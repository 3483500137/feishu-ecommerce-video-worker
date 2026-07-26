'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  relayContentJobAction,
  relayNextActionAfterPrompt,
  relayRetryNextAction,
  buildRelayPromptRequest,
  buildRelayReferenceLinkPrompt,
  buildRelayVideoRequest,
  relayGenerationMethod,
  relayVideoDuration,
  inspectRelayVideoTask,
  buildRelayStartPatch,
  buildRelayFailurePatch,
  friendlyRelayErrorMessage,
} = require('../src/relay-content');

test('an immediate run continues from prompt generation or retry in the same worker scan', () => {
  assert.equal(relayNextActionAfterPrompt({ requestedVideo: true }), 'submit-video');
  assert.equal(relayNextActionAfterPrompt({ requestedVideo: false }), 'none');
  assert.equal(relayRetryNextAction({ hasPrompt: true }), 'submit-video');
  assert.equal(relayRetryNextAction({ hasPrompt: false }), 'generate-prompt');
});

const videoAccess = {
  accessNumber: 'API-0002', accessName: '中转站视频', protocol: 'videos',
  baseUrl: 'https://relay.example/v1', modelId: 'video-pro', modelName: 'Video Pro',
};

test('relay state machine generates prompt first and defaults video ratio to 9:16', () => {
  assert.equal(relayContentJobAction({ '生成状态': [], '输入内容要求': '' }), 'none');
  assert.equal(relayContentJobAction({
    '生成状态': [], '输入内容要求': '展示新款汉服',
  }), 'generate-prompt');
  assert.equal(relayContentJobAction({
    '生成状态': ['待生成视频'], '视频提示词': '古风女子旋转展示汉服', '是否立刻生成视频': ['是'],
  }), 'submit-video');
  const request = buildRelayVideoRequest({
    '生成方式': ['文生视频'], '视频提示词': '古风女子旋转展示汉服', '视频时长': 6,
  }, videoAccess);
  assert.equal(request.payload.aspect_ratio, '9:16');
  assert.equal(request.payload.prompt, '古风女子旋转展示汉服');
  assert.equal(request.payload.duration, 6);
});

test('relay prompt generation choice controls initial generation and regeneration', () => {
  assert.equal(relayContentJobAction({
    '生成状态': [], '输入内容要求': '展示新款汉服', '生成视频提示词': ['否'],
  }), 'none');
  assert.equal(relayContentJobAction({
    '生成状态': [], '输入内容要求': '展示新款汉服', '生成视频提示词': ['是'],
  }), 'generate-prompt');
  assert.equal(relayContentJobAction({
    '生成状态': ['待生成视频'], '输入内容要求': '展示新款汉服', '视频提示词': '旧提示词', '生成视频提示词': ['重新生成'],
  }), 'generate-prompt');
  assert.equal(relayContentJobAction({
    '生成状态': ['失败'], '输入内容要求': '', '视频提示词': '', '生成视频提示词': ['是'],
    '生成方式': ['参考视频生成'], '参考视频链接': 'https://v.douyin.com/example/',
  }), 'generate-prompt');
  assert.equal(relayContentJobAction({
    '生成状态': [], '输入内容要求': '', '生成视频提示词': ['重新生成'],
    '生成方式': ['参考视频生成'], '参考视频链接': 'https://v.douyin.com/example/',
  }), 'generate-prompt');
  assert.equal(relayContentJobAction({
    '生成状态': ['待生成视频'], '视频提示词': '古风女子旋转展示汉服', '是否立刻生成视频': ['是'], '视频生成选用': [{ id: 'rec-video-1' }],
  }), 'submit-video');
});

test('a reference-video link defaults an otherwise unselected mode to reference-video generation', () => {
  const row = {
    '参考视频链接': 'https://v.douyin.com/example/',
    '生成视频提示词': ['重新生成'],
    '生成状态': ['待生成提示词'],
  };
  assert.equal(relayGenerationMethod(row), '参考视频生成');
  assert.equal(relayContentJobAction(row), 'generate-prompt');
});

