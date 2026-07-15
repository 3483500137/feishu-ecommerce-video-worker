'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPersonaImagePrompt, buildVideoGenerationMessage, collectUrls, chooseArtifactUrl, extractMarkdownUrl, firstOption, linkedRecordId, probeVideoDuration, resolveReferenceSource, rowsFromEnvelope } = require('../src/worker');

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

test('video duration probe parses FFmpeg duration output', () => {
  const fakeSpawn = () => ({ stderr: 'Duration: 00:00:16.70, start: 0.000000, bitrate: 1234 kb/s' });
  assert.equal(probeVideoDuration('reference.mp4', fakeSpawn), 16.7);
});

test('video duration probe returns null for unreadable output', () => {
  assert.equal(probeVideoDuration('reference.mp4', () => ({ stderr: 'Invalid data found' })), null);
});

test('persona image prompt requires real-camera photography and rejects 2D and CG styles', () => {
  const prompt = buildPersonaImagePrompt('传承咏春的武术少女', '穿青白中式长裙');
  assert.match(prompt, /传承咏春的武术少女/);
  assert.match(prompt, /穿青白中式长裙/);
  assert.match(prompt, /真实相机拍摄/);
  assert.match(prompt, /自然皮肤纹理/);
  assert.match(prompt, /真实五官比例/);
  assert.match(prompt, /禁止.*2D.*动漫.*插画.*3D CG.*游戏建模.*数字人/);
  assert.match(prompt, /20至30岁/);
  assert.match(prompt, /单人全身/);
  assert.match(prompt, /不得出现其他人物/);
});
