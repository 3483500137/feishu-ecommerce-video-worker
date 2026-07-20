'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { assertValidConfig, loadConfig } = require('./project-config');
const { runLark: invokeLark } = require('./lark-cli');
const { uploadXyqAsset: uploadAssetToXyq } = require('./xyq-client');
const {
  buildExtensionPublishPayload,
  buildPublishIdempotencyKey,
  createPublishTaskId,
  markPublishTaskFailed,
  writePublishTask,
} = require('./multipost-publish');
const {
  buildLtxPayload,
  createLtxClient,
  inspectLtxTask,
  ltxJobAction,
  ltxModelChoice,
} = require('./ltx');
const {
  createRelayMediaStore,
  parseRelayAssetKeys,
} = require('./media-relay');
const {
  buildLtxSegmentPayloads,
  buildLtxStoryboardPrompt,
  concatLtxSegments,
  extractReferenceFrames,
  ltxSegmentCountForDuration,
  parseLtxStoryboard,
  parseLtxTaskIds,
  pollLtxTaskGroup,
  prepareAnalysisVideo,
} = require('./ltx-rebuild');

const ROOT = path.resolve(__dirname, '..');
const CONFIG = loadConfig({ root: ROOT });
const RUNTIME = path.join(ROOT, 'runtime');
const LOG_DIR = path.join(ROOT, 'logs');
const LOCK_FILE = path.join(RUNTIME, 'worker.lock');
const LTX_REFERENCE_CACHE_DIR = path.join(RUNTIME, 'ltx-reference-cache');

function ensureDirs() {
  fs.mkdirSync(RUNTIME, { recursive: true });
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

function ltxReferenceCacheFile(recordId) {
  const safeRecordId = String(recordId || '').replace(/[^A-Za-z0-9_-]/g, '_');
  if (!safeRecordId) throw new Error('LTX reference cache requires a record ID');
  return path.join(LTX_REFERENCE_CACHE_DIR, `${safeRecordId}.mp4`);
}

function cacheLtxReferenceVideo(recordId, sourceFile) {
  const target = ltxReferenceCacheFile(recordId);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(sourceFile, target);
  return target;
}

function removeLtxReferenceCache(recordId) {
  fs.rmSync(ltxReferenceCacheFile(recordId), { force: true });
}

function log(message, details) {
  ensureDirs();
  const suffix = details === undefined ? '' : ` ${typeof details === 'string' ? details : JSON.stringify(details)}`;
  const line = `${new Date().toISOString()} ${message}${suffix}`;
  fs.appendFileSync(path.join(LOG_DIR, 'worker.log'), `${line}\n`, 'utf8');
  process.stdout.write(`${line}\n`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function feishuDateTime(date = new Date()) {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).format(date);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || ROOT,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
    env: options.env || process.env,
  });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `${command} failed`).trim());
  }
  return result.stdout.trim();
}

function runLark(args) {
  return invokeLark(args, { root: ROOT });
}

function rowsFromEnvelope(data) {
  const fields = data.fields || [];
  return (data.data || []).map((values, index) => {
    const row = { record_id: data.record_id_list[index] };
    fields.forEach((field, fieldIndex) => { row[field] = values[fieldIndex]; });
    return row;
  });
}

function firstOption(value) {
  if (Array.isArray(value)) {
    const first = value[0];
    return typeof first === 'string' ? first : first?.name || '';
  }
  return value || '';
}

function linkedRecordId(value) {
  return Array.isArray(value) ? value[0]?.id || '' : '';
}

function videoModelChoice(value) {
  const selected = firstOption(value);
  const models = {
    'Seedance 2.0': { name: 'Seedance 2.0', id: 'seedance2.0_vision' },
    'Seedance 2.0 Fast': { name: 'Seedance 2.0 Fast', id: 'seedance2.0_fast_vision' },
    'Seedance 2.0 Mini': { name: 'Seedance 2.0 Mini', id: 'Seedance_2.0_mini' },
  };
  return models[selected] || models['Seedance 2.0 Mini'];
}

function personaJobAction(row) {
  if (firstOption(row['是否立刻生成人设']) === '是') return 'generate';
  if (['失败', '生成中'].includes(firstOption(row['人设生成状态']))) return 'none';
  if (!row['人物形象']) return 'backfill';
  return 'none';
}

function contentJobAction(row) {
  if (firstOption(row['是否立刻生成视频']) === '是') return 'generate';
  if (firstOption(row['生成状态']) !== '生成中') return 'none';
  if (row['小云雀线程ID'] && row['小云雀运行ID']) return 'resume';
  return 'generate';
}

function platformPublishJobAction(row) {
  const publishStatus = firstOption(row['发布状态']);
  const copyStatus = firstOption(row['文案生成状态']);
  if (['发布中', '发布成功', '已取消'].includes(publishStatus)) return 'none';
  if (copyStatus === '失败') return 'none';
  const copyComplete = row['发布标题'] && row['发布文案'] && row['标签'] && copyStatus === '已完成';
  if (copyComplete) {
    const confirmation = firstOption(row['确认发布']);
    const hasExistingTask = Boolean(row['MultiPost任务ID'] || row['幂等键']);
    if (confirmation === '重试发布' && publishStatus === '发布失败' && hasExistingTask) return 'retry';
    return confirmation === '是' && publishStatus === '待确认' && !hasExistingTask ? 'publish' : 'none';
  }
  const hasInputs = linkedRecordId(row['内容'])
    && linkedRecordId(row['平台账号'])
    && extractMarkdownUrl(row['最终视频']);
  return hasInputs ? 'generate' : 'none';
}

function buildPublishAttempt(row, { retry = false } = {}) {
  if (!retry) {
    return {
      attempt: 0,
      confirmation: firstOption(row['确认发布']) || '是',
      previousTaskId: '',
    };
  }
  const previousTaskId = String(row['MultiPost任务ID'] || '').trim();
  if (!previousTaskId) throw new Error('重试发布缺少历史 MultiPost任务ID');
  return {
    attempt: Math.max(0, Math.trunc(Number(row['重试次数']) || 0)) + 1,
    confirmation: '是',
    previousTaskId,
  };
}

function buildPublishCopyPrompt({ platform, contentNumber, videoPrompt }) {
  return [
    `请观看视频，为${platform || '目标短视频平台'}生成短、准、有互动感的中文标题、发布文案和标签。`,
    `内容流水号：${contentNumber || '未提供'}`,
    videoPrompt ? `视频制作要求：${videoPrompt}` : '',
    '硬性长度：标题不超过 20 字；正文 20 至 45 字，最多两句；标签 3 至 5 个。',
    '正文结构：第一句只提炼一个最吸引人的亮点或情绪钩子，第二句用自然问句邀请互动。',
    '风格：像真人随手发布，口语化、有画面感；禁止逐镜头复述动作、服装和场景，禁止写成长段视频简介。',
    '准确性：只写视频中确实出现的内容，不虚构价格、功效、活动或联系方式；正文中不要堆标签。',
    '只输出严格 JSON，不要 Markdown 代码块或解释。格式：{"title":"标题","copy":"发布文案","tags":["标签1","标签2"]}',
  ].filter(Boolean).join('\n');
}

