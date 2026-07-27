'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { inspectSetup } = require('../scripts/doctor');

test('doctor identifies missing config and secrets without printing their values', () => {
  const report = inspectSetup({
    config: { base_token: 'your_feishu_base_token' },
    configExists: false,
    env: { KIMI_API_KEY: 'super-secret-value' },
    commandExists: () => false,
    larkCliAvailable: false,
    nodeVersion: '20.10.0',
  });
  assert.equal(report.ok, false);
  assert.ok(report.items.some((item) => item.name === 'config.json' && item.level === 'error'));
  assert.ok(report.items.some((item) => item.name === 'XYQ_ACCESS_KEY' && item.level === 'warning'));
  assert.equal(JSON.stringify(report).includes('super-secret-value'), false);
});
test('doctor treats optional publishing dependencies as warnings', () => {
  const report = inspectSetup({
    config: {
      base_token: 'bascn-valid',
      persona_table_id: 'tbl-persona',
      content_table_id: 'tbl-content',
      persona_image_attachment_field_id: 'fld-image',
    },
    configExists: true,
    env: { KIMI_API_KEY: 'set', XYQ_ACCESS_KEY: 'set' },
    commandExists: (command) => ['yt-dlp', 'ffmpeg'].includes(command),
    larkCliAvailable: true,
    nodeVersion: '22.0.0',
  });
  assert.equal(report.ok, true);
  assert.ok(report.items.some((item) => item.name === 'cloudflared' && item.level === 'warning'));
});
