process.env.NODE_ENV = 'test';

var PM2    = require('../..');
var should = require('should');
var fs     = require('fs');
var os     = require('os');
var path   = require('path');

process.chdir(__dirname);

// prodman: cluster workers start in the app's cwd, so node_args like `--import <package>`
// resolve from the app's node_modules rather than from the daemon's directory
describe('Cluster mode worker cwd', function() {
  this.timeout(20000);

  var pm2 = new PM2.custom({ cwd: __dirname });
  var app = fs.mkdtempSync(path.join(os.tmpdir(), 'pm2-clucwd-'));
  var marker = path.join(app, 'loaded-from');

  before(function() {
    // a package only resolvable from the app directory
    var pkgDir = path.join(app, 'node_modules', 'cwd-probe-loader');
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: 'cwd-probe-loader', main: 'index.js' }));
    fs.writeFileSync(path.join(pkgDir, 'index.js'),
      "require('fs').writeFileSync(" + JSON.stringify(marker) + ", process.cwd())\n");
    fs.writeFileSync(path.join(app, 'app.js'), 'setInterval(function() {}, 1000)\n');
  });

  after(function(done) {
    pm2.delete('all', function() {
      pm2.kill(function() {
        fs.rmSync(app, { recursive: true, force: true });
        done();
      });
    });
  });

  it('resolves --import from the app directory', function(done) {
    pm2.start({
      script    : path.join(app, 'app.js'),
      name      : 'clucwd',
      cwd       : app,
      exec_mode : 'cluster',
      instances : 1,
      node_args : ['--import', 'cwd-probe-loader']
    }, function(err) {
      should(err).be.null();
      setTimeout(function() {
        pm2.list(function(err, list) {
          var proc = list.filter(function(p) { return p.name === 'clucwd'; })[0];
          proc.pm2_env.status.should.eql('online');
          proc.pm2_env.restart_time.should.eql(0);
          fs.realpathSync(fs.readFileSync(marker, 'utf8')).should.eql(fs.realpathSync(app));
          done();
        });
      }, 2000);
    });
  });
});
