// Proves a non-yield sessions_yield result clears the clue through the event queue.
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  emitAgentEvent,
  getAgentEventLifecycleGeneration,
  onAgentEvent,
  resetAgentEventsForTest,
  rotateAgentEventLifecycleGeneration,
  type AgentEventPayload,
} from "../infra/agent-events.js";
import { resetSystemEventsForTest } from "../infra/system-events.js";
import {
  getActiveGatewayRootWorkCount,
  resetGatewayWorkAdmission,
} from "../process/gateway-work-admission.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { holdStateDatabaseCoordinator as holdCoordinator } from "../test-utils/state-database-contention.js";
import "./task-registry.js";
import { captureTaskRegistryReadFence } from "./task-registry-listener-state.js";
import { publishTaskRecordAfterAtomicStore } from "./task-registry-publication.js";
import { tasks } from "./task-registry-state.js";
import { getTaskRegistryStore } from "./task-registry.store.js";
import { loadTaskRegistryStateFromSqliteReadOnly } from "./task-registry.store.sqlite.js";
import { createTaskFixture } from "./task-registry.test-support.js";
import {
  resetTaskFlowRegistryForTests,
  resetTaskRegistryForTests,
} from "./task-runtime.test-helpers.js";

afterEach(() => {
  vi.restoreAllMocks();
  resetTaskRegistryForTests({ persist: false });
  resetTaskFlowRegistryForTests({ persist: false });
  resetAgentEventsForTest({ preserveListeners: true });
  resetGatewayWorkAdmission();
  resetSystemEventsForTest();
});

async function joinEvents() {
  await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0), { timeout: 30_000 });
}

function taskPublication(
  taskId: string,
  matches: (task: NonNullable<ReturnType<typeof tasks.get>>) => boolean,
) {
  return vi.waitFor(
    () =>
      expect(
        tasks.get(taskId) && matches(tasks.get(taskId)!),
        JSON.stringify(tasks.get(taskId)),
      ).toBe(true),
    { timeout: 30_000 },
  );
}

function createRunningToolTask(runId: string, task: string) {
  return createTaskFixture("cli", {
    runId,
    task,
    status: "running",
    notifyPolicy: "silent",
    deliveryStatus: "not_applicable",
  });
}

function queueTool(runId: string, data: AgentEventPayload["data"]) {
  emitAgentEvent({ runId, stream: "tool", data });
}

function emitYield(
  runId: string,
  phase: "start" | "result",
  status?: "deferred" | "yielded" | "error",
  toolCallId = "yield-1",
) {
  queueTool(
    runId,
    phase === "start"
      ? { phase, name: "sessions_yield", toolCallId }
      : {
          phase,
          name: "sessions_yield",
          toolCallId,
          isError: status === "error",
          result: { details: { status } },
        },
  );
}