test('reference video generation uses probed duration when the field is blank', () => {
  assert.equal(relayVideoDuration({ '生成方式': ['参考视频生成'], '视频时长': '' }, { referenceDurationSeconds: 8.7 }), 8.7);
  assert.equal(relayVideoDuration({ '生成方式': ['参考视频生成'], '视频时长': 9 }, { referenceDurationSeconds: 8.7 }), 8.7);
  assert.equal(relayVideoDuration({ '生成方式': ['参考视频生成'], '视频时长': '' }), null);
  const request = buildRelayVideoRequest({
    '生成方式': ['参考视频生成'],
    '视频提示词': '按参考视频复刻',
    '参考视频链接': 'https://files/ref.mp4',
    '画面比例': ['16:9'],
  }, videoAccess, { referenceDurationSeconds: 8.7 });
  assert.equal(request.payload.duration, 8.7);
  assert.equal(request.payload.aspect_ratio, '9:16');
});

test('reference video generation omits duration when only a link is available', () => {
  const request = buildRelayVideoRequest({
    '生成方式': ['参考视频生成'],
    '视频提示词': '按参考视频复刻',
    '参考视频链接': '抖音分享 [https://v.douyin.com/fxwMMjgLGMY/](https://v.douyin.com/fxwMMjgLGMY/) 复制链接',
    '视频时长': '',
  }, videoAccess);
  assert.equal(request.payload.reference_video_url, 'https://v.douyin.com/fxwMMjgLGMY/');
  assert.equal(Object.hasOwn(request.payload, 'duration'), false);
  assert.equal(request.payload.width, 1080);
  assert.equal(request.payload.height, 1920);
});

test('reference video generation can submit a resolved playable URL while keeping the pasted share link', () => {
  const request = buildRelayVideoRequest({
    '生成方式': ['参考视频生成'],
    '视频提示词': '按参考视频复刻',
    '参考视频链接': 'https://v.douyin.com/fxwMMjgLGMY/',
  }, videoAccess, { referenceVideoUrl: 'https://v3-dy.example/video.mp4?mime_type=video_mp4' });

  assert.equal(request.payload.reference_video_url, 'https://v3-dy.example/video.mp4?mime_type=video_mp4');
});

test('NewAPI reference video generation omits duration because the provider derives it from the reference video', () => {
  const request = buildRelayVideoRequest({
    '生成方式': ['参考视频生成'],
    '视频提示词': '按参考视频复刻，保持同等时长',
    '参考视频链接': 'https://v.douyin.com/fxwMMjgLGMY/',
    '人设图片链接': 'https://files.example/persona.png',
  }, { ...videoAccess, videoApiStyle: 'newapi-video-generations' }, {
    referenceDurationSeconds: 20.734,
    referenceVideoUrl: 'https://v3-dy.example/video.mp4?mime_type=video_mp4',
  });

  assert.equal(request.payload.reference_video_url, 'https://v3-dy.example/video.mp4?mime_type=video_mp4');
  assert.equal(request.payload.image_url, 'https://files.example/persona.png');
  assert.equal(Object.hasOwn(request.payload, 'duration'), false);
});

test('APIMesh reference video generation creates silent visuals for reference-audio muxing', () => {
  const request = buildRelayVideoRequest({
    '生成方式': ['参考视频生成'],
    '视频提示词': '按参考视频逐镜复刻',
    '参考视频链接': 'https://files.example/reference.mp4',
  }, { ...videoAccess, videoApiStyle: 'apimesh-videos-generations' }, { referenceDurationSeconds: 14.118 });

  assert.equal(request.payload.duration, 14.118);
  assert.equal(request.payload.generate_audio, false);
});

test('relay task with an external id only resumes polling and controlled retry wins once', () => {
  assert.equal(relayContentJobAction({
    '生成状态': ['生成中'], '外部任务ID': 'task-1', '是否立刻生成视频': ['是'],
  }), 'poll-video');
  assert.equal(relayContentJobAction({
    '生成状态': ['失败'], '外部任务ID': 'task-old', '是否立刻生成视频': ['重试生成'],
  }), 'reset-retry');
  assert.equal(relayContentJobAction({
    '生成状态': ['失败'], '外部任务ID': 'task-old', '重试生成': ['重试'],
  }), 'reset-retry');
  assert.equal(relayContentJobAction({
    '生成状态': ['已完成'], '外部任务ID': 'task-1', '是否立刻生成视频': ['否'],
  }), 'none');
});

