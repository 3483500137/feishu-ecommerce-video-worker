'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const RUNTIME = path.join(ROOT, 'runtime');
const LOG_DIR = path.join(ROOT, 'logs');
const LOCK_FILE = path.join(RUNTIME, 'worker.lock');
const LARK_CLI = path.join(process.env.APPDATA, 'npm', 'node_modules', '@larksuite', 'cli', 'scripts', 'run.js');

function ensureDirs() {
  fs.mkdirSync(RUNTIME, { recursive: true });
  fs.mkdirSync(LOG_DIR, { recursive: true });
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
  const stdout = run(process.execPath, [LARK_CLI, ...args, '--format', 'json']);
  const envelope = JSON.parse(stdout);
  if (!envelope.ok) throw new Error(envelope.error?.message || 'lark-cli request failed');
  return envelope.data;
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

function extractMarkdownUrl(value) {
  if (!value || typeof value !== 'string') return '';
  if (/^https?:\/\//i.test(value)) return value;
  const match = value.match(/\((https?:\/\/[^\s]+)\)$/i);
  return match ? match[1] : '';
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
  const urls = collectUrls(runData);
  const preferred = kind === 'video'
    ? urls.find((url) => /(?:\.mp4(?:\?|$)|video|mime_type=video)/i.test(url))
    : urls.find((url) => /(?:\.(?:png|jpe?g|webp)(?:\?|$)|image|mime_type=image)/i.test(url));
  return preferred || urls.find((url) => !/xyq\.jianying\.com\/home/i.test(url)) || '';
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
  const env = { ...process.env, PYTHONPATH: CONFIG.yt_dlp_path };
  const commonArgs = ['-m', 'yt_dlp', '--no-playlist', '-f', 'bv*+ba/b', '--merge-output-format', 'mp4', '-o', template];
  run('python', [...commonArgs, url], { env });
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
  if (!files.length) throw new Error('参考视频附件下载后未找到文件');
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

function buildVideoGenerationMessage({ referenceDurationSeconds, fallbackUrl = '', videoPrompt = '' }) {
  const durationInstruction = Number.isFinite(referenceDurationSeconds)
    ? `参考视频检测时长为 ${referenceDurationSeconds.toFixed(3)} 秒。最终视频必须与参考视频时长一致，误差不得超过 1 秒。`
    : '生成前必须先读取参考视频并检测其精确时长；最终视频必须以检测到的参考时长为准，误差不得超过 1 秒。';
  return [
    '使用已上传的所选人设形象和参考视频生成最终视频。',
    '已上传的所选人设图片是最终视频的唯一人物形象来源。必须把参考视频中的人物完整替换为该人设；不得保留或混合参考视频原人物的脸、五官、发型、年龄、服装、体型和气质。',
    '参考视频原人物仅用于提供动作、口型、走位和时间点，不得作为人物外观来源。',
    durationInstruction,
    '完整复刻参考视频的动作、动作顺序与时间点、对白、台词、旁白、原声、BGM、音效、镜头、运镜、构图、场景调度和剪辑节奏，保持音画同步。',
    fallbackUrl ? `参考视频链接：${fallbackUrl}。本地下载受平台限制，请直接读取该链接作为参考视频。` : '',
    videoPrompt ? `补充视频提示词：${videoPrompt}` : '',
    '参考视频优先级最高；补充提示词不得覆盖参考视频内容。无需展示方案，直接生成最终视频。',
  ].filter(Boolean).join('\n');
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

function uploadXyqAsset(filePath) {
  const script = path.join(CONFIG.xyq_skill_scripts, 'upload_file.py');
  const stdout = run('python', [script, filePath]);
  const parsed = JSON.parse(stdout);
  if (!parsed.asset_id) throw new Error('小云雀上传未返回 asset_id');
  return parsed.asset_id;
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
    const imagePrompt = `根据以下人设生成单人全身人物形象图：${persona}\n用户要求：${row['输入人设要求'] || ''}\n人物必须是20至30岁的成年清纯女生，严格保持用户指定服装；画面不得出现其他人物。直接生成最终图片。`;
    const result = await completeXyqTask({
      message: imagePrompt,
      assetIds: [],
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
    const assetIds = [uploadXyqAsset(personaFile)];
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
      assetIds.push(uploadXyqAsset(referenceFile));
    }
    const referenceDurationSeconds = probeVideoDuration(referenceFile);
    const message = buildVideoGenerationMessage({
      referenceDurationSeconds,
      fallbackUrl: referenceSource.fallbackUrl,
      videoPrompt: row['视频提示词'] || '',
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

async function main() {
  ensureDirs();
  if (!process.env.XYQ_ACCESS_KEY) throw new Error('缺少用户环境变量 XYQ_ACCESS_KEY');
  if (!process.env.KIMI_API_KEY) throw new Error('缺少用户环境变量 KIMI_API_KEY');

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
    const personaFields = ['人设编号', '手机编号', '人设类型', '输入人设要求', '人设', '人物形象链接（内部）', '人物形象', '是否立刻生成人设', '人设生成状态', '形象线程ID', '形象运行ID', '失败原因'];
    let personas = listRecords(CONFIG.persona_table_id, personaFields);
    const personaJobs = personas.filter((row) => firstOption(row['是否立刻生成人设']) === '是' || !row['人物形象']);
    for (const row of personaJobs) {
      const recovered = await backfillPersonaAttachment(row).catch((error) => {
        log('人物形象附件恢复失败', { recordId: row.record_id, error: error.message });
        return false;
      });
      if (!recovered) await processPersona(row);
    }

    personas = listRecords(CONFIG.persona_table_id, personaFields);
    const personaById = new Map(personas.map((row) => [row.record_id, row]));
    const contentFields = ['内容流水号', '人设', '视频提示词', '参考视频链接', '参考视频文件', '是否立刻生成视频', '生成状态', '小云雀线程ID'];
    const contents = listRecords(CONFIG.content_table_id, contentFields);
    const contentJobs = contents.filter((row) => firstOption(row['是否立刻生成视频']) === '是' || (firstOption(row['生成状态']) === '生成中' && !row['小云雀线程ID']));
    for (const row of contentJobs) await processContent(row, personaById);
    log('本轮扫描完成', { personaJobs: personaJobs.length, contentJobs: contentJobs.length });
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

module.exports = { buildVideoGenerationMessage, collectUrls, chooseArtifactUrl, extractMarkdownUrl, firstOption, linkedRecordId, probeVideoDuration, resolveReferenceSource, rowsFromEnvelope };
