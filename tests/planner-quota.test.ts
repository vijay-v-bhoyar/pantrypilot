import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { generateText, stepCountIs, tool } from "ai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { z } from "zod";
import { H2Journal, createH2Policy, initializeQuota, measuredTokens, nextStart,
  pacificDay, promptUsage, withProjectLock, type SafetyClock } from "../scripts/lib/planner-quota";
import { budgetedModelFetch, createModelBudget } from "../src/lib/model-budget";

const roots: string[] = [];
beforeEach(() => { vi.stubGlobal("fetch", vi.fn(() => { throw new Error("UNEXPECTED_EGRESS"); })); });
afterEach(async () => {
  vi.unstubAllGlobals(); vi.useRealTimers();
  for (const root of roots.splice(0)) {
    expect(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)).toBe(true);
    expect(path.basename(root).startsWith("pantrypilot-h2-quota-")).toBe(true);
    await rm(root, { recursive: true, force: true });
  }
});
async function fixture(knownUsed = 0) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pantrypilot-h2-quota-")); roots.push(root);
  const quota = path.join(root, "project"), project = "gen-lang-client-0107804522";
  let now = Date.UTC(2026, 9, 27, 12), elapsed = 0;
  const clock: SafetyClock = { now: () => now, monotonic: () => elapsed, sleep: async (ms, signal) => {
    signal.throwIfAborted(); now += ms; elapsed += ms; signal.throwIfAborted(); } };
  const advance = (ms: number) => { now += ms; elapsed += ms; };
  const origin = { project, day: pacificDay(now), knownUsed, evidenceReference: "approved-local-fixture" };
  await initializeQuota(quota, origin);
  const control = new AbortController(), campaign = randomUUID();
  const transport = vi.fn<typeof fetch>().mockImplementation(async (url) => String(url).endsWith(":countTokens") ?
    Response.json({ totalTokens: 2 }) : Response.json({ usageMetadata: { promptTokenCount: 3 } }));
  const makePolicy = (extra = {}) => createH2Policy({ root: quota, project, campaign, caseId: 1,
    model: "fixture-model", day: origin.day, approvedDay: origin.day, knownProjectUseReference: "approved-local-fixture",
    signal: control.signal, assertActive: () => control.signal.throwIfAborted(), clock, transport, ...extra });
  const request = (policy = makePolicy(), body = JSON.stringify({ contents: [{ role: "user", parts: [{ text: "synthetic" }] }],
    generationConfig: { maxOutputTokens: 1024, responseSchema: { type: "OBJECT" } } })) =>
    policy.dispatch({ modelId: "fixture-model", body, init: { headers: { "x-goog-api-key": "FAKE_SENTINEL" } },
      signal: control.signal, send: () => transport("https://generativelanguage.googleapis.com/v1beta/models/fixture-model:generateContent",
        { method: "POST", body, signal: control.signal }) });
  return { root, quota, origin, project, campaign, clock, advance, control, transport, makePolicy, request };
}
it.each([49999, 50000])("IMP-T09 accepts measured boundary %s independently of actual inference usage", (value) => {
  expect(measuredTokens(value)).toBe(value);
});
it.each([50001, 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER, undefined, null, "1"])(
  "IMP-T09 refuses unadmitted count %s", (value) => { expect(() => measuredTokens(value)).toThrow(); });
