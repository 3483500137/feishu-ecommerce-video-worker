# Strict Artifact and Persona Regeneration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make active persona triggers regenerate instead of restoring stale images, and write Base results only from the last real 小云雀 artifact of the requested media type.

**Architecture:** Add a pure persona-action selector that distinguishes active generation from passive attachment recovery. Replace whole-run URL scanning with artifact-only selection over `entry_list`, walking artifacts newest-first and accepting only exact image/video artifact subtypes. After tests pass, retrigger PS-0002 and CT-00005 once and inspect their actual outputs.

**Tech Stack:** Node.js CommonJS, `node:test`, lark-cli Base commands, 小云雀 API, Windows Task Scheduler.

## Global Constraints

- “是否立刻生成人设=是” must always call Kimi and 小云雀, even when an old internal image URL exists.
- Passive attachment recovery remains available only when there is no active persona trigger and the attachment is missing.
- Final video/image URLs must come only from exact 小云雀 artifact media content.
- When several artifacts exist, select the newest matching artifact so the final composite wins over earlier clips.
- A completed run without a matching artifact must fail and keep “最终视频” empty.
- Retry PS-0002 and CT-00005 once only after implementation verification.
- Preserve the untracked `scripts/run-worker-hidden.vbs` file.

---

### Task 1: Correct Persona Job Routing

**Files:**
- Modify: `test/worker.test.js`
- Modify: `src/worker.js`

**Interfaces:**
- Consumes: `personaJobAction(row)` with a normalized Base record object.
- Produces: one of `'generate'`, `'backfill'`, or `'none'`.

- [x] **Step 1: Write failing routing tests**

```js
test('active persona trigger regenerates even when an old image URL exists', () => {
  assert.equal(personaJobAction({
    '是否立刻生成人设': ['是'],
    '人物形象': [{ file_token: 'old' }],
    '人物形象链接（内部）': 'https://example.com/old.jpg',
  }), 'generate');
});

test('missing persona attachment passively backfills when not actively triggered', () => {
  assert.equal(personaJobAction({
    '是否立刻生成人设': ['否'],
    '人物形象': null,
    '人物形象链接（内部）': 'https://example.com/old.jpg',
  }), 'backfill');
});
```

- [x] **Step 2: Run tests and verify RED**

Run: `node --test test/worker.test.js`

Expected: FAIL because `personaJobAction` is not exported/defined.

- [x] **Step 3: Implement the action selector**

```js
function personaJobAction(row) {
  if (firstOption(row['是否立刻生成人设']) === '是') return 'generate';
  if (!row['人物形象']) return 'backfill';
  return 'none';
}
```

- [x] **Step 4: Integrate routing in `main`**

```js
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
```

Export `personaJobAction`, run `node --test test/worker.test.js`, and expect all tests PASS.

- [x] **Step 5: Commit Task 1**

```bash
git add src/worker.js test/worker.test.js
git commit -m "fix: honor active persona regeneration"
```

### Task 2: Select Only the Last Matching Artifact

**Files:**
- Modify: `test/worker.test.js`
- Modify: `src/worker.js`

**Interfaces:**
- Consumes: `chooseArtifactUrl(runData, kind)` where `kind` is `'image'` or `'video'`.
- Produces: the newest matching artifact URL, or `''` when none exists.

- [x] **Step 1: Replace the permissive selector test with failing artifact tests**

```js
function artifactEntry(subType, mediaKey, url, name) {
  return {
    type: 2,
    artifact: {
      name,
      content: [{ sub_type: subType, data: JSON.stringify({ [mediaKey]: { url } }) }],
    },
  };
}

test('artifact selection ignores prompt URLs and chooses the last composite video', () => {
  const data = {
    entry_list: [
      { type: 1, message: { content: [{ type: 'text', data: '参考：https://v.douyin.com/example/' }] } },
      artifactEntry('biz/x_data_video', 'video', 'https://cdn.example.com/clip.mp4', 'clip.mp4'),
      artifactEntry('biz/x_data_video', 'video', 'https://cdn.example.com/final.mp4', 'final_video.mp4'),
    ],
  };
  assert.equal(chooseArtifactUrl(data, 'video'), 'https://cdn.example.com/final.mp4');
});

test('artifact selection returns empty when a completed run has no video artifact', () => {
  const data = { entry_list: [{ type: 1, message: { content: [{ type: 'text', data: 'https://v.douyin.com/example/' }] } }] };
  assert.equal(chooseArtifactUrl(data, 'video'), '');
});

test('artifact selection reads image artifacts', () => {
  const data = { entry_list: [artifactEntry('biz/x_data_image', 'image', 'https://cdn.example.com/persona.jpg', 'persona.jpg')] };
  assert.equal(chooseArtifactUrl(data, 'image'), 'https://cdn.example.com/persona.jpg');
});
```

