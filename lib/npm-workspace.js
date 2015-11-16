// vim: noai:ts=2:sw=2
var program = require('commander'),
  fs = require('fs'),
  path = require('path'),
  when = require('when'),
  ncp = require('ncp').ncp,
  rimraf = require("rimraf"),
  through2 = require('through2'),
  spawned = require('spawned'),
  child_process = require('child_process');
  _ = require('lodash');

var DESCRIPTOR_NAME = "workspace.json";

var npm_major_version = 0;
var self = module.exports = {};

self.cli = function() {
  program
    .version(require("../package.json").version)
    .option('-c, --copy', 'Copy modules instead of linking')
    .option('-v, --verbose', 'Output verbose log')
    .option('-g, --remove-git', 'Remove .git directories during copy')
    .option('-p, --production', 'Installs only dependencies (no devDependencies)')
    .option('-r, --recursive', 'Follow all subdirectory paths for modules');

  program
    .command('install')
    .description('Install the package using local dirs')
    .action(function(){
      try {
        npm_major_version = +child_process.execSync('npm -v',{encoding:'utf8'}).split('.')[0];
      } catch (err) {
        console.log('[npm-workspace] Could not read npm version. Is npm in your path? '+err);
      }

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
  var files = self.descendantsExcludingNpmModules(cwd, program.recursive);
  _.each(files, function(file) {
    promise = promise.then(function() {
      return self.install(file, installed);
    });
  });
  return promise;
};

function onlyDirectories(f){return fs.statSync(f).isDirectory();}
function noDotFolders(f){return path.basename(f).indexOf('.') !== 0;}
function resolveTo(dir){return function(file) {return path.resolve(dir, file);};}
function flatten(arr) {
  return arr.reduce(function (flat, toFlatten) {
    return flat.concat(Array.isArray(toFlatten) ? flatten(toFlatten) : toFlatten);
  }, []);
}

self.descendantsExcludingNpmModules = function descendantsExcludingNpmModules(cwd, recurse) {
  if (["node_modules", "bower_components"].indexOf(path.basename(cwd)) > -1) return []; // skip very common package manager stores
  if (path.basename(cwd).indexOf('.') == 0) return []; // skip hidden directories

  var files = fs.readdirSync(cwd).map(resolveTo(cwd)).filter(onlyDirectories).filter(noDotFolders);
  if (files.length < 1) return [];
  if (recurse && files.length > 0) {
    _.each(files, function(file) {
      if (typeof (file) == 'string'){
        files.push(descendantsExcludingNpmModules(file, recurse));
      }
    });
  }
  return flatten(files); // flatten tree into simple list
}


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
  
  return self.installWorkspaceDependencies(cwd, allDeps, workspaceDescriptor, installed)
  .then(function() {
    // skip deep peer dependencies if doing a production install
    if (program.production) return;

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
          var pkgPath = path.resolve(nodeModulesDir, link, 'package.json');
          if (!fs.existsSync(pkgPath)) { throw new Error('Invalid package at '+pkgPath); }
          var linkPackage = require(pkgPath);
          
          if(!_.isEmpty(linkPackage.peerDependencies)) {
            //Install OR link peer dependencies
            self.log.verbose("Installing peer dependencies " +
              JSON.stringify(_.keys(linkPackage.peerDependencies)) + " from "
              + linkPackage.name + "@" + linkPackage.version + " into " + cwd);
          }
          
          return self.installWorkspaceDependencies(cwd, linkPackage.peerDependencies, workspaceDescriptor, installed)
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

    //check peer dependencies for linked modules only
    return processLinked(_.pick(allDeps, _.keys(workspaceDescriptor.links)));
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

// splits each property of the dependencies object into its own object in an array
// i.e. {'a':1, 'b':2} becomes [{'name':'a','version':1},{'name':'b', 'version':2}]
function repack(obj) {
  var outp = [];
  Object.keys(obj||{}).forEach(function(k){
    outp.push({name:k, version:obj[k]});
  });
  return outp;
}


/**
 * Install (or link), in a specific module, a set of dependencies
 */
self.installWorkspaceDependencies = function(cwd, dependencies, workspaceDescriptor, installed) {
  dependencies = repack(dependencies);
  var links = workspaceDescriptor.links || {};
  var repos = workspaceDescriptor.repos || {};
  var results = {
    linked: {},
    installed: {}
  };
  var nodeModulesDir = path.resolve(cwd, 'node_modules');

  // group dependencies by kind, and add some extra meta data.
  var linkDependencies = [];
  var specialRepoDeps  = [];

  dependencies.forEach(function(spec){
    var dest = path.resolve(nodeModulesDir, spec.name);
    if (links[spec.name]) {
      linkDependencies.push({name:spec.name, version:spec.version, mapping:links[spec.name], dest:dest});
    } else if (repos[spec.name]) {
      specialRepoDeps.push({name:spec.name, version:spec.version, altRepository:repos[spec.name], dest:dest});
    }
  });

  // To maintain compatibility with all npm versions up to 3, we do some odd things here
  // (1) add packages from special repos
  // (2) add dummy packages for anything that will be linked
  // (3) do a normal `npm i`
  // (4) remove the dummy packages and do the link/copy for real.

  var promise = when.resolve();

  // (1) add each of the special repo deps one-by-one
  specialRepoDeps.forEach(function(item) {
    promise = promise.then(function() {
      self.log.verbose("Installing single module "+ item.name+
        "@"+item.version+" from "+item.altRepository + " for module " + cwd);

      if(fs.existsSync(item.dest)) return self.log.verbose("Already exists. Skipping "+item.name);

      var installArgs = ['install', item.name+'@"'+item.version+'"'];
      installArgs.push('--registry');
      installArgs.push(item.altRepository);

      return self.npm(installArgs, cwd).then(function() {
        results.installed[item.name] = item.version;
      });
    });
  });

  // (2) add a dummy package for any links
  linkDependencies.forEach(function(item) {
    promise = promise.then(function() {
      self.log.verbose("Stubbing mapped module " + item.name + "@" + item.version + " for module " + cwd);
      var exists = fs.existsSync(item.dest);
      var pkgIsSymLink = exists && fs.lstatSync(item.dest).isSymbolicLink();

      if (!exists || pkgIsSymLink) {
        if(pkgIsSymLink) { rimraf.sync(item.dest); }

        fs.mkdirSync(item.dest);
        var realPkg = path.join(item.mapping, 'package.json');
        var stubPkg = path.join(item.dest, 'package.json');
        if (npm_major_version >= 3) {// make fake package in stub
          fs.writeFileSync(stubPkg, '{}', 'utf8'); 
        } else {// copy real package into stub (required for npm < 3)
          fs.writeFileSync(stubPkg, fs.readFileSync(realPkg), 'utf8');
        }
        fs.writeFileSync(path.join(item.dest, 'npm-workspace-stub'), '');
      }
    });
  });


  // (3) install all the normal packages
  promise = promise.then(function() {
    self.log.info("npm install for " + cwd);
      
    var args = ['install'];
    if(program.production) {
      args.push('--production');
    }

    return self.npm(args, cwd);
  })

  // (4) finally link modules and install sub-dependencies.
  linkDependencies.forEach(function(item) {
    promise = promise.then(function() {
      self.log.verbose("Processing mapped module " + item.name + "@" + item.version + " for module " + cwd);
      var exists = fs.existsSync(item.dest);
      var pkgIsSymLink = exists && fs.lstatSync(item.dest).isSymbolicLink();

      //don't override by default
      if(program.copy) {
        // remove any existing symlinks
        if(pkgIsSymLink) { rimraf.sync(item.dest); }
        
        // Check to see if this is a stub package. If so, delete and continue with the copy
        var stubMarker = path.join(item.dest, 'npm-workspace-stub');
        if(exists && fs.existsSync(stubMarker)) {
          rimraf.sync(item.dest);
        }

        // copy if not already present
        if(!fs.existsSync(item.dest)) {
          self.log.info("Copying "+ item.dest +" from " + item.mapping);
          var deferred = when.defer();
          var copy = when.promise(function(resolve, reject){
            ncp(item.mapping, item.dest, function (err) {
              if (err) {
                return reject(err);
              }
              //remove .git if options say so
              if(program.removeGit) {
                self.log.info("Cleaning .git directory " + path.join(item.dest, '.git'));
                rimraf.sync(path.join(item.dest, '.git'));
                rimraf.sync(path.join(item.dest, '.gitignore'));
              }
              resolve();
            });
          });
          return copy;
        }
      } else if(/*not a copy, and */!pkgIsSymLink) {
        rimraf.sync(item.dest); // remove dummy package

        fs.symlinkSync(item.mapping, item.dest, "dir");
        self.log.info("Created link "+ item.dest +" -> " + item.mapping);
      }

      //now we make sure we fully install this linked module
    }).then(function() {
      return self.install(item.dest, installed); // Future : only do this if we haven't seen it before
    }).then(function() {
      results.linked[item.name] = item.version;
    });
  });

  // All install promises hooked up, return them to be run
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

// read the 'package.json' file in the current directory
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

// recurse up from current location to find 'workspace.json'
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

function longestFirst(a,b){return b.length - a.length;}

self.cleanWorkspace = function(cwd) {
  //let's be sure we are in a workspace
  if(!self.getWorkspaceDescriptor(cwd, true, true)) {
    return;
  }
  self.log.info("Cleaning workspace " + cwd);
  
  var files = self.descendantsExcludingNpmModules(cwd, program.recursive);
  files.sort(longestFirst); // less likely to break symlinks on Windows.

  _.each(files, function(file) {
    self.cleanModule(file);
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



