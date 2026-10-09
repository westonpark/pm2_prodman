'use strict'

const log = require('debug')('interactor:pm2:interface')
const path = require('path')
const async = require('async')
const fs = require('fs')
const cst = require('../constants')
const childProcess = require('child_process')

const GET_LOGS_DEFAULT_LINES = 200
const GET_LOGS_MAX_LINES = 5000
const TAIL_CHUNK_SIZE = 64 * 1024
const TAIL_MAX_BYTES = 16 * 1024 * 1024
const PULL_TIMEOUT = 5 * 60 * 1000

/**
 * Read the last `lines` lines of a file, reading backwards from the end
 * by chunks (never loads the whole file).
 * @param {String} filePath
 * @param {Number} lines
 * @param {Function} cb invoked with <err, String>
 */
const tailFile = (filePath, lines, cb) => {
  if (!filePath || lines <= 0) return cb(null, '')
  fs.open(filePath, 'r', (err, fd) => {
    if (err) return cb(err.code === 'ENOENT' ? null : err, '')
    const done = (err, res) => fs.close(fd, () => cb(err, res))
    fs.fstat(fd, (err, stat) => {
      if (err) return done(err)
      let position = stat.size
      let chunks = []
      let newlines = 0
      let bytesRead = 0
      // a trailing newline terminates the last line, it doesn't start a new one
      let skipTrailing = true

      const readChunk = () => {
        if (position <= 0 || newlines > lines || bytesRead >= TAIL_MAX_BYTES) return finish()
        const size = Math.min(TAIL_CHUNK_SIZE, position)
        position -= size
        const buf = Buffer.alloc(size)
        fs.read(fd, buf, 0, size, position, (err, n) => {
          if (err) return done(err)
          bytesRead += n
          for (let i = n - 1; i >= 0; i--) {
            if (buf[i] === 0x0a) {
              if (skipTrailing && position + i === stat.size - 1) continue
              newlines++
            }
          }
          skipTrailing = false
          chunks.unshift(buf.slice(0, n))
          return readChunk()
        })
      }

      const finish = () => {
        let content = Buffer.concat(chunks).toString('utf8')
        if (content.endsWith('\n')) content = content.slice(0, -1)
        if (content.endsWith('\r')) content = content.slice(0, -1)
        let arr = content.split('\n')
        if (arr.length > lines) arr = arr.slice(arr.length - lines)
        return done(null, arr.join('\n'))
      }

      return readChunk()
    })
  })
}

