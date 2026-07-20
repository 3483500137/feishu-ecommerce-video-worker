# MultiPost Safe Retry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a one-shot “重试发布” command to the existing 飞书“确认发布” field, preserve duplicate protection, and restore CT-00008 to a safe failed state.

**Architecture:** The worker distinguishes first publish from retry in `platformPublishJobAction`. A retry consumes the command by restoring “确认发布=是”, retires the old local task, increments the retry attempt, and creates a new task with an attempt-specific idempotency key. 飞书 schema and CT-00008 are updated only after unit tests pass; reloading the unpacked Chrome extension is the final operational step.

**Tech Stack:** Node.js CommonJS, `node:test`, 飞书 Base through `lark-cli`, Chrome unpacked extension.

## Global Constraints

- “重试发布” is an option in the existing “确认发布” select field; do not add another column.
- Never auto-retry a failed platform publication.
- CT-00008 must be restored to “发布失败” without triggering a new publication.
- Preserve the original MultiPost task ID and idempotency key on CT-00008.
- A retry must create a new task ID and a new idempotency key.
- Do not modify `D:\一键多平台发布\MultiPost 1.3`.

---

### Task 1: Add retry decision rules

**Files:**
- Modify: `test/worker.test.js`
- Modify: `src/worker.js:102-117`

**Interfaces:**
- Consumes: `firstOption(row[field])`
- Produces: `platformPublishJobAction(row) -> "publish" | "retry" | "generate" | "none"`

- [ ] **Step 1: Write failing decision tests**

Add tests asserting:

```js
assert.equal(platformPublishJobAction({
  '发布标题': '标题',
  '发布文案': '文案',
  '标签': '#标签',
  '文案生成状态': ['已完成'],
  '确认发布': ['重试发布'],
  '发布状态': ['发布失败'],
  'MultiPost任务ID': 'mpx-old',
  '幂等键': 'mpx-old-key',
}), 'retry');
```

Also assert that “重试发布” returns `none` for “发布中”, “发布成功”, “待确认”, or when both historical identifiers are empty.

- [ ] **Step 2: Run the focused tests**

Run: `node --test test/worker.test.js`

Expected: the retry test fails because the current implementation returns `none`.

- [ ] **Step 3: Implement the decision**

In `platformPublishJobAction`, read `confirmation = firstOption(row['确认发布'])`. Return `retry` only when copy is complete, confirmation is “重试发布”, status is “发布失败”, and a historical task identifier exists. Keep the existing first-publish predicate unchanged.

- [ ] **Step 4: Re-run the focused tests**

Run: `node --test test/worker.test.js`

Expected: all worker tests pass.

### Task 2: Generate attempt-specific idempotency keys

**Files:**
- Modify: `test/multipost-publish.test.js`
- Modify: `src/multipost-publish.js:96-106`

**Interfaces:**
- Produces: `buildPublishIdempotencyKey({ recordId, accountRecordId, videoUrl, attempt? }) -> string`

- [ ] **Step 1: Write a failing idempotency test**

```js
const first = buildPublishIdempotencyKey({
  recordId: 'rec-1',
  accountRecordId: 'account-1',
  videoUrl: 'https://example.com/a.mp4',
  attempt: 0,
});
const retry = buildPublishIdempotencyKey({
  recordId: 'rec-1',
  accountRecordId: 'account-1',
  videoUrl: 'https://example.com/a.mp4',
  attempt: 1,
});
assert.notEqual(first, retry);
```

- [ ] **Step 2: Run the focused test**

Run: `node --test test/multipost-publish.test.js`

Expected: failure because `attempt` is not part of the hash source.

- [ ] **Step 3: Implement attempt hashing**

Normalize `attempt` to a non-negative integer and append it to the hash source. Omitting `attempt` must behave as attempt `0` so existing first-publish tests remain deterministic.

- [ ] **Step 4: Re-run the focused test**

Run: `node --test test/multipost-publish.test.js`

Expected: all MultiPost publish tests pass.

### Task 3: Implement one-shot retry task creation

**Files:**
- Modify: `src/worker.js:6-11`
- Modify: `src/worker.js:542-607`
- Modify: `src/worker.js:881-883`
- Modify: `test/worker.test.js`

**Interfaces:**
- Consumes: `markPublishTaskFailed(oldTaskId, reason)`
- Produces: `processConfirmedPublish(row, accountById, { retry: boolean })`

- [ ] **Step 1: Add a failing retry side-effect test**