- [x] **Step 2: Run tests and verify RED**

Run: `node --test test/worker.test.js`

Expected: the last-composite and no-artifact tests FAIL against the permissive selector.

- [x] **Step 3: Implement strict newest-first artifact selection**

```js
function chooseArtifactUrl(runData, kind) {
  const subtype = kind === 'video' ? 'biz/x_data_video' : 'biz/x_data_image';
  const entries = Array.isArray(runData?.entry_list) ? runData.entry_list : [];
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const contents = Array.isArray(entries[index]?.artifact?.content) ? entries[index].artifact.content : [];
    const matching = contents.filter((item) => item?.sub_type === subtype);
    const urls = collectUrls(matching);
    const preferred = kind === 'video'
      ? urls.find((url) => /(?:\.mp4(?:\?|$)|mime_type=video|download_url)/i.test(url))
      : urls.find((url) => /(?:\.(?:png|jpe?g|webp)(?:\?|$)|mime_type=image|origin_url)/i.test(url));
    if (preferred || urls[0]) return preferred || urls[0];
  }
  return '';
}
```

- [x] **Step 4: Run full verification**

Run: `npm test`

Expected: all tests PASS.

Run: `node --check src/worker.js`

Expected: exit code 0.

Run: `git diff --check`

Expected: exit code 0.

- [x] **Step 5: Commit Task 2**

```bash
git add src/worker.js test/worker.test.js docs/superpowers/plans/2026-07-16-strict-artifact-and-persona-regeneration.md
git commit -m "fix: select only final generated artifacts"
```

### Task 3: Retry and Validate the Two Production Records

**Files:**
- No source changes.
- Preserve: `scripts/run-worker-hidden.vbs`

**Interfaces:**
- PS-0002 record ID: `recvpfdmGM6JkC`
- CT-00005 record ID: `recvpqWoaYFxWp`

- [x] **Step 1: Reset the two records for one retry**

```powershell
lark-cli base +record-upsert --base-token <REDACTED_BASE_TOKEN> --table-id <REDACTED_PERSONA_TABLE_ID> --record-id recvpfdmGM6JkC --json '{"是否立刻生成人设":"是","人设生成状态":"待生成","失败原因":null}' --as user --format json
lark-cli base +record-upsert --base-token <REDACTED_BASE_TOKEN> --table-id <REDACTED_CONTENT_TABLE_ID> --record-id recvpqWoaYFxWp --json '{"是否立刻生成视频":"是","生成状态":"待生成","最终视频":null,"小云雀线程ID":null,"小云雀运行ID":null,"生成任务链接":null,"失败原因":null}' --as user --format json
```

- [x] **Step 2: Enable and start the scheduled worker**

```powershell
Enable-ScheduledTask -TaskName 'FeishuEcommerceVideoWorker'
Start-ScheduledTask -TaskName 'FeishuEcommerceVideoWorker'
```

- [x] **Step 3: Monitor PS-0002 to a terminal state**

Poll the Base record and 小云雀 run. On success, download its current `人物形象` attachment and inspect it visually. Accept only a real-camera adult woman photograph; reject 2D illustration and CG digital-human output.

- [x] **Step 4: Monitor CT-00005 to a terminal state**

Poll the Base record and 小云雀 run. On success, verify `最终视频` equals the newest video artifact URL and is not the reference Douyin URL. On no artifact, verify status is `失败`, `最终视频` is empty, and `失败原因` explains that no video result was found.

- [x] **Step 5: Final verification**

Run `npm test`, confirm the scheduled task is Ready with `LastTaskResult=0`, confirm `git status --short` contains only the pre-existing untracked `scripts/run-worker-hidden.vbs`, and leave the scheduled task enabled.
