'use strict';

/**
 * prodman: built-in log rotation, replacing the pm2-logrotate module.
 *
 * Runs in the daemon and uses the same settings (`pm2 set pm2-logrotate:<key> <value>`), so
 * existing module configuration carries over. Differences from the module:
 *  - on by default (`pm2 set pm2-logrotate:enabled false` turns it off)
 *  - app logs are renamed and the app's log streams reopened, instead of copied and truncated:
 *    instant for any file size, and no lines are lost while copying. Only pm2.log, which the
 *    daemon can't reopen, is copied and truncated.
 *  - a file is never rotated again while its previous rotation is in progress, and compression
 *    runs one file at a time, so a huge first rotation can't snowball and fill the disk
 *  - boolean settings accept true/"true"/1/"yes" (the module ignored `compress true`)
 *  - retention counts compressed and uncompressed copies, oldest removed first
 *
 * Settings (module_conf.json → "pm2-logrotate"):
 *   enabled         true      rotate at all
 *   max_size        10M       rotate a log once it reaches this size (K, M, G or bytes)
 *   retain          10        rotated copies to keep per log ("all" keeps everything)
 *   compress        true      gzip rotated copies
 *   dateFormat      YYYY-MM-DD_HH-mm-ss   suffix of rotated files (YYYY MM DD HH mm ss SSS)
 *   TZ              (local)   time zone for the suffix, e.g. Europe/London
 *   workerInterval  30        seconds between size checks
 *   rotateInterval  0 0 * * * cron schedule that rotates every non-empty log regardless of size
 *   rotateModule    true      also rotate the logs of PM2 modules
 */

var fs = require('fs');
var path = require('path');
var zlib = require('zlib');
var stream = require('stream');
var Cron = require('croner');
var cst = require('../constants.js');
var Configuration = require('./Configuration.js');

var CONF_KEY = 'pm2-logrotate';
var MODULE_NAME = 'pm2-logrotate';
var PREFIX = '[logrotate] ';

var DEFAULTS = {
  enabled: true,
  max_size: '10M',
  retain: 10,
  compress: true,
  dateFormat: 'YYYY-MM-DD_HH-mm-ss',
  TZ: null,
  workerInterval: 30,
  rotateInterval: '0 0 * * *',
  rotateModule: true
};

function parseBool(v, def) {
  if (v === true || v === false) return v;
  if (v === undefined || v === null || v === '') return def;
  var s = String(v).trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].indexOf(s) > -1) return true;
  if (['false', '0', 'no', 'off'].indexOf(s) > -1) return false;
  return def;
}

/** "10M", "1.5G", "500K", "1048576" → bytes; null when unparseable */
function parseSize(v) {
  if (typeof v === 'number') return v > 0 ? Math.floor(v) : null;
  var m = String(v || '').trim().match(/^(\d+(?:\.\d+)?)\s*([KMG]?)B?$/i);
  if (!m) return null;
  var mult = { '': 1, K: 1024, M: 1024 * 1024, G: 1024 * 1024 * 1024 }[m[2].toUpperCase()];
  var n = Math.floor(parseFloat(m[1]) * mult);
  return n > 0 ? n : null;
}

function readConfig(raw) {
  raw = raw || {};
  var pick = function(k) { return raw[k] !== undefined && raw[k] !== null && raw[k] !== '' ? raw[k] : DEFAULTS[k]; };
  var retain = pick('retain');
  var interval = parseInt(pick('workerInterval'), 10);
  return {
    enabled: parseBool(raw.enabled, DEFAULTS.enabled),
    maxSize: parseSize(pick('max_size')) || parseSize(DEFAULTS.max_size),
    retain: String(retain).toLowerCase() === 'all' ? Infinity
      : (parseInt(retain, 10) >= 0 ? parseInt(retain, 10) : DEFAULTS.retain),
    compress: parseBool(raw.compress, DEFAULTS.compress),
    dateFormat: String(pick('dateFormat')),
    tz: raw.TZ ? String(raw.TZ) : null,
    workerInterval: (interval >= 1 ? interval : DEFAULTS.workerInterval) * 1000,
    rotateInterval: String(pick('rotateInterval')),
    rotateModule: parseBool(raw.rotateModule, DEFAULTS.rotateModule)
  };
}

