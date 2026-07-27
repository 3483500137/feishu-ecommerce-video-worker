'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildInvalidPublishPatch, buildOrphanedPublishTaskPatch, buildLtxAnalysisRequest, buildLtxCompletedPatch, buildLtxFailedPatch, buildLtxPayload, buildLtxStartPatch, buildPersonaImagePrompt, buildPersonaImageRequest, buildPublishAttempt, buildPublishCopyPrompt, buildRelaySegmentPrompt, buildVideoGenerationMessage, collectUrls, chooseArtifactUrl, completeContentVideo, contentJobAction, downloadHttp, extractDouyinShareVideo, extractMarkdownUrl, firstOption, formatPublishTags, hydrateRelayPersona, inspectLtxTask, inspectXyqRun, linkedRecordId, ltxJobAction, ltxModelChoice, ltxReferenceUrl, parsePublishCopy, personaJobAction, platformPublishJobAction, probeVideoDuration, processConfirmedPublish, readVideoDataUrl, relaySegmentPlan, relaySegmentSecondsForAccess, relaySegmentTimeline, relayTaskDescriptor, requestLtxStoryboard, resolveDouyinShareVideo, resolveReferenceSource, resolveFieldIds, rowsFromEnvelope, serializeRelayTaskDescriptor, videoModelChoice } = require('../src/worker');

function artifactEntry(subType, mediaKey, url, name) {
  return {
    type: 2,
    artifact: {
      name,
      content: [{ sub_type: subType, data: JSON.stringify({ [mediaKey]: { url } }) }],
    },
  };
}

test('中转站参考视频任务把关联人设解析为完整人设正文', () => {
  const relayRow = {
    '生成方式': ['参考视频生成'],
    '人设': [{ id: 'rec-persona-1' }],
  };
  const personaById = new Map([[
    'rec-persona-1',
    {
      '人设': '23岁武术少女，黑色长发，绿白中式长裙，清纯但英气。',
      '人物形象链接（内部）': 'https://files.example/persona.png',
    },
  ]]);

  const hydrated = hydrateRelayPersona(relayRow, personaById);

  assert.equal(hydrated['人设'], '23岁武术少女，黑色长发，绿白中式长裙，清纯但英气。');
  assert.equal(hydrated['人设图片链接'], 'https://files.example/persona.png');
  assert.deepEqual(relayRow['人设'], [{ id: 'rec-persona-1' }]);
});

test('LTX status patches never overwrite the final-video attachment field', () => {
  const start = buildLtxStartPatch({
    modelName: 'LTX 2.3 首尾帧',
    submittedAt: 123456789,
  });
  const completed = buildLtxCompletedPatch({ completedAt: 987654321 });
  const failed = buildLtxFailedPatch({ reason: 'segment failed', completedAt: 555555555 });

  assert.equal(start['生成状态'], '生成中');
  assert.equal(start['提交时间'], 123456789);
  assert.equal(Object.hasOwn(start, '最终视频'), false);
  assert.equal(Object.hasOwn(start, '视频时长'), false);
  assert.equal(start['生成供应商'], 'Kimi分镜 + NewAPI LTX + FFmpeg + Cloudflare中继');
  assert.equal(completed['生成状态'], '已完成');
  assert.equal(completed['完成时间'], 987654321);
  assert.equal(Object.hasOwn(completed, '最终视频'), false);
  assert.equal(failed['生成状态'], '失败');
  assert.equal(failed['失败原因'], 'segment failed');
  assert.equal(Object.hasOwn(failed, '最终视频'), false);
});

test('buildLtxAnalysisRequest sends the local reference video and asks for dynamic visual segments', () => {
  const request = buildLtxAnalysisRequest({
    model: 'kimi-k2.6',
    videoDataUrl: 'data:video/mp4;base64,AAAA',
    durationSeconds: 30,
    userPrompt: '保持产品特写',
  });
  assert.equal(request.model, 'kimi-k2.6');
  assert.equal(request.messages[1].content[0].video_url.url, 'data:video/mp4;base64,AAAA');
  assert.match(request.messages[1].content[1].text, /6 个连续的片段/);
  assert.match(request.messages[1].content[1].text, /保持产品特写/);
});

