# Dashboard PR 165587: exact-head local disposable macOS VM proof

Source and packaged app commit: `b23aa78e2df00658b07bbeb7b4fe76fe573c99bc` (the current head of the PR branch, including the attachment Save regression repair).

Executed 2026-10-05 in a fresh credentialless Tart VM from official `ghcr.io/cirruslabs/macos-golden-gate-xcode:27` (OCI digest sha256:324ea5656dee8ab9b0a0df70fda2cfed8912051ad0eca3b1b883bf6ddac88fab). macOS 27.0 (26A428), Xcode 27.0 (27A266a), Swift 6.4, Node 24.21.0, pnpm 12.5.1. No operator state, profile, or provider credentials were copied. Local VM execution, **not hosted CI**.

## Native test execution

Canonical `scripts/test-macos-native.mts` ran three disjoint partitions plus the focused Dashboard filter:
- default **2,504 tests / 282 suites** passed in 226.829 s
- rendered **2 / 1** passed in 5.299 s
- named **13 / 2** passed in 12.580 s
- focused Dashboard/browser filter **29 tests / 4 suites** passed in 2.774 s

Total **2,548 native tests executed and passed**. The four logs are included. The new Save test really drives WebKit download adoption, presses the real Save control and compares the published bytes.

## Actual app + actual remote Gateway

A genuine ad-hoc DEBUG app with `OpenClawGitCommit=b23aa78e2df0` was packaged through `scripts/package-mac-app.sh` (optional MLX TTS omitted by its explicit opt-in). `bundle-head.txt`, `bundle-sha256.txt` and `codesign.txt` bind the executable.

The app ran with `--attach-only --dashboard` against its own guest-loopback Gateway on 28789 (`runtime.json`). The Gateway seeded a synthetic local DOCX session, and an independent verifier confirmed the real attachment endpoint returns HTTP 200 with `Content-Disposition: attachment` and the exact source bytes (`ticket-receipt.json`, 1103 bytes, sha256 f5433176…).

1. The Dashboard renders the attachment card (`attachment-card.png`, "native-dashboard-proof.docx · DOCX · 11 KB").
2. Pressing the real `Download` link opens the genuine macOS Save sheet (`save-sheet.png`, AX dump shows "Save As: native-dashboard-proof.docx", Documents, Cancel/Save).
3. The filename was set to `native-dashboard-saved.docx` and the real `Save` button pressed. The published file matched the source bytes exactly: **1103 bytes, sha256 f5433176395ddd4ce5f31d741475fe3ee8cc31cb50b4462913cec9097b56ff0d** (`saved-receipt.json`, `documents-after-save.txt`).
4. Pressing `Download` again and then the real `Cancel` button produced **no file** (`cancel-receipt.json`; the Documents listing is byte-identical before and after cancel, `documents-before-cancel.txt` vs `documents-after-cancel.txt`).
5. After Cancel the Dashboard still shows the same document and an enabled Download control (`after-cancel.png`, `after-cancel.ax.txt`).

Synthetic attachment bytes were removed from the guest afterwards; the disposable VM is discarded by the owner.
