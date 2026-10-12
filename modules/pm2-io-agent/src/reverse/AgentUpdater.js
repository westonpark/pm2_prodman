'use strict'

/**
 * prodman: update pm2_prodman on this host when prodman asks (`selfUpdate`).
 *
 * The update must outlive this agent: restarting PM2 restarts the agent. So it runs as a
 * detached shell script that
 *   1. installs the new version with the npm of the node running this agent (the node the PM2
 *      service uses), from the source prodman sends; or, when PM2 runs from the standalone
 *      binary (PM2_BINARY), downloads the binary for this platform from the latest GitHub
 *      release of the source's repository (or PRODMAN_BINARY_URL), checks it against the
 *      release's SHA256SUMS and replaces the binary;
 *   2. saves the process list and restarts PM2: through its systemd service (pm2-$USER, needs
 *      passwordless `sudo systemctl restart`), else `pm2 update` when there is no service;
 *   3. records the outcome in $PM2_HOME/prodman-update.json, which the next agent reports to
 *      prodman (reportPrevious) and removes.
 *
 * Only sources from the pm2_prodman repository are accepted, unless PRODMAN_UPDATE_SOURCES lists
 * other allowed prefixes (comma-separated). PRODMAN_AUTO_UPDATE=off refuses all updates.
 */

const fs = require('fs')
const path = require('path')
const os = require('os')
const childProcess = require('child_process')
const log = require('debug')('interactor:update')

const DEFAULT_ALLOWED = [
  'https://codeload.github.com/westonpark/pm2_prodman/',
  'https://github.com/westonpark/pm2_prodman',
  'github:westonpark/pm2_prodman'
]

function allowedSources (env) {
  const extra = String(env.PRODMAN_UPDATE_SOURCES || '').split(',').map(s => s.trim()).filter(Boolean)
  return DEFAULT_ALLOWED.concat(extra)
}

