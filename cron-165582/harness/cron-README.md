# Cron actual-app proof for PR 165582

These files are task-owned VM helpers, not repository source changes. They have
not run native tests or the app on the operator desktop. Shell and Node syntax
checks pass, and `cron-ax.swift` passes Swift typechecking. Runtime remains
unverified until the parent runs them inside the credentialless guest.

## Source-bound behavior

The exact source is `9fbe51b94c95c17b17d4e0c490eab9b7502fa5f6`.
`apps/macos/Sources/OpenClaw/StatusMenuController.swift` already provides
`--debug-open-menu`, which uses the real status item and normal NSMenu callbacks.
No changes to production source are needed. Never pass `--debug-menu-fixtures`.
That separate flag seeds mock jobs and cannot establish the requested proof.

Normal `StatusMenuSummaries.refresh` starts the real `CronJobsStore`.
`GatewayConnection` identifies its operator client as `openclaw-macos`, mode
`ui`. Native config overrides use existing `OPENCLAW_CONFIG_PATH` and
`OPENCLAW_STATE_DIR`; remote connection is direct with `gateway.mode=remote`
and `gateway.remote.transport=direct`. This prevents local app-owned Gateway
lifecycle from taking over the explicitly isolated Gateway.

The real Gateway is built from the same checkout, running `openclaw.mjs gateway
run` on guest loopback28790 with its own state/config. Its two synthetic future
jobs use main-session systemEvent payloads, scheduled24h and25h ahead. They do
not invoke a model or external delivery during the observation.

`cron-ws-recorder.mjs` forwards native WebSocket frames unchanged through guest
loopback28791 to that Gateway. It neither replies to requests nor creates
events. It logs frame type, method, event, requestID, connectionID, safe client
metadata, success/errorcode and the isolated fixture names returned by
`cron.list`. It never logs device signatures, authentication, public/private
keys, request parameters or provider data. The recorder is observation only;
all behavior being proved comes from the packaged app and real Gateway.

## Guest commands

The guest needs supported Node, the exact repo pnpm version and Xcode27 with
its first-launch setup completed. Check these against `toolchain.txt`.
Use a public credentialless checkout, for example a fetch of the exact fork
branch into a new guest path. Verify SHA before building; do not import GitHub
credentials, host config, Keychain or operator Gateway state.

```sh
export OPENCLAW_DISPOSABLE_GUEST=credentialless-tart
bash /path/to/scripts/cron-guest-setup.sh /path/to/exact-checkout /path/to/evidence
bash /path/to/scripts/cron-guest-start.sh /path/to/exact-checkout /path/to/evidence
node /path/to/scripts/cron-observe.mjs /path/to/evidence
```

Setup runs the upstream native launcher in the same three disjoint partitions
used by current CI. The CI marker variables are invocation checks only. The
actual boundary is the freshly provisioned credentialless disposable VM.
Its output retains build, suite, packaging, code-signature and exact-bundle SHA
receipts. It then compiles the task-owned AX observer.

Before observation, grant the compiled `cron-ax` helper Accessibility access
inside the VM if needed. Grant guest Screen Recording access to the calling
terminal/process if `screencapture` requires it. These permissions apply only
to the disposable guest. Do not modify operator TCC databases or bypass TCC.
Helpers fail rather than inventing missing AX/screenshot evidence. Startup
`--debug-open-menu` does not require Accessibility. A GUI-active guest account
is needed; a headless SSH session without WindowServer is insufficient.

The observer requires an actual successful native `cron.list` response and
visible initial fixture in the Automations submenu. It waits10 actual seconds
for Cron loading to settle, then verifies zero `cron.list` for120 actual
monotonic seconds. AX snapshots every5 seconds must show the menu and original
fixture still open. Any reconnect or socket error fails that interval.
The interval itself sends no network commands or GUI input. Subsequent
real `cron.add` triggers a real Gateway Cron event, and the observer requires
a native reload plus rendered new fixture in the same open menu. It closes
and reopens with real input and requires a fresh native load/current preview.

If reopen cannot identify the status item through AX, inspect the guest-only
screenshot and pass its actual screen coordinates:

```sh
node /path/to/scripts/cron-observe.mjs /path/to/evidence ACTUAL_STATUS_X ACTUAL_STATUS_Y
```

Do this on the first observation attempt. `observation-owner.json` deliberately
blocks blind reruns after a possible fixture mutation. For a failed attempt,
inspect stored trace/result and fixtureIDs before deciding on a fresh attempt.
Do not delete failure evidence or duplicate a possibly completed mutation.
Menu labels assume an English guest UI; for other languages inspect AX labels
before adapting this task-owned helper.

## Acceptance and limitations

Only `runtime-result.json` with status `passed`, all three native suite
partition logs with genuine success and exact-head bundled-app receipts
constitute the requested completed proof. Screenshots must be viewed by the
parent to check rendered content. Readable AX or network data alone does not
replace screenshot inspection. Preserve `ws.jsonl`, `observation.jsonl`, AX
snapshots and initial/event/reopened images in the evidence bundle.

120 seconds uses actual wall time measured by `performance.now`, not virtual
time or timers advanced by tests. Periodic AX snapshots establish sampled
menu continuity; they cannot prove every visual instant between samples.
Capture video through the VM tool as well if continuous visual evidence is
required. The forwarding recorder adds a loopback hop, but does not change
payloads, synthesize responses or intercept the app's owner implementation.
The proof is for this head, guest toolchain and tested conditions only.

If app connection requires pairing, inspect its real Gateway pending-device
state and approve only the guest's own `openclaw-macos` identity. Do not disable
device validation or copy operator device credentials. A fresh guest-only token is stored in mode0600 configs, never printed or placed on command arguments. The Gateway remains loopback-only; it is not a recommendation
for a production Gateway. The entire VM is discarded after parent evidence
export. Parent owns app/Gateway shutdown, VM deletion and PR publication.