Exercise `processConfirmedPublish` through injected dependencies or a small exported helper and assert that retry preparation returns:

```js
{
  attempt: 1,
  confirmation: '是',
  previousTaskId: 'mpx-old'
}
```

The helper must reject retry when the old task ID is missing.

- [ ] **Step 2: Run the focused worker tests**

Run: `node --test test/worker.test.js`

Expected: failure because retry preparation is not implemented.

- [ ] **Step 3: Implement retry preparation**

Import `markPublishTaskFailed`. Before writing a new retry task:

```js
markPublishTaskFailed(previousTaskId, '由飞书发起受控重试');
const attempt = retryCount + 1;
```

Build the new key with `attempt`. When updating the Base record, include:

```js
{
  '确认发布': '是',
  '发布状态': '发布中',
  'MultiPost任务ID': taskId,
  '幂等键': idempotencyKey,
  '重试次数': attempt,
  '失败原因': null,
}
```

For a first publish, keep attempt `0` and do not change “重试次数”.

- [ ] **Step 4: Route retry jobs**

In the main loop, call:

```js
if (action === 'publish') await processConfirmedPublish(row, accountById);
else if (action === 'retry') await processConfirmedPublish(row, accountById, { retry: true });
```

- [ ] **Step 5: Run all tests**

Run: `npm test`

Expected: all tests pass.

### Task 4: Update 飞书 schema and restore CT-00008

**Files:**
- No local files.
- Update Base field `fldRxw2qkI`.
- Update Base record `recvpCDSGTWH4k`.

**Interfaces:**
- Consumes: Base token `<REDACTED_BASE_TOKEN>`, table `<REDACTED_PLATFORM_PUBLISH_TABLE_ID>`

- [ ] **Step 1: Read the current field and record**

Run:

```powershell
lark-cli base +field-get --base-token <REDACTED_BASE_TOKEN> --table-id <REDACTED_PLATFORM_PUBLISH_TABLE_ID> --field-id fldRxw2qkI --as user
lark-cli base +record-get --base-token <REDACTED_BASE_TOKEN> --table-id <REDACTED_PLATFORM_PUBLISH_TABLE_ID> --record-id recvpCDSGTWH4k --as user
```

Expected: “确认发布” is a single select; CT-00008 still has the original idempotency key.

- [ ] **Step 2: Update the select field**

Use `base +field-update` with the complete target definition:

```json
{
  "type": "select",
  "name": "确认发布",
  "multiple": false,
  "description": "是=首次发布；重试发布=仅对发布失败的历史任务发起一次受控重试",
  "options": [
    {"name":"否","hue":"Gray","lightness":"Lighter"},
    {"name":"是","hue":"Green","lightness":"Lighter"},
    {"name":"重试发布","hue":"Orange","lightness":"Lighter"}
  ]
}
```

- [ ] **Step 3: Restore CT-00008 without retriggering**

Write:

```json
{
  "发布状态": "发布失败",
  "MultiPost任务ID": "mpx-example-task-id",
  "确认发布": "是",
  "失败原因": "任务已下发，但 MultiPost 扩展未完成实际发布或结果回传；已确认快手端无该作品，可在扩展重新加载后选择“重试发布”"
}
```

Do not clear or replace “幂等键”.

- [ ] **Step 4: Read back schema and record**

Expected: the field has exactly `否 / 是 / 重试发布`; CT-00008 is “发布失败”, has the original task ID and original idempotency key, and is not eligible for automatic first publish.

### Task 5: Reload extension and verify runtime safety

**Files:**
- Use unpacked extension directory: `vendor/MultiPost-1.3.8`

**Interfaces:**
- Chrome extension page: `chrome://extensions`

- [ ] **Step 1: Reload the unpacked MultiPost extension**

Open the existing Chrome extensions page and click “重新加载” only for the MultiPost extension loaded from the workspace directory.

- [ ] **Step 2: Run a worker scan**

Run: `node src/worker.js --once`

Expected: CT-00008 is not published because its confirmation is “是” with existing task identifiers and status “发布失败”.

- [ ] **Step 3: Verify no unintended task was created**

Compare `runtime/multipost-publish-tasks` before and after the scan. Expected: no new task for CT-00008.

- [ ] **Step 4: Final full verification**

Run: `npm test`

Read the Base field and CT-00008 record again. Expected: tests pass and CT-00008 remains safely failed until the user explicitly selects “重试发布”.
