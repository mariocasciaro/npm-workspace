


var expect = require('chai').expect,
  npm_workspace = require('../lib/npm-workspace'),
  fs = require('fs'),
  path = require('path');

var NPM_WORKSPACE_EXE = path.resolve(__dirname, "../bin/npm-workspace");

describe('npm-workspace link', function() {

  it('should link modules dirs', function(done) {
    var prjRoot = __dirname + "/fixtures/basicLink/prj1";
    npm_workspace.install(prjRoot).then(function() {
      expect(fs.existsSync(prjRoot + "/node_modules/prj2")).to.be.true;
      done();
    }).otherwise(done);
  });
});