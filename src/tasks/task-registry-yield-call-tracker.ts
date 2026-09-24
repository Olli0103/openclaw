import type { AgentEventPayload } from "../infra/agent-events.js";
import {
  sameTaskAgentEventSource,
  type TaskAgentEventSource,
} from "./task-registry-agent-event-source.js";
import type { TaskAgentEventTarget } from "./task-registry-agent-event-target.js";

const latestByTask = new Map<
  string,
  { source: TaskAgentEventSource; createdAt: number; callId: string }
>();

export function clearLatestYieldCalls(): void {
  latestByTask.clear();
}

export function forgetLatestYieldCall(taskId: string): void {
  latestByTask.delete(taskId);
}

/** Only the latest matching call may clear a stored sessions_yield clue. */
export function captureLatestYieldCallId(
  task: TaskAgentEventTarget,
  source: TaskAgentEventSource,
  event: AgentEventPayload,
): string | undefined {
  const data = event.data;
  const callId = typeof data.toolCallId === "string" ? data.toolCallId.trim() : "";
  if (event.stream === "tool" && data.phase === "start") {
    const name = typeof data.name === "string" ? data.name.trim() : "";
    if (name === "sessions_yield" && callId) {
      latestByTask.set(task.taskId, { source, createdAt: task.createdAt, callId });
    } else {
      latestByTask.delete(task.taskId);
    }
  }
  const latest = latestByTask.get(task.taskId);
  const matchingId =
    latest && latest.createdAt === task.createdAt && sameTaskAgentEventSource(latest.source, source)
      ? latest.callId
      : undefined;
  if (
    (event.stream === "tool" && data.phase === "result" && callId === matchingId) ||
    (event.stream === "lifecycle" && (data.phase === "end" || data.phase === "error"))
  ) {
    latestByTask.delete(task.taskId);
  }
  return matchingId;
}
