import { readProcessMemoryCapacity, type MemoryLimitParams } from "./process-memory.mts";

/** Keep native Go GC slack inside the host budget; Node heap flags do not reach tsgo. */
export function resolveNativeDeclarationCompilerEnv(
  params: MemoryLimitParams = {},
): NodeJS.ProcessEnv {
  const env = params.env ?? process.env;
  if (env.GOMEMLIMIT !== undefined) {
    return env;
  }
  const { limitBytes, unresolved } = readProcessMemoryCapacity(params);
  if (unresolved || limitBytes === null) {
    return env;
  }
  // A 10GiB host gets a 6GiB Go limit. The remaining 40% covers non-Go RSS,
  // the build parent, and other processes; larger hosts avoid a fixed low cap.
  const limitMiB = Math.floor((limitBytes * 0.6) / (1024 * 1024));
  return limitMiB > 0 ? { ...env, GOMEMLIMIT: `${limitMiB}MiB` } : env;
}

