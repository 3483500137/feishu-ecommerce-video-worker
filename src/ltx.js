'use strict';

const LTX_OUTPUT = Object.freeze({
  width: 704,
  height: 1280,
  duration: 5,
  frames: 121,
});

function optionValue(value) {
  if (!Array.isArray(value)) return String(value || '').trim();
  const first = value[0];
  return String(typeof first === 'string' ? first : first?.name || '').trim();
}

function ltxModelChoice(value) {
  const selected = optionValue(value);
  const models = {
    'LTX 2.3 单帧': {
      name: 'LTX 2.3 单帧',
      id: 'aipdd_ltx_2.3',
      mode: 'single',
    },
    'LTX 2.3 首尾帧': {
      name: 'LTX 2.3 首尾帧',
      id: 'aipdd_ltx_2.3 (首尾帧)',
      mode: 'first-last',
    },
  };
  return models[selected] || models['LTX 2.3 单帧'];
}

function requirePublicHttpsUrl(value, label) {
  const text = String(value || '').trim();
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw new Error(`${label}不是有效的公开 HTTPS 地址`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`${label}必须是上游可访问的公开 HTTPS 地址`);
  return parsed.toString();
}

function buildLtxPayload({
  modelValue,
  prompt,
  firstFrameUrl,
  lastFrameUrl = '',
  seed,
}) {
  const model = ltxModelChoice(modelValue);
  const normalizedPrompt = String(prompt || '').trim() || '自然流畅的镜头运动，写实摄影';
  const firstFrame = requirePublicHttpsUrl(firstFrameUrl, '首帧图片');
  const payload = {
    model: model.id,
    prompt: normalizedPrompt,
    width: LTX_OUTPUT.width,
    height: LTX_OUTPUT.height,
    duration: LTX_OUTPUT.duration,
    generate_audio: false,
  };

  if (model.mode === 'first-last') {
    if (!String(lastFrameUrl || '').trim()) throw new Error('LTX 2.3 首尾帧缺少尾帧图片');
    payload.first_frame_image = firstFrame;
    payload.last_frame_image = requirePublicHttpsUrl(lastFrameUrl, '尾帧图片');
    payload.timeline_data = JSON.stringify({
      segments: [{
        prompt: normalizedPrompt,
        length: LTX_OUTPUT.frames,
        color: '#4f8edc',
      }],
    });
  } else {
    payload.image = firstFrame;
  }

  const normalizedSeed = Number(seed);
  if (Number.isSafeInteger(normalizedSeed) && normalizedSeed >= 0) payload.seed = normalizedSeed;
  return payload;
}

function ltxJobAction(row) {
  if (optionValue(row['是否立刻生成视频']) === '是') return 'generate';
  if (optionValue(row['生成状态']) !== '生成中') return 'none';
  return row['外部任务ID'] ? 'resume' : 'generate';
}

function inspectLtxTask(taskData) {
  const status = String(taskData?.status || taskData?.state || '').toLowerCase();
  if (['completed', 'succeeded', 'success'].includes(status)) {
    const resultUrl = taskData?.metadata?.url
      || taskData?.output?.url
      || taskData?.video_url
      || taskData?.url
      || '';
    return resultUrl
      ? { status: 'completed', resultUrl }
      : { status: 'failed', error: 'LTX任务完成但未找到视频结果' };
  }
  if (['failed', 'error', 'cancelled', 'canceled'].includes(status)) {
    const reason = taskData?.error?.message
      || taskData?.error
      || taskData?.message
      || taskData?.fail_reason
      || status;
    return { status: 'failed', error: `LTX生成失败: ${reason}` };
  }
  return { status: 'pending' };
}

function createLtxClient({ baseUrl, apiKey, fetchImpl = fetch }) {
  const normalizedBaseUrl = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!normalizedBaseUrl) throw new Error('缺少配置 ltx_base_url');
  if (!apiKey) throw new Error('缺少用户环境变量 NEWAPI_API_KEY');

  async function request(pathname, options = {}) {
    const response = await fetchImpl(`${normalizedBaseUrl}${pathname}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) {
      const reason = json?.error?.message || json?.message || `HTTP ${response.status}`;
      throw new Error(`LTX接口失败: ${reason}`);
    }
    return json;
  }

  return {
    async submit(payload) {
      const task = await request('/v1/videos', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      const taskId = task?.id || task?.task_id || task?.data?.id || task?.data?.task_id;
      if (!taskId) throw new Error('LTX接口未返回任务ID');
      return { taskId: String(taskId), raw: task };
    },
    get(taskId) {
      return request(`/v1/videos/${encodeURIComponent(taskId)}`, { method: 'GET' });
    },
  };
}

module.exports = {
  LTX_OUTPUT,
  buildLtxPayload,
  createLtxClient,
  inspectLtxTask,
  ltxJobAction,
  ltxModelChoice,
  requirePublicHttpsUrl,
};
