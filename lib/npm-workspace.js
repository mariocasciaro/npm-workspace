// vim: noai:ts=2:sw=2
var program = require('commander'),
  fs = require('fs'),
  path = require('path'),
  when = require('when'),
  ncp = require('ncp').ncp,
  rimraf = require("rimraf"),
  through2 = require('through2'),
  spawned = require('spawned'),
  _ = require('lodash');

var DESCRIPTOR_NAME = "workspace.json";

var self = module.exports = {};

self.cli = function() {
  program
    .version(require("../package.json").version)
    .option('-c, --copy', 'Copy modules instead of linking')
    .option('-v, --verbose', 'Output verbose log')
    .option('-g, --remove-git', 'Remove .git directories during copy')
    .option('-p, --production', 'Installs only dependencies (no devDependencies)')
    .option('-l, --relative', 'Create relative symlinks for modules instead of absolute ones');

  program
    .command('install')
    .description('Install the package using local dirs')
    .action(function(){
      self.install(process.cwd()).then(function() {
        console.log('[npm-workspace] Done, happy coding!');
      }).catch(function(err) {
        console.log(err.stack + "\n[npm-workspace] Ooooops, it wasn't my fault, I swear");
      });
    });
    
  program
    .command('clean')
    .description('Clean packages')
    .action(function(){
      self.clean(process.cwd()).then(function() {
        console.log('[npm-workspace] Done, happy coding!');
      }).catch(function(err) {
        console.log(err.stack + "\n[npm-workspace] Ooooops, it wasn't my fault, I swear");
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


self.log = {
  verbose: function(message) {
    if(program.verbose) {
      console.log("[npm-workspace] " + message);
    }
  },
  info: function(message) {
    console.log("[npm-workspace] " + message);
  },
  error: function(message) {
    console.error("[npm-workspace] " + message);
  },
  log: function(message) {
    console.log(message);
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
  self.log.info("Installing workspace " + cwd);
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
    self.log.verbose("Module already processed " + realDir);
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
  
  self.ensureNodeModules(cwd);
  var nodeModulesDir = path.resolve(cwd, 'node_modules');
  
  var allDeps = _.extend({}, packageDescriptor.dependencies);
  if(!program.production) {
    _.extend(allDeps, packageDescriptor.devDependencies);
  }

  self.log.verbose("Installing direct dependencies " + JSON.stringify(_.keys(allDeps)) + " for " 
    + packageDescriptor.name + "@" + packageDescriptor.version);
  
  return self.installWorkspaceDependencies(cwd, allDeps, workspaceDescriptor, true, installed)
  .then(function() {
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
          
          if(!_.isEmpty(linkPackage.peerDependencies)) {
            //Install OR link peer dependencies
            self.log.verbose("Installing peer dependencies " +
              JSON.stringify(_.keys(linkPackage.peerDependencies)) + " from "
              + linkPackage.name + "@" + linkPackage.version + " into " + cwd);
          }
          
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

    //check peer dependendies for linked modules only (others are installed with npm install)
    return processLinked(_.pick(allDeps, _.keys(workspaceDescriptor.links)));
  }).then(function() {
    self.log.info("npm install "
      + packageDescriptor.name + "@" + packageDescriptor.version + " for " + cwd);
      
    var args = ['install'];
    if(program.production) {
      args.push('--production');
    }
    return self.npm(args, cwd);
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
  var options = {
    cwd: cwd.replace(/\\/g, "/")
  };
  options.out = through2(function(chunk, enc, cb) {
    if(program.verbose) {
      this.push(chunk);
      process.stdout.write(chunk, enc, cb);
    }
  });
  options.err = through2(function(chunk, enc, cb) {
    if(program.verbose) {
      this.push(chunk);
      process.stdout.write(chunk, enc, cb);
    }
  });

  if (process.platform === "win32") {
    args = [ (args.join(" ")) ]; // npm 2.x on Windows doesn't handle multiple argument properly?
  }

  return spawned('npm', args, options)
  .catch(function(proc) {
    console.error(proc.combined);
  });
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
 * Install (of link), in a specific module, a set of dependencies
 */
self.installWorkspaceDependencies = function(cwd, dependencies, workspaceDescriptor, linkOnly, installed) {
  dependencies = dependencies || [];
  var results = {
    linked: {},
    installed: {}
  };
  var nodeModulesDir = path.resolve(cwd, 'node_modules');
  
  var promise = when.resolve();
  _.each(dependencies, function(version, name) {
    promise = promise.then(function() {
      self.log.verbose("Processing module " + name + "@" + version + " for module " + cwd);
      var mapping = workspaceDescriptor.links[name];
      var altRepository = (workspaceDescriptor.repos || {})[name];
      var dest = path.resolve(nodeModulesDir, name);
      if(mapping) {
        self.log.verbose("Found mapping for module " + name + "@" + version);
        var promise = when.resolve();
        
        //don't override by default
        if(program.copy) {
          if(fs.existsSync(dest) && fs.lstatSync(dest).isSymbolicLink()) {
            rimraf.sync(dest);
          }
          
          if(!fs.existsSync(dest)) {
            self.log.info("[npm-workspace] Copying "+ dest +" from " + mapping);
            var deferred = when.defer();
            ncp(mapping, dest, function (err) {
              if (err) {
                return deferred.reject(err);
              }
              deferred.resolve();
            });
            promise = deferred.promise.then(function() {
              //remove .git if options say so
              if(program.removeGit) {
                self.log.info("Cleaning .git directory " + path.join(dest, '.git'));
                rimraf.sync(path.join(dest, '.git'));
                rimraf.sync(path.join(dest, '.gitignore'));
              }
              
              if(program.production) {
                rimraf.sync((path.join(dest, 'node_modules')));
              }
            });
          }
        } else if(!fs.existsSync(dest)) {
          self.log.info("Creating link "+ dest +" -> " + mapping);
          if (program.relative) {
            var relPath;
            
            /* we should assure that we are not symlinking inside a symlink ( as
               this breaks path calculations by node ).
               Ex:
                prj1 depends on prj2 that depends on prj3
                .
                ├── prj1
                │   ├── node_modules
                │   │   └── prj2 -> ../../prj2
                │   └── package.json
                ├── prj2
                │   ├── node_modules
                │   │   └── prj3 -> ../../../../prj3 ==> this is obviously wrong
                │   └── package.json
                ├── prj3
                │   └── package.json
                └── workspace.json
             */
            // if parent folder is called node_modules we can be in a linked module
            if (path.basename(path.dirname(cwd)) == 'node_modules') {
              // if we are in a module, last installed module will be our parent module, right?
              var lastInstalled = path.basename(_.last(installed));
              // search for parent module in to-be-linked modules
              var linkedParent = _.find(workspaceDescriptor.links, function(p, n) { return n === lastInstalled; });
              // if parent module is a linked module
              if (linkedParent) {
                // get current module full path
                var currentFullPath = _.find(workspaceDescriptor.links, function(p, n) { return n === name; });
                // get relative path between absolute parent module node_modules folder and current module
                relPath = path.relative(path.join(linkedParent, 'node_modules'), currentFullPath);
              }
            } else {            
              // if is not the case above simply symlink the old way
              relPath = path.relative(path.dirname(dest), mapping);
            }
            // do it
            fs.symlinkSync(relPath, dest, "dir");
          } else {
            fs.symlinkSync(mapping, dest, "dir");
          }
        }
          
        //now we make sure we fully install this linked module
        return promise.then(function() {
          return self.install(dest, installed);
        }).then(function() {
          results.linked[name] = version;
        });
        //remove if already exists
        //rimraf.sync(linkDest);
      } else if(!linkOnly || altRepository) {
        //do not install if already there
        if(!fs.existsSync(dest)) {
          var armsg = (altRepository) ? (" from "+altRepository) : ("");
          self.log.verbose("Installing single module "+ name+"@"+version+armsg);
          var installArgs = ['install', name+"@"+version];
          if (altRepository) {
            installArgs.push('--registry');
            installArgs.push(altRepository);
          }
          return self.npm(installArgs, cwd).then(function() {
            results.installed[name] = version;
          });
        } else {self.log.verbose("Already exists. Skipping "+name);}
      } else {
        self.log.verbose("Link only and no links found. Skipping "+name);
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
  self.log.info("Cleaning workspace " + cwd);
  
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
  self.log.info("Cleaning module " + cwd);
  rimraf.sync(path.resolve(cwd, 'node_modules'));
};



