'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildAccountPatch,
  createAccountServer,
  publishPage,
  platformLoginUrl,
  platformKeyFor,
} = require('../src/multipost-account-server');

test('maps Feishu platform names to MultiPost account keys', () => {
  assert.equal(platformKeyFor('快手'), 'kuaishou');
  assert.equal(platformKeyFor('微信视频号'), 'weixinchannel');
  assert.equal(platformKeyFor('小红书'), 'rednote');
  assert.equal(platformKeyFor('未知平台'), '');
});

test('maps Kuaishou to the official creator login entry', () => {
  assert.equal(platformLoginUrl('快手'), 'https://cp.kuaishou.com/article/publish/video');
  assert.equal(platformLoginUrl('未知平台'), '');
});

test('builds a verified account patch from MultiPost extension data', () => {
  const patch = buildAccountPatch('抖音', {
    douyin: {
      provider: 'douyin',
      accountId: 'sec_uid_123',
      username: '测试账号',
    },
  }, new Date(2026, 6, 17, 12, 34, 56));
  assert.deepEqual(patch, {
    'MultiPost平台标识': 'douyin',
    'MultiPost账号ID': 'sec_uid_123',
    '账号昵称': '测试账号',
    '登录状态': '有效',
    '最近验证时间': '2026-07-17 12:34:56',
  });
});

test('marks platforms without account detection for manual handling', () => {
  const patch = buildAccountPatch('快手', {}, new Date(2026, 6, 17, 12, 34, 56));
  assert.equal(patch['MultiPost平台标识'], 'kuaishou');
  assert.equal(patch['MultiPost账号ID'], null);
  assert.equal(patch['账号昵称'], null);
  assert.equal(patch['登录状态'], '需要人工处理');
});

test('local endpoint updates exactly the requested Feishu record', async (t) => {
  const calls = [];
  const server = createAccountServer({
    updatePlatformAccount(recordId, patch) {
      calls.push({ recordId, patch });
    },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();

  const response = await fetch(`http://127.0.0.1:${port}/api/multipost/account`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      recordId: 'rec-account-request-1',
      platformName: '小红书',
      accountInfo: {
        rednote: {
          provider: 'rednote',
          accountId: 'user_456',
          username: '小红书账号',
        },
      },
    }),
  });
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].recordId, 'rec-account-request-1');
  assert.equal(calls[0].patch['MultiPost账号ID'], 'user_456');
});

test('account page includes the trusted-domain and account-info extension actions', async (t) => {
  const server = createAccountServer({ updatePlatformAccount() {} });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/multipost/account?record_id=rec-account-request-1&platform=${encodeURIComponent('快手')}`);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /MULTIPOST_EXTENSION_REQUEST_TRUST_DOMAIN/);
  assert.match(html, /MULTIPOST_EXTENSION_GET_ACCOUNT_INFOS/);
  assert.match(html, /MULTIPOST_EXTENSION_REFRESH_KUAISHOU_ACCOUNT_INFO/);
  assert.match(html, /MULTIPOST_EXTENSION_REFRESH_ACCOUNT_INFOS/);
  assert.match(html, /打开快手创作者平台/);
  assert.match(html, /未登录时扫码/);
  assert.match(html, /登录完成，刷新账号/);
  assert.match(html, /https:\/\/cp\.kuaishou\.com\/article\/publish\/video/);
  assert.match(html, /rec-account-request-1/);
});

test('account server mounts the local API configuration handler on the same port', async (t) => {
  let calls = 0;
  const server = createAccountServer({
    updatePlatformAccount() {},
    async apiConfigHandler(request, response, url) {
      if (url.pathname !== '/api-config') return false;
      calls += 1;
      response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('api config mounted');
      return true;
    },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();

  const response = await fetch(`http://127.0.0.1:${port}/api-config?record_id=recApi12345`);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'api config mounted');
  assert.equal(calls, 1);
});

