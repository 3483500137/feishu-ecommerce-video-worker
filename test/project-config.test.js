'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadConfig, resolveConfigPath, validateConfig } = require('../src/project-config');

test('loadConfig returns portable defaults when config file is absent', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-cloner-config-'));
  const config = loadConfig({ root });
  assert.equal(config.kimi_base_url, 'https://api.moonshot.cn/v1');
  assert.equal(config.xyq_base_url, 'https://xyq.jianying.com');
  assert.equal(config.yt_dlp_command, 'yt-dlp');
});

test('resolveConfigPath supports an explicit environment override', () => {
  const root = path.join('tmp', 'project');
  const selected = resolveConfigPath({ root, env: { FEISHU_ACCOUNT_CLONER_CONFIG: 'D:\\safe\\custom.json' } });
  assert.equal(selected, path.resolve('D:\\safe\\custom.json'));
});

test('validateConfig reports field names without exposing secret values', () => {
  const errors = validateConfig({ base_token: 'your_feishu_base_token' }, { features: ['core'], env: {} });
  assert.ok(errors.some((message) => message.includes('base_token')));
  assert.ok(errors.some((message) => message.includes('KIMI_API_KEY')));
  assert.equal(errors.join('\n').includes('your_feishu_base_token'), false);
});

test('validateConfig checks optional LTX settings only when that feature is enabled', () => {
  const errors = validateConfig({}, { features: ['ltx'], env: {} });
  assert.ok(errors.some((message) => message.includes('ltx_content_table_id')));
  assert.ok(errors.some((message) => message.includes('NEWAPI_API_KEY')));
  assert.equal(errors.some((message) => message.includes('KIMI_API_KEY')), false);
});
