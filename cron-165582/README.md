# Cron PR 165582: exact-head local disposable macOS VM proof

Source and packaged app: `9fbe51b94c95c17b17d4e0c490eab9b7502fa5f6`.

Executed 2026-10-05 in a fresh Tart VM from official `ghcr.io/cirruslabs/macos-golden-gate-xcode:27`, OCI digest `sha256:324ea5656dee8ab9b0a0df70fda2cfed8912051ad0eca3b1b883bf6ddac88fab`. macOS 27.0 (26A428), Xcode 27.0 (27A266a), Swift 6.4, Node 24.21.0, pnpm 12.5.1. No operator state or provider credentials copied. Local VM execution, **not hosted CI**.

## Native execution

Canonical launcher ran three disjoint partitions: default **2,500 tests / 281 suites**, rendered **2 / 1**, named **13 / 2**. All **2,515 native tests passed**, not merely compiled. `native-test-summary.json` retains execution footers and original log hashes. Full app/test build passed in 168.22 seconds after preparing the missing generated Mermaid resource through its repository owner script. The first missing-resource setup failure remains retained locally.

The VM provides OS/credential isolation. CI environment markers are invocation checks only; the canonical launcher additionally owns fresh HOME/state/Keychain resources.

## Actual app and actual Gateway

A genuine ad-hoc DEBUG package was built via `scripts/package-mac-app.sh`; optional MLX TTS omitted through its explicit opt-in. `bundle-head.txt`, `bundle-sha256.txt`, `codesign.txt` bind the packaged binary. No menu fixtures, injected JavaScript or patched app.

The transparent WebSocket observer forwards frames unchanged between the app and its own guest-loopback Gateway. `ws.jsonl` retains only methods/request identities, event names, client identity and job id/name/enabled summaries, not authentication, tickets, signatures or payloads.

1. Real native `cron.list` loads the visible future-only synthetic job: `initial.png`.
2. Menu stays open **120.2576485 actual monotonic seconds** with **23 AX continuity checks**, **zero additional cron.list requests** and zero connection interruptions: `quiet-120-seconds.png`, `observation.jsonl`. Health/tick traffic continues.
3. Supported real CLI `cron add` emits a real Cron publication; native refresh renders the new job while the menu remains open: `event-updated.png`.
4. Supported normal AXCancel closes the menu (`closed.png`). Normal status-item input opens it again; a fresh native `cron.list` and current visible preview are verified (`reopened.png`, `runtime-result.json`).

The original observer's CG Escape did not close the menu. Its failed result is retained in `runtime-result-before-continuation.json`; quiet/event phases were not repeated or relabelled. `cron-reopen-continuation.mjs` independently verifies closure and fresh reopen after AXCancel. No duplicate mutation.

The fresh Gateway creates internal maintenance jobs. Scheduled execution was disabled only in this disposable guest (`cron.enabled=false`); real Cron CRUD, publication and client requests remained enabled. This does not disable the native polling path under test. Synthetic jobs are future-only; no provider work invoked.

All decoded captures were visually inspected. Zero-sized hidden AX nodes do not count as visible menus. Earlier synthetic owner/virtual-clock before/after proof in the PR remains separate; this does not claim a live pre-fix app run.
