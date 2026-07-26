'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createWorkerModelRuntime, importLegacyCredentials } = require('../src/worker-routing');

function accessRow(overrides = {}) {
  return {
    record_id: 'rec-text-1', 接入编号: 'API-0001', 接入名称: '文本模型',
    服务商类型: ['Kimi'], API协议: ['Chat Completions'], 接口地址: 'https://gateway/v1',
    模型名称: '文本一号', 模型ID: 'text-1', 模型能力: ['文本', '视觉分析'],
    本机密钥别名: 'api:text', 是否默认: ['人设文本', '提示词', '发布文案'], 是否启用: ['是'],
    ...overrides,
  };
}

test('XYQ work resolves without Kimi and calls only the selected account', async () => {
  const calls = [];
  const xyq = accessRow({
    record_id: 'rec-xyq-1', 接入名称: '小云雀视频', 服务商类型: ['小云雀'], API协议: ['XYQ Skill'],
    模型名称: 'Seedance Mini', 模型ID: 'Seedance_2.0_mini', 模型能力: ['视频生成'],
    本机密钥别名: 'api:xyq', 是否默认: ['视频生成'],
  });
  const runtime = createWorkerModelRuntime({
    accessRows: [xyq], env: {}, credentialStore: { get: (alias) => alias === 'api:xyq' ? 'xyq-local' : null },
    adapterRegistry: { get: () => ({
      async submitSkill(input) { calls.push(input); return { threadId: 't1', runId: 'r1' }; },
    }) },
  });
  const result = await runtime.submitSkill({
    row: { '视频生成模型': [{ id: 'rec-xyq-1' }] }, fieldName: '视频生成模型',
    capability: '视频生成', defaultPurpose: '视频生成', message: '生成视频',
  });
  assert.equal(result.runId, 'r1');
  assert.equal(calls[0].secret, 'xyq-local');
  assert.equal(calls[0].access.modelId, 'Seedance_2.0_mini');
});

test('relay video works without XYQ and stores a deterministic model snapshot', async () => {
  const relay = accessRow({
    record_id: 'rec-video-1', 接入名称: '中转站视频', 服务商类型: ['中转站'], API协议: ['Videos'],
    模型名称: '视频一号', 模型ID: 'video-1', 模型能力: ['视频生成'],
    本机密钥别名: 'api:relay', 是否默认: ['视频生成'],
  });
  const runtime = createWorkerModelRuntime({
    accessRows: [relay], env: {}, credentialStore: { get: () => 'relay-local' },
    adapterRegistry: { get: () => ({ async submitVideo() { return { taskId: 'task-1' }; } }) },
  });
  const result = await runtime.submitVideo({
    row: {}, fieldName: '视频生成模型', capability: '视频生成', defaultPurpose: '视频生成',
    payload: { prompt: '测试', aspect_ratio: '9:16' },
  });
  assert.equal(result.taskId, 'task-1');
  assert.equal(JSON.parse(result.modelSnapshot).modelId, 'video-1');
});

test('explicit model wins, blank uses one default, and legacy model field maps by name', () => {
  const selected = accessRow({ record_id: 'rec-selected', 接入名称: '指定模型', 模型名称: '新模型', 是否默认: [] });
  const fallback = accessRow({ record_id: 'rec-default', 接入名称: '默认模型', 模型名称: '旧模型', 是否默认: ['提示词'] });
  const runtime = createWorkerModelRuntime({ accessRows: [selected, fallback], credentialStore: { get: () => 'x' }, adapterRegistry: { get() {} } });
  assert.equal(runtime.resolve({
    row: { '文本/分析模型': [{ id: 'rec-selected' }] }, fieldName: '文本/分析模型',
    capability: '文本', defaultPurpose: '提示词', legacyFieldName: '模型选用',
  }).recordId, 'rec-selected');
  assert.equal(runtime.resolve({
    row: {}, fieldName: '文本/分析模型', capability: '文本', defaultPurpose: '提示词',
  }).recordId, 'rec-default');
  assert.equal(runtime.resolve({
    row: { '模型选用': ['旧模型'] }, fieldName: '文本/分析模型', capability: '文本',
    defaultPurpose: '不存在的默认', legacyFieldName: '模型选用',
  }).recordId, 'rec-default');
});

test('publish copy uses the row selected model instead of a fixed Kimi model', async () => {
  const calls = [];
  const runtime = createWorkerModelRuntime({
    accessRows: [accessRow()], credentialStore: { get: () => 'text-local' }, env: {},
    adapterRegistry: { get: () => ({ async complete(input) {
      calls.push(input); return { choices: [{ message: { content: '{"title":"标题","copy":"短文案","tags":["A","B","C"]}' } }] };
    } }) },
  });
  const result = await runtime.completeChat({
    row: { '发布文案模型': [{ id: 'rec-text-1' }] }, fieldName: '发布文案模型',
    capability: '视觉分析', defaultPurpose: '发布文案', messages: [{ role: 'user', content: '生成文案' }],
  });
  assert.equal(result.content, '{"title":"标题","copy":"短文案","tags":["A","B","C"]}');
  assert.equal(calls[0].access.modelId, 'text-1');
});

test('legacy environment credentials import once into each configured DPAPI alias', () => {
  const saved = new Map();
  const store = {
    metadata: (alias) => saved.has(alias) ? { alias } : null,
    set(alias, secret) { saved.set(alias, secret); return { alias }; },
  };
  const rows = [
    accessRow(),
    accessRow({ record_id: 'rec-video', 服务商类型: ['中转站'], API协议: ['Videos'], 本机密钥别名: 'api:video' }),
  ];
  const env = { KIMI_API_KEY: 'kimi-secret', NEWAPI_API_KEY: 'video-secret' };
  const first = importLegacyCredentials({ env, store, accessRows: rows });
  const second = importLegacyCredentials({ env, store, accessRows: rows });
  assert.deepEqual(first.sort(), ['api:text', 'api:video']);
  assert.deepEqual(second, []);
  assert.equal(saved.get('api:text'), 'kimi-secret');
  assert.equal(saved.get('api:video'), 'video-secret');
  assert.doesNotMatch(JSON.stringify(first), /secret/);
});
