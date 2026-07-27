'use strict';

const http = require('http');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createApiConfigHandler } = require('../src/api-config');

function accessRow() {
  return {
    record_id: 'recApi12345',
    接入名称: 'Kimi主账号',
    服务商类型: ['Kimi'],
    API协议: ['Chat Completions'],
    接口地址: 'https://api.moonshot.cn/v1',
    模型名称: 'Kimi K2.6',
    模型ID: 'kimi-k2.6',
    模型能力: ['文本', '视觉分析'],
    本机密钥别名: '',
    是否默认: ['人设文本'],
    是否启用: ['是'],
  };
}

async function withServer(overrides, run) {
  const updates = [];
  const creates = [];
  const secrets = new Map();
  const rows = new Map([['recApi12345', accessRow()]]);
  const baseClient = {
    async getAccessRecord(recordId) { return rows.get(recordId) || null; },
    async updateAccessRecord(recordId, patch) { updates.push({ recordId, patch }); Object.assign(rows.get(recordId), patch); },
    async createAccessRecord(fields) { creates.push(fields); return { record_id: `rec-created-${creates.length}`, ...fields }; },
  };
  const credentialStore = {
    set(alias, secret) { secrets.set(alias, secret); return { alias, masked: `••••${secret.slice(-4)}` }; },
    get(alias) { return secrets.get(alias) || null; },
    remove(alias) { return secrets.delete(alias); },
    metadata(alias) { const secret = secrets.get(alias); return secret ? { alias, masked: `••••${secret.slice(-4)}` } : null; },
  };
  const adapter = {
    async validate() { return { valid: true, modelFound: true, models: [{ id: 'kimi-k2.6', name: 'Kimi K2.6' }, { id: 'vision-2', name: 'Vision 2' }] }; },
    async listModels() { return [{ id: 'kimi-k2.6', name: 'Kimi K2.6' }, { id: 'vision-2', name: 'Vision 2' }]; },
  };
  const handler = createApiConfigHandler({
    baseClient,
    credentialStore,
    adapterRegistry: { get: () => adapter },
    now: () => new Date('2026-07-21T08:00:00.000Z'),
    ...overrides,
  });
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (!await handler(request, response, url)) {
      response.writeHead(404).end('not found');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    await run({ baseUrl, updates, creates, secrets });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function openPage(baseUrl) {
  const response = await fetch(`${baseUrl}/api-config?record_id=recApi12345`);
  const html = await response.text();
  const csrfToken = html.match(/name="csrf-token" content="([^"]+)"/)?.[1];
  return { response, html, csrfToken, cookie: response.headers.get('set-cookie')?.split(';')[0] };
}

test('config page is local-only, issues CSRF state, and never renders a stored secret', async () => {
  await withServer({}, async ({ baseUrl, secrets }) => {
    secrets.set('api:recApi12345', 'sk-must-not-render');
    const page = await openPage(baseUrl);
    assert.equal(page.response.status, 200);
    assert.ok(page.csrfToken);
    assert.match(page.cookie, /^api_config_csrf=/);
    assert.match(page.html, /Kimi主账号/);
    assert.doesNotMatch(page.html, /sk-must-not-render/);
  });
});

test('config writes reject missing CSRF and foreign origins', async () => {
  await withServer({}, async ({ baseUrl }) => {
    const missing = await fetch(`${baseUrl}/api-config/save`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ recordId: 'recApi12345', secret: 'sk-test' }),
    });
    assert.equal(missing.status, 403);

    const page = await openPage(baseUrl);
    const foreign = await fetch(`${baseUrl}/api-config/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: page.cookie, Origin: 'https://evil.example' },
      body: JSON.stringify({ recordId: 'recApi12345', csrfToken: page.csrfToken, secret: 'sk-test' }),
    });
    assert.equal(foreign.status, 403);
  });
});

test('saving a secret stores it locally and writes only masked metadata to Feishu', async () => {
  await withServer({}, async ({ baseUrl, updates, secrets }) => {
    const page = await openPage(baseUrl);
    const response = await fetch(`${baseUrl}/api-config/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: page.cookie, Origin: baseUrl },
      body: JSON.stringify({ recordId: 'recApi12345', csrfToken: page.csrfToken, secret: 'sk-private-7788' }),
    });
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(secrets.get('api:recApi12345'), 'sk-private-7788');
    assert.deepEqual(updates.at(-1), {
      recordId: 'recApi12345',
      patch: { 本机密钥别名: 'api:recApi12345', 密钥尾号: '7788', 验证状态: '待验证', 失败原因: null },
    });
    assert.doesNotMatch(JSON.stringify(payload), /sk-private-7788/);
  });
});

test('validation uses the selected adapter and writes a safe status', async () => {
  await withServer({}, async ({ baseUrl, updates, secrets }) => {
    secrets.set('api:recApi12345', 'sk-valid-1234');
    const page = await openPage(baseUrl);
    const response = await fetch(`${baseUrl}/api-config/validate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: page.cookie, Origin: baseUrl },
      body: JSON.stringify({ recordId: 'recApi12345', csrfToken: page.csrfToken }),
    });
    const payload = await response.json();
    assert.equal(payload.ok, true);
    assert.equal(payload.modelFound, true);
    assert.equal(updates.at(-1).patch['验证状态'], '有效');
    assert.equal(updates.at(-1).patch['最近验证时间'], '2026-07-21 16:00:00');
  });
});

test('failed validation tolerates a synchronous Feishu update client', async () => {
  const updates = [];
  const row = accessRow();
  const baseClient = {
    getAccessRecord() { return row; },
    updateAccessRecord(recordId, patch) { updates.push({ recordId, patch }); return { ok: true }; },
    createAccessRecord() { throw new Error('not used'); },
  };
  const credentialStore = {
    get() { return 'sk-local-only'; },
    metadata() { return { masked: '••••only' }; },
  };
  const adapterRegistry = {
    get() {
      return { async validate() { throw new Error('upstream unavailable'); } };
    },
  };

  await withServer({ baseClient, credentialStore, adapterRegistry }, async ({ baseUrl }) => {
    const page = await openPage(baseUrl);
    const response = await fetch(`${baseUrl}/api-config/validate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: page.cookie, Origin: baseUrl },
      body: JSON.stringify({ recordId: 'recApi12345', csrfToken: page.csrfToken }),
    });
    const payload = await response.json();

    assert.equal(response.status, 400);
    assert.equal(payload.error, 'upstream unavailable');
    assert.equal(updates.at(-1).patch['失败原因'], 'upstream unavailable');
  });
});

test('model import creates one row per selected model in the same access table', async () => {
  await withServer({}, async ({ baseUrl, creates, secrets }) => {
    secrets.set('api:recApi12345', 'sk-valid-1234');
    const page = await openPage(baseUrl);
    const response = await fetch(`${baseUrl}/api-config/import-models`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: page.cookie, Origin: baseUrl },
      body: JSON.stringify({ recordId: 'recApi12345', csrfToken: page.csrfToken, modelIds: ['kimi-k2.6', 'vision-2'] }),
    });
    const payload = await response.json();
    assert.equal(payload.created, 2);
    assert.deepEqual(creates.map((row) => row['模型ID']), ['kimi-k2.6', 'vision-2']);
    assert.ok(creates.every((row) => row['本机密钥别名'] === 'api:recApi12345'));
    assert.ok(creates.every((row) => row['API协议'] === 'Chat Completions'));
  });
});
