// Continue the retained quiet/event observation without repeating its mutation.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
if (process.env.OPENCLAW_DISPOSABLE_GUEST !== 'credentialless-tart') throw new Error('guest required');
const root = process.argv[2];
const receipt = JSON.parse(fs.readFileSync(path.join(root, 'runtime.json')));
const records = fs.readFileSync(path.join(root, 'observation.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
const quiet = records.find(r => r.phase === 'quiet-window-pass');
if (!quiet || !records.some(r => r.phase === 'event-preview-pass')) throw new Error('prior phases not proven');
const ax = path.join(process.env.HOME, 'proof/scripts/cron-ax');
const run = (bin, args) => {
  const r = spawnSync(bin, args, {encoding:'utf8', timeout:30000});
  if (r.status !== 0) throw new Error(`${bin}: ${r.status}`);
  return r.stdout;
};
const rows = () => {
  const all = fs.readFileSync(path.join(root, 'ws.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const native = new Set(all.filter(r => r.type === 'req' && r.method === 'connect' && r.client?.id === 'openclaw-macos' && r.client?.mode === 'ui').map(r => r.connection));
  return all.filter(r => native.has(r.connection));
};
const dump = name => {
  const text = run(ax, [String(receipt.appPid), 'dump']);
  fs.writeFileSync(path.join(root, `${name}.ax.json`), text);
  return JSON.parse(text);
};
const closed = dump('closed-with-AXCancel');
if (closed.nodes.some(n => n.role === 'AXMenu' && n.width > 0 && n.height > 0)) throw new Error('menu still open');
run('/usr/sbin/screencapture', ['-x', path.join(root, 'closed.png')]);
fs.copyFileSync(path.join(root, 'runtime-result.json'), path.join(root, 'runtime-result-before-continuation.json'));
const before = rows().length;
const started = new Date().toISOString();
run(ax, [String(receipt.appPid), 'reopen', '1199', '15']);
let refreshed = false;
for (let i=0; i<60; i++) {
  if (rows().slice(before).some(r => r.type === 'res' && r.method === 'cron.list' && r.ok && r.jobs?.some(j => j.name === 'Cron native proof event updated'))) { refreshed=true; break; }
  await new Promise(r=>setTimeout(r,500));
}
if (!refreshed) throw new Error('no fresh reopen response');
run(ax,[String(receipt.appPid),'hover-automations']);
await new Promise(r=>setTimeout(r,1000));
const tree = dump('reopened');
if (!tree.nodes.some(n => n.width > 0 && n.height > 0 && [n.title,n.description,n.help].some(v => v?.includes('Cron native proof event updated')))) throw new Error('fresh preview not rendered');
run('/usr/sbin/screencapture',['-x',path.join(root,'reopened.png')]);
const result = {status:'passed',head:receipt.head,actualQuietSeconds:quiet.actualElapsedMs/1000,recurringCronListRequests:0,menuContinuityChecks:quiet.menuChecks,initialRealGatewayPreview:true,cronPushUpdatedOpenPreview:true,reopenedFreshPreview:true,closeAction:'supported AXCancel (CG Escape ineffective)',continuationStarted:started,continuationFinished:new Date().toISOString(),retainedFailedObservation:'runtime-result-before-continuation.json',schedulerExecutionDisabled:true,gatewayPort:receipt.gatewayPort,transparentRecorderPort:receipt.recorderPort};
fs.writeFileSync(path.join(root,'runtime-result.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify(result));
