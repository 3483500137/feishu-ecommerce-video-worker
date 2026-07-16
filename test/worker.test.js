'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPersonaImagePrompt, buildVideoGenerationMessage, collectUrls, chooseArtifactUrl, contentJobAction, extractMarkdownUrl, firstOption, inspectXyqRun, linkedRecordId, personaJobAction, probeVideoDuration, resolveReferenceSource, rowsFromEnvelope } = require('../src/worker');

function artifactEntry(subType, mediaKey, url, name) {
  return {
    type: 2,
    artifact: {
      name,
      content: [{ sub_type: subType, data: JSON.stringify({ [mediaKey]: { url } }) }],
    },
  };
}

test('extractMarkdownUrl extracts Feishu markdown links', () => {
  assert.equal(extractMarkdownUrl('[视频](https://v.douyin.com/example/)'), 'https://v.douyin.com/example/');
  assert.equal(extractMarkdownUrl('https://example.com/a.mp4'), 'https://example.com/a.mp4');
});

test('row helpers normalize Base values', () => {
  assert.equal(firstOption(['是']), '是');
  assert.equal(linkedRecordId([{ id: 'rec123' }]), 'rec123');
  assert.deepEqual(rowsFromEnvelope({ fields: ['A'], data: [['x']], record_id_list: ['rec1'] }), [{ record_id: 'rec1', A: 'x' }]);
});

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
  assert.equal(collectUrls(data).length, 1);
});

test('artifact selection decodes escaped ampersands in signed URLs', () => {
  const data = { entry_list: [artifactEntry('biz/x_data_image', 'image', 'https://example.com/image.png?x=1\\u0026signature=ok', 'persona.png')] };
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

test('video task requires a full-frame 9:16 canvas without landscape side backgrounds', () => {
  const message = buildVideoGenerationMessage({ referenceDurationSeconds: 16.7 });
  assert.match(message, /最终成片画布必须严格为 9:16 竖屏/);
  assert.match(message, /主体画面必须铺满整个竖屏画布/);
  assert.match(message, /禁止.*横版画布.*模糊复制侧边背景.*镜像延展.*左右补边.*黑边/);
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

test('interrupted content with existing 小云雀 IDs resumes instead of regenerating', () => {
  assert.equal(contentJobAction({
    '是否立刻生成视频': ['否'],
    '生成状态': ['生成中'],
    '小云雀线程ID': 'thread-1',
    '小云雀运行ID': 'run-1',
  }), 'resume');
});

test('orphaned content without complete 小云雀 IDs regenerates', () => {
  assert.equal(contentJobAction({
    '是否立刻生成视频': ['否'],
    '生成状态': ['生成中'],
    '小云雀线程ID': 'thread-1',
    '小云雀运行ID': '',
  }), 'generate');
});

test('completed existing run returns its final composite artifact', () => {
  const run = {
    state: 3,
    entry_list: [
      artifactEntry('biz/x_data_video', 'video', 'https://cdn.example.com/clip.mp4', 'clip.mp4'),
      artifactEntry('biz/x_data_video', 'video', 'https://cdn.example.com/final.mp4', 'final.mp4'),
    ],
  };
  assert.deepEqual(inspectXyqRun(run, 'video'), {
    status: 'completed',
    resultUrl: 'https://cdn.example.com/final.mp4',
  });
});

test('running existing run remains pending for the next scheduled scan', () => {
  assert.deepEqual(inspectXyqRun({ state: 2 }, 'video'), { status: 'pending' });
});
