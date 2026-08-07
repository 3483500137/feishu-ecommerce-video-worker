'use strict';

const { ModelRoutingError, optionValues } = require('./model-routing');
const { promptTargetDirection, targetDirectionInstruction } = require('./douyin-hot');

function option(value, fallback = '') {
  return optionValues(value)[0] || fallback;
}

function text(value) {
  if (Array.isArray(value)) return value.map((item) => text(item)).filter(Boolean).join('\n');
  if (value && typeof value === 'object') return String(value.text || value.name || value.value || '').trim();
  return String(value || '').trim();
}

function extractUrl(value) {
  const raw = text(value);
  if (/^https?:\/\/\S+$/i.test(raw)) return raw;
  const markdownMatches = [...raw.matchAll(/\]\((https?:\/\/[^)\s]+)\)/gi)];
  if (markdownMatches.length) return markdownMatches.at(-1)[1];
  const url = raw.match(/https?:\/\/[^\s)\]}，。；;、]+/i)?.[0] || '';
  return url.replace(/[，。；;、]+$/u, '');
}

function attachmentUrl(value, index = 0) {
  if (!Array.isArray(value) || !value[index]) return '';
  const item = value[index];
  if (typeof item === 'string') return item.trim();
  return String(item.url || item.link || item.download_url || item.tmp_url || '').trim();
}

function requireProtocol(access, protocol, capability) {
  if (!access || access.protocol !== protocol) {
    throw new ModelRoutingError('CAPABILITY_MISMATCH', `所选模型不能执行“${capability}”任务`);
  }
  if (Array.isArray(access.capabilities) && access.capabilities.length && !access.capabilities.includes(capability)) {
    throw new ModelRoutingError('CAPABILITY_MISMATCH', `所选模型不具备“${capability}”能力`);
  }
}

function positiveNumber(value) {
  const normalized = Number(value);
  return Number.isFinite(normalized) && normalized > 0 ? normalized : null;
}

function relayGenerationMethod(row = {}) {
  const selected = option(row['生成方式']);
  if (selected) return selected;

  // A reference-video URL is the complete input for a reference-video task.
  // Treating an unselected mode as text-to-video made "生成视频提示词=是/重新生成"
  // appear to do nothing for otherwise valid rows.
  if (extractUrl(row['参考视频链接']) || attachmentUrl(row['参考视频'])) {
    return '参考视频生成';
  }
  return '文生视频';
}

function relayVideoDuration(row = {}, { referenceDurationSeconds = null } = {}) {
  const method = relayGenerationMethod(row);
  const reference = positiveNumber(referenceDurationSeconds);
  if (method === '参考视频生成' && reference) return reference;
  const explicit = positiveNumber(row['视频时长']);
  if (explicit) return explicit;
  if (method === '参考视频生成') return null;
  return 5;
}

function promptGenerationChoice(row = {}) {
  return option(row['生成视频提示词'], option(row['视频提示词选用'], '是'));
}

function shouldGeneratePrompt(row = {}) {
  const choice = promptGenerationChoice(row);
  return choice === '是' || choice === '重新生成';
}

function hasPromptSource(row = {}) {
  const method = relayGenerationMethod(row);
  if (text(row['提示词库错误'])) return true;
  if (text(row['输入内容要求'])) return true;
  if (text(row['提示词库内容'])) return true;
  if (method === '参考视频生成') {
    return Boolean(extractUrl(row['参考视频链接']) || attachmentUrl(row['参考视频']));
  }
  return false;
}

function shouldRetryVideo(row = {}) {
  return option(row['是否立刻生成视频']) === '重试生成'
    || ['是', '重试'].includes(option(row['重试生成']));
}

// A user-triggered run must continue without waiting for a second worker scan.
// These helpers keep the state transitions explicit and testable.
function relayNextActionAfterPrompt({ requestedVideo = false } = {}) {
  return requestedVideo ? 'submit-video' : 'none';
}

function relayRetryNextAction({ hasPrompt = false } = {}) {
  return hasPrompt ? 'submit-video' : 'generate-prompt';
}

