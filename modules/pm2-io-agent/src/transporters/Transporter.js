'use strict'

const log = require('debug')('interactor:transporter')
const EventEmitter2 = require('eventemitter2').EventEmitter2
const dns = require('dns')
const net = require('net')
const cst = require('../../constants.js')

const Transporter = module.exports = class Transporter extends EventEmitter2 {
  constructor () {
    super({
      delimiter: ':',
      wildcard: true
    })
  }

  /**
   * Disconnect and connect to a url
   * @param {String} url where the client will connect [optionnal]
   * @param {Function} cb invoked with <err>
   */
  reconnect (url, cb) {
    log('Reconnect transporter')
    this.disconnect()
    this.connect(url, cb)
  }

  /**
   * Broadcast the close event from websocket connection
   * @private
   * @param {Integer} code
   * @param {String} reason
   */
  _onClose (code, reason) {
    log('Closed transporter')
    this.disconnect()
    this._reconnect()
    this.emit('close', code, reason)
  }

  /**
   * Broadcast the error event from websocket connection
   * and eventually close the connection if it isnt already
   * @private
   * @param {Error} err
   */
  _onError (err) {
    log(`Error with transporter: ${err.message}`)
    // close connection if needed
    this.disconnect()
    this._reconnect()
    this.emit('error', err)
  }

  /**
   * Worker that will empty the packet queue if the connection works.
   * @private
   */
  _emptyQueue () {
    // create the queue if it doesn't exist
    if (!this.queue) {
      this.queue = []
      return
    }
    if (this.queue.length === 0) return
    if (!this.isConnected()) return

    log('Emptying queue (size : %d)', this.queue.length)

    // re-send all of the data
    while (this.queue.length > 0) {
      if (!this.isConnected()) return
      let packet = this.queue[0]
      this.send(packet.channel, packet.data)
      this.queue.shift()
    }
  }

  /**
   * Host name used for the DNS reachability check: the websocket endpoint host
   * if known, otherwise the root URL host. Returns null for localhost / IPs.
   * @private
   * @return {String|null}
   */
  _getCheckHost () {
    let hostname = null
    const candidates = [typeof this.endpoint === 'string' ? this.endpoint : null, cst.KEYMETRICS_ROOT_URL]
    for (const candidate of candidates) {
      if (!candidate) continue
      try {
        hostname = new URL(candidate).hostname
        if (hostname) break
      } catch (e) {}
    }
    if (!hostname) return null
    hostname = hostname.replace(/^\[|\]$/g, '')
    if (hostname === 'localhost' || hostname.endsWith('.localhost') || net.isIP(hostname)) return null
    return hostname
  }

  /**
   * Is internet reachable via DNS
   * @private
   * @param {Function} cb invoked with <boolean>
   */
  _checkInternet (cb) {
    // prodman: resolve the configured server host instead of google.com,
    // and skip the check entirely for localhost / IP addresses
    const host = this._getCheckHost()
    if (!host) {
      this._online = true
      return cb(this._online)
    }
    dns.lookup(host, (err) => {
      if (err && (err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN')) {
        if (this._online) {
          log('Internet is unreachable (DNS)')
        }
        this._online = false
      } else {
        if (!this._online) {
          log('Internet is reachable again')
        }
        this._online = true
      }
      return cb(this._online)
    })
  }

  /**
   * Strategy to reconnect to remote endpoint:
   *  -> test internet connection with dns request (if fail retry in 2 sec)
   *  -> try to connect to endpoint (if fail back off 5s → 60s, with jitter)
   *
   * prodman: exactly one retry chain may exist. `_reconnecting` stays true while a
   * retry is scheduled, so send() (called every second for status), close and
   * error events cannot start parallel chains — upstream let a new chain start
   * on every send during an outage, which grew without bound.
   */
  _reconnect () {
    if (this._reconnecting === true) return
    if (this.isConnected()) {
      // connected by another path (e.g. the endpoint re-poll) while a retry was pending
      this._reconnectAttempts = 0
      return
    }
    this._reconnecting = true

    const retry = (ms) => {
      this._reconnectTimer = setTimeout(() => {
        this._reconnectTimer = null
        this._reconnecting = false
        this._reconnect()
      }, process.env.NODE_ENV === 'test' ? 1 : ms)
    }

    log('Trying to reconnect to remote endpoint')
    this._checkInternet((online) => {
      if (!online && !cst.PM2_DEBUG) {
        log('Internet down, retry in 2 seconds ..')
        return retry(2000)
      }
      this.connect((err) => {
        if (err || !this.isConnected()) {
          this._reconnectAttempts = (this._reconnectAttempts || 0) + 1
          const delay = Transporter.backoff(this._reconnectAttempts)
          log('Endpoint down, retry in %ds ...', Math.round(delay / 1000))
          return retry(delay)
        }

        log('Connection established with remote endpoint')
        this._reconnectAttempts = 0
        this._reconnecting = false
        this._emptyQueue()
      })
    })
  }

  /**
   * Delay before reconnect attempt `n` (1-based): 5s, 10s, 20s, 40s, then 60s,
   * ±20% jitter so a fleet doesn't reconnect in lockstep after a prodman restart.
   */
  static backoff (n) {
    const base = Math.min(5000 * 2 ** Math.max(0, n - 1), 60000)
    return Math.round(base * (0.8 + Math.random() * 0.4))
  }
}
