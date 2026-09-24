// Shared operator note for a running task whose current generation last started sessions_yield.
// Successor activation clears the previous generation's tool name, so resumed work is not labeled.
import type { TaskRecord } from "./task-registry.types.js";

export const RETAINED_YIELD_GUIDANCE = [
  "retained sessions_yield owner, not necessarily a live worker.",
  "Review the exact owner and generation, pending inputs, descendants, outstanding continuations, and parent delivery before tasks.cancel.",
  "Age, delivery, or a quiet turn does not prove the child finished.",
].join(" ");

export function isRetainedYieldOwner(
  task: Pick<TaskRecord, "status" | "endedAt" | "lastToolName">,
): boolean {
  return (
    task.status === "running" && task.endedAt == null && task.lastToolName === "sessions_yield"
  );
}
