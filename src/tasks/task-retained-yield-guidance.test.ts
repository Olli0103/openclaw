// Covers retained sessions_yield diagnostics for audit, maintenance, and drain.
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { prepareCanonicalTaskActivation } from "./task-backing-authority-write.js";
import { createSubagentTaskBackingDetail } from "./task-backing-authority.js";
import { createRunningTaskRun, withTaskExecutorStateDir } from "./task-executor.test-support.js";
import {
  captureTaskAgentEventChange,
  prepareTaskAgentEventUpdate,
} from "./task-registry-agent-event.operation.js";
import { captureTaskPersistenceReceipt } from "./task-registry-records.js";
import { tasks } from "./task-registry-state.js";
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
import { getTaskRegistryStore } from "./task-registry.store.js";
import { loadTaskRegistryStateFromSqliteReadOnly } from "./task-registry.store.sqlite.js";
import type { TaskRecord } from "./task-registry.types.js";
import { formatActiveTaskRestartBlocker } from "./task-restart-blocker.js";
import { isRetainedYieldOwner, RETAINED_YIELD_GUIDANCE } from "./task-retained-yield-guidance.js";
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
      `lastTool=sessions_yield unverified. ${RETAINED_YIELD_GUIDANCE}`,
    );
    expect(formatActiveTaskRestartBlocker(yieldBlocker)).not.toContain("retained yield owner");
    expect(formatActiveTaskRestartBlocker(liveBlocker)).not.toContain("sessions_yield");
    expect((await runTaskRegistryMaintenance()).reconciled).toBe(0);
    expect(currentTasks.get(yielded.taskId)?.status).toBe("running");
    expect(currentTasks.get(live.taskId)?.status).toBe("running");
  });

  it("does not label a resumed generation that still had sessions_yield as its previous tool", async () => {
    await withTaskExecutorStateDir(async () => {
      const created = createRunningTaskRun({
        runtime: "subagent",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        childSessionKey: "agent:main:subagent:resumed-yield",
        runId: "resumed-yield-run",
        task: "Resume after yield",
        startedAt: 1,
        lastEventAt: 1,
      });
      const stored = tasks.get(created.taskId);
      if (!stored?.parentFlowId || !stored.childSessionKey || !stored.runId) {
        throw new Error("expected a mirrored running task");
      }
      stored.lastToolName = "sessions_yield";
      getTaskRegistryStore().upsertTaskWithDeliveryState({ task: stored });
      const persisted = loadTaskRegistryStateFromSqliteReadOnly().tasks.get(stored.taskId);
      expect(persisted?.lastToolName).toBe("sessions_yield");
      expect(isRetainedYieldOwner(persisted ?? stored)).toBe(true);

      const prepared = prepareCanonicalTaskActivation({
        runtime: "subagent",
        childSessionKey: stored.childSessionKey,
        runId: stored.runId,
        detail: createSubagentTaskBackingDetail(2),
        startedAt: 2,
      });
      if (!prepared) {
        throw new Error("expected canonical activation");
      }
      expect(prepared.current.lastToolName).toBe("sessions_yield");
      getTaskRegistryStore().upsertTaskWithDeliveryState({ task: prepared.next });
      const resumed = loadTaskRegistryStateFromSqliteReadOnly().tasks.get(stored.taskId);
      expect(resumed?.status).toBe("running");
      expect(resumed?.endedAt).toBeUndefined();
      expect(resumed?.lastToolName).toBeUndefined();
      expect(isRetainedYieldOwner(resumed ?? prepared.next)).toBe(false);
    });
  });

  it("clears a deferred or rejected sessions_yield instead of keeping the clue", () => {
    const task = makeStaleTask({
      runId: "run-yield",
      childSessionKey: "agent:main:subagent:yield",
      lastToolName: "sessions_yield",
    });
    const expectedTask = captureTaskPersistenceReceipt(task);
    for (const result of [
      { details: { status: "deferred" } },
      { details: { status: "error", error: "Yield not supported in this context" } },
      { details: { status: "already_pending" } },
    ]) {
      const change = captureTaskAgentEventChange(
        task,
        {
          runId: "run-yield",
          seq: 2,
          stream: "tool",
          ts: (task.lastEventAt ?? task.createdAt) + 1,
          data: {
            phase: "result",
            name: "sessions_yield",
            toolCallId: "yield-1",
            isError: result.details.status === "error",
            result,
          },
        },
        false,
        "yield-1",
      );
      expect(change?.clearLastToolName).toBe(true);
      const update = change
        ? prepareTaskAgentEventUpdate(task, { taskId: task.taskId, expectedTask, change })
        : null;
      if (!update) {
        throw new Error("expected the unconfirmed yield name to clear");
      }
      expect(update.task.lastToolName).toBeUndefined();
      expect(Object.hasOwn(update.task, "lastToolName")).toBe(false);
      expect(isRetainedYieldOwner(update.task)).toBe(false);
    }

    const yielded = captureTaskAgentEventChange(
      task,
      {
        runId: "run-yield",
        seq: 3,
        stream: "tool",
        ts: (task.lastEventAt ?? task.createdAt) + 1,
        data: {
          phase: "result",
          name: "sessions_yield",
          toolCallId: "yield-1",
          isError: false,
          result: { details: { status: "yielded" } },
        },
      },
      false,
      "yield-1",
    );
    expect(yielded?.clearLastToolName).toBeUndefined();
    expect(isRetainedYieldOwner(task)).toBe(true);

    const unknown = captureTaskAgentEventChange(
      task,
      {
        runId: "run-yield",
        seq: 4,
        stream: "tool",
        ts: (task.lastEventAt ?? task.createdAt) + 1,
        data: { phase: "result", name: "sessions_yield", toolCallId: "yield-1", isError: false },
      },
      false,
      "yield-1",
    );
    expect(unknown?.clearLastToolName).toBeUndefined();
    expect(isRetainedYieldOwner(task)).toBe(true);
  });

  it("shows the unverified clue through openclaw tasks audit", async () => {
    await withTaskExecutorStateDir(async (stateDir) => {
      const staleAt = Date.now() - 45 * 60_000;
      const created = createRunningTaskRun({
        runtime: "subagent",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        childSessionKey: "agent:main:subagent:cli-yield",
        runId: "cli-yield-run",
        task: "CLI yield clue",
        startedAt: staleAt,
        lastEventAt: staleAt,
      });
      const stored = tasks.get(created.taskId);
      if (!stored) {
        throw new Error("expected stored task");
      }
      stored.lastToolName = "sessions_yield";
      stored.startedAt = staleAt;
      stored.lastEventAt = staleAt;
      getTaskRegistryStore().upsertTaskWithDeliveryState({ task: stored });
      await closeOpenClawStateDatabaseAsync();
      const copyDir = mkdtempSync(path.join(tmpdir(), "yield-audit-proof-"));
      try {
        cpSync(stateDir, copyDir, { recursive: true });
        const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
        const started = Date.now();
        const output = spawnSync(process.execPath, ["openclaw.mjs", "tasks", "audit", "--json"], {
          cwd: repoRoot,
          env: {
            PATH: process.env.PATH ?? "",
            HOME: process.env.HOME ?? "",
            OPENCLAW_STATE_DIR: copyDir,
            OPENCLAW_COMPILE_CACHE_DISABLED_RESPAWNED: "1",
          },
          encoding: "utf8",
          timeout: 180_000,
        });
        const wallMs = Date.now() - started;
        const rendered = `${output.stdout ?? ""}\n${output.stderr ?? ""}`;
        if (output.status !== 0 || !rendered.includes("not a confirmed pause")) {
          throw new Error(
            JSON.stringify({
              status: output.status,
              error: output.error?.message,
              signal: output.signal,
              wallMs,
              files: readdirSync(copyDir),
              stdout: (output.stdout ?? "").slice(0, 800),
              stderr: (output.stderr ?? "").slice(0, 800),
            }),
          );
        }
        expect(rendered).toContain(created.taskId);
        expect(wallMs).toBeGreaterThan(0);
      } finally {
        rmSync(copyDir, { recursive: true, force: true });
      }
    });
  }, 180_000);
});
