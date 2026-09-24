// Proves a non-yield sessions_yield result clears the clue through the event queue.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  emitAgentEvent,
  resetAgentEventsForTest,
  type AgentEventPayload,
} from "../infra/agent-events.js";
import { resetSystemEventsForTest } from "../infra/system-events.js";
import {
  getActiveGatewayRootWorkCount,
  resetGatewayWorkAdmission,
} from "../process/gateway-work-admission.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { holdStateDatabaseCoordinator as holdCoordinator } from "../test-utils/state-database-contention.js";
import "./task-registry.js";
import { tasks } from "./task-registry-state.js";
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
) {
  queueTool(
    runId,
    phase === "start"
      ? { phase, name: "sessions_yield" }
      : {
          phase,
          name: "sessions_yield",
          isError: status === "error",
          result: { details: { status } },
        },
  );
}

describe("sessions_yield event-queue clearing", () => {
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
});
