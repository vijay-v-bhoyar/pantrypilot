/** Application-owned event contract. No Studio SDK is imported or required. */
export type DashboardAgentOutcome = "ok" | "error" | "cancelled";
export type DashboardAgentEvent =
  | { type: "RUN_STARTED" | "RUN_FINISHED"; threadId: string; runId: string }
  | { type: "STEP_STARTED" | "STEP_FINISHED"; stepName: string }
  | { type: "TOOL_CALL_START"; toolCallId: string; toolCallName: string }
  | { type: "TOOL_CALL_ARGS"; toolCallId: string; delta: string }
  | { type: "TOOL_CALL_END"; toolCallId: string }
  | { type: "TOOL_CALL_RESULT"; messageId: string; toolCallId: string; content: string }
  | { type: "TEXT_MESSAGE_START"; messageId: string; role: "assistant" }
  | { type: "TEXT_MESSAGE_CONTENT"; messageId: string; delta: string }
  | { type: "TEXT_MESSAGE_END"; messageId: string }
  | { type: "RUN_ERROR"; code: string; message: string };
export type DashboardAgentInput = {
  threadId: string; runId: string;
  messages: { id: string; role: "user" | "assistant" | "system"; content: string }[];
  tools: readonly unknown[]; context: readonly unknown[];
  state: Record<string, unknown>; forwardedProps: Record<string, unknown>;
};
type Trace = { threadId: string; runId: string; agentId: string };
export type DashboardAgentContext = {
  params: undefined; instructions(): undefined; tools(): readonly unknown[]; signal?: AbortSignal;
  emit?(event:
    | { type: "run_started"; trace: Trace; timestamp: number; query: string; toolSchemas: readonly unknown[] }
    | { type: "run_finished"; trace: Trace; timestamp: number; status: DashboardAgentOutcome }): void;
};
export type DashboardAgentRunner = {
  id: string; name: string; description: string; tools(): readonly unknown[];
  run(input: DashboardAgentInput, context: DashboardAgentContext): AsyncGenerator<DashboardAgentEvent, void, unknown>;
};
