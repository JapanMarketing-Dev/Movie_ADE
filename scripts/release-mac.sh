#!/usr/bin/env bash
# Builds, signs (Developer ID), notarizes and staples the macOS app on the maintainer's Mac, then attaches the
# dmg/zip to the GitHub Release v<version>. Windows/Linux are built by CI (.github/workflows/release.yml).
#
#   scripts/release-mac.sh <version>
#
# Needs ~/.solocut-release/notary.env (never committed):
#   SOLOCUT_MAC_IDENTITY, APPLE_API_KEY (path to AuthKey_*.p8), APPLE_API_KEY_ID, APPLE_API_ISSUER
set -euo pipefail
VERSION="${1:?usage: scripts/release-mac.sh <version>}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck disable=SC1091
source "$HOME/.solocut-release/notary.env"
: "${SOLOCUT_MAC_IDENTITY:?}" "${APPLE_API_KEY:?}" "${APPLE_API_KEY_ID:?}" "${APPLE_API_ISSUER:?}"

# Build from a clean worktree of the tag, so work in progress in the main checkout never ships.
WT="$(mktemp -d)/solocut-v$VERSION"
git -C "$ROOT" worktree add --detach "$WT" "v$VERSION"
trap 'git -C "$ROOT" worktree remove --force "$WT" >/dev/null 2>&1 || true' EXIT
cd "$WT"
node -e "const v=require('./apps/desktop/package.json').version; if (v!=='$VERSION') { console.error('apps/desktop version is '+v+', expected $VERSION'); process.exit(1) }"
pnpm install --frozen-lockfile
node scripts/build-cli.mjs
cd apps/desktop
rm -rf release
pnpm dist:mac:all

for app in release/mac-arm64/Solocut.app release/mac/Solocut.app; do
  [ -d "$app" ] || continue
  codesign --verify --deep --strict --verbose=1 "$app"
  xcrun stapler validate "$app"
  spctl --assess --type execute --verbose=2 "$app"
done
# electron-builder notarizes the .app; notarize the signed dmg too so opening the download shows no warning.
for dmg in release/*.dmg; do
  xcrun notarytool submit "$dmg" --key "$APPLE_API_KEY" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER" --wait
  xcrun stapler staple "$dmg"
  spctl --assess --type open --context context:primary-signature --verbose=2 "$dmg"
done

mkdir -p "$ROOT/apps/desktop/release"
cp release/Solocut-"$VERSION"-mac-*.{dmg,zip} "$ROOT/apps/desktop/release/"
cd "$ROOT"
gh release upload "v$VERSION" -R JapanMarketing-Dev/solocut --clobber apps/desktop/release/Solocut-"$VERSION"-mac-*.{dmg,zip}
echo "✓ signed + notarized mac builds attached to v$VERSION. Next: node scripts/release.mjs $VERSION --notes docs/release-notes/$VERSION.md"