function relayContentJobAction(row = {}) {
  if (shouldRetryVideo(row)) return 'reset-retry';
  const status = option(row['生成状态']);
  const taskId = text(row['外部任务ID']);
  if (taskId && status === '生成中') return 'poll-video';
  if (status === '生成提示词中') return 'none';
  const promptChoice = promptGenerationChoice(row);
  const hasPrompt = Boolean(text(row['视频提示词']));
  if ((promptChoice === '重新生成' || (promptChoice === '是' && !hasPrompt)) && hasPromptSource(row)) {
    return 'generate-prompt';
  }
  if (['已完成', '失败', '需要配置'].includes(status)) return 'none';
  if (!status || status === '待生成提示词') {
    const ready = shouldGeneratePrompt(row) && hasPromptSource(row);
    return ready ? 'generate-prompt' : 'none';
  }
  if (status === '待生成视频' && option(row['是否立刻生成视频']) === '是') return 'submit-video';
  return 'none';
}

function buildRelayPromptRequest(row = {}, access, { referenceVideoDataUrl = '', referenceVideoUrl = '' } = {}) {
  requireProtocol(access, 'chat-completions', '文本');
  if (text(row['提示词库错误'])) {
    throw new ModelRoutingError('CONFIG_REQUIRED', text(row['提示词库错误']));
  }
  const method = relayGenerationMethod(row);
  const rawRequirements = text(row['输入内容要求']);
  const librarySuggestion = text(row['提示词库内容']);
  const requirements = rawRequirements || librarySuggestion || (method === '参考视频生成'
    ? '按参考视频逐镜复刻；如已选择人设，则用所选人设完整替换参考视频人物。'
    : '');
  if (!requirements) throw new ModelRoutingError('CONFIG_REQUIRED', '请填写输入内容要求');
  const duration = Number(row['视频时长'] || 5);
  const ratio = option(row['画面比例'], '9:16');
  const persona = text(row['人设']);
  const targetDirection = promptTargetDirection(row);
  const content = [
    `内容要求：${requirements}`,
    librarySuggestion ? `提示词库建议：${librarySuggestion}` : '',
    targetDirection ? `本次唯一目标方向：${targetDirection}` : '',
    targetDirectionInstruction(targetDirection),
    persona ? `人物设定：${persona}` : '',
    `生成方式：${method}`,
    `视频时长：${duration}秒`,
    `画面比例：${ratio}`,
    '目标：制作复刻视频。必须根据工具提供的参考图片、参考视频或参考链接提炼可执行的视频生成提示词；有参考素材时，以参考素材为准，不要自由改编。',
    '只输出一段适合视频生成模型的中文提示词，不要标题、解释、Markdown或标签。',
  ].filter(Boolean).join('\n');
  const referenceVideoInputUrl = referenceVideoDataUrl || referenceVideoUrl;
  if (method === '参考视频生成' && !referenceVideoInputUrl) {
    throw new ModelRoutingError('CONFIG_REQUIRED', '参考视频生成必须先读取参考视频，不能仅根据文字要求猜测画面');
  }
  const userContent = method === '参考视频生成'
    ? [
      { type: 'video_url', video_url: { url: referenceVideoInputUrl } },
      {
        type: 'text',
        text: [
          '使用已上传的所选人设形象和参考视频生成最终视频。',
          '必须且只能使用“视频生成选用”字段指定的视频模型，不得自动改用其他模型。',
          '已上传的所选人设图片是最终视频的唯一人物形象来源。必须把参考视频中的人物完整替换为该人设；不得保留或混合参考视频原人物的脸、五官、发型、年龄、服装、体型和气质。',
          '参考视频原人物仅用于提供动作、口型、走位和时间点，不得作为人物外观来源。',
          '最终成片画布必须严格为 9:16 竖屏，主体画面必须铺满整个竖屏画布并延伸到四边。',
          '禁止使用横版画布、横版容器、模糊复制侧边背景、镜像延展、左右补边、黑边、白边、画框、三联画或把竖屏内容嵌入横屏背景。',
          '最终视频必须与参考视频时长一致，误差不得超过 1 秒。',
          '只能依据参考视频实际内容提取主体、场景、动作顺序、镜头、构图、运镜和节奏，不得凭空添加视频中不存在的人物、商品或场景。',
          '这是逐镜复刻任务，不是改编或重新创作。唯一允许替换的是人物外观/人设：将参考视频中的原人物完整替换为下方所选人物设定；人物数量及其余内容不变。',
          '完整复刻参考视频的动作、动作顺序与时间点、对白、台词、旁白、原声、BGM、音效、镜头、运镜、构图、场景调度和剪辑节奏，保持音画同步。',
          '除人物外观/人设外，参考视频的镜头、动作、动作顺序、时间点、走位、姿态、道具、运镜、构图、景别、机位、场景、光线、色调、节奏和时长必须逐项复刻，不得增删或改写。',
          '必须按参考视频从 0 秒到结尾的真实时间线连续生成；第二段必须承接第一段之后的参考视频内容，不得把第一段动作、镜头或画面复制到第二段，不得循环、回放或重新开始。',
          '用户要求只作为必要的局部修改指令；“去掉视频上的文字”表示删除画面中的文字、字幕、贴纸和水印，不得因此改变画面内容。未明确要求改变的项目全部保持与参考视频一致。',
          referenceVideoUrl && !referenceVideoDataUrl ? `后台未能下载参考视频，必须直接读取参考视频链接完成分析：${referenceVideoUrl}` : '',
          '参考视频优先级最高；补充提示词不得覆盖参考视频内容。无需展示方案，直接生成最终视频。',
          '输出提示词必须按参考视频真实时间顺序描述可见画面和动作，不得使用“自由发挥”“类似”“大致”等放宽复刻的表述。',
          content,
        ].join('\n'),
      },
    ]
    : content;
  return {
    access,
    messages: [
      { role: 'system', content: '你是短视频逐镜复刻分析师。必须先观看输入视频，再输出忠于真实画面的复刻提示词。除指定人物外观/人设替换和用户明确修改项外，禁止改编、补充或删减任何内容。' },
      { role: 'user', content: userContent },
    ],
    temperature: 0.2,
  };
}