test('prompt request contains requirements and selected text model', () => {
  const access = { ...videoAccess, protocol: 'chat-completions', modelId: 'moonshot-v1-8k' };
  const request = buildRelayPromptRequest({
    '输入内容要求': '突出面料垂坠感，人物全身入镜',
    '生成方式': ['图生视频'], '视频时长': 5, '画面比例': ['9:16'],
  }, access);
  assert.equal(request.access, access);
  assert.match(request.messages[1].content, /面料垂坠感/);
  assert.match(request.messages[1].content, /图生视频/);
  assert.match(request.messages[1].content, /制作复刻视频/);
  assert.match(request.messages[1].content, /参考图片、参考视频或参考链接/);
  assert.match(request.messages[1].content, /9:16/);
});

test('reference-video prompt analysis sends the actual video to the vision model', () => {
  const access = { ...videoAccess, protocol: 'chat-completions', modelId: 'kimi-k2.6' };
  const request = buildRelayPromptRequest({
    '输入内容要求': '去掉视频上的文字',
    '人设': '白衣古风女侠，黑色长发，高马尾',
    '生成方式': ['参考视频生成'], '视频时长': 5, '画面比例': ['9:16'],
  }, access, { referenceVideoDataUrl: 'data:video/mp4;base64,AAAA' });

  assert.equal(Array.isArray(request.messages[1].content), true);
  assert.deepEqual(request.messages[1].content[0], {
    type: 'video_url', video_url: { url: 'data:video/mp4;base64,AAAA' },
  });
  assert.match(request.messages[1].content[1].text, /必须且只能使用“视频生成选用”字段指定的视频模型/);
  assert.match(request.messages[1].content[1].text, /唯一人物形象来源/);
  assert.match(request.messages[1].content[1].text, /参考视频原人物仅用于提供动作、口型、走位和时间点/);
  assert.match(request.messages[1].content[1].text, /最终成片画布必须严格为 9:16 竖屏/);
  assert.match(request.messages[1].content[1].text, /禁止使用横版画布、横版容器、模糊复制侧边背景、镜像延展、左右补边、黑边、白边、画框、三联画/);
  assert.match(request.messages[1].content[1].text, /最终视频必须与参考视频时长一致，误差不得超过 1 秒/);
  assert.match(request.messages[1].content[1].text, /只能依据参考视频实际内容/);
  assert.match(request.messages[1].content[1].text, /对白、台词、旁白、原声、BGM、音效/);
  assert.match(request.messages[1].content[1].text, /第二段必须承接第一段之后的参考视频内容/);
  assert.match(request.messages[1].content[1].text, /参考视频优先级最高；补充提示词不得覆盖参考视频内容/);
  assert.match(request.messages[1].content[1].text, /唯一允许替换的是人物外观\/人设/);
  assert.match(request.messages[1].content[1].text, /镜头、动作、动作顺序、时间点、走位、姿态、道具、运镜、构图、景别、机位、场景、光线、色调、节奏和时长必须逐项复刻/);
  assert.match(request.messages[1].content[1].text, /白衣古风女侠/);
  assert.match(request.messages[1].content[1].text, /删除画面中的文字/);
  assert.match(request.messages[1].content[1].text, /去掉视频上的文字/);
});

test('reference-video prompt analysis can regenerate from reference video without text requirements', () => {
  const access = { ...videoAccess, protocol: 'chat-completions', modelId: 'kimi-k2.6' };
  const request = buildRelayPromptRequest({
    '输入内容要求': '',
    '人设': '白衣古风女侠',
    '生成方式': ['参考视频生成'], '视频时长': 5, '画面比例': ['9:16'],
  }, access, { referenceVideoDataUrl: 'data:video/mp4;base64,AAAA' });

  assert.match(request.messages[1].content[1].text, /按参考视频逐镜复刻/);
  assert.match(request.messages[1].content[1].text, /白衣古风女侠/);
});

