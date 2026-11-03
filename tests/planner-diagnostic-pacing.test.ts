import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { H2Journal, createH2Policy, initializeQuota, pacificDay, withProjectLock } from "../scripts/lib/planner-quota";

it("DIAG a generation pacing failure cannot inherit the successful count HTTP status", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pantrypilot-diagnostic-pacing-"));
  const root = path.join(temporaryRoot, "quota");
  const now = Date.now(), day = pacificDay(now), control = new AbortController();
  const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ totalTokens: 237 }));
  const send = vi.fn(async () => Response.json({ usageMetadata: { promptTokenCount: 240 } }));
  try {
    await initializeQuota(root, { project: "gen-lang-client-0107804522", day, knownUsed: 0, evidenceReference: "offline-pacing" });
    const journal = new H2Journal(root);
    // An earlier generation still occupies the pacing window; counting can succeed first.
    await journal.append({ kind: "generation-start", at: now, day, campaign: "earlier", caseId: 1,
      pair: "earlier-pair", identity: "0".repeat(64), reservedTokens: 62500 });
    const policy = createH2Policy({ root, project: "gen-lang-client-0107804522", campaign: "synthetic", caseId: 2,
      model: "fixture-model", day, approvedDay: day, knownProjectUseReference: "offline-pacing",
      signal: control.signal, assertActive: () => control.signal.throwIfAborted(), transport,
      clock: { now: () => now, monotonic: () => 0, sleep: async () => { throw new Error("FAKE_PACING_SECRET"); } } });
    await expect(withProjectLock(root, () => policy.dispatch({ modelId: "fixture-model", body: "{}", init: {},
      signal: control.signal, send }))).rejects.toThrow("H2 transport stopped");
    const rows = await journal.read();
    expect(rows.find(r => r.value.kind === "poison")?.value.diagnostic).toEqual({ version: 1, phase: "GENERATION_PACING" });
    expect(transport).toHaveBeenCalledTimes(1); expect(send).not.toHaveBeenCalled();
    expect(JSON.stringify(rows)).not.toContain("FAKE_PACING_SECRET");
    expect(await readFile(path.join(root, "block.lock"), "utf8")).toContain("owner");
  } finally {
    expect(path.resolve(temporaryRoot).startsWith(path.resolve(os.tmpdir()) + path.sep)).toBe(true);
    expect(path.basename(temporaryRoot).startsWith("pantrypilot-diagnostic-pacing-")).toBe(true);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
