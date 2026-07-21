'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createAdapterRegistry } = require('../src/provider-adapters');

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function access(protocol, overrides = {}) {
  return {
    protocol,
    baseUrl: 'https://gateway.example/v1',
    modelId: protocol === 'videos' ? 'video-model' : 'chat-model',
    modelName: '测试模型',
    ...overrides,
  };
}

test('chat adapter lists models and completes with the selected model', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith('/models')) return jsonResponse(200, { data: [{ id: 'chat-model' }, { id: 'other' }] });
    return jsonResponse(200, { choices: [{ message: { content: '完成' } }] });
  };
  const adapter = createAdapterRegistry({ fetchImpl, sleepImpl: async () => {} }).get('chat-completions');
  const models = await adapter.listModels(access('chat-completions'), 'sk-local');
  const result = await adapter.complete({
    access: access('chat-completions'), secret: 'sk-local', messages: [{ role: 'user', content: '你好' }],
  });

  assert.deepEqual(models, [{ id: 'chat-model', name: 'chat-model' }, { id: 'other', name: 'other' }]);
  assert.equal(result.choices[0].message.content, '完成');
  assert.equal(JSON.parse(calls[1].options.body).model, 'chat-model');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer sk-local');
});

test('videos adapter submits once and polls by external task ID', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (options.method === 'POST') return jsonResponse(200, { id: 'task-123' });
    return jsonResponse(200, { id: 'task-123', status: 'completed', url: 'https://cdn.example/video.mp4' });
  };
  const adapter = createAdapterRegistry({ fetchImpl, sleepImpl: async () => {} }).get('videos');
  const submitted = await adapter.submitVideo({
    access: access('videos'), secret: 'video-secret', payload: { prompt: '人物转身', aspect_ratio: '9:16' },
  });
  const task = await adapter.getVideoTask({ access: access('videos'), secret: 'video-secret', taskId: submitted.taskId });

  assert.equal(submitted.taskId, 'task-123');
  assert.equal(task.status, 'completed');
  assert.equal(JSON.parse(calls[0].options.body).model, 'video-model');
  assert.match(calls[1].url, /\/videos\/task-123$/);
});

test('XYQ adapter uses the skill endpoints and bearer access key', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return jsonResponse(200, { data: { thread_id: 'thread-1', run_id: 'run-1' } });
  };
  const adapter = createAdapterRegistry({ fetchImpl, sleepImpl: async () => {} }).get('xyq-skill');
  const result = await adapter.submitSkill({
    access: access('xyq-skill', { baseUrl: 'https://xyq.jianying.com', modelId: 'Seedance_2.0_mini' }),
    secret: 'xyq-secret',
    message: '生成视频',
    assetIds: ['asset-1'],
    threadId: '',
  });

  assert.deepEqual(result, { threadId: 'thread-1', runId: 'run-1', raw: { thread_id: 'thread-1', run_id: 'run-1' } });
  assert.match(calls[0].url, /\/api\/biz\/v1\/skill\/submit_run$/);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer xyq-secret');
});

test('idempotent model listing retries a temporary 429 without delaying tests', async () => {
  let attempts = 0;
  const delays = [];
  const fetchImpl = async () => {
    attempts += 1;
    return attempts === 1
      ? jsonResponse(429, { error: { message: 'rate limited' } })
      : jsonResponse(200, { data: [{ id: 'chat-model' }] });
  };
  const adapter = createAdapterRegistry({ fetchImpl, sleepImpl: async (ms) => delays.push(ms) }).get('chat-completions');
  await adapter.listModels(access('chat-completions'), 'secret');
  assert.equal(attempts, 2);
  assert.deepEqual(delays, [250]);
});

test('authentication errors are classified and redact secrets from upstream text', async () => {
  const fetchImpl = async () => jsonResponse(401, { error: { message: 'bad key sk-exposed-secret' } });
  const adapter = createAdapterRegistry({ fetchImpl, sleepImpl: async () => {} }).get('chat-completions');
  await assert.rejects(
    adapter.listModels(access('chat-completions'), 'sk-exposed-secret'),
    (error) => error.code === 'AUTH_FAILED'
      && error.status === 401
      && !error.message.includes('sk-exposed-secret'),
  );
});

test('unknown protocols fail before making a network request', () => {
  const registry = createAdapterRegistry({ fetchImpl: async () => { throw new Error('must not run'); } });
  assert.throws(() => registry.get('custom-protocol'), /不支持的API协议/);
});

