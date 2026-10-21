import { ensure } from "./errors";
import type { Workspace } from "./types";
const runtime = globalThis as typeof globalThis & {
  pantryAgentControllers?: Map<string, Set<AbortController>>;
};
const controllers = (runtime.pantryAgentControllers ??= new Map());
export function agentPaused(w: Workspace, organizationId: string) {
  return (
    w.audit
      .filter(
        (a) => a.action === "agentStop" && a.organizationId === organizationId,
      )
      .at(-1)?.detail === "disabled"
  );
}
export function admitAgent(w: Workspace, organizationId: string) {
  ensure(
    !agentPaused(w, organizationId),
    "AI_STOPPED",
    "AI runs are paused.",
    409,
  );
  const runs = w.agentRuns.filter((r) => r.source === "gemini");
  ensure(
    !runs.some(
      (r) =>
        r.error === "run in progress" &&
        Date.parse(r.createdAt) > Date.now() - 65000,
    ),
    "AI_BUSY",
    "One AI run is already in progress.",
    409,
  );
  ensure(
    !runs.some((r) => Date.parse(r.createdAt) > Date.now() - 10000),
    "AI_RATE",
    "Wait ten seconds between AI runs.",
    429,
  );
}
export function agentController(workspaceId: string, organizationId: string) {
  const key = `${workspaceId}:${organizationId}`;
  const controller = new AbortController();
  const set = controllers.get(key) ?? new Set();
  set.add(controller);
  controllers.set(key, set);
  return {
    controller,
    finish: () => {
      set.delete(controller);
      if (!set.size) controllers.delete(key);
    },
  };
}
export function stopAgents(workspaceId: string, organizationId: string) {
  for (const c of controllers.get(`${workspaceId}:${organizationId}`) || [])
    c.abort(new Error("AI run stopped by the organization owner."));
}
