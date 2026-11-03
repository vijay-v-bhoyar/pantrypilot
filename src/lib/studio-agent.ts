import type { DashboardAgentRunner, DashboardAgentOutcome } from "./dashboard-agent-contract";
import { z } from "zod";
import { analysisPrompts, type Focus } from "./dashboard";
import { analystResponseSchema, evidenceBrief } from "./dashboard-evidence";

const question = z.enum(analysisPrompts);
const answer = analystResponseSchema;
const publicAnalystErrors = new Set([
  "Configure and authorize Gemini before using the analyst.",
  "Select and qualify an explicit Gemini model before enabling AI. No default or fallback model is used.",
  "AI runs are paused.",
  "One AI run is already in progress.",
  "Wait ten seconds between AI runs.",
  "Daily free quota reached.",
  "AI is available only in operator-approved synthetic demo workspaces.",
  "Usage limits could not be confirmed. Retry shortly.",
  "Usage limit capacity reached. Retry later.",
  "Your membership has ended.",
  "Your role cannot perform this action.",
  "Only synthetic demo prompts are supported.",
  "Operational records changed during analysis. Review the current dashboard and ask again.",
]);
class AnalystError extends Error {
  constructor(
    message: string,
    public code: string,
  ) {
    super(message);
  }
}

// Application-owned adapter delegates model work to the authenticated server.
// Community rendering needs no Studio SDK, chat history, tools or context export.
export function pantryStudioAgent(
  applyFocus: (focus: Focus) => void,
  request: typeof fetch = fetch,
): DashboardAgentRunner {
  return {
    id: "pantry-analyst",
    name: "Pantry dashboard analyst",
    description:
      "Reviews scoped operational evidence, explains verified amounts and selects an approved view without changing records.",
    tools: () => [],
    run: async function* (input, ctx) {
      if (ctx.signal?.aborted) return;
      const trace = {
        threadId: input.threadId,
        runId: input.runId,
        agentId: "pantry-analyst",
      };
      const prompt = question.safeParse(
        input.messages.filter((m) => m.role === "user").at(-1)?.content,
      );
      let status: DashboardAgentOutcome = "error";
      ctx.emit?.({
        type: "run_started",
        trace,
        timestamp: Date.now(),
        query: prompt.success
          ? prompt.data
          : "[unsupported dashboard question]",
        toolSchemas: [],
      });
      yield {
        type: "RUN_STARTED",
        threadId: input.threadId,
        runId: input.runId,
      };
      try {
        if (!prompt.success)
          throw new AnalystError(
            "Choose one of the suggested dashboard questions.",
            "ANALYST_INPUT",
          );
        const signal = AbortSignal.any([
          ...(ctx.signal ? [ctx.signal] : []),
          AbortSignal.timeout(35000),
        ]);
        signal.throwIfAborted();
        yield { type: "STEP_STARTED", stepName: "Review dashboard focus" };
        const response = await request("/api/analytics-agent", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt: prompt.data }),
          signal,
        });
        signal.throwIfAborted();
        const data: unknown = await response.json();
        if (!response.ok) {
          const error = z
            .object({ error: z.object({ message: z.string().max(300) }) })
            .safeParse(data);
          throw new AnalystError(
            error.success && publicAnalystErrors.has(error.data.error.message)
              ? error.data.error.message
              : "The analyst is unavailable. Your dashboard is preserved.",
            "ANALYST_UNAVAILABLE",
          );
        }
        const parsed = answer.safeParse(data);
        if (!parsed.success)
          throw new AnalystError(
            "The analyst returned an unsupported view. Your dashboard is preserved.",
            "ANALYST_OUTPUT",
          );
        const focus = parsed.data.focus;
        const callId = `view-${input.runId}`;
        yield {
          type: "TOOL_CALL_START",
          toolCallId: callId,
          toolCallName: "selectDashboard",
        };
        yield {
          type: "TOOL_CALL_ARGS",
          toolCallId: callId,
          delta: JSON.stringify({ focus }),
        };
        yield { type: "TOOL_CALL_END", toolCallId: callId };
        // Cancellation may arrive while the harness consumes the preceding events.
        signal.throwIfAborted();
        applyFocus(focus);
        yield {
          type: "TOOL_CALL_RESULT",
          messageId: `result-${input.runId}`,
          toolCallId: callId,
          content: JSON.stringify({ focus, operationalRecordsChanged: false }),
        };
        const messageId = `answer-${input.runId}`;
        yield { type: "TEXT_MESSAGE_START", messageId, role: "assistant" };
        yield {
          type: "TEXT_MESSAGE_CONTENT",
          messageId,
          delta: parsed.data.evidence
            ? `At analysis time: ${evidenceBrief(focus, parsed.data.evidence).summary} ${evidenceBrief(focus, parsed.data.evidence).nextStep} Financial and inventory records are unchanged.`
            : `Showing ${focus} first. Financial and inventory records are unchanged.`,
        };
        yield { type: "TEXT_MESSAGE_END", messageId };
        yield { type: "STEP_FINISHED", stepName: "Review dashboard focus" };
        status = "ok";
        yield {
          type: "RUN_FINISHED",
          threadId: input.threadId,
          runId: input.runId,
        };
      } catch (error) {
        if (ctx.signal?.aborted) status = "cancelled";
        else
          yield {
            type: "RUN_ERROR",
            code:
              error instanceof AnalystError
                ? error.code
                : "ANALYST_UNAVAILABLE",
            message:
              error instanceof AnalystError
                ? error.message
                : "The analyst could not complete. Check your current dashboard before retrying.",
          };
      } finally {
        ctx.emit?.({
          type: "run_finished",
          trace,
          timestamp: Date.now(),
          status,
        });
      }
    },
  };
}
