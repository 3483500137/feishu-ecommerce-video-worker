'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('media relay installer clears a queued registration before its explicit start', () => {
  const script = fs.readFileSync(
    path.resolve(__dirname, '..', 'scripts', 'install-media-relay.ps1'),
    'utf8',
  );
  const registerIndex = script.indexOf('Register-ScheduledTask');
  const stopIndex = script.indexOf('Stop-ScheduledTask');
  const startIndex = script.indexOf('Start-ScheduledTask');

  assert.ok(registerIndex >= 0, 'installer must register the task');
  assert.ok(stopIndex > registerIndex, 'installer must clear the registration queue after registering');
  assert.ok(startIndex > stopIndex, 'installer must start only after the queued instance is cleared');
});
