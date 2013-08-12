
var program = require('commander'),
  fs = require('fs'),
  path = require('path'),
  rimraf = require("rimraf"),
  spawn = require('child_process').spawn,
  when = require('when'),
  _ = require('lodash');

var DESCRIPTOR_NAME = "workspace.json";

var self = module.exports = {};

self.cli = function() {
  program
    .version('0.0.1')
    .option('-C, --chdir <path>', 'change the working directory');

  program
    .command('install')
    .description('Install the package using local dirs')
    .action(function(){
      self.install(process.cwd()).then(function() {
        console.log('[npm-workspace] Done, happy coding!');
      }).otherwise(function() {
        console.log('[npm-workspace] Ooooops, it wasn\'t my fault, I swear');
      });
    });

  program.parse(process.argv);
};


self.install = function(cwd, workspaceDescriptor) {
  console.log("[npm-workspace] Installing " + cwd);
  if(!workspaceDescriptor) {
    workspaceDescriptor = self.getWorkspaceDescriptor(cwd);
  }
  self.ensureNodeModules(cwd);
  var nodeModulesDir = path.resolve(cwd, 'node_modules');
  var pkg = self.getPackageDescriptor(cwd);

  return self.installWorkspacePackages(cwd, pkg.dependencies, workspaceDescriptor, true)
  .then(function(installResults) {
    return self.npm(['install'], cwd).then(function() {
      //check peer depencendies for linked modules only (others are installed with npm install)

      function processLinked(deps) {
        if(_.isEmpty(deps)) {
          return;
        }
        var newDeps = [];
        var promise = when.resolve();
        _.each(deps, function(link) {
          promise = promise.then(function() {
            var linkPackage = require(path.resolve(nodeModulesDir, link, 'package.json'));
            return self.installWorkspacePackages(cwd, linkPackage.peerDependencies, workspaceDescriptor)
            .then(function(newResults) {
              Array.prototype.push.apply(newDeps, newResults.linked);
            });
          });
        });
        return promise.then(function() {
          return processLinked(newDeps);
        });
      }

      return processLinked(installResults.linked);
    });
  });
};


self.npm = function(args, cwd) {
  var deferred = when.defer();
  var npm = spawn('npm', args, {cwd: cwd});
  npm.stdout.pipe(process.stdout);
  npm.stderr.pipe(process.stderr);
  npm.on('close', function (code) {
    if(code !== 0) {
      deferred.reject(code);
    } else {
      deferred.resolve(code);
    }
  });

  return deferred.promise;
};


self.ensureNodeModules = function(cwd) {
  var dir = path.resolve(cwd, 'node_modules');
  if(!fs.existsSync(dir)) {
    fs.mkdirSync(dir);
  }
};



self.installWorkspacePackages = function(cwd, dependencies, workspaceDescriptor, linkOnly) {
  var results = {
    linked: [],
    installed: []
  };
  var nodeModulesDir = path.resolve(cwd, 'node_modules');

  var promise = when.resolve();
  _.each(dependencies, function(version, name) {
    promise = promise.then(function() {
      var mapping = workspaceDescriptor.links[name];
      if(mapping) {
        var linkDest = path.resolve(nodeModulesDir, name);

        //don't override by default
        if(!fs.existsSync(linkDest)) {
          console.log("[npm-workspace] Creating link "+ linkDest +" -> " + mapping);
          fs.symlinkSync(mapping, linkDest);
          //now we make sure we fully install this linked module
          return self.install(linkDest).then(function() {
            results.linked.push(name);
          });
        }
        //remove if already exists
        //rimraf.sync(linkDest);
      } else if(!linkOnly) {
        return self.npm(['install', name], cwd).then(function() {
          results.installed.push(name);
        });
      }
    });
  });

  return promise.then(function() {
    return results;
  });
};



self.isRoot = function(root) {
  return path.resolve('/') === path.resolve(root);
};



self.normalizeDescriptor = function(cwd, descriptor) {
  descriptor = _.cloneDeep(descriptor);

  //resolve dirs for the the "link" property
  var newLinks = {};
  _.each(descriptor.links, function(modName, dir) {
    newLinks[modName] = path.resolve(cwd, dir);
  });
  descriptor.links = newLinks;

  return descriptor;
};



self.getPackageDescriptor = function(cwd) {
  var fileDesc = path.join(cwd, 'package.json');
  if(fs.existsSync(fileDesc)) {
    return require(fileDesc);
  }

  throw new Error('Cannot find package.json');
  //don't go upper (for now)
};


self.getWorkspaceDescriptor = function(cwd) {
  var fileDesc = path.join(cwd, DESCRIPTOR_NAME);
  if(fs.existsSync(fileDesc)) {
    return self.normalizeDescriptor(cwd, require(fileDesc));
  }

  if(self.isRoot(cwd)) {
    throw new Error("Cannot find workspace.json");
  }

  return self.getWorkspaceDescriptor(path.resolve(cwd, '../'));
};
