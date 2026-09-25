import { spawn } from "node:child_process";
import fs from "node:fs";

const expectedHead = "2c9ca5be89531e084ff512ab1b8c7d8732d0529b";
const expectedLimit = 10 * 1024 ** 3;
const output = ".artifacts/pr-157783-native-memory/receipt.json";
const read = (file) => fs.readFileSync(file, "utf8").trim();
const limit = Number(read("/sys/fs/cgroup/memory.max"));
if (limit !== expectedLimit) {
  throw new Error(`Expected 10 GiB memory.max, received ${limit}`);
}
const eventCounts = () =>
  Object.fromEntries(
    read("/sys/fs/cgroup/memory.events")
      .split("\n")
      .map((line) => line.split(" ").map((value) => value.trim())),
  );
const before = eventCounts();
const startedAt = Date.now();
let peakCgroupBytes = 0;
let peakCompilerKiB = 0;
let compilerPid = null;
let compilerGOMEMLIMIT = null;
let samples = 0;

function sample() {
  const current = Number(read("/sys/fs/cgroup/memory.current"));
  peakCgroupBytes = Math.max(peakCgroupBytes, current);
  samples++;
  for (const entry of fs.readdirSync("/proc")) {
    if (!/^\d+$/u.test(entry)) continue;
    const base = `/proc/${entry}`;
    try {
      const args = fs.readFileSync(`${base}/cmdline`, "utf8").split("\0");
      if (!args.includes("--locale") || !args.includes("--pretty") || !args.includes("-p")) {
        continue;
      }
      const status = fs.readFileSync(`${base}/status`, "utf8");
      const rss = Number(status.match(/^VmRSS:\s+(\d+) kB$/mu)?.[1] ?? 0);
      peakCompilerKiB = Math.max(peakCompilerKiB, rss);
      compilerPid = Number(entry);
      const entryEnv = fs
        .readFileSync(`${base}/environ`, "utf8")
        .split("\0")
        .find((variable) => variable.startsWith("GOMEMLIMIT="));
      compilerGOMEMLIMIT = entryEnv?.slice("GOMEMLIMIT=".length) ?? null;
    } catch {
      // The compiler can exit between enumeration and reading its procfs files.
    }
  }
}

const command = [
  "--import",
  "./scripts/tsx.mjs",
  "scripts/tsdown-build.mts",
  "--config",
  "tsdown.config.ts",
  "--filter",
  "openclaw-dts-base",
];
const env = { ...process.env, OPENCLAW_BUILD_CACHE: "0" };
delete env.GOMEMLIMIT;
console.log(`Candidate source: ${expectedHead}`);
console.log(`Cgroup memory.max: ${limit} bytes (10 GiB)`);
console.log(`Cold command: OPENCLAW_BUILD_CACHE=0 node ${command.join(" ")}`);
const child = spawn(process.execPath, command, { env, stdio: "inherit" });
sample();
const timer = setInterval(sample, 1000);
const exitCode = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) => resolve(signal ? `signal:${signal}` : code));
});
clearInterval(timer);
sample();
const after = eventCounts();
const receipt = {
  expectedHead,
  command: `OPENCLAW_BUILD_CACHE=0 node ${command.join(" ")}`,
  cgroupMemoryMaxBytes: limit,
  compilerPid,
  compilerGOMEMLIMIT,
  peakCompilerRSSKiB: peakCompilerKiB,
  peakCgroupMemoryBytes: peakCgroupBytes,
  samples,
  elapsedSeconds: Math.round((Date.now() - startedAt) / 100) / 10,
  exitCode,
  oomEventsDelta: Number(after.oom ?? 0) - Number(before.oom ?? 0),
  oomKillEventsDelta: Number(after.oom_kill ?? 0) - Number(before.oom_kill ?? 0),
};
fs.mkdirSync(".artifacts/pr-157783-native-memory", { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`);
console.log(`Proof receipt: ${JSON.stringify(receipt)}`);
if (
  exitCode !== 0 ||
  !compilerPid ||
  compilerGOMEMLIMIT !== "6144MiB" ||
  receipt.oomEventsDelta !== 0 ||
  receipt.oomKillEventsDelta !== 0
) {
  process.exitCode = 1;
}