describe("sessions_yield event-queue clearing", () => {
  it.each([false, true])(
    "keeps the current yield across reentrant rotation (explicit: %s)",
    async (explicit) => {
      await withOpenClawTestState({ layout: "state-only" }, async () => {
        // Register before the task listener so the outer event loses its generation in delivery.
        resetTaskRegistryForTests({ persist: false });
        const runId = "yield-reentrant-generation";
        const stop = onAgentEvent((event) => {
          if (event.runId === runId && event.data.name === "older_start") {
            rotateAgentEventLifecycleGeneration();
            emitYield(runId, "start");
          }
        });
        try {
          const task = createRunningToolTask(runId, "Keep the current generation's yield");
          const context = captureOpenClawStateWorkerContext();
          emitAgentEvent({
            runId,
            ...(explicit ? { lifecycleGeneration: getAgentEventLifecycleGeneration() } : {}),
            stream: "tool",
            data: { phase: "start", name: "older_start", toolCallId: "older" },
          });
          // Older queued work may refuse settlement; the nested current call must still persist.
          await Promise.allSettled([captureTaskRegistryReadFence(context.admission)]);
          expect(
            loadTaskRegistryStateFromSqliteReadOnly().tasks.get(task.taskId)?.lastToolName,
          ).toBe("sessions_yield");
          emitYield(runId, "result", "deferred");
          await captureTaskRegistryReadFence(context.admission);
          expect(
            loadTaskRegistryStateFromSqliteReadOnly().tasks.get(task.taskId)?.lastToolName,
          ).toBeUndefined();
        } finally {
          stop();
        }
      });
    },
  );

  it("keeps the current yield call when another database closes", async () => {
    await withOpenClawTestState({ layout: "state-only" }, async () => {
      const task = createRunningToolTask("yield-other-database", "Retain the exact database owner");
      const context = captureOpenClawStateWorkerContext();
      emitYield(task.runId!, "start");
      await captureTaskRegistryReadFence(context.admission);
      const otherPath = path.join(path.dirname(context.admission.databasePath), "other.sqlite");
      openOpenClawStateDatabase({ path: otherPath });
      await closeOpenClawStateDatabaseByPathAsync(otherPath);
      context.admission.assertCurrent();
      emitYield(task.runId!, "result", "deferred");
      await captureTaskRegistryReadFence(context.admission);
      expect(
        loadTaskRegistryStateFromSqliteReadOnly().tasks.get(task.taskId)?.lastToolName,
      ).toBeUndefined();
    });
  });

  it.each([
    ["deferred", false],
    ["error", false],
    ["deferred", true],
  ] as const)(
    "handles a %s result after normalized timestamps (replacement: %s)",
    async (status, replaced) => {
      await withOpenClawTestState({ layout: "state-only" }, async () => {
        const task = createTaskFixture("cli", {
          runId: "yield-normalized-start",
          task: "Clear the exact call after lifecycle timestamp normalization",
          status: "queued",
          startedAt: 1_000,
          notifyPolicy: "silent",
          deliveryStatus: "not_applicable",
        });
        const context = captureOpenClawStateWorkerContext();
        const holder = holdCoordinator(
          context.admission.databasePath,
          context.coordinatorRuntime,
          10_000,
        );
        try {
          await holder.ready;
          emitAgentEvent({
            runId: task.runId!,
            stream: "lifecycle",
            data: { phase: "start", startedAt: 0 },
          });
          emitYield(task.runId!, "start");
          holder.release();
          await holder.joined;
          await captureTaskRegistryReadFence(context.admission);
          expect(loadTaskRegistryStateFromSqliteReadOnly().tasks.get(task.taskId)).toMatchObject({
            createdAt: 0,
            lastToolName: "sessions_yield",
            toolUseCount: 1,
          });

          if (replaced) {
            // Restore the pre-normalization identity, but not the original call's ownership.
            const replacement = {
              ...task,
              status: "running" as const,
              task: "Replacement task",
              lastToolName: "sessions_yield",
              toolUseCount: 1,
            };
            getTaskRegistryStore().upsertTaskWithDeliveryState({ task: replacement });
            publishTaskRecordAfterAtomicStore(replacement);
          }
          emitYield(task.runId!, "result", status);
          await captureTaskRegistryReadFence(context.admission);
          const durable = loadTaskRegistryStateFromSqliteReadOnly().tasks.get(task.taskId);
          expect(durable?.lastToolName).toBe(replaced ? "sessions_yield" : undefined);
          expect(durable?.toolUseCount).toBe(1);
        } finally {
          holder.release();
          await holder.joined;
        }
      });
    },
  );

  it("clears a quick non-yield result inside the liveness window", async () => {
    await withOpenClawTestState({ layout: "state-only" }, async () => {
      const task = createRunningToolTask("yield-clear-window", "Clear a deferred yield");
      const started = taskPublication(
        task.taskId,
        (current) => current.lastToolName === "sessions_yield",
      );
      emitYield(task.runId!, "start");
      await started;
      await joinEvents();
      const cleared = taskPublication(
        task.taskId,
        (current) => current.lastToolName !== "sessions_yield",
      );
      emitYield(task.runId!, "result", "deferred");
      await cleared;
      await joinEvents();
      expect(
        loadTaskRegistryStateFromSqliteReadOnly().tasks.get(task.taskId)?.lastToolName,
      ).toBeUndefined();
    });
  });

  it("keeps a confirmed yield result that arrives inside the liveness window", async () => {
    await withOpenClawTestState({ layout: "state-only" }, async () => {
      const task = createRunningToolTask("yield-keep-window", "Keep a confirmed yield");
      const started = taskPublication(
        task.taskId,
        (current) => current.lastToolName === "sessions_yield",
      );
      emitYield(task.runId!, "start");
      await started;
      await joinEvents();
      emitYield(task.runId!, "result", "yielded");
      await joinEvents();
      expect(loadTaskRegistryStateFromSqliteReadOnly().tasks.get(task.taskId)?.lastToolName).toBe(
        "sessions_yield",
      );
    });
  });

  it("drops a queued yield start when its non-yield result shares that batch", async () => {
    await withOpenClawTestState({ layout: "state-only" }, async () => {
      const task = createRunningToolTask("yield-batched-clear", "Clear a still-queued yield start");
      const context = captureOpenClawStateWorkerContext();
      const holder = holdCoordinator(
        context.admission.databasePath,
        context.coordinatorRuntime,
        10_000,
      );
      try {
        await holder.ready;
        emitYield(task.runId!, "start");
        emitYield(task.runId!, "result", "error");
        holder.release();
        await holder.joined;
        await joinEvents();
        const durable = loadTaskRegistryStateFromSqliteReadOnly().tasks.get(task.taskId);
        expect(durable?.lastToolName).toBeUndefined();
        expect(durable?.toolUseCount).toBe(1);
      } finally {
        holder.release();
        await holder.joined;
      }
    });
  });

  it("keeps a newer queued tool start after a non-yield result", async () => {
    await withOpenClawTestState({ layout: "state-only" }, async () => {
      const task = createRunningToolTask("yield-next-start", "Keep the newer tool");
      const context = captureOpenClawStateWorkerContext();
      const holder = holdCoordinator(
        context.admission.databasePath,
        context.coordinatorRuntime,
        10_000,
      );
      try {
        await holder.ready;
        emitYield(task.runId!, "start");
        emitYield(task.runId!, "result", "deferred");
        queueTool(task.runId!, { phase: "start", name: "newer_tool" });
        holder.release();
        await joinEvents();
        const durable = loadTaskRegistryStateFromSqliteReadOnly().tasks.get(task.taskId);
        expect(durable?.lastToolName).toBe("newer_tool");
        expect(durable?.toolUseCount).toBe(2);
      } finally {
        holder.release();
        await holder.joined;
      }
    });
  });

  it("does not let a late yield result clear a different queued tool", async () => {
    await withOpenClawTestState({ layout: "state-only" }, async () => {
      const task = createRunningToolTask("yield-late-result", "Keep a different queued tool");
      const context = captureOpenClawStateWorkerContext();
      const holder = holdCoordinator(
        context.admission.databasePath,
        context.coordinatorRuntime,
        10_000,
      );
      try {
        await holder.ready;
        emitYield(task.runId!, "start");
        queueTool(task.runId!, { phase: "start", name: "newer_tool" });
        emitYield(task.runId!, "result", "deferred");
        holder.release();
        await holder.joined;
        await joinEvents();
        const durable = loadTaskRegistryStateFromSqliteReadOnly().tasks.get(task.taskId);
        expect(durable?.lastToolName).toBe("newer_tool");
        expect(durable?.toolUseCount).toBe(2);
      } finally {
        holder.release();
        await holder.joined;
      }
    });
  });

  it("keeps a newer same-name yield when an older call returns deferred", async () => {
    await withOpenClawTestState({ layout: "state-only" }, async () => {
      const task = createRunningToolTask("yield-overlap", "Keep the newer yield");
      const context = captureOpenClawStateWorkerContext();
      const holder = holdCoordinator(
        context.admission.databasePath,
        context.coordinatorRuntime,
        10_000,
      );
      try {
        await holder.ready;
        emitYield(task.runId!, "start", undefined, "older");
        emitYield(task.runId!, "start", undefined, "newer");
        emitYield(task.runId!, "result", "deferred", "older");
        emitYield(task.runId!, "result", "yielded", "newer");
        holder.release();
        await holder.joined;
        await joinEvents();
        const durable = loadTaskRegistryStateFromSqliteReadOnly().tasks.get(task.taskId);
        expect(durable?.lastToolName).toBe("sessions_yield");
        expect(durable?.toolUseCount).toBe(2);
      } finally {
        holder.release();
        await holder.joined;
      }
    });
  });

  it("keeps a committed newer yield when the older result arrives later", async () => {
    await withOpenClawTestState({ layout: "state-only" }, async () => {
      const task = createRunningToolTask("yield-overlap-committed", "Keep a committed newer yield");
      emitYield(task.runId!, "start", undefined, "older");
      await taskPublication(task.taskId, (current) => current.toolUseCount === 1);
      await joinEvents();
      emitYield(task.runId!, "start", undefined, "newer");
      await taskPublication(task.taskId, (current) => current.toolUseCount === 2);
      await joinEvents();
      emitYield(task.runId!, "result", "deferred", "older");
      await joinEvents();
      emitYield(task.runId!, "result", "yielded", "newer");
      await joinEvents();
      const durable = loadTaskRegistryStateFromSqliteReadOnly().tasks.get(task.taskId);
      expect(durable?.lastToolName).toBe("sessions_yield");
      expect(durable?.toolUseCount).toBe(2);
    });
  });
});
