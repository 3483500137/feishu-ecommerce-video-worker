'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  processIsAlive,
  waitForHealthyTunnel,
} = require('../src/media-relay-recovery');

test('waitForHealthyTunnel waits for a new reachable Quick Tunnel address', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ltx-relay-wait-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const statePath = path.join(root, 'state.json');
  fs.writeFileSync(statePath, JSON.stringify({ baseUrl: 'https://stale-edge.trycloudflare.com' }));
  setTimeout(() => {
    fs.writeFileSync(statePath, JSON.stringify({ baseUrl: 'https://fresh-edge.trycloudflare.com' }));
  }, 10).unref();

  const state = await waitForHealthyTunnel({
    statePath,
    previousBaseUrl: 'https://stale-edge.trycloudflare.com',
    pollMs: 5,
    timeoutMs: 200,
    fetchImpl: async (url) => ({ ok: url.includes('fresh-edge') }),
  });

  assert.equal(state.baseUrl, 'https://fresh-edge.trycloudflare.com');
});

test('processIsAlive detects this worker and rejects invalid PIDs', () => {
  assert.equal(processIsAlive(process.pid), true);
  assert.equal(processIsAlive(0), false);
  assert.equal(processIsAlive('not-a-pid'), false);
});