function pad(n, w) { return String(n).padStart(w || 2, '0'); }

/** date → dateFormat with YYYY MM DD HH mm ss SSS, in tz (an IANA zone) or local time */
function formatDate(date, fmt, tz) {
  var p;
  try {
    if (tz) {
      p = {};
      new Intl.DateTimeFormat('en-GB', {
        timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit'
      }).formatToParts(date).forEach(function(x) { p[x.type] = x.value; });
    }
  } catch (e) {
    p = null;
  }
  var v = p ? {
    YYYY: p.year, MM: p.month, DD: p.day, HH: p.hour, mm: p.minute, ss: p.second
  } : {
    YYYY: String(date.getFullYear()), MM: pad(date.getMonth() + 1), DD: pad(date.getDate()),
    HH: pad(date.getHours()), mm: pad(date.getMinutes()), ss: pad(date.getSeconds())
  };
  v.SSS = pad(date.getMilliseconds(), 3);
  return fmt.replace(/YYYY|SSS|MM|DD|HH|mm|ss/g, function(t) { return v[t]; });
}

/** "/logs/app-out.log" → "/logs/app-out" (the prefix of its rotated copies) */
function baseOf(file) {
  return file.replace(/\.log$/, '');
}

/** a free name for the rotated copy of file */
function rotatedName(file, stamp) {
  var base = baseOf(file) + '__' + stamp;
  var name = base + '.log';
  for (var i = 1; fs.existsSync(name) || fs.existsSync(name + '.gz'); i++)
    name = base + '-' + i + '.log';
  return name;
}

/** rotated copies of file (compressed or not), newest first */
function rotatedCopies(file) {
  var dir = path.dirname(file);
  var prefix = path.basename(baseOf(file)) + '__';
  var names;
  try { names = fs.readdirSync(dir); } catch (e) { return []; }
  return names
    .filter(function(n) { return n.indexOf(prefix) === 0 && /\.log(\.gz)?$/.test(n); })
    .map(function(n) {
      var f = path.join(dir, n);
      try { return { file: f, mtime: fs.statSync(f).mtimeMs }; } catch (e) { return null; }
    })
    .filter(Boolean)
    .sort(function(a, b) { return b.mtime - a.mtime || (a.file < b.file ? 1 : -1); })
    .map(function(x) { return x.file; });
}

function isLogPath(f) {
  return typeof f === 'string' && f.length > 0 && f.indexOf('/dev/null') === -1 && f !== 'NULL';
}

function LogRotate(God, opts) {
  opts = opts || {};
  this.God = God;
  this.pm2Log = opts.pm2Log || cst.PM2_LOG_FILE_PATH;
  this.getConfig = opts.getConfig || function() { return Configuration.getSync(CONF_KEY); };
  this.reopenDelay = opts.reopenDelay !== undefined ? opts.reopenDelay : 2000;
  this.log = opts.log || function(msg) { console.log(PREFIX + msg); };
  this.busy = {};                 // file → true while it is being rotated
  this.inflight = [];             // rotations not yet finished (see idle())
  this.chain = Promise.resolve(); // compression queue, one file at a time
  this.timer = null;
  this.cron = null;
  this.cronExpr = null;
  this.warnedModule = false;
  this.swept = false;
}

LogRotate.prototype.start = function() {
  var that = this;
  if (this.timer) return;
  var loop = function() {
    var conf = that.check();
    that.timer = setTimeout(loop, conf ? conf.workerInterval : DEFAULTS.workerInterval * 1000);
    if (that.timer.unref) that.timer.unref();
  };
  this.timer = setTimeout(loop, 5000);
  if (this.timer.unref) this.timer.unref();
};

LogRotate.prototype.stop = function() {
  if (this.timer) clearTimeout(this.timer);
  this.timer = null;
  if (this.cron) this.cron.stop();
  this.cron = null;
  this.cronExpr = null;
};

/** current settings, or null when rotation is off or left to the external module */
LogRotate.prototype.config = function() {
  var conf = readConfig(this.getConfig());
  if (!conf.enabled) return null;
  if (this.externalModule()) {
    if (!this.warnedModule)
      this.log('the pm2-logrotate module is installed, so built-in rotation is paused. ' +
        'Remove it with `pm2 uninstall pm2-logrotate` (its settings carry over).');
    this.warnedModule = true;
    return null;
  }
  this.warnedModule = false;
  return conf;
};