test('reference-video prompt analysis can fall back to a source video URL', () => {
  const access = { ...videoAccess, protocol: 'chat-completions', modelId: 'kimi-k2.6' };
  const request = buildRelayPromptRequest({
    '输入内容要求': '',
    '生成方式': ['参考视频生成'],
    '参考视频链接': '抖音分享 [https://v.douyin.com/fxwMMjgLGMY/](https://v.douyin.com/fxwMMjgLGMY/) 复制链接',
  }, access, { referenceVideoUrl: 'https://v.douyin.com/fxwMMjgLGMY/' });

  assert.equal(request.messages[1].content[0].type, 'video_url');
  assert.equal(request.messages[1].content[0].video_url.url, 'https://v.douyin.com/fxwMMjgLGMY/');
  assert.match(request.messages[1].content[1].text, /直接读取参考视频链接完成分析/);
});

test('reference-video link prompt is generated without uploading a video file', () => {
  const prompt = buildRelayReferenceLinkPrompt({
    '输入内容要求': '',
    '人设': '白衣古风女侠',
    '视频时长': '',
    '参考视频链接': '抖音分享 [https://v.douyin.com/fxwMMjgLGMY/](https://v.douyin.com/fxwMMjgLGMY/) 复制链接',
  });

  assert.match(prompt, /参考视频链接：https:\/\/v\.douyin\.com\/fxwMMjgLGMY\//);
  assert.match(prompt, /白衣古风女侠/);
  assert.match(prompt, /唯一人物形象来源/);
  assert.match(prompt, /画布必须严格为 9:16/);
  assert.match(prompt, /生成前必须读取参考视频并检测其真实时长/);
  assert.match(prompt, /参考视频优先级最高；补充提示词不得覆盖参考视频内容/);
});

test('reference-video prompt analysis refuses to hallucinate without video data', () => {
  const access = { ...videoAccess, protocol: 'chat-completions', modelId: 'kimi-k2.6' };
  assert.throws(() => buildRelayPromptRequest({
    '输入内容要求': '去掉视频上的文字', '生成方式': ['参考视频生成'],
  }, access), (error) => error.code === 'CONFIG_REQUIRED' && /读取参考视频/.test(error.message));
});

test('video request supports all four generation modes', () => {
  const common = { '视频提示词': '镜头平稳推进', '画面比例': ['16:9'], '随机种子': 42 };
  const cases = [
    ['文生视频', {}, {}],
    ['图生视频', { '参考图片': [{ url: 'https://files/a.jpg' }] }, { image_url: 'https://files/a.jpg' }],
    ['首尾帧', {
      '参考图片': [{ url: 'https://files/first.jpg' }], '尾帧图片': [{ url: 'https://files/last.jpg' }],
    }, { first_frame_url: 'https://files/first.jpg', last_frame_url: 'https://files/last.jpg' }],
    ['参考视频生成', { '参考视频': [{ url: 'https://files/ref.mp4' }] }, { reference_video_url: 'https://files/ref.mp4' }],
    ['参考视频生成', { '参考视频链接': 'https://files/ref-link.mp4' }, { reference_video_url: 'https://files/ref-link.mp4' }],
    ['参考视频生成', {
      '参考视频链接': '抖音分享 [https://v.douyin.com/fxwMMjgLGMY/](https://v.douyin.com/fxwMMjgLGMY/) 复制链接',
    }, { reference_video_url: 'https://v.douyin.com/fxwMMjgLGMY/' }],
  ];
  for (const [method, fields, expected] of cases) {
    const request = buildRelayVideoRequest({ ...common, ...fields, '生成方式': [method] }, videoAccess);
    assert.equal(request.access, videoAccess);
    assert.equal(request.payload.aspect_ratio, method === '参考视频生成' ? '9:16' : '16:9');
    assert.equal(request.payload.seed, 42);
    assert.deepEqual(Object.fromEntries(Object.keys(expected).map((key) => [key, request.payload[key]])), expected);
  }
});

test('missing assets and capabilities are rejected before a paid submission', () => {
  assert.throws(
    () => buildRelayVideoRequest({ '生成方式': ['图生视频'], '视频提示词': '测试' }, videoAccess),
    (error) => error.code === 'CONFIG_REQUIRED' && /参考图片/.test(error.message),
  );
  assert.throws(
    () => buildRelayPromptRequest({ '输入内容要求': '测试' }, { ...videoAccess, protocol: 'videos' }),
    (error) => error.code === 'CAPABILITY_MISMATCH',
  );
});

test('video task inspection normalizes running, completed, and failed responses', () => {
  assert.deepEqual(inspectRelayVideoTask({ status: 'processing' }), { state: 'running', resultUrl: '', error: '' });
  assert.deepEqual(inspectRelayVideoTask({ data: { status: 'completed', output: { url: 'https://cdn/final.mp4' } } }), {
    state: 'completed', resultUrl: 'https://cdn/final.mp4', error: '',
  });
  assert.deepEqual(inspectRelayVideoTask({
    status: 'succeeded',
    content: [{ type: 'video_url', video_url: { url: 'https://cdn/final-from-content.mp4' } }],
  }), {
    state: 'completed', resultUrl: 'https://cdn/final-from-content.mp4', error: '',
  });
  assert.deepEqual(inspectRelayVideoTask({
    status: 'succeeded', content: { video_url: 'https://cdn/apimesh-result.mp4' },
  }), {
    state: 'completed', resultUrl: 'https://cdn/apimesh-result.mp4', error: '',
  });
  assert.deepEqual(inspectRelayVideoTask({ status: 'failed', error: { message: 'content rejected' } }), {
    state: 'failed', resultUrl: '', error: 'content rejected',
  });
});

test('start and failure patches snapshot models and reset trigger fields', () => {
  const start = buildRelayStartPatch({ phase: 'video', access: videoAccess, taskId: 'task-9', now: '2026-07-21 12:00:00' });
  assert.equal(start['生成状态'], '生成中');
  assert.equal(start['外部任务ID'], 'task-9');
  assert.equal(start['是否立刻生成视频'], '否');
  assert.equal(Object.hasOwn(start, '重试生成'), false);
  assert.equal(Object.hasOwn(start, '实际视频模型'), false);

  const configFailure = buildRelayFailurePatch(Object.assign(new Error('尚未导入本机密钥'), { code: 'CONFIG_REQUIRED' }));
  assert.equal(configFailure['生成状态'], '需要配置');
  assert.equal(Object.hasOwn(configFailure, '重试生成'), false);
  assert.match(configFailure['失败原因'], /本机密钥/);
  assert.equal(buildRelayFailurePatch(new Error('上游失败'))['生成状态'], '失败');

  const promptFailure = buildRelayFailurePatch(Object.assign(new Error('无法读取参考视频'), { code: 'CONFIG_REQUIRED' }), { phase: 'prompt' });
  assert.equal(promptFailure['生成状态'], '需要配置');
  assert.equal(promptFailure['生成视频提示词'], '否');
});

test('video provider duration limit errors are converted to actionable Chinese configuration failures', () => {
  const error = new Error('模型接口失败: The parameter `content[1]` specified in the request is not valid: the parameter video duration (seconds) specified in the request must be less than or equal to 15.2 for model doubao-seedance-2-0-mini in r2v.');
  const patch = buildRelayFailurePatch(error, { phase: 'video' });

  assert.equal(patch['生成状态'], '需要配置');
  assert.match(patch['失败原因'], /参考视频时长超过所选模型上限/);
  assert.match(patch['失败原因'], /15\.2 秒/);
  assert.match(patch['失败原因'], /doubao-seedance-2-0-mini/);
  assert.match(friendlyRelayErrorMessage(new Error('Invalid video_url. Request id: 123')), /参考视频链接不是模型可直接读取/);
});

test('video provider real-person safety errors ask for a compatible selected model', () => {
  const imagePatch = buildRelayFailurePatch(new Error('The request failed because the input image may contain real person.'));
  const videoPatch = buildRelayFailurePatch(new Error('The request failed because the input video may contain real person.'));
  const mixedPatch = buildRelayFailurePatch(new Error('first/last frame content cannot be mixed with reference media content.'));

  assert.equal(imagePatch['生成状态'], '需要配置');
  assert.match(imagePatch['失败原因'], /真人\/拟真人人设图片/);
  assert.match(imagePatch['失败原因'], /视频生成选用/);
  assert.equal(videoPatch['生成状态'], '需要配置');
  assert.match(videoPatch['失败原因'], /真人参考视频/);
  assert.equal(mixedPatch['生成状态'], '需要配置');
  assert.match(mixedPatch['失败原因'], /人设参考图与参考视频/);
});
