'use strict';

const PROTOCOLS = Object.freeze({
  'Chat Completions': 'chat-completions',
  Videos: 'videos',
  'XYQ Skill': 'xyq-skill',
});

class ModelRoutingError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ModelRoutingError';
    this.code = code;
  }
}

function optionValues(value) {
  if (!Array.isArray(value)) {
    const text = String(value || '').trim();
    return text ? [text] : [];
  }
  return value
    .map((item) => String(typeof item === 'string' ? item : item?.name || '').trim())
    .filter(Boolean);
}

function linkedRecordId(value) {
  if (!Array.isArray(value) || !value.length) return '';
  const first = value[0];
  return String(typeof first === 'string' ? first : first?.id || first?.record_id || '').trim();
}

function legacyEnvName(provider, protocol) {
  if (protocol === 'xyq-skill' || provider === '小云雀') return 'XYQ_ACCESS_KEY';
  if (provider === 'Kimi') return 'KIMI_API_KEY';
  if (protocol === 'videos') return 'NEWAPI_API_KEY';
  return '';
}

function normalizeAccessRecord(row = {}) {
  const provider = optionValues(row['服务商类型'])[0] || '';
  const protocolLabel = optionValues(row['API协议'])[0] || '';
  const protocol = PROTOCOLS[protocolLabel] || String(protocolLabel).trim().toLowerCase();
  return {
    recordId: String(row.record_id || row.recordId || '').trim(),
    accessNumber: String(row['接入编号'] || row.accessNumber || '').trim(),
    accessName: String(row['接入名称'] || row.accessName || '').trim(),
    provider,
    protocol,
    baseUrl: String(row['接口地址'] || row.baseUrl || '').trim().replace(/\/+$/, ''),
    modelName: String(row['模型名称'] || row.modelName || '').trim(),
    modelId: String(row['模型ID'] || row.modelId || '').trim(),
    capabilities: optionValues(row['模型能力'] || row.capabilities),
    credentialAlias: String(row['本机密钥别名'] || row.credentialAlias || '').trim(),
    defaults: optionValues(row['是否默认'] || row.defaults),
    enabled: optionValues(row['是否启用'] || row.enabled)[0] !== '否',
    validationStatus: optionValues(row['验证状态'] || row.validationStatus)[0] || '未配置',
    legacyEnvName: legacyEnvName(provider, protocol),
  };
}

function asNormalizedAccess(value) {
  if (!value) return null;
  return value.recordId && value.protocol ? value : normalizeAccessRecord(value);
}

function validateAccess(access, capability) {
  if (!access) throw new ModelRoutingError('CONFIG_REQUIRED', '未找到选择的接入API记录');
  if (!access.enabled) throw new ModelRoutingError('ACCESS_DISABLED', `接入API ${access.accessName || access.accessNumber} 已停用`);
  if (!access.protocol || !access.modelId) {
    throw new ModelRoutingError('CONFIG_REQUIRED', `接入API ${access.accessName || access.accessNumber} 缺少协议或模型ID`);
  }
  if (capability && !access.capabilities.includes(capability)) {
    throw new ModelRoutingError('CAPABILITY_MISMATCH', `模型 ${access.modelName || access.modelId} 不具备“${capability}”能力`);
  }
  return access;
}

function resolveSelectedAccess({ linkedValue, accessById, capability, defaultPurpose }) {
  const explicitId = linkedRecordId(linkedValue);
  if (explicitId) return validateAccess(asNormalizedAccess(accessById.get(explicitId)), capability);

  const candidates = [...accessById.values()]
    .map(asNormalizedAccess)
    .filter((access) => access.enabled && access.defaults.includes(defaultPurpose));
  if (!candidates.length) {
    throw new ModelRoutingError('CONFIG_REQUIRED', `没有配置“${defaultPurpose}”默认模型`);
  }
  if (candidates.length > 1) {
    throw new ModelRoutingError('AMBIGUOUS_DEFAULT', `“${defaultPurpose}”存在多个默认模型，请在飞书中明确选择`);
  }
  return validateAccess(candidates[0], capability);
}

function resolveCredential({ access, credentialStore, env = process.env }) {
  let secret = null;
  if (access.credentialAlias && credentialStore?.get) secret = credentialStore.get(access.credentialAlias);
  if (!secret && access.legacyEnvName) secret = env[access.legacyEnvName];
  if (!String(secret || '').trim()) {
    throw new ModelRoutingError('CONFIG_REQUIRED', `模型 ${access.modelName || access.modelId} 尚未导入本机密钥`);
  }
  return String(secret).trim();
}

function snapshotAccess(access) {
  return JSON.stringify({
    accessNumber: access.accessNumber,
    accessName: access.accessName,
    protocol: access.protocol,
    baseUrl: access.baseUrl,
    modelId: access.modelId,
    modelName: access.modelName,
  });
}

module.exports = {
  ModelRoutingError,
  linkedRecordId,
  normalizeAccessRecord,
  optionValues,
  resolveCredential,
  resolveSelectedAccess,
  snapshotAccess,
};

