#!/bin/sh
# prodman: install the standalone pm2 binary (a release asset, see packager/binary)
#
#   curl -fsSL https://github.com/westonpark/pm2_prodman/releases/latest/download/install.sh | sh
#
# PM2_INSTALL_DIR  where to put pm2 (default ~/.local/bin)
# PM2_VERSION      a release version such as 8.3.0 (default: the latest release)
# PM2_REPO         the GitHub repository (default westonpark/pm2_prodman)
# PM2_BASE_URL     download from this directory (assets + SHA256SUMS) instead of GitHub
set -eu

REPO=${PM2_REPO:-westonpark/pm2_prodman}
DIR=${PM2_INSTALL_DIR:-$HOME/.local/bin}
if [ -n "${PM2_VERSION:-}" ]; then BASE="https://github.com/$REPO/releases/download/v${PM2_VERSION#v}"
else BASE="https://github.com/$REPO/releases/latest/download"; fi
BASE=${PM2_BASE_URL:-$BASE}

die () { echo "pm2 install: $*" >&2; exit 1; }

case "$(uname -s)" in
  Linux) OS=linux ;;
  Darwin) OS=darwin ;;
  *) die "unsupported OS $(uname -s): use npm install -g https://codeload.github.com/$REPO/tar.gz/master" ;;
esac
case "$(uname -m)" in
  x86_64|amd64) ARCH=x64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) die "no pm2 binary for $(uname -m) (bun builds x64 and arm64 only): use npm install -g https://codeload.github.com/$REPO/tar.gz/master" ;;
esac
LIBC=
if [ "$OS" = linux ] && { ls /lib/ld-musl-* >/dev/null 2>&1 || ldd --version 2>&1 | grep -qi musl; }; then LIBC=-musl; fi
ASSET="pm2-$OS-$ARCH$LIBC"

fetch () { if command -v curl >/dev/null 2>&1; then curl -fsSL --retry 3 -o "$2" "$1"; else wget -q -O "$2" "$1"; fi; }
sha256 () { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1; }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
echo "downloading $BASE/$ASSET"
fetch "$BASE/$ASSET" "$TMP/pm2" || die "cannot download $BASE/$ASSET"
fetch "$BASE/SHA256SUMS" "$TMP/SHA256SUMS" || die "cannot download $BASE/SHA256SUMS"
WANT=$(awk -v a="$ASSET" '$2 == a { print $1 }' "$TMP/SHA256SUMS")
[ -n "$WANT" ] || die "$ASSET is not in SHA256SUMS"
[ "$(sha256 "$TMP/pm2")" = "$WANT" ] || die "checksum mismatch for $ASSET"
chmod 755 "$TMP/pm2"
"$TMP/pm2" --binary-info >/dev/null || die "the downloaded binary does not run on this machine"

mkdir -p "$DIR"
mv -f "$TMP/pm2" "$DIR/pm2"
echo "installed $DIR/pm2: $("$DIR/pm2" --binary-info)"

FOUND=$(command -v pm2 || true)
if [ "$FOUND" != "$DIR/pm2" ]; then
  if [ -n "$FOUND" ]; then echo "note: 'pm2' on your PATH is $FOUND; put $DIR first, or remove that pm2 (npm rm -g pm2 under its node)"
  else echo "note: add $DIR to your PATH"; fi
fi
command -v node >/dev/null 2>&1 || echo "note: pm2 runs its daemon and apps on node: install Node.js or set PM2_NODE=/path/to/node"