LogRotate.prototype.externalModule = function() {
  var db = this.God.clusters_db || {};
  return Object.keys(db).some(function(id) {
    var e = db[id] && db[id].pm2_env;
    return e && e.name === MODULE_NAME && e.pmx_module;
  });
};

/** log file → { copy: bool, procs: [...] } for every log PM2 writes */
LogRotate.prototype.targets = function(conf) {
  var db = this.God.clusters_db || {};
  var files = {};
  Object.keys(db).forEach(function(id) {
    var proc = db[id];
    var e = proc && proc.pm2_env;
    if (!e || (e.pmx_module && !conf.rotateModule)) return;
    [e.pm_out_log_path, e.pm_err_log_path, e.pm_log_path].forEach(function(f) {
      if (!isLogPath(f)) return;
      var t = files[f] || (files[f] = { copy: false, procs: [] });
      if (t.procs.indexOf(proc) === -1) t.procs.push(proc);
    });
  });
  if (isLogPath(this.pm2Log)) files[this.pm2Log] = { copy: true, procs: [] };
  return files;
};

/** one size check; force rotates every non-empty log. Returns the settings used. */
LogRotate.prototype.check = function(force) {
  var that = this;
  var conf;
  try {
    conf = this.config();
    if (!conf) return null;
    this.schedule(conf);
    var targets = this.targets(conf);
    if (!this.swept) this.sweep(targets, conf);
    var due = Object.keys(targets).filter(function(file) {
      if (that.busy[file]) return false;
      var size;
      try { size = fs.statSync(file).size; } catch (e) { return false; }
      return force ? size > 0 : size >= conf.maxSize;
    });
    if (due.length) this.rotateFiles(due, targets, conf);
  } catch (e) {
    this.log('check failed: ' + (e.stack || e));
  }
  return conf;
};

LogRotate.prototype.schedule = function(conf) {
  var that = this;
  if (conf.rotateInterval === this.cronExpr) return;
  if (this.cron) this.cron.stop();
  this.cron = null;
  this.cronExpr = conf.rotateInterval;
  try {
    this.cron = Cron(conf.rotateInterval, function() { that.check(true); });
  } catch (e) {
    this.log('invalid rotateInterval "' + conf.rotateInterval + '": ' + e.message);
  }
};

/**
 * Once per daemon start: compress rotated copies left uncompressed (a restart during
 * compression, or the pm2-logrotate module) and remove unfinished .gz.tmp files.
 */
LogRotate.prototype.sweep = function(targets, conf) {
  var that = this;
  this.swept = true;
  Object.keys(targets).forEach(function(file) {
    var dir = path.dirname(file);
    var prefix = path.basename(baseOf(file)) + '__';
    var names;
    try { names = fs.readdirSync(dir); } catch (e) { return; }
    names.filter(function(n) { return n.indexOf(prefix) === 0; }).forEach(function(n) {
      var f = path.join(dir, n);
      if (/\.gz\.tmp$/.test(n)) {
        try { fs.unlinkSync(f); } catch (e) {}
      } else if (conf.compress && /\.log$/.test(n)) {
        that.chain = that.chain.then(function() { return gzipFile(f); })
          .catch(function(e) { that.log('compressing ' + f + ' failed: ' + e.message); });
      }
    });
  });
};

/**
 * Rotate several files. Files the daemon can't reopen are copied and truncated one by one.
 * The others are all renamed first, then every process that writes any of them is reopened
 * exactly once: one process often owns several due files (out, err, combined), and reopening
 * it once per file ran PM2's log reload concurrently with itself, which broke its streams.
 */
