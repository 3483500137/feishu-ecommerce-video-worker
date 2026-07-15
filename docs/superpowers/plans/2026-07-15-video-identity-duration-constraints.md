# Video Identity and Duration Constraints Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Submit every new 小云雀 video task with the selected persona image as the only character identity source and with the reference video's exact duration plus a maximum one-second tolerance.

**Architecture:** Add two small pure/testable boundaries to the existing worker: one function probes a downloaded reference video's duration with local `ffmpeg`, and one function builds the 小云雀 task message. `processContent` supplies the detected duration when available and falls back to an explicit “detect first” instruction for URL-only references; existing submission, polling, and Base write-back remain unchanged.

**Tech Stack:** Node.js CommonJS, `node:test`, local FFmpeg, lark-cli, 小云雀 API.

## Global Constraints

- The selected persona “人物形象” image is the final video's only character identity source.
- The original reference-video person supplies only motion, lip movement, blocking, camera, and audio information.
- Final duration must match the reference duration with an error no greater than 1 second.
- Do not add post-generation duration validation, automatic regeneration, or local trimming.
- Do not cancel or resubmit CT-00004, which was submitted before this change.

---

### Task 1: Build Hard-Constraint Task Messages

**Files:**
- Modify: `test/worker.test.js`
- Modify: `src/worker.js`

**Interfaces:**
- Consumes: `{ referenceDurationSeconds?: number, fallbackUrl?: string, videoPrompt?: string }`
- Produces: `buildVideoGenerationMessage(options): string`

- [x] **Step 1: Write the failing message tests**

```js
test('video task message uses the selected persona as the only identity and includes exact duration', () => {
  const message = buildVideoGenerationMessage({ referenceDurationSeconds: 16.7 });
  assert.match(message, /唯一人物形象来源/);
  assert.match(message, /不得保留或混合参考视频原人物/);
  assert.match(message, /16\.700 秒/);
  assert.match(message, /误差不得超过 1 秒/);
});

test('URL-only video task tells 小云雀 to detect duration before generation', () => {
  const message = buildVideoGenerationMessage({ fallbackUrl: 'https://v.douyin.com/example/' });
  assert.match(message, /先读取参考视频并检测其精确时长/);
  assert.match(message, /误差不得超过 1 秒/);
});
```

- [x] **Step 2: Run tests and verify RED**

Run: `node --test test/worker.test.js`

Expected: FAIL because `buildVideoGenerationMessage` is not exported/defined.

- [x] **Step 3: Implement the minimal message builder**

```js
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
```

- [x] **Step 4: Export the function and run tests**

Run: `node --test test/worker.test.js`

Expected: all message tests and existing tests PASS.

### Task 2: Probe Local Reference Duration and Integrate Submission

**Files:**
- Modify: `test/worker.test.js`
- Modify: `src/worker.js`

**Interfaces:**
- Consumes: `probeVideoDuration(filePath, spawn = spawnSync)`
- Produces: a positive duration in seconds, or `null` when FFmpeg cannot read one.
- `processContent` passes the probe result into `buildVideoGenerationMessage`.

- [x] **Step 1: Write the failing duration-parser test**

```js
test('video duration probe parses FFmpeg duration output', () => {
  const fakeSpawn = () => ({ stderr: 'Duration: 00:00:16.70, start: 0.000000, bitrate: 1234 kb/s' });
  assert.equal(probeVideoDuration('reference.mp4', fakeSpawn), 16.7);
});

test('video duration probe returns null for unreadable output', () => {
  assert.equal(probeVideoDuration('reference.mp4', () => ({ stderr: 'Invalid data found' })), null);
});
```

- [x] **Step 2: Run tests and verify RED**

Run: `node --test test/worker.test.js`

Expected: FAIL because `probeVideoDuration` is not exported/defined.

- [x] **Step 3: Implement the minimal FFmpeg probe**

```js
function probeVideoDuration(filePath, spawn = spawnSync) {
  if (!filePath) return null;
  const result = spawn('ffmpeg', ['-hide_banner', '-i', filePath], {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
  });
  const match = String(result.stderr || result.stdout || '').match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/i);
  if (!match) return null;
  const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}
```

- [x] **Step 4: Integrate the builder in `processContent`**

```js
const referenceDurationSeconds = probeVideoDuration(referenceFile);
const message = buildVideoGenerationMessage({
  referenceDurationSeconds,
  fallbackUrl: referenceSource.fallbackUrl,
  videoPrompt: row['视频提示词'] || '',
});
```

Remove the previous inline `message` array and export `probeVideoDuration`.

- [x] **Step 5: Run the full verification suite**

Run: `npm test`

Expected: 9 tests PASS, 0 tests FAIL.

Run: `git diff --check`

Expected: exit code 0 and no whitespace errors.

- [x] **Step 6: Verify the worker remains scheduled and CT-00004 was not resubmitted**

Run: `Get-ScheduledTask -TaskName 'FeishuEcommerceVideoWorker' | Get-ScheduledTaskInfo`

Expected: `LastTaskResult` is `0` while the existing worker remains active or completes normally.

- [x] **Step 7: Commit implementation**

```bash
git add src/worker.js test/worker.test.js docs/superpowers/specs/2026-07-15-video-identity-duration-constraints-design.md docs/superpowers/plans/2026-07-15-video-identity-duration-constraints.md
git commit -m "feat: enforce video identity and duration constraints"
```
