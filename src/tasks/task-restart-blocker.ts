// Shared formatting contract for restart diagnostics that report active tasks.
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { TaskRecord, TaskStatus } from "./task-registry.types.js";
import { RETAINED_YIELD_GUIDANCE } from "./task-retained-yield-guidance.js";

export type ActiveTaskRestartBlocker = {
  taskId: string;
  status: Extract<TaskStatus, "running">;
  runtime: TaskRecord["runtime"];
  /** Internal classification; omitted from suspension task metadata. */
  taskKind?: TaskRecord["taskKind"];
  runId?: string;
  label?: string;
  title?: string;
  /** Set only when the stored running task is a retained sessions_yield owner. */
  retainedYield?: "sessions_yield";
};

export function formatActiveTaskRestartBlocker(task: ActiveTaskRestartBlocker): string {
  const formatted = [
    `taskId=${task.taskId}`,
    task.runId ? `runId=${task.runId}` : null,
    `status=${task.status}`,
    `runtime=${task.runtime}`,
    task.label ? `label=${task.label}` : null,
    task.title ? `title=${truncateUtf16Safe(task.title, 80)}` : null,
  ]
    .filter((value): value is string => Boolean(value))
    .join(" ");
  if (task.retainedYield !== "sessions_yield") {
    return formatted;
  }
  return `${formatted} retainedYield=sessions_yield. ${RETAINED_YIELD_GUIDANCE}`;
}
