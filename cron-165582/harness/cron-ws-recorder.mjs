// Disposable guest only. Transparent forwarding, never a fake Gateway.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
const [repo, output, listenArg = '28791', upstreamArg = '28790'] = process.argv.slice(2);
if (!repo || !output) throw new Error('repo and output are required');
const require = createRequire(`${repo}/package.json`);
const { WebSocket, WebSocketServer } = require('ws');
const listen = Number(listenArg), upstream = Number(upstreamArg);
if (![listen, upstream].every(p => Number.isInteger(p) && p > 1024 && p < 65536) || listen === upstream) throw new Error('invalid ports');
let nextConnection = 0;
const emit = x => fs.appendFileSync(output, JSON.stringify({ wall: new Date().toISOString(), monoMs: performance.now(), ...x }) + '\n');
const server = new WebSocketServer({ host: '127.0.0.1', port: listen });
server.on('listening', () => emit({ kind: 'recorder-listening', listen, upstream }));
server.on('connection', (downstream, request) => {
  const connection = ++nextConnection;
  const pending = [], methods = new Map();
  const headers = {};
  // Preserve browser-origin diagnostics if present; never add identity/auth headers.
  if (request.headers.origin) headers.Origin = request.headers.origin;
  const real = new WebSocket(`ws://127.0.0.1:${upstream}${request.url || '/'}`, { headers });
  emit({ kind: 'connection-open', connection });
  function observe(direction, buffer) {
    let frame;
    try { frame = JSON.parse(buffer.toString()); } catch { emit({ kind: 'non-json', direction, connection }); return; }
    const row = { kind: 'frame', direction, connection, type: frame.type, id: frame.id };
    if (frame.type === 'req') {
      row.method = frame.method;
      methods.set(frame.id, frame.method);
      if (frame.method === 'connect') {
        row.client = { id: frame.params?.client?.id, mode: frame.params?.client?.mode, version: frame.params?.client?.version, platform: frame.params?.client?.platform };
        row.role = frame.params?.role;
      }
    }
    if (frame.type === 'res') {
      row.method = methods.get(frame.id); row.ok = frame.ok;
      if (row.method === 'cron.list' && frame.ok === true) {
        row.total = frame.payload?.total;
        row.jobs = frame.payload?.jobs?.map(job => ({ id: job.id, name: job.name, enabled: job.enabled }));
      }
      if (!frame.ok) row.errorCode = frame.error?.code;
      methods.delete(frame.id);
    }
    if (frame.type === 'event') row.event = frame.event;
    emit(row);
  }
  downstream.on('message', (buffer, binary) => {
    observe('native-to-gateway', buffer);
    if (real.readyState === WebSocket.OPEN) real.send(buffer, { binary });
    else pending.push([buffer, binary]);
  });
  real.on('open', () => { for (const [buffer, binary] of pending.splice(0)) real.send(buffer, { binary }); });
  real.on('message', (buffer, binary) => {
    observe('gateway-to-native', buffer);
    if (downstream.readyState === WebSocket.OPEN) downstream.send(buffer, { binary });
  });
  downstream.on('close', (code) => { emit({ kind: 'connection-close', connection, side: 'native', code }); real.close(); });
  real.on('close', (code) => { emit({ kind: 'connection-close', connection, side: 'gateway', code }); downstream.close(); });
  for (const [side, socket] of [['native', downstream], ['gateway', real]]) socket.on('error', () => emit({ kind: 'socket-error', side, connection }));
});
process.on('SIGTERM', () => { for (const socket of server.clients) socket.terminate(); server.close(() => process.exit(0)); });
