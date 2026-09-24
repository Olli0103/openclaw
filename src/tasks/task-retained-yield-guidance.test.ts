// Covers retained sessions_yield diagnostics for audit, maintenance, and drain.
import { afterEach, describe, expect, it } from "vitest";
import {
  getInspectableActiveTaskRestartBlockers,
  getTaskRegistryMaintenanceDiagnostics,
  previewTaskRegistryMaintenance,
  runTaskRegistryMaintenance,
  stopTaskRegistryMaintenance,
} from "./task-registry.maintenance.js";
import {
  createTaskRegistryMaintenanceHarness,
  resetTaskRegistryMaintenanceMocks,
} from "./task-registry.maintenance.test-support.js";
import type { TaskRecord } from "./task-registry.types.js";
import { formatActiveTaskRestartBlocker } from "./task-restart-blocker.js";
import { RETAINED_YIELD_GUIDANCE } from "./task-retained-yield-guidance.js";
import { resetDetachedTaskLifecycleRuntimeForTests } from "./task-runtime.test-helpers.js";

function makeStaleTask(overrides: Partial<TaskRecord>): TaskRecord {
  const staleAt = Date.now() - 45 * 60_000;
  return {
    taskId: "task-test",
    runtime: "subagent",
    requesterSessionKey: "agent:main:main",
    ownerKey: "agent:main:main",
    scopeKind: "session",
    task: "test task",
    status: "running",
    deliveryStatus: "delivered",
    notifyPolicy: "silent",
    createdAt: staleAt,
    startedAt: staleAt,
    lastEventAt: staleAt,
    ...overrides,
  };
}

afterEach(async () => {
  await stopTaskRegistryMaintenance();
  resetTaskRegistryMaintenanceMocks();
  resetDetachedTaskLifecycleRuntimeForTests();
});

describe("retained sessions_yield guidance", () => {
  it("explains a retained yield owner without cancelling it", async () => {
    const yieldChild = "agent:main:subagent:yield-owner";
    const liveChild = "agent:main:subagent:live-owner";
    const yielded = makeStaleTask({
      taskId: "task-yield-owner",
      runId: "run-yield-owner",
      childSessionKey: yieldChild,
      lastToolName: "sessions_yield",
    });
    const live = makeStaleTask({
      taskId: "task-live-owner",
      runId: "run-live-owner",
      childSessionKey: liveChild,
      lastToolName: "read",
    });
    const { currentTasks } = createTaskRegistryMaintenanceHarness({
      tasks: [yielded, live],
      sessionStore: {
        [yieldChild]: { sessionId: "yield-owner", updatedAt: Date.now() },
        [liveChild]: { sessionId: "live-owner", updatedAt: Date.now() },
      },
    });

    expect(previewTaskRegistryMaintenance().reconciled).toBe(0);
    const diagnostics = getTaskRegistryMaintenanceDiagnostics().staleRunningTasks;
    expect(diagnostics.find((diagnostic) => diagnostic.taskId === yielded.taskId)).toMatchObject({
      decision: "retained",
      reason: "backing_session_present",
      detail: RETAINED_YIELD_GUIDANCE,
    });
    expect(
      diagnostics.find((diagnostic) => diagnostic.taskId === live.taskId)?.detail,
    ).toBeUndefined();
    const blockers = getInspectableActiveTaskRestartBlockers();
    const yieldBlocker = blockers.find((blocker) => blocker.taskId === yielded.taskId);
    const liveBlocker = blockers.find((blocker) => blocker.taskId === live.taskId);
    if (!yieldBlocker || !liveBlocker) {
      throw new Error("expected both restart blockers");
    }
    expect(yieldBlocker.retainedYield).toBe("sessions_yield");
    expect(liveBlocker.retainedYield).toBeUndefined();
    expect(formatActiveTaskRestartBlocker(yieldBlocker)).toContain(
      `retainedYield=sessions_yield. ${RETAINED_YIELD_GUIDANCE}`,
    );
    expect(formatActiveTaskRestartBlocker(liveBlocker)).not.toContain("sessions_yield");
    expect((await runTaskRegistryMaintenance()).reconciled).toBe(0);
    expect(currentTasks.get(yielded.taskId)?.status).toBe("running");
    expect(currentTasks.get(live.taskId)?.status).toBe("running");
  });
});
