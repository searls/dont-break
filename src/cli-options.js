'use strict'

var debug = require('debug')('dont-break')
function list (val) {
  return val.split(',')
}

var program = require('commander')
program
  .option('-t, --top-downloads <n>',
    'Fetch N most downloaded dependent modules, save and check', parseInt)
  .option('-s, --top-starred <n>',
    'Fetch N most starred dependent modules, save and check', parseInt)
  .option('-d, --dep <name1,name2,name3>',
    'Check if current code breaks given dependent project(s)', list)
  .option('--timeout <N seconds>',
    'Wait for N seconds when installing a package', parseInt)
  .parse(process.argv)

debug('command line options')
debug(program)

module.exports = program
