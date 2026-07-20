'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { resolveLarkCli } = require('../src/lark-cli');

test('resolveLarkCli honors LARK_CLI_PATH', () => {
  const target = path.resolve('tools', 'lark-cli.js');
  const resolved = resolveLarkCli({
    env: { LARK_CLI_PATH: target },
    existsSync: (candidate) => candidate === target,
  });
  assert.equal(resolved.command, process.execPath);
  assert.deepEqual(resolved.prefixArgs, [target]);
});
test('resolveLarkCli prefers the project-local package', () => {
  const root = path.resolve('portable-project');
  const local = path.join(root, 'node_modules', '@larksuite', 'cli', 'scripts', 'run.js');
  const resolved = resolveLarkCli({ root, env: {}, existsSync: (candidate) => candidate === local });
  assert.deepEqual(resolved.prefixArgs, [local]);
});

test('resolveLarkCli gives an actionable error when unavailable', () => {
  assert.throws(
    () => resolveLarkCli({ env: {}, existsSync: () => false, globalRoots: [] }),
    /npm install.*@larksuite\/cli|LARK_CLI_PATH/,
  );
});
