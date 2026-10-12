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
    pm2: 'node ' + q(prefix + '/lib/node_modules/pm2/bin/pm2'),
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
    pm2: q(binary),
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

/** the detached update script */
function script ({ nodeBin, home, statusFile, from, user, pm2, install }) {
  return `#!/bin/bash
# prodman agent self-update (generated by AgentUpdater.js)
export PATH=${q(nodeBin)}:$PATH
export PM2_HOME=${q(home)} STATUS_FILE=${q(statusFile)} STATUS_FROM=${q(from)}
# status <ok 1|0> <to> <error> <restart>: read by the next agent (reportPrevious)
status () {
  STATUS_OK="$1" STATUS_TO="$2" STATUS_ERR="$3" STATUS_RESTART="$4" node -e 'const e = process.env; require("fs").writeFileSync(e.STATUS_FILE, JSON.stringify({ at: Date.now(), from: e.STATUS_FROM, ok: e.STATUS_OK === "1", to: e.STATUS_TO || null, error: e.STATUS_ERR || null, restart: e.STATUS_RESTART || null }))'
}
fail () { status 0 "$TO" "$1" ""; echo "FAILED: $1"; exit 1; }
${install}
echo "installed $TO"
UNIT=pm2-${user}
if systemctl cat "$UNIT" >/dev/null 2>&1; then
  sudo -n true 2>/dev/null || sudo -n -l systemctl restart "$UNIT" >/dev/null 2>&1 || fail "installed $TO but cannot restart $UNIT: needs passwordless sudo for systemctl restart $UNIT"
  ${pm2} save || true
  status 1 "$TO" "" systemd
  echo "restarting $UNIT"
  # systemd carries out the restart even though it stops this script (same cgroup)
  sudo -n systemctl restart "$UNIT" || fail "installed $TO but systemctl restart $UNIT failed"
else
  status 1 "$TO" "" "pm2 update"
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
    const child = (deps.spawn || childProcess.spawn)('bash', [scriptFile], { detached: true, stdio: ['ignore', out, out], env: Object.assign({}, env, { RUNNER_TRACKING_ID: '' }) })
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

module.exports = { selfUpdate, reportPrevious, checkSource, script, sourceRepo, binaryAsset }
