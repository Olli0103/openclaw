#!/bin/bash
set -euo pipefail
[[ -f /tmp/openclaw-native-disposable-20261005 ]] || exit 2
export PATH=/opt/homebrew/bin:/usr/local/bin:$PATH
root="$HOME/proof"
mkdir -p "$root"
cp -R '/Volumes/My Shared Files/helpers' "$root/scripts"
repo="$root/openclaw"
[[ ! -e "$repo" ]] || { echo 'Checkout exists; reconcile first'; exit 2; }
git clone --depth 1 --single-branch --branch fix/macos-cron-events-165527 https://github.com/Olli0103/openclaw.git "$repo"
[[ "$(git -C "$repo" rev-parse HEAD)" == 9fbe51b94c95c17b17d4e0c490eab9b7502fa5f6 ]] || exit 2
cd "$repo"
git fetch --depth 1 origin fix/macos-dashboard-downloads-139262:refs/heads/dashboard-proof
[[ "$(git rev-parse dashboard-proof)" == 0157649a18aae67689f2aaa975f503ffee84fb15 ]] || exit 2
node --version
pnpm --version
