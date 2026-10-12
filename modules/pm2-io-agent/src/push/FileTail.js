'use strict'

/**
 * Follow a text file like `tail -F`: starts at the end, survives rotation (new inode) and
 * truncation, reads at most maxRead bytes per poll. onLine(line) for each complete line.
 */
const fs = require('fs')

class FileTail {
  constructor (file, onLine, opts) {
    opts = opts || {}
    this.file = file
    this.onLine = onLine
    this.pollMs = opts.pollMs || 1000
    this.maxRead = opts.maxRead || 1024 * 1024
    this.fd = null
    this.ino = null
    this.pos = 0
    this.partial = ''
    this.timer = null
  }

  start () {
    this._open(false)
    this.timer = setInterval(() => this.poll(), this.pollMs)
    if (this.timer.unref) this.timer.unref()
    return this
  }

  stop () {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    try { if (this.fd !== null) fs.closeSync(this.fd) } catch (e) {}
    this.fd = null
  }

  _open (fromStart) {
    try { if (this.fd !== null) fs.closeSync(this.fd) } catch (e) {}
    this.fd = null
    try {
      const st = fs.statSync(this.file)
      this.fd = fs.openSync(this.file, 'r')
      this.ino = st.ino
      this.pos = fromStart ? 0 : st.size
      this.partial = ''
    } catch (e) {}
  }

  poll () {
    let st
    try { st = fs.statSync(this.file) } catch (e) { return }
    if (this.fd === null || st.ino !== this.ino || st.size < this.pos) this._open(this.fd !== null || this.ino !== null)
    if (this.fd === null || st.size <= this.pos) return
    const length = Math.min(st.size - this.pos, this.maxRead)
    const buf = Buffer.alloc(length)
    let read = 0
    try { read = fs.readSync(this.fd, buf, 0, length, this.pos) } catch (e) { return }
    this.pos += read
    const parts = (this.partial + buf.slice(0, read).toString('utf8')).split('\n')
    this.partial = parts.pop()
    for (const line of parts) if (line) this.onLine(line)
  }
}

module.exports = FileTail
