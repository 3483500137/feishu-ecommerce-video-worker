'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildExtensionPublishPayload,
  buildPublishIdempotencyKey,
  findLatestDispatchedPublishTask,
  markPublishTaskDispatched,
  markPublishTaskSucceeded,
  normalizeTags,
  writePublishTask,
} = require('../src/multipost-publish');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('builds the official MultiPost extension payload for Kuaishou auto publish', () => {
  const payload = buildExtensionPublishPayload({
    platform: '快手',
    title: '问你呢，拳好看还是我好看？',
    content: '拳风扫过来的时候，我呼吸都停了。',
    tags: '#古风 #武侠 #汉服',
    videoUrl: 'https://cdn.example.com/final.mp4?token=abc',
    scheduledPublishTime: '2026-07-18 09:30:00',
  });

  assert.deepEqual(payload.platforms, [{ name: 'VIDEO_KUAISHOU' }]);
  assert.equal(payload.isAutoPublish, true);
  assert.equal(payload.data.title, '问你呢，拳好看还是我好看？');
  assert.equal(payload.data.content, '拳风扫过来的时候，我呼吸都停了。');
  assert.deepEqual(payload.data.tags, ['古风', '武侠', '汉服']);
  assert.equal(payload.data.video.url, 'https://cdn.example.com/final.mp4?token=abc');
  assert.equal(payload.data.video.name, 'final.mp4');
  assert.equal(payload.data.video.type, 'video/mp4');
  assert.equal(payload.data.scheduledPublishTime, new Date('2026-07-18T09:30:00+08:00').getTime());
});

test('normalizes hash-prefixed and repeated publish tags', () => {
  assert.deepEqual(normalizeTags('#古风 #武侠  #古风,汉服'), ['古风', '武侠', '汉服']);
});

test('idempotency key is deterministic and changes with the target account', () => {
  const first = buildPublishIdempotencyKey({
    recordId: 'rec-publish-1',
    accountRecordId: 'rec-account-1',
    videoUrl: 'https://example.com/a.mp4',
  });
  const repeated = buildPublishIdempotencyKey({
    recordId: 'rec-publish-1',
    accountRecordId: 'rec-account-1',
    videoUrl: 'https://example.com/a.mp4',
  });
  const otherAccount = buildPublishIdempotencyKey({
    recordId: 'rec-publish-1',
    accountRecordId: 'rec-account-2',
    videoUrl: 'https://example.com/a.mp4',
  });

  assert.equal(first, repeated);
  assert.notEqual(first, otherAccount);
  assert.match(first, /^mpx-[a-f0-9]{32}$/);
});

test('idempotency key changes for each controlled retry attempt', () => {
  const first = buildPublishIdempotencyKey({
    recordId: 'rec-publish-1',
    accountRecordId: 'rec-account-1',
    videoUrl: 'https://example.com/a.mp4',
    attempt: 0,
  });
  const retry = buildPublishIdempotencyKey({
    recordId: 'rec-publish-1',
    accountRecordId: 'rec-account-1',
    videoUrl: 'https://example.com/a.mp4',
    attempt: 1,
  });

  assert.notEqual(first, retry);
  assert.match(retry, /^mpx-[a-f0-9]{32}$/);
});

test('rejects unsupported platforms before opening a publish task', () => {
  assert.throws(() => buildExtensionPublishPayload({
    platform: '未知平台',
    title: '标题',
    content: '文案',
    tags: '#标签',
    videoUrl: 'https://example.com/a.mp4',
  }), /暂不支持.*未知平台/);
});

test('finds and completes the matching recently dispatched publish task', (t) => {
  const taskDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multipost-publish-'));
  t.after(() => fs.rmSync(taskDir, { recursive: true, force: true }));
  writePublishTask({
    taskId: 'mpx-test-success',
    recordId: 'recvpBGbdaG3LA',
    status: 'queued',
    createdAt: new Date().toISOString(),
    expectedAccount: { platformKey: 'kuaishou', accountId: '9990000000001' },
    payload: {
      data: { title: '问你呢，拳好看还是我好看？' },
    },
  }, taskDir);
  markPublishTaskDispatched('mpx-test-success', taskDir);

  const matching = findLatestDispatchedPublishTask({
    platformKey: 'kuaishou',
    titleText: '问你呢，拳好看还是我好看？ 拳风扫过来的时候，我呼吸都停了。',
  }, taskDir);
  assert.equal(matching.taskId, 'mpx-test-success');

  const completed = markPublishTaskSucceeded('mpx-test-success', {
    publishedAt: '2026-07-17 17:02',
  }, taskDir);
  assert.equal(completed.status, 'succeeded');
  assert.equal(completed.publishedAt, '2026-07-17 17:02');
});
