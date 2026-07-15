'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { collectUrls, chooseArtifactUrl, extractMarkdownUrl, firstOption, linkedRecordId, resolveReferenceSource, rowsFromEnvelope } = require('../src/worker');

test('extractMarkdownUrl extracts Feishu markdown links', () => {
  assert.equal(extractMarkdownUrl('[视频](https://v.douyin.com/example/)'), 'https://v.douyin.com/example/');
  assert.equal(extractMarkdownUrl('https://example.com/a.mp4'), 'https://example.com/a.mp4');
});

test('row helpers normalize Base values', () => {
  assert.equal(firstOption(['是']), '是');
  assert.equal(linkedRecordId([{ id: 'rec123' }]), 'rec123');
  assert.deepEqual(rowsFromEnvelope({ fields: ['A'], data: [['x']], record_id_list: ['rec1'] }), [{ record_id: 'rec1', A: 'x' }]);
});

test('artifact selection prefers requested media type', () => {
  const data = { items: [{ url: 'https://example.com/image.png' }, { url: 'https://example.com/video.mp4' }] };
  assert.equal(chooseArtifactUrl(data, 'video'), 'https://example.com/video.mp4');
  assert.equal(chooseArtifactUrl(data, 'image'), 'https://example.com/image.png');
  assert.equal(collectUrls(data).length, 2);
});

test('artifact selection decodes escaped ampersands in signed URLs', () => {
  const data = { url: 'https://example.com/image.png?x=1\\u0026signature=ok' };
  assert.equal(chooseArtifactUrl(data, 'image'), 'https://example.com/image.png?x=1&signature=ok');
});

test('falls back to the reference URL when downloading the video fails', async () => {
  const result = await resolveReferenceSource({
    attachmentFile: '',
    referenceUrl: 'https://v.douyin.com/example/',
    download: () => { throw new Error('cookies required'); },
  });
  assert.deepEqual(result, {
    file: '',
    fallbackUrl: 'https://v.douyin.com/example/',
    downloadError: 'cookies required',
  });
});
