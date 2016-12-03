'use strict'

const la = require('lazy-ass')
const check = require('check-more-types')
var path = require('path')
const osTmpdir = require('os-tmpdir')
var join = path.join
var quote = require('quote')
const chdir = require('chdir-promise')
var banner = require('./banner')
const debug = require('debug')('dont-break')
const isRepoUrl = require('./is-repo-url')

const _ = require('lodash')
const q = require('q')

const npmInstall = require('npm-utils').install
const npmTest = require('npm-utils').test
la(check.fn(npmTest), 'npm test should be a function', npmTest)

var fs = require('fs')
var read = fs.readFileSync
var exists = fs.existsSync

var stripComments = require('strip-json-comments')
// write found dependencies into a hidden file
const dontBreakFilename = './.dont-break.json'

const DEFAULT_TEST_COMMAND = 'npm test'
const INSTALL_TIMEOUT_SECONDS = 10

const install = require('./install-dependency')

function readJSON (filename) {
  la(exists(filename), 'cannot find JSON file to load', filename)
  return JSON.parse(read(filename))
}

const npm = require('top-dependents')
la(check.schema({
  downloads: check.fn,
  sortedByDownloads: check.fn,
  topDependents: check.fn
}, npm), 'invalid npm methods', npm)

function saveTopDependents (name, metric, n) {
  la(check.unemptyString(name), 'invalid package name', name)
  la(check.unemptyString(metric), 'invalid metric', metric)
  la(check.positiveNumber(n), 'invalid top number', n)

  var fetchTop = _.partial(npm.downloads, metric)
  return q(npm.topDependents(name, n))
    .then(fetchTop)
    .then(npm.sortedByDownloads)
    .then(function (dependents) {
      la(check.array(dependents), 'cannot select top n, not a list', dependents)
      console.log('limiting top downloads to first', n, 'from the list of', dependents.length)
      return _.take(dependents, n)
    })
    .then(function saveToFile (topDependents) {
      la(_.isArray(topDependents), 'expected list of top strings', topDependents)
      // TODO use template library instead of manual concat
      var str = '// top ' + n + ' most dependent modules by ' + metric + ' for ' + name + '\n'
      str += '// data from NPM registry on ' + (new Date()).toDateString() + '\n'
      str += JSON.stringify(topDependents, null, 2) + '\n'
      return q.ninvoke(fs, 'writeFile', dontBreakFilename, str, 'utf-8').then(function () {
        console.log('saved top', n, 'dependents for', name, 'by', metric, 'to', dontBreakFilename)
        return topDependents
      })
    })
}

function getDependentsFromFile () {
  return q.ninvoke(fs, 'readFile', dontBreakFilename, 'utf-8')
    .then(stripComments)
    .then(text => {
      debug('loaded dependencies file', text)
      return text
    })
    .then(JSON.parse)
    .catch(function (err) {
      // the file does not exist probably
      console.log(err && err.message)
      console.log('could not find file', quote(dontBreakFilename), 'in', quote(process.cwd()))
      console.log('no dependent projects, maybe query NPM for projects that depend on this one.')
      return []
    })
}

function getDependents (options, name) {
  options = options || {}
  var forName = name

  if (!name) {
    var pkg = require(join(process.cwd(), 'package.json'))
    forName = pkg.name
  }

  var firstStep

  var metric, n
  if (check.number(options.topDownloads)) {
    metric = 'downloads'
    n = options.topDownloads
  } else if (check.number(options.topStarred)) {
    metric = 'starred'
    n = options.topStarred
  }
  if (check.unemptyString(metric) && check.number(n)) {
    firstStep = saveTopDependents(forName, metric, n)
  }

  return q(firstStep).then(getDependentsFromFile)
}

function testInFolder (testCommand, folder) {
  la(check.unemptyString(testCommand), 'missing test command', testCommand)
  la(check.unemptyString(folder), 'expected folder', folder)
  var cwd = process.cwd()
  process.chdir(folder)
  return npmTest(testCommand).then(function () {
    console.log('tests work in', folder)
    return folder
  })
  .catch(function (errors) {
    console.error('tests did not work in', folder)
    console.error('code', errors.code)
    throw errors
  })
  .finally(function () {
    process.chdir(cwd)
  })
}

function testCurrentModuleInDependent (dependentFolder) {
  la(check.unemptyString(dependentFolder), 'expected dependent folder', dependentFolder)

  debug('testing the current module in %s', dependentFolder)
  const thisFolder = process.cwd()
  debug('current module folder %s', thisFolder)

  const options = {
    name: thisFolder
  }

  return chdir.to(dependentFolder)
    .then(() => npmInstall(options))
    .then(() => {
      console.log('Installed\n %s\n in %s', thisFolder, dependentFolder)
    })
    .finally(chdir.from)
    .then(() => {
      return dependentFolder
    })
}

