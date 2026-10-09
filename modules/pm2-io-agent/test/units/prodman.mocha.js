/* eslint-env mocha */

'use strict'

/**
 * Tests for the prodman extensions of the agent
 */

process.env.NODE_ENV = 'test'

process.env.PM2_MACHINE_NAME = 'test'
process.env.PM2_PUBLIC_KEY = 'g94c9opeq5i4f6j'
process.env.PM2_SECRET_KEY = 'ydz2i1lbkccm7g2'

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const cst = require('../../constants')
const PM2Interface = require('../../src/PM2Interface')
const PushInteractor = require('../../src/push/PushInteractor')
const ReverseInteractor = require('../../src/reverse/ReverseInteractor')
const DataRetriever = require('../../src/push/DataRetriever')
const WebsocketTransport = require('../../src/transporters/WebsocketTransport')

const useDaemon = (cb) => {
  const modPath = require.resolve('../../src/InteractorDaemon')
  delete require.cache[modPath]
  const Daemon = require(modPath)
  const daemon = new Daemon()
  cb(daemon, _ => {
    daemon.transport.transporters.forEach(transport => {
      clearInterval(transport._worker)
      clearInterval(transport._heartbeater)
    })
    if (daemon._sigusr1Handler) process.removeListener('SIGUSR1', daemon._sigusr1Handler)
    if (daemon._sigusr2Handler) process.removeListener('SIGUSR2', daemon._sigusr2Handler)
  })
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm2-prodman-test-'))
const writeLines = (name, count, prefix) => {
  const file = path.join(tmpDir, name)
  let content = ''
  for (let i = 1; i <= count; i++) content += `${prefix} line ${i}\n`
  fs.writeFileSync(file, content)
  return file
}

describe('Prodman extensions', () => {
  after(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    } catch (e) {}
  })

  describe('constants', _ => {
    it('should normalize root urls without forcing https', () => {
      assert.strictEqual(cst.normalizeRootUrl('http://host:8070/'), 'http://host:8070')
      assert.strictEqual(cst.normalizeRootUrl('https://prodman.example.com'), 'https://prodman.example.com')
      assert.strictEqual(cst.normalizeRootUrl('localhost:8070'), 'http://localhost:8070')
      assert.strictEqual(cst.normalizeRootUrl('10.0.0.2:8070'), 'http://10.0.0.2:8070')
      assert.strictEqual(cst.normalizeRootUrl('prodman.example.com'), 'https://prodman.example.com')
      assert.strictEqual(cst.DEFAULT_ROOT_URL, 'http://localhost:8070')
    })
  })

  describe('verifyPM2 prodman.collect_logs', _ => {
    it('should enable then disable continuous log collection on re-poll', (done) => {
      useDaemon((daemon, cleanup) => {
        let response = {
          active: true,
          pending: false,
          disabled: false,
          endpoints: { ws: 'ws://localhost:8070/agent/ws' },
          prodman: { version: 1, collect_logs: true }
        }
        daemon._pingRoot = (cb) => cb(null, response)
        daemon.transport = {
          connect: (endpoints, next) => next(),
          transporters: daemon.transport.transporters
        }
        assert.strictEqual(daemon.opts.PRODMAN_COLLECT_LOGS, false)
        daemon._verifyEndpoint((err) => {
          assert(!err)
          assert.strictEqual(daemon.opts.PRODMAN_COLLECT_LOGS, true)
          response = Object.assign({}, response, { prodman: { version: 1, collect_logs: false } })
          daemon._verifyEndpoint((err) => {
            assert(!err)
            assert.strictEqual(daemon.opts.PRODMAN_COLLECT_LOGS, false)
            // missing prodman object (stock backend) => stock behaviour
            response = Object.assign({}, response)
            delete response.prodman
            daemon._verifyEndpoint(() => {
              assert.strictEqual(daemon.opts.PRODMAN_COLLECT_LOGS, false)
              cleanup()
              done()
            })
          })
        })
      })
    })

    it('should allow the prodman remote methods', (done) => {
      useDaemon((daemon, cleanup) => {
        ['stop', 'delete', 'start', 'flush', 'reloadLogs', 'pullAndReload', 'dump', 'getLogs'].forEach(method => {
          assert(daemon.opts.PM2_REMOTE_METHOD_ALLOWED.indexOf(method) > -1, method)
        })
        cleanup()
        done()
      })
    })

    it('should forward logs when collect_logs is on, without startLogging', () => {
      global._logs = false
      const sent = []
      const opts = { MACHINE_NAME: 'machine', PRODMAN_COLLECT_LOGS: true }
      const push = new PushInteractor(opts, { bus: { on: _ => {} } }, {
        send: (channel, packet) => sent.push({ channel, packet })
      })
      clearInterval(push._cacheFS._worker)
      push.processes.set('app', { name: 'app' })
      const packet = () => ({ process: { pm_id: 0, name: 'app' }, data: 'hello\n', at: Date.now() })

      push._onPM2Event('log:out', packet())
      assert.strictEqual(sent.length, 1)
      assert.strictEqual(sent[0].channel, 'logs')
      assert.strictEqual(sent[0].packet.log_type, 'out')

      opts.PRODMAN_COLLECT_LOGS = false
      push._onPM2Event('log:err', packet())
      assert.strictEqual(sent.length, 1, 'stock behaviour: no logs without startLogging')
    })
  })

  describe('trigger:pm2:result', _ => {
    const allowed = ['restart', 'getLogs', 'startLogging']

    it('should echo request_id and serialize errors as {message}', (done) => {
      const reverse = new ReverseInteractor({
        MACHINE_NAME: 'machine',
        PUBLIC_KEY: 'public',
        PM2_REMOTE_METHOD_ALLOWED: allowed
      }, {
        remote: (method, params, cb) => cb(new Error('boom'))
      }, {
        send: (event, data) => {
          assert.strictEqual(event, 'trigger:pm2:result')
          assert.deepStrictEqual(data.ret.err, { message: 'boom' })
          assert.strictEqual(JSON.parse(JSON.stringify(data)).ret.err.message, 'boom')
          assert.strictEqual(data.meta.request_id, 'req-42')
          assert.strictEqual(data.meta.method_name, 'restart')
          assert.strictEqual(data.meta.app_name, 'app')
          done()
        }
      })
      reverse._onPM2Action({ method_name: 'restart', parameters: { name: 'app', request_id: 'req-42' } })
    })

    it('should echo request_id on success and on refused methods', (done) => {
      const results = []
      const reverse = new ReverseInteractor({
        MACHINE_NAME: 'machine',
        PUBLIC_KEY: 'public',
        PM2_REMOTE_METHOD_ALLOWED: allowed
      }, {
        remote: (method, params, cb) => cb(null, [{ pm_id: 0 }])
      }, {
        send: (event, data) => {
          results.push(data)
          if (results.length < 2) return
          assert.strictEqual(results[0].ret.err, null)
          assert.strictEqual(results[0].meta.request_id, 'a')
          assert.deepStrictEqual(results[1].ret.err, { message: 'Method not allowed' })
          assert.strictEqual(results[1].meta.request_id, 'b')
          done()
        }
      })
      reverse._onPM2Action({ method_name: 'getLogs', parameters: { id: 0, request_id: 'a' } })
      reverse._onPM2Action({ method_name: 'killEverything', parameters: { request_id: 'b' } })
    })

    it('should not crash when parameters are missing', (done) => {
      const reverse = new ReverseInteractor({
        MACHINE_NAME: 'machine',
        PUBLIC_KEY: 'public',
        PM2_REMOTE_METHOD_ALLOWED: allowed
      }, {
        remote: (method, params, cb) => cb(null, 'ok')
      }, {
        send: (event, data) => {
          assert.strictEqual(data.ret.data, 'ok')
          assert.strictEqual(data.meta.request_id, undefined)
          done()
        }
      })
      reverse._onPM2Action({ method_name: 'restart' })
    })
  })

  describe('trigger:action without process_id', _ => {
    it('should target the app by name instead of crashing', (done) => {
      const reverse = new ReverseInteractor('opts', {
        msgProcess: (data, cb) => {
          assert(!('id' in data), 'no id key so pm2 resolves by name')
          assert.strictEqual(data.name, 'my-app')
          assert.strictEqual(data.msg, 'km:heapdump')
          cb(null, { success: true })
        }
      }, {
        send: (name, data) => {
          assert.strictEqual(name, 'trigger:action:success')
          done()
        }
      })
      reverse._onCustomAction({ action_name: 'km:heapdump', app_name: 'my-app' })
    })

    it('should send a failure when neither process_id nor app_name is given', (done) => {
      const reverse = new ReverseInteractor('opts', {
        msgProcess: () => assert.fail('should not be called')
      }, {
        send: (name, data) => {
          assert.strictEqual(name, 'trigger:action:failure')
          assert.strictEqual(data.success, false)
          done()
        }
      })
      reverse._onCustomAction({ action_name: 'test' })
    })
  })

  describe('PM2Interface prodman methods', _ => {
    const outFile = writeLines('app-out.log', 300, 'out')
    const errFile = writeLines('app-err.log', 3, 'err')
    const list = [
      { pm_id: 0, name: 'app', pm2_env: { pm_id: 0, name: 'app', status: 'online', pm_out_log_path: outFile, pm_err_log_path: errFile } },
      { pm_id: 1, name: 'other', pm2_env: { pm_id: 1, name: 'other', status: 'stopped', pm_out_log_path: path.join(tmpDir, 'missing.log'), pm_err_log_path: path.join(tmpDir, 'missing-err.log') } }
    ]
    const makeInterface = (rpc) => new PM2Interface(Object.assign({
      getMonitorData: (opts, cb) => cb(null, JSON.parse(JSON.stringify(list)))
    }, rpc || {}))

    it('getLogs should tail the last 200 lines by default', (done) => {
      makeInterface().getLogs({ name: 'app' }, (err, res) => {
        assert(!err)
        assert.strictEqual(res.length, 1)
        assert.strictEqual(res[0].pm_id, 0)
        assert.strictEqual(res[0].name, 'app')
        const lines = res[0].out.split('\n')
        assert.strictEqual(lines.length, 200)
        assert.strictEqual(lines[0], 'out line 101')
        assert.strictEqual(lines[199], 'out line 300')
        assert.strictEqual(res[0].err, 'err line 1\nerr line 2\nerr line 3')
        done()
      })
    })

    it('getLogs should honour lines, type and id', (done) => {
      makeInterface().getLogs({ id: 0, lines: 2, type: 'out' }, (err, res) => {
        assert(!err)
        assert.strictEqual(res[0].out, 'out line 299\nout line 300')
        assert.strictEqual(res[0].err, '')
        done()
      })
    })

    it('getLogs should return empty strings for missing files', (done) => {
      makeInterface().getLogs({ name: 'other' }, (err, res) => {
        assert(!err)
        assert.strictEqual(res[0].out, '')
        assert.strictEqual(res[0].err, '')
        done()
      })
    })

    it('getLogs should fail for unknown process', (done) => {
      makeInterface().getLogs({ name: 'nope' }, (err) => {
        assert(err instanceof Error)
        done()
      })
    })

    it('tailFile should read large files from the end and cap lines', (done) => {
      // ~20000 lines of ~60 bytes => > 1MB, several 64KB chunks
      const file = path.join(tmpDir, 'big.log')
      let content = ''
      for (let i = 1; i <= 20000; i++) content += `big line ${i} ${'x'.repeat(48)}\n`
      fs.writeFileSync(file, content)
      PM2Interface.tailFile(file, 5000, (err, out) => {
        assert(!err)
        const lines = out.split('\n')
        assert.strictEqual(lines.length, 5000)
        assert(lines[0].startsWith('big line 15001 '))
        assert(lines[4999].startsWith('big line 20000 '))
        makeInterface().getLogs({ name: 'app', lines: 999999 }, (err, res) => {
          assert(!err)
          assert.strictEqual(res[0].out.split('\n').length, 300, 'capped at 5000, file only has 300')
          done()
        })
      })
    })

    it('tailFile should handle files without trailing newline', (done) => {
      const file = path.join(tmpDir, 'nonl.log')
      fs.writeFileSync(file, 'a\nb\nc')
      PM2Interface.tailFile(file, 2, (err, out) => {
        assert(!err)
        assert.strictEqual(out, 'b\nc')
        done()
      })
    })

    it('stop / delete should resolve names to ids', (done) => {
      const stopped = []
      const deleted = []
      const pm2 = makeInterface({
        stopProcessId: (id, cb) => { stopped.push(id); cb(null, {}) },
        deleteProcessId: (id, cb) => { deleted.push(id); cb(null, {}) }
      })
      pm2.stop({ name: 'app' }, (err, res) => {
        assert(!err)
        assert.deepStrictEqual(stopped, [0])
        pm2.delete({ id: 1 }, (err) => {
          assert(!err)
          assert.deepStrictEqual(deleted, [1])
          pm2.stop({}, (err) => {
            assert(err instanceof Error, 'id or name required')
            done()
          })
        })
      })
    })

    it('start should restart stopped processes only', (done) => {
      const restarted = []
      const pm2 = makeInterface({
        restartProcessId: (opts, cb) => { restarted.push(opts.id); cb(null, {}) }
      })
      pm2.start({ name: 'other' }, (err, res) => {
        assert(!err)
        assert.deepStrictEqual(restarted, [1])
        pm2.start({ name: 'app' }, (err, res) => {
          assert(!err)
          assert.deepStrictEqual(restarted, [1], 'online process left untouched')
          done()
        })
      })
    })

    it('flush should truncate the log files', (done) => {
      const out = writeLines('flush-out.log', 10, 'o')
      const errLog = writeLines('flush-err.log', 10, 'e')
      const pm2 = new PM2Interface({
        getMonitorData: (opts, cb) => cb(null, [
          { pm_id: 3, pm2_env: { pm_id: 3, name: 'f', pm_out_log_path: out, pm_err_log_path: errLog } }
        ])
      })
      pm2.flush({ name: 'f' }, (err) => {
        assert(!err)
        assert.strictEqual(fs.statSync(out).size, 0)
        assert.strictEqual(fs.statSync(errLog).size, 0)
        done()
      })
    })

    it('reloadLogs should accept (params, cb)', (done) => {
      const pm2 = makeInterface({ reloadLogs: (opts, cb) => cb(null, {}) })
      pm2.reloadLogs({}, (err, res) => {
        assert(!err)
        assert.strictEqual(res.success, true)
        done()
      })
    })
  })

  describe('DataRetriever enrichment', _ => {
    it('should add process and server fields', () => {
      const system = { 'CPU Usage': { value: 12, unit: '%' } }
      const res = DataRetriever.status([{
        pid: 12,
        monit: { cpu: 1.5, memory: 1000 },
        pm2_env: {
          name: 'app',
          pm_id: 0,
          namespace: 'default',
          version: '1.2.3',
          node_version: '24.0.0',
          unstable_restarts: 2,
          pm_cwd: '/srv/app',
          instances: 4,
          watch: false,
          autorestart: true,
          axm_options: { metrics: { http: true } }
        }
      }], { PM2_VERSION: '7.0.4' }, { system: system })
      const proc = res.process[0]
      assert.strictEqual(proc.namespace, 'default')
      assert.strictEqual(proc.version, '1.2.3')
      assert.strictEqual(proc.node_version, '24.0.0')
      assert.strictEqual(proc.unstable_restarts, 2)
      assert.strictEqual(proc.pm_cwd, '/srv/app')
      assert.strictEqual(proc.instances, 4)
      assert.strictEqual(proc.watch, false)
      assert.strictEqual(proc.autorestart, true)
      assert.deepStrictEqual(proc.axm_options, { metrics: { http: true } })
      assert.strictEqual(res.server.arch, os.arch())
      assert.strictEqual(res.server.cpus, os.cpus().length)
      assert.strictEqual(typeof res.server.cpu_model, 'string')
      assert.deepStrictEqual(res.server.system, system)

      const noSystem = DataRetriever.status([], { PM2_VERSION: '7.0.4' })
      assert.deepStrictEqual(noSystem.server.system, {})
    })

    it('PushInteractor should cache getSystemData and survive failures', (done) => {
      let calls = 0
      const sent = []
      const ipm2 = {
        bus: { on: _ => {} },
        rpc: {
          getSystemData: (opts, cb) => { calls++; cb(null, { 'RAM Used': { value: 1, unit: 'GB' } }) },
          getMonitorData: (opts, cb) => cb(null, [])
        }
      }
      const push = new PushInteractor({ MACHINE_NAME: 'm', PM2_VERSION: '7.0.4' }, ipm2, {
        send: (channel, data) => sent.push(data)
      })
      clearInterval(push._cacheFS._worker)
      push._worker()
      push._worker()
      assert.strictEqual(calls, 1, 'cached for ~5s')
      assert.deepStrictEqual(sent[1].data.server.system, { 'RAM Used': { value: 1, unit: 'GB' } })

      ipm2.rpc.getSystemData = (opts, cb) => cb(new Error('nope'))
      push._systemInfosAt = 0
      push._worker()
      assert.deepStrictEqual(sent[2].data.server.system, { 'RAM Used': { value: 1, unit: 'GB' } }, 'keeps last snapshot')

      delete ipm2.rpc.getSystemData
      push._systemInfosAt = 0
      push._worker()
      assert.strictEqual(sent.length, 4)
      done()
    })
  })

  describe('Transporter reachability check', _ => {
    it('should skip the DNS lookup for localhost / IPs and resolve the prodman host otherwise', (done) => {
      const dns = require('dns')
      const tmp = dns.lookup
      const looked = []
      dns.lookup = (host, cb) => { looked.push(host); cb(null) }
      const transport = new WebsocketTransport({}, null)
      clearInterval(transport._worker)
      clearInterval(transport._heartbeater)
      transport.endpoint = 'ws://localhost:8070/agent/ws'
      transport._checkInternet((online) => {
        assert.strictEqual(online, true)
        assert.deepStrictEqual(looked, [])
        transport.endpoint = 'ws://192.168.1.10:8070/agent/ws'
        transport._checkInternet(() => {
          assert.deepStrictEqual(looked, [])
          transport.endpoint = 'wss://prodman.example.com/agent/ws'
          transport._checkInternet(() => {
            dns.lookup = tmp
            assert.deepStrictEqual(looked, ['prodman.example.com'])
            done()
          })
        })
      })
    })
  })

  describe('websocket heartbeat timeout', () => {
    const WebsocketTransport = require('../../src/transporters/WebsocketTransport')

    function fakeTransport (lastSeenAgo) {
      const t = Object.create(WebsocketTransport.prototype)
      const calls = { ping: 0, terminate: 0 }
      t._ws = { readyState: 1, ping: () => calls.ping++, terminate: () => calls.terminate++ }
      t._lastSeen = Date.now() - lastSeenAgo
      return { t, calls }
    }

    it('pings while the server keeps answering', () => {
      const { t, calls } = fakeTransport(1000)
      t._heartbeat()
      assert.deepStrictEqual(calls, { ping: 1, terminate: 0 })
    })

    it('terminates a half-open socket so the close handler reconnects', () => {
      const { t, calls } = fakeTransport(60000)
      t._heartbeat()
      assert.deepStrictEqual(calls, { ping: 0, terminate: 1 })
    })

    it('treats any inbound message as a sign of life', () => {
      const { t } = fakeTransport(60000)
      t._daemon = { _reverse: null }
      t._onMessage('not json')
      assert(Date.now() - t._lastSeen < 1000)
    })
  })
})
