/* eslint-env mocha */

'use strict'

const assert = require('assert')
const WebSocket = require('ws')
const Transporter = require('../../src/transporters/Transporter')
const WebsocketTransport = require('../../src/transporters/WebsocketTransport')
const InteractorDaemon = require('../../src/InteractorDaemon')

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

/** Run `fn` with NODE_ENV != test and a short fixed backoff, then restore both. */
async function withRealRetries (backoffMs, fn) {
  const env = process.env.NODE_ENV
  const tBackoff = Transporter.backoff
  const dBackoff = InteractorDaemon.startupBackoff
  process.env.NODE_ENV = 'production'
  Transporter.backoff = () => backoffMs
  InteractorDaemon.startupBackoff = () => backoffMs
  try {
    await fn()
  } finally {
    process.env.NODE_ENV = env
    Transporter.backoff = tBackoff
    InteractorDaemon.startupBackoff = dBackoff
  }
}

describe('prodman agent resilience', function () {
  describe('Transporter reconnect', () => {
    class DownTransport extends Transporter {
      constructor () {
        super()
        this.connects = 0
        this.up = false
      }

      isConnected () { return this.up }
      _checkInternet (cb) { cb(true) }
      connect (cb) {
        this.connects++
        if (this.up) return cb()
        cb(new Error('ECONNREFUSED'))
      }
    }

    it('keeps a single retry chain however often send/close/error ask to reconnect', () => withRealRetries(30, async () => {
      const t = new DownTransport()
      // simulate ~200ms of an outage with status sends every 5ms (upstream started a new chain on each)
      for (let i = 0; i < 40; i++) {
        t._reconnect()
        await wait(5)
      }
      // one attempt immediately, then one every 30ms
      assert(t.connects >= 5 && t.connects <= 9, `expected ~7 connect attempts, got ${t.connects}`)
      assert.strictEqual(t._reconnecting, true)
      clearTimeout(t._reconnectTimer)
    }))

    it('stops retrying once connected and resets the backoff', () => withRealRetries(10, async () => {
      const t = new DownTransport()
      t._reconnect()
      await wait(35)
      t.up = true
      await wait(30)
      const after = t.connects
      await wait(50)
      assert.strictEqual(t.connects, after, 'no further attempts once connected')
      assert.strictEqual(t._reconnecting, false)
      assert.strictEqual(t._reconnectAttempts, 0)
    }))

    it('backs off from 5s to a 60s cap with jitter', () => {
      for (let i = 0; i < 50; i++) {
        const d1 = Transporter.backoff(1)
        const d9 = Transporter.backoff(9)
        assert(d1 >= 4000 && d1 <= 6000, `attempt 1 → ${d1}`)
        assert(d9 >= 48000 && d9 <= 72000, `attempt 9 → ${d9}`)
      }
    })
  })

  describe('WebsocketTransport stale sockets', () => {
    let wss, url, transport
    beforeEach((done) => {
      wss = new WebSocket.Server({ port: 0 }, () => {
        url = `ws://127.0.0.1:${wss.address().port}`
        done()
      })
    })
    afterEach((done) => {
      clearInterval(transport._worker)
      clearInterval(transport._heartbeater)
      transport.disconnect()
      wss.clients.forEach(c => c.terminate())
      wss.close(() => done())
    })

    it('ignores events from a superseded socket and replaces it cleanly', (done) => {
      transport = new WebsocketTransport({ PUBLIC_KEY: 'p', SECRET_KEY: 's', MACHINE_NAME: 'm' }, {})
      let closes = 0
      transport._onClose = () => { closes++ }
      transport.connect(url, (err) => {
        assert.ifError(err)
        const first = transport._ws
        transport.connect(url, (err) => {
          assert.ifError(err)
          assert.notStrictEqual(transport._ws, first)
          assert(first.readyState >= WebSocket.CLOSING, 'old socket was terminated')
          setTimeout(() => {
            assert.strictEqual(closes, 0, 'closing the old socket must not trigger _onClose')
            assert.strictEqual(transport.isConnected(), true)
            assert.strictEqual(wss.clients.size, 1, 'only one connection to the server')
            // a real drop of the current socket is still reported
            wss.clients.forEach(c => c.terminate())
            setTimeout(() => {
              assert.strictEqual(closes, 1)
              done()
            }, 100)
          }, 100)
        })
      })
    })
  })

  describe('InteractorDaemon startup', () => {
    it('keeps retrying the handshake instead of exiting when prodman is unreachable', () => withRealRetries(5, async () => {
      let verifies = 0
      const exits = []
      const fake = Object.create(InteractorDaemon.prototype)
      Object.assign(fake, {
        opts: {},
        startRPC: () => ({}),
        _verifyEndpoint (cb) {
          verifies++
          if (this._stop) return
          cb(new Error('connect ECONNREFUSED'))
        },
        exit: (err) => exits.push(err),
        sendToParent: () => {}
      })
      fake.start()
      // upstream exited after 30 tries; make sure we go well past that
      await wait(400)
      fake._stop = true
      clearTimeout(fake._startupRetry)
      assert(verifies > 30, `expected more than 30 attempts, got ${verifies}`)
      assert.deepStrictEqual(exits, [])
    }))

    it('still exits when prodman rejects the keys', () => withRealRetries(5, async () => {
      const exits = []
      const fake = Object.create(InteractorDaemon.prototype)
      Object.assign(fake, {
        opts: {},
        startRPC: () => ({}),
        _verifyEndpoint: cb => cb(null, { active: false, error: true, msg: 'invalid keys' }),
        exit: (err) => exits.push(err),
        sendToParent: () => {}
      })
      fake.start()
      await wait(20)
      assert.strictEqual(exits.length, 1)
      assert.match(exits[0].message, /invalid keys/)
    }))
  })
})
