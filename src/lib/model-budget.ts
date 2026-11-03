import { ensure } from "./errors";

export type ModelLimits = Readonly<{
  maxHttpRequests: number;
  maxInputBytes: number;
  maxOutputTokens: number;
  timeoutMs: number;
}>;

// Admission ceilings, not defaults or a statement about provider billing.
const ceilings: ModelLimits = {
  maxHttpRequests: 10, maxInputBytes: 32768,
  maxOutputTokens: 1024, timeoutMs: 300000,
};
export function validateModelLimits(value: ModelLimits, scope: "run" | "evaluation" = "run"): ModelLimits {
  for (const key of Object.keys(ceilings) as (keyof ModelLimits)[])
    ensure(Number.isSafeInteger(value[key]) && value[key] > 0 && value[key] <=
      (scope === "evaluation" && key === "maxHttpRequests" ? 120 : ceilings[key]),
      "AI_BUDGET_CONFIG", "Configure explicit model request, input, output and time budgets within the approved ceilings.", 503);
  return Object.freeze({ ...value });
}
export function requiredModelLimits(): ModelLimits {
  const number = (name: string) => {
    const raw = process.env[name];
    return raw && /^[1-9][0-9]*$/.test(raw) ? Number(raw) : NaN;
  };
  return validateModelLimits({
    maxHttpRequests: number("AI_MAX_HTTP_REQUESTS"),
    maxInputBytes: number("AI_MAX_INPUT_BYTES"),
    maxOutputTokens: number("AI_MAX_OUTPUT_TOKENS"),
    timeoutMs: number("AI_TIMEOUT_MS"),
  });
}

export function createModelBudget(limits: ModelLimits, scope: "run" | "evaluation" = "run") {
  limits = validateModelLimits(limits, scope);
  let attempts = 0;
  const deadline = Date.now() + limits.timeoutMs;
  const signal = AbortSignal.timeout(limits.timeoutMs);
  return {
    limits, signal,
    get attempts() { return attempts; },
    assertActive() {
      ensure(!signal.aborted && Date.now() < deadline,
        "AI_BUDGET", "The model time budget ended. Existing records are preserved.", 429);
    },
    assertCapacity() {
      this.assertActive();
      ensure(attempts < limits.maxHttpRequests,
        "AI_BUDGET", "The model request budget is exhausted. Existing records are preserved.", 429);
    },
    charge() { this.assertCapacity(); attempts++; },
  };
}
export type ModelBudget = ReturnType<typeof createModelBudget>;

// Extra approval expiry must reach transport without snapshotting live counters.
export function bindModelBudgetSignal(base: ModelBudget, approvalSignal: AbortSignal): ModelBudget {
  const signal = AbortSignal.any([base.signal, approvalSignal]);
  return { limits: base.limits, signal, get attempts() { return base.attempts; },
    assertActive() { signal.throwIfAborted(); base.assertActive(); },
    assertCapacity() { this.assertActive(); base.assertCapacity(); },
    charge() { this.assertActive(); base.charge(); } };
}

export type EvaluationTransportPolicy = Readonly<{
  dispatch(request: { modelId: string; body: string; init: RequestInit;
    signal: AbortSignal; send(): Promise<Response> }): Promise<Response>;
}>;

/** Counts actual outbound HTTP attempts, including SDK continuation steps and failures.
 * Counters live only in this run/process. Durable hosted run quotas remain separate.
 */
export function budgetedModelFetch(
  modelId: string, budget: ModelBudget, signal: AbortSignal,
  shared?: ModelBudget, transport: typeof fetch = fetch, policy?: EvaluationTransportPolicy,
): typeof fetch {
  return async (input, init) => {
    const combined = AbortSignal.any([signal, budget.signal,
      ...(shared ? [shared.signal] : []), ...(init?.signal ? [init.signal] : [])]);
    combined.throwIfAborted();
    budget.assertCapacity(); shared?.assertCapacity();
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    ensure(url.origin === "https://generativelanguage.googleapis.com" && !url.username && !url.password &&
      url.pathname === `/v1beta/models/${modelId}:generateContent` && !url.search && init?.method === "POST",
      "AI_BUDGET", "The model transport target was refused.", 503);
    ensure(typeof init.body === "string" && Buffer.byteLength(init.body, "utf8") <= budget.limits.maxInputBytes &&
      (!shared || Buffer.byteLength(init.body, "utf8") <= shared.limits.maxInputBytes),
      "AI_BUDGET", "The serialized model input exceeds the approved budget.", 413);
    let payload: { generationConfig?: { maxOutputTokens?: unknown } };
    try { payload = JSON.parse(init.body); } catch { payload = {}; }
    const tokens = payload?.generationConfig?.maxOutputTokens;
    ensure(typeof tokens === "number" && Number.isSafeInteger(tokens) && tokens > 0 &&
      tokens <= budget.limits.maxOutputTokens && (!shared || tokens <= shared.limits.maxOutputTokens),
      "AI_BUDGET", "The model output limit exceeds the approved budget.", 503);
    const body = init.body;
    const send = async () => {
      // Policy waits/counting never extend the original generation budgets.
      combined.throwIfAborted(); budget.assertCapacity(); shared?.assertCapacity();
      budget.charge(); shared?.charge();
      return transport(input, { ...init, body, signal: combined, redirect: "error" });
    };
    const response = policy ? await policy.dispatch({ modelId, body, init: { ...init, body }, signal: combined, send }) : await send();
    combined.throwIfAborted(); budget.assertActive(); shared?.assertActive();
    return response;
  };
}
