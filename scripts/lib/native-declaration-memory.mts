import { readProcessMemoryCapacity, type MemoryLimitParams } from "./process-memory.mts";

/** Keep native Go GC slack inside the host budget; Node heap flags do not reach tsgo. */
export function resolveNativeDeclarationCompilerEnv(
  params: MemoryLimitParams & { concurrentCompilers?: 1 | 2 } = {},
): NodeJS.ProcessEnv {
  const env = params.env ?? process.env;
  if (env.GOMEMLIMIT !== undefined) {
    return env;
  }
  const { limitBytes, unresolved } = readProcessMemoryCapacity(params);
  if (unresolved || limitBytes === null) {
    return env;
  }
  // Share the Go-managed budget across overlapping compiler children. This is
  // only a soft Go limit; non-Go RSS and the build parent still need headroom.
  const limitMiB = Math.floor(
    (limitBytes * 0.6) / ((params.concurrentCompilers ?? 1) * 1024 * 1024),
  );
  return limitMiB > 0 ? { ...env, GOMEMLIMIT: `${limitMiB}MiB` } : env;
}

