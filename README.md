# OpenClaw #157961 — isolated Gateway Goal outcome proof

This is evidence for [PR #158021](https://github.com/openclaw/openclaw/pull/158021) at source commit `aa7e2fd720b1e400e7809d907dfe529fe1b221a8` (2026-09-25). It is not a production-Gateway trace or a diagnosis of the separate already-settled-operation report.

## Boundary exercised

`goal-157961-real-proof.e2e.test.ts` launches an isolated real OpenClaw Gateway and a Chromium Control UI with a synthetic owner, session, active Goal, and unused fixture model provider. It clicks **Pause goal** in the rendered UI. The Gateway commits that operation and responds `ok: true, replayed: false`; the browser WebSocket route withholds only this ACK. After the browser request times out, the rendered **Check outcome** control is clicked. The second request has identical mutation parameters and operation ID. The Gateway responds `ok: true, replayed: true`, proving no second mutation. The browser route substitutes a synthetic `UNAVAILABLE` response *only on the way back to the browser*. The patched Control UI then displays “Goal update not confirmed. Check its outcome before making another change. Synthetic receipt transport interrupted” while retaining the recovery control.

The exact sanitized response observations and assertions are in [after.json](after.json); the inspected rendered result is [after.png](after.png). This proves the UI behavior on a real Gateway replay with a controlled lost browser receipt. It does **not** prove a real network outage, an unmodified browser transport, or the root cause of the issue's already-settled operation observation. The first clean source counterfactual could not be captured reliably because the Gateway's session-change refresh removed the recovery banner before the follow-up click; no failed setup screenshot is represented as a before image.

## Reproduce

From the PR checkout (with dependencies and Playwright Chromium installed), copy this test to `ui/src/e2e/goal-157961-real-proof.e2e.test.ts`, then run:

```sh
GOAL_PROOF_DIR=/tmp/goal-157961-proof pnpm test:ui:e2e ui/src/e2e/goal-157961-real-proof.e2e.test.ts
```

The original run passed **1/1 tests** (191.23 s total command duration; case 8.179 s), after a successful local `pnpm build` and focused Goal suites. The test is a temporary proof harness and was removed from the PR worktree after capture; its output is the files in this branch. The local production Gateway was not contacted or modified.