test('readVideoDataUrl converts a local MP4 to a bounded data URL', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ltx-data-url-'));
  const file = path.join(root, 'sample.mp4');
  fs.writeFileSync(file, Buffer.from([0, 1, 2, 3]));
  assert.equal(readVideoDataUrl(file, 4), 'data:video/mp4;base64,AAECAw==');
  assert.throws(() => readVideoDataUrl(file, 3), /过大/);
});

test('requestLtxStoryboard parses six prompts returned by Kimi', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ltx-storyboard-'));
  const file = path.join(root, 'analysis.mp4');
  fs.writeFileSync(file, Buffer.from([0, 1, 2, 3]));
  let captured;
  const prompts = await requestLtxStoryboard({
    videoFile: file,
    durationSeconds: 28,
    userPrompt: '节奏轻快',
    baseUrl: 'https://kimi.test/v1',
    model: 'kimi-k2.6',
    apiKey: 'test-key',
    fetchImpl: async (url, options) => {
      captured = { url, options };
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: '{"segments":["1","2","3","4","5","6"]}' } }] }),
      };
    },
  });
  assert.deepEqual(prompts, ['1', '2', '3', '4', '5', '6']);
  assert.equal(captured.url, 'https://kimi.test/v1/chat/completions');
  assert.equal(captured.options.headers.Authorization, 'Bearer test-key');
});

test('extractMarkdownUrl extracts Feishu markdown links', () => {
  assert.equal(extractMarkdownUrl('[视频](https://v.douyin.com/example/)'), 'https://v.douyin.com/example/');
  assert.equal(
    extractMarkdownUrl('[https://v.douyin.com/dbpH-qOS8EU/](https://v.douyin.com/dbpH-qOS8EU/) '),
    'https://v.douyin.com/dbpH-qOS8EU/',
  );
  assert.equal(extractMarkdownUrl('  https://example.com/a.mp4  '), 'https://example.com/a.mp4');
  assert.equal(extractMarkdownUrl('https://example.com/a.mp4'), 'https://example.com/a.mp4');
});

test('extractDouyinShareVideo reads playable URL and duration from share HTML', () => {
  const html = '"video":{"play_addr":{"uri":"v0","url_list":["https:\\u002F\\u002Faweme.snssdk.com\\u002Faweme\\u002Fv1\\u002Fplaywm\\u002F?video_id=v0&amp;ratio=720p"]},"duration":20734}';
  const result = extractDouyinShareVideo(html);

  assert.equal(result.url, 'https://aweme.snssdk.com/aweme/v1/playwm/?video_id=v0&ratio=720p');
  assert.equal(result.durationSeconds, 20.734);
});

test('resolveDouyinShareVideo follows the play redirect to an mp4 URL', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (url === 'https://v.douyin.com/demo/') {
      return new Response('"video":{"play_addr":{"uri":"v0","url_list":["https:\\u002F\\u002Faweme.snssdk.com\\u002Faweme\\u002Fv1\\u002Fplaywm\\u002F?video_id=v0"]},"duration":6100}', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      });
    }
    return new Response('', {
      status: 302,
      headers: { Location: 'https://v3-dy.example/video.mp4?mime_type=video_mp4' },
    });
  };

  const result = await resolveDouyinShareVideo('https://v.douyin.com/demo/', { fetchImpl });

  assert.equal(result.url, 'https://v3-dy.example/video.mp4?mime_type=video_mp4');
  assert.equal(result.durationSeconds, 6.1);
  assert.equal(calls[1].url, 'https://aweme.snssdk.com/aweme/v1/playwm/?video_id=v0');
});

test('relay long reference videos are split into continuous bounded segments', () => {
  const timeline = relaySegmentTimeline(20.734, 15);

  assert.deepEqual(timeline, [
    { index: 0, start: 0, end: 10.367, duration: 10.367 },
    { index: 1, start: 10.367, end: 20.734, duration: 10.367 },
  ]);
  const prompt = buildRelaySegmentPrompt({
    basePrompt: '完整替换人物并逐镜复刻',
    segment: timeline[1],
    totalSegments: timeline.length,
  });
  assert.match(prompt, /第 2\/2 段/);
  assert.match(prompt, /10\.367 秒到 20\.734 秒/);
  assert.match(prompt, /不得从第 0 秒重新开始/);
});