test('publish bridge claims one queued task and sends the official extension publish action', async (t) => {
  const tasks = new Map([[
    'mpx-test-task',
    {
      taskId: 'mpx-test-task',
      recordId: 'rec-publish-request-1',
      status: 'queued',
      payload: {
        platforms: [{ name: 'VIDEO_KUAISHOU' }],
        isAutoPublish: true,
        data: {
          title: '标题',
          content: '文案',
          tags: ['古风'],
          video: { name: 'final.mp4', url: 'https://example.com/final.mp4', type: 'video/mp4' },
        },
      },
    },
  ]]);
  const server = createAccountServer({
    updatePlatformAccount() {},
    readPublishTask(taskId) {
      return tasks.get(taskId) || null;
    },
    claimPublishTask(taskId) {
      const task = tasks.get(taskId);
      if (!task || task.status !== 'queued') return null;
      task.status = 'dispatching';
      return task;
    },
    markPublishTaskDispatched(taskId) {
      tasks.get(taskId).status = 'dispatched';
      return tasks.get(taskId);
    },
    markPublishTaskFailed(taskId, error) {
      const task = tasks.get(taskId);
      task.status = 'failed';
      task.error = error;
      return task;
    },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();

  const response = await fetch(`http://127.0.0.1:${port}/multipost/publish?task_id=mpx-test-task`);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /MULTIPOST_EXTENSION_REQUEST_TRUST_DOMAIN/);
  assert.match(html, /MULTIPOST_EXTENSION_CHECK_SERVICE_STATUS/);
  assert.match(html, /MULTIPOST_EXTENSION_PUBLISH/);
  assert.match(html, /\/api\/multipost\/publish-task\/claim/);
  assert.match(html, /\/api\/multipost\/publish-task\/dispatched/);
  assert.match(html, /mpx-test-task/);
});

test('publish bridge refreshes the current Kuaishou account before comparing the binding', async (t) => {
  const server = createAccountServer({
    updatePlatformAccount() {},
    readPublishTask() {
      return { taskId: 'mpx-refresh-account', status: 'queued' };
    },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();

  const response = await fetch(`http://127.0.0.1:${port}/multipost/publish?task_id=mpx-refresh-account`);
  const html = await response.text();

  assert.match(html, /MULTIPOST_EXTENSION_REFRESH_KUAISHOU_ACCOUNT_INFO/);
});

test('publish bridge account mismatch identifies the bound and detected accounts', async (t) => {
  const server = createAccountServer({
    updatePlatformAccount() {},
    readPublishTask() {
      return { taskId: 'mpx-account-mismatch', status: 'queued' };
    },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();

  const response = await fetch(`http://127.0.0.1:${port}/multipost/publish?task_id=mpx-account-mismatch`);
  const html = await response.text();

  assert.match(html, /飞书绑定账号：/);
  assert.match(html, /Chrome 实际账号：/);
});

test('publish bridge falls back to an exact nickname match when Kuaishou hides the account ID', () => {
  const html = publishPage('mpx-nickname-fallback');
  assert.match(html, /actualUsername && actualUsername === expectedUsername/);
});

test('publish claim endpoint is idempotent', async (t) => {
  let claims = 0;
  const server = createAccountServer({
    updatePlatformAccount() {},
    readPublishTask() {
      return { taskId: 'mpx-test-task', status: 'queued' };
    },
    claimPublishTask() {
      claims += 1;
      return claims === 1
        ? { taskId: 'mpx-test-task', status: 'dispatching', payload: { isAutoPublish: true } }
        : null;
    },
    markPublishTaskDispatched() {},
    markPublishTaskFailed() {},
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();

  const request = () => fetch(`http://127.0.0.1:${port}/api/multipost/publish-task/claim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ taskId: 'mpx-test-task' }),
  });
  const first = await request();
  const second = await request();
  assert.equal(first.status, 200);
  assert.equal(second.status, 409);
});

test('publish success endpoint writes the verified platform result back to Feishu', async (t) => {
  const updates = [];
  const task = {
    taskId: 'mpx-test-success',
    recordId: 'rec-publish-request-1',
    status: 'dispatched',
  };
  const server = createAccountServer({
    updatePlatformAccount() {},
    updatePlatformPublish(recordId, patch) {
      updates.push({ recordId, patch });
    },
    readPublishTask() {
      return task;
    },
    findLatestDispatchedPublishTask() {
      return task;
    },
    markPublishTaskSucceeded(taskId, result) {
      return { ...task, taskId, status: 'succeeded', ...result };
    },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();

  const response = await fetch(`http://127.0.0.1:${port}/api/multipost/publish-task/succeeded`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      platformKey: 'kuaishou',
      titleText: '示例视频标题',
      publishedAt: '2026-07-17 17:02',
    }),
  });
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.deepEqual(updates, [{
    recordId: 'rec-publish-request-1',
    patch: {
      '发布状态': '发布成功',
      '实际发布时间': '2026-07-17 17:02',
      '失败原因': null,
    },
  }]);
});
