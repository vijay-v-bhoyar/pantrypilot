import { ensure } from "../../src/lib/errors";
export type GeminiCurrentState = {
  version: 1; status: "HOLD" | "READY_FOR_REVIEW" | "APPROVED_WINDOW" | "CLOSED"; project: string; model: string;
  baseline: { sourceDigest: string; buildId: string };
  proposedPolicy: "PP-GEMINI-SESSION-A1"; policyStatus: "LOCAL_CANDIDATE_UNVERIFIED" | "OFFLINE_VERIFIED";
  runtimeSubject: null | { canonicalRoot: string; id: string; sourceDigest: string; buildId: string;
    manifestHash: string; quotaHead: string };
  currentRelease: null | { status: "REVIEW_ONLY" | "APPROVED" | "EXPIRED" | "CONSUMED"; path: string; sha256: string };
  holds: { initialization: boolean; keys: boolean; providers: boolean; submission: boolean };
  answerHistory: { path: string; count: number; sha256: string };
  failedEvidence: string[]; nextAction: string;
};
export function validateGeminiCurrentState(s: GeminiCurrentState) {
  const keys = ["version", "status", "project", "model", "baseline", "proposedPolicy", "policyStatus",
    "runtimeSubject", "currentRelease", "holds", "answerHistory", "failedEvidence", "nextAction"];
  ensure(Object.keys(s).sort().join() === keys.sort().join() && s.version === 1 &&
    ["HOLD", "READY_FOR_REVIEW", "APPROVED_WINDOW", "CLOSED"].includes(s.status) &&
    s.project === "gen-lang-client-0107804522" && s.model === "gemini-3.6-flash" &&
    s.proposedPolicy === "PP-GEMINI-SESSION-A1" && ["LOCAL_CANDIDATE_UNVERIFIED", "OFFLINE_VERIFIED"].includes(s.policyStatus) &&
    Object.keys(s.holds).sort().join() === "initialization,keys,providers,submission" &&
    Object.values(s.holds).every(v => typeof v === "boolean") &&
    /^[a-f0-9]{64}$/.test(s.baseline.sourceDigest) && /^[a-zA-Z0-9_-]{1,120}$/.test(s.baseline.buildId) &&
    Number.isSafeInteger(s.answerHistory.count) && s.answerHistory.count >= 62 &&
    /^[a-f0-9]{64}$/.test(s.answerHistory.sha256) && s.failedEvidence.length >= 2 &&
    new Set(s.failedEvidence).size === s.failedEvidence.length && s.nextAction.length > 0,
  "CURRENT_STATE", "Current state must have one subject, dated evidence and explicit holds.");
  if (s.runtimeSubject) ensure(Object.keys(s.runtimeSubject).sort().join() ===
    "buildId,canonicalRoot,id,manifestHash,quotaHead,sourceDigest" &&
    [s.runtimeSubject.sourceDigest, s.runtimeSubject.manifestHash, s.runtimeSubject.quotaHead].every(h => /^[a-f0-9]{64}$/.test(h)) &&
    /^[a-f0-9-]{36}$/.test(s.runtimeSubject.id) && s.runtimeSubject.canonicalRoot.length > 0 && s.runtimeSubject.buildId.length > 0,
  "CURRENT_STATE", "Runtime subject is incomplete.");
  if (s.currentRelease) ensure(Object.keys(s.currentRelease).sort().join() === "path,sha256,status" &&
    ["REVIEW_ONLY", "APPROVED", "EXPIRED", "CONSUMED"].includes(s.currentRelease.status) &&
    /^[a-f0-9]{64}$/.test(s.currentRelease.sha256) && s.currentRelease.path.length > 0,
  "CURRENT_STATE", "Release reference is incomplete.");
  const active = s.status === "APPROVED_WINDOW";
  ensure(active === (s.currentRelease?.status === "APPROVED") &&
    (!active || (s.policyStatus === "OFFLINE_VERIFIED" && s.runtimeSubject !== null &&
      !s.holds.initialization && !s.holds.keys && !s.holds.providers)),
  "CURRENT_STATE", "Release metadata contradicts the current holds.");
  // Records are not authority: runtime still verifies separately approved source-bound files.
  return s;
}