test('every relay reference above 15 seconds uses exactly two segments with overlap for a natural handoff', () => {
  assert.equal(relaySegmentSecondsForAccess({ videoApiStyle: 'apimesh-videos-generations' }), 15);
  const plan = relaySegmentPlan(17, 15, 0.5);

  assert.deepEqual(plan, [
    { index: 0, start: 0, end: 8.5, duration: 8.5, inputStart: 0, inputDuration: 8.5, trimLeadingSeconds: 0 },
    { index: 1, start: 8.5, end: 17, duration: 8.5, inputStart: 8, inputDuration: 9, trimLeadingSeconds: 0.5 },
  ]);
  const prompt = buildRelaySegmentPrompt({ basePrompt: '逐镜复刻', segment: plan[1], totalSegments: plan.length });
  assert.match(prompt, /0\.500 秒衔接上下文/);
  assert.match(prompt, /禁止把它重新作为新的开场/);
  assert.deepEqual(relaySegmentPlan(30, 15, 0), [
    { index: 0, start: 0, end: 15, duration: 15, inputStart: 0, inputDuration: 15, trimLeadingSeconds: 0 },
    { index: 1, start: 15, end: 30, duration: 15, inputStart: 15, inputDuration: 15, trimLeadingSeconds: 0 },
  ]);
  assert.throws(() => relaySegmentPlan(30.001, 15), /裁剪至 30 秒以内/);
});

test('relay segmented task descriptors round-trip through the external task field', () => {
  const descriptor = {
    mode: 'segmented',
    taskIds: ['task-1', 'task-2'],
    assetKeys: ['rec-segment-a.mp4'],
    durationSeconds: 20.734,
    segmentSeconds: 15,
  };
  const serialized = serializeRelayTaskDescriptor(descriptor);

  assert.deepEqual(relayTaskDescriptor(serialized), { ...descriptor, segmentPlan: [] });
  assert.deepEqual(relayTaskDescriptor('task-single').taskIds, ['task-single']);
  const audioMux = { mode: 'single-audio-mux', taskIds: ['task-audio'], assetKeys: [], durationSeconds: 14.118 };
  assert.deepEqual(relayTaskDescriptor(serializeRelayTaskDescriptor(audioMux)), { ...audioMux, segmentSeconds: 15, segmentPlan: [] });
});

test('LTX reference input accepts only a downloadable HTTP URL', () => {
  assert.equal(
    ltxReferenceUrl('[抖音视频](https://v.douyin.com/dbpH-qOS8EU/) '),
    'https://v.douyin.com/dbpH-qOS8EU/',
  );
  assert.throws(() => ltxReferenceUrl(''), /参考视频链接/);
  assert.throws(() => ltxReferenceUrl('not-a-url'), /有效的 HTTP/);
});

test('row helpers normalize Base values', () => {
  assert.equal(firstOption(['是']), '是');
  assert.equal(linkedRecordId([{ id: 'rec123' }]), 'rec123');
  assert.deepEqual(rowsFromEnvelope({ fields: ['A'], data: [['x']], record_id_list: ['rec1'] }), [{ record_id: 'rec1', A: 'x' }]);
});

test('record reads resolve Chinese field names to the current Base field IDs', () => {
  assert.deepEqual(resolveFieldIds(['内容流水号', 'fld-known', '不存在字段'], [
    { id: 'fld-number', name: '内容流水号' },
    { id: 'fld-known', name: '视频提示词' },
  ]), ['fld-number', 'fld-known', '不存在字段']);
});

test('complete platform publish input with blank copy starts Kimi generation', () => {
  assert.equal(platformPublishJobAction({
    '内容': [{ id: 'content-1' }],
    '平台账号': [{ id: 'account-1' }],
    '最终视频': 'https://example.com/final.mp4',
    '发布标题': '',
    '发布文案': '',
    '标签': '',
    '文案生成状态': '',
    '发布状态': '',
  }), 'generate');
});

