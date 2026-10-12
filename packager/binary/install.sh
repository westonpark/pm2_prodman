#!/bin/sh
# prodman: install the standalone pm2 binary (a release asset, see packager/binary) and set the
# host up to run it. Safe to re-run: it repairs what is missing and leaves a healthy host alone.
#
#   curl -fsSL https://github.com/westonpark/pm2_prodman/releases/latest/download/install.sh | sh
#
# and to link the server to a prodman bucket in the same step:
#
#   curl -fsSL …/install.sh | PRODMAN_URL=https://prodman.example.com PM2_PUBLIC_KEY=<public> PM2_SECRET_KEY=<secret> sh
#
# After installing the binary it
#   1. on Linux with systemd, installs and enables the pm2-<user> service (or points an existing
#      one at this binary, keeping the rest of the unit) — needs sudo;
#   2. gets PM2 running from this binary inside the service: hands over a daemon started outside
#      it, restarts the service when it runs another version, or starts it; without systemd it
#      restarts a running daemon of another version (pm2 update);
#   3. links the server to prodman when PRODMAN_URL, PM2_PUBLIC_KEY and PM2_SECRET_KEY are given
#      and it isn't linked yet (an existing link to another bucket is kept unless PM2_RELINK=1);
#      starts the prodman agent when the host is linked but its agent isn't running;
#   4. removes other pm2 installations (npm ones under any node version, in /usr, /usr/local…),
#      which shadow this one in shells and, at pm2 <= 7, start daemons outside the service.
#
# PM2_INSTALL_DIR  where to put pm2 (default ~/.local/bin)
# PM2_VERSION      a release version such as 8.3.0 (default: the latest release)
# PM2_REPO         the GitHub repository (default westonpark/pm2_prodman)
# PM2_BASE_URL     download from this directory (assets + SHA256SUMS) instead of GitHub
# PM2_SETUP=0      only install the binary (skip 1-4)
# PRODMAN_URL, PM2_PUBLIC_KEY, PM2_SECRET_KEY, PM2_MACHINE_NAME (optional), PM2_RELINK=1
#                  link to this prodman bucket (keys from prodman: Bucket settings → Connect)
set -eu

REPO=${PM2_REPO:-westonpark/pm2_prodman}
DIR=${PM2_INSTALL_DIR:-$HOME/.local/bin}
if [ -n "${PM2_VERSION:-}" ]; then BASE="https://github.com/$REPO/releases/download/v${PM2_VERSION#v}"
else BASE="https://github.com/$REPO/releases/latest/download"; fi
BASE=${PM2_BASE_URL:-$BASE}

