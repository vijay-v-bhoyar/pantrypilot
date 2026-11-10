import { ensure } from "../../src/lib/errors";

// Opt-in proposal; a source change or this constant never grants execution authority.
export const SESSION_A1 = Object.freeze({ id: "PP-GEMINI-SESSION-A1",
  ownerAttestationAgeMs: 900000, windowMs: 300000, diagnostic503Retries: 1,
  dailyCombinedHttp: 20 });
export type SessionFields = { sessionPolicy?: typeof SESSION_A1.id; ownerAttestedAt?: number };
export function sessionTiming(value: SessionFields & { quietSince: number; usageObservedAt: number;
  windowStart: number }, now: number) {
  if (value.sessionPolicy === undefined) {
    ensure(value.ownerAttestedAt === undefined, "SESSION_POLICY", "Unbound owner attestation.");
    return value.quietSince + 900000 <= value.usageObservedAt &&
      value.usageObservedAt <= value.windowStart && now - value.usageObservedAt <= 60000;
  }
  ensure(value.sessionPolicy === SESSION_A1.id, "SESSION_POLICY", "Unknown session policy.");
  const at = value.ownerAttestedAt;
  return Number.isSafeInteger(at) && at! > 0 && at! <= value.windowStart && at! <= now &&
    now - at! <= SESSION_A1.ownerAttestationAgeMs && value.quietSince <= at! &&
    value.usageObservedAt <= at!;
}
export function sessionGrantKeys(value: SessionFields, legacy: string[]) {
  return value.sessionPolicy === undefined ? legacy : [...legacy, "sessionPolicy", "ownerAttestedAt"];
}
export type SessionPlan = {
  policy: typeof SESSION_A1.id; day: string; knownPriorHttp: number; laterExternalReservedHttp: number;
  usageObservedAt: number; usageReference: string; evidenceBasis: "OWNER_ATTESTED_PARTIAL_UI" | "VERIFIED_PROJECT_TOTAL";
  quotaHead: string; manifestHash: string; sourceDigest: string; buildId: string;
  maxHttpRequests: 6 | 12; expiresAt: number;
};
export type SessionReady = { scopeSha256: string; planSha256: string; atMs: number; day: string;
  knownPriorHttp: number; exclusive: true; completeHistoryConfirmed: true };
const hash = /^[a-f0-9]{64}$/;
export function validateSessionPlan(p: SessionPlan, expected: {
  manifestHash: string; sourceDigest: string; buildId: string; maxHttpRequests: number; expiresAt: number;
}, day: string, now: number) {
  const keys = ["policy", "day", "knownPriorHttp", "laterExternalReservedHttp", "usageObservedAt",
    "usageReference", "evidenceBasis", "quotaHead", "manifestHash", "sourceDigest", "buildId", "maxHttpRequests", "expiresAt"];
  ensure(Object.keys(p).sort().join() === keys.sort().join() && p.policy === SESSION_A1.id && p.day === day &&
    [p.knownPriorHttp, p.laterExternalReservedHttp].every(n => Number.isSafeInteger(n) && n >= 0) &&
    p.knownPriorHttp + p.laterExternalReservedHttp + p.maxHttpRequests <= SESSION_A1.dailyCombinedHttp &&
    [p.quotaHead, p.manifestHash, p.sourceDigest].every(v => hash.test(v)) &&
    p.manifestHash === expected.manifestHash && p.sourceDigest === expected.sourceDigest && p.buildId === expected.buildId &&
    p.maxHttpRequests === expected.maxHttpRequests && p.expiresAt === expected.expiresAt && p.expiresAt > now &&
    Number.isSafeInteger(p.usageObservedAt) && p.usageObservedAt > 0 && p.usageObservedAt <= now &&
    /^[a-zA-Z0-9._/-]{1,160}$/.test(p.usageReference) &&
    ["OWNER_ATTESTED_PARTIAL_UI", "VERIFIED_PROJECT_TOTAL"].includes(p.evidenceBasis),
  "SESSION_ACCOUNTING", "Session accounting is incomplete, stale or outside the approved cap.");
}
export function validateSessionReady(r: SessionReady, scopeHash: string, planHash: string,
  plan: SessionPlan, now: number) {
  const keys = ["scopeSha256", "planSha256", "atMs", "day", "knownPriorHttp", "exclusive", "completeHistoryConfirmed"];
  ensure(Object.keys(r).sort().join() === keys.sort().join() && r.scopeSha256 === scopeHash &&
    r.planSha256 === planHash && r.day === plan.day && r.knownPriorHttp === plan.knownPriorHttp &&
    r.exclusive === true && r.completeHistoryConfirmed === true && Number.isSafeInteger(r.atMs) && r.atMs > 0 &&
    r.atMs <= now && now - r.atMs <= SESSION_A1.ownerAttestationAgeMs,
  "SESSION_READY", "Owner readiness is absent, changed or expired.");
}