LogRotate.prototype.rotateFiles = function(files, targets, conf) {
  var that = this;
  var stamp = formatDate(new Date(), conf.dateFormat, conf.tz);
  var renames = [];
  files.forEach(function(file) {
    if (!targets[file].copy) return renames.push(file);
    var dest = rotatedName(file, stamp);
    that.rotate(file, targets[file], conf, copyTruncate(file, dest), dest);
  });
  if (!renames.length) return;
  var moves = renames.map(function(file) {
    var dest = rotatedName(file, stamp);
    that.busy[file] = true;
    return { file: file, dest: dest, renamed: renameFile(file, dest) };
  });
  var reopened = Promise.all(moves.map(function(m) { return m.renamed.then(function() { return true; }, function() { return false; }); }))
    .then(function(ok) {
      var procs = [];
      moves.forEach(function(m, i) {
        if (!ok[i]) return;
        targets[m.file].procs.forEach(function(proc) { if (procs.indexOf(proc) === -1) procs.push(proc); });
      });
      procs.forEach(function(proc) { reopen(that, proc); });
      // writes in flight land in the renamed files until each app has reopened its logs
      return new Promise(function(resolve) { setTimeout(resolve, that.reopenDelay); });
    });
  moves.forEach(function(m) {
    that.rotate(m.file, targets[m.file], conf, m.renamed.then(function() { return reopened; }), m.dest);
  });
};

/** finish rotating one file once `moved` resolves: compress the copy, prune old copies */
LogRotate.prototype.rotate = function(file, target, conf, moved, dest) {
  var that = this;
  this.busy[file] = true;
  var done = moved
    .then(function() {
      delete that.busy[file];
      that.log('rotated ' + file + ' → ' + path.basename(dest));
      that.chain = that.chain.then(function() {
        return (conf.compress ? gzipFile(dest) : Promise.resolve())
          .then(function() { prune(that, file, conf.retain); });
      }).catch(function(e) {
        that.log('compressing ' + dest + ' failed: ' + e.message);
      });
      return that.chain;
    }, function(e) {
      delete that.busy[file];
      that.log('rotating ' + file + ' failed: ' + e.message);
    });
  this.inflight.push(done);
  done.then(function() { that.inflight.splice(that.inflight.indexOf(done), 1); });
  return done;
};

/** resolves when every started rotation, including compression and pruning, has finished */
LogRotate.prototype.idle = function() {
  var that = this;
  return Promise.all(this.inflight.slice()).then(function() {
    return that.inflight.length ? that.idle() : that.chain;
  });
};

function renameFile(file, dest) {
  return new Promise(function(resolve, reject) {
    fs.rename(file, dest, function(err) { return err ? reject(err) : resolve(); });
  });
}

function reopen(that, proc) {
  try {
    var e = proc.pm2_env;
    if (e.exec_mode === 'cluster_mode' && proc.send && proc.isConnected && proc.isConnected())
      proc.send({ type: 'log:reload' });
    else if (proc._reloadLogs)
      proc._reloadLogs(function(err) { if (err) that.log('reopening logs of ' + e.name + ' failed: ' + err.message); });
  } catch (err) {
    that.log('reopening logs failed: ' + err.message);
  }
}

/** for files whose writer can't reopen them (pm2.log, opened with O_APPEND) */
function copyTruncate(file, dest) {
  return new Promise(function(resolve, reject) {
    stream.pipeline(fs.createReadStream(file), fs.createWriteStream(dest, { flags: 'wx' }), function(err) {
      if (err) return reject(err);
      fs.truncate(file, 0, function(err) { return err ? reject(err) : resolve(); });
    });
  });
}

function gzipFile(file) {
  return new Promise(function(resolve, reject) {
    var tmp = file + '.gz.tmp';
    stream.pipeline(fs.createReadStream(file), zlib.createGzip(), fs.createWriteStream(tmp), function(err) {
      if (err) {
        fs.unlink(tmp, function() { reject(err); });
        return;
      }
      fs.rename(tmp, file + '.gz', function(err) {
        if (err) return reject(err);
        fs.unlink(file, function() { resolve(); });
      });
    });
  });
}

function prune(that, file, retain) {
  if (retain === Infinity) return;
  rotatedCopies(file).slice(retain).forEach(function(old) {
    try {
      fs.unlinkSync(old);
      that.log('removed ' + path.basename(old));
    } catch (e) {}
  });
}

LogRotate.readConfig = readConfig;
LogRotate.parseSize = parseSize;
LogRotate.parseBool = parseBool;
LogRotate.formatDate = formatDate;
LogRotate.rotatedCopies = rotatedCopies;
LogRotate.DEFAULTS = DEFAULTS;

module.exports = LogRotate;