function parsePublishCopy(raw) {
  const text = String(raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('Kimi未返回有效的发布文案 JSON');
  let parsed;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch (error) {
    throw new Error(`Kimi发布文案 JSON 解析失败: ${error.message}`);
  }
  const title = String(parsed.title || parsed.标题 || '').trim();
  const copy = String(parsed.copy || parsed.content || parsed.文案 || '').trim();
  const rawTags = Array.isArray(parsed.tags)
    ? parsed.tags
    : String(parsed.tags || parsed.标签 || '').split(/[\s,，、]+/);
  const tags = [...new Set(rawTags
    .map((tag) => String(tag || '').trim().replace(/^#+/, ''))
    .filter(Boolean))];
  if (!title || !copy || !tags.length) throw new Error('Kimi返回的标题、文案或标签不完整');
  if (title.length > 20) throw new Error(`发布标题超过 20 字（当前 ${title.length} 字）`);
  if (copy.length > 45) throw new Error(`发布文案超过 45 字（当前 ${copy.length} 字）`);
  if (tags.length < 3 || tags.length > 5) throw new Error(`发布标签必须为 3 至 5 个（当前 ${tags.length} 个）`);
  return { title, copy, tags };
}

function formatPublishTags(tags) {
  return tags.map((tag) => `#${String(tag).trim().replace(/^#+/, '')}`).filter((tag) => tag !== '#').join(' ');
}

function extractMarkdownUrl(value) {
  if (!value || typeof value !== 'string') return '';
  const text = value.trim();
  if (/^https?:\/\/\S+$/i.test(text)) return text;
  const match = text.match(/\((https?:\/\/[^)\s]+)\)$/i);
  return match ? match[1] : '';
}

function ltxReferenceUrl(value) {
  const text = String(value || '').trim();
  if (!text) throw new Error('请填写参考视频链接');
  const url = extractMarkdownUrl(text);
  if (!url) throw new Error('参考视频链接必须是有效的 HTTP 或 HTTPS 地址');
  return url;
}

function collectUrls(value, output = []) {
  if (typeof value === 'string') {
    const normalized = value.replace(/\\u0026/gi, '&').replace(/\\u002f/gi, '/');
    const matches = normalized.match(/https?:\/\/[^\s"'<>\\]+/g);
    if (matches) output.push(...matches.map((url) => url.replace(/[),.;]+$/, '')));
    if (/^[{[]/.test(value)) {
      try { collectUrls(JSON.parse(value), output); } catch {}
    }
  } else if (Array.isArray(value)) {
    value.forEach((item) => collectUrls(item, output));
  } else if (value && typeof value === 'object') {
    Object.values(value).forEach((item) => collectUrls(item, output));
  }
  return [...new Set(output)];
}

function chooseArtifactUrl(runData, kind) {
  const subtype = kind === 'video' ? 'biz/x_data_video' : 'biz/x_data_image';
  const entries = Array.isArray(runData?.entry_list) ? runData.entry_list : [];
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const contents = Array.isArray(entries[index]?.artifact?.content) ? entries[index].artifact.content : [];
    const matching = contents.filter((item) => item?.sub_type === subtype);
    const urls = matching.flatMap((item) => {
      if (typeof item.data === 'string' && /^[{[]/.test(item.data.trim())) {
        try { return collectUrls(JSON.parse(item.data)); } catch {}
      }
      return collectUrls(item.data);
    });
    const preferred = kind === 'video'
      ? urls.find((url) => /(?:\.mp4(?:\?|$)|mime_type=video)/i.test(url))
      : urls.find((url) => /(?:\.(?:png|jpe?g|webp)(?:\?|$)|mime_type=image|origin_url)/i.test(url));
    if (preferred || urls[0]) return preferred || urls[0];
  }
  return '';
}

function inspectXyqRun(runData, kind) {
  const state = Number(runData?.state);
  if (state === 3) {
    const resultUrl = chooseArtifactUrl(runData, kind);
    if (resultUrl) return { status: 'completed', resultUrl };
    return { status: 'failed', error: `小云雀任务完成但未找到${kind === 'video' ? '视频' : '图片'}结果` };
  }
  if (state === 4) return { status: 'failed', error: `小云雀生成失败: ${runData?.fail_reason || '未知原因'}` };
  if (state === 5) return { status: 'failed', error: '小云雀任务已取消' };
  return { status: 'pending' };
}

function listRecords(tableId, fields) {
  const args = ['base', '+record-list', '--base-token', CONFIG.base_token, '--table-id', tableId, '--limit', '200'];
  fields.forEach((field) => args.push('--field-id', field));
  return rowsFromEnvelope(runLark(args));
}

function updateRecord(tableId, recordId, patch) {
  runLark([
    'base', '+record-upsert', '--base-token', CONFIG.base_token,
    '--table-id', tableId, '--record-id', recordId, '--json', JSON.stringify(patch),
  ]);
}

function taskLink(threadId) {
  return `https://xyq.jianying.com/home?tab_name=integrated-agent&thread_id=${encodeURIComponent(threadId)}&agent_name=pippit_nest_agent`;
}

async function downloadHttp(url, targetBase) {
  const response = await fetch(url, {
    redirect: 'follow',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36',
      Referer: 'https://xyq.jianying.com/',
    },
  });
  if (!response.ok) throw new Error(`下载失败 HTTP ${response.status}: ${url}`);
  const contentType = response.headers.get('content-type') || '';
  const ext = /png/i.test(contentType) ? '.png' : /webp/i.test(contentType) ? '.webp' : /jpe?g/i.test(contentType) ? '.jpg' : path.extname(new URL(response.url).pathname) || '.bin';
  const target = `${targetBase}${ext}`;
  fs.writeFileSync(target, Buffer.from(await response.arrayBuffer()));
  return target;
}

function downloadReferenceVideo(url, outputDir) {
  fs.mkdirSync(outputDir, { recursive: true });
  const template = path.join(outputDir, 'reference.%(ext)s');
  const commonArgs = ['--no-playlist', '-f', 'bv*+ba/b', '--merge-output-format', 'mp4', '-o', template];
  run(CONFIG.yt_dlp_command || 'yt-dlp', [...commonArgs, url]);
  const files = fs.readdirSync(outputDir).filter((name) => /^reference\./i.test(name));
  if (!files.length) throw new Error('参考视频下载后未找到输出文件');
  return path.join(outputDir, files[0]);
}

function downloadBaseAttachment(tableId, recordId, attachmentValue, outputDir) {
  const token = Array.isArray(attachmentValue) ? attachmentValue[0]?.file_token : '';
  if (!token) return '';
  fs.mkdirSync(outputDir, { recursive: true });
  const relativeDir = `.${path.sep}${path.relative(ROOT, outputDir)}`;
  runLark([
    'base', '+record-download-attachment', '--base-token', CONFIG.base_token,
    '--table-id', tableId, '--record-id', recordId, '--file-token', token,
    '--output', relativeDir, '--overwrite',
  ]);
  const files = fs.readdirSync(outputDir);
  if (!files.length) throw new Error('飞书附件下载后未找到文件');
  return path.join(outputDir, files[0]);
}

async function resolveReferenceSource({ attachmentFile, referenceUrl, download }) {
  if (attachmentFile) return { file: attachmentFile, fallbackUrl: '', downloadError: '' };
  if (!referenceUrl) return { file: '', fallbackUrl: '', downloadError: '' };
  try {
    return { file: await download(referenceUrl), fallbackUrl: '', downloadError: '' };
  } catch (error) {
    return { file: '', fallbackUrl: referenceUrl, downloadError: error.message };
  }
}

function buildVideoGenerationMessage({ referenceDurationSeconds, fallbackUrl = '', videoPrompt = '', videoModel = '' }) {
  const model = videoModelChoice(videoModel);
  const durationInstruction = Number.isFinite(referenceDurationSeconds)
    ? `参考视频检测时长为 ${referenceDurationSeconds.toFixed(3)} 秒。最终视频必须与参考视频时长一致，误差不得超过 1 秒。`
    : '生成前必须先读取参考视频并检测其精确时长；最终视频必须以检测到的参考时长为准，误差不得超过 1 秒。';
  return [
    '使用已上传的所选人设形象和参考视频生成最终视频。',
    `必须且只能使用指定视频模型：${model.name}；模型标识：${model.id}。不得自动改用其他模型。`,
    '已上传的所选人设图片是最终视频的唯一人物形象来源。必须把参考视频中的人物完整替换为该人设；不得保留或混合参考视频原人物的脸、五官、发型、年龄、服装、体型和气质。',
    '参考视频原人物仅用于提供动作、口型、走位和时间点，不得作为人物外观来源。',
    '最终成片画布必须严格为 9:16 竖屏，建议分辨率为 1080×1920 或 720×1280；主体画面必须铺满整个竖屏画布并延伸到四边。',
    '禁止使用横版画布、横版容器、模糊复制侧边背景、镜像延展、左右补边、黑边、白边、画框、三联画或把竖屏内容嵌入横屏背景。参考素材画幅不同时，只能通过裁切、重新构图和镜头重排适配 9:16。',
    durationInstruction,
    '完整复刻参考视频的动作、动作顺序与时间点、对白、台词、旁白、原声、BGM、音效、镜头、运镜、构图、场景调度和剪辑节奏，保持音画同步。',
    fallbackUrl ? `参考视频链接：${fallbackUrl}。本地下载受平台限制，请直接读取该链接作为参考视频。` : '',
    videoPrompt ? `补充视频提示词：${videoPrompt}` : '',
    '参考视频优先级最高；补充提示词不得覆盖参考视频内容。无需展示方案，直接生成最终视频。',
  ].filter(Boolean).join('\n');
}

function buildPersonaImagePrompt(persona, userRequirement = '', { useReferenceFace = false } = {}) {
  return [
    `根据以下人设生成单人全身人物形象照片：${persona}`,
    `用户要求：${userRequirement}`,
    useReferenceFace
      ? '随任务上传的参考图片是人物人脸身份的唯一来源。生成结果必须与参考图片保持同一个人，保留可识别的脸型、五官结构和个人面部特征，不得改成或混合其他人的脸。参考图片仅用于锁定人脸身份，不得照搬参考图的背景、服装和姿势；服装、造型、构图和场景仍按人设与用户要求生成。'
      : '',
    '输出必须是真实相机拍摄的真人摄影效果：真实成年女性，自然皮肤纹理、真实五官比例、自然人体结构和真实光影，不得呈现渲染质感。',
    '人物必须是20至30岁的成年清纯女生，严格保持用户指定服装；画面为单人全身照片，不得出现其他人物。',
    '禁止生成2D、动漫、插画、卡通、二次元、绘画、3D CG、游戏建模、数字人、塑料皮肤或明显渲染风格。',
    '直接生成最终图片。',
  ].filter(Boolean).join('\n');
}

async function buildPersonaImageRequest({
  persona,
  userRequirement = '',
  referenceFile = '',
  uploadAsset = uploadXyqAsset,
}) {
  const useReferenceFace = Boolean(referenceFile);
  return {
    message: buildPersonaImagePrompt(persona, userRequirement, { useReferenceFace }),
    assetIds: useReferenceFace ? [await uploadAsset(referenceFile)] : [],
  };
}

function probeVideoDuration(filePath, spawn = spawnSync) {
  if (!filePath) return null;
  const result = spawn('ffmpeg', ['-hide_banner', '-i', filePath], {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
  });
  const output = String(result.stderr || result.stdout || '');
  const match = output.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/i);
  if (!match) return null;
  const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

async function uploadXyqAsset(filePath) {
  return uploadAssetToXyq(filePath, {
    baseUrl: CONFIG.xyq_base_url,
    accessKey: process.env.XYQ_ACCESS_KEY,
  });
}

async function xyqPost(endpoint, body) {
  const response = await fetch(`${CONFIG.xyq_base_url}${endpoint}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.XYQ_ACCESS_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok || json.ret !== '0') throw new Error(`小云雀接口失败: ${json.errmsg || response.status}`);
  return json.data;
}

async function submitXyq(message, assetIds = [], threadId = '') {
  const body = { message };
  if (assetIds.length) body.asset_ids = assetIds;
  if (threadId) body.thread_id = threadId;
  const data = await xyqPost('/api/biz/v1/skill/submit_run', body);
  return {
    threadId: data.run?.thread_id || '',
    runId: data.run?.run_id || '',
    webLink: data.web_thread_link || '',
  };
}

async function getXyqRun(threadId, runId) {
  const data = await xyqPost('/api/biz/v1/skill/get_thread', { thread_id: threadId, run_id: runId, after_seq: 0 });
  return data.thread?.run_list?.[0] || {};
}

async function completeXyqTask({ message, assetIds, kind, onRun }) {
  let submitted = await submitXyq(message, assetIds);
  if (!submitted.threadId || !submitted.runId) throw new Error('小云雀提交未返回线程ID或运行ID');
  await onRun(submitted);
  const deadline = Date.now() + CONFIG.max_poll_minutes * 60_000;
  let confirmed = false;

  while (Date.now() < deadline) {
    await sleep(CONFIG.poll_interval_seconds * 1000);
    const runData = await getXyqRun(submitted.threadId, submitted.runId);
    const state = Number(runData.state);
    if (state === 3) {
      const resultUrl = chooseArtifactUrl(runData, kind);
      if (!resultUrl) throw new Error(`小云雀任务完成但未找到${kind === 'video' ? '视频' : '图片'}结果`);
      return { ...submitted, resultUrl, raw: runData };
    }
    if (state === 4) throw new Error(`小云雀生成失败: ${runData.fail_reason || '未知原因'}`);
    if (state === 5) throw new Error('小云雀任务已取消');
    if (state === 9 && !confirmed) {
      submitted = await submitXyq('确认。严格按照已提交要求直接生成最终结果，不再询问或展示方案。', [], submitted.threadId);
      confirmed = true;
      await onRun(submitted);
    }
  }
  throw new Error(`小云雀任务超过 ${CONFIG.max_poll_minutes} 分钟仍未完成`);
}

async function kimiPersona(row) {
  const response = await fetch(`${CONFIG.kimi_base_url}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.KIMI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: CONFIG.kimi_model,
      messages: [
        { role: 'system', content: '根据用户填写的人设类型和要求，输出一段可直接用于短视频创作的详细人物人设。只输出人设正文。人物必须是20至30岁的成年女性。' },
        { role: 'user', content: `人设类型：${firstOption(row['人设类型'])}\n输入人设要求：${row['输入人设要求'] || ''}` },
      ],
    }),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Kimi接口失败: ${json.error?.message || response.status}`);
  const persona = json.choices?.[0]?.message?.content?.trim();
  if (!persona) throw new Error('Kimi未返回人设正文');
  return persona;
}

async function fetchVideoDataUrl(url, maxBytes = 70 * 1024 * 1024) {
  const response = await fetch(url, {
    redirect: 'follow',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36',
    },
  });
  if (!response.ok) throw new Error(`最终视频下载失败 HTTP ${response.status}`);
  const declaredBytes = Number(response.headers.get('content-length') || 0);
  if (declaredBytes > maxBytes) throw new Error(`最终视频过大（${Math.ceil(declaredBytes / 1024 / 1024)} MB），无法提交给 Kimi`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length) throw new Error('最终视频下载结果为空');
  if (buffer.length > maxBytes) throw new Error(`最终视频过大（${Math.ceil(buffer.length / 1024 / 1024)} MB），无法提交给 Kimi`);
  const contentType = (response.headers.get('content-type') || 'video/mp4').split(';')[0];
  const mime = contentType.startsWith('video/') ? contentType : 'video/mp4';
  return `data:${mime};base64,${buffer.toString('base64')}`;
}

function readVideoDataUrl(filePath, maxBytes = 70 * 1024 * 1024) {
  const stat = fs.statSync(filePath);
  if (!stat.isFile() || !stat.size) throw new Error('参考视频文件为空');
  if (stat.size > maxBytes) {
    throw new Error(`参考视频分析副本过大（${Math.ceil(stat.size / 1024 / 1024)} MB），无法提交给 Kimi`);
  }
  const ext = path.extname(filePath).toLowerCase();
  const mime = ext === '.webm' ? 'video/webm' : ext === '.mov' ? 'video/quicktime' : 'video/mp4';
  return `data:${mime};base64,${fs.readFileSync(filePath).toString('base64')}`;
}

function buildLtxAnalysisRequest({ model, videoDataUrl, durationSeconds, segmentCount, userPrompt = '' }) {
  return {
    model,
    messages: [
      {
        role: 'system',
        content: '你是短视频分镜分析师。只能依据视频实际画面输出可供图生视频模型使用的视觉提示词，主体和产品不得凭空改变。',
      },
      {
        role: 'user',
        content: [
          { type: 'video_url', video_url: { url: videoDataUrl } },
          { type: 'text', text: buildLtxStoryboardPrompt({ durationSeconds, segmentCount, userPrompt }) },
        ],
      },
    ],
  };
}

async function requestLtxStoryboard({
  videoFile,
  durationSeconds,
  segmentCount = ltxSegmentCountForDuration(durationSeconds),
  userPrompt = '',
  baseUrl = CONFIG.kimi_base_url,
  model = CONFIG.kimi_model,
  apiKey = process.env.KIMI_API_KEY,
  fetchImpl = fetch,
}) {
  const response = await fetchImpl(`${String(baseUrl).replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(buildLtxAnalysisRequest({
      model,
      videoDataUrl: readVideoDataUrl(videoFile),
      durationSeconds,
      segmentCount,
      userPrompt,
    })),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Kimi接口失败: ${json.error?.message || response.status}`);
  return parseLtxStoryboard(json.choices?.[0]?.message?.content, segmentCount);
}

async function kimiPublishCopy(row, contentRow = {}) {
  const videoUrl = extractMarkdownUrl(row['最终视频']);
  if (!videoUrl) throw new Error('缺少可读取的最终视频链接');
  const videoDataUrl = await fetchVideoDataUrl(videoUrl);
  const prompt = buildPublishCopyPrompt({
    platform: firstOption(row['平台']),
    contentNumber: row['内容流水号'] || contentRow['内容流水号'],
    videoPrompt: contentRow['视频提示词'],
  });
  const response = await fetch(`${CONFIG.kimi_base_url}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.KIMI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: CONFIG.kimi_model,
      messages: [
        {
          role: 'system',
          content: '你是短视频平台发布编辑。必须基于视频实际画面生成标题、文案和标签，不得编造视频中没有的信息。',
        },
        {
          role: 'user',
          content: [
            { type: 'video_url', video_url: { url: videoDataUrl } },
            { type: 'text', text: prompt },
          ],
        },
      ],
    }),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Kimi接口失败: ${json.error?.message || response.status}`);
  return parsePublishCopy(json.choices?.[0]?.message?.content);
}

async function processPlatformPublish(row, contentById, accountById) {
  const recordId = row.record_id;
  const contentId = linkedRecordId(row['内容']);
  const accountId = linkedRecordId(row['平台账号']);
  const contentRow = contentById.get(contentId) || {};
  const accountRow = accountById.get(accountId) || {};
  const platform = firstOption(row['平台']) || firstOption(accountRow['平台']) || '未指定平台';
  const contentNumber = row['内容流水号'] || contentRow['内容流水号'] || contentId;
  const accountNumber = accountRow['账号编号'] || accountId;
  const taskName = `${contentNumber}-${platform}-${accountNumber}`;
  updateRecord(CONFIG.platform_publish_table_id, recordId, {
    '发布任务': taskName,
    '文案生成状态': '生成中',
    '发布状态': '生成文案中',
    '确认发布': '否',
    '失败原因': null,
  });
  log('开始生成平台发布文案', { recordId, taskName });
  try {
    const generated = await kimiPublishCopy({ ...row, '平台': platform, '内容流水号': contentNumber }, contentRow);
    updateRecord(CONFIG.platform_publish_table_id, recordId, {
      '发布任务': taskName,
      '发布标题': generated.title,
      '发布文案': generated.copy,
      '标签': formatPublishTags(generated.tags),
      '文案生成状态': '已完成',
      '确认发布': '否',
      '发布状态': '待确认',
      '失败原因': null,
    });
    log('平台发布文案生成完成', { recordId, taskName });
  } catch (error) {
    updateRecord(CONFIG.platform_publish_table_id, recordId, {
      '发布任务': taskName,
      '文案生成状态': '失败',
      '发布状态': '需要人工处理',
      '失败原因': String(error.message).slice(0, 1000),
    });
    log('平台发布文案生成失败', { recordId, taskName, error: error.message });
  }
}

function openPublishBridge(taskId) {
  const port = Number(CONFIG.multipost_account_port) || 17386;
  const url = `http://127.0.0.1:${port}/multipost/publish?task_id=${encodeURIComponent(taskId)}`;
  const chromeCandidates = process.platform === 'win32'
    ? [
      path.join(process.env.PROGRAMFILES || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ]
    : [];
  const chromeExecutable = chromeCandidates.find((candidate) => candidate && fs.existsSync(candidate));
  const command = chromeExecutable || (process.platform === 'win32' ? 'rundll32.exe' : 'xdg-open');
  const args = chromeExecutable
    ? [url]
    : process.platform === 'win32'
      ? ['url.dll,FileProtocolHandler', url]
      : [url];
  const child = spawn(command, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  return url;
}

async function processConfirmedPublish(row, accountById, { retry = false } = {}) {
  const recordId = row.record_id;
  const accountRecordId = linkedRecordId(row['平台账号']);
  const account = accountById.get(accountRecordId);
  const videoUrl = extractMarkdownUrl(row['最终视频']);
  const retryCount = Number(row['重试次数'] || 0);
  let attempt = retry ? retryCount + 1 : 0;

  try {
    const publishAttempt = buildPublishAttempt(row, { retry });
    attempt = publishAttempt.attempt;
    if (!account) throw new Error('未找到关联的平台账号记录');
    if (firstOption(account['是否启用']) !== '是') throw new Error('关联的平台账号未启用');
    if (firstOption(account['登录状态']) !== '有效') throw new Error('关联的平台账号登录状态不是“有效”');
    if (!account['MultiPost账号ID']) throw new Error('关联的平台账号缺少 MultiPost账号ID');

    const platform = firstOption(row['平台']) || firstOption(account['平台']);
    const payload = buildExtensionPublishPayload({
      platform,
      title: row['发布标题'],
      content: row['发布文案'],
      tags: row['标签'],
      videoUrl,
      scheduledPublishTime: row['计划发布时间'],
    });
    const idempotencyKey = buildPublishIdempotencyKey({
      recordId,
      accountRecordId,
      videoUrl,
      attempt,
    });
    const taskId = createPublishTaskId(recordId);
    const task = {
      taskId,
      recordId,
      accountRecordId,
      idempotencyKey,
      status: 'queued',
      createdAt: new Date().toISOString(),
      expectedAccount: {
        platformKey: account['MultiPost平台标识'],
        accountId: String(account['MultiPost账号ID']),
        username: account['账号昵称'] || '',
      },
      payload,
    };

    if (retry && !markPublishTaskFailed(publishAttempt.previousTaskId, '由飞书发起受控重试')) {
      throw new Error('未找到可终止的历史 MultiPost 发布任务');
    }
    writePublishTask(task);
    const publishPatch = {
      '发布状态': '发布中',
      'MultiPost任务ID': taskId,
      '幂等键': idempotencyKey,
      '失败原因': null,
    };
    if (retry) {
      publishPatch['确认发布'] = publishAttempt.confirmation;
      publishPatch['重试次数'] = attempt;
    }
    updateRecord(CONFIG.platform_publish_table_id, recordId, publishPatch);
    const bridgeUrl = openPublishBridge(taskId);
    log('已创建 MultiPost 真实发布任务', {
      recordId,
      taskId,
      platform,
      accountId: account['MultiPost账号ID'],
      bridgeUrl,
    });
  } catch (error) {
    const failurePatch = {
      '发布状态': '发布失败',
      '失败原因': String(error.message).slice(0, 1000),
      '重试次数': retry ? attempt : retryCount + 1,
    };
    if (retry) failurePatch['确认发布'] = '是';
    updateRecord(CONFIG.platform_publish_table_id, recordId, failurePatch);
    log('创建 MultiPost 发布任务失败', { recordId, error: error.message });
  }
}

function findFileTokens(value, output = []) {
  if (Array.isArray(value)) value.forEach((item) => findFileTokens(item, output));
  else if (value && typeof value === 'object') {
    if (typeof value.file_token === 'string') output.push(value.file_token);
    Object.values(value).forEach((item) => findFileTokens(item, output));
  }
  return [...new Set(output)];
}

function replaceAttachment(tableId, recordId, fieldId, filePath) {
  const current = runLark([
    'base', '+record-get', '--base-token', CONFIG.base_token, '--table-id', tableId,
    '--record-id', recordId, '--field-id', fieldId,
  ]);
  for (const token of findFileTokens(current)) {
    runLark([
      'base', '+record-remove-attachment', '--base-token', CONFIG.base_token,
      '--table-id', tableId, '--record-id', recordId, '--field-id', fieldId,
      '--file-token', token, '--yes',
    ]);
  }
  const relativeFile = `.${path.sep}${path.relative(ROOT, filePath)}`;
  runLark([
    'base', '+record-upload-attachment', '--base-token', CONFIG.base_token,
    '--table-id', tableId, '--record-id', recordId, '--field-id', fieldId,
    '--file', relativeFile,
  ]);
}

async function processPersona(row) {
  const recordId = row.record_id;
  const workDir = path.join(RUNTIME, `persona-${recordId}`);
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(workDir, { recursive: true });
  log('开始处理人设', { recordId, number: row['人设编号'] });
  updateRecord(CONFIG.persona_table_id, recordId, {
    '人设生成状态': '生成中',
    '是否立刻生成人设': '否',
    '失败原因': null,
  });

  try {
    const persona = await kimiPersona(row);
    updateRecord(CONFIG.persona_table_id, recordId, { '人设': persona });
    const referenceFile = downloadBaseAttachment(
      CONFIG.persona_table_id,
      recordId,
      row['参考图片'],
      path.join(workDir, 'reference-face'),
    );
    const imageRequest = await buildPersonaImageRequest({
      persona,
      userRequirement: row['输入人设要求'] || '',
      referenceFile,
    });
    const result = await completeXyqTask({
      message: imageRequest.message,
      assetIds: imageRequest.assetIds,
      kind: 'image',
      onRun: async ({ threadId, runId, webLink }) => updateRecord(CONFIG.persona_table_id, recordId, {
        '形象线程ID': threadId,
        '形象运行ID': runId,
        '形象任务链接': webLink || taskLink(threadId),
      }),
    });
    const imageFile = await downloadHttp(result.resultUrl, path.join(workDir, 'persona'));
    replaceAttachment(CONFIG.persona_table_id, recordId, CONFIG.persona_image_attachment_field_id, imageFile);
    updateRecord(CONFIG.persona_table_id, recordId, {
      '形象结果原始数据（内部）': JSON.stringify({ url: result.resultUrl }),
      '人设生成状态': '已完成',
      '失败原因': null,
    });
    log('人设处理完成', { recordId, number: row['人设编号'] });
  } catch (error) {
    updateRecord(CONFIG.persona_table_id, recordId, { '人设生成状态': '失败', '失败原因': String(error.message).slice(0, 1000) });
    log('人设处理失败', { recordId, error: error.message });
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

async function backfillPersonaAttachment(row) {
  const recordId = row.record_id;
  const workDir = path.join(RUNTIME, `persona-backfill-${recordId}`);
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(workDir, { recursive: true });
  try {
    let imageUrl = extractMarkdownUrl(row['人物形象链接（内部）']) || row['人物形象链接（内部）'] || '';
    if (!imageUrl && row['形象线程ID'] && row['形象运行ID']) {
      const runData = await getXyqRun(row['形象线程ID'], row['形象运行ID']);
      imageUrl = chooseArtifactUrl(runData, 'image');
    }
    if (!imageUrl) return false;
    const imageFile = await downloadHttp(imageUrl, path.join(workDir, 'persona'));
    replaceAttachment(CONFIG.persona_table_id, recordId, CONFIG.persona_image_attachment_field_id, imageFile);
    updateRecord(CONFIG.persona_table_id, recordId, {
      '形象结果原始数据（内部）': JSON.stringify({ url: imageUrl }),
      '人设生成状态': '已完成',
      '失败原因': null,
    });
    log('人物形象附件补齐', { recordId, number: row['人设编号'] });
    return true;
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

async function processContent(row, personaById) {
  const recordId = row.record_id;
  const workDir = path.join(RUNTIME, `content-${recordId}`);
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(workDir, { recursive: true });
  log('开始处理视频', { recordId, number: row['内容流水号'] });
  updateRecord(CONFIG.content_table_id, recordId, {
    '生成状态': '生成中',
    '是否立刻生成视频': '否',
    '失败原因': null,
    '小云雀线程ID': null,
    '小云雀运行ID': null,
    '生成任务链接': null,
    '最终视频': null,
  });

  try {
    const personaId = linkedRecordId(row['人设']);
    const persona = personaById.get(personaId);
    if (!persona) throw new Error('未找到所选择的人设记录');
    const personaUrl = extractMarkdownUrl(persona['人物形象链接（内部）']) || persona['人物形象链接（内部）'];
    if (!personaUrl) throw new Error('所选择的人设没有可用的人物形象，请先生成人物形象');

    const personaFile = await downloadHttp(personaUrl, path.join(workDir, 'selected-persona'));
    const assetIds = [await uploadXyqAsset(personaFile)];
    const referenceAttachment = row['参考视频文件'];
    const referenceUrl = extractMarkdownUrl(row['参考视频链接']) || row['参考视频链接'] || '';
    const attachmentFile = downloadBaseAttachment(CONFIG.content_table_id, recordId, referenceAttachment, path.join(workDir, 'reference-file'));
    const referenceSource = await resolveReferenceSource({
      attachmentFile,
      referenceUrl,
      download: (url) => downloadReferenceVideo(url, path.join(workDir, 'reference-video')),
    });
    const referenceFile = referenceSource.file;
    if (referenceFile) {
      assetIds.push(await uploadXyqAsset(referenceFile));
    }
    const referenceDurationSeconds = probeVideoDuration(referenceFile);
    const message = buildVideoGenerationMessage({
      referenceDurationSeconds,
      fallbackUrl: referenceSource.fallbackUrl,
      videoPrompt: row['视频提示词'] || '',
      videoModel: row['模型选用'],
    });

    const result = await completeXyqTask({
      message,
      assetIds,
      kind: 'video',
      onRun: async ({ threadId, runId, webLink }) => updateRecord(CONFIG.content_table_id, recordId, {
        '小云雀线程ID': threadId,
        '小云雀运行ID': runId,
        '生成任务链接': webLink || taskLink(threadId),
      }),
    });
    updateRecord(CONFIG.content_table_id, recordId, {
      '最终视频': result.resultUrl,
      '生成状态': '已完成',
      '失败原因': null,
    });
    log('视频处理完成', { recordId, number: row['内容流水号'] });
  } catch (error) {
    updateRecord(CONFIG.content_table_id, recordId, { '生成状态': '失败', '失败原因': String(error.message).slice(0, 1000) });
    log('视频处理失败', { recordId, error: error.message });
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

async function resumeContent(row) {
  const recordId = row.record_id;
  log('恢复视频任务', { recordId, number: row['内容流水号'] });
  const runData = await getXyqRun(row['小云雀线程ID'], row['小云雀运行ID']);
  const outcome = inspectXyqRun(runData, 'video');
  if (outcome.status === 'pending') {
    log('视频任务仍在生成', { recordId, number: row['内容流水号'] });
    return;
  }
  if (outcome.status === 'failed') {
    updateRecord(CONFIG.content_table_id, recordId, {
      '生成状态': '失败',
      '最终视频': null,
      '失败原因': outcome.error.slice(0, 1000),
    });
    log('恢复视频任务失败', { recordId, error: outcome.error });
    return;
  }
  updateRecord(CONFIG.content_table_id, recordId, {
    '最终视频': outcome.resultUrl,
    '生成状态': '已完成',
    '失败原因': null,
  });
  log('恢复视频任务完成', { recordId, number: row['内容流水号'] });
}

function getLtxClient() {
  return createLtxClient({
    baseUrl: CONFIG.ltx_base_url,
    apiKey: process.env.NEWAPI_API_KEY,
  });
}

async function cleanupLtxRelayMedia(row, recordId, { strict = false } = {}) {
  const assetKeys = parseRelayAssetKeys(row['中继素材键（内部）']);
  if (!assetKeys.length) return;
  try {
    await createRelayMediaStore().remove(assetKeys);
    updateRecord(CONFIG.ltx_content_table_id, recordId, { '中继素材键（内部）': null });
  } catch (error) {
    log('LTX中继素材清理失败', { recordId, error: error.message });
    if (strict) throw error;
  }
}

function buildLtxStartPatch({ modelName, submittedAt }) {
  return {
    '模型选用': modelName,
    '是否立刻生成视频': '否',
    '生成状态': '生成中',
    '生成供应商': 'Kimi分镜 + NewAPI LTX + FFmpeg + Cloudflare中继',
    '外部任务ID': null,
    '分段提示词（内部）': null,
    '失败原因': null,
    '提交时间': submittedAt,
    '完成时间': null,
  };
}

function buildLtxCompletedPatch({ completedAt }) {
  return {
    '生成状态': '已完成',
    '失败原因': null,
    '完成时间': completedAt,
  };
}

function buildLtxFailedPatch({ reason, completedAt }) {
  return {
    '生成状态': '失败',
    '失败原因': String(reason).slice(0, 1000),
    '完成时间': completedAt,
  };
}

async function processLtxContent(row) {
  const recordId = row.record_id;
  const model = ltxModelChoice(row['模型选用']);
  const workDir = path.join(RUNTIME, `ltx-${recordId}`);
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(workDir, { recursive: true });
  const staleAssetKeys = parseRelayAssetKeys(row['中继素材键（内部）']);
  const uploadedAssetKeys = [];
  const submittedTaskIds = [];
  let expectedSegmentCount = 0;
  let mediaStore;
  let staleCleanupSucceeded = staleAssetKeys.length === 0;
  updateRecord(CONFIG.ltx_content_table_id, recordId, buildLtxStartPatch({
    modelName: model.name,
    submittedAt: feishuDateTime(),
  }));
  log('开始提交LTX参考视频等时长复刻任务', { recordId, number: row['内容流水号'], model: model.name });

  try {
    await cleanupLtxRelayMedia(row, recordId, { strict: true });
    staleCleanupSucceeded = true;
    const referenceUrl = ltxReferenceUrl(row['参考视频链接']);
    const referenceFile = downloadReferenceVideo(referenceUrl, path.join(workDir, 'reference-video'));
    const referenceDuration = probeVideoDuration(referenceFile);
    cacheLtxReferenceVideo(recordId, referenceFile);
    if (!referenceDuration) throw new Error('无法检测参考视频时长，请重新上传有效视频');
    expectedSegmentCount = ltxSegmentCountForDuration(referenceDuration);
    updateRecord(CONFIG.ltx_content_table_id, recordId, { '视频时长': referenceDuration });
    const analysisFile = prepareAnalysisVideo({
      videoFile: referenceFile,
      outputFile: path.join(workDir, 'analysis', 'reference-analysis.mp4'),
    });
    const prompts = await requestLtxStoryboard({
      videoFile: analysisFile,
      durationSeconds: referenceDuration,
      segmentCount: expectedSegmentCount,
      userPrompt: row['视频提示词'],
    });
    const frameFiles = extractReferenceFrames({
      videoFile: referenceFile,
      durationSeconds: referenceDuration,
      segmentCount: expectedSegmentCount,
      outputDir: path.join(workDir, 'frames'),
    });
    mediaStore = createRelayMediaStore();
    const uploadedFrames = [];
    for (let index = 0; index < frameFiles.length; index += 1) {
      const uploaded = await mediaStore.upload(frameFiles[index], { recordId, role: `boundary-${index}` });
      uploadedFrames.push(uploaded);
      uploadedAssetKeys.push(uploaded.assetKey);
    }
    const payloads = buildLtxSegmentPayloads({
      modelValue: model.name,
      frameUrls: uploadedFrames.map((item) => item.url),
      prompts,
      seed: row['随机种子'],
    });
    updateRecord(CONFIG.ltx_content_table_id, recordId, {
      '中继素材键（内部）': JSON.stringify(uploadedAssetKeys),
      '分段提示词（内部）': JSON.stringify(prompts),
    });
    const client = getLtxClient();
    for (let index = 0; index < payloads.length; index += 1) {
      const submitted = await client.submit(payloads[index]);
      submittedTaskIds.push(submitted.taskId);
      updateRecord(CONFIG.ltx_content_table_id, recordId, {
        '外部任务ID': JSON.stringify(submittedTaskIds),
        '失败原因': null,
      });
      log('LTX分段任务已提交', {
        recordId,
        segment: index + 1,
        taskId: submitted.taskId,
        model: model.name,
      });
    }
  } catch (error) {
    if (submittedTaskIds.length) {
      updateRecord(CONFIG.ltx_content_table_id, recordId, {
        '生成状态': '生成中',
        '外部任务ID': JSON.stringify(submittedTaskIds),
        '失败原因': `已提交 ${submittedTaskIds.length}/${expectedSegmentCount || '?'} 段，等待已提交任务结束后清理：${String(error.message)}`.slice(0, 1000),
      });
      log('LTX分段任务仅部分提交，将等待已提交任务结束', {
        recordId,
        submitted: submittedTaskIds.length,
        error: error.message,
      });
      return;
    }
    let cleanupFailed = false;
    if (mediaStore && uploadedAssetKeys.length) {
      try {
        await mediaStore.remove(uploadedAssetKeys);
      } catch (cleanupError) {
        cleanupFailed = true;
        log('LTX提交失败后的中继素材清理失败', { recordId, error: cleanupError.message });
      }
    }
    const retainedAssetKeys = cleanupFailed
      ? uploadedAssetKeys
      : (!staleCleanupSucceeded ? staleAssetKeys : []);
    removeLtxReferenceCache(recordId);
    updateRecord(CONFIG.ltx_content_table_id, recordId, {
      '生成状态': '失败',
      '失败原因': String(error.message).slice(0, 1000),
      '中继素材键（内部）': retainedAssetKeys.length ? JSON.stringify(retainedAssetKeys) : null,
      '完成时间': feishuDateTime(),
    });
    log('LTX视频任务提交失败', { recordId, error: error.message });
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

async function resumeLtxContent(row) {
  const recordId = row.record_id;
  const taskIds = parseLtxTaskIds(row['外部任务ID']);
  const workDir = path.join(RUNTIME, `ltx-resume-${recordId}`);
  const referenceVideoFile = ltxReferenceCacheFile(recordId);
  try {
    if (!taskIds.length) throw new Error('缺少LTX外部任务ID');
    const targetDuration = Number(row['视频时长']);
    const expectedSegmentCount = ltxSegmentCountForDuration(targetDuration);
    const outcome = await pollLtxTaskGroup(getLtxClient(), taskIds);
    if (outcome.status === 'pending') {
      log('LTX分段任务仍在生成', { recordId, taskIds });
      return;
    }
    if (outcome.status === 'failed') {
      updateRecord(CONFIG.ltx_content_table_id, recordId, buildLtxFailedPatch({
        reason: outcome.error,
        completedAt: feishuDateTime(),
      }));
      await cleanupLtxRelayMedia(row, recordId);
      removeLtxReferenceCache(recordId);
      log('LTX分段任务失败', { recordId, taskIds, error: outcome.error });
      return;
    }
    if (taskIds.length !== expectedSegmentCount) {
      throw new Error(`LTX任务仅成功提交 ${taskIds.length}/${expectedSegmentCount} 段，请重新触发生成`);
    }
    fs.rmSync(workDir, { recursive: true, force: true });
    fs.mkdirSync(workDir, { recursive: true });
    const segmentFiles = [];
    for (let index = 0; index < outcome.resultUrls.length; index += 1) {
      segmentFiles.push(await downloadHttp(
        outcome.resultUrls[index],
        path.join(workDir, `segment-${String(index).padStart(2, '0')}`),
      ));
    }
    const finalFile = concatLtxSegments({
      segmentFiles,
      referenceVideoFile,
      targetDurationSeconds: targetDuration,
      outputFile: path.join(workDir, `ltx-${recordId}-final.mp4`),
      workDir: path.join(workDir, 'concat'),
    });
    if (!CONFIG.ltx_final_video_attachment_field_id) {
      throw new Error('缺少配置 ltx_final_video_attachment_field_id');
    }
    replaceAttachment(
      CONFIG.ltx_content_table_id,
      recordId,
      CONFIG.ltx_final_video_attachment_field_id,
      finalFile,
    );
    updateRecord(CONFIG.ltx_content_table_id, recordId, buildLtxCompletedPatch({
      completedAt: feishuDateTime(),
    }));
    await cleanupLtxRelayMedia(row, recordId);
    removeLtxReferenceCache(recordId);
    log('LTX等时长视频合成并上传完成', { recordId, taskIds, durationSeconds: targetDuration });
  } catch (error) {
    updateRecord(CONFIG.ltx_content_table_id, recordId, buildLtxFailedPatch({
      reason: error.message,
      completedAt: feishuDateTime(),
    }));
    await cleanupLtxRelayMedia(row, recordId);
    removeLtxReferenceCache(recordId);
    log('LTX视频任务轮询或合成失败', { recordId, taskIds, error: error.message });
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

async function main() {
  ensureDirs();
  const enabledFeatures = ['core'];
  if (CONFIG.ltx_content_table_id || CONFIG.ltx_base_url) enabledFeatures.push('ltx');
  if (CONFIG.platform_account_table_id || CONFIG.platform_publish_table_id) enabledFeatures.push('publishing');
  assertValidConfig(CONFIG, { features: enabledFeatures });

  let lock;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      lock = fs.openSync(LOCK_FILE, 'wx');
      fs.writeFileSync(lock, String(process.pid), 'utf8');
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const existingPid = Number(fs.readFileSync(LOCK_FILE, 'utf8').trim());
      let active = false;
      if (existingPid) {
        try { process.kill(existingPid, 0); active = true; } catch {}
      }
      if (active) {
        log('已有任务处理器正在运行，本次退出', { pid: existingPid });
        return;
      }
      fs.rmSync(LOCK_FILE, { force: true });
      log('已清理失效的任务锁', { pid: existingPid || null });
    }
  }
  if (lock === undefined) throw new Error('无法取得任务处理锁');

  try {
    const personaFields = ['人设编号', '手机编号', '人设类型', '输入人设要求', '参考图片', '人设', '人物形象链接（内部）', '人物形象', '是否立刻生成人设', '人设生成状态', '形象线程ID', '形象运行ID', '失败原因'];
    let personas = listRecords(CONFIG.persona_table_id, personaFields);
    const personaJobs = personas
      .map((row) => ({ row, action: personaJobAction(row) }))
      .filter((job) => job.action !== 'none');
    for (const { row, action } of personaJobs) {
      if (action === 'generate') {
        await processPersona(row);
        continue;
      }
      const recovered = await backfillPersonaAttachment(row).catch((error) => {
        log('人物形象附件恢复失败', { recordId: row.record_id, error: error.message });
        return false;
      });
      if (!recovered) await processPersona(row);
    }

    personas = listRecords(CONFIG.persona_table_id, personaFields);
    const personaById = new Map(personas.map((row) => [row.record_id, row]));
    const contentFields = ['内容流水号', '人设', '视频提示词', '参考视频链接', '参考视频文件', '模型选用', '是否立刻生成视频', '生成状态', '小云雀线程ID', '小云雀运行ID'];
    const contents = listRecords(CONFIG.content_table_id, contentFields);
    for (const row of contents) {
      if (!firstOption(row['模型选用'])) {
        row['模型选用'] = 'Seedance 2.0 Mini';
        updateRecord(CONFIG.content_table_id, row.record_id, { '模型选用': 'Seedance 2.0 Mini' });
      }
    }
    const contentJobs = contents
      .map((row) => ({ row, action: contentJobAction(row) }))
      .filter((job) => job.action !== 'none');
    for (const { row, action } of contentJobs) {
      if (action === 'resume') await resumeContent(row);
      else await processContent(row, personaById);
    }

    let ltxContentJobs = [];
    if (CONFIG.ltx_content_table_id) {
      const ltxContentFields = [
        '内容流水号', '人设', '参考视频链接', '视频提示词',
        '模型选用', '视频时长', '随机种子', '是否立刻生成视频',
        '生成状态', '生成供应商', '外部任务ID', '中继素材键（内部）', '分段提示词（内部）',
        '最终视频', '失败原因',
        '提交时间', '完成时间',
      ];
      const ltxContents = listRecords(CONFIG.ltx_content_table_id, ltxContentFields);
      for (const row of ltxContents) {
        const defaults = {};
        if (!firstOption(row['模型选用'])) {
          row['模型选用'] = 'LTX 2.3 首尾帧';
          defaults['模型选用'] = 'LTX 2.3 首尾帧';
        }
        if (Object.keys(defaults).length) updateRecord(CONFIG.ltx_content_table_id, row.record_id, defaults);
      }
      ltxContentJobs = ltxContents
        .map((row) => ({ row, action: ltxJobAction(row) }))
        .filter((job) => job.action !== 'none');
      for (const { row, action } of ltxContentJobs) {
        if (action === 'resume') await resumeLtxContent(row);
        else await processLtxContent(row);
      }
    }

    let platformPublishJobs = [];
    if (CONFIG.platform_account_table_id && CONFIG.platform_publish_table_id) {
      const platformAccountFields = [
        '账号编号', '平台', 'MultiPost平台标识', 'MultiPost账号ID', '账号昵称', '登录状态', '是否启用',
      ];
      const platformAccounts = listRecords(CONFIG.platform_account_table_id, platformAccountFields);
      const accountById = new Map(platformAccounts.map((row) => [row.record_id, row]));
      const contentById = new Map(contents.map((row) => [row.record_id, row]));
      const platformPublishFields = [
        '发布任务', '内容', '内容流水号', '平台账号', '平台', '最终视频',
        '发布标题', '发布文案', '标签', '文案生成状态', '确认发布', '发布状态',
        '计划发布时间', 'MultiPost任务ID', '幂等键', '重试次数',
      ];
      const platformPublishes = listRecords(CONFIG.platform_publish_table_id, platformPublishFields);
      platformPublishJobs = platformPublishes
        .map((row) => ({ row, action: platformPublishJobAction(row) }))
        .filter((job) => job.action !== 'none');
      for (const { row, action } of platformPublishJobs) {
        if (action === 'publish') await processConfirmedPublish(row, accountById);
        else if (action === 'retry') await processConfirmedPublish(row, accountById, { retry: true });
        else await processPlatformPublish(row, contentById, accountById);
      }
    }
    log('本轮扫描完成', {
      personaJobs: personaJobs.length,
      contentJobs: contentJobs.length,
      ltxContentJobs: ltxContentJobs.length,
      platformPublishJobs: platformPublishJobs.length,
    });
  } finally {
    if (lock !== undefined) fs.closeSync(lock);
    fs.rmSync(LOCK_FILE, { force: true });
  }
}

if (require.main === module) {
  main().catch((error) => {
    log('任务处理器异常退出', error.message);
    process.exitCode = 1;
  });
}

module.exports = { buildLtxAnalysisRequest, buildLtxCompletedPatch, buildLtxFailedPatch, buildLtxPayload, buildLtxStartPatch, buildPersonaImagePrompt, buildPersonaImageRequest, buildPublishAttempt, buildPublishCopyPrompt, buildVideoGenerationMessage, collectUrls, chooseArtifactUrl, contentJobAction, extractMarkdownUrl, firstOption, formatPublishTags, inspectLtxTask, inspectXyqRun, linkedRecordId, listRecords, ltxJobAction, ltxModelChoice, ltxReferenceUrl, parsePublishCopy, personaJobAction, platformPublishJobAction, probeVideoDuration, processConfirmedPublish, processLtxContent, readVideoDataUrl, requestLtxStoryboard, resolveReferenceSource, resumeLtxContent, rowsFromEnvelope, videoModelChoice };
