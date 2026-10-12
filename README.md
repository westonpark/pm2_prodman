## Prodman

This is a fork of PM2 7.0.4 whose agent reports to **prodman**, a self-hosted
replacement for PM2.io / Keymetrics. The agent speaks the Keymetrics wire protocol plus a few
prodman extensions (see `prodman/docs/agent-protocol.md`).

### Linking a machine

```bash
# with bucket keys (copy them from the prodman UI)
PRODMAN_URL=http://host:3000 pm2 link <secret> <public> [machine-name]

# or interactively: prompts for the prodman URL, email and password,
# then lets you pick (or create) a bucket and links to it
pm2 plus          # aliases: pm2 login, pm2 register; `pm2 plus create` makes a new bucket

pm2 open          # opens ${PRODMAN_URL}/r/<public key>
pm2 logout        # deletes the stored CLI token
pm2 unlink        # stops the agent and forgets the link
```

### Environment variables

| Variable | Purpose |
|---|---|
| `PRODMAN_URL` | prodman base URL (default `http://localhost:8070`). Order: `PRODMAN_URL` → `KEYMETRICS_NODE` → `--info-node` → `~/.pm2/agent.json5` → default. `http://` is kept as-is; a URL without scheme gets `http://` (localhost/IP) or `https://`. |
| `KEYMETRICS_NODE` | legacy alias, still honoured |
| `PRODMAN_SYSLOG` | system log source when prodman enables `collect_syslog`: `auto` (journald → `/var/log/syslog` → `/var/log/messages`, Linux only), `journald`, `file:/path`, `off` |
| `PRODMAN_DOCKER` | Docker socket to report on when prodman enables `collect_docker`: `auto` (`DOCKER_HOST` if `unix://`, else `/var/run/docker.sock`), `unix:///path`, `off`. The PM2 user needs access to the socket (docker group) |

The CLI token from `pm2 plus` / `pm2 login` is stored in `~/.pm2/prodman-token` (mode 0600).

### Standalone binary

pm2_prodman is also released as a single executable built with `bun build --compile`, so pm2
no longer lives inside a node installation: switching or removing a node version can't leave a
service pointing at a pm2 that no longer exists, or an old pm2 shadowing the new one.

```bash
curl -fsSL https://github.com/westonpark/pm2_prodman/releases/latest/download/install.sh | sh
# → ~/.local/bin/pm2 (PM2_INSTALL_DIR to change, PM2_VERSION=8.3.0 for a given release)

# install and link to a prodman bucket in one step (PM2_MACHINE_NAME optional, PM2_RELINK=1 to move buckets)
curl -fsSL https://github.com/westonpark/pm2_prodman/releases/latest/download/install.sh \
  | PRODMAN_URL=https://prodman.example.com PM2_PUBLIC_KEY=<public> PM2_SECRET_KEY=<secret> sh
```

Then it sets the host up, and re-running it repairs one (a healthy host is left alone): on Linux it
installs and enables the `pm2-<user>` systemd service (or points an existing unit at the binary),
moves a PM2 started outside the service into it or restarts it on the new version, starts the
prodman agent if the host is linked but its agent isn't running (or links it, given the keys:
they go only to `pm2 link`, never into PM2's or the apps' environment), and removes other pm2
installations. `PM2_SETUP=0` only installs the binary.

Release assets: `pm2-linux-x64`, `pm2-linux-arm64`, `pm2-linux-x64-musl`, `pm2-linux-arm64-musl`,
`pm2-darwin-x64`, `pm2-darwin-arm64`, `pm2-windows-x64.exe`, with `SHA256SUMS`. There is no bun
build for 32-bit ARM: use npm there.

- The binary carries the npm package with its production dependencies and unpacks it once to
  `$PM2_HOME/runtime/<version>-<hash>` (the newest three are kept). The CLI runs on the embedded
  bun; the daemon, the agent and your apps run on **node** from those same files, so apps behave
  exactly as with an npm install, cluster mode included.
- node is `PM2_NODE` if set, else `node` on the PATH; pm2 stops with an error when there is none.
  Apps started with interpreter `node` also use `PM2_NODE`.
- `pm2 startup` writes the binary's path into the service (`ExecStart=/home/ubuntu/.local/bin/pm2 resurrect`)
  and the node directory into its `PATH`.
