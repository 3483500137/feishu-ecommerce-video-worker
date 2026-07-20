'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { uploadXyqAsset } = require('../src/xyq-client');

test('uploadXyqAsset sends the expected multipart fields and parses the Pippit asset id', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xyq-upload-'));
  const file = path.join(root, 'portrait.png');
  fs.writeFileSync(file, Buffer.from([1, 2, 3]));
  let captured;
  const assetId = await uploadXyqAsset(file, {
    baseUrl: 'https://xyq.test/',
    accessKey: 'secret-key',
    fetchImpl: async (url, options) => {
      captured = { url, options };
      return { ok: true, json: async () => ({ ret: '0', data: { pippit_asset_id: 'asset-123' } }) };
    },
  });
  assert.equal(assetId, 'asset-123');
  assert.equal(captured.url, 'https://xyq.test/api/biz/v1/skill/upload_file');
  assert.equal(captured.options.headers.Authorization, 'Bearer secret-key');
  assert.equal(captured.options.body.get('accessKey'), 'secret-key');
  assert.equal(captured.options.body.get('file').name, 'portrait.png');
});
test('uploadXyqAsset errors never expose the access key', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xyq-upload-'));
  const file = path.join(root, 'portrait.jpg');
  fs.writeFileSync(file, Buffer.from([1]));
  await assert.rejects(
    uploadXyqAsset(file, {
      baseUrl: 'https://xyq.test',
      accessKey: 'do-not-leak',
      fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ errmsg: 'bad credential do-not-leak' }) }),
    }),
    (error) => error.message.includes('401') && !error.message.includes('do-not-leak'),
  );
});
