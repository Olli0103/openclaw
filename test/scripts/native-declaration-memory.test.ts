import { expect, it } from "vitest";
import { resolveNativeDeclarationCompilerEnv } from "../../scripts/lib/native-declaration-emitter.mts";

const GIB = 1024 ** 3;

it("bounds native declaration Go memory on a 10GiB host", () => {
  const env = resolveNativeDeclarationCompilerEnv({
    env: {},
    platform: "darwin",
    physicalMemoryBytes: 16 * GIB,
    availableMemoryBytes: 16 * GIB,
    cgroupMemoryLimitBytes: 10 * GIB,
    cgroupMemoryLimitPaths: [],
  });
  expect(env.GOMEMLIMIT).toBe("6144MiB");
});

it("scales native declaration Go memory on a larger host", () => {
  const env = resolveNativeDeclarationCompilerEnv({
    env: {},
    platform: "darwin",
    physicalMemoryBytes: 24 * GIB,
    availableMemoryBytes: 24 * GIB,
    cgroupMemoryLimitPaths: [],
  });
  expect(env.GOMEMLIMIT).toBe("14745MiB");
});

it("preserves an explicit Go limit", () => {
  const env = { GOMEMLIMIT: "5GiB" };
  expect(resolveNativeDeclarationCompilerEnv({ env, cgroupMemoryLimitBytes: 10 * GIB })).toBe(env);
});