- `pm2 --binary-info` prints the version, build, platform and runtime directory as JSON.
- Self-update from prodman replaces the binary with the latest release's asset for the host
  (checked against `SHA256SUMS`) instead of running npm. `PRODMAN_BINARY_URL` points it at
  another directory of assets.
- Build locally with `bun packager/binary/build.js` (this platform), `--all`, or a list such as
  `linux-x64 linux-arm64`; output in `dist/binary`. `packager/binary/smoke.sh dist/binary/pm2-<platform>`
  tests one. `.github/workflows/binary.yml` builds, tests and publishes every platform to the
  release `v<version>` on each push to master that changes pm2.

### Changes vs upstream PM2

- Default root URL is `PRODMAN_URL` / `http://localhost:8070` instead of `root.keymetrics.io` (agent and CLI).
- `pm2 plus`, `pm2 login`, `pm2 register`, `pm2 logout` use prodman's `/api/cli/*` endpoints instead of the PM2.io OAuth flows; `@pm2/js-api` was removed.
- `pm2 open` and the `pm2 ls` footer link to `<prodman url>/r/<public key>`.
- Agent: honours `prodman.collect_logs` from `verifyPM2` (re-read every 60 s) to stream all logs continuously.
- Agent: honours `prodman.collect_syslog` and forwards the host system log (journald or a syslog file, rotation-aware, rate-capped) on the `syslog` channel (`src/push/SyslogCollector.js`).
- Agent: never gives up connecting. The startup handshake retries forever with backoff (1s → 60s) instead of exiting after ~90s, and reconnects use a single retry chain (5s → 60s, jittered). Upstream started a new chain on every status send during an outage, so attempts grew without bound and flooded `agent.log`. Stale sockets can no longer close the live connection, and a heartbeat timeout detects half-open connections.
- Agent: status carries extra process fields (`namespace`, `version`, `node_version`, `unstable_restarts`, `pm_cwd`, `instances`, `watch`, `autorestart`, real `axm_options`) and server fields (`arch`, `cpus`, `cpu_model`, `system` = daemon SysMetrics snapshot).
- Agent: remote methods `stop`, `delete`, `start`, `flush`, `reloadLogs`, `pullAndReload`, `dump`, `getLogs` (tail of the log files); `trigger:pm2:result` echoes `request_id` and serializes errors as `{ message }`; `trigger:action` falls back to the app name when no process id is given.
- Agent: `selfUpdate` lets prodman update pm2_prodman on the host (`src/reverse/AgentUpdater.js`): installs from the bucket's agent package and restarts PM2 via systemd (or `pm2 update`). `PRODMAN_UPDATE_SOURCES` allows other sources, `PRODMAN_AUTO_UPDATE=off` refuses updates.
- Agent: monitors system services chosen in prodman (nginx, PostgreSQL, Apache, MySQL, Redis, …): systemd state, CPU, memory, restarts, version and their logs (`src/push/ServiceCollector.js`).
- Agent: reports the host's Docker containers and their logs (`src/push/DockerCollector.js`, `docker:status` / `docker:logs`) when prodman's `collect_docker` is on. `PRODMAN_DOCKER` picks the socket (`auto`, `unix:///path`, `off`); the PM2 user needs access to it (the docker group).
- Built-in log rotation (`lib/LogRotate.js`), on by default, replacing the `pm2-logrotate` module. See [Log rotation](#log-rotation).
- Service guard (`lib/ServiceGuard.js`): where PM2 is installed as a systemd service, or inside a GitHub Actions runner job, `pm2` commands never start an unsupervised daemon, and `pm2 update` is refused in favour of `systemctl restart`. `PM2_SERVICE_GUARD=off` disables it.
- Cluster workers start in the app's `cwd` (as fork mode does), so `node_args` like `--import tsx` resolve from the app, not from wherever the daemon was started.
- No phone-homes: the version.pm2.io check and its `@pm2/pm2-version-check` dependency are removed, the reachability check resolves the prodman host (skipped for localhost/IPs) instead of google.com, and `pm2 serve` no longer injects the apm.pm2.io browser script.

---

<div align="center">
 <br/>

<picture>
  <source
    srcset="https://raw.githubusercontent.com/Unitech/pm2/master/pres/pm2-v4.png"
    width=710px
    media="(prefers-color-scheme: light)"
  />
  <source
    srcset="https://raw.githubusercontent.com/Unitech/pm2/master/pres/pm2-v4-dark-mode.png"
    width=710px
    media="(prefers-color-scheme: dark), (prefers-color-scheme: no-preference)"
  />
  <img src="https://raw.githubusercontent.com/Unitech/pm2/master/pres/pm2-v4.png" alt="PM2" />
</picture>

  <br/>
<br/>
<b>P</b>(rocess) <b>M</b>(anager) <b>2</b><br/>
  <i>Runtime Edition</i>
<br/><br/>


<a title="PM2 Downloads" href="https://npm-stat.com/charts.html?package=pm2">
  <img src="https://img.shields.io/npm/dm/pm2" alt="Downloads per Month"/>
</a>

<a title="PM2 Downloads" href="https://npm-stat.com/charts.html?package=pm2">
  <img src="https://img.shields.io/npm/dy/pm2" alt="Downloads per Year"/>
</a>

<a href="https://badge.fury.io/js/pm2" title="NPM Version Badge">
   <img src="https://badge.fury.io/js/pm2.svg" alt="npm version">
</a>

<br/>
<br/>
<br/>
</div>


PM2 is a production process manager for Node.js/Bun applications with a built-in load balancer. It allows you to keep applications alive forever, to reload them without downtime and to facilitate common system admin tasks.

Starting an application in production mode is as easy as:

```bash
$ pm2 start app.js
```

PM2 is battle-tested by [a comprehensive test suite](https://github.com/Unitech/pm2/actions/workflows/node.js.yml).

Official website: [https://pm2.keymetrics.io/](https://pm2.keymetrics.io/)

Works on Linux, macOS, and Windows. Supports Node.js 18+ and Bun 1+.


## Installing PM2

### With NPM

```bash
$ npm install pm2 -g
```

### With Bun

```bash
$ bun install pm2 -g
```

If you only have Bun installed (no Node.js), symlink `node` to `bun` so PM2's `#!/usr/bin/env node` shebang resolves to Bun's node-compatibility runtime:

```bash
$ sudo ln -s $(which bun) /usr/local/bin/node
```

___

You can install Node.js easily with [NVM](https://github.com/nvm-sh/nvm#installing-and-updating) or [FNM](https://github.com/Schniz/fnm) or install Bun with `curl -fsSL https://bun.sh/install | bash`

### Start an application

You can start any application (Node.js, Bun, and also Python, Ruby, binaries in $PATH...) like that:

```bash
$ pm2 start app.js
$ pm2 start app.ts
$ pm2 start app.py
```

Your app is now daemonized, monitored and kept alive forever.

### Managing Applications

Once applications are started you can manage them easily:

![Process listing](https://github.com/Unitech/pm2/raw/master/pres/pm2-ls-v2.png)

To list all running applications:

```bash
$ pm2 list
```

Managing apps is straightforward:

```bash
$ pm2 stop     <app_name|namespace|id|'all'|json_conf>
$ pm2 restart  <app_name|namespace|id|'all'|json_conf>
$ pm2 delete   <app_name|namespace|id|'all'|json_conf>
```

To have more details on a specific application:

```bash
$ pm2 describe <id|app_name>
```

To monitor logs, custom metrics, application information:

```bash
$ pm2 monit
```

[More about Process Management](https://pm2.keymetrics.io/docs/usage/process-management/)

### Cluster Mode: Node.js Load Balancing & Zero Downtime Reload

Cluster mode starts multiple Node.js processes and load-balances HTTP/TCP/UDP queries between them. This significantly increases throughput on multi-core machines and improves reliability (faster socket re-balancing in case of unhandled errors).

![Framework supported](https://raw.githubusercontent.com/Unitech/pm2/master/pres/cluster.png)

Starting a Node.js application in cluster mode that will leverage all CPUs available:

```bash
$ pm2 start api.js -i <processes>
```

`<processes>` can be `'max'`, `-1` (all cpu minus 1) or a specified number of instances to start.

**Zero Downtime Reload**

Hot Reload allows you to update an application without any downtime:

```bash
$ pm2 reload all
```

[More information about how PM2 makes clustering easy](https://pm2.keymetrics.io/docs/usage/cluster-mode/)

### Container Support

With the drop-in replacement command for `node`, called `pm2-runtime`, run your Node.js application in a hardened production environment.
Using it is seamless:

```dockerfile
RUN npm install pm2 -g
CMD [ "pm2-runtime", "npm", "--", "start" ]
```

[Read More about the dedicated integration](https://pm2.keymetrics.io/docs/usage/docker-pm2-nodejs/)

### Terminal Based Monitoring

![Monit](https://github.com/Unitech/pm2/raw/master/pres/pm2-monit.png)

Monitor all processes launched straight from the command line:

```bash
$ pm2 monit
```

### Log Management

To consult logs just type the command:

```bash
$ pm2 logs
```

Standard, Raw, JSON and formatted output are available.

Examples:

```bash
$ pm2 logs APP-NAME       # Display APP-NAME logs
$ pm2 logs --json         # JSON output
$ pm2 logs --format       # Formatted output

$ pm2 flush               # Flush all logs
$ pm2 reloadLogs          # Reload all logs
```

#### Log rotation

pm2_prodman rotates logs itself; the `pm2-logrotate` module is not needed (if it is installed,
built-in rotation pauses until you `pm2 uninstall pm2-logrotate`). It rotates every app's out,
error and combined (`log_file`) logs plus `pm2.log`, using the module's settings:

| Setting | Default | |
|---|---|---|
| `enabled` | `true` | `pm2 set pm2-logrotate:enabled false` turns rotation off |
| `max_size` | `10M` | rotate a log when it reaches this size (`K`, `M`, `G` or bytes) |
| `retain` | `10` | rotated copies to keep per log (`all` keeps every copy) |
| `compress` | `true` | gzip rotated copies |
| `dateFormat` | `YYYY-MM-DD_HH-mm-ss` | suffix of rotated files: `app-out__2026-10-10_11-01-37.log.gz` |
| `TZ` | local time | time zone for the suffix, e.g. `Europe/London` |
| `workerInterval` | `30` | seconds between size checks |
| `rotateInterval` | `0 0 * * *` | cron schedule that rotates every non-empty log regardless of size |
| `rotateModule` | `true` | also rotate the logs of PM2 modules |

```bash
$ pm2 set pm2-logrotate:max_size 50M    # applies within one check interval, no restart needed
$ pm2 conf pm2-logrotate                # show the current settings
```

How it differs from the module: app logs are renamed and the apps' log streams reopened rather
than copied and truncated, so rotation is instant at any size and loses no lines (only `pm2.log`
is copied). A log is never rotated again while its previous rotation is still in progress, and
compression runs one file at a time, so a first rotation of multi-GB logs can't snowball and fill
the disk. `compress true` works (the module ignored it), and copies left uncompressed by a
restart are compressed when the daemon starts.

[More about log management](https://pm2.keymetrics.io/docs/usage/log-management/)

### Startup Scripts Generation

PM2 can generate and configure a Startup Script to keep PM2 and your processes alive at every server restart.

Init Systems Supported: **systemd**, **upstart**, **systemv**, **openrc**, **launchd**, **rcd**, **rcd-openbsd**, **smf**

```bash
# Generate Startup Script
$ pm2 startup

# Freeze your process list across server restart
$ pm2 save

# Remove Startup Script
$ pm2 unstartup
```

[More about Startup Scripts Generation](https://pm2.keymetrics.io/docs/usage/startup/)

### Updating PM2

```bash
# Install latest PM2 version
$ npm install pm2@latest -g
# Save process list, exit old PM2 & restore all processes
$ pm2 update
```

*PM2 updates are seamless*

## PM2+ Monitoring

If you manage your apps with PM2, PM2+ makes it easy to monitor and manage apps across servers.

![https://app.pm2.io/](https://pm2.io/img/app-overview.png)

Feel free to try it:

[Discover the monitoring dashboard for PM2](https://app.pm2.io/)

Thanks in advance and we hope that you like PM2!

## CHANGELOG

[CHANGELOG](https://github.com/Unitech/pm2/blob/master/CHANGELOG.md)

## Contributors

[Contributors](https://pm2.keymetrics.io/hall-of-fame/)

## License

PM2 is made available under the terms of the GNU Affero General Public License 3.0 (AGPL 3.0).
For other licenses [contact us](mailto:contact@keymetrics.io).
