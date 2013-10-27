
var program = require('commander'),
  fs = require('fs'),
  path = require('path'),
  spawn = require('child_process').spawn,
  when = require('when'),
  ncp = require('ncp').ncp,
  rimraf = require("rimraf"),
  _ = require('lodash');

var DESCRIPTOR_NAME = "workspace.json";

var self = module.exports = {};

self.cli = function() {
  program
    .version(require("../package.json").version)
    .option('-c, --copy', 'Copy modules instead of linking');

  program
    .command('install')
    .description('Install the package using local dirs')
    .action(function(){
      self.install(process.cwd()).then(function() {
        console.log('[npm-workspace] Done, happy coding!');
      }).otherwise(function(err) {
        console.log(err.stack + "\n[npm-workspace] Ooooops, it wasn\'t my fault, I swear");
      });
    });
    
  program
    .command('clean')
    .description('Clean packages')
    .action(function(){
      self.clean(process.cwd()).then(function() {
        console.log('[npm-workspace] Done, happy coding!');
      }).otherwise(function(err) {
        console.log(err.stack + "\n[npm-workspace] Ooooops, it wasn\'t my fault, I swear");
      });
    });

  program
    .command('*')
    .action(function(env){
      program.help();
    });

  program.parse(process.argv);



  if (program.args.length === 0) {
    program.help();
  }
};


self.install = function(cwd, installed) {
  installed = installed || [];
  var wsDesc = self.getWorkspaceDescriptor(cwd, true, true);
  var ret = when.resolve();
  if(wsDesc) {
    ret = self.installWorkspace(cwd, installed);
  }
  var pkg = self.getPackageDescriptor(cwd, true);
  if(pkg) {
    ret = when(ret, function() {
      return self.installModule(cwd, wsDesc, pkg, installed);
    });
  }
  
  return ret;
};


self.installWorkspace = function(cwd, installed) {
  console.log("[npm-workspace] Installing workspace" + cwd);
  installed = installed || [];
  
  var promise = when.resolve();
  var files = fs.readdirSync(cwd);
  _.each(files, function(file) {
    promise = promise.then(function() {
      var fullName = path.resolve(cwd, file);
      var stat = fs.statSync(fullName);
      if(stat.isDirectory()) {
        return self.install(fullName, installed);
      }
    });
  });
  return promise;
};


/**
 * Fully install a single module (by linking modules if necessary)
 */
self.installModule = function(cwd, workspaceDescriptor, packageDescriptor, installed) {
  var realDir = self.resolveLink(cwd);
  if(_.contains(installed, realDir)) {
    console.log("[npm-workspace] Module already processed " + realDir);
    return when.resolve();
  } else {
    installed.push(realDir);
  }
  
  if(!workspaceDescriptor) {
    //get the UPPER descriptor, not the one directly in the dir
    workspaceDescriptor = self.getWorkspaceDescriptor(path.resolve(cwd, '../'));
  }
  if(!packageDescriptor) {
    packageDescriptor = self.getPackageDescriptor(cwd);
  }
  
  console.log("[npm-workspace] Processing module " + packageDescriptor.name + "@" + packageDescriptor.version);
  self.ensureNodeModules(cwd);
  var nodeModulesDir = path.resolve(cwd, 'node_modules');
  
  var allDeps = _.defaults({}, packageDescriptor.dependencies, packageDescriptor.devDependencies);

  return self.installWorkspaceDependencies(cwd, allDeps, workspaceDescriptor, true, installed)
  .then(function() {
    return self.npm(['install'], cwd).then(function() {
      
      //For the links we have to be sure we manually process the peerDependencies (recursively)
      //since they are not processed by npm
      function processLinked(deps, processed) {
        if(_.isEmpty(deps)) {
          return;
        }
        if(!processed) {
          processed = _.clone(deps);
        }
        
        var newDeps = {};
        var promise = when.resolve();
        _.each(deps, function(version, link) {
          promise = promise.then(function() {
            var linkPackage = require(path.resolve(nodeModulesDir, link, 'package.json'));
            //Install OR link peer dependencies
            return self.installWorkspaceDependencies(cwd, linkPackage.peerDependencies, workspaceDescriptor, false, installed)
            .then(function(newResults) {
              _.extend(newDeps, newResults.linked);
            });
          });
        });
        
        return promise.then(function() {
          var diff = _.omit(newDeps, _.keys(processed));
          //update the global list
          var newProcessed = _.extend({}, processed, diff);
          //process only new links
          return processLinked(diff, newProcessed);
        });
      }

      //check peer depencendies for linked modules only (others are installed with npm install)
      return processLinked(_.pick(allDeps, _.keys(workspaceDescriptor.links)));
    });
  });
};

