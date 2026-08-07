'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

let refreshDouyinAccount;
try {
  ({ refreshDouyinAccount } = require('../vendor/MultiPost-1.3.8/static/background/douyin-account-background'));
} catch {}

test('Douyin and Kuaishou account bridges can load in the same extension service worker', () => {
  const backgroundDir = path.join(
    __dirname,
    '..',
    'vendor',
    'MultiPost-1.3.8',
    'static',
    'background',
  );
  const context = vm.createContext({
    console,
    module: { exports: {} },
  });

  assert.doesNotThrow(() => {
    vm.runInContext(
      fs.readFileSync(path.join(backgroundDir, 'kuaishou-account-background.js'), 'utf8'),
      context,
      { filename: 'kuaishou-account-background.js' },
    );
    vm.runInContext(
      fs.readFileSync(path.join(backgroundDir, 'douyin-account-background.js'), 'utf8'),
      context,
      { filename: 'douyin-account-background.js' },
    );
  });
});

test('refreshes the current Douyin login instead of returning the cached account', async () => {
  assert.equal(typeof refreshDouyinAccount, 'function');

  let storedValue = JSON.stringify({
    douyin: {
      provider: 'douyin',
      accountId: 'cached-account',
      username: '缓存账号',
    },
    kuaishou: {
      provider: 'kuaishou',
      accountId: 'kuaishou-account',
      username: '快手账号',
    },
  });
  const storage = {
    async get(key) {
      return { [key]: storedValue };
    },
    async set(values) {
      storedValue = values.multipost_account_info;
    },
  };
  const fetchImpl = async () => ({
    ok: true,
    async json() {
      return {
        user: {
          sec_uid: 'current-account',
          nickname: '当前账号',
          signature: '简介',
          avatar_larger: { url_list: ['https://example.com/avatar.png'] },
        },
      };
    },
  });

  const result = await refreshDouyinAccount({ fetchImpl, storage });
  const stored = JSON.parse(storedValue);

  assert.equal(result.account.accountId, 'current-account');
  assert.equal(result.account.username, '当前账号');
  assert.equal(result.accountInfo.douyin.accountId, 'current-account');
  assert.equal(stored.douyin.accountId, 'current-account');
  assert.equal(stored.kuaishou.accountId, 'kuaishou-account');
});

test('does not report a valid Douyin account when the live session is logged out', async () => {
  assert.equal(typeof refreshDouyinAccount, 'function');

  let storedValue = JSON.stringify({
    douyin: {
      provider: 'douyin',
      accountId: 'cached-account',
      username: '缓存账号',
    },
    kuaishou: {
      provider: 'kuaishou',
      accountId: 'kuaishou-account',
      username: '快手账号',
    },
  });
  const storage = {
    async get(key) {
      return { [key]: storedValue };
    },
    async set(values) {
      storedValue = values.multipost_account_info;
    },
  };
  const fetchImpl = async () => ({
    ok: true,
    async json() {
      return { user: null };
    },
  });

  const result = await refreshDouyinAccount({ fetchImpl, storage });

  assert.deepEqual(result.accountInfo, {});
  assert.equal(result.account, null);
  assert.match(result.error, /未登录/);
  assert.equal(JSON.parse(storedValue).douyin, undefined);
  assert.equal(JSON.parse(storedValue).kuaishou.accountId, 'kuaishou-account');
});
