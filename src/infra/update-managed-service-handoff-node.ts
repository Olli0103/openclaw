import path from "node:path";
import { UpdatePreMutationError } from "../cli/update-cli/shared.js";
import {
  resolveBunRuntimeInfo,
  resolveNodeRuntimeInfo,
  resolveSystemNodeInfo,
} from "../daemon/runtime-paths.js";
import { buildCliRespawnPlan } from "../entry.respawn.js";
import {
  isExecutableFile,
  resolveExecutableFromPathEnv,
  resolveExecutablePath,
} from "./executable-path.js";
import type { RespawnSupervisor } from "./supervisor-markers.js";

const RUNTIME_RECOVERY_ACTION =
  "Inspect the service with `openclaw gateway status --deep` and refresh its definition under the installation owner (for a standard OpenClaw-managed service: `openclaw gateway install --force`). Then retry the update. The serving Gateway has not been stopped.";

class ManagedHandoffNodeUnavailableError extends UpdatePreMutationError {
  constructor() {
    super(
      "managed-service-handoff-failed",
      `The Gateway's Node executable was removed and no compatible replacement was found. Install a supported Node. ${RUNTIME_RECOVERY_ACTION}`,
    );
    this.name = "ManagedHandoffNodeUnavailableError";
  }
}

class ManagedHandoffServiceRuntimeUnavailableError extends UpdatePreMutationError {
  constructor(cause?: unknown) {
    super(
      "managed-service-handoff-failed",
      `The Gateway's service definition could not be verified with an available executable. ${RUNTIME_RECOVERY_ACTION}`,
      { cause },
    );
    this.name = "ManagedHandoffServiceRuntimeUnavailableError";
  }
}

async function assertManagedHandoffServiceRuntime(
  supervisor: RespawnSupervisor | null | undefined,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  if (!supervisor) {
    return; // A foreground Gateway has no native service to restart.
  }
  let command: { programArguments: string[] } | null;
  try {
    command =
      supervisor === "launchd"
        ? await (
            await import("../daemon/launchd-runtime.js")
          ).readLaunchAgentProgramArguments(env, {
            requireEffective: true,
          })
        : supervisor === "systemd"
          ? await (
              await import("../daemon/systemd-service-files.js")
            ).readSystemdServiceExecStart(env, { requireEffective: true })
          : await (
              await import("../daemon/schtasks-layout.js")
            ).readScheduledTaskCommand(env, {
              requireEffective: true,
            });
  } catch (cause) {
    throw new ManagedHandoffServiceRuntimeUnavailableError(cause);
  }
  const args = command?.programArguments ?? [];
  const executable = args[0];
  const gatewayIndex = args.indexOf("gateway");
  const entrypoint = args[gatewayIndex - 1];
  const runtimeName = path.basename(executable ?? "").toLowerCase();
  // A supported service wrapper has the shape [wrapper, "gateway", ...]. Its
  // executable can be healthy while its hidden Node path is gone. Only a direct
  // runtime + CLI entrypoint can be verified before parking the serving Gateway.
  if (
    !executable ||
    !resolveExecutablePath(executable, { env, useCache: false }) ||
    gatewayIndex < 2 ||
    !entrypoint ||
    !path.isAbsolute(entrypoint) ||
    !/\.(?:[cm]?js|ts)$/iu.test(entrypoint) ||
    !/^(?:node|bun)(?:\.exe)?$/iu.test(runtimeName)
  ) {
    throw new ManagedHandoffServiceRuntimeUnavailableError();
  }
  const runtime = runtimeName.startsWith("bun")
    ? await resolveBunRuntimeInfo(executable, undefined, env)
    : await resolveNodeRuntimeInfo(executable, env);
  if (runtime.status !== "supported") {
    throw new ManagedHandoffServiceRuntimeUnavailableError();
  }
}

/** The original Gateway executable may disappear while its process stays alive. */
export async function resolveManagedHandoffNodeExecutable(
  env: NodeJS.ProcessEnv,
  supervisor?: RespawnSupervisor | null,
): Promise<string> {
  if (isExecutableFile(process.execPath, { env })) {
    return process.execPath;
  }
  const systemNode = await resolveSystemNodeInfo({ env });
  let replacement = systemNode?.status === "supported" ? systemNode.path : undefined;
  if (!replacement) {
    for (const directory of (env.PATH ?? "").split(path.delimiter).filter(path.isAbsolute)) {
      const pathNode = resolveExecutableFromPathEnv("node", directory, env, { useCache: false });
      if (pathNode && (await resolveNodeRuntimeInfo(pathNode, env)).status === "supported") {
        replacement = pathNode;
        break;
      }
    }
  }
  if (!replacement) {
    throw new ManagedHandoffNodeUnavailableError();
  }
  // The helper may run under the replacement while a preserved native definition
  // still points at the removed path. Never park that service until it can restart.
  await assertManagedHandoffServiceRuntime(supervisor, env);
  return replacement;
}

/** Keep the update CLI on the selected handoff runtime and preserve startup flags. */
export function prepareManagedHandoffCliRuntime(
  commandArgv: string[],
  env: NodeJS.ProcessEnv,
  handoffNodeExecutable: string,
): { nodeExecArgv?: string[]; readyEnv: NodeJS.ProcessEnv } {
  const nodeCommand =
    commandArgv[0] === handoffNodeExecutable ||
    /^(?:node|bun)(?:\.exe)?$/iu.test(path.basename(commandArgv[0] ?? ""));
  const startup = nodeCommand
    ? buildCliRespawnPlan({
        argv: commandArgv,
        env,
        execArgv: [],
        execPath: commandArgv[0],
      })
    : null;
  const nodeExecArgv = nodeCommand
    ? (startup?.argv.slice(0, startup.argv.length - commandArgv.length + 1) ?? [])
    : undefined;
  if (startup) {
    commandArgv[0] = startup.command;
  }
  return { nodeExecArgv, readyEnv: startup?.env ?? env };
}
