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

test('chat adapter forces temperature 1 for Kimi K2.6', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    return jsonResponse(200, { choices: [{ message: { content: '完成' } }] });
  };
  const adapter = createAdapterRegistry({ fetchImpl, sleepImpl: async () => {} }).get('chat-completions');

  await adapter.complete({
    access: access('chat-completions', { modelId: 'kimi-k2.6' }),
    secret: 'sk-local',
    messages: [{ role: 'user', content: '生成短视频提示词' }],
    temperature: 0.6,
  });

  assert.equal(JSON.parse(calls[0].options.body).temperature, 1);
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

test('videos adapter supports NewAPI singular video generation paths', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    return options.method === 'POST'
      ? jsonResponse(200, { id: 'newapi-task' })
      : jsonResponse(200, { id: 'newapi-task', status: 'completed' });
  };
  const adapter = createAdapterRegistry({ fetchImpl, sleepImpl: async () => {} }).get('videos');
  const selected = access('videos', { videoApiStyle: 'newapi-video-generations' });

  await adapter.submitVideo({ access: selected, secret: 'secret', payload: { prompt: 'test' } });
  await adapter.getVideoTask({ access: selected, secret: 'secret', taskId: 'newapi-task' });

  assert.match(calls[0].url, /\/video\/generations$/);
  assert.match(calls[1].url, /\/video\/generations\/newapi-task$/);
});

test('NewAPI video generation wraps reference videos in content with roles', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    return jsonResponse(200, { id: 'newapi-reference-task' });
  };
  const adapter = createAdapterRegistry({ fetchImpl, sleepImpl: async () => {} }).get('videos');
  const selected = access('videos', { videoApiStyle: 'newapi-video-generations' });

  await adapter.submitVideo({
    access: selected,
    secret: 'secret',
    payload: {
      prompt: '按参考视频逐镜复刻',
      image_url: 'https://cdn.example/persona.png',
      reference_video_url: 'https://v.douyin.com/fxwMMjgLGMY/',
      aspect_ratio: '9:16',
      width: 1080,
      height: 1920,
    },
  });

  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.model, 'video-model');
  assert.equal(body.prompt, undefined);
  assert.equal(body.reference_video_url, undefined);
  assert.equal(body.ratio, '9:16');
  assert.equal(body.resolution, '1080p');
  assert.deepEqual(body.content, [
    { type: 'text', text: '按参考视频逐镜复刻' },
    { type: 'image_url', image_url: { url: 'https://cdn.example/persona.png' }, role: 'reference_image' },
    { type: 'video_url', video_url: { url: 'https://v.douyin.com/fxwMMjgLGMY/' }, role: 'reference_video' },
  ]);
});

test('videos adapter supports APIMesh plural video generation paths and integer durations', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    return options.method === 'POST'
      ? jsonResponse(200, { data: { task_id: 'mesh-task' } })
      : jsonResponse(200, { id: 'mesh-task', status: 'completed' });
  };
  const adapter = createAdapterRegistry({ fetchImpl, sleepImpl: async () => {} }).get('videos');
  const selected = access('videos', { videoApiStyle: 'apimesh-videos-generations' });

  await adapter.submitVideo({
    access: selected,
    secret: 'secret',
    payload: { prompt: 'test', image_url: 'https://cdn.example/first.jpg', duration: 14.118, aspect_ratio: '9:16' },
  });
  await adapter.getVideoTask({ access: selected, secret: 'secret', taskId: 'mesh-task' });

  assert.match(calls[0].url, /\/videos\/generations$/);
  assert.match(calls[1].url, /\/videos\/generations\/mesh-task$/);
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.prompt, undefined);
  assert.deepEqual(body.content, [
    { type: 'text', text: 'test' },
    { type: 'image_url', image_url: { url: 'https://cdn.example/first.jpg' } },
  ]);
  assert.equal(body.duration, 14);
  assert.equal(body.aspect_ratio, '9:16');
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
  assert.deepEqual(JSON.parse(calls[0].options.body).general_agent_settings, {
    video_model: 'Seedance_2.0_mini',
  });
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
