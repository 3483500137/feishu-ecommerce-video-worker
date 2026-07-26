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

function videoCollectionPath(access) {
  return {
    'newapi-video-generations': 'video/generations',
    'apimesh-videos-generations': 'videos/generations',
  }[access?.videoApiStyle] || 'videos';
}

function videoContentFromPayload(payload = {}, { includeRoles = false } = {}) {
  const {
    prompt, image_url: imageUrl, first_frame_url: firstFrameUrl,
    last_frame_url: lastFrameUrl, reference_video_url: referenceVideoUrl,
    content: suppliedContent,
  } = payload || {};
  const content = Array.isArray(suppliedContent) ? [...suppliedContent] : [];
  if (!content.length && prompt) content.push({ type: 'text', text: prompt });
  if (imageUrl) {
    content.push({
      type: 'image_url',
      image_url: { url: imageUrl },
      ...(includeRoles ? { role: 'reference_image' } : {}),
    });
  }
  if (firstFrameUrl) {
    content.push({
      type: 'image_url',
      image_url: { url: firstFrameUrl },
      ...(includeRoles ? { role: 'first_frame' } : {}),
    });
  }
  if (lastFrameUrl) {
    content.push({
      type: 'image_url',
      image_url: { url: lastFrameUrl },
      ...(includeRoles ? { role: 'last_frame' } : {}),
    });
  }
  if (referenceVideoUrl) {
    content.push({
      type: 'video_url',
      video_url: { url: referenceVideoUrl },
      ...(includeRoles ? { role: 'reference_video' } : {}),
    });
  }
  return content;
}

function normalizeResolution(payload = {}) {
  if (payload.resolution) return payload.resolution;
  const width = Number(payload.width);
  const height = Number(payload.height);
  if (Number.isFinite(width) && Number.isFinite(height) && Math.max(width, height) >= 1080) return '1080p';
  return '720p';
}

function normalizeApimeshDuration(duration) {
  const seconds = Number(duration);
  // APIMesh 的 Seedance 参数把 duration 定义为整数秒。参考视频本身仍会
  // 以毫秒精度用于分段与拼接；这里只转换模型请求字段，误差最多 0.5 秒。
  return Number.isFinite(seconds) && seconds > 0 ? Math.max(1, Math.round(seconds)) : undefined;
}

function videoRequestBody(access, payload, modelId) {
  if (access?.videoApiStyle === 'newapi-video-generations') {
    const {
      prompt, image_url: imageUrl, first_frame_url: firstFrameUrl,
      last_frame_url: lastFrameUrl, reference_video_url: referenceVideoUrl,
      content: suppliedContent, aspect_ratio: aspectRatio, width, height, ...parameters
    } = payload || {};
    const hasMedia = Boolean(imageUrl || firstFrameUrl || lastFrameUrl || referenceVideoUrl || suppliedContent);
    const body = {
      ...parameters,
      model: modelId,
      ...(aspectRatio ? { ratio: aspectRatio } : {}),
      resolution: normalizeResolution(payload),
    };
    if (hasMedia) {
      body.content = videoContentFromPayload(payload, { includeRoles: true });
    } else if (prompt) {
      body.prompt = prompt;
    }
    return body;
  }

  if (access?.videoApiStyle !== 'apimesh-videos-generations') {
    return { ...payload, model: modelId };
  }

  const {
    prompt, image_url: imageUrl, first_frame_url: firstFrameUrl,
    last_frame_url: lastFrameUrl, reference_video_url: referenceVideoUrl,
    content: suppliedContent, duration: requestedDuration, ...parameters
  } = payload || {};
  const content = videoContentFromPayload(payload);
  const duration = normalizeApimeshDuration(requestedDuration);
  return {
    ...parameters,
    ...(duration ? { duration } : {}),
    model: modelId,
    content,
  };
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
      const body = { model: access.modelId, messages, ...parameters };
      if (String(access.modelId || '').toLowerCase() === 'kimi-k2.6' && body.temperature !== undefined) {
        body.temperature = 1;
      }
      return requestJson({
        url: endpoint(access.baseUrl, 'chat/completions'),
        secret,
        method: 'POST',
        body,
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
      const collectionPath = videoCollectionPath(access);
      const raw = await requestJson({
        url: endpoint(access.baseUrl, collectionPath),
        secret,
        method: 'POST',
        body: videoRequestBody(access, payload, access.modelId),
      });
      const taskId = raw?.id || raw?.task_id || raw?.data?.id || raw?.data?.task_id;
      if (!taskId) throw new ProviderError('INVALID_RESPONSE', '视频接口未返回任务ID');
      return { taskId: String(taskId), raw };
    },
    getVideoTask({ access, secret, taskId }) {
      const collectionPath = videoCollectionPath(access);
      return requestJson({
        url: endpoint(access.baseUrl, `${collectionPath}/${encodeURIComponent(taskId)}`),
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
  videoCollectionPath,
  videoRequestBody,
  normalizeApimeshDuration,
};