test('completed platform publish copy waits while confirmation is not yes', () => {
  assert.equal(platformPublishJobAction({
    '内容': [{ id: 'content-1' }],
    '平台账号': [{ id: 'account-1' }],
    '最终视频': 'https://example.com/final.mp4',
    '发布标题': '标题',
    '发布文案': '文案',
    '标签': '#龙华商汇 #短视频',
    '文案生成状态': ['已完成'],
    '确认发布': ['否'],
    '发布状态': ['待确认'],
  }), 'none');
});

test('confirmed completed platform publish copy starts a real publish', () => {
  assert.equal(platformPublishJobAction({
    '内容': [{ id: 'content-1' }],
    '平台账号': [{ id: 'account-1' }],
    '最终视频': 'https://example.com/final.mp4',
    '发布标题': '标题',
    '发布文案': '文案',
    '标签': '#龙华商汇 #短视频',
    '文案生成状态': ['已完成'],
    '确认发布': ['是'],
    '发布状态': ['待确认'],
    'MultiPost任务ID': '',
    '幂等键': '',
  }), 'publish');
});

test('confirmed completed platform publish copy also starts when status was accidentally blank', () => {
  assert.equal(platformPublishJobAction({
    '内容': [{ id: 'content-1' }],
    '平台账号': [{ id: 'account-1' }],
    '最终视频': 'https://example.com/final.mp4',
    '发布标题': '标题',
    '发布文案': '文案',
    '标签': '#龙华商汇 #短视频',
    '文案生成状态': ['已完成'],
    '确认发布': ['是'],
    '发布状态': null,
    'MultiPost任务ID': '',
    '幂等键': '',
  }), 'publish');
});

test('correcting an invalid first publish from retry to yes starts even when status is failed', () => {
  assert.equal(platformPublishJobAction({
    '内容': [{ id: 'content-1' }],
    '平台账号': [{ id: 'account-1' }],
    '最终视频': 'https://example.com/final.mp4',
    '发布标题': '标题',
    '发布文案': '文案',
    '标签': '#龙华商汇 #短视频',
    '文案生成状态': ['已完成'],
    '确认发布': ['是'],
    '发布状态': ['发布失败'],
    'MultiPost任务ID': '',
    '幂等键': '',
  }), 'publish');
});

test('existing MultiPost task prevents duplicate publishing', () => {
  assert.equal(platformPublishJobAction({
    '内容': [{ id: 'content-1' }],
    '平台账号': [{ id: 'account-1' }],
    '最终视频': 'https://example.com/final.mp4',
    '发布标题': '标题',
    '发布文案': '文案',
    '标签': '#龙华商汇 #短视频',
    '文案生成状态': ['已完成'],
    '确认发布': ['是'],
    '发布状态': ['待确认'],
    'MultiPost任务ID': 'mpx-existing',
    '幂等键': 'sha256-existing',
  }), 'none');
});

test('failed MultiPost task can be retried only through the explicit retry option', () => {
  assert.equal(platformPublishJobAction({
    '发布标题': '标题',
    '发布文案': '文案',
    '标签': '#龙华商汇 #短视频',
    '文案生成状态': ['已完成'],
    '确认发布': ['重试发布'],
    '发布状态': ['发布失败'],
    'MultiPost任务ID': 'mpx-existing',
    '幂等键': 'mpx-existing-key',
  }), 'retry');
});

test('explicit retry recovers a dispatched task whose Base status was manually cleared', () => {
  assert.equal(platformPublishJobAction({
    '发布标题': '标题',
    '发布文案': '文案',
    '标签': '#龙华商汇 #短视频',
    '文案生成状态': ['已完成'],
    '确认发布': ['重试发布'],
    '发布状态': null,
    'MultiPost任务ID': 'mpx-existing',
    '幂等键': 'mpx-existing-key',
  }), 'retry');
});

test('confirmed publish with a blank status and existing MultiPost task is surfaced for controlled retry', () => {
  const row = {
    '发布标题': '标题',
    '发布文案': '文案',
    '标签': '#龙华商汇 #短视频',
    '文案生成状态': ['已完成'],
    '确认发布': ['是'],
    '发布状态': null,
    'MultiPost任务ID': 'mpx-existing',
    '幂等键': 'mpx-existing-key',
  };

  assert.equal(platformPublishJobAction(row), 'orphaned-task');
  const patch = buildOrphanedPublishTaskPatch(row);
  assert.equal(patch['发布状态'], '发布失败');
  assert.match(patch['失败原因'], /已有 MultiPost任务ID/);
  assert.match(patch['失败原因'], /重试发布/);
});

