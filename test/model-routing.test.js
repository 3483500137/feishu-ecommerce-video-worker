'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeAccessRecord,
  resolveSelectedAccess,
  resolveCredential,
  snapshotAccess,
} = require('../src/model-routing');

function accessRow(overrides = {}) {
  return {
    record_id: 'rec-api-1',
    接入编号: 'API-0001',
    接入名称: 'Kimi主账号',
    服务商类型: ['Kimi'],
    API协议: ['Chat Completions'],
    接口地址: 'https://api.moonshot.cn/v1',
    模型名称: 'Kimi K2.6',
    模型ID: 'kimi-k2.6',
    模型能力: ['文本', '视觉分析'],
    本机密钥别名: 'api:rec-api-1',
    是否默认: ['人设文本', '发布文案'],
    是否启用: ['是'],
    验证状态: ['有效'],
    ...overrides,
  };
}

test('normalizes a Feishu access row without secret material', () => {
  const access = normalizeAccessRecord(accessRow());
  assert.equal(access.protocol, 'chat-completions');
  assert.deepEqual(access.capabilities, ['文本', '视觉分析']);
  assert.equal(access.enabled, true);
  assert.equal(access.legacyEnvName, 'KIMI_API_KEY');
  assert.doesNotMatch(JSON.stringify(access), /Bearer|sk-/);
});

test('explicit linked access wins over defaults and must match capability', () => {
  const explicit = normalizeAccessRecord(accessRow());
  const other = normalizeAccessRecord(accessRow({ record_id: 'rec-api-2', 接入编号: 'API-0002', 接入名称: '其他默认' }));
  const accessById = new Map([[explicit.recordId, explicit], [other.recordId, other]]);

  assert.equal(resolveSelectedAccess({
    linkedValue: [{ id: explicit.recordId }],
    accessById,
    capability: '视觉分析',
    defaultPurpose: '提示词',
  }).recordId, explicit.recordId);

  assert.throws(() => resolveSelectedAccess({
    linkedValue: [{ id: explicit.recordId }],
    accessById,
    capability: '视频生成',
    defaultPurpose: '视频生成',
  }), (error) => error.code === 'CAPABILITY_MISMATCH');
});

test('blank selection resolves one enabled default and rejects ambiguous defaults', () => {
  const first = normalizeAccessRecord(accessRow({ 是否默认: ['提示词'] }));
  const second = normalizeAccessRecord(accessRow({ record_id: 'rec-api-2', 接入编号: 'API-0002', 是否默认: [] }));
  const map = new Map([[first.recordId, first], [second.recordId, second]]);
  assert.equal(resolveSelectedAccess({
    linkedValue: [], accessById: map, capability: '文本', defaultPurpose: '提示词',
  }).recordId, first.recordId);

  second.defaults = ['提示词'];
  assert.throws(() => resolveSelectedAccess({
    linkedValue: [], accessById: map, capability: '文本', defaultPurpose: '提示词',
  }), (error) => error.code === 'AMBIGUOUS_DEFAULT');
});

test('disabled and missing access records stop before provider calls', () => {
  const disabled = normalizeAccessRecord(accessRow({ 是否启用: ['否'] }));
  const map = new Map([[disabled.recordId, disabled]]);
  assert.throws(() => resolveSelectedAccess({
    linkedValue: [{ id: disabled.recordId }], accessById: map, capability: '文本', defaultPurpose: '人设文本',
  }), (error) => error.code === 'ACCESS_DISABLED');
  assert.throws(() => resolveSelectedAccess({
    linkedValue: [{ id: 'missing' }], accessById: map, capability: '文本', defaultPurpose: '人设文本',
  }), (error) => error.code === 'CONFIG_REQUIRED');
});

test('credential resolution prefers DPAPI store and falls back to the legacy environment', () => {
  const access = normalizeAccessRecord(accessRow());
  assert.equal(resolveCredential({
    access,
    credentialStore: { get: () => 'dpapi-secret' },
    env: { KIMI_API_KEY: 'legacy-secret' },
  }), 'dpapi-secret');
  assert.equal(resolveCredential({
    access,
    credentialStore: { get: () => null },
    env: { KIMI_API_KEY: 'legacy-secret' },
  }), 'legacy-secret');
  assert.throws(() => resolveCredential({
    access,
    credentialStore: { get: () => null },
    env: {},
  }), (error) => error.code === 'CONFIG_REQUIRED');
});

test('model snapshot is deterministic and excludes credential aliases', () => {
  const snapshot = snapshotAccess(normalizeAccessRecord(accessRow()));
  assert.deepEqual(JSON.parse(snapshot), {
    accessNumber: 'API-0001',
    accessName: 'Kimi主账号',
    protocol: 'chat-completions',
    baseUrl: 'https://api.moonshot.cn/v1',
    modelId: 'kimi-k2.6',
    modelName: 'Kimi K2.6',
  });
  assert.doesNotMatch(snapshot, /密钥|credential|rec-api-1/);
});

