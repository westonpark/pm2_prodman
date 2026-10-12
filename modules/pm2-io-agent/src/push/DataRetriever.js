'use strict'

const os = require('os')
const pkg = require('../../../../package.json')
const constants = require('../../constants')
const RuntimeInspector = require('./RuntimeInspector')
const Supervisor = require('./Supervisor')
const hostname = os.hostname()
const platform = os.platform()
const arch = os.arch()
const username = process.env.SUDO_USER || process.env.C9_USER || process.env.LOGNAME ||
      process.env.USER || process.env.LNAME || process.env.USERNAME

// cpu count / model don't change during the agent lifetime: compute once
let cpuCount = 0
let cpuModel = null
try {
  const cpus = os.cpus() || []
  cpuCount = cpus.length
  cpuModel = cpus.length > 0 ? cpus[0].model : null
} catch (e) {}

const AXM_OPTIONS_MAX_SIZE = 8 * 1024

// prodman: language runtime / interpreter details per process (cached version probes)
const runtimeInspector = new RuntimeInspector()

/**
 * Return a JSON-safe copy of axm_options, or {} if it is missing,
 * not serializable or unexpectedly large.
 * @param {Object} axmOptions
 * @return {Object}
 */
const safeAxmOptions = (axmOptions) => {
  if (!axmOptions || typeof axmOptions !== 'object') return {}
  try {
    const str = JSON.stringify(axmOptions)
    if (!str || str.length > AXM_OPTIONS_MAX_SIZE) return {}
    return JSON.parse(str)
  } catch (e) {
    return {}
  }
}

function supervised () {
  const s = Supervisor.supervisor(constants.PM2_HOME)
  return { pm2_supervisor: s ? s.supervisor : null, pm2_service: s ? s.service : null }
}

module.exports = class DataRetriever {
  /**
   * Normalize each process metdata
   * @param {Object} processes process list extracted from pm2 daemon
   * @param {Object} conf interactor configuration
   * @param {Object} [extra] additional data
   * @param {Object} [extra.system] SysMetrics snapshot of the pm2 daemon
   */
  static status (processes, conf, extra) {
    processes = processes || []
    extra = extra || {}
    const formattedProcs = processes
          .filter(proc => !proc.pm2_env.name.match(/_old_/))
          .map((proc) => {
            const env = proc.pm2_env
            const monit = proc.monit || {}

            return {
              pid: proc.pid,
              name: env.name,
              interpreter: env.exec_interpreter,
              args: env.node_args,
              path: env.pm_exec_path,
              restart_time: env.restart_time,
              created_at: env.created_at,
              exec_mode: env.exec_mode,
              pm_uptime: env.pm_uptime,
              status: env.status,
              pm_id: env.pm_id,
              unique_id: env.unique_id,

              cpu: Math.floor(monit.cpu) || 0,
              memory: Math.floor(monit.memory) || 0,

              versioning: env.versioning || null,

              node_env: env.NODE_ENV || null,

              axm_actions: env.axm_actions || [],
              axm_monitor: env.axm_monitor || {},
              axm_options: safeAxmOptions(env.axm_options),
              axm_dynamic: env.dynamic || {},

              // prodman extensions
              namespace: env.namespace !== undefined ? env.namespace : null,
              version: env.version !== undefined ? env.version : null,
              node_version: env.node_version !== undefined ? env.node_version : null,
              unstable_restarts: env.unstable_restarts || 0,
              pm_cwd: env.pm_cwd !== undefined ? env.pm_cwd : null,
              instances: env.instances !== undefined ? env.instances : null,
              watch: env.watch !== undefined ? env.watch : false,
              autorestart: env.autorestart !== undefined ? env.autorestart : true,
              runtime: runtimeInspector.describe(env)
            }
          })

    return {
      process: formattedProcs,
      server: {
        username: username,
        hostname: hostname,
        uptime: os.uptime(),
        platform: platform,
        pm2_version: conf.PM2_VERSION,
        pm2_agent_version: pkg.version,
        node_version: process.version,
        // prodman: how pm2 is installed: the standalone binary (CLI on bun, see packager/binary) or npm
        pm2_install: process.env.PM2_BINARY ? 'binary' : 'npm',
        pm2_bun_version: process.env.PM2_BINARY ? (process.env.PM2_BUN_VERSION || null) : null,
        // prodman: 'systemd' (with the unit) when the daemon runs as a systemd service, 'none' when
        // not, null when unknown (not Linux)
        ...supervised(),
        unique_id: constants.UNIQUE_SERVER_ID,
        loadavg: os.loadavg(),
        total_mem: os.totalmem(),
        type: os.type(),
        // prodman extensions
        arch: arch,
        cpus: cpuCount,
        cpu_model: cpuModel,
        system: (extra.system && typeof extra.system === 'object') ? extra.system : {}
      }
    }
  }
}