function getDependency (dependent) {
  if (_.isString(dependent)) {
    return {
      name: dependent,
      repoUrl: isRepoUrl(dependent) ? dependent : undefined,
      command: DEFAULT_TEST_COMMAND
    }
  } else {
    return {
      name: dependent.name,
      repoUrl: dependent.repoUrl,
      command: dependent.command || DEFAULT_TEST_COMMAND
    }
  }
}

function testDependent (options, dependent) {
  la(check.unemptyString(dependent.name), 'invalid dependent', dependent.name)
  banner('  testing', quote(dependent.name))

  function formFullFolderName () {
    if (dependent.repoUrl) {
      // simple repo installation
      return toFolder
    } else {
      // it was NPM install
      return join(toFolder, 'lib', 'node_modules', dependent.name)
    }
  }

  var testModuleInFolder = _.partial(testInFolder, dependent.command)

  const pkg = require(join(process.cwd(), 'package.json'))
  const depName = pkg.name + '-v' + pkg.version + '-against-' + dependent.name
  const safeName = _.kebabCase(_.deburr(depName))
  debug('original name "%s", safe "%s"', depName, safeName)
  const toFolder = join(osTmpdir(), safeName)
  console.log('testing folder %s', quote(toFolder))

  const timeoutSeconds = options.timeout || INSTALL_TIMEOUT_SECONDS
  la(check.positiveNumber(timeoutSeconds), 'wrong timeout', timeoutSeconds, options)

  const installOptions = {
    name: dependent.repoUrl || dependent.name,
    prefix: toFolder
  }
  return install(installOptions)
    .timeout(timeoutSeconds * 1000, 'install timed out for ' + dependent.name)
    .then(formFullFolderName)
    .then(function checkInstalledFolder (folder) {
      la(check.unemptyString(folder), 'expected folder', folder)
      la(exists(folder), 'expected folder to exist', folder)
      return folder
    })
    .then(function printMessage (folder) {
      var installedPackage = readJSON(join(folder, 'package.json'))
      var moduleVersion = installedPackage.version
      var currentVersion = installedPackage.dependencies[pkg.name] ||
        installedPackage.devDependencies[pkg.name]
      banner('installed', dependent.name + '@' + moduleVersion,
        '\ninto', folder,
        '\ncurrently uses', pkg.name + '@' + currentVersion,
        '\nwill test', pkg.name + '@' + pkg.version)
      return folder
    })
    .then(function installDependencies (folder) {
      console.log('installing dev dependencies', folder)
      var cwd = process.cwd()
      process.chdir(folder)
      return install({}).then(function () {
        console.log('restoring current directory', cwd)
        process.chdir(cwd)
        return folder
      }, function (err) {
        console.error('Could not install dependencies in', folder)
        console.error(err)
        throw err
      })
    })
    .then(testModuleInFolder)
    .then(testCurrentModuleInDependent)
    .then(testModuleInFolder)
}

function testDependents (options, dependents) {
  la(check.array(dependents), 'expected dependents', dependents)

  // TODO switch to parallel testing!
  return dependents.reduce(function (prev, dependent) {
    return prev.then(function () {
      return testDependent(options, dependent)
    })
  }, q(true))
}

function dontBreakDependents (options, userDependents) {
  la(_.isArray(userDependents), 'invalid dependents', userDependents)
  debug('dependents', userDependents)

  var dependents = _.map(userDependents, getDependency)
  banner('  testing the following dependents\n  ' + _.map(dependents, 'name').join(', '))

  const logSuccess = function logSuccess () {
    console.log('all dependents tested')
  }

  return testDependents(options, dependents)
    .then(logSuccess)
}

function dontBreak (options) {
  if (check.unemptyString(options)) {
    options = {
      folder: options
    }
  }
  options = options || {}
  options.folder = options.folder || process.cwd()

  debug('working in folder %s', options.folder)
  var start = chdir.to(options.folder)

  if (_.isArray(options.dep)) {
    start = start.then(function () {
      return options.dep
    })
  } else {
    start = start.then(function () {
      debug('getting dependents')
      return getDependents(options)
    })
  }

  const logPass = function logPass () {
    console.log('PASS: Current version does not break dependents')
    return true
  }

  const logFail = function logFail (err) {
    console.log('FAIL: Current version breaks dependents')
    if (err && err.message) {
      console.error('REPORTED ERROR:', err.message)
      if (err.stack) {
        console.error(err.stack)
      }
    }
    return false
  }

  return start
    .then(_.partial(dontBreakDependents, options))
    .then(logPass, logFail)
    .finally(chdir.from)
}

module.exports = dontBreak
