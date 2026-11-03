import { afterEach, expect, it, vi } from "vitest";
import { generateText, stepCountIs, tool } from "ai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { z } from "zod";
import { budgetedModelFetch, createModelBudget, requiredModelLimits, validateModelLimits } from "@/lib/model-budget";

const limits = { maxHttpRequests: 2, maxInputBytes: 32768, maxOutputTokens: 512, timeoutMs: 60000 };
const url = "https://generativelanguage.googleapis.com/v1beta/models/fixture-model:generateContent";
const init = (tokens = 512, extra = "") => ({ method: "POST", body: JSON.stringify({
  generationConfig: { maxOutputTokens: tokens }, contents: extra,
}) });
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

it.each([undefined, "", "0", "-1", "1.2", "1e2", "Infinity", " 2", "11"])("denies invalid HTTP budget %s", (raw) => {
  vi.stubEnv("AI_MAX_HTTP_REQUESTS", raw);
  vi.stubEnv("AI_MAX_INPUT_BYTES", "32768"); vi.stubEnv("AI_MAX_OUTPUT_TOKENS", "512"); vi.stubEnv("AI_TIMEOUT_MS", "60000");
  expect(requiredModelLimits).toThrow("explicit model");
});
it.each(["maxInputBytes", "maxOutputTokens", "timeoutMs"] as const)("validates %s without silent expansion", (key) => {
  for (const value of [NaN, 0, -1, 0.1, Infinity, Number.MAX_SAFE_INTEGER])
    expect(() => validateModelLimits({ ...limits, [key]: value })).toThrow("explicit model");
});
it("requires separate explicit evaluation limits and retains hard ceilings", () => {
  expect(() => createModelBudget({ ...limits, maxHttpRequests: 12 })).toThrow();
  expect(createModelBudget({ ...limits, maxHttpRequests: 120 }, "evaluation").limits.maxHttpRequests).toBe(120);
  expect(() => createModelBudget({ ...limits, maxHttpRequests: 121 }, "evaluation")).toThrow();
});
it("counts failed attempts and refuses another request before transport", async () => {
  const transport = vi.fn<typeof fetch>().mockRejectedValue(new Error("PRIVATE_DIAGNOSTIC"));
  const budget = createModelBudget(limits);
  const request = budgetedModelFetch("fixture-model", budget, new AbortController().signal, undefined, transport);
  for (let i = 0; i < 2; i++) await expect(request(url, init())).rejects.toThrow("PRIVATE_DIAGNOSTIC");
  await expect(request(url, init())).rejects.toMatchObject({ code: "AI_BUDGET" });
  expect(budget.attempts).toBe(2); expect(transport).toHaveBeenCalledTimes(2);
});
it("shares a session cap across independent planner runs", async () => {
  const transport = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({}));
  const shared = createModelBudget({ ...limits, maxHttpRequests: 1 }, "evaluation");
  const a = createModelBudget(limits), b = createModelBudget(limits);
  await budgetedModelFetch("fixture-model", a, new AbortController().signal, shared, transport)(url, init());
  await expect(budgetedModelFetch("fixture-model", b, new AbortController().signal, shared, transport)(url, init())).rejects.toMatchObject({ code: "AI_BUDGET" });
  expect(b.attempts).toBe(0); expect(shared.attempts).toBe(1); expect(transport).toHaveBeenCalledTimes(1);
});
it.each([undefined, 0, -1, 513, 1.5, "512"])("denies absent/invalid output token bound %s before send", async (tokens) => {
  const transport = vi.fn<typeof fetch>(); const budget = createModelBudget(limits);
  const request = budgetedModelFetch("fixture-model", budget, new AbortController().signal, undefined, transport);
  const body = JSON.stringify({ generationConfig: { maxOutputTokens: tokens } });
  await expect(request(url, { method: "POST", body })).rejects.toMatchObject({ code: "AI_BUDGET" });
  expect(transport).not.toHaveBeenCalled(); expect(budget.attempts).toBe(0);
});
it("measures UTF-8 serialized bytes, including schema/tool output, before each send", async () => {
  const transport = vi.fn<typeof fetch>(); const budget = createModelBudget({ ...limits, maxInputBytes: 100 });
  await expect(budgetedModelFetch("fixture-model", budget, new AbortController().signal, undefined, transport)(url, init(512, "é".repeat(30)))).rejects.toMatchObject({ code: "AI_BUDGET", status: 413 });
  expect(transport).not.toHaveBeenCalled(); expect(budget.attempts).toBe(0);
});
it.each(["https://other.example/v1beta/models/fixture-model:generateContent", url.replace("fixture-model", "another-model"), url + "?key=PRIVATE"])("denies changed target %s", async (target) => {
  const transport = vi.fn<typeof fetch>();
  await expect(budgetedModelFetch("fixture-model", createModelBudget(limits), new AbortController().signal, undefined, transport)(target, init())).rejects.toMatchObject({ code: "AI_BUDGET" });
  expect(transport).not.toHaveBeenCalled();
});
it("denies pre-send cancellation and discards a transport that completes after cancellation", async () => {
  const control = new AbortController(); const transport = vi.fn<typeof fetch>().mockImplementation(async () => {
    control.abort(new Error("stopped")); return Response.json({});
  });
  const budget = createModelBudget(limits);
  const request = budgetedModelFetch("fixture-model", budget, control.signal, undefined, transport);
  await expect(request(url, init())).rejects.toThrow("stopped");
  await expect(request(url, init())).rejects.toThrow("stopped");
  expect(budget.attempts).toBe(1); expect(transport).toHaveBeenCalledTimes(1);
});
it("denies an elapsed time budget before send", async () => {
  vi.useFakeTimers(); const budget = createModelBudget({ ...limits, timeoutMs: 10 });
  vi.advanceTimersByTime(11); const transport = vi.fn<typeof fetch>();
  await expect(budgetedModelFetch("fixture-model", budget, new AbortController().signal, undefined, transport)(url, init())).rejects.toThrow();
  expect(transport).not.toHaveBeenCalled();
});

