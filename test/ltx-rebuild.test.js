'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
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
} = require('../src/ltx-rebuild');

test('segment count follows the reference duration in five-second generation units', () => {
  assert.equal(ltxSegmentCountForDuration(5), 1);
  assert.equal(ltxSegmentCountForDuration(5.01), 2);
  assert.equal(ltxSegmentCountForDuration(18.181), 4);
  assert.equal(ltxSegmentCountForDuration(60), 12);
  assert.throws(() => ltxSegmentCountForDuration(60.01), /60 秒/);
});

test('buildBoundaryTimestamps maps dynamic boundaries across the full reference video', () => {
  assert.deepEqual(
    buildBoundaryTimestamps(18.18),
    [0, 4.545, 9.09, 13.635, 18.13],
  );
});

test('buildBoundaryTimestamps still returns distinct boundaries for a short video', () => {
  const timestamps = buildBoundaryTimestamps(3);
  assert.equal(timestamps.length, 2);
  assert.equal(timestamps[0], 0);
  assert.equal(timestamps.at(-1), 2.95);
  assert.ok(timestamps.every((value, index) => index === 0 || value > timestamps[index - 1]));
});

test('parseLtxStoryboard accepts the requested dynamic prompt count', () => {
  const prompts = parseLtxStoryboard('```json\n{"segments":["一","二","三","四"]}\n```', 4);
  assert.deepEqual(prompts, ['一', '二', '三', '四']);
  assert.throws(() => parseLtxStoryboard('{"segments":["一"]}', 4), /4 条/);
});

test('buildLtxStoryboardPrompt asks for the dynamic visual segment count', () => {
  const prompt = buildLtxStoryboardPrompt({ durationSeconds: 18.18, segmentCount: 4, userPrompt: '保持产品特写' });
  assert.match(prompt, /4 个连续的片段/);
  assert.match(prompt, /18\.180 秒/);
  assert.match(prompt, /保持产品特写/);
  assert.match(prompt, /不要描述音频/);
});

test('parseLtxTaskIds supports task arrays and legacy single task IDs', () => {
  assert.deepEqual(parseLtxTaskIds('["a","b"]'), ['a', 'b']);
  assert.deepEqual(parseLtxTaskIds('legacy-task'), ['legacy-task']);
  assert.deepEqual(parseLtxTaskIds(''), []);
});

test('inspectLtxTaskGroup completes only when every segment has a result URL', () => {
  const completed = inspectLtxTaskGroup([
    { taskId: 'a', outcome: { status: 'completed', resultUrl: 'https://v/1.mp4' } },
    { taskId: 'b', outcome: { status: 'completed', resultUrl: 'https://v/2.mp4' } },
  ]);
  assert.deepEqual(completed, {
    status: 'completed',
    resultUrls: ['https://v/1.mp4', 'https://v/2.mp4'],
  });

  assert.deepEqual(inspectLtxTaskGroup([
    { taskId: 'a', outcome: { status: 'completed', resultUrl: 'https://v/1.mp4' } },
    { taskId: 'b', outcome: { status: 'pending' } },
  ]), { status: 'pending' });
});

test('inspectLtxTaskGroup reports the failed segment and task ID', () => {
  assert.deepEqual(inspectLtxTaskGroup([
    { taskId: 'a', outcome: { status: 'completed', resultUrl: 'https://v/1.mp4' } },
    { taskId: 'b', outcome: { status: 'failed', error: 'blocked' } },
  ]), {
    status: 'failed',
    error: 'LTX 第 2 段任务 b 失败: blocked',
  });
});

test('buildLtxSegmentPayloads creates dynamic first-last tasks with stable per-segment seeds', () => {
  const frameUrls = Array.from({ length: 5 }, (_, index) => `https://relay.test/frame-${index}.jpg`);
  const prompts = Array.from({ length: 4 }, (_, index) => `动作 ${index + 1}`);
  const payloads = buildLtxSegmentPayloads({
    modelValue: 'LTX 2.3 首尾帧',
    frameUrls,
    prompts,
    seed: 100,
  });
  assert.equal(payloads.length, 4);
  assert.equal(payloads[0].first_frame_image, frameUrls[0]);
  assert.equal(payloads[0].last_frame_image, frameUrls[1]);
  assert.equal(payloads[3].first_frame_image, frameUrls[3]);
  assert.equal(payloads[3].last_frame_image, frameUrls[4]);
  assert.deepEqual(payloads.map((payload) => payload.seed), [100, 101, 102, 103]);
});

test('extractReferenceFrames invokes FFmpeg for dynamic normalized boundary images', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ltx-frames-'));
  const calls = [];
  const files = extractReferenceFrames({
    videoFile: 'reference.mp4',
    durationSeconds: 18.18,
    outputDir: root,
    spawn: (command, args) => {
      calls.push({ command, args });
      return { status: 0, stdout: '', stderr: '' };
    },
  });
  assert.equal(files.length, 5);
  assert.equal(calls.length, 5);
  assert.equal(calls[0].command, 'ffmpeg');
  assert.ok(calls[0].args.includes('scale=704:1280:force_original_aspect_ratio=increase,crop=704:1280,format=yuv420p'));
  assert.ok(calls[4].args.includes('18.130'));
});

test('prepareAnalysisVideo creates a small silent Kimi analysis copy', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ltx-analysis-'));
  let args;
  const output = prepareAnalysisVideo({
    videoFile: 'reference.mp4',
    outputFile: path.join(root, 'analysis.mp4'),
    spawn: (_command, value) => {
      args = value;
      return { status: 0, stdout: '', stderr: '' };
    },
  });
  assert.equal(output, path.join(root, 'analysis.mp4'));
  assert.ok(args.includes('-an'));
  assert.ok(args.includes("scale='min(640,iw)':-2,fps=8"));
});

test('concatLtxSegments creates a fixed 9:16 video and muxes the reference audio', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ltx-concat-'));
  const calls = [];
  const outputFile = path.join(root, 'final.mp4');
  const output = concatLtxSegments({
    segmentFiles: Array.from({ length: 4 }, (_, index) => `clip-${index}.mp4`),
    referenceVideoFile: 'reference.mp4',
    targetDurationSeconds: 18.181,
    outputFile,
    workDir: root,
    spawn: (_command, args) => {
      calls.push(args);
      return { status: 0, stdout: '', stderr: '' };
    },
  });
  assert.equal(output, outputFile);
  assert.equal(calls.length, 6);
  assert.ok(calls[0].includes('scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,fps=24,setsar=1,format=yuv420p'));
  assert.ok(calls.at(-1).includes('reference.mp4'));
  assert.ok(calls.at(-1).includes('1:a:0?'));
  assert.ok(calls.at(-1).includes('aac'));
  assert.ok(calls.at(-1).includes('18.181'));
  assert.match(fs.readFileSync(path.join(root, 'concat.txt'), 'utf8'), /normalized-03\.mp4/);
});

test('pollLtxTaskGroup polls every task and aggregates their inspected outcomes', async () => {
  const seen = [];
  const outcome = await pollLtxTaskGroup({
    get: async (taskId) => {
      seen.push(taskId);
      return { status: 'completed', metadata: { url: `https://video.test/${taskId}.mp4` } };
    },
  }, ['a', 'b']);
  assert.deepEqual(seen, ['a', 'b']);
  assert.deepEqual(outcome, {
    status: 'completed',
    resultUrls: ['https://video.test/a.mp4', 'https://video.test/b.mp4'],
  });
});