test('retry option does not bypass status and task-history safeguards', () => {
  const base = {
    '发布标题': '标题',
    '发布文案': '文案',
    '标签': '#龙华商汇 #短视频',
    '文案生成状态': ['已完成'],
    '确认发布': ['重试发布'],
    'MultiPost任务ID': 'mpx-existing',
    '幂等键': 'mpx-existing-key',
  };
  for (const status of ['待确认', '发布中', '发布成功']) {
    assert.equal(platformPublishJobAction({ ...base, '发布状态': [status] }), 'none');
  }
  assert.equal(platformPublishJobAction({
    ...base,
    '发布状态': ['发布失败'],
    'MultiPost任务ID': '',
    '幂等键': '',
  }), 'none');
});

test('retry option without a historical task is surfaced as a visible publish failure', () => {
  const row = {
    '发布标题': '标题',
    '发布文案': '文案',
    '标签': '#龙华商汇 #短视频',
    '文案生成状态': ['已完成'],
    '确认发布': ['重试发布'],
    '发布状态': null,
    'MultiPost任务ID': '',
    '幂等键': '',
  };

  assert.equal(platformPublishJobAction(row), 'invalid-retry');
  assert.deepEqual(buildInvalidPublishPatch(row), {
    '发布状态': '发布失败',
    '失败原因': '重试发布缺少历史 MultiPost任务ID；首次发布请将“确认发布”改为“是”。',
  });
});

test('retry preparation consumes the retry option and increments the attempt once', () => {
  assert.deepEqual(buildPublishAttempt({
    '确认发布': ['重试发布'],
    'MultiPost任务ID': 'mpx-old',
    '重试次数': 0,
  }, { retry: true }), {
    attempt: 1,
    confirmation: '是',
    previousTaskId: 'mpx-old',
  });
  assert.throws(() => buildPublishAttempt({
    '确认发布': ['重试发布'],
    'MultiPost任务ID': '',
    '重试次数': 0,
  }, { retry: true }), /缺少历史 MultiPost任务ID/);
});

test('Kimi publish copy parser accepts fenced JSON and normalizes tags', () => {
  const parsed = parsePublishCopy('```json\n{"title":"  标题  ","copy":" 一袭青衣，拳风飒爽。你觉得拳好看，还是她更好看？ ","tags":["#古风"," 武术 ","#互动","#古风"]}\n```');
  assert.deepEqual(parsed, {
    title: '标题',
    copy: '一袭青衣，拳风飒爽。你觉得拳好看，还是她更好看？',
    tags: ['古风', '武术', '互动'],
  });
  assert.equal(formatPublishTags(parsed.tags), '#古风 #武术 #互动');
});

test('Kimi publish copy parser rejects long-form narration', () => {
  assert.throws(() => parsePublishCopy(JSON.stringify({
    title: '古风女侠',
    copy: '这是一段明显超过四十五个字符的长篇场景复述，它把人物服装、庭院环境、每一个转身、踢腿、出掌和最后定势都逐一介绍了一遍。',
    tags: ['古风', '武术', '女侠'],
  })), /发布文案超过 45 字/);
});

