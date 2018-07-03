#!/usr/bin/env node

process.env.ENV = 'test';

const startup = require('@travetto/base/bin/travetto');

if (process.env.EXECUTION) {
  process.env.NO_WATCH = true;
  require('../src/runner/communication').server();
} else {
  startup.run().then(x => {
    const { Runner } = require('../src/runner');
    new Runner(process.argv.slice(2)).run().then(x => process.exit(0), e => process.exit(1));
  }).catch(err => {
    console.error(err);
    process.exit(1);
  });
}