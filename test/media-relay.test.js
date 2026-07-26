'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const {
  buildRelayAssetKey,
  createMediaRequestHandler,
  createRelayMediaStore,
  extractTryCloudflareUrl,
  parseRelayAssetKeys,
} = require('../src/media-relay');

test('relay asset keys are unguessable, sanitized, and retain image extensions', () => {
  assert.equal(buildRelayAssetKey({
    recordId: 'rec/unsafe value',
    role: 'first frame',
    filePath: 'C:\\temp\\人物照片.PNG',
    randomBytes: () => Buffer.from('0123456789abcdef0123456789abcdef', 'hex'),
  }), 'rec-unsafe-value-first-frame-0123456789abcdef0123456789abcdef.png');
});

test('relay media store copies images, returns the active tunnel URL, and removes files', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ltx-relay-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const storageDir = path.join(root, 'media');
  const statePath = path.join(root, 'state.json');
  const source = path.join(root, 'first.png');
  fs.writeFileSync(source, 'image bytes');
  fs.writeFileSync(statePath, JSON.stringify({
    baseUrl: 'https://gentle-example.trycloudflare.com',
    startedAt: new Date().toISOString(),
  }));
  const healthChecks = [];
  const store = createRelayMediaStore({
    statePath,
    storageDir,
    randomBytes: () => Buffer.from('0123456789abcdef0123456789abcdef', 'hex'),
    fetchImpl: async (url) => {
      healthChecks.push(url);
      return { ok: true };
    },
  });

  const uploaded = await store.upload(source, { recordId: 'rec001', role: 'first' });

  assert.equal(uploaded.assetKey, 'rec001-first-0123456789abcdef0123456789abcdef.png');
  assert.equal(uploaded.url, `https://gentle-example.trycloudflare.com/media/${uploaded.assetKey}`);
  assert.equal(fs.readFileSync(path.join(storageDir, uploaded.assetKey), 'utf8'), 'image bytes');
  assert.deepEqual(healthChecks, ['https://gentle-example.trycloudflare.com/health']);

  await store.remove([uploaded.assetKey]);
  assert.equal(fs.existsSync(path.join(storageDir, uploaded.assetKey)), false);
});

test('relay media store can publish short mp4 reference segments', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-video-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const storageDir = path.join(root, 'media');
  const statePath = path.join(root, 'state.json');
  const source = path.join(root, 'segment.mp4');
  fs.writeFileSync(source, 'video bytes');
  fs.writeFileSync(statePath, JSON.stringify({ baseUrl: 'https://video-edge.trycloudflare.com' }));
  const store = createRelayMediaStore({
    statePath,
    storageDir,
    randomBytes: () => Buffer.from('fedcba9876543210fedcba9876543210', 'hex'),
    fetchImpl: async () => ({ ok: true }),
  });

  const uploaded = await store.upload(source, { recordId: 'rec001', role: 'segment-1' });

  assert.equal(uploaded.assetKey, 'rec001-segment-1-fedcba9876543210fedcba9876543210.mp4');
  assert.equal(fs.readFileSync(path.join(storageDir, uploaded.assetKey), 'utf8'), 'video bytes');
});

test('relay state must contain a reachable HTTPS TryCloudflare address', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ltx-relay-state-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'first.png');
  const statePath = path.join(root, 'state.json');
  fs.writeFileSync(source, 'image bytes');
  fs.writeFileSync(statePath, JSON.stringify({ baseUrl: 'http://127.0.0.1:17480' }));
  const store = createRelayMediaStore({ statePath, storageDir: path.join(root, 'media') });

  await assert.rejects(() => store.upload(source, { recordId: 'rec001', role: 'first' }), /Cloudflare临时中继/);
});

test('relay media store retries while a new Quick Tunnel domain propagates', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ltx-relay-retry-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'first.png');
  const statePath = path.join(root, 'state.json');
  fs.writeFileSync(source, 'image bytes');
  fs.writeFileSync(statePath, JSON.stringify({ baseUrl: 'https://new-edge.trycloudflare.com' }));
  let attempts = 0;
  const store = createRelayMediaStore({
    statePath,
    storageDir: path.join(root, 'media'),
    healthRetryMs: 0,
    fetchImpl: async () => {
      attempts += 1;
      return { ok: attempts === 3, status: 503 };
    },
  });

  const uploaded = await store.upload(source, { recordId: 'rec001', role: 'first' });

  assert.equal(attempts, 3);
  assert.match(uploaded.url, /^https:\/\/new-edge\.trycloudflare\.com\/media\//);
});

test('relay helpers parse Cloudflare output and stored asset keys safely', () => {
  assert.equal(
    extractTryCloudflareUrl('INF Your quick Tunnel has been created! Visit it at https://bright-river.trycloudflare.com'),
    'https://bright-river.trycloudflare.com',
  );
  assert.equal(extractTryCloudflareUrl('no tunnel here'), '');
  assert.deepEqual(parseRelayAssetKeys('["first.png","last.png"]'), ['first.png', 'last.png']);
  assert.deepEqual(parseRelayAssetKeys('invalid'), []);
});

test('relay HTTP handler serves health and only randomized media filenames', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ltx-relay-http-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const assetKey = 'rec001-first-0123456789abcdef0123456789abcdef.png';
  fs.writeFileSync(path.join(root, assetKey), 'public image');
  const server = http.createServer(createMediaRequestHandler({ storageDir: root }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();

  const health = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true });

  const media = await fetch(`http://127.0.0.1:${port}/media/${assetKey}`);
  assert.equal(media.status, 200);
  assert.equal(media.headers.get('content-type'), 'image/png');
  assert.equal(await media.text(), 'public image');

  const blocked = await fetch(`http://127.0.0.1:${port}/media/not-random.png`);
  assert.equal(blocked.status, 404);
});
