import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';

if (process.env.OPENCLAW_DISPOSABLE_GUEST !== 'credentialless-tart') throw new Error('disposable guest attestation required');
const [proof, statusX, statusY] = process.argv.slice(2);
if (!proof) throw new Error('evidence directory required');
const receipt = JSON.parse(fs.readFileSync(path.join(proof, 'runtime.json'), 'utf8'));
if (receipt.head !== '9fbe51b94c95c17b17d4e0c490eab9b7502fa5f6') throw new Error('wrong head');
// No blind rerun after an uncertain mutation. Parent reconciles fixtures and
// retains the failed receipt before deliberately starting another observation.
fs.writeFileSync(path.join(proof, 'observation-owner.json'), JSON.stringify({ pid: process.pid, head: receipt.head, started: new Date().toISOString() }), { flag: 'wx' });
const scripts = path.dirname(fileURLToPath(import.meta.url));
const ax = path.join(scripts, 'cron-ax');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const marker = x => fs.appendFileSync(path.join(proof, 'observation.jsonl'), JSON.stringify({ wall: new Date().toISOString(), monoMs: performance.now(), ...x }) + '\n');
function exec(bin, args, env = process.env) {
  const result = spawnSync(bin, args, { encoding: 'utf8', env, timeout: 90000 });
  if (result.status !== 0) throw new Error(`${path.basename(bin)} failed (${result.status}): ${(result.stderr || result.error?.message || '').slice(-1200)}`);
  return result.stdout;
}
function frames() {
  // Recorder writes complete lines. Ignore only a final in-flight append.
  const data = fs.readFileSync(path.join(proof, 'ws.jsonl'), 'utf8');
  return data.slice(0, data.lastIndexOf('\n')).split('\n').filter(Boolean).map(line => JSON.parse(line));
}
function currentRows() {
  const all = frames();
  const native = new Set(all.filter(row => row.type === 'req' && row.method === 'connect' && row.client?.id === 'openclaw-macos' && row.client?.mode === 'ui').map(row => row.connection));
  return all.filter(row => native.has(row.connection));
}
function axDump(name) {
  const output = exec(ax, [String(receipt.appPid), 'dump']);
  fs.writeFileSync(path.join(proof, `${name}.ax.json`), output);
  const tree = JSON.parse(output);
  // An NSMenu visible in this process is required; AXMenuBar is not enough.
  if (!tree.nodes.some(node => node.role === 'AXMenu' && node.width > 0 && node.height > 0)) throw new Error('native menu is not open');
  return tree;
}
function hasName(tree, name) {
  return tree.nodes.some(node => node.width > 0 && node.height > 0 && [node.title, node.description, node.help].some(value => typeof value === 'string' && value.includes(name)));
}
async function waitFor(test, seconds, label) {
  const start = performance.now();
  while (performance.now() - start < seconds * 1000) { if (test()) return; await sleep(500); }
  throw new Error(`Timed out waiting for ${label}`);
}
function capture(name) {
  exec('/usr/sbin/screencapture', ['-x', path.join(proof, `${name}.png`)]);
  if (fs.statSync(path.join(proof, `${name}.png`)).size < 100) throw new Error('empty screenshot');
}
function cli(args) {
  return exec(process.execPath, [path.join(receipt.repo, 'openclaw.mjs'), ...args], {
    ...process.env, OPENCLAW_STATE_DIR: path.join(proof, 'gateway-state'), OPENCLAW_CONFIG_PATH: path.join(proof, 'gateway-state/openclaw.json'),
  });
}

