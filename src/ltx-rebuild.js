'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { buildLtxPayload, inspectLtxTask, ltxModelChoice } = require('./ltx');

const LTX_SEGMENT_SECONDS = 5;
const LTX_MAX_SECONDS = 60;
const LTX_MAX_SEGMENTS = LTX_MAX_SECONDS / LTX_SEGMENT_SECONDS;

function ltxSegmentCountForDuration(durationSeconds) {
  const duration = Number(durationSeconds);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('无法读取参考视频时长');
  if (duration > LTX_MAX_SECONDS) throw new Error(`LTX 参考视频当前最长支持 ${LTX_MAX_SECONDS} 秒`);
  return Math.ceil(duration / LTX_SEGMENT_SECONDS);
}

function buildBoundaryTimestamps(durationSeconds, segmentCount = ltxSegmentCountForDuration(durationSeconds)) {
  const duration = Number(durationSeconds);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('无法读取参考视频时长');
  if (!Number.isSafeInteger(segmentCount) || segmentCount < 1) throw new Error('分段数量无效');
  const last = Math.max(0, duration - 0.05);
  return Array.from({ length: segmentCount + 1 }, (_, index) => {
    if (index === segmentCount) return Number(last.toFixed(3));
    return Number(((duration * index) / segmentCount).toFixed(3));
  });
}

function buildLtxStoryboardPrompt({
  durationSeconds,
  segmentCount = ltxSegmentCountForDuration(durationSeconds),
  userPrompt = '',
}) {
  const exampleSegments = Array.from({ length: segmentCount }, (_, index) => `第${index + 1}段提示词`);
  return [
    `参考视频实际时长为 ${Number(durationSeconds).toFixed(3)} 秒。`,
    `请按整条视频的实际时间线，把视觉内容映射为 ${segmentCount} 个连续的片段。每个 LTX 任务生成 5 秒，最后合成时会按参考时长裁切。`,
    '每段只描述人物或物体动作、场景、构图、镜头运动、光线和节奏，保持主体身份、服装、产品和空间连续。',
    '不要描述音频、对白、字幕、文字、水印或无法由静音图生视频模型可靠生成的内容。',
    userPrompt ? `用户补充要求：${userPrompt}` : '',
    `严格只输出 JSON：${JSON.stringify({ segments: exampleSegments })}`,
  ].filter(Boolean).join('\n');
}

function parseLtxStoryboard(value, segmentCount) {
  if (!Number.isSafeInteger(segmentCount) || segmentCount < 1 || segmentCount > LTX_MAX_SEGMENTS) {
    throw new Error('LTX 分段数量无效');
  }
  const text = String(value || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Kimi 未返回有效的 LTX 分段 JSON');
  }
  const segments = Array.isArray(parsed) ? parsed : parsed?.segments;
  if (!Array.isArray(segments) || segments.length !== segmentCount) {
    throw new Error(`Kimi 必须返回 ${segmentCount} 条 LTX 分段提示词`);
  }
  const prompts = segments.map((item) => String(item || '').trim());
  if (prompts.some((item) => !item)) throw new Error('Kimi 返回的 LTX 分段提示词不能为空');
  return prompts;
}

function parseLtxTaskIds(value) {
  const text = String(value || '').trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed.map((item) => String(item || '').trim()).filter(Boolean);
  } catch {}
  return [text];
}

function buildLtxSegmentPayloads({ modelValue, frameUrls, prompts, seed }) {
  if (!Array.isArray(prompts) || !prompts.length || prompts.length > LTX_MAX_SEGMENTS) {
    throw new Error('LTX 分段提示词数量无效');
  }
  if (!Array.isArray(frameUrls) || frameUrls.length !== prompts.length + 1) {
    throw new Error(`LTX 分段生成必须包含 ${prompts.length + 1} 张边界帧`);
  }
  const model = ltxModelChoice(modelValue);
  const baseSeed = Number(seed);
  return prompts.map((prompt, index) => buildLtxPayload({
    modelValue: model.name,
    prompt,
    firstFrameUrl: frameUrls[index],
    lastFrameUrl: model.mode === 'first-last' ? frameUrls[index + 1] : '',
    seed: Number.isSafeInteger(baseSeed) && baseSeed >= 0 ? baseSeed + index : undefined,
  }));
}

