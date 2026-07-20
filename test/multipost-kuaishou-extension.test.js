'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const EXTENSION_ROOT = path.resolve(__dirname, '..', 'vendor', 'MultiPost-1.3.8');
const CONTENT_SCRIPT = path.join(EXTENSION_ROOT, 'kuaishou-account-content.js');
const BACKGROUND_SCRIPT = path.join(EXTENSION_ROOT, 'static', 'background', 'kuaishou-account-background.js');

test('extracts a Kuaishou account from the visible creator account card', () => {
  const { buildKuaishouAccount } = require(CONTENT_SCRIPT);

  assert.deepEqual(buildKuaishouAccount({
    username: '快手用户9990000000001',
    kwaiId: '',
    avatarUrl: 'https://example.com/avatar.png',
  }), {
    provider: 'kuaishou',
    accountId: '9990000000001',
    username: '快手用户9990000000001',
    description: '',
    profileUrl: 'https://cp.kuaishou.com/profile',
    avatarUrl: 'https://example.com/avatar.png',
    extraData: {
      source: 'creator-page-dom',
      kwaiId: '',
    },
  });
});

test('prefers the visible Kwai ID over the generated nickname suffix', () => {
  const { buildKuaishouAccount } = require(CONTENT_SCRIPT);
  const account = buildKuaishouAccount({
    username: '快手用户9990000000001',
    kwaiId: '快手号：real-kwai-id',
    avatarUrl: '',
  });

  assert.equal(account.accountId, 'real-kwai-id');
});

test('does not invent an account when the creator page has no visible username', () => {
  const { buildKuaishouAccount } = require(CONTENT_SCRIPT);
  assert.equal(buildKuaishouAccount({ username: '', kwaiId: '', avatarUrl: '' }), null);
});

test('merges Kuaishou into MultiPost serialized account storage', () => {
  const { mergeAccountStorage } = require(BACKGROUND_SCRIPT);
  const account = {
    provider: 'kuaishou',
    accountId: '9990000000001',
    username: '快手用户9990000000001',
  };
  const merged = mergeAccountStorage(JSON.stringify({
    douyin: { provider: 'douyin', accountId: 'dy-1', username: '抖音账号' },
  }), account);

  assert.equal(merged.kuaishou.accountId, '9990000000001');
  assert.equal(merged.douyin.accountId, 'dy-1');
});

test('extension manifest loads the account bridge and wrapper service worker', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(EXTENSION_ROOT, 'manifest.json'), 'utf8'));
  assert.equal(manifest.background.service_worker, 'static/background/multipost-service-worker.js');
  assert.ok(manifest.content_scripts.some((entry) => (
    entry.matches.includes('https://cp.kuaishou.com/*')
      && entry.js.includes('kuaishou-account-content.js')
  )));
});

test('builds a publish result only from a Kuaishou published work card', () => {
  const { buildKuaishouPublishResult } = require(CONTENT_SCRIPT);
  assert.deepEqual(buildKuaishouPublishResult({
    titleText: '问你呢，拳好看还是我好看？\n发布文案',
    status: '已发布',
    publishedAt: '2026-07-17 17:02',
  }), {
    platformKey: 'kuaishou',
    titleText: '问你呢，拳好看还是我好看？ 发布文案',
    publishedAt: '2026-07-17 17:02',
  });
  assert.equal(buildKuaishouPublishResult({
    titleText: '标题',
    status: '审核中',
    publishedAt: '2026-07-17 17:02',
  }), null);
});

test('Kuaishou extension bridge reports published results to the local worker', () => {
  const contentSource = fs.readFileSync(CONTENT_SCRIPT, 'utf8');
  const backgroundSource = fs.readFileSync(BACKGROUND_SCRIPT, 'utf8');
  assert.match(contentSource, /MULTIPOST_EXTENSION_REPORT_KUAISHOU_PUBLISH_RESULT/);
  assert.match(contentSource, /video-item--published/);
  assert.match(backgroundSource, /api\/multipost\/publish-task\/succeeded/);
});