it.each([62500, 1])("IMP-T10 allows reconciled usage %s", (value) => { expect(promptUsage(value)).toBe(value); });
it.each([62501, undefined, null, 0, -1, 1.1, Infinity, "62500"])("IMP-T10 stops invalid usage %s", (value) => {
  expect(() => promptUsage(value)).toThrow();
});
it.each([0, 18, 19, 20])("IMP-T04 combined project cap and pair capacity with %s prior use", async (used) => {
  const f = await fixture(used);
  await withProjectLock(f.quota, async () => {
    const allowed = Math.floor((20 - used) / 2), policy = f.makePolicy();
    for (let i = 0; i < allowed; i++) await f.request(policy);
    await expect(f.request(policy)).rejects.toThrow();
    expect(f.transport).toHaveBeenCalledTimes(allowed * 2);
    const events = await new H2Journal(f.quota).read();
    expect(events.filter((e) => e.value.kind === "pair-reserved")).toHaveLength(allowed);
  });
});
it("IMP-T05 restart/new campaign alias cannot regain the spent project allowance", async () => {
  const f = await fixture(18);
  await withProjectLock(f.quota, async () => { await f.request(); });
  await withProjectLock(f.quota, async () => {
    await expect(f.request(f.makePolicy({ campaign: randomUUID() }))).rejects.toThrow();
  });
  expect(f.transport).toHaveBeenCalledTimes(2);
  await expect(initializeQuota(f.quota, f.origin)).rejects.toThrow();
});
it("IMP-T05 real concurrent lock owners and stale ownership fail closed", async () => {
  const f = await fixture(); let entered!: () => void, release!: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const first = withProjectLock(f.quota, async () => { entered(); await hold; });
  await ready; await expect(withProjectLock(f.quota, async () => {})).rejects.toMatchObject({ code: "EEXIST" });
  release(); await first;
  await expect(withProjectLock(f.quota, async () => { throw new Error("interrupted"); })).rejects.toThrow();
  await expect(withProjectLock(f.quota, async () => {})).rejects.toMatchObject({ code: "EEXIST" });
});
it("IMP-T15/16 detects missing terminal events, altered chains and uncertain sends", async () => {
  const f = await fixture(); f.transport.mockRejectedValue(new Error("FAKE_SENTINEL_PRIVATE"));
  await withProjectLock(f.quota, async () => { await expect(f.request()).rejects.toThrow("H2 transport stopped"); });
  const journal = new H2Journal(f.quota), rows = await journal.read();
  expect(rows.some((r) => r.value.kind === "poison")).toBe(true);
  expect(JSON.stringify(rows)).not.toContain("FAKE_SENTINEL_PRIVATE");
  await expect(f.request(f.makePolicy())).rejects.toThrow();
  const last = `${String(rows.length - 1).padStart(6, "0")}.json`;
  await unlink(path.join(f.quota, "events", last)); await expect(journal.read()).rejects.toThrow();
});
it("IMP-T08 sends the exact nested request without a query key and refuses wrong model", async () => {
  const f = await fixture(); await withProjectLock(f.quota, async () => { await f.request(); });
  const [url, init] = f.transport.mock.calls[0];
  expect(String(url)).toBe("https://generativelanguage.googleapis.com/v1beta/models/fixture-model:countTokens");
  expect(init?.redirect).toBe("error");
  const nested = JSON.parse(init!.body as string).generateContentRequest;
  expect(nested.model).toBe("models/fixture-model"); expect(nested.generationConfig.responseSchema).toEqual({ type: "OBJECT" });
  expect(nested.contents[0].parts[0].text).toBe("synthetic");
  await expect(f.makePolicy({ model: "other" }).dispatch({ modelId: "fixture-model", body: "{}", init: {},
    signal: f.control.signal, send: async () => Response.json({}) })).rejects.toThrow();
  expect(f.transport).toHaveBeenCalledTimes(2);
});
it("IMP-T10 keeps headroom reservations and poisons missing/over-limit usage without replay", async () => {
  const f = await fixture(); f.transport.mockImplementation(async (url) => String(url).endsWith(":countTokens") ?
    Response.json({ totalTokens: 50000 }) : Response.json({ usageMetadata: { promptTokenCount: 62501 } }));
  await withProjectLock(f.quota, async () => { await expect(f.request()).rejects.toThrow(); });
  await expect(f.request(f.makePolicy())).rejects.toThrow();
  const rows = await new H2Journal(f.quota).read();
  expect(rows.filter((r) => r.value.kind === "generation-start")[0].value.reservedTokens).toBe(62500);
  expect(f.transport).toHaveBeenCalledTimes(2);
});
it("IMP-T11 enforces fourth/fifth rolling starts and 16-second gaps for both endpoint classes", async () => {
  expect(nextStart([0, 16000, 32000, 48000], 49000)).toBe(64000);
  expect(nextStart([0], 1)).toBe(16000); expect(nextStart([], 0)).toBe(0);
  const f = await fixture(); await withProjectLock(f.quota, async () => {
    const policy = f.makePolicy(); for (let i = 0; i < 5; i++) await f.request(policy);
  });
  const rows = await new H2Journal(f.quota).read();
  for (const kind of ["count-start", "generation-start"]) {
    const times = rows.filter((r) => r.value.kind === kind).map((r) => r.value.at as number);
    times.forEach((now, index) => { if (index) expect(now - times[index - 1]).toBeGreaterThanOrEqual(16000);
      expect(times.filter((t) => t <= now && now - t < 60000).length).toBeLessThanOrEqual(4); });
  }
});
it("IMP-T06 Pacific day, DST and backwards safety time never reset existing reservations", async () => {
  expect(pacificDay(Date.parse("2026-10-28T06:59:59Z"))).toBe("2026-10-27");
  expect(pacificDay(Date.parse("2026-10-28T07:00:00Z"))).toBe("2026-10-28");
  for (const instant of ["2026-03-08T09:59:59Z", "2026-03-08T10:00:00Z", "2026-11-01T08:59:59Z", "2026-11-01T09:00:00Z"])
    expect(pacificDay(Date.parse(instant))).toMatch(/^2026-(03-08|11-01)$/);
  const f = await fixture(); await withProjectLock(f.quota, async () => { await f.request(); });
  f.advance(-1); await expect(f.request(f.makePolicy())).rejects.toThrow();
  expect(f.transport).toHaveBeenCalledTimes(2);
});
it("IMP-T12 abort while pacing produces no post-abort count/generation", async () => {
  const f = await fixture(); await withProjectLock(f.quota, async () => { await f.request(); });
  const stopClock: SafetyClock = { ...f.clock, sleep: async (_ms, signal) => {
    f.control.abort(); signal.throwIfAborted(); } };
  await withProjectLock(f.quota, async () => { await expect(f.request(f.makePolicy({ clock: stopClock }))).rejects.toThrow(); });
  expect(f.transport).toHaveBeenCalledTimes(2);
});
it.each([1, 2, 3, 4, 5])("IMP-T15 persistence interruption at append %s never replays a pair", async (boundary) => {
  const f = await fixture(); const append = H2Journal.prototype.append; let seen = 0;
  const intercept = vi.spyOn(H2Journal.prototype, "append").mockImplementation(async function(this: H2Journal, value) {
    if (++seen === boundary) throw new Error("synthetic persistence interruption");
    return append.call(this, value);
  });
  try {
    await withProjectLock(f.quota, async () => { await expect(f.request()).rejects.toThrow(); });
    const sent = f.transport.mock.calls.length;
    await expect(f.request(f.makePolicy())).rejects.toThrow(); expect(f.transport).toHaveBeenCalledTimes(sent);
  } finally { intercept.mockRestore(); }
});
it("IMP-T12 count timeout aborts its response and never dispatches generation", async () => {
  const f = await fixture(), deadline = new AbortController(); let entered!: () => void;
  const reached = new Promise<void>((resolve) => { entered = resolve; });
  const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
    expect(ms).toBe(10000); return deadline.signal;
  });
  f.transport.mockImplementation(async (_url, options) => new Promise<Response>((_resolve, reject) => {
    options?.signal?.addEventListener("abort", () => reject(new Error("synthetic count timeout")), { once: true });
    entered();
  }));
  try {
    const result = f.request().catch(() => "REFUSED"); await reached; deadline.abort();
    expect(await result).toBe("REFUSED"); expect(f.transport).toHaveBeenCalledTimes(1);
    expect(String(f.transport.mock.calls[0][0])).toContain(":countTokens");
  } finally { timeout.mockRestore(); }
});
it("IMP-T07 actual installed SDK continuations use paired fake transport and retain original generation cap", async () => {
  const f = await fixture(); f.transport.mockImplementation(async (url) => String(url).endsWith(":countTokens") ?
    Response.json({ totalTokens: 1 }) : Response.json({ candidates: [{ content: { role: "model", parts: [
      { functionCall: { name: "read", args: {} } } ] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1, totalTokenCount: 3 } }));
  const budget = createModelBudget({ maxHttpRequests: 2, maxInputBytes: 32768, maxOutputTokens: 1024, timeoutMs: 60000 });
  await withProjectLock(f.quota, async () => {
    const model = createGoogleGenerativeAI({ apiKey: "FAKE_SENTINEL", fetch: budgetedModelFetch("fixture-model",
      budget, f.control.signal, undefined, f.transport, f.makePolicy()) })("fixture-model");
    await expect(generateText({ model, prompt: "synthetic", maxRetries: 0, maxOutputTokens: 1024,
      tools: { read: tool({ inputSchema: z.object({}), execute: async () => ({ synthetic: true }) }) },
      stopWhen: stepCountIs(6) })).rejects.toThrow();
  });
  expect(budget.attempts).toBe(2); expect(f.transport).toHaveBeenCalledTimes(4);
});
it("IMP-T18 receipts contain identities/counts only, never fake private bodies/headers", async () => {
  const f = await fixture(); await withProjectLock(f.quota, async () => { await f.request(); });
  const rows = await new H2Journal(f.quota).read(), text = JSON.stringify(rows);
  expect(text).not.toContain("FAKE_SENTINEL"); expect(text).not.toContain("synthetic");
  expect(text).not.toContain("x-goog-api-key"); expect(globalThis.fetch).not.toHaveBeenCalled();
  const origin = path.join(f.quota, "origin.json"); const value = await readFile(origin, "utf8");
  await writeFile(origin, value.replace("approved-local-fixture", "changed"));
  await expect(f.request(f.makePolicy())).rejects.toThrow();
});