function inspectLtxTaskGroup(tasks) {
  for (let index = 0; index < tasks.length; index += 1) {
    const { taskId, outcome } = tasks[index];
    if (outcome.status === 'failed') {
      return {
        status: 'failed',
        error: `LTX 第 ${index + 1} 段任务 ${taskId} 失败: ${outcome.error || '未知原因'}`,
      };
    }
  }
  if (tasks.some(({ outcome }) => outcome.status !== 'completed')) return { status: 'pending' };
  return { status: 'completed', resultUrls: tasks.map(({ outcome }) => outcome.resultUrl) };
}

function runFfmpeg(args, { cwd = process.cwd(), spawn = spawnSync } = {}) {
  const result = spawn('ffmpeg', ['-y', '-hide_banner', ...args], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(String(result.stderr || result.stdout || 'FFmpeg 执行失败').trim());
}

function extractReferenceFrames({ videoFile, durationSeconds, segmentCount, outputDir, spawn = spawnSync }) {
  fs.mkdirSync(outputDir, { recursive: true });
  return buildBoundaryTimestamps(durationSeconds, segmentCount || ltxSegmentCountForDuration(durationSeconds)).map((timestamp, index) => {
    const output = path.join(outputDir, `boundary-${String(index).padStart(2, '0')}.jpg`);
    runFfmpeg([
      '-ss', timestamp.toFixed(3), '-i', videoFile, '-frames:v', '1',
      '-vf', 'scale=704:1280:force_original_aspect_ratio=increase,crop=704:1280,format=yuv420p',
      '-q:v', '2', output,
    ], { cwd: outputDir, spawn });
    return output;
  });
}

function prepareAnalysisVideo({ videoFile, outputFile, spawn = spawnSync }) {
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  runFfmpeg([
    '-i', videoFile, '-an', '-vf', "scale='min(640,iw)':-2,fps=8",
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30', '-movflags', '+faststart', outputFile,
  ], { cwd: path.dirname(outputFile), spawn });
  return outputFile;
}

function concatLtxSegments({ segmentFiles, referenceVideoFile, targetDurationSeconds, outputFile, workDir, spawn = spawnSync }) {
  const expectedCount = ltxSegmentCountForDuration(targetDurationSeconds);
  if (!Array.isArray(segmentFiles) || segmentFiles.length !== expectedCount) {
    throw new Error(`LTX 拼接必须包含 ${expectedCount} 个视频片段`);
  }
  if (!referenceVideoFile) throw new Error('LTX final assembly requires the reference video audio source');
  fs.mkdirSync(workDir, { recursive: true });
  const normalized = segmentFiles.map((input, index) => {
    const output = path.join(workDir, `normalized-${String(index).padStart(2, '0')}.mp4`);
    runFfmpeg([
      '-i', input, '-t', String(LTX_SEGMENT_SECONDS), '-an',
      '-vf', 'scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,fps=24,setsar=1,format=yuv420p',
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-movflags', '+faststart', output,
    ], { cwd: workDir, spawn });
    return output;
  });
  const listFile = path.join(workDir, 'concat.txt');
  const quote = (file) => `file '${file.replace(/'/g, "'\\''")}'`;
  fs.writeFileSync(listFile, `${normalized.map(quote).join('\n')}\n`, 'utf8');
  const joinedVideoFile = path.join(workDir, 'joined-video.mp4');
  runFfmpeg([
    '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy',
    joinedVideoFile,
  ], { cwd: workDir, spawn });
  runFfmpeg([
    '-i', joinedVideoFile, '-i', referenceVideoFile,
    '-map', '0:v:0', '-map', '1:a:0?',
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
    '-t', Number(targetDurationSeconds).toFixed(3), '-movflags', '+faststart', outputFile,
  ], { cwd: workDir, spawn });
  return outputFile;
}

async function pollLtxTaskGroup(client, taskIds) {
  const tasks = [];
  for (const taskId of taskIds) {
    tasks.push({ taskId, outcome: inspectLtxTask(await client.get(taskId)) });
  }
  return inspectLtxTaskGroup(tasks);
}

module.exports = {
  LTX_MAX_SECONDS,
  LTX_MAX_SEGMENTS,
  LTX_SEGMENT_SECONDS,
  buildBoundaryTimestamps,
  buildLtxSegmentPayloads,
  buildLtxStoryboardPrompt,
  concatLtxSegments,
  extractReferenceFrames,
  inspectLtxTaskGroup,
  ltxSegmentCountForDuration,
  parseLtxStoryboard,
  parseLtxTaskIds,
  pollLtxTaskGroup,
  prepareAnalysisVideo,
};