// Real SDK continuation loop; only the HTTP transport is a fixture. No credentials/network.
it("caps real SDK multi-step model HTTP attempts, without retries/fallback", async () => {
  const budget = createModelBudget(limits);
  const transport = vi.fn<typeof fetch>().mockImplementation(async (_url, options) => {
    expect(JSON.parse(options!.body as string).generationConfig.maxOutputTokens).toBe(512);
    expect(options!.redirect).toBe("error");
    return Response.json({ candidates: [{ content: { role: "model", parts: [
      { functionCall: { name: "read", args: {} } },
    ] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } });
  });
  const model = createGoogleGenerativeAI({ apiKey: "fixture-never-real", fetch:
    budgetedModelFetch("fixture-model", budget, new AbortController().signal, undefined, transport) })("fixture-model");
  await expect(generateText({ model, prompt: "Synthetic fixture", maxOutputTokens: 512, maxRetries: 0,
    tools: { read: tool({ inputSchema: z.object({}).strict(), execute: async () => ({ synthetic: true }) }) },
    stopWhen: stepCountIs(6),
  })).rejects.toThrow("request budget");
  expect(transport).toHaveBeenCalledTimes(2); expect(budget.attempts).toBe(2);
});

it("IMP-T12/13 rechecks original budgets after internal policy waits without charging counts as generations", async () => {
  const transport = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({}));
  const control = new AbortController(), budget = createModelBudget(limits);
  const request = budgetedModelFetch("fixture-model", budget, control.signal, undefined, transport,
    { dispatch: async ({ send }) => { control.abort(); return send(); } });
  await expect(request(url, init())).rejects.toThrow();
  expect(budget.attempts).toBe(0); expect(transport).not.toHaveBeenCalled();
});
it("IMP-T13 preserves the generation allowlist even with an evaluation policy", async () => {
  const dispatch = vi.fn(), transport = vi.fn<typeof fetch>();
  await expect(budgetedModelFetch("fixture-model", createModelBudget(limits), new AbortController().signal,
    undefined, transport, { dispatch })(url.replace(":generateContent", ":countTokens"), init())).rejects.toThrow();
  expect(dispatch).not.toHaveBeenCalled(); expect(transport).not.toHaveBeenCalled();
});