function buildRelayReferenceLinkPrompt(row = {}, { referenceVideoUrl = '' } = {}) {
  if (text(row['提示词库错误'])) {
    throw new ModelRoutingError('CONFIG_REQUIRED', text(row['提示词库错误']));
  }
  const url = referenceVideoUrl || extractUrl(row['参考视频链接']) || attachmentUrl(row['参考视频']);
  if (!url) throw new ModelRoutingError('CONFIG_REQUIRED', '参考视频生成需要参考视频链接');
  const requirements = text(row['输入内容要求'])
    || '按参考视频逐镜复刻；如已选择人设，则用所选人设完整替换参考视频人物。';
  const librarySuggestion = text(row['提示词库内容']);
  const persona = text(row['人设']);
  const duration = positiveNumber(row['视频时长']);
  const targetDirection = promptTargetDirection(row);
  return [
    `参考视频链接：${url}`,
    '使用已上传的所选人设形象和参考视频生成最终视频。',
    '必须且只能使用“视频生成选用”字段指定的视频模型，不得自动改用其他模型。',
    persona ? `已上传的所选人设/人物设定：${persona}` : '如已选择人设，已上传的所选人设图片是最终视频的唯一人物形象来源。',
    '已上传的所选人设图片是最终视频的唯一人物形象来源。必须把参考视频中的人物完整替换为该人设；不得保留或混合参考视频原人物的脸、五官、发型、年龄、服装、体型和气质。',
    '参考视频原人物仅用于提供动作、口型、走位和时间点，不得作为人物外观来源。',
    '最终成片画布必须严格为 9:16 竖屏，主体画面必须铺满整个竖屏画布并延伸到四边。',
    '禁止使用横版画布、横版容器、模糊复制侧边背景、镜像延展、左右补边、黑边、白边、画框、三联画或把竖屏内容嵌入横屏背景。',
    duration
      ? `最终视频必须与参考视频时长一致；当前填写/检测视频时长为 ${duration} 秒，误差不得超过 1 秒。`
      : '最终视频必须与参考视频时长一致；生成前必须读取参考视频并检测其真实时长，误差不得超过 1 秒。',
    '完整复刻参考视频的动作、动作顺序与时间点、对白、台词、旁白、原声、BGM、音效、镜头、运镜、构图、场景调度和剪辑节奏，保持音画同步。',
    '必须按参考视频从 0 秒到结尾的真实时间线连续生成；第二段必须承接第一段之后的参考视频内容，不得把第一段动作、镜头或画面复制到第二段，不得循环、回放或重新开始。',
    `补充要求：${requirements}`,
    librarySuggestion ? `提示词库建议：${librarySuggestion}` : '',
    targetDirection ? `本次唯一目标方向：${targetDirection}` : '',
    targetDirectionInstruction(targetDirection),
    '参考视频优先级最高；补充提示词不得覆盖参考视频内容。无需展示方案，直接生成最终视频。',
  ].filter(Boolean).join('\n');
}