test('publish prompt includes platform and known content context', () => {
  const prompt = buildPublishCopyPrompt({
    platform: '快手',
    contentNumber: 'CT-00005',
    videoPrompt: '展示商圈夜景和餐饮门店',
  });
  assert.match(prompt, /快手/);
  assert.match(prompt, /CT-00005/);
  assert.match(prompt, /展示商圈夜景和餐饮门店/);
  assert.match(prompt, /标题不超过 20 字/);
  assert.match(prompt, /正文 20 至 45 字/);
  assert.match(prompt, /最多两句/);
  assert.match(prompt, /禁止逐镜头复述/);
  assert.match(prompt, /标签 3 至 5 个/);
  assert.match(prompt, /JSON/);
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

test('extractMarkdownUrl reads links from pasted short-video share text', () => {
  const text = '6.61 u@F.hb :7pm 11/20 jPk:/ 一身沉气 [https://v.douyin.com/fxwMMjgLGMY/](https://v.douyin.com/fxwMMjgLGMY/) 复制此链接';
  assert.equal(extractMarkdownUrl(text), 'https://v.douyin.com/fxwMMjgLGMY/');
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

test('video task message forbids segment repetition and requires a continuous reference timeline', () => {
  const message = buildVideoGenerationMessage({ referenceDurationSeconds: 16.7 });
  assert.match(message, /从 0 秒到结尾/);
  assert.match(message, /第二段必须承接第一段之后的参考视频内容/);
  assert.match(message, /不得把第一段动作、镜头或画面复制到第二段/);
  assert.match(message, /不得循环、回放或重新开始/);
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

test('video model defaults to Seedance 2.0 Mini when the Base field is empty', () => {
  assert.deepEqual(videoModelChoice(''), {
    name: 'Seedance 2.0 Mini',
    id: 'Seedance_2.0_mini',
  });
});

test('video model selection maps every Base option to an explicit backend model', () => {
  assert.deepEqual(videoModelChoice(['Seedance 2.0']), {
    name: 'Seedance 2.0',
    id: 'seedance2.0_vision',
  });
  assert.deepEqual(videoModelChoice(['Seedance 2.0 Mini']), {
    name: 'Seedance 2.0 Mini',
    id: 'Seedance_2.0_mini',
  });
});

test('video message keeps a dynamically selected access model instead of falling back to Mini', () => {
  const message = buildVideoGenerationMessage({
    videoModel: { name: '部署者视频模型', id: 'custom-video-v2' },
  });
  assert.match(message, /部署者视频模型/);
  assert.match(message, /custom-video-v2/);
  assert.doesNotMatch(message, /Seedance 2\.0 Mini/);
});

test('video task explicitly requires the selected model', () => {
  const message = buildVideoGenerationMessage({
    referenceDurationSeconds: 15,
    videoModel: ['Seedance 2.0 Mini'],
  });
  assert.match(message, /必须且只能使用指定视频模型：Seedance 2\.0 Mini/);
  assert.match(message, /模型标识：Seedance_2\.0_mini/);
});

test('LTX model selection maps the two Base options to separate workflows', () => {
  assert.deepEqual(ltxModelChoice(['LTX 2.3 单帧']), {
    name: 'LTX 2.3 单帧',
    id: 'aipdd_ltx_2.3',
    mode: 'single',
  });
  assert.deepEqual(ltxModelChoice(['LTX 2.3 首尾帧']), {
    name: 'LTX 2.3 首尾帧',
    id: 'aipdd_ltx_2.3 (首尾帧)',
    mode: 'first-last',
  });
});

test('single-frame LTX payload uses the tested fixed output profile', () => {
  assert.deepEqual(buildLtxPayload({
    modelValue: ['LTX 2.3 单帧'],
    prompt: '人物自然看向镜头',
    firstFrameUrl: 'https://cdn.example.com/first.jpg',
    seed: 12345,
  }), {
    model: 'aipdd_ltx_2.3',
    prompt: '人物自然看向镜头',
    image: 'https://cdn.example.com/first.jpg',
    width: 704,
    height: 1280,
    duration: 5,
    generate_audio: false,
    seed: 12345,
  });
});

test('first-last LTX payload requires both public HTTPS frames and serializes its timeline', () => {
  const payload = buildLtxPayload({
    modelValue: ['LTX 2.3 首尾帧'],
    prompt: '人物缓慢转身',
    firstFrameUrl: 'https://cdn.example.com/first.jpg',
    lastFrameUrl: 'https://cdn.example.com/last.jpg',
  });
  assert.equal(payload.first_frame_image, 'https://cdn.example.com/first.jpg');
  assert.equal(payload.last_frame_image, 'https://cdn.example.com/last.jpg');
  assert.deepEqual(JSON.parse(payload.timeline_data), {
    segments: [{ prompt: '人物缓慢转身', length: 121, color: '#4f8edc' }],
  });
  assert.throws(() => buildLtxPayload({
    modelValue: ['LTX 2.3 首尾帧'],
    prompt: '人物缓慢转身',
    firstFrameUrl: 'https://cdn.example.com/first.jpg',
  }), /缺少尾帧图片/);
  assert.throws(() => buildLtxPayload({
    modelValue: ['LTX 2.3 单帧'],
    prompt: '人物自然看向镜头',
    firstFrameUrl: 'http://cdn.example.com/first.jpg',
  }), /公开 HTTPS/);
});

test('LTX content records submit once and resume by external task ID', () => {
  assert.equal(ltxJobAction({
    '是否立刻生成视频': ['是'],
    '生成状态': ['等待'],
  }), 'generate');
  assert.equal(ltxJobAction({
    '是否立刻生成视频': ['否'],
    '生成状态': ['生成中'],
    '外部任务ID': 'video-task-1',
  }), 'resume');
  assert.equal(ltxJobAction({
    '是否立刻生成视频': ['否'],
    '生成状态': ['已完成'],
    '外部任务ID': 'video-task-1',
  }), 'none');
});

test('LTX task inspection normalizes pending, completed and failed responses', () => {
  assert.deepEqual(inspectLtxTask({ status: 'processing' }), { status: 'pending' });
  assert.deepEqual(inspectLtxTask({
    status: 'completed',
    metadata: { url: 'https://cdn.example.com/final.mp4' },
  }), {
    status: 'completed',
    resultUrl: 'https://cdn.example.com/final.mp4',
  });
  assert.deepEqual(inspectLtxTask({
    status: 'failed',
    error: { message: 'upstream rejected the image' },
  }), {
    status: 'failed',
    error: 'LTX生成失败: upstream rejected the image',
  });
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

test('persona image request uploads a pasted reference and makes its face the identity source', () => {
  const uploads = [];
  const request = buildPersonaImageRequest({
    persona: '传承咏春的武术少女',
    userRequirement: '穿青白中式长裙',
    referenceFile: 'C:\\temp\\face.png',
    uploadAsset: (filePath) => {
      uploads.push(filePath);
      return 'asset-face-001';
    },
  });

  assert.deepEqual(uploads, ['C:\\temp\\face.png']);
  assert.deepEqual(request.assetIds, ['asset-face-001']);
  assert.match(request.message, /参考图片.*人脸身份/);
  assert.match(request.message, /同一个人/);
  assert.match(request.message, /不得.*其他人.*脸/);
  assert.match(request.message, /背景、服装和姿势/);
});

test('persona image request keeps the original text-only flow when no reference is pasted', () => {
  const request = buildPersonaImageRequest({
    persona: '传承咏春的武术少女',
    userRequirement: '穿青白中式长裙',
    referenceFile: '',
    uploadAsset: () => { throw new Error('must not upload'); },
  });

  assert.deepEqual(request.assetIds, []);
  assert.doesNotMatch(request.message, /参考图片.*人脸身份/);
  assert.match(request.message, /传承咏春的武术少女/);
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

test('failed or already-running persona is not passively regenerated every scan', () => {
  assert.equal(personaJobAction({
    '是否立刻生成人设': ['否'],
    '人设生成状态': ['失败'],
    '人物形象': null,
  }), 'none');
  assert.equal(personaJobAction({
    '是否立刻生成人设': ['否'],
    '人设生成状态': ['生成中'],
    '人物形象': null,
  }), 'none');
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

test('content completion uploads final video into an online-preview attachment when configured', async () => {
  const calls = [];
  await completeContentVideo({
    tableId: 'tbl-content',
    recordId: 'rec-content',
    resultUrl: 'https://cdn.example.com/final.mp4?download=true',
    workDir: 'C:\\runtime\\content-rec',
    finalVideoAttachmentFieldId: 'fldPreview',
    downloadHttpFn: async (url, targetBase) => {
      calls.push(['download', url, targetBase]);
      return 'C:\\runtime\\content-rec\\final-video.mp4';
    },
    replaceAttachmentFn: (tableId, recordId, fieldId, filePath) => {
      calls.push(['attach', tableId, recordId, fieldId, filePath]);
    },
    updateRecordFn: (tableId, recordId, patch) => {
      calls.push(['update', tableId, recordId, patch]);
    },
  });

  assert.deepEqual(calls, [
    ['download', 'https://cdn.example.com/final.mp4?download=true', 'C:\\runtime\\content-rec\\final-video'],
    ['attach', 'tbl-content', 'rec-content', 'fldPreview', 'C:\\runtime\\content-rec\\final-video.mp4'],
    ['update', 'tbl-content', 'rec-content', {
      '最终视频': 'https://cdn.example.com/final.mp4?download=true',
      '生成状态': '已完成',
      '失败原因': null,
    }],
  ]);
});

test('worker launcher uses an explicit node executable and records startup failures', () => {
  const launcher = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'run-worker.ps1'), 'utf8');

  assert.match(launcher, /nodeCandidates/);
  assert.match(launcher, /@\(\$nodeCandidates\)\[0\]/);
  assert.match(launcher, /worker-launcher\.log/);
  assert.doesNotMatch(launcher, /& node\s+['"]?\.\\src\\worker\.js/);
  assert.doesNotMatch(launcher, /New-Item[^\n]*-LiteralPath/);
});

test('worker launcher kills a timed-out worker and removes its stale lock', () => {
  const launcher = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'run-worker.ps1'), 'utf8');

  assert.match(launcher, /FEISHU_WORKER_TIMEOUT_MINUTES/);
  assert.match(launcher, /Start-Process/);
  assert.match(launcher, /WaitForExit/);
  assert.match(launcher, /Stop-Process\s+-Id\s+\$workerProcess\.Id\s+-Force/);
  assert.match(launcher, /worker\.lock/);
});

test('worker lark-cli calls have a transport timeout instead of blocking forever', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'worker.js'), 'utf8');

  assert.match(source, /timeout:\s*options\.timeoutMs/);
  assert.match(source, /run\(process\.execPath,\s*\[LARK_CLI,[\s\S]+timeoutMs:\s*60_000/);
  assert.match(source, /process\.exit\(0\)/);
});

test('content completion creates the preview download directory', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'content-preview-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await completeContentVideo({
    tableId: 'tbl-content',
    recordId: 'rec-content',
    resultUrl: 'https://cdn.example.com/final.mp4',
    workDir: path.join(root, 'nested'),
    finalVideoAttachmentFieldId: 'fldPreview',
    downloadHttpFn: async (_url, targetBase) => {
      assert.equal(fs.existsSync(path.dirname(targetBase)), true);
      const file = `${targetBase}.mp4`;
      fs.writeFileSync(file, 'video bytes');
      return file;
    },
    replaceAttachmentFn: () => {},
    updateRecordFn: () => {},
  });
});

test('downloadHttp stores video/mp4 responses with an mp4 extension', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'video-download-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => ({
    ok: true,
    url: 'https://cdn.example.com/signed/no-extension',
    headers: { get: (name) => (name.toLowerCase() === 'content-type' ? 'video/mp4' : '') },
    arrayBuffer: async () => Buffer.from('video bytes'),
  });

  const file = await downloadHttp('https://cdn.example.com/signed/no-extension', path.join(root, 'final-video'));

  assert.equal(path.extname(file), '.mp4');
  assert.equal(fs.readFileSync(file, 'utf8'), 'video bytes');
});

test('downloadHttp uses Douyin-friendly headers for resolved douyinvod media', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-download-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let capturedOptions;
  globalThis.fetch = async (_url, options) => {
    capturedOptions = options;
    return {
      ok: true,
      url: 'https://v3-douyinvod.com/video?mime_type=video_mp4',
      headers: { get: (name) => (name.toLowerCase() === 'content-type' ? 'video/mp4' : '') },
      arrayBuffer: async () => Buffer.from('video bytes'),
    };
  };

  await downloadHttp('https://v3-douyinvod.com/video?mime_type=video_mp4', path.join(root, 'segment'));

  assert.equal(capturedOptions.headers.Referer, 'https://www.iesdouyin.com/');
  assert.match(capturedOptions.headers['User-Agent'], /iPhone/);
});

test('running existing run remains pending for the next scheduled scan', () => {
  assert.deepEqual(inspectXyqRun({ state: 2 }, 'video'), { status: 'pending' });
});
