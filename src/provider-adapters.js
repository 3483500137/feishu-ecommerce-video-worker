'use strict';

class ProviderError extends Error {
  constructor(code, message, { status = 0, retriable = false } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
    this.status = status;
    this.retriable = retriable;
  }
}

function endpoint(baseUrl, pathname) {
  return `${String(baseUrl || '').replace(/\/+$/, '')}/${String(pathname || '').replace(/^\/+/, '')}`;
}

function redact(value, secret = '') {
  let text = String(value || '未知接口错误');
  if (secret) text = text.split(secret).join('[REDACTED]');
  return text.replace(/\b(?:sk|ak)-[A-Za-z0-9_-]{6,}\b/gi, '[REDACTED]');
}

function errorCode(status) {
  if ([401, 403].includes(status)) return 'AUTH_FAILED';
  if (status === 402) return 'BALANCE_REQUIRED';
  if (status === 429) return 'RATE_LIMITED';
  return status >= 500 ? 'UPSTREAM_UNAVAILABLE' : 'UPSTREAM_REJECTED';
}

function createAdapterRegistry({
  fetchImpl = fetch,
  sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  async function requestJson({ url, secret, method = 'GET', body, idempotent = false }) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await fetchImpl(url, {
        method,
        headers: {
          Authorization: `Bearer ${secret}`,
          'Content-Type': 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const json = await response.json().catch(() => ({}));
      if (response.ok) return json;

      const retriable = [429, 500, 502, 503, 504].includes(response.status);
      if (idempotent && retriable && attempt < 2) {
        await sleepImpl(250 * (2 ** attempt));
        continue;
      }
      const upstream = json?.error?.message || json?.message || json?.errmsg || `HTTP ${response.status}`;
      throw new ProviderError(errorCode(response.status), `模型接口失败: ${redact(upstream, secret)}`, {
        status: response.status,
        retriable,
      });
    }
    throw new ProviderError('UPSTREAM_UNAVAILABLE', '模型接口重试耗尽', { retriable: true });
  }

  async function listOpenAiModels(access, secret) {
    const json = await requestJson({
      url: endpoint(access.baseUrl, 'models'),
      secret,
      idempotent: true,
    });
    return (Array.isArray(json.data) ? json.data : [])
      .map((model) => ({
        id: String(model?.id || '').trim(),
        name: String(model?.name || model?.id || '').trim(),
      }))
      .filter((model) => model.id);
  }

  const chat = {
    listModels: listOpenAiModels,
    async validate(access, secret) {
      const models = await listOpenAiModels(access, secret);
      return { valid: true, modelFound: models.some((model) => model.id === access.modelId), models };
    },
    complete({ access, secret, messages, ...parameters }) {
      return requestJson({
        url: endpoint(access.baseUrl, 'chat/completions'),
        secret,
        method: 'POST',
        body: { model: access.modelId, messages, ...parameters },
      });
    },
  };

  const videos = {
    listModels: listOpenAiModels,
    async validate(access, secret) {
      const models = await listOpenAiModels(access, secret);
      return { valid: true, modelFound: models.some((model) => model.id === access.modelId), models };
    },
    async submitVideo({ access, secret, payload = {} }) {
      const raw = await requestJson({
        url: endpoint(access.baseUrl, 'videos'),
        secret,
        method: 'POST',
        body: { ...payload, model: access.modelId },
      });
      const taskId = raw?.id || raw?.task_id || raw?.data?.id || raw?.data?.task_id;
      if (!taskId) throw new ProviderError('INVALID_RESPONSE', '视频接口未返回任务ID');
      return { taskId: String(taskId), raw };
    },
    getVideoTask({ access, secret, taskId }) {
      return requestJson({
        url: endpoint(access.baseUrl, `videos/${encodeURIComponent(taskId)}`),
        secret,
        idempotent: true,
      });
    },
  };

  const xyq = {
    async listModels(access) {
      return access.modelId ? [{ id: access.modelId, name: access.modelName || access.modelId }] : [];
    },
    async validate(access, secret) {
      return { valid: Boolean(secret && access.modelId), modelFound: Boolean(access.modelId), models: await this.listModels(access) };
    },
    async submitSkill({ access, secret, message, assetIds = [], threadId = '' }) {
      const body = { message };
      if (assetIds.length) body.asset_ids = assetIds;
      if (threadId) body.thread_id = threadId;
      const response = await requestJson({
        url: endpoint(access.baseUrl, 'api/biz/v1/skill/submit_run'),
        secret,
        method: 'POST',
        body,
      });
      if (response.ret !== undefined && response.ret !== '0') {
        throw new ProviderError('UPSTREAM_REJECTED', `小云雀接口失败: ${redact(response.errmsg, secret)}`);
      }
      const raw = response.data || response;
      const run = raw.run || raw;
      return {
        threadId: String(run.thread_id || '').trim(),
        runId: String(run.run_id || '').trim(),
        raw,
      };
    },
    async getSkillRun({ access, secret, threadId, runId }) {
      const response = await requestJson({
        url: endpoint(access.baseUrl, 'api/biz/v1/skill/get_thread'),
        secret,
        method: 'POST',
        body: { thread_id: threadId, run_id: runId, after_seq: 0 },
        idempotent: true,
      });
      if (response.ret !== undefined && response.ret !== '0') {
        throw new ProviderError('UPSTREAM_REJECTED', `小云雀接口失败: ${redact(response.errmsg, secret)}`);
      }
      return response.data?.thread?.run_list?.[0] || response.data || response;
    },
  };

  const adapters = new Map([
    ['chat-completions', chat],
    ['videos', videos],
    ['xyq-skill', xyq],
  ]);

  return {
    get(protocol) {
      const adapter = adapters.get(String(protocol || '').trim());
      if (!adapter) throw new Error(`不支持的API协议: ${protocol || '空'}`);
      return adapter;
    },
  };
}

module.exports = {
  ProviderError,
  createAdapterRegistry,
  redact,
};

