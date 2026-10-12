#!/usr/bin/env bash
# prodman: smoke test of a standalone pm2 binary (run by .github/workflows/binary.yml)
#   packager/binary/smoke.sh dist/binary/pm2-linux-x64
# Starts a fork and a cluster app on node, checks they serve, saves, kills, resurrects, kills.
set -euo pipefail

BIN=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
WORK=$(mktemp -d /tmp/pm2s.XXXXXX)   # short: PM2_HOME holds unix sockets
export PM2_HOME=$WORK/h PM2_SERVICE_GUARD=off
trap '"$BIN" kill >/dev/null 2>&1 || true; rm -rf "$WORK"' EXIT

cat > "$WORK/app.js" <<'EOF'
require('http').createServer((q, r) => r.end('ok ' + process.version)).listen(process.env.PORT)
EOF

fetch () { node -e 'fetch("http://127.0.0.1:" + process.argv[1]).then(r => r.text()).then(t => console.log(t), e => { console.error(e.message); process.exit(1) })' "$1"; }
check () { # wait for both apps to answer
  for i in $(seq 1 20); do
    if fetch 4801 >/dev/null 2>&1 && fetch 4802 >/dev/null 2>&1; then echo "  fork: $(fetch 4801), cluster: $(fetch 4802)"; return 0; fi
    sleep 0.5
  done
  echo "apps do not answer"; cat "$PM2_HOME/pm2.log"; exit 1
}

echo "binary: $("$BIN" --binary-info)"
cd "$WORK"
PORT=4801 "$BIN" start app.js --name fork >/dev/null
PORT=4802 "$BIN" start app.js --name cluster -i 2 >/dev/null
check
"$BIN" jlist | node -e '
  const list = JSON.parse(require("fs").readFileSync(0, "utf8"))
  for (const p of list) console.log("  %s %s %s %s", p.name, p.pm2_env.exec_mode, p.pm2_env.status, p.pm2_env.exec_interpreter)
  if (list.length !== 3 || list.some(p => p.pm2_env.status !== "online")) process.exit(1)'
"$BIN" save >/dev/null
"$BIN" kill >/dev/null
"$BIN" resurrect >/dev/null
check
"$BIN" kill >/dev/null
echo "smoke test passed"
