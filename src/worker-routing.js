'use strict';

const {
  ModelRoutingError,
  linkedRecordId,
  normalizeAccessRecord,
  resolveCredential,
  resolveSelectedAccess,
  snapshotAccess,
} = require('./model-routing');
const { createAdapterRegistry } = require('./provider-adapters');

function buildAccessMap(rows = []) {
  return new Map(rows.map(normalizeAccessRecord).filter((access) => access.recordId).map((access) => [access.recordId, access]));
}

function matchesCapability(access, capability) {
  return !capability || access.capabilities.includes(capability);
}

function resolveLegacyAccess({ row, legacyFieldName, accessById, capability }) {
  if (!legacyFieldName) return null;
  const raw = row?.[legacyFieldName];
  const selected = Array.isArray(raw)
    ? String(typeof raw[0] === 'string' ? raw[0] : raw[0]?.name || '').trim()
    : String(raw || '').trim();
  if (!selected) return null;
  const matches = [...accessById.values()].filter((access) => access.enabled
    && matchesCapability(access, capability)
    && [access.modelId, access.modelName, access.accessName].includes(selected));
  if (matches.length > 1) throw new ModelRoutingError('AMBIGUOUS_DEFAULT', `旧模型“${selected}”匹配多个接入API，请明确选择`);
  return matches[0] || null;
}

function createWorkerModelRuntime({
  accessRows = [],
  credentialStore,
  env = process.env,
  adapterRegistry = createAdapterRegistry(),
} = {}) {
  const accessById = buildAccessMap(accessRows);

  function resolve({ row = {}, fieldName, capability, defaultPurpose, legacyFieldName = '' }) {
    const linkedValue = row[fieldName];
    if (!linkedRecordId(linkedValue)) {
      const legacy = resolveLegacyAccess({ row, legacyFieldName, accessById, capability });
      if (legacy) return legacy;
    }
    return resolveSelectedAccess({ linkedValue, accessById, capability, defaultPurpose });
  }

  function context(options) {
    const access = options.modelSnapshot ? resolveSnapshot(options.modelSnapshot) : resolve(options);
    const secret = resolveCredential({ access, credentialStore, env });
    return { access, secret, adapter: adapterRegistry.get(access.protocol) };
  }

  function resolveSnapshot(value) {
    let snapshot;
    try { snapshot = typeof value === 'string' ? JSON.parse(value) : value; }
    catch { throw new ModelRoutingError('CONFIG_REQUIRED', '任务中的模型快照已损坏'); }
    const configured = [...accessById.values()].find((access) => access.accessNumber === snapshot?.accessNumber);
    if (!configured) throw new ModelRoutingError('CONFIG_REQUIRED', `模型快照 ${snapshot?.accessNumber || ''} 对应的接入已不存在`);
    return {
      ...configured,
      accessName: snapshot.accessName || configured.accessName,
      protocol: snapshot.protocol || configured.protocol,
      baseUrl: snapshot.baseUrl || configured.baseUrl,
      modelId: snapshot.modelId || configured.modelId,
      modelName: snapshot.modelName || configured.modelName,
    };
  }

  return {
    accessById,
    resolve,
    resolveSnapshot,
    getContext: context,

    async completeChat(options) {
      const { access, secret, adapter } = context(options);
      const raw = await adapter.complete({
        access, secret, messages: options.messages,
        ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
        ...(options.max_tokens === undefined ? {} : { max_tokens: options.max_tokens }),
      });
      const content = String(raw?.choices?.[0]?.message?.content || '').trim();
      if (!content) throw new Error(`模型 ${access.modelName || access.modelId} 未返回正文`);
      return { access, modelSnapshot: snapshotAccess(access), content, raw };
    },

    async submitVideo(options) {
      const { access, secret, adapter } = context(options);
      const result = await adapter.submitVideo({ access, secret, payload: options.payload });
      return { ...result, access, modelSnapshot: snapshotAccess(access) };
    },

    async getVideoTask(options) {
      const { access, secret, adapter } = context(options);
      return adapter.getVideoTask({ access, secret, taskId: options.taskId });
    },

    async submitSkill(options) {
      const { access, secret, adapter } = context(options);
      const result = await adapter.submitSkill({
        access, secret, message: options.message,
        assetIds: options.assetIds || [], threadId: options.threadId || '',
      });
      return { ...result, access, modelSnapshot: snapshotAccess(access) };
    },

    async getSkillRun(options) {
      const { access, secret, adapter } = context(options);
      return adapter.getSkillRun({ access, secret, threadId: options.threadId, runId: options.runId });
    },
  };
}

function importLegacyCredentials({ env = process.env, store, accessRows = [] }) {
  if (!store?.set || !store?.metadata) return [];
  const imported = [];
  const candidates = accessRows.map(normalizeAccessRecord)
    .filter((access) => access.credentialAlias && access.legacyEnvName && String(env[access.legacyEnvName] || '').trim());
  const seen = new Set();
  for (const access of candidates) {
    if (seen.has(access.credentialAlias)) continue;
    seen.add(access.credentialAlias);
    if (store.metadata(access.credentialAlias)) continue;
    store.set(access.credentialAlias, String(env[access.legacyEnvName]).trim());
    imported.push(access.credentialAlias);
  }
  return imported;
}

module.exports = {
  buildAccessMap,
  createWorkerModelRuntime,
  importLegacyCredentials,
  resolveLegacyAccess,
};