/** why this source can't be installed, or null */
function checkSource (source, env) {
  if (/^(off|false|0|no)$/i.test(String(env.PRODMAN_AUTO_UPDATE || ''))) return 'updates are disabled on this host (PRODMAN_AUTO_UPDATE=off)'
  if (typeof source !== 'string' || !source.trim()) return 'no update source given'
  if (/[\s'"`$;&|<>\\]/.test(source)) return 'invalid update source'
  if (!allowedSources(env).some(p => source.startsWith(p))) return `source not allowed on this host: ${source} (set PRODMAN_UPDATE_SOURCES to allow it)`
  return null
}

const q = s => `'${String(s).replace(/'/g, `'\\''`)}'`

/**
 * the agent's own environment (WatchDog sets PM2_AGENT_ONLINE): a PM2 restarted with it thinks an
 * agent is already running and starts none
 */
const AGENT_ENV = ['PM2_AGENT_ONLINE', 'PM2_INTERACTOR_PROCESSING', 'PM2_STATUS', 'PM2_VERSION', 'PM2_USAGE']

/** env for the update script: the agent's, without its own state */
function scriptEnv (env) {
  const out = Object.assign({}, env, { RUNNER_TRACKING_ID: '' })
  for (const k of AGENT_ENV) delete out[k]
  return out
}

/** the GitHub repository (owner/name) of a pm2_prodman source, or null */
function sourceRepo (source) {
  const m = /^(?:https:\/\/codeload\.github\.com\/|https:\/\/github\.com\/|github:)([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/#]|$)/.exec(source)
  return m ? m[1] + '/' + m[2] : null
}

/** release asset of the standalone pm2 binary for a host, e.g. pm2-linux-x64 (see packager/binary) */
function binaryAsset (platform, arch, musl) {
  const os = platform === 'win32' ? 'windows' : platform
  return 'pm2-' + os + '-' + arch + (musl ? '-musl' : '') + (os === 'windows' ? '.exe' : '')
}

function isMusl () {
  try { return process.platform === 'linux' && !process.report.getReport().header.glibcVersionRuntime } catch (e) { return false }
}

/**
 * Where to download the binary from: PRODMAN_BINARY_URL (a directory holding the assets and
 * SHA256SUMS), else the latest GitHub release of the source's repository.
 */
function binaryBase (source, env) {
  if (env.PRODMAN_BINARY_URL) return String(env.PRODMAN_BINARY_URL).replace(/\/+$/, '')
  const repo = sourceRepo(source)
  return repo ? 'https://github.com/' + repo + '/releases/latest/download' : null
}

/** install step for an npm install of pm2: npm install -g into the prefix of the agent's node */
function npmInstall ({ source, prefix }) {
  const flag = source.startsWith('github:') ? '--allow-git=root' : '--allow-remote=root'
  return {
    kind: 'npm',
    pm2: 'node ' + q(prefix + '/lib/node_modules/pm2/bin/pm2'),
    unitPm2: prefix + '/bin/pm2',
    keepPrefix: prefix,
    install: `echo "== $(date) updating pm2_prodman $STATUS_FROM from ${source}"
npm install -g ${flag} ${q(source)} || fail "npm install failed (see prodman-update.log on the server)"
TO=$(PKG=${q(prefix + '/lib/node_modules/pm2/package.json')} node -p 'require(process.env.PKG).version') || fail "cannot read the installed version"`
  }
}

/**
 * install step for the standalone pm2 binary: download the release asset, check it against
 * SHA256SUMS and that it runs, then replace the binary (a rename: the running one is unaffected)
 */
function binaryInstall ({ binary, base, asset }) {
  return {
    kind: 'binary',
    pm2: q(binary),
    unitPm2: binary,
    install: `BIN=${q(binary)} BASE=${q(base)} ASSET=${q(asset)}
NEW="$BIN.new.$$"
echo "== $(date) updating the pm2 binary ($STATUS_FROM) from $BASE/$ASSET"
fetch () { if command -v curl >/dev/null; then curl -fsSL --retry 3 -o "$2" "$1"; else wget -q -O "$2" "$1"; fi; }
sha256 () { if command -v sha256sum >/dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1; }
trap 'rm -f "$NEW" "$NEW.sums"' EXIT
fetch "$BASE/$ASSET" "$NEW" || fail "cannot download $BASE/$ASSET"
fetch "$BASE/SHA256SUMS" "$NEW.sums" || fail "cannot download $BASE/SHA256SUMS"
WANT=$(awk -v a="$ASSET" '$2 == a { print $1 }' "$NEW.sums")
[ -n "$WANT" ] || fail "$ASSET is not in SHA256SUMS"
[ "$(sha256 "$NEW")" = "$WANT" ] || fail "checksum mismatch for $ASSET"
chmod 755 "$NEW"
TO=$("$NEW" --binary-info | node -p 'JSON.parse(require("fs").readFileSync(0, "utf8")).version') || fail "the downloaded binary does not run"
mv -f "$NEW" "$BIN" || fail "cannot replace $BIN"`
  }
}

/**
 * the detached update script: install (the step), remove other pm2 installations, make sure PM2
 * runs as the systemd service pm2-$USER (installing or correcting the unit), then restart PM2
 * through it
 */
function script ({ nodeBin, home, statusFile, from, user, pm2, install, kind, unitPm2, keepPrefix }) {
  return `#!/bin/bash
# prodman agent self-update (generated by AgentUpdater.js)
# the agent's own state must not reach the PM2 started below, or it would not start an agent
unset ${AGENT_ENV.join(' ')}
export PATH=${q(nodeBin)}:$PATH
export PM2_HOME=${q(home)} STATUS_FILE=${q(statusFile)} STATUS_FROM=${q(from)}
# status <ok 1|0> <to> <error> <restart> [warning]: read by the next agent (reportPrevious)
status () {
  STATUS_OK="$1" STATUS_TO="$2" STATUS_ERR="$3" STATUS_RESTART="$4" STATUS_WARN="$5" node -e 'const e = process.env; require("fs").writeFileSync(e.STATUS_FILE, JSON.stringify({ at: Date.now(), from: e.STATUS_FROM, ok: e.STATUS_OK === "1", to: e.STATUS_TO || null, error: e.STATUS_ERR || null, restart: e.STATUS_RESTART || null, warning: e.STATUS_WARN || null }))'
}
fail () { status 0 "$TO" "$1" "" "$WARN"; echo "FAILED: $1"; exit 1; }
WARN=""
warn () { echo "WARNING: $1"; WARN="\${WARN:+$WARN; }$1"; }
${install}
echo "installed $TO"

# --- remove other pm2 installations: an old pm2 left under another node version (or the binary
# on an npm host) shadows this one in shells, and any pm2 <= 7 starts a daemon outside the service
KIND=${q(kind)} KEEP=${q(keepPrefix || '')}
remove_npm_pm2 () { # <prefix>
  local p="$1" rm="rm -rf"
  [ -d "$p/lib/node_modules/pm2" ] || return 0
  [ -n "$KEEP" ] && [ "$(readlink -f "$p")" = "$(readlink -f "$KEEP")" ] && return 0
  [ -w "$p/lib/node_modules" ] || rm="sudo -n rm -rf"
  echo "removing the pm2 installed under $p"
  $rm "$p/lib/node_modules/pm2" "$p/bin/pm2" "$p/bin/pm2-dev" "$p/bin/pm2-docker" "$p/bin/pm2-runtime" || warn "could not remove the pm2 under $p"
}
for p in "$HOME"/.nvm/versions/node/* "$HOME"/.asdf/installs/nodejs/* "$HOME"/.volta/tools/image/node/* "$HOME"/.local/share/fnm/node-versions/*/installation /usr /usr/local /opt/homebrew; do
  [ -d "$p" ] && remove_npm_pm2 "$p"
done
rm -f "$HOME"/.local/bin/pm2.new.* 2>/dev/null
if [ "$KIND" = npm ] && [ -x "$HOME/.local/bin/pm2" ] && [ "$(head -c 2 "$HOME/.local/bin/pm2")" != "#!" ]; then
  echo "removing the standalone pm2 binary $HOME/.local/bin/pm2"
  rm -f "$HOME/.local/bin/pm2"
fi

UNIT=pm2-${user}
PM2_CMD=${q(unitPm2)}
if [ -d /run/systemd/system ] && command -v systemctl >/dev/null; then
  # --- the systemd service: install it, or correct it when it runs another pm2
  NODE_DIR=${q(nodeBin)}
  [ -x "$HOME/.pm2-current/bin/node" ] && NODE_DIR="$HOME/.pm2-current/bin"
  UNIT_FILE=$(systemctl show -p FragmentPath --value "$UNIT" 2>/dev/null)
  RUNS=$(sed -nE 's/^ExecStart=([^ ]+).*/\\1/p' "$UNIT_FILE" 2>/dev/null | head -1)
  if [ -z "$UNIT_FILE" ] || [ ! -f "$UNIT_FILE" ] || [ "$(readlink -f "$RUNS" 2>/dev/null)" != "$(readlink -f "$PM2_CMD")" ]; then
    if [ -n "$UNIT_FILE" ] && [ -f "$UNIT_FILE" ]; then
      # keep the unit (PATH, environment…), only point its commands at this pm2
      echo "updating $UNIT_FILE to run $PM2_CMD"
      sed -E "s#^(Exec(Start|Reload|Stop)=)[^ ]+#\\1$PM2_CMD#" "$UNIT_FILE" > "$PM2_HOME/$UNIT.service.new"
    else
      UNIT_FILE=/etc/systemd/system/$UNIT.service
      echo "installing $UNIT_FILE to run $PM2_CMD"
      cat > "$PM2_HOME/$UNIT.service.new" <<UNIT
[Unit]
Description=PM2 process manager
Documentation=https://pm2.keymetrics.io/
After=network.target

[Service]
Type=forking
User=${user}
LimitNOFILE=infinity
LimitNPROC=infinity
LimitCORE=infinity
Environment=PATH=$NODE_DIR:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
Environment=PM2_HOME=$PM2_HOME
PIDFile=$PM2_HOME/pm2.pid
Restart=on-failure

ExecStart=$PM2_CMD resurrect
ExecReload=$PM2_CMD reload all
ExecStop=$PM2_CMD kill

[Install]
WantedBy=multi-user.target
UNIT
    fi
    if sudo -n install -m 644 "$PM2_HOME/$UNIT.service.new" "$UNIT_FILE" && sudo -n systemctl daemon-reload && sudo -n systemctl enable "$UNIT"; then
      rm -f "$PM2_HOME/$UNIT.service.new"
    else
      warn "could not install the systemd service $UNIT (needs passwordless sudo); run: sudo install -m 644 $PM2_HOME/$UNIT.service.new $UNIT_FILE && sudo systemctl daemon-reload && sudo systemctl enable $UNIT"
    fi
  fi
fi

if systemctl cat "$UNIT" >/dev/null 2>&1; then
  sudo -n true 2>/dev/null || sudo -n -l systemctl restart "$UNIT" >/dev/null 2>&1 || fail "installed $TO but cannot restart $UNIT: needs passwordless sudo for systemctl restart $UNIT"
  ${pm2} save || true
  if systemctl is-active --quiet "$UNIT"; then
    status 1 "$TO" "" systemd "$WARN"
    echo "restarting $UNIT"
    # systemd carries out the restart even though it stops this script (same cgroup)
    sudo -n systemctl restart "$UNIT" || fail "installed $TO but systemctl restart $UNIT failed"
  else
    # the running daemon was started outside the service: hand it over to systemd
    echo "moving PM2 into $UNIT"
    ${pm2} kill || true
    status 1 "$TO" "" systemd "$WARN"
    if ! sudo -n systemctl start "$UNIT"; then
      warn "systemctl start $UNIT failed; PM2 restarted outside systemd"
      status 1 "$TO" "" "pm2 resurrect" "$WARN"
      PM2_SERVICE_GUARD=off ${pm2} resurrect || fail "installed $TO but could not restart PM2"
    fi
  fi
else
  status 1 "$TO" "" "pm2 update" "$WARN"
  echo "no $UNIT service: pm2 update"
  ${pm2} update || fail "installed $TO but pm2 update failed"
fi
echo "== done"
`
}

/**
 * Start an update in the background. cb(err) when it can't start; cb(null, info) once it runs.
 * @param {Object} params { source }
 * @param {Object} [deps] env/home/spawn/version/execPath for tests
 */
function selfUpdate (params, deps, cb) {
  deps = deps || {}
  const env = deps.env || process.env
  const source = params && params.source
  const problem = checkSource(source, env)
  if (problem) return cb(new Error(problem))
  const home = deps.home || env.PM2_HOME || path.join(os.homedir(), '.pm2')
  const nodeBin = path.dirname(deps.execPath || process.execPath)
  // started by the standalone pm2 binary (packager/binary): replace the binary, else npm install
  let step
  if (env.PM2_BINARY) {
    const base = binaryBase(source, env)
    if (!base) return cb(new Error('cannot tell where to download the pm2 binary from ' + source + ' (set PRODMAN_BINARY_URL)'))
    step = binaryInstall({ binary: env.PM2_BINARY, base, asset: deps.asset || binaryAsset(process.platform, process.arch, isMusl()) })
  } else {
    step = npmInstall({ source, prefix: path.dirname(nodeBin) })
  }
  const from = deps.version || require('../../../../package.json').version
  const user = deps.user || env.USER || os.userInfo().username
  const statusFile = path.join(home, 'prodman-update.json')
  const logFile = path.join(home, 'prodman-update.log')
  const scriptFile = path.join(home, 'prodman-update.sh')
  try {
    fs.writeFileSync(scriptFile, script(Object.assign({ nodeBin, home, statusFile, from, user }, step)), { mode: 0o700 })
    try { fs.unlinkSync(statusFile) } catch (e) {}
    const out = fs.openSync(logFile, 'a')
    const child = (deps.spawn || childProcess.spawn)('bash', [scriptFile], { detached: true, stdio: ['ignore', out, out], env: scriptEnv(env) })
    child.unref()
    log('update from %s started (pid %s)', from, child.pid)
    cb(null, { started: true, from, source, log: logFile })
  } catch (err) {
    cb(err)
  }
}

/**
 * Report (and remove) the outcome of an update that restarted the previous agent.
 * @param {Object} transport needs send(channel, payload)
 */
function reportPrevious (transport, deps) {
  deps = deps || {}
  const env = deps.env || process.env
  const home = deps.home || env.PM2_HOME || path.join(os.homedir(), '.pm2')
  const statusFile = path.join(home, 'prodman-update.json')
  let status
  try { status = JSON.parse(fs.readFileSync(statusFile, 'utf8')) } catch (e) { return null }
  try { fs.unlinkSync(statusFile) } catch (e) {}
  let tail = ''
  try { tail = fs.readFileSync(path.join(home, 'prodman-update.log'), 'utf8').split('\n').slice(-30).join('\n') } catch (e) {}
  const payload = Object.assign({ at: Date.now(), now: deps.version || require('../../../../package.json').version, log: tail }, status)
  transport.send('agent:update', payload)
  return payload
}

module.exports = { selfUpdate, reportPrevious, checkSource, script, scriptEnv, sourceRepo, binaryAsset }