die () { echo "pm2 install: $*" >&2; exit 1; }
WARNINGS=""
warn () { echo "warning: $*" >&2; WARNINGS="$WARNINGS
  - $*"; }

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
PM2="$DIR/pm2"
INFO=$("$PM2" --binary-info)
VERSION=$(echo "$INFO" | sed -nE 's/^\{"version":"([^"]+)".*/\1/p')
echo "installed $PM2: $INFO"

if [ "${PM2_SETUP:-1}" = 0 ]; then exit 0; fi

# link details: taken out of the environment so they never reach PM2's (or its apps') environment
LINK_URL=${PRODMAN_URL:-} LINK_PUBLIC=${PM2_PUBLIC_KEY:-} LINK_SECRET=${PM2_SECRET_KEY:-} LINK_NAME=${PM2_MACHINE_NAME:-}
unset PRODMAN_URL PM2_PUBLIC_KEY PM2_SECRET_KEY PM2_MACHINE_NAME

USER_NAME=$(id -un)
export PM2_HOME="${PM2_HOME:-$HOME/.pm2}"
UNIT="pm2-$USER_NAME"
# run pm2 without any agent state this shell may carry (a PM2 started with PM2_AGENT_ONLINE
# starts no agent)
pm2c () { env -u PM2_AGENT_ONLINE -u PM2_INTERACTOR_PROCESSING -u PM2_STATUS -u PM2_USAGE "$PM2" "$@"; }

# root commands: sudo without a password, else sudo asking on the terminal, else none
if [ "$(id -u)" = 0 ]; then SUDO=""
elif sudo -n true 2>/dev/null; then SUDO="sudo -n"
elif [ -r /dev/tty ] && command -v sudo >/dev/null 2>&1; then SUDO="sudo"
else SUDO="none"; fi
asroot () { if [ "$SUDO" = none ]; then return 1; fi; $SUDO "$@"; }

# the running daemon (pm2.pid, else its process title: a daemon started by hand may have none)
daemon_pid () {
  pid=$(cat "$PM2_HOME/pm2.pid" 2>/dev/null || true)
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then echo "$pid"; return 0; fi
  pgrep -u "$(id -u)" -f "^PM2 v[^:]*: God Daemon \\($PM2_HOME\\)" 2>/dev/null | head -1
}
daemon_version () { pid=$(daemon_pid); [ -n "$pid" ] && ps -o args= -p "$pid" | sed -nE 's/^PM2 v([^:]+):.*/\1/p'; }
agent_running () { pgrep -u "$(id -u)" -f "^PM2 Agent v[^:]*: \\($PM2_HOME\\)" >/dev/null 2>&1; }

# --- 1. the systemd service ---------------------------------------------------------------
NODE_DIR=""
if [ -x "$HOME/.pm2-current/bin/node" ]; then NODE_DIR="$HOME/.pm2-current/bin"
elif [ -n "${PM2_NODE:-}" ]; then NODE_DIR=$(dirname "$PM2_NODE")
elif command -v node >/dev/null 2>&1; then NODE_DIR=$(dirname "$(command -v node)"); fi
[ -n "$NODE_DIR" ] || warn "no node found: pm2 runs its daemon and apps on node (install Node.js or set PM2_NODE=/path/to/node)"

SYSTEMD=0
[ "$OS" = linux ] && [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1 && SYSTEMD=1
UNIT_CHANGED=0
if [ "$SYSTEMD" = 1 ] && [ -n "$NODE_DIR" ]; then
  UNIT_FILE=$(systemctl show -p FragmentPath --value "$UNIT" 2>/dev/null || true)
  RUNS=""
  [ -n "$UNIT_FILE" ] && [ -f "$UNIT_FILE" ] && RUNS=$(sed -nE 's/^ExecStart=([^ ]+).*/\1/p' "$UNIT_FILE" | head -1)
  if [ -z "$RUNS" ] || [ "$(readlink -f "$RUNS" 2>/dev/null || echo "$RUNS")" != "$(readlink -f "$PM2")" ]; then
    NEW="$TMP/$UNIT.service"
    if [ -n "$RUNS" ]; then
      # keep the unit (PATH, environment…), only point its commands at this pm2
      echo "updating $UNIT_FILE to run $PM2"
      sed -E "s#^(Exec(Start|Reload|Stop)=)[^ ]+#\\1$PM2#" "$UNIT_FILE" > "$NEW"
    else
      UNIT_FILE=/etc/systemd/system/$UNIT.service
      echo "installing $UNIT_FILE"
      cat > "$NEW" <<EOF
[Unit]
Description=PM2 process manager
Documentation=https://pm2.keymetrics.io/
After=network.target

[Service]
Type=forking
User=$USER_NAME
LimitNOFILE=infinity
LimitNPROC=infinity
LimitCORE=infinity
Environment=PATH=$NODE_DIR:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
Environment=PM2_HOME=$PM2_HOME
PIDFile=$PM2_HOME/pm2.pid
Restart=on-failure

ExecStart=$PM2 resurrect
ExecReload=$PM2 reload all
ExecStop=$PM2 kill

[Install]
WantedBy=multi-user.target
EOF
    fi
    if asroot install -m 644 "$NEW" "$UNIT_FILE" && asroot systemctl daemon-reload && asroot systemctl enable "$UNIT" 2>/dev/null; then
      UNIT_CHANGED=1
    else
      cp "$NEW" "$PM2_HOME/$UNIT.service.new" 2>/dev/null || true
      warn "could not install the systemd service (needs sudo). Run: sudo install -m 644 $PM2_HOME/$UNIT.service.new $UNIT_FILE && sudo systemctl daemon-reload && sudo systemctl enable $UNIT, then re-run this script"
    fi
  fi
fi

# --- 2. PM2 running this binary, inside the service ------------------------------------------
if [ "$SYSTEMD" = 1 ] && systemctl cat "$UNIT" >/dev/null 2>&1; then
  if systemctl is-active --quiet "$UNIT"; then
    if [ "$(daemon_version)" != "$VERSION" ] || [ "$UNIT_CHANGED" = 1 ]; then
      echo "restarting $UNIT (running pm2 $(daemon_version || echo '?'), installed $VERSION)"
      pm2c save >/dev/null 2>&1 || true
      asroot systemctl restart "$UNIT" || warn "systemctl restart $UNIT failed"
    fi
  else
    if [ -n "$(daemon_pid)" ]; then
      # started outside the service (shell, CI job): hand it over, keeping its process list
      echo "moving the running PM2 into $UNIT"
      pm2c save >/dev/null 2>&1 || true
      PM2_SERVICE_GUARD=off pm2c kill >/dev/null 2>&1 || true
    fi
    echo "starting $UNIT"
    asroot systemctl start "$UNIT" || warn "systemctl start $UNIT failed (see: systemctl status $UNIT)"
  fi
elif [ -n "$(daemon_pid)" ] && [ "$(daemon_version)" != "$VERSION" ]; then
  # no service: restart the daemon in place on this version
  echo "restarting PM2 (running pm2 $(daemon_version), installed $VERSION)"
  pm2c update >/dev/null || warn "pm2 update failed"
  [ "$SYSTEMD" = 1 ] && warn "PM2 is not running as a systemd service: nothing restarts it after a crash or reboot"
fi

# --- 3. the prodman link and agent ------------------------------------------------------------
if [ -n "$LINK_PUBLIC$LINK_SECRET" ]; then
  if [ -z "$LINK_PUBLIC" ] || [ -z "$LINK_SECRET" ] || [ -z "$LINK_URL" ]; then
    warn "not linked: set PRODMAN_URL, PM2_PUBLIC_KEY and PM2_SECRET_KEY together"
  elif [ -f "$PM2_HOME/agent.json5" ] && grep -q "\"public_key\": *\"$LINK_PUBLIC\"" "$PM2_HOME/agent.json5"; then
    echo "already linked to this bucket"
  elif [ -f "$PM2_HOME/agent.json5" ] && [ "${PM2_RELINK:-}" != 1 ]; then
    warn "already linked to another bucket, so not relinked (set PM2_RELINK=1 to link to this one)"
  else
    echo "linking to $LINK_URL"
    # shellcheck disable=SC2086 # the optional machine name
    pm2c link "$LINK_SECRET" "$LINK_PUBLIC" $LINK_NAME --info-node "$LINK_URL" >/dev/null 2>&1 || warn "pm2 link failed (see $PM2_HOME/agent.log)"
  fi
fi
if [ -f "$PM2_HOME/agent.json5" ] && [ -n "$(daemon_pid)" ]; then
  for i in 1 2 3 4 5 6 7 8 9 10; do agent_running && break; sleep 1; done
  if ! agent_running; then
    echo "starting the prodman agent"
    pm2c link >/dev/null 2>&1 || warn "could not start the prodman agent (see $PM2_HOME/agent.log)"
  fi
fi

# --- 4. other pm2 installations ---------------------------------------------------------------
remove_npm_pm2 () { # <prefix>
  [ -d "$1/lib/node_modules/pm2" ] || return 0
  echo "removing the pm2 installed under $1"
  if [ -w "$1/lib/node_modules" ]; then rm -rf "$1/lib/node_modules/pm2" "$1/bin/pm2" "$1/bin/pm2-dev" "$1/bin/pm2-docker" "$1/bin/pm2-runtime"
  else asroot rm -rf "$1/lib/node_modules/pm2" "$1/bin/pm2" "$1/bin/pm2-dev" "$1/bin/pm2-docker" "$1/bin/pm2-runtime" || warn "could not remove the pm2 under $1"; fi
}
for p in "$HOME"/.nvm/versions/node/* "$HOME"/.asdf/installs/nodejs/* "$HOME"/.volta/tools/image/node/* "$HOME"/.local/share/fnm/node-versions/*/installation /usr /usr/local /opt/homebrew; do
  [ -d "$p" ] && remove_npm_pm2 "$p"
done
rm -f "$DIR"/pm2.new.* 2>/dev/null || true

# --- summary -------------------------------------------------------------------------------------
echo
if [ -n "$(daemon_pid)" ]; then
  echo "PM2 $(daemon_version) is running$( [ "$SYSTEMD" = 1 ] && systemctl is-active --quiet "$UNIT" && echo " as the systemd service $UNIT")$( agent_running && echo ", prodman agent running")"
else
  echo "PM2 is installed; no daemon is running yet (pm2 start <app>)"
fi
if [ ! -f "$PM2_HOME/agent.json5" ]; then
  echo "not linked to prodman: re-run with PRODMAN_URL, PM2_PUBLIC_KEY and PM2_SECRET_KEY, or run pm2 link <secret> <public>"
fi
FOUND=$(command -v pm2 || true)
if [ "$FOUND" != "$PM2" ]; then
  if [ -n "$FOUND" ]; then warn "'pm2' on your PATH is $FOUND: put $DIR first"
  else echo "note: add $DIR to your PATH"; fi
fi
if [ -n "$WARNINGS" ]; then echo "warnings:$WARNINGS"; fi