function buildRelayVideoRequest(row = {}, access, options = {}) {
  requireProtocol(access, 'videos', '视频生成');
  const method = relayGenerationMethod(row);
  const prompt = text(row['视频提示词']);
  if (!prompt) throw new ModelRoutingError('CONFIG_REQUIRED', '请先生成或填写视频提示词');

  const duration = relayVideoDuration(row, options);
  const payload = {
    prompt,
    aspect_ratio: method === '参考视频生成' ? '9:16' : option(row['画面比例'], '9:16'),
  };
  if (payload.aspect_ratio === '9:16') {
    payload.width = 1080;
    payload.height = 1920;
  }
  const shouldSendDuration = duration
    && !(method === '参考视频生成' && access?.videoApiStyle === 'newapi-video-generations');
  if (shouldSendDuration) payload.duration = duration;
  // APIMesh 会对模型生成的音轨单独进行内容审核。参考视频复刻的音轨
  // 由后处理从原始参考视频无损时间线复用，因此这里仅生成画面，避免把
  // 原有对白或 BGM 交给模型重新合成而触发不必要的音频审核。
  if (method === '参考视频生成' && access?.videoApiStyle === 'apimesh-videos-generations') {
    payload.generate_audio = false;
  }
  const seed = Number(row['随机种子']);
  if (Number.isFinite(seed) && text(row['随机种子'])) payload.seed = seed;

  if (method === '图生视频') {
    payload.image_url = attachmentUrl(row['参考图片']);
    if (!payload.image_url) throw new ModelRoutingError('CONFIG_REQUIRED', '图生视频需要参考图片');
  } else if (method === '首尾帧') {
    payload.first_frame_url = attachmentUrl(row['参考图片']);
    payload.last_frame_url = attachmentUrl(row['尾帧图片']);
    if (!payload.first_frame_url || !payload.last_frame_url) {
      throw new ModelRoutingError('CONFIG_REQUIRED', '首尾帧生成需要参考图片和尾帧图片');
    }
  } else if (method === '参考视频生成') {
    const personaImageUrl = text(row['人设图片链接']);
    if (personaImageUrl) payload.image_url = personaImageUrl;
    payload.reference_video_url = options.referenceVideoUrl || attachmentUrl(row['参考视频']) || extractUrl(row['参考视频链接']);
    if (!payload.reference_video_url) throw new ModelRoutingError('CONFIG_REQUIRED', '参考视频生成需要参考视频');
  } else if (method !== '文生视频') {
    throw new ModelRoutingError('CONFIG_REQUIRED', `不支持的生成方式：${method}`);
  }
  return { access, payload };
}

