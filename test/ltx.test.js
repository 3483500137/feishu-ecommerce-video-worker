'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLtxClient } = require('../src/ltx');

test('LTX client submits and polls OpenAI-compatible video tasks', async () => {
  const requests = [];
  const responses = [
    { id: 'video-task-1', status: 'queued' },
    { id: 'video-task-1', status: 'processing' },
  ];
  const client = createLtxClient({
    baseUrl: 'http://newapi.example.test/',
    apiKey: 'test-key',
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return {
        ok: true,
        json: async () => responses.shift(),
      };
    },
  });

  const submitted = await client.submit({ model: 'aipdd_ltx_2.3' });
  const task = await client.get(submitted.taskId);

  assert.equal(submitted.taskId, 'video-task-1');
  assert.equal(task.status, 'processing');
  assert.equal(requests[0].url, 'http://newapi.example.test/v1/videos');
  assert.equal(requests[0].options.method, 'POST');
  assert.equal(requests[0].options.headers.Authorization, 'Bearer test-key');
  assert.equal(requests[1].url, 'http://newapi.example.test/v1/videos/video-task-1');
  assert.equal(requests[1].options.method, 'GET');
});

test('LTX client reports upstream errors without exposing the API key', async () => {
  const client = createLtxClient({
    baseUrl: 'http://newapi.example.test',
    apiKey: 'secret-test-key',
    fetchImpl: async () => ({
      ok: false,
      status: 400,
      json: async () => ({ error: { message: 'invalid image' } }),
    }),
  });

  await assert.rejects(
    client.submit({ model: 'aipdd_ltx_2.3' }),
    (error) => error.message === 'LTX接口失败: invalid image'
      && !error.message.includes('secret-test-key'),
  );
});
