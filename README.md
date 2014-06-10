[![NPM version](https://badge.fury.io/js/npm-workspace.png)](http://badge.fury.io/js/npm-workspace)
[![Build Status](https://travis-ci.org/mariocasciaro/npm-workspace.png)](https://travis-ci.org/mariocasciaro/npm-workspace)
[![Dependency Status](https://gemnasium.com/mariocasciaro/npm-workspace.png)](https://gemnasium.com/mariocasciaro/npm-workspace)

# Synopsis

A command line utility to ease the `link`-ing of local npm modules,
especially when `link`-ing modules with `peerDependencies`.

## This is for you if

In short, if you use `npm link` a lot.

Alternatively, if:

- When developing, you put all your npm modules in a directory, aka **workspace**, and you expect they will link together magically.
- You have a number of **private** npm and you use `npm link` to link them together.
- You have **local working copies** fo your public npm modules, but you prefer to `link` them when developing.
- You also have **peerDependencies**, and `npm link` doesn't exactly work well with that.
- You ended up writing a shell script to handle any of the above, but you are not satisfied with the results.

## Install

```
npm install -g npm-workspace
```

## Typical use case

```sh
myNodeJsWorkspace
├── prj1
│   ├── lib
│   └── package.json
├── prj2
│   ├── src
│   └── package.json
├── prj3
│   ├── index.js
│   └── package.json
└── workspace.json
```

With:
```
{
  "name": "prj1",
  "version": "0.0.1",
  "private": "true",
  "dependencies": {
    "request": "~2.26.0",       <- A "normal" dependency
    "prj2": "0.0.1"             <- A local dependency, want to npm link that
  }
}
```

```
{
  "name": "prj2",
  "version": "0.0.1",
  "peerDependencies": {
    "underscore": "~1.5.1",     <- Normal peer dependency, this WILL NOT be installed
                                    in your parent module, if you 'npm link' 
                                    this package (prj2)
    "prj3": "0.0.1"             <- Local peer dependency, this WILL NOT be installed
                                    in your parent module, if you 'npm link' 
                                    this package (prj2)
  }
}
```

```
{
  "name": "prj3",
  "version": "0.0.1",
  "peerDependencies": {
    "optimist": "~0.6.0",       <- This becomes a nested peerDependencies
                                    if you consider that prj1->prj2->prj3
  }
}
```

Now **instead** of doing this

```sh
cd myNodeJsWorkspace
cd prj3
npm link
cd ../prj2
npm link
cd ../prj1
npm link prj2
npm link prj3
npm install underscore
npm install optimist
npm install
```

you can just...

## The magic part

Create a `workspace.json` in your workspace dir, and create mappings `module name -> module dir`
```sh
{
  "links": {
    "prj2": "prj2",
    "prj3": "prj3"
  }
}
```

Then

### To install and link everything in your workspace
```sh
cd myNodeJsWorkspace
npm-workspace install
```

### To install and link only one module
```sh
cd myNodeJsWorkspace/prj1
npm-workspace install
```

### To clean your workspace (remove all node_modules directories)
```sh
cd myNodeJsWorkspace
npm-workspace clean
```

## Package an app for deployment

When you are ready to deploy youtr app, you can package all your modules for production, including all your private/local only modules. Just use these 3 options:

* `-c`: Copy the packages into `node_modules` instead of linking them
* `-g`: Remove `.git` directories from dependencies while copying. This is so you can package your production app under a new repo (e.g. for use in a PaaS)
* `-p`: Installs only production dependencies (ignores `devDependencies`)

__Example__
```sh
cd myNodeJsWorkspace/yourapp
npm-workspace install -cgp
```

Your app is now ready for deployment.


## Under the hood

- It finds and parse the links from the nearest `workspace.json` up in the current directory tree.
- For each module:
    - If a link was specified in `workspace.json`: creates a **local symbolic link** (as opposed to `npm link` that creates a global link) for each matching module in `dependencies` and  `devDependencies`
    - Otherwise, `npm install` all the remaining modules
- For each module linked, install or link its `peerDependencies` (recursively)

## This is NOT

- The ultimate solution to your Node.js development workflow/private modules/deployment/etc/etc/etc/