function inspectRelayVideoTask(raw = {}) {
  const data = raw?.data && typeof raw.data === 'object' ? raw.data : raw;
  const status = String(data?.status || data?.state || '').trim().toLowerCase();
  const content = Array.isArray(data?.content) ? data.content : [];
  const outputContent = Array.isArray(data?.output?.content) ? data.output.content : [];
  const contentVideoUrl = [...content, ...outputContent]
    .map((item) => item?.video_url?.url || item?.url || '')
    .find((url) => String(url || '').trim());
  // APIMesh completed tasks return a single content object instead of the
  // OpenAI-style content array: { content: { video_url: '...' } }.
  const objectContentVideoUrl = String(
    data?.content?.video_url || data?.content?.video_url?.url || data?.content?.url || '',
  ).trim();
  const resultUrl = String(
    data?.output?.url || data?.result?.url || data?.video?.url || data?.video_url || data?.url || objectContentVideoUrl || contentVideoUrl || '',
  ).trim();
  const error = String(data?.error?.message || data?.error || data?.message || '').trim();
  if (['completed', 'succeeded', 'success', 'done'].includes(status)) {
    return { state: 'completed', resultUrl, error: resultUrl ? '' : '视频任务完成但未返回结果链接' };
  }
  if (['failed', 'error', 'cancelled', 'canceled'].includes(status)) {
    return { state: 'failed', resultUrl: '', error: error || `视频任务状态：${status}` };
  }
  return { state: 'running', resultUrl: '', error: '' };
}

function buildRelayStartPatch({ phase, access, taskId = '', now = '' }) {
  const promptPhase = phase === 'prompt';
  return {
    '生成状态': promptPhase ? '生成提示词中' : '生成中',
    ...(taskId ? { '外部任务ID': taskId } : {}),
    ...(now && !promptPhase ? { '提交时间': now } : {}),
    '失败原因': null,
    '是否立刻生成视频': '否',
  };
}

function friendlyRelayErrorMessage(error) {
  const message = String(error?.message || error || '未知错误').trim();
  const durationLimit = message.match(/video duration \(seconds\).*?less than or equal to\s+([\d.]+).*?model\s+([A-Za-z0-9_.-]+)/i);
  if (durationLimit) {
    return `参考视频时长超过所选模型上限：该模型在参考视频生成模式最多支持 ${durationLimit[1]} 秒。请更换支持长参考视频的模型，或改用分段生成流程。模型：${durationLimit[2]}`;
  }
  if (/Invalid video_url/i.test(message)) {
    return '参考视频链接不是模型可直接读取的视频文件地址。已支持自动解析抖音分享链接；如果仍失败，请检查该分享链接是否可公开访问或是否已过期。';
  }
  if (/input image may contain real person/i.test(message)) {
    return '所选视频模型拒绝真人/拟真人人设图片输入，无法按当前复刻要求使用所选人设形象生成。请在“视频生成选用”中改选支持真人参考图 + 参考视频复刻/人物替换的模型后重试。';
  }
  if (/input video may contain real person/i.test(message)) {
    return '所选视频模型拒绝真人参考视频输入，无法按当前参考视频做复刻。请在“视频生成选用”中改选支持真人参考视频复刻/人物替换的模型后重试。';
  }
  if (/first\/last frame content cannot be mixed with reference media content/i.test(message)) {
    return '所选视频模型不支持把人设参考图与参考视频在同一次请求中混用。请在“视频生成选用”中改选支持“参考图 + 参考视频”复刻的模型后重试。';
  }
  return message || '未知错误';
}

function buildRelayFailurePatch(error, { phase = '' } = {}) {
  const configCodes = new Set(['CONFIG_REQUIRED', 'ACCESS_DISABLED', 'CAPABILITY_MISMATCH', 'AMBIGUOUS_DEFAULT', 'AUTH_FAILED']);
  const message = friendlyRelayErrorMessage(error);
  const modelConfigFailure = /^参考视频时长超过所选模型上限/.test(message)
    || /^所选视频模型/.test(message);
  return {
    '生成状态': configCodes.has(error?.code) || modelConfigFailure ? '需要配置' : '失败',
    '失败原因': message.slice(0, 1000),
    '是否立刻生成视频': '否',
    ...(phase === 'prompt' ? { '生成视频提示词': '否' } : {}),
  };
}

module.exports = {
  relayContentJobAction,
  relayNextActionAfterPrompt,
  relayRetryNextAction,
  buildRelayPromptRequest,
  buildRelayReferenceLinkPrompt,
  buildRelayVideoRequest,
  relayGenerationMethod,
  relayVideoDuration,
  inspectRelayVideoTask,
  buildRelayStartPatch,
  buildRelayFailurePatch,
  friendlyRelayErrorMessage,
};
