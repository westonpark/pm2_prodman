'use strict'

const WebSocket = require('ws')
const ProxyAgent = require('proxy-agent')
const log = require('debug')('interactor:websocket')
const cst = require('../../constants.js')
const pkg = require('../../../../package.json')
const Transporter = require('./Transporter')
const jsonPatch = require('fast-json-patch')
const fs = require('fs')

const HEARTBEAT_TIMEOUT = parseInt(process.env.PRODMAN_WS_TIMEOUT, 10) || 20000
/**
 * Websocket Transport used to communicate with KM
 * @param {Object} opts options
 * @param {Daemon} daemon Interactor instance
 */
module.exports = class WebsocketTransport extends Transporter {
  constructor (opts, daemon) {
    super()
    log('WebsocketTransporter constructed')
    this.opts = opts
    this._daemon = daemon
    this._ws = null
    this.queue = []
    this._last_status = null
    this._resend_status = false
    this._worker = setInterval(this._emptyQueue.bind(this), process.env.NODE_ENV === 'test' ? 2 : 10000)
    this._lastSeen = Date.now()
    this._heartbeater = setInterval(this._heartbeat.bind(this), 5000)
  }

  /**
   * Send heartbeat to websocket server (every 5 sec)
   */
  _heartbeat () {
    if (!this.isConnected()) return false
    // Detect half-open connections (server restarted, NAT/proxy dropped the
    // socket): if nothing came back for a while, terminate so the close
    // handler reconnects.
    if (Date.now() - this._lastSeen > HEARTBEAT_TIMEOUT) {
      log('No pong or message for %dms, terminating websocket', Date.now() - this._lastSeen)
      return this._ws.terminate()
    }
    return this._ws.ping()
  }

  /**
   * Connect the websocket client to a url
   * @param {String} url where the client will connect
   * @param {Function} cb invoked with <err>
   */
  connect (url, cb) {
    if (typeof url === 'function') {
      cb = url
      url = this.endpoint
    }
    this.endpoint = url

    if (!url) return cb(new Error('Websocket URL is not defined!'))

    log('Connecting websocket transporter to %s...', url)
    // never leave an earlier socket running alongside the new one
    if (this._ws) {
      const old = this._ws
      this._ws = null
      try { old.terminate() } catch (e) {}
    }
    const ws = this._ws = new WebSocket(url, {
      perMessageDeflate: process.env.WS_GZIP || false,
      headers: {
        'X-KM-PUBLIC': this.opts.PUBLIC_KEY,
        'X-KM-SECRET': this.opts.SECRET_KEY,
        'X-KM-SERVER': this.opts.MACHINE_NAME,
        'X-PM2-VERSION': this.opts.PM2_VERSION || '0.0.0',
        'X-PROTOCOL-VERSION': cst.PROTOCOL_VERSION,
        'User-Agent': `PM2 Agent v${pkg.version}`
      },
      agent: cst.PROXY ? new ProxyAgent(cst.PROXY) : undefined
    })
    // prodman: events from a socket that is no longer current must not tear
    // down (or reconnect over) the live connection
    const current = () => ws === this._ws

    let onError = (err) => {
      log('Error on websocket connect', err)
      return cb(err)
    }
    ws.once('error', onError)
    ws.once('open', () => {
      this._lastSeen = Date.now()
      this._resend_status = true
      log(`Connected to ${url}`)
      ws.removeListener('error', onError)
      if (!current()) return cb(new Error('Connection superseded by a newer one'))
      ws.on('close', (code, reason) => { if (current()) this._onClose(code, reason) })
      ws.on('error', (err) => { if (current()) this._onError(err) })
      return cb()
    })

    ws.on('message', (data) => { if (current()) this._onMessage(data) })
    ws.on('ping', () => {
      try { ws.pong() } catch (e) {}
    })
    ws.on('pong', () => { if (current()) this._lastSeen = Date.now() })
  }

  /**
   * Disconnect clients
   */
  disconnect () {
    log('Disconnect websocket transporter')
    if (this.isConnected()) {
      this._ws.close(1000, 'Disconnecting')
    }
    this._ws = null
  }

  /**
   * Are push and reverse connections ready
   * @return {Boolean}
   */
  isConnected () {
    return this._ws && this._ws.readyState === 1
  }

  /**
   * Send data to endpoints
   * @param {String} channel
   * @param {Object} data
   */
  send (channel, data) {
    if (!channel || !data) {
      return log('Trying to send message without all necessary fields')
    }
    if (!this.isConnected()) {
      if (!this._reconnecting) this._reconnect()

      // do not buffer status/monitoring packet
      if (channel === 'status' || channel === 'monitoring') return

      log('Trying to send data while not connected, buffering ...')

      // remove last element if the queue is full
      if (this.queue.length >= cst.PACKET_QUEUE_SIZE) {
        this.queue.shift()
      }
      return this.queue.push({ channel: channel, data: data })
    }

    if (channel === 'status' && process.env.WS_JSON_PATCH) {
      if (this._last_status == null || this._resend_status == true) {
        if (this._resend_status)
          log('Sending fresh new status')
        this._resend_status = false
        this._last_status = data
      }
      else {
        let patch = jsonPatch.compare(this._last_status, data)

        let packet = {
          payload: patch,
          channel: 'status:patch'
        }

        this._last_status = data


        if (process.env.WS_JSON_PATCH_BENCH) {
          fs.writeFileSync('status', JSON.stringify(data))
          fs.writeFileSync('patch', JSON.stringify(packet))
        }

        return this._ws.send(JSON.stringify(packet), (err) => {
          packet = null
          if (err) {
            this.emit('error', err)
          }
        })
      }
    }

    log('Sending packet over for channel %s', channel)
    let packet = {
      payload: data,
      channel: channel
    }
    this._ws.send(JSON.stringify(packet), {
      compress: cst.COMPRESS_PROTOCOL || false
    }, (err) => {
      packet = null
      if (err) {
        this.emit('error', err)
        // buffer the packet to send it when the connection will be up again
        this.queue.push({ channel: channel, data: data })
      }
    })
  }

  /**
   * Message received from keymetrics
   * @private
   * @param {String} json packet
   */
  _onMessage (data) {
    this._lastSeen = Date.now()
    try {
      data = JSON.parse(data)
    } catch (err) {
      return log('Bad packet received from remote : %s', err.message || err)
    }

    if (process.env.WS_JSON_PATCH && data.channel == 'status:resend') {
      log(`Wrong patch sent to backend, resending fresh status`)
      this._resend_status = true
    }

    // ensure that all required field are present
    if (!data || !data.payload || !data.channel) {
      return log('Received message without all necessary fields')
    }
    log('Recevied data on channel %s', data.channel)
    this.emit(data.channel, data.payload)
  }
}