/**
 * Resolve a symbolic link if necessary
 */
self.resolveLink = function(dir) {
  if(fs.lstatSync(dir).isSymbolicLink()) {
    return fs.readlinkSync(dir);
  }
  return dir;
};


/**
 * Launch the npm executable
 */
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


/**
 * Ensure node_modules exists
 */
self.ensureNodeModules = function(cwd) {
  var dir = path.resolve(cwd, 'node_modules');
  if(!fs.existsSync(dir)) {
    fs.mkdirSync(dir);
  }
};


/**
 * Install (of link),in a specific module, a set of dependencies
 */
self.installWorkspaceDependencies = function(cwd, dependencies, workspaceDescriptor, linkOnly, installed) {
  var results = {
    linked: {},
    installed: {}
  };
  var nodeModulesDir = path.resolve(cwd, 'node_modules');

  var promise = when.resolve();
  _.each(dependencies, function(version, name) {
    promise = promise.then(function() {
      var mapping = workspaceDescriptor.links[name];
      var dest = path.resolve(nodeModulesDir, name);
      if(mapping) {
        var destExists = fs.existsSync(dest);
        var promise = when.resolve();
        
        //don't override by default
        if(program.copy) {
          if(destExists && fs.lstatSync(dest).isSymbolicLink()) {
            rimraf.sync(dest);
          }
          
          if(!destExists) {
            console.log("[npm-workspace] Copying "+ dest +" from " + mapping);
            var deferred = when.defer();
            ncp(mapping, dest, function (err) {
              if (err) {
                return deferred.reject(err);
              }
              deferred.resolve();
            });
            promise = deferred.promise;
          }
        } else if(!destExists) {
          console.log("[npm-workspace] Creating link "+ dest +" -> " + mapping);
          fs.symlinkSync(mapping, dest);
        }
          
        //now we make sure we fully install this linked module
        return promise.then(function() {
          return self.install(dest, installed);
        }).then(function() {
          results.linked[name] = version;
        });
        //remove if already exists
        //rimraf.sync(linkDest);
      } else if(!linkOnly) {
        //do not install if already there
        if(!fs.existsSync(dest)) {
          console.log("[npm-workspace] Installing single module "+ name);
          return self.npm(['install', name], cwd).then(function() {
            results.installed[name] = version;
          });
        }
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
  _.each(descriptor.links, function(dir, modName) {
    newLinks[modName] = path.resolve(cwd, dir);
  });
  descriptor.links = newLinks;

  return descriptor;
};



self.getPackageDescriptor = function(cwd, nothrow) {
  var fileDesc = path.resolve(cwd, 'package.json');
  if(fs.existsSync(fileDesc)) {
    return require(fileDesc);
  }

  if(nothrow) {
    return null;
  } else {
    throw new Error('Cannot find package.json');
  }
  //don't go upper (for now)
};


self.getWorkspaceDescriptor = function(cwd, shallow, nothrow) {
  var fileDesc = path.resolve(cwd, DESCRIPTOR_NAME);
  if(fs.existsSync(fileDesc)) {
    return self.normalizeDescriptor(cwd, require(fileDesc));
  } else if(shallow || self.isRoot(cwd)) {
    if(nothrow) {
      return null;
    }
    throw new Error("Cannot find workspace.json");
  }

  return self.getWorkspaceDescriptor(path.resolve(cwd, '../'), shallow, nothrow);
};


self.clean = function(cwd) {
  var wsDesc = self.getWorkspaceDescriptor(cwd, true, true);
  var ret = when.resolve();
  if(wsDesc) {
    //we are in a workspace
    ret = when.resolve(self.cleanWorkspace(cwd));
  }
  
  var pkg = self.getPackageDescriptor(cwd, true);
  if(pkg) {
    //we are in a module dir
    ret = when(ret, function() {
      return self.cleanModule(cwd);
    });
  }
  
  return ret;
};


self.cleanWorkspace = function(cwd) {
  //let's be sure we are in a workspace
  if(!self.getWorkspaceDescriptor(cwd, true, true)) {
    return;
  }
  console.log("[npm-workspace] Cleaning workspace " + cwd);
  
  var files = fs.readdirSync(cwd);
  _.each(files, function(file) {
    var fullPath = path.resolve(cwd, file);
    if(fs.statSync(fullPath).isDirectory()) {
      self.cleanModule(fullPath);
    }
  });
};

self.cleanModule = function(cwd) {
  //let's be sure we are in a module
  if(!self.getPackageDescriptor(cwd, true)) {
    return;
  }
  console.log("[npm-workspace] Cleaning module " + cwd);
  rimraf.sync(path.resolve(cwd, 'node_modules'));
};