try {
  marker({ phase: 'begin', head: receipt.head });
  await waitFor(() => currentRows().some(row => row.type === 'res' && row.method === 'cron.list' && row.ok && row.jobs?.some(job => job.name === 'Cron native proof initial')), 90, 'real native initial Cron response');
  exec(ax, [String(receipt.appPid), 'hover-automations']);
  await sleep(1500);
  let initial = axDump('initial');
  if (!hasName(initial, 'Cron native proof initial')) throw new Error('real initial job is not visible in the Automations submenu');
  capture('initial');
  // Wait until Cron loading is quiescent, then measure 120 actual seconds.
  let lastCount = currentRows().filter(row => row.method === 'cron.list' && row.type === 'req').length;
  let quietSince = performance.now();
  const settleStart = quietSince;
  while (performance.now() - quietSince < 10000) {
    if (performance.now() - settleStart > 90000) throw new Error('Cron requests did not settle');
    await sleep(1000);
    const count = currentRows().filter(row => row.method === 'cron.list' && row.type === 'req').length;
    if (count !== lastCount) { quietSince = performance.now(); lastCount = count; }
    axDump('settling');
  }
  const before = currentRows().length;
  const start = performance.now();
  marker({ phase: 'quiet-window-start', rowOffset: before, initialCronRequests: lastCount });
  let checks = 0;
  while (performance.now() - start < 120000) {
    await sleep(Math.min(5000, 120000 - (performance.now() - start)));
    const tree = axDump(`quiet-${String(++checks).padStart(2, '0')}`);
    if (!hasName(tree, 'Cron native proof initial')) throw new Error('unchanged menu preview disappeared');
    marker({ phase: 'menu-open-check', check: checks, elapsedMs: performance.now() - start });
  }
  const end = performance.now();
  const windowRows = currentRows().slice(before);
  const requests = windowRows.filter(row => row.type === 'req' && row.method === 'cron.list');
  const interruptions = windowRows.filter(row => ['connection-close', 'socket-error'].includes(row.kind) || row.method === 'connect');
  if (end - start < 120000 || requests.length || interruptions.length) throw new Error(`Quiet window failed: ${end - start}ms, ${requests.length} cron.list, ${interruptions.length} connection interruptions`);
  capture('quiet-120-seconds');
  marker({ phase: 'quiet-window-pass', actualElapsedMs: end - start, cronListRequests: 0, connectionInterruptions: 0, menuChecks: checks });
  const eventOffset = currentRows().length;
  const created = cli(['cron', 'add', '--name', 'Cron native proof event updated', '--at', '25h', '--session', 'main', '--system-event', 'Disposable future-only event proof. No provider.', '--json']);
  fs.writeFileSync(path.join(proof, 'event-job.json'), created);
  await waitFor(() => {
    const rows = currentRows().slice(eventOffset);
    return rows.some(row => row.type === 'event' && row.event === 'cron') && rows.some(row => row.type === 'res' && row.method === 'cron.list' && row.ok && row.jobs?.some(job => job.name === 'Cron native proof event updated'));
  }, 30, 'Cron push and native refresh');
  await sleep(1500);
  exec(ax, [String(receipt.appPid), 'hover-automations']);
  await sleep(1000);
  const updated = axDump('event-updated');
  if (!hasName(updated, 'Cron native proof event updated')) throw new Error('push update did not render in the still-open native menu');
  capture('event-updated');
  marker({ phase: 'event-preview-pass' });
  exec(ax, [String(receipt.appPid), 'escape']);
  await sleep(500);
  // Escape may close only the submenu, so close the root separately if needed.
  exec(ax, [String(receipt.appPid), 'escape']);
  await sleep(750);
  const closed = JSON.parse(exec(ax, [String(receipt.appPid), 'dump']));
  fs.writeFileSync(path.join(proof, 'closed.ax.json'), JSON.stringify(closed));
  if (closed.nodes.some(node => node.role === 'AXMenu' && node.width > 0 && node.height > 0)) throw new Error('menu did not close before reopen');
  const reopenOffset = currentRows().length;
  const reopenArgs = [String(receipt.appPid), 'reopen'];
  if (statusX !== undefined && statusY !== undefined) reopenArgs.push(statusX, statusY);
  exec(ax, reopenArgs);
  await waitFor(() => currentRows().slice(reopenOffset).some(row => row.type === 'res' && row.method === 'cron.list' && row.ok && row.jobs?.some(job => job.name === 'Cron native proof event updated')), 30, 'fresh native reopen load');
  exec(ax, [String(receipt.appPid), 'hover-automations']);
  await sleep(1000);
  if (!hasName(axDump('reopened'), 'Cron native proof event updated')) throw new Error('reopened current preview absent');
  capture('reopened');
  const result = { status: 'passed', head: receipt.head, actualQuietSeconds: (end - start) / 1000, recurringCronListRequests: 0, menuContinuityChecks: checks, initialRealGatewayPreview: true, cronPushUpdatedOpenPreview: true, reopenedFreshPreview: true, gatewayPort: receipt.gatewayPort, transparentRecorderPort: receipt.recorderPort };
  fs.writeFileSync(path.join(proof, 'runtime-result.json'), JSON.stringify(result, null, 2));
  marker({ phase: 'runtime-pass', ...result });
  console.log(JSON.stringify(result));
} catch (error) {
  const result = { status: 'failed', head: receipt.head, reason: error.message };
  fs.writeFileSync(path.join(proof, 'runtime-result.json'), JSON.stringify(result, null, 2));
  marker({ phase: 'runtime-failed', ...result });
  console.error(error.message); process.exitCode = 1;
}
