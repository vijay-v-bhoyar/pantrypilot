import { expect, it } from "vitest";
import { SESSION_A1, sessionTiming, validateSessionPlan, validateSessionReady, type SessionPlan } from "../scripts/lib/gemini-session-admission";
import { validateGeminiCurrentState, type GeminiCurrentState } from "../scripts/lib/gemini-current-state";
const now = Date.UTC(2026, 10, 7, 18);
const expected = { manifestHash: "a".repeat(64), sourceDigest: "b".repeat(64), buildId: "offline", maxHttpRequests: 6, expiresAt: now + 300000 };
const plan: SessionPlan = { ...expected, policy: SESSION_A1.id, day: "2026-11-07", knownPriorHttp: 0,
  laterExternalReservedHttp: 14, usageObservedAt: now - 120000, usageReference: "offline-partial-ui",
  evidenceBasis: "OWNER_ATTESTED_PARTIAL_UI", quotaHead: "c".repeat(64), maxHttpRequests: 6 };
it("A1 uses an explicit owner timestamp without freshening old UI evidence", () => {
  expect(() => validateSessionPlan(plan, expected, plan.day, now)).not.toThrow();
  const g = { sessionPolicy: SESSION_A1.id, ownerAttestedAt: now, quietSince: now, usageObservedAt: now - 120000, windowStart: now };
  expect(sessionTiming(g, now)).toBe(true); expect(g.usageObservedAt).toBe(now - 120000);
  expect(sessionTiming({ ...g, ownerAttestedAt: now - 900001 }, now)).toBe(false);
});
it("legacy freshness and settle still refuse stale or missing evidence", () => {
  expect(sessionTiming({ quietSince: now - 1000000, usageObservedAt: now - 61000, windowStart: now }, now)).toBe(false);
  expect(() => sessionTiming({ ownerAttestedAt: now, quietSince: now, usageObservedAt: now, windowStart: now }, now)).toThrow();
});
it.each([{ knownPriorHttp: 1 }, { day: "2026-11-08" }, { evidenceBasis: "UNKNOWN" }, { quotaHead: null }])(
  "refuses incomplete, changed or over-budget plans", delta => {
    expect(() => validateSessionPlan({ ...plan, ...delta } as SessionPlan, expected, plan.day, now)).toThrow();
  });
it("requires one owner confirmation bound to plan, count and scope", () => {
  const r = { scopeSha256: "d".repeat(64), planSha256: "e".repeat(64), atMs: now, day: plan.day,
    knownPriorHttp: 0, exclusive: true as const, completeHistoryConfirmed: true as const };
  expect(() => validateSessionReady(r, r.scopeSha256, r.planSha256, plan, now)).not.toThrow();
  expect(() => validateSessionReady({ ...r, knownPriorHttp: 1 }, r.scopeSha256, r.planSha256, plan, now)).toThrow();
  expect(() => validateSessionReady(r, r.scopeSha256, r.planSha256, plan, now + 900001)).toThrow();
});
it("current-state record has a single unadmitted subject and all holds", () => {
  // Portable synthetic record: public source tests must not require private owner-history files.
  const state: GeminiCurrentState = { version: 1, status: "HOLD", project: "gen-lang-client-0107804522",
    model: "gemini-3.6-flash", baseline: { sourceDigest: "a".repeat(64), buildId: "offline-build" },
    proposedPolicy: "PP-GEMINI-SESSION-A1", policyStatus: "LOCAL_CANDIDATE_UNVERIFIED",
    runtimeSubject: null, currentRelease: null, holds: { initialization: true, keys: true, providers: true, submission: true },
    answerHistory: { path: "offline-history", count: 62, sha256: "b".repeat(64) },
    failedEvidence: ["offline-failure-a", "offline-failure-b"], nextAction: "offline-review" };
  expect(validateGeminiCurrentState(state)).toBe(state);
  expect(() => validateGeminiCurrentState({ ...state, currentRelease: { approved: true } } as unknown as GeminiCurrentState)).toThrow();
  expect(() => validateGeminiCurrentState({ ...state, currentInitialProbeCandidate: {} } as unknown as GeminiCurrentState)).toThrow();
  const released: GeminiCurrentState = { ...state, status: "APPROVED_WINDOW", policyStatus: "OFFLINE_VERIFIED",
    runtimeSubject: { canonicalRoot: "C:/offline-only", id: "00000000-0000-0000-0000-000000000000",
      sourceDigest: "a".repeat(64), buildId: "offline", manifestHash: "c".repeat(64), quotaHead: "d".repeat(64) },
    currentRelease: { status: "APPROVED", path: "offline-release", sha256: "e".repeat(64) },
    holds: { initialization: false, keys: false, providers: true, submission: true } };
  expect(() => validateGeminiCurrentState(released)).toThrow();
  expect(() => validateGeminiCurrentState({ ...released, holds: { ...released.holds, providers: false } })).not.toThrow();
});
