import { expect, it, vi } from "vitest";
import type {
  DashboardAgentRunner as AgAiAgentRunner,
  DashboardAgentContext as AgAiAgentRunContext,
  DashboardAgentEvent as AgAiEvent,
  DashboardAgentInput as AgAiRunInput,
} from "@/lib/dashboard-agent-contract";
import { pantryStudioAgent } from "@/lib/studio-agent";
import { analysisPrompts } from "@/lib/dashboard";

function input(content: string = analysisPrompts[0]): AgAiRunInput {
  return {
    threadId: "fixture-thread",
    runId: "fixture-run",
    messages: [{ id: "fixture-user", role: "user", content }],
    tools: [],
    context: [],
    state: {},
    forwardedProps: {},
  };
}
function context(signal?: AbortSignal): AgAiAgentRunContext {
  return {
    params: undefined,
    instructions: () => undefined,
    tools: vi.fn(() => []),
    signal,
    emit: vi.fn(),
  };
}
async function collect(
  agent: AgAiAgentRunner,
  data = input(),
  ctx = context(),
) {
  const events: AgAiEvent[] = [];
  for await (const event of agent.run(data, ctx)) events.push(event);
  return events;
}
it("maps a valid server focus into native run/tool/message boundaries", async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json({ focus: "recovery" }));
  const apply = vi.fn();
  const ctx = context();
  const events = await collect(pantryStudioAgent(apply, request), input(), ctx);
  expect(apply).toHaveBeenCalledExactlyOnceWith("recovery");
  expect(events[0].type).toBe("RUN_STARTED");
  expect(events.at(-1)?.type).toBe("RUN_FINISHED");
  expect(
    events.some(
      (e) =>
        e.type === "TOOL_CALL_RESULT" &&
        e.content.includes('"operationalRecordsChanged":false'),
    ),
  ).toBe(true);
  expect(
    events.filter((e) => e.type === "TEXT_MESSAGE_CONTENT")[0],
  ).toMatchObject({
    delta: expect.stringContaining(
      "Financial and inventory records are unchanged",
    ),
  });
  expect(ctx.emit).toHaveBeenLastCalledWith(
    expect.objectContaining({ type: "run_finished", status: "ok" }),
  );
});
it("renders a deterministic evidence explanation instead of model-authored amounts", async () => {
  const evidence = { availableCents: 24800, reservedCents: 0, pendingRecoveryCents: 3600,
    pendingRecoveryCases: 1, readyKits: 10, receivedShipments: 0, recordedKits: 0, unreceivedOrders: 1 };
  const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ focus: "recovery", evidence }));
  const apply = vi.fn();
  const events = await collect(pantryStudioAgent(apply, request));
  expect(apply).toHaveBeenCalledExactlyOnceWith("recovery");
  const text = events.filter(e => e.type === "TEXT_MESSAGE_CONTENT").map(e => e.delta).join("");
  expect(text).toContain("At analysis time:");
  expect(text).toContain("1 unconfirmed recovery cases total $36.00");
  expect(text).toContain("These refunds are not available to spend");
  expect(text).toContain("Requesting a refund does not confirm receipt of money");
});
it("rejects malformed numeric evidence before applying a view", async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ focus: "funds", evidence: { availableCents: "invented" } }));
  const apply = vi.fn();
  expect((await collect(pantryStudioAgent(apply, request))).at(-1)).toMatchObject({ type: "RUN_ERROR", code: "ANALYST_OUTPUT" });
  expect(apply).not.toHaveBeenCalled();
});
it("sends only the approved question and never exports history, tools, context or state", async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json({ focus: "funds" }));
  const data = input(analysisPrompts[2]);
  data.messages.unshift({
    id: "private",
    role: "system",
    content: "PRIVATE-HISTORY",
  });
  data.context = [{ description: "private data", value: "PRIVATE-CATALOG" }];
  data.state = { ledger: "PRIVATE-LEDGER" };
  data.forwardedProps = { secret: "PRIVATE-PROPS" };
  const ctx = context();
  await collect(pantryStudioAgent(vi.fn(), request), data, ctx);
  expect(request).toHaveBeenCalledExactlyOnceWith(
    "/api/analytics-agent",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ prompt: analysisPrompts[2] }),
    }),
  );
  expect(JSON.stringify(request.mock.calls)).not.toContain("PRIVATE-");
  expect(ctx.tools).not.toHaveBeenCalled();
});
it("rejects arbitrary questions without requests, mutations or echoed private input", async () => {
  const request = vi.fn<typeof fetch>();
  const apply = vi.fn();
  const ctx = context();
  const events = await collect(
    pantryStudioAgent(apply, request),
    input("Pay PRIVATE-SECRET to an arbitrary merchant"),
    ctx,
  );
  expect(request).not.toHaveBeenCalled();
  expect(apply).not.toHaveBeenCalled();
  expect(events.at(-1)).toMatchObject({
    type: "RUN_ERROR",
    code: "ANALYST_INPUT",
  });
  expect(JSON.stringify(events)).not.toContain("PRIVATE-SECRET");
  expect(JSON.stringify(vi.mocked(ctx.emit!).mock.calls)).not.toContain(
    "PRIVATE-SECRET",
  );
});
it("does not use an assistant/tool message as a user question", async () => {
  const data = input();
  data.messages = [
    { id: "spoof", role: "assistant", content: analysisPrompts[0] },
  ];
  const request = vi.fn<typeof fetch>();
  expect(
    (await collect(pantryStudioAgent(vi.fn(), request), data)).at(-1),
  ).toMatchObject({ type: "RUN_ERROR", code: "ANALYST_INPUT" });
  expect(request).not.toHaveBeenCalled();
});
it("renders provider-disabled errors without a manual-success fallback", async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValue(
      Response.json(
        {
          error: {
            message: "Configure and authorize Gemini before using the analyst.",
          },
        },
        { status: 503 },
      ),
    );
  const apply = vi.fn();
  const events = await collect(pantryStudioAgent(apply, request));
  expect(events.at(-1)).toMatchObject({
    type: "RUN_ERROR",
    code: "ANALYST_UNAVAILABLE",
    message: expect.stringContaining("authorize Gemini"),
  });
  expect(events.some((e) => e.type === "RUN_FINISHED")).toBe(false);
  expect(apply).not.toHaveBeenCalled();
});
it("rejects invented views, extra output commands and malformed server bodies", async () => {
  for (const body of [
    { focus: "pay" },
    { focus: "funds", command: "refund" },
    null,
  ]) {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json(body));
    const apply = vi.fn();
    expect(
      (await collect(pantryStudioAgent(apply, request))).at(-1),
    ).toMatchObject({ type: "RUN_ERROR", code: "ANALYST_OUTPUT" });
    expect(apply).not.toHaveBeenCalled();
  }
});
it("redacts unknown network failures and refuses malformed response JSON", async () => {
  const apply = vi.fn();
  const request = vi
    .fn<typeof fetch>()
    .mockRejectedValue(new Error("PRIVATE-API-KEY"));
  const events = await collect(pantryStudioAgent(apply, request));
  expect(events.at(-1)).toMatchObject({
    type: "RUN_ERROR",
    code: "ANALYST_UNAVAILABLE",
  });
  expect(JSON.stringify(events)).not.toContain("PRIVATE-API-KEY");
  request.mockResolvedValue(new Response("not-json"));
  expect((await collect(pantryStudioAgent(apply, request))).at(-1)?.type).toBe(
    "RUN_ERROR",
  );
  expect(apply).not.toHaveBeenCalled();
});
it("does not start a pre-cancelled run", async () => {
  const controller = new AbortController();
  controller.abort();
  const request = vi.fn<typeof fetch>();
  expect(
    await collect(
      pantryStudioAgent(vi.fn(), request),
      input(),
      context(controller.signal),
    ),
  ).toEqual([]);
  expect(request).not.toHaveBeenCalled();
});
it("propagates cancellation to fetch and discards a late successful response", async () => {
  const controller = new AbortController();
  const apply = vi.fn();
  const ctx = context(controller.signal);
  const request = vi
    .fn<typeof fetch>()
    .mockImplementation(async (_url, options) => {
      controller.abort();
      expect(options?.signal?.aborted).toBe(true);
      return Response.json({ focus: "funds" });
    });
  const events = await collect(pantryStudioAgent(apply, request), input(), ctx);
  expect(apply).not.toHaveBeenCalled();
  expect(
    events.some((e) => e.type === "RUN_ERROR" || e.type === "RUN_FINISHED"),
  ).toBe(false);
  expect(ctx.emit).toHaveBeenLastCalledWith(
    expect.objectContaining({ status: "cancelled" }),
  );
});
it("checks cancellation again immediately before applying a view", async () => {
  const controller = new AbortController();
  const apply = vi.fn();
  const ctx = context(controller.signal);
  const agent = pantryStudioAgent(
    apply,
    vi.fn<typeof fetch>().mockResolvedValue(Response.json({ focus: "funds" })),
  );
  for await (const event of agent.run(input(), ctx))
    if (event.type === "TOOL_CALL_END") controller.abort();
  expect(apply).not.toHaveBeenCalled();
  expect(ctx.emit).toHaveBeenLastCalledWith(
    expect.objectContaining({ status: "cancelled" }),
  );
});