module.exports = class PM2Interface {
  constructor (rpc) {
    log('PM2Interface instantiate')
    this.rpc = rpc
  }

  getProcessByName (name, cb) {
    var foundProc = []

    this.rpc.getMonitorData({}, (err, list) => {
      if (err) {
        log('Error retrieving process list: ' + err)
        return cb(err)
      }

      list.forEach((proc) => {
        if (proc.pm2_env.name === name || proc.pm2_env.pm_exec_path === path.resolve(name.toString())) {
          foundProc.push(proc)
        }
      })

      return cb(null, foundProc)
    })
  }

  /**
   * Scale up/down a process
   * @method scale
   */
  scale (opts, cb) {
    const self = this
    const appName = opts.name
    let number = opts.number

    function addProcs (proc, value, cb) {
      (function ex (proc, number) {
        if (number-- === 0) return cb()
        log('Scaling up application')
        self.rpc.duplicateProcessId(proc.pm2_env.pm_id, ex.bind(this, proc, number))
      })(proc, number)
    }

    function rmProcs (procs, value, cb) {
      let i = 0;

      (function ex (procs, number) {
        if (number++ === 0) return cb()
        self.rpc.deleteProcessId(procs[i++].pm2_env.pm_id, ex.bind(this, procs, number))
      })(procs, number)
    }

    let end = () => {
      return cb ? cb(null, {success: true}) : log('Successfuly scale')
    }

    this.getProcessByName(appName, (err, procs) => {
      if (err) {
        return cb ? cb(err) : log(err)
      }

      if (!procs || procs.length === 0) {
        log('Application %s not found', appName)
        return cb ? cb(new Error('App not found')) : log('App not found')
      }

      let procNumber = procs.length

      if (typeof (number) === 'string' && number.indexOf('+') >= 0) {
        number = parseInt(number, 10)
        return addProcs(procs[0], number, end)
      } else if (typeof (number) === 'string' && number.indexOf('-') >= 0) {
        number = parseInt(number, 10)
        return rmProcs(procs, number, end)
      } else {
        number = parseInt(number, 10)
        number = number - procNumber

        if (number < 0) {
          return rmProcs(procs, number, end)
        } else if (number > 0) {
          return addProcs(procs[0], number, end)
        } else {
          log('Nothing to do')
          return cb ? cb(new Error('Same process number')) : log('Same process number')
        }
      }
    })
  }

  /**
   * Dump current processes managed by pm2 into DUMP_FILE_PATH file
   * @method dump
   * @param {} cb
   * @return
   */
  dump (params, cb) {
    if (typeof params === 'function') {
      cb = params
      params = {}
    }
    var envArr = []

    this.rpc.getMonitorData({}, (err, list) => {
      if (err) {
        return typeof cb === 'function' ? cb(err) : false
      }

      /**
       * Description
       * @method end
       * @param {} err
       * @return
       */
      const end = () => {
        // Overwrite dump file, delete if broken and exit
        try {
          fs.writeFileSync(cst.DUMP_FILE_PATH, JSON.stringify(envArr, '', 2))
        } catch (e) {
          log('Dump error', e.stack || e)
          return cb(e)
        }
        return (cb) ? cb(null, {success: true}) : true
      }

      async.each(list, (app, done) => {
        delete app.pm2_env.instances
        delete app.pm2_env.pm_id
        if (!app.pm2_env.pmx_module) {
          envArr.push(app.pm2_env)
        }
        done()
      }, end)
    })
  }

  _callWithProcessId (fn, params, cb) {
    if (params.id === undefined) {
      this.getProcessByName(params.name, (err, processes) => {
        if (err) return cb(err)

        // in case we don't find the process ourselves
        // we believe pm2 will find it
        if (processes.length === 0) {
          return fn(Object.assign({ id: params.name }, params), cb)
        }

        async.eachOf(processes, (process, _key, localCb) => {
          params.id = process.pm_id
          fn(params, localCb)
        }, cb)
      })
    } else {
      fn(params, cb)
    }
  }

  restart (params, cb) {
    this._callWithProcessId(this.rpc.restartProcessId, params, cb)
  }

  reload (params, cb) {
    this._callWithProcessId(this.rpc.reloadProcessId, params, cb)
  }

  reset (params, cb) {
    this._callWithProcessId(
      (newParams, cb) => this.rpc.resetMetaProcessId(newParams.id, cb),
      params,
      cb
    )
  }

  ping (params, cb) {
    this._callWithProcessId(this.rpc.ping, params, cb)
  }

  // ---------------------------------------------------------------------------
  // prodman extensions
  // ---------------------------------------------------------------------------

  /**
   * Resolve processes matching params.id / params.name ('all' or nothing = every process)
   * @param {Object} params
   * @param {Function} cb invoked with <err, Array<proc>>
   */
  _resolveProcesses (params, cb) {
    params = params || {}
    this.rpc.getMonitorData({}, (err, list) => {
      if (err) return cb(err)
      list = (list || []).filter(proc => proc && proc.pm2_env &&
        !(typeof proc.pm2_env.pm_id === 'string' && proc.pm2_env.pm_id.indexOf('_old_') > -1))

      const target = params.id !== undefined && params.id !== null ? params.id : params.name
      if (target === undefined || target === null || target === 'all') return cb(null, list)

      const found = list.filter(proc => {
        const pmId = proc.pm_id !== undefined ? proc.pm_id : proc.pm2_env.pm_id
        return String(pmId) === String(target) || proc.pm2_env.name === target ||
          proc.name === target
      })
      if (found.length === 0) return cb(new Error(`Process ${target} not found`))
      return cb(null, found)
    })
  }

  /**
   * Run fn(pm_id, cb) on each process matching params, collect results
   */
  _eachProcess (params, fn, cb) {
    this._resolveProcesses(params, (err, procs) => {
      if (err) return cb(err)
      const results = []
      async.eachSeries(procs, (proc, next) => {
        const pmId = proc.pm_id !== undefined ? proc.pm_id : proc.pm2_env.pm_id
        fn(pmId, proc, (err, res) => {
          if (err) return next(err)
          results.push(res)
          return next()
        })
      }, (err) => cb(err || null, results))
    })
  }

  _requireTarget (params, cb) {
    if (!params || ((params.id === undefined || params.id === null) && (params.name === undefined || params.name === null))) {
      cb(new Error('Missing process id or name'))
      return false
    }
    return true
  }

  stop (params, cb) {
    if (!this._requireTarget(params, cb)) return
    this._eachProcess(params, (id, proc, next) => this.rpc.stopProcessId(id, next), (err, res) => {
      return err ? cb(err) : cb(null, { success: true, processes: res.length })
    })
  }

  delete (params, cb) {
    if (!this._requireTarget(params, cb)) return
    this._eachProcess(params, (id, proc, next) => this.rpc.deleteProcessId(id, next), (err, res) => {
      return err ? cb(err) : cb(null, { success: true, processes: res.length })
    })
  }

  /**
   * Start (= restart) a stopped / errored process by id or name.
   * Processes already online are left untouched.
   */
  start (params, cb) {
    if (!this._requireTarget(params, cb)) return
    let started = 0
    this._eachProcess(params, (id, proc, next) => {
      const status = proc.pm2_env.status
      if (status === 'online' || status === 'launching') return next(null, false)
      started++
      return this.rpc.restartProcessId({ id: id }, next)
    }, (err, res) => {
      return err ? cb(err) : cb(null, { success: true, processes: res.length, started: started })
    })
  }

  /**
   * Truncate the log files of the matching processes (all if no id/name)
   */
  flush (params, cb) {
    this._eachProcess(params, (id, proc, next) => {
      const env = proc.pm2_env
      const files = [env.pm_out_log_path, env.pm_err_log_path, env.pm_log_path]
        .filter(f => typeof f === 'string' && f.length > 0 && f !== '/dev/null' && f !== 'NULL')
      async.each(files, (file, done) => {
        fs.truncate(file, 0, (err) => done(err && err.code !== 'ENOENT' ? err : null))
      }, next)
    }, (err, res) => {
      return err ? cb(err) : cb(null, { success: true, processes: res.length })
    })
  }

  reloadLogs (params, cb) {
    if (typeof params === 'function') {
      cb = params
      params = {}
    }
    this.rpc.reloadLogs({}, (err) => {
      return err ? cb(err) : cb(null, { success: true })
    })
  }

  /**
   * git pull the process repository, run post_update commands and reload,
   * by delegating to the pm2 CLI (`pm2 pull <name>`)
   */
  pullAndReload (params, cb) {
    if (!this._requireTarget(params, cb)) return
    const target = params.name !== undefined && params.name !== null ? params.name : params.id
    // always use the CLI of the pm2 install this agent belongs to (PM2_BINARY_PATH may be a user script)
    const pm2Bin = path.resolve(__dirname, '../../../bin/pm2')
    childProcess.execFile(process.execPath, [pm2Bin, 'pull', String(target)], {
      env: process.env,
      timeout: PULL_TIMEOUT,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true
    }, (err, stdout, stderr) => {
      // strip ANSI color codes from the CLI output
      const output = `${stdout || ''}${stderr || ''}`.replace(/\u001b\[[0-9;]*m/g, '')
      if (err) return cb(new Error(`pm2 pull ${target} failed: ${output.trim() || err.message}`))
      return cb(null, { success: true, output: output })
    })
  }

  /**
   * Tail the out/err log files of the matching processes
   * @param {Object} params { id|name, lines = 200 (max 5000), type = 'out'|'err'|'both' }
   * @param {Function} cb invoked with <err, [{ pm_id, name, out, err }]>
   */
  getLogs (params, cb) {
    params = params || {}
    let lines = parseInt(params.lines, 10)
    if (isNaN(lines) || lines <= 0) lines = GET_LOGS_DEFAULT_LINES
    lines = Math.min(lines, GET_LOGS_MAX_LINES)
    const type = ['out', 'err', 'both'].indexOf(params.type) > -1 ? params.type : 'both'

    this._eachProcess(params, (id, proc, next) => {
      const env = proc.pm2_env
      const result = { pm_id: id, name: env.name, out: '', err: '' }
      const targets = []
      if (type === 'out' || type === 'both') targets.push(['out', env.pm_out_log_path])
      if (type === 'err' || type === 'both') targets.push(['err', env.pm_err_log_path])
      async.each(targets, (t, done) => {
        tailFile(t[1], lines, (err, content) => {
          if (err) return done(err)
          result[t[0]] = content
          return done()
        })
      }, (err) => next(err, result))
    }, cb)
  }
}

module.exports.tailFile = tailFile
