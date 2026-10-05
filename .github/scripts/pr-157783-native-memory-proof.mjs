// Fork-only proof tooling; not part of the candidate's production build policy.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

// Exact rebased PR head; keep the workflow pin synchronized.
const expectedHead = "078fe921e196b2255dfc228d4834fce5f5e58a97";
const GiB = 1024 ** 3;
const MiB = 1024 ** 2;
function containmentBytesForCell(cell) {
  return (cell === "focused-10" ? 10 : 13.75) * GiB;
}
const output = path.resolve(".artifacts/pr-157783-native-memory");
const read = (file) => fs.readFileSync(file, "utf8").trim();
const optionalRead = (file) => {
  try {
    return read(file);
  } catch {
    return null;
  }
};
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function write(name, value) {
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, name), `${JSON.stringify(value, null, 2)}\n`);
}
function sync(bin, args) {
  const result = spawnSync(bin, args, { encoding: "utf8", maxBuffer: 16 * MiB });
  assert.equal(result.status, 0, `${bin} ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}
function verifyHead() {
  assert.equal(sync("git", ["rev-parse", "HEAD"]), expectedHead);
  if (process.env.PROOF_HEAD) assert.equal(process.env.PROOF_HEAD, expectedHead);
}
function memoryInfo() {
  return Object.fromEntries(
    read("/proc/meminfo")
      .split("\n")
      .flatMap((line) => {
        const match = /^(MemTotal|MemAvailable|SwapTotal|SwapFree):\s+(\d+) kB$/u.exec(line);
        return match ? [[match[1], Number(match[2]) * 1024]] : [];
      }),
  );
}
function events() {
  return Object.fromEntries(
    read("/sys/fs/cgroup/memory.events")
      .split("\n")
      .map((line) => {
        const [key, value] = line.split(/\s+/u);
        return [key, Number(value)];
      }),
  );
}
function cgroupMemory() {
  return Object.fromEntries(
    [
      "memory.max",
      "memory.high",
      "memory.current",
      "memory.peak",
      "memory.swap.max",
      "memory.swap.current",
    ].map((name) => [name, optionalRead(`/sys/fs/cgroup/${name}`)]),
  );
}
function hostReceipt(cell) {
  verifyHead();
  const memory = memoryInfo();
  const containmentBytes = containmentBytesForCell(cell);
  const record = /^0::(.*)$/mu.exec(read("/proc/self/cgroup"))?.[1];
  const hierarchy = [];
  let directory = record ? path.join("/sys/fs/cgroup", record) : "/sys/fs/cgroup";
  while (directory.startsWith("/sys/fs/cgroup")) {
    hierarchy.push({
      path: directory,
      max: optionalRead(path.join(directory, "memory.max")),
      high: optionalRead(path.join(directory, "memory.high")),
    });
    if (directory === "/sys/fs/cgroup") break;
    directory = path.dirname(directory);
  }
  const limits = hierarchy
    .flatMap((entry) => [entry.max, entry.high])
    .map(Number)
    .filter((value) => Number.isFinite(value) && value > 0);
  const capacityBytes = Math.min(memory.MemTotal, ...limits);
  const receipt = {
    expectedHead,
    node: process.version,
    architecture: process.arch,
    cpuCount: os.availableParallelism(),
    memory,
    hierarchy,
    capacityBytes,
    containmentBytes,
    requiredHostHeadroomBytes: 256 * MiB,
    runnerClass:
      "standard public ubuntu-24.04 (advertised 4 vCPU / 16 GB); measured capacity is authoritative",
  };
  write(cell ? `host-${cell}.json` : "host.json", receipt);
  console.log(JSON.stringify(receipt));
  assert.equal(process.platform, "linux");
  assert.ok(
    capacityBytes >= containmentBytes + receipt.requiredHostHeadroomBytes,
    `Actual host/cgroup capacity is too small for the requested ${containmentBytes / GiB} GiB cell`,
  );
  assert.ok(
    memory.MemAvailable >= containmentBytes + receipt.requiredHostHeadroomBytes,
    `Actual host headroom is too small for the requested ${containmentBytes / GiB} GiB cell`,
  );
}
function baseEnvironment() {
  const env = {
    ...process.env,
    CI: "true",
    OPENCLAW_BUILD_CACHE: "0",
    OPENCLAW_BUILD_TIMESTAMP: process.env.OPENCLAW_BUILD_TIMESTAMP ?? "2026-10-05T00:00:00.000Z",
    GIT_COMMIT: expectedHead,
  };
  for (const key of [
    "GOMEMLIMIT",
    "GOGC",
    "NODE_OPTIONS",
    "OPENCLAW_TSDOWN_MAX_OLD_SPACE_MB",
    "OPENCLAW_DOCKER_BUILD_TSDOWN_MAX_OLD_SPACE_MB",
    "OPENCLAW_RUN_NODE_SKIP_DTS_BUILD",
    "OPENCLAW_SKIP_NATIVE_PROTOCOL_PREP",
    "OPENCLAW_BUILD_PRIVATE_QA",
    "NODE_COMPILE_CACHE",
  ])
    delete env[key];
  return env;
}
function toolchain() {
  const require = createRequire(path.join(process.cwd(), "package.json"));
  const packageManager = require("./package.json").packageManager;
  const pnpm = sync("pnpm", ["--version"]);
  assert.equal(
    pnpm,
    /^pnpm@([^+]+)/u.exec(packageManager)?.[1],
    "Container package manager differs from source pin",
  );
  assert.equal(process.versions.node, "24.21.0");
  const bun = sync("bun", ["--version"]);
  assert.equal(bun, "1.4.2");
  const typescript = require("typescript/package.json").version;
  assert.equal(typescript, "7.1.0-dev.20260920.1");
  return {
    node: process.version,
    pnpm,
    packageManager,
    bun,
    bunSHA256: hash(fs.readFileSync(fs.realpathSync("/usr/local/bin/bun"))),
    typescript,
    expectedAsyncTransport: "tsgo --api --async",
    lockfileSHA256: hash(fs.readFileSync("pnpm-lock.yaml")),
  };
}
function clearCompilerCaches() {
  if (!fs.existsSync(".artifacts")) return;
  for (const entry of fs.readdirSync(".artifacts"))
    if (entry !== path.basename(output))
      fs.rmSync(path.join(".artifacts", entry), { recursive: true, force: true });
}
function coldOutputs() {
  // Dedicated disposable checkout only. Never invoke a cell on a live host.
  for (const root of [
    "dist",
    "dist-runtime",
    ...fs.readdirSync("packages").map((name) => `packages/${name}/dist`),
  ])
    fs.rmSync(root, { recursive: true, force: true });
  clearCompilerCaches();
}
function outputManifest() {
  const roots = [
    "dist",
    "dist-runtime",
    ...fs
      .readdirSync("packages")
      .map((name) => `packages/${name}/dist`)
      .filter((root) => fs.existsSync(root)),
  ];
  assert.ok(fs.existsSync("dist") && fs.existsSync("dist-runtime"));
  const entries = [];
  function visit(file) {
    const stat = fs.lstatSync(file);
    const base = { path: file.split(path.sep).join("/"), mode: stat.mode & 0o777 };
    if (stat.isSymbolicLink())
      entries.push({ ...base, kind: "symlink", target: fs.readlinkSync(file) });
    else if (stat.isDirectory()) {
      entries.push({ ...base, kind: "directory" });
      for (const name of fs.readdirSync(file).toSorted()) visit(path.join(file, name));
    } else if (stat.isFile()) {
      const bytes = fs.readFileSync(file);
      const entry = { ...base, kind: "file", size: stat.size, sha256: hash(bytes) };
      // Preserve every raw hash. Only explicitly named local-stamp clock fields
      // are normalized in the separately labeled same-head comparison.
      if (file === "dist/.buildstamp" || file === "dist/.runtime-postbuildstamp") {
        const value = JSON.parse(bytes.toString("utf8"));
        delete value.builtAt;
        delete value.syncedAt;
        entry.timestampNormalizedSHA256 = hash(JSON.stringify(value));
      }
      entries.push(entry);
    } else throw new Error(`Unsupported output type: ${file}`);
  }
  for (const root of roots) visit(root);
  return { expectedHead, roots, entries: entries.toSorted((a, b) => a.path.localeCompare(b.path)) };
}
function compareManifests() {
  verifyHead();
  const auto = JSON.parse(read(path.join(output, "build-auto-manifest.json")));
  const override = JSON.parse(read(path.join(output, "build-override-manifest.json")));
  const lhs = new Map(auto.entries.map((entry) => [entry.path, entry]));
  const rhs = new Map(override.entries.map((entry) => [entry.path, entry]));
  const rawDifferences = [],
    unexplainedDifferences = [];
  function normalize(entry) {
    if (!entry?.timestampNormalizedSHA256) return entry;
    const { sha256: _rawHash, size: _rawSize, timestampNormalizedSHA256, ...rest } = entry;
    return { ...rest, sha256: timestampNormalizedSHA256 };
  }
  for (const file of [...new Set([...lhs.keys(), ...rhs.keys()])].toSorted()) {
    const left = lhs.get(file),
      right = rhs.get(file);
    if (JSON.stringify(left) === JSON.stringify(right)) continue;
    rawDifferences.push({ path: file, auto: left ?? null, override: right ?? null });
    if (JSON.stringify(normalize(left)) !== JSON.stringify(normalize(right)))
      unexplainedDifferences.push(file);
  }
  write("comparison.json", {
    expectedHead,
    status:
      unexplainedDifferences.length === 0 ? "passed-with-named-timestamp-normalization" : "failed",
    comparison:
      "Entire dist, dist-runtime and package-dist inventories; all raw hashes retained. Only dist/.buildstamp builtAt and dist/.runtime-postbuildstamp syncedAt normalized in the separately labeled comparison",
    autoEntries: lhs.size,
    overrideEntries: rhs.size,
    rawIdentical: rawDifferences.length === 0,
    rawDifferences,
    unexplainedDifferences,
    identicalAfterNamedTimestampNormalization: unexplainedDifferences.length === 0,
  });
  console.log(
    `Complete manifests: ${lhs.size} / ${rhs.size} entries, ${rawDifferences.length} raw differences, ${unexplainedDifferences.length} unexplained differences`,
  );
  assert.equal(
    unexplainedDifferences.length,
    0,
    "Output comparison failed; inspect the retained diff, do not ignore declaration chunks",
  );
}
async function runMeasured(
  name,
  bin,
  args,
  env,
  { expectCompilers = false, expectedOverride, sharedBudget = false, timeoutMs = 45 * 60_000 } = {},
) {
  const tools = toolchain();
  const memoryBefore = cgroupMemory(),
    eventsBefore = events(),
    started = Date.now();
  const compilers = new Map();
  let peakProcessRSSKiB = 0,
    peakCompilerRSSKiB = 0,
    maxConcurrentCompilers = 0,
    timedOut = false,
    exit;
  const log = fs.openSync(path.join(output, `${name}.log`), "w");
  const child = spawn(bin, args, { env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  const knownOwned = new Set([child.pid]);
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (bytes) => {
      fs.writeSync(log, bytes);
      process.stdout.write(bytes);
    });
  function signal(value) {
    try {
      process.kill(-child.pid, value);
    } catch {}
  }
  const timeout = setTimeout(() => {
    timedOut = true;
    signal("SIGTERM");
    setTimeout(() => signal("SIGKILL"), 10_000).unref();
  }, timeoutMs);
  function sample() {
    const rows = [];
    for (const pid of fs.readdirSync("/proc")) {
      if (!/^\d+$/u.test(pid)) continue;
      try {
        const status = read(`/proc/${pid}/status`);
        const argv = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
        rows.push({
          pid: Number(pid),
          ppid: Number(/^PPid:\s+(\d+)/mu.exec(status)?.[1]),
          rssKiB: Number(/^VmRSS:\s+(\d+) kB$/mu.exec(status)?.[1] ?? 0),
          argv,
        });
      } catch {
        /* Processes can exit between procfs reads. */
      }
    }
    const owned = new Set(knownOwned);
    let changed;
    do {
      changed = false;
      for (const row of rows)
        if (owned.has(row.ppid) && !owned.has(row.pid)) {
          owned.add(row.pid);
          changed = true;
        }
    } while (changed);
    for (const pid of owned) knownOwned.add(pid);
    let totalRSS = 0,
      compilerRSS = 0,
      active = 0;
    for (const row of rows.filter((entry) => owned.has(entry.pid))) {
      totalRSS += row.rssKiB;
      if (
        !row.argv.includes("--api") ||
        !/^tsgo(?:\.exe)?$/u.test(path.basename(row.argv[0] ?? ""))
      )
        continue;
      const isAsync = row.argv.includes("--async");
      if (isAsync) active++;
      compilerRSS += row.rssKiB;
      if (!compilers.has(row.pid)) {
        try {
          const environment = Object.fromEntries(
            fs
              .readFileSync(`/proc/${row.pid}/environ`, "utf8")
              .split("\0")
              .flatMap((entry) => {
                const split = entry.indexOf("="),
                  key = entry.slice(0, split);
                return [
                  "GOMEMLIMIT",
                  "GOGC",
                  "OPENCLAW_TSDOWN_MAX_OLD_SPACE_MB",
                  "NODE_OPTIONS",
                ].includes(key)
                  ? [[key, entry.slice(split + 1)]]
                  : [];
              }),
          );
          compilers.set(row.pid, {
            pid: row.pid,
            parentPid: row.ppid,
            executable: path.basename(row.argv[0]),
            transport: isAsync ? "--api --async" : "--api (sync parser)",
            async: isAsync,
            firstSeenMs: Date.now() - started,
            lastSeenMs: Date.now() - started,
            peakRSSKiB: row.rssKiB,
            environment,
          });
        } catch {
          continue;
        }
      }
      const record = compilers.get(row.pid);
      record.lastSeenMs = Date.now() - started;
      record.peakRSSKiB = Math.max(record.peakRSSKiB, row.rssKiB);
    }
    peakProcessRSSKiB = Math.max(peakProcessRSSKiB, totalRSS);
    peakCompilerRSSKiB = Math.max(peakCompilerRSSKiB, compilerRSS);
    maxConcurrentCompilers = Math.max(maxConcurrentCompilers, active);
  }
  const timer = setInterval(sample, 200);
  sample();
  try {
    exit = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    sample();
    const remaining = () =>
      [...knownOwned].filter((pid) => pid !== child.pid && fs.existsSync(`/proc/${pid}`));
    if (remaining().length) {
      signal("SIGTERM");
      await pause(1000);
    }
    const eventsAfter = events();
    const receipt = {
      expectedHead,
      status: "validation-pending",
      command: [bin, ...args].join(" "),
      toolchain: tools,
      suppliedGOMEMLIMIT: env.GOMEMLIMIT ?? null,
      suppliedNodeHeapMiB: env.OPENCLAW_TSDOWN_MAX_OLD_SPACE_MB ?? null,
      elapsedSeconds: (Date.now() - started) / 1000,
      exit,
      timedOut,
      memoryBefore,
      memoryAfter: cgroupMemory(),
      eventsBefore,
      eventsAfter,
      oomDelta: eventsAfter.oom - eventsBefore.oom,
      oomKillDelta: eventsAfter.oom_kill - eventsBefore.oom_kill,
      peakProcessRSSKiB,
      peakCompilerRSSKiB,
      maxConcurrentCompilers,
      compilers: [...compilers.values()],
      lingeringWorkerPids: remaining(),
    };
    write(`${name}-receipt.json`, receipt);
    assert.equal(exit.code, 0, `${name} failed; see retained log and receipt`);
    assert.equal(timedOut, false);
    assert.equal(receipt.oomDelta, 0);
    assert.equal(receipt.oomKillDelta, 0);
    assert.equal(receipt.memoryAfter["memory.swap.current"], "0");
    assert.equal(
      receipt.lingeringWorkerPids.length,
      0,
      "A sampled worker outlived its command owner",
    );
    const asyncCompilers = [...compilers.values()].filter((compiler) => compiler.async);
    if (expectCompilers)
      assert.ok(
        asyncCompilers.length > 0,
        "No actual tsgo --api --async declaration child observed",
      );
    for (const compiler of compilers.values()) {
      if (expectedOverride)
        assert.equal(
          compiler.environment.GOMEMLIMIT,
          expectedOverride,
          "Caller override was not inherited",
        );
      else if (expectCompilers && compiler.async) {
        const value = /^([1-9]\d*)MiB$/u.exec(compiler.environment.GOMEMLIMIT ?? "");
        assert.ok(value, "Actual compiler did not inherit an automatic Go limit");
        assert.ok(Number(value[1]) <= Math.floor((Number(memoryBefore["memory.max"]) * 0.6) / MiB));
      }
    }
    if (sharedBudget) {
      assert.ok(
        maxConcurrentCompilers >= 2,
        "No real two-compiler overlap; this is not a parallel proof",
      );
      let pairs = 0;
      const records = asyncCompilers;
      for (let i = 0; i < records.length; i++)
        for (let j = i + 1; j < records.length; j++) {
          const left = records[i],
            right = records[j];
          if (
            Math.max(left.firstSeenMs, right.firstSeenMs) >
            Math.min(left.lastSeenMs, right.lastSeenMs)
          )
            continue;
          const l = /^([1-9]\d*)MiB$/u.exec(left.environment.GOMEMLIMIT ?? ""),
            r = /^([1-9]\d*)MiB$/u.exec(right.environment.GOMEMLIMIT ?? "");
          assert.ok(l && r);
          assert.equal(l[1], r[1], "Sibling compilers did not share one budget snapshot");
          assert.ok(
            (Number(l[1]) + Number(r[1])) * MiB <= Number(memoryBefore["memory.max"]) * 0.6,
          );
          pairs++;
        }
      assert.ok(pairs > 0, "No overlapping compiler pair established shared limits");
    }
    receipt.status = "passed";
    write(`${name}-receipt.json`, receipt);
    return receipt;
  } finally {
    clearTimeout(timeout);
    clearInterval(timer);
    fs.closeSync(log);
    if (!exit || exit.code !== 0) signal("SIGKILL");
  }
}
async function runtimeSmoke(env) {
  await runMeasured("smoke-cli", process.execPath, ["openclaw.mjs", "--version"], env, {
    timeoutMs: 60_000,
  });
  await runMeasured(
    "smoke-built-status",
    process.execPath,
    ["--import", "./scripts/tsx.mjs", "scripts/test-built-status-message-runtime.mts"],
    env,
    { timeoutMs: 120_000 },
  );
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-proof-smoke-")),
    state = path.join(home, "state");
  fs.mkdirSync(state);
  const config = path.join(state, "openclaw.json");
  fs.writeFileSync(
    config,
    JSON.stringify({
      gateway: {
        mode: "local",
        bind: "loopback",
        port: 19441,
        auth: { mode: "none" },
        controlUi: { enabled: false },
      },
      plugins: { enabled: false },
      browser: { enabled: false },
      cron: { enabled: false },
      update: { checkOnStart: false, auto: { enabled: false } },
    }),
  );
  const isolated = {
    ...env,
    HOME: home,
    OPENCLAW_STATE_DIR: state,
    OPENCLAW_CONFIG_PATH: config,
    OPENCLAW_NO_RESPAWN: "1",
    OPENCLAW_DISABLE_BONJOUR: "1",
    OPENCLAW_EXEC_SHELL_SNAPSHOT: "0",
    OPENCLAW_SKIP_CHANNELS: "1",
    OPENCLAW_SKIP_CRON: "1",
    OPENCLAW_SKIP_GMAIL_WATCHER: "1",
    OPENCLAW_SKIP_CANVAS_HOST: "1",
  };
  const log = fs.openSync(path.join(output, "smoke-gateway.log"), "w");
  const child = spawn(process.execPath, ["openclaw.mjs", "gateway"], {
    env: isolated,
    stdio: ["ignore", log, log],
    detached: true,
  });
  const closed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  const started = Date.now(),
    checks = [];
  let success = false;
  try {
    while (Date.now() - started < 180_000) {
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error("Built Gateway exited before readiness");
      try {
        const response = await fetch("http://127.0.0.1:19441/readyz", {
          signal: AbortSignal.timeout(1500),
        });
        if (response.ok && (await response.json()).ok === true) break;
      } catch {}
      await pause(500);
    }
    for (const endpoint of ["readyz", "healthz"]) {
      const response = await fetch(`http://127.0.0.1:19441/${endpoint}`, {
          signal: AbortSignal.timeout(3000),
        }),
        body = await response.json();
      assert.ok(response.ok && body.ok === true, `Gateway ${endpoint} did not return ok`);
      checks.push({ endpoint, status: response.status, ok: body.ok });
    }
    success = true;
  } finally {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {}
    const result = await Promise.race([closed, pause(20_000).then(() => null)]);
    if (!result) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
      await closed;
    }
    fs.closeSync(log);
    write("smoke-gateway-receipt.json", {
      expectedHead,
      success,
      checks,
      elapsedSeconds: (Date.now() - started) / 1000,
      gracefulShutdown: result !== null,
      exit: result,
    });
    fs.rmSync(home, { recursive: true, force: true });
    assert.ok(result, "Gateway did not shut down gracefully");
    assert.ok(result.code === 0 || result.signal === "SIGTERM", "Gateway shutdown failed");
  }
}
async function containerCell(name) {
  verifyHead();
  fs.mkdirSync(output, { recursive: true });
  const expectedLimit = containmentBytesForCell(name),
    memory = cgroupMemory();
  write(`${name}-containment.json`, {
    expectedHead,
    memory,
    physicalMemory: memoryInfo(),
    cpus: os.availableParallelism(),
    procCgroup: read("/proc/self/cgroup"),
  });
  assert.equal(Number(memory["memory.max"]), expectedLimit);
  assert.equal(memory["memory.swap.max"], "0");
  assert.equal(memory["memory.swap.current"], "0");
  const env = baseEnvironment();
  if (name === "build-auto" || name === "build-override") {
    coldOutputs();
    if (name === "build-override") env.GOMEMLIMIT = "6GiB";
    await runMeasured(name, "pnpm", ["build"], env, {
      expectCompilers: true,
      expectedOverride: env.GOMEMLIMIT,
    });
    write(`${name}-manifest.json`, outputManifest());
  } else if (name === "focused-10") {
    clearCompilerCaches();
    await runMeasured(
      name,
      process.execPath,
      [
        "--import",
        "./scripts/tsx.mjs",
        "scripts/tsdown-build.mts",
        "--config",
        "tsdown.config.ts",
        "--filter",
        "openclaw-dts-base",
      ],
      env,
      { expectCompilers: true },
    );
  } else if (name === "parallel") {
    const requiredBytes = 13.5 * GiB,
      availableBytes = Math.min(
        expectedLimit - Number(memory["memory.current"]),
        memoryInfo().MemAvailable,
      );
    if (availableBytes < requiredBytes) {
      write("parallel-receipt.json", {
        expectedHead,
        status: "skipped",
        reason:
          "Actual available capacity below two 6144 MiB Node heaps plus 768 MiB headroom per child",
        availableBytes,
        requiredBytes,
        notProven: "Real two-worker budget sharing",
      });
      console.log("Parallel cell skipped: actual capacity below 13.5 GiB admission requirement");
      return;
    }
    env.OPENCLAW_TSDOWN_MAX_OLD_SPACE_MB = "6144";
    clearCompilerCaches();
    await runMeasured(
      name,
      process.execPath,
      ["--import", "./scripts/tsx.mjs", "scripts/write-plugin-sdk-entry-dts.ts"],
      env,
      { expectCompilers: true, sharedBudget: true },
    );
  } else if (name === "smoke") await runtimeSmoke(env);
  else if (name === "check" || name === "test") await runMeasured(name, "pnpm", [name], env);
  else throw new Error(`Unknown contained cell: ${name}`);
}
async function runContainer(name) {
  hostReceipt(name);
  const image = process.env.PROOF_IMAGE;
  assert.match(image ?? "", /^sha256:[0-9a-f]{64}$/u, "Provision and pin the proof image first");
  const bun = process.env.PROOF_BUN_PATH;
  assert.ok(
    bun && fs.statSync(bun).isFile(),
    "Provision the source-pinned standalone Bun executable first",
  );
  const size = String(containmentBytesForCell(name));
  const args = [
    "run",
    "--rm",
    "--init",
    `--memory=${size}`,
    `--memory-swap=${size}`,
    "--cpus=4",
    "--network=none",
    "--pids-limit=4096",
    "--mount",
    `type=bind,source=${process.cwd()},target=/work`,
    "--mount",
    `type=bind,source=${path.resolve("proof-harness")},target=/proof,readonly`,
    "--mount",
    `type=bind,source=${bun},target=/usr/local/bin/bun,readonly`,
    "--workdir",
    "/work",
    // The disposable root container mounts the runner-owned checkout. Trust
    // only that exact mount, without changing host or image Git configuration.
    "--env",
    "GIT_CONFIG_COUNT=1",
    "--env",
    "GIT_CONFIG_KEY_0=safe.directory",
    "--env",
    "GIT_CONFIG_VALUE_0=/work",
    "--env",
    `PROOF_HEAD=${expectedHead}`,
    "--env",
    `OPENCLAW_BUILD_TIMESTAMP=${process.env.OPENCLAW_BUILD_TIMESTAMP ?? "2026-10-05T00:00:00.000Z"}`,
    image,
    "node",
    "/proof/.github/scripts/pr-157783-native-memory-proof.mjs",
    "cell",
    name,
  ];
  const child = spawn("docker", args, { stdio: "inherit" });
  const exit = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  write(`${name}-docker-exit.json`, {
    expectedHead,
    image,
    memoryLimit: size,
    network: "none",
    swap: "disabled",
    exit,
  });
  assert.equal(exit.code, 0, `${name} disposable container failed`);
}
try {
  const [mode, cell] = process.argv.slice(2);
  if (mode === "host") hostReceipt();
  else if (mode === "run") await runContainer(cell);
  else if (mode === "cell") await containerCell(cell);
  else if (mode === "compare") compareManifests();
  else throw new Error("Expected host, run <cell>, cell <cell>, or compare");
} catch (error) {
  console.error(error);
  write(`${process.argv[2] ?? "unknown"}-${process.argv[3] ?? "failure"}-error.json`, {
    expectedHead,
    error: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
}