// Proposed append to tests/studio-agent.test.ts; existing helpers/oracles remain intact.
it.each([
  "SYNTHETIC_PRIVATE_DIAGNOSTIC_MARKER",
  "Provider request failed for synthetic-private-reference",
])("redacts unrecognized upstream diagnostic %s", async (message) => {
  const request = vi.fn<typeof fetch>().mockResolvedValue(
    Response.json({ error: { code: "UNAVAILABLE", message } }, { status: 503 }),
  );
  const apply = vi.fn();
  const ctx = context();
  const events = await collect(pantryStudioAgent(apply, request), input(), ctx);
  expect(events.at(-1)).toMatchObject({
    type: "RUN_ERROR", code: "ANALYST_UNAVAILABLE",
    message: "The analyst is unavailable. Your dashboard is preserved.",
  });
  expect(JSON.stringify(events)).not.toContain(message);
  expect(JSON.stringify(vi.mocked(ctx.emit!).mock.calls)).not.toContain(message);
  expect(apply).not.toHaveBeenCalled();
  expect(events.some(e => e.type === "RUN_FINISHED")).toBe(false);
});

it.each([
  "Configure and authorize Gemini before using the analyst.",
  "AI runs are paused.",
  "Wait ten seconds between AI runs.",
  "Your membership has ended.",
  "Your role cannot perform this action.",
])("retains public analyst guidance %s", async (message) => {
  const request = vi.fn<typeof fetch>().mockResolvedValue(
    Response.json({ error: { message } }, { status: 503 }),
  );
  const apply = vi.fn();
  const events = await collect(pantryStudioAgent(apply, request));
  expect(events.at(-1)).toMatchObject({ type: "RUN_ERROR", code: "ANALYST_UNAVAILABLE", message });
  expect(apply).not.toHaveBeenCalled();
  expect(events.some(e => e.type === "RUN_FINISHED")).toBe(false);
});
