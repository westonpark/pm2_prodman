'use strict';

/**
 * prodman: never start an unsupervised PM2 daemon.
 *
 * Two ways a daemon started by the CLI leaves apps down:
 *  - PM2 is installed as a systemd service (`pm2 startup`), but a shell or CI job starts the
 *    daemon itself. systemd can't adopt it ("New main PID ... does not belong to service"),
 *    the service fails, and nothing restarts PM2 after a crash or reboot.
 *  - a GitHub Actions self-hosted runner job starts it. When the job ends the runner kills
 *    every process carrying the job's RUNNER_TRACKING_ID, daemon included; apps that outlive
 *    it (e.g. Python) are orphaned and keep their ports.
 *
 * So the CLI only spawns a daemon when it is itself running inside the service, or when no
 * service is installed and it isn't in a runner job. PM2_SERVICE_GUARD=off disables the check.
 */

var fs = require('fs');
var path = require('path');
var childProcess = require('child_process');

var UNIT_DIRS = ['/etc/systemd/system', '/lib/systemd/system', '/usr/lib/systemd/system'];

/** the systemd unit whose Environment=PM2_HOME= is this PM2_HOME, or null */
function findService(pm2Home, opts) {
  opts = opts || {};
  if (!opts.dirs && process.platform !== 'linux') return null;
  var want = path.resolve(pm2Home);
  var dirs = opts.dirs || UNIT_DIRS;
  for (var i = 0; i < dirs.length; i++) {
    var files;
    try { files = fs.readdirSync(dirs[i]); } catch (e) { continue; }
    for (var j = 0; j < files.length; j++) {
      if (!/^pm2.*\.service$/.test(files[j])) continue;
      var file = path.join(dirs[i], files[j]);
      var text;
      try { text = fs.readFileSync(file, 'utf8'); } catch (e) { continue; }
      var m = text.match(/^\s*Environment=\s*"?PM2_HOME=([^"\r\n]+?)"?\s*$/m);
      if (m && path.resolve(m[1]) === want) return { unit: files[j], file: file };
    }
  }
  return null;
}

/** true when this process runs in the unit's cgroup (i.e. systemd started it for the unit) */
function insideUnit(unit, cgroupFile) {
  var text;
  try { text = fs.readFileSync(cgroupFile || '/proc/self/cgroup', 'utf8'); } catch (e) { return false; }
  return text.split('\n').some(function(line) {
    var p = line.split(':').slice(2).join(':');
    return p.split('/').indexOf(unit) > -1;
  });
}

function inRunnerJob(env) {
  return !!(env.RUNNER_TRACKING_ID || env.GITHUB_ACTIONS === 'true');
}

function unitState(unit) {
  try {
    var r = childProcess.spawnSync('systemctl', ['is-active', unit], { encoding: 'utf8', timeout: 2000 });
    return (r.stdout || '').trim() || null;
  } catch (e) {
    return null;
  }
}

/**
 * Why this process must not spawn a daemon for pm2Home, or null when it may.
 * @param {Object} opts { pm2Home, env?, dirs?, cgroupFile?, unitState? } (all but pm2Home for tests)
 */
function check(opts) {
  var env = opts.env || process.env;
  if (String(env.PM2_SERVICE_GUARD || '').toLowerCase() === 'off') return null;

  var service = findService(opts.pm2Home, opts);
  var runner = inRunnerJob(env);

  if (service) {
    if (insideUnit(service.unit, opts.cgroupFile)) return null;
    var state = (opts.unitState || unitState)(service.unit);
    var name = service.unit.replace(/\.service$/, '');
    var err = new Error([
      'PM2 is installed as the systemd service ' + name + ' (' + service.file + '), but its daemon is not running' +
        (state ? ' (service is ' + state + ').' : '.'),
      'Refusing to start a daemon outside the service: systemd could not supervise it' +
        (runner ? ', and the GitHub Actions runner would kill it when this job ends.' : '.'),
      'Start the service, then run the command again:',
      '  sudo systemctl start ' + name,
      '  systemctl status ' + name + '   # see why it stopped',
      'To bypass this check, set PM2_SERVICE_GUARD=off.'
    ].join('\n'));
    err.code = 'PM2_SERVICE_NOT_RUNNING';
    err.service = name;
    return err;
  }

  if (runner) {
    var rerr = new Error([
      'No PM2 daemon is running, and this is a GitHub Actions runner job.',
      'Refusing to start one here: the runner kills it (and the apps it started) when the job ends.',
      'Install PM2 as a service on this machine and start it, then run the job again:',
      '  pm2 startup     # prints the command that installs the systemd service',
      '  sudo systemctl start pm2-' + (env.USER || '<user>'),
      'To bypass this check, set PM2_SERVICE_GUARD=off.'
    ].join('\n'));
    rerr.code = 'PM2_RUNNER_NO_DAEMON';
    return rerr;
  }

  return null;
}

/**
 * `pm2 update` kills the daemon and starts a new one from the CLI, so it is blocked whenever
 * check() would block a fresh daemon. The service restart does the same job supervised.
 */
function checkUpdate(opts) {
  var env = opts.env || process.env;
  if (String(env.PM2_SERVICE_GUARD || '').toLowerCase() === 'off') return null;
  var service = findService(opts.pm2Home, opts);
  if (service && insideUnit(service.unit, opts.cgroupFile)) return null;
  if (!service && !inRunnerJob(env)) return null;
  var name = service ? service.unit.replace(/\.service$/, '') : 'pm2-' + (env.USER || '<user>');
  var err = new Error([
    service
      ? '`pm2 update` would replace the daemon of the systemd service ' + name + ' with one systemd cannot supervise.'
      : '`pm2 update` would start a new daemon inside this GitHub Actions runner job, which kills it when the job ends.',
    'Nothing has been changed. To load the installed PM2 version, restart ' + (service ? 'the service' : 'PM2 as a service') + ' instead:',
    '  pm2 save && sudo systemctl restart ' + name,
    'To bypass this check, set PM2_SERVICE_GUARD=off.'
  ].join('\n'));
  err.code = 'PM2_UPDATE_OUTSIDE_SERVICE';
  err.guard = true;
  return err;
}

/** the service that will be left stopped by `pm2 kill` from outside it, or null */
function stoppedService(opts) {
  var service = findService(opts.pm2Home, opts);
  if (!service || insideUnit(service.unit, opts.cgroupFile)) return null;
  return service.unit.replace(/\.service$/, '');
}

module.exports = {
  check: check,
  checkUpdate: checkUpdate,
  stoppedService: stoppedService,
  findService: findService,
  insideUnit: insideUnit,
  inRunnerJob: inRunnerJob
};
