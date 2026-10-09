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
| `PM2_ENABLE_VERSION_CHECK=true` | opt back in to the daily version check against version.pm2.io (off by default) |

The CLI token from `pm2 plus` / `pm2 login` is stored in `~/.pm2/prodman-token` (mode 0600).

### Changes vs upstream PM2

- Default root URL is `PRODMAN_URL` / `http://localhost:8070` instead of `root.keymetrics.io` (agent and CLI).
- `pm2 plus`, `pm2 login`, `pm2 register`, `pm2 logout` use prodman's `/api/cli/*` endpoints instead of the PM2.io OAuth flows; `@pm2/js-api` was removed.
- `pm2 open` and the `pm2 ls` footer link to `<prodman url>/r/<public key>`.
- Agent: honours `prodman.collect_logs` from `verifyPM2` (re-read every 60 s) to stream all logs continuously.
- Agent: status carries extra process fields (`namespace`, `version`, `node_version`, `unstable_restarts`, `pm_cwd`, `instances`, `watch`, `autorestart`, real `axm_options`) and server fields (`arch`, `cpus`, `cpu_model`, `system` = daemon SysMetrics snapshot).
- Agent: remote methods `stop`, `delete`, `start`, `flush`, `reloadLogs`, `pullAndReload`, `dump`, `getLogs` (tail of the log files); `trigger:pm2:result` echoes `request_id` and serializes errors as `{ message }`; `trigger:action` falls back to the app name when no process id is given.
- No phone-homes: the version check is opt-in, the reachability check resolves the prodman host (skipped for localhost/IPs) instead of google.com, and `pm2 serve` no longer injects the apm.pm2.io browser script.

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

To enable log rotation install the following module

```bash
$ pm2 install pm2-logrotate
```

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
