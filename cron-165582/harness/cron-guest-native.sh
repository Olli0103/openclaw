#!/bin/bash
set -euo pipefail
[[ "${OPENCLAW_DISPOSABLE_GUEST:-}" == credentialless-tart && -f /tmp/openclaw-native-disposable-20261005 ]] || exit 2
repo="${1:?guest checkout}"; proof="${2:?evidence directory}"
script_dir="$(cd "$(dirname "$0")" && pwd)"
expected=9fbe51b94c95c17b17d4e0c490eab9b7502fa5f6
[[ "$(git -C "$repo" rev-parse HEAD)" == "$expected" ]] || exit 2
[[ -z "$(git -C "$repo" status --porcelain --untracked-files=no)" ]] || exit 2
cd "$repo"
node scripts/prepare-apple-mermaid.mjs > "$proof/mermaid-prepare.log" 2>&1
swift build --package-path apps/macos --build-system native --build-tests --enable-code-coverage --disable-index-store -Xswiftc -gline-tables-only > "$proof/native-build-tests.log" 2>&1
export CI=true GITHUB_ACTIONS=true RUNNER_OS=macOS RUNNER_TEMP="$proof/runner-temp"
native_args=(--package-path apps/macos --build-system native --enable-code-coverage --disable-index-store -Xswiftc -gline-tables-only --skip-build --experimental-maximum-parallelization-width 8)
node scripts/test-macos-native.mts default "${native_args[@]}" --skip 'AppStateIsolationTests|ProfileChatPreferencesTests|QuickChatCatalogPresentationTests' > "$proof/native-default.log" 2>&1
node scripts/test-macos-native.mts default "${native_args[@]}" --filter 'QuickChatCatalogPresentationTests' > "$proof/native-rendered.log" 2>&1
node scripts/test-macos-native.mts named "${native_args[@]}" --filter 'AppStateIsolationTests|ProfileChatPreferencesTests' > "$proof/native-named.log" 2>&1
# Package a genuine debug app, retaining its matching real bundled Gateway.
# No release signing identity or operator Keychain is imported.
SKIP_PNPM_INSTALL=1 OPENCLAW_SKIP_MLX_TTS=1 ALLOW_ADHOC_SIGNING=1 SIGN_IDENTITY=- ./scripts/package-mac-app.sh > "$proof/package.log" 2>&1
/usr/libexec/PlistBuddy -c 'Print :OpenClawGitCommit' dist/OpenClaw.app/Contents/Info.plist > "$proof/bundle-head.txt"
[[ "$(cat "$proof/bundle-head.txt")" == "$expected" ]] || { echo 'Bundle SHA does not match' >&2; exit 2; }
codesign -dvv dist/OpenClaw.app > "$proof/codesign.txt" 2>&1
shasum -a 256 dist/OpenClaw.app/Contents/MacOS/OpenClaw > "$proof/bundle-sha256.txt"
swiftc "$script_dir/cron-ax.swift" -o "$script_dir/cron-ax"
echo 'Build, full native partitions, package and AX helper completed. Grant guest-only Accessibility/Screen Recording if needed before runtime capture.'
