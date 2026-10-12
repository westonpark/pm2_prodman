'use strict'

/**
 * prodman: is the PM2 daemon supervised by systemd? Read from the daemon's cgroup (Linux): a
 * daemon started by its service sits in system.slice/<unit>.service; one started from a shell or
 * a CI job sits in a session scope or the runner's unit, where nothing restarts it after a crash
 * or reboot, and self-updates can't hand it over.
 *
 *   { supervisor: 'systemd', service: 'pm2-ubuntu.service' }  run by a systemd service
 *   { supervisor: 'none', service: null }                     outside any service
 *   null                                                      not Linux/systemd, or no daemon
 */

const fs = require('fs')
const path = require('path')

const CACHE_MS = 60 * 1000

function detect (pm2Home, procRoot) {
  procRoot = procRoot || '/proc'
  let pid
  try { pid = parseInt(fs.readFileSync(path.join(pm2Home, 'pm2.pid'), 'utf8'), 10) } catch (e) { return null }
  if (!pid) return null
  let cgroup
  try { cgroup = fs.readFileSync(path.join(procRoot, String(pid), 'cgroup'), 'utf8') } catch (e) { return null }
  // cgroup v2: "0::/system.slice/pm2-ubuntu.service"; v1: "1:name=systemd:/system.slice/…"
  const line = cgroup.split('\n').find(l => l.startsWith('0::')) || cgroup.split('\n').find(l => l.includes('name=systemd')) || ''
  const unit = line.slice(line.lastIndexOf(':') + 1)
  // (inside a container the path is prefixed, e.g. /docker/<id>/system.slice/…)
  const m = /(?:^|\/)system\.slice\/(?:.*\/)?([^/]+\.service)$/.exec(unit)
  // a CI runner (actions.runner.*.service) or other service is not PM2's own service
  if (m && !/^actions\.runner\./.test(m[1])) return { supervisor: 'systemd', service: m[1] }
  return { supervisor: 'none', service: null }
}

let cache = { at: 0, value: null }

/** the daemon's supervisor, cached for a minute */
function supervisor (pm2Home, opts) {
  opts = opts || {}
  if ((opts.platform || process.platform) !== 'linux') return null
  const now = Date.now()
  if (!opts.fresh && now - cache.at < CACHE_MS) return cache.value
  cache = { at: now, value: detect(pm2Home, opts.procRoot) }
  return cache.value
}

module.exports = { supervisor, detect }
