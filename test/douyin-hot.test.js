'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PROMPT_TARGET_DIRECTIONS,
  activeHotDirectionConfig,
  buildSmartFillRequest,
  buildHotTopicPromptRequest,
  buildPromptLibrarySyncPlan,
  buildSuggestedVideoPrompt,
  buildWeeklyCleanupPlan,
  currentWeekId,
  fetchDouyinHotList,
  parseHotTopicPromptAnalysis,
  parseSmartFillCandidates,
  parseDouyinHotList,
  promptLibraryContent,
  promptTargetDirection,
  scorePromptLibraryTopic,
  selectDirectionalTopics,
  selectSmartFillCandidates,
  selectSmartFillFallback,
  targetDirectionInstruction,
} = require('../src/douyin-hot');

const samplePayload = {
  data: {
    active_time: '2026-07-29 22:17:27',
    word_list: [
      {
        sentence_id: '2589763',
        group_id: '7669000000000000001',
        word: '赵心童6:2战胜丁俊晖晋级八强',
        hot_value: 11668969,
        event_time: 1785657600,
        video_count: 6,
        view_count: 61384093,
        word_cover: { url_list: ['https://example.com/billiards.jpg'] },
      },
      { sentence_id: 'ad-1', word: '广告话题', hot_value: 99999999, ad_data: '{}' },
      { sentence_id: '2589592', word: '感受下昆明小炒的滇味暴击', hot_value: 11177865 },
    ],
  },
};

test('parseDouyinHotList converts the public hot list into prompt-library topics and skips ads', () => {
  const topics = parseDouyinHotList(samplePayload, { limit: 10 });

  assert.equal(topics.length, 2);
  const firstScores = scorePromptLibraryTopic({
    title: '赵心童6:2战胜丁俊晖晋级八强',
    rank: 1,
    hotValue: 11668969,
  });
  assert.deepEqual(topics[0], {
    topicId: '2589763',
    videoId: '7669000000000000001',
    title: '赵心童6:2战胜丁俊晖晋级八强',
    rank: 1,
    hotValue: 11668969,
    viewCount: 61384093,
    relatedVideoCount: 6,
    topicUrl: 'https://www.douyin.com/search/%E8%B5%B5%E5%BF%83%E7%AB%A56%3A2%E6%88%98%E8%83%9C%E4%B8%81%E4%BF%8A%E6%99%96%E6%99%8B%E7%BA%A7%E5%85%AB%E5%BC%BA',
    videoUrl: 'https://www.douyin.com/video/7669000000000000001',
    coverUrl: 'https://example.com/billiards.jpg',
    publishedAt: '2026-08-02 16:00:00',
    suggestion: buildSuggestedVideoPrompt('赵心童6:2战胜丁俊晖晋级八强'),
    capturedAt: '2026-07-29 22:17:27',
    ...firstScores,
  });
  assert.equal(topics[1].rank, 2);
  assert.match(topics[0].suggestion, /只使用可核实内容/);
});

test('active direction configuration remains single-target and parses configurable topic keywords', () => {
  const config = activeHotDirectionConfig([
    {
      record_id: 'rec-disabled',
      '配置名称': '旧方向',
      '目标方向': ['账号涨粉'],
      '热点题材': '泛娱乐',
      '是否启用': ['否'],
    },
    {
      record_id: 'rec-active',
      '配置名称': '传统武术复刻',
      '目标方向': ['复刻生产'],
      '热点题材': '传统国风舞剑/武术',
      '包含关键词': '舞剑、武术、剑术、功夫、汉服、武侠',
      '排除关键词': '游戏, 手游',
      '每日热点数量': 8,
      '最低方向匹配分': 60,
      '补足策略': ['智能补足'],
      '智能补足最低分': 68,
      '立即刷新热点': ['是'],
      '是否启用': ['是'],
    },
  ]);

  assert.deepEqual(config, {
    recordId: 'rec-active',
    name: '传统武术复刻',
    targetDirection: '复刻生产',
    topicDirection: '传统国风舞剑/武术',
    includeKeywords: ['舞剑', '武术', '剑术', '功夫', '汉服', '武侠'],
    excludeKeywords: ['游戏', '手游'],
    dailyLimit: 8,
    minimumDirectionScore: 60,
    supplementStrategy: '智能补足',
    smartFillMinimumScore: 68,
    refreshRequested: true,
  });
});

test('directional selection keeps relevant martial-arts hotspots and writes auditable scores', () => {
  const config = activeHotDirectionConfig([{
    '配置名称': '传统武术复刻',
    '目标方向': ['复刻生产'],
    '热点题材': '传统国风舞剑/武术',
    '包含关键词': '舞剑、武术、剑术、功夫、汉服、武侠',
    '排除关键词': '游戏、手游',
    '每日热点数量': 5,
    '最低方向匹配分': 60,
    '是否启用': ['是'],
  }]);
  const topics = [
    {
      topicId: 'martial-1',
      title: '汉服少女雨中舞剑',
      rank: 18,
      hotValue: 3_000_000,
      publishedAt: '2026-08-03 07:30:00',
      remakeScore: 92,
    },
    {
      topicId: 'sports-1',
      title: '足球联赛最新赛果',
      rank: 1,
      hotValue: 12_000_000,
      publishedAt: '2026-08-03 07:30:00',
      remakeScore: 42,
    },
    {
      topicId: 'game-1',
      title: '武侠手游新版本',
      rank: 2,
      hotValue: 10_000_000,
      publishedAt: '2026-08-03 07:30:00',
      remakeScore: 80,
    },
  ];

  const selected = selectDirectionalTopics(topics, config, {
    now: new Date('2026-08-03T00:00:00.000Z'),
  });

  assert.equal(selected.length, 1);
  assert.equal(selected[0].topicId, 'martial-1');
  assert.equal(selected[0].topicDirection, '传统国风舞剑/武术');
  assert.equal(selected[0].targetDirection, '复刻生产');
  assert.ok(selected[0].directionMatchScore >= 60);
  assert.ok(selected[0].priorityScore >= 60);
});

test('smart fill asks the model to select only safe, directionally adaptable candidates and caps the batch', () => {
  const config = activeHotDirectionConfig([{
    '配置名称': '传统武术复刻',
    '目标方向': ['复刻生产'],
    '热点题材': '传统国风舞剑/武术',
    '包含关键词': '舞剑、武术',
    '每日热点数量': 3,
    '最低方向匹配分': 60,
    '补足策略': ['智能补足'],
    '智能补足最低分': 65,
    '是否启用': ['是'],
  }]);
  const strict = [{ topicId: 'strict-1', title: '汉服舞剑挑战', rank: 10 }];
  const candidates = selectSmartFillCandidates([
    ...strict,
    { topicId: 'fill-1', title: '抖音作者上手揭秘天下第一刀', rank: 3, hotValue: 8_000_000, remakeScore: 75 },
    { topicId: 'fill-2', title: '舞台惊艳亮相全场欢呼', rank: 7, hotValue: 6_000_000, remakeScore: 70 },
    { topicId: 'unsafe', title: '官方通报地震救援进展', rank: 1, hotValue: 12_000_000, remakeScore: 40 },
  ], strict, config, { now: new Date('2026-08-03T00:00:00.000Z') });

  assert.deepEqual(candidates.map((topic) => topic.topicId), ['fill-1', 'fill-2']);
  const request = buildSmartFillRequest(candidates, config, { limit: 2 });
  assert.match(request.messages[1].content, /天下第一刀/);
  assert.doesNotMatch(request.messages[1].content, /地震救援/);

  const selected = parseSmartFillCandidates(JSON.stringify({
    items: [
      { topicId: 'fill-1', semanticScore: 86, reproducibilityScore: 84, reason: '兵器展示和亮相结构可转为国风武术短片。' },
      { topicId: 'fill-2', semanticScore: 54, reproducibilityScore: 72, reason: '相关性偏弱。' },
    ],
  }), candidates, config, { now: new Date('2026-08-03T00:00:00.000Z'), limit: 2 });

  assert.equal(selected.length, 1);
  assert.equal(selected[0].topicId, 'fill-1');
  assert.equal(selected[0].matchMethod, '智能补足');
  assert.equal(selected[0].directionMatchScore, 86);
  assert.match(selected[0].smartFillReason, /兵器展示/);

  const fallback = selectSmartFillFallback(candidates, config, {
    now: new Date('2026-08-03T00:00:00.000Z'),
    limit: 2,
  });
  assert.equal(fallback.length, 1);
  assert.equal(fallback[0].matchMethod, '智能补足');
  assert.match(fallback[0].smartFillReason, /刀剑、武术/);
});

test('weekly cleanup deletes only old Douyin hotspots and preserves current-week and manual prompts', () => {
  const now = new Date('2026-08-03T00:30:00.000Z');
  assert.equal(currentWeekId(now), '2026-W32');
  const deletionIds = buildWeeklyCleanupPlan([
    {
      record_id: 'rec-old',
      '来源平台': ['抖音热榜'],
      '所属周期': '2026-W31',
      '抓取时间': '2026-08-02 12:00:00',
    },
    {
      record_id: 'rec-current',
      '来源平台': ['抖音热榜'],
      '所属周期': '2026-W32',
      '抓取时间': '2026-08-03 08:10:00',
    },
    {
      record_id: 'rec-manual',
      '来源平台': ['手工录入'],
      '所属周期': '2026-W31',
      '抓取时间': '2026-07-30 10:00:00',
    },
  ], { now });

  assert.deepEqual(deletionIds, ['rec-old']);
});

test('hotspot prompt analysis is grounded in the selected topic, direction, cover and metadata', () => {
  const config = activeHotDirectionConfig([{
    '配置名称': '传统武术复刻',
    '目标方向': ['复刻生产'],
    '热点题材': '传统国风舞剑/武术',
    '包含关键词': '舞剑、武术',
    '每日热点数量': 5,
    '最低方向匹配分': 60,
    '是否启用': ['是'],
  }]);
  const topic = {
    topicId: 'martial-1',
    videoId: '7669000000000000002',
    title: '汉服少女雨中舞剑',
    coverUrl: 'https://example.com/sword.jpg',
    hotValue: 8_000_000,
    viewCount: 30_000_000,
    rank: 5,
    topicDirection: config.topicDirection,
    directionMatchScore: 95,
    reproducibilityScore: 92,
  };
  const request = buildHotTopicPromptRequest(topic, config);
  const userContent = request.messages[1].content;

  assert.equal(Array.isArray(userContent), true);
  assert.match(userContent[0].text, /汉服少女雨中舞剑/);
  assert.match(userContent[0].text, /传统国风舞剑\/武术/);
  assert.equal(userContent[1].image_url.url, 'https://example.com/sword.jpg');

  const analysis = parseHotTopicPromptAnalysis(JSON.stringify({
    summary: '汉服人物在雨景中完成连续舞剑动作。',
    shotAnalysis: '中景起势，侧向跟拍，近景收剑。',
    prompt: '9:16 雨中古风庭院，汉服女侠依次起势、旋身、刺剑、收剑，侧向稳定跟拍。',
    relevanceScore: 96,
  }), topic, config);
  assert.equal(analysis.relevanceScore, 96);
  assert.match(analysis.prompt, /起势、旋身、刺剑、收剑/);
});

test('fetchDouyinHotList sends browser headers and rejects empty upstream data', async () => {
  let request;
  const topics = await fetchDouyinHotList({
    limit: 1,
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { ok: true, json: async () => samplePayload };
    },
  });

  assert.equal(topics.length, 1);
  assert.match(request.url, /so-landing\.douyin\.com\/aweme\/v1\/hot\/search\/list/);
  assert.match(request.options.headers.Referer, /landings\/hotlist/);

  await assert.rejects(
    fetchDouyinHotList({
      fetchImpl: async () => ({ ok: true, json: async () => ({ data: { word_list: [] } }) }),
    }),
    /没有返回可用话题/,
  );
});

test('buildPromptLibrarySyncPlan updates existing topics and creates new topics without duplicates', () => {
  const topics = parseDouyinHotList(samplePayload);
  const plan = buildPromptLibrarySyncPlan([
    { record_id: 'rec-existing', '热榜ID': '2589763', '热点标题': '旧标题', '来源平台': ['抖音热榜'] },
  ], topics, { syncedAt: '2026-07-29 22:18:00' });

  assert.equal(plan.updates.length, 1);
  assert.equal(plan.updates[0].recordId, 'rec-existing');
  assert.equal(plan.updates[0].patch['热点标题'], '赵心童6:2战胜丁俊晖晋级八强');
  assert.equal(plan.creates.length, 1);
  assert.equal(plan.creates[0]['热点标题'], '感受下昆明小炒的滇味暴击');
  assert.equal(plan.creates[0]['来源平台'], '抖音热榜');
  assert.equal(plan.creates[0]['是否启用'], '是');
  assert.equal(plan.creates[0]['系统推荐方向'], '电商成交');
  assert.equal(typeof plan.creates[0]['成交适配分'], 'number');
});

test('sync planning does not overwrite a manually maintained prompt with the same title', () => {
  const topic = parseDouyinHotList(samplePayload, { limit: 1 })[0];
  const plan = buildPromptLibrarySyncPlan([{
    record_id: 'rec-manual',
    '热点标题': topic.title,
    '来源平台': ['手工录入'],
    '建议提示词': '人工维护的专用提示词',
  }], [topic]);

  assert.equal(plan.updates.length, 0);
  assert.equal(plan.creates.length, 1);
});

test('sync planning backfills scores for historical Douyin topics but preserves scored and manual rows', () => {
  const plan = buildPromptLibrarySyncPlan([
    {
      record_id: 'rec-history-missing',
      '热点标题': '历史国风舞蹈挑战',
      '来源平台': ['抖音热榜'],
      '热榜排名': 18,
      '热度值': 3_000_000,
    },
    {
      record_id: 'rec-history-scored',
      '热点标题': '已评分历史热点',
      '来源平台': ['抖音热榜'],
      '成交适配分': 30,
      '涨粉适配分': 80,
      '复刻适配分': 60,
      '系统推荐方向': ['账号涨粉'],
      '推荐理由': '保留现有评分',
    },
    {
      record_id: 'rec-manual',
      '热点标题': '手工提示词',
      '来源平台': ['手工录入'],
    },
  ], []);

  assert.equal(plan.updates.length, 1);
  assert.equal(plan.updates[0].recordId, 'rec-history-missing');
  assert.equal(plan.updates[0].patch['系统推荐方向'], '复刻生产');
  assert.equal(plan.updates[0].patch['推荐理由'].includes('复刻生产得分最高'), true);
});

test('promptLibraryContent prefers the reusable suggestion and falls back to the topic title', () => {
  assert.equal(promptLibraryContent({ '建议提示词': '重点展示城市烟火气' }), '重点展示城市烟火气');
  assert.equal(promptLibraryContent({ '热点标题': '昆明小炒' }), '昆明小炒');
});

test('topic scoring recommends one of the three target directions from independent scores', () => {
  const commerce = scorePromptLibraryTopic({ title: '感受下昆明小炒的滇味暴击', rank: 20, hotValue: 2_000_000 });
  const growth = scorePromptLibraryTopic({ title: '冠军回应决赛名场面', rank: 1, hotValue: 12_000_000 });
  const remake = scorePromptLibraryTopic({ title: '国风舞蹈运镜挑战', rank: 20, hotValue: 2_000_000 });

  assert.deepEqual(PROMPT_TARGET_DIRECTIONS, ['电商成交', '账号涨粉', '复刻生产']);
  assert.equal(commerce.recommendedDirection, '电商成交');
  assert.equal(growth.recommendedDirection, '账号涨粉');
  assert.equal(remake.recommendedDirection, '复刻生产');
  assert.match(commerce.recommendationReason, /成交\d+／涨粉\d+／复刻\d+/);
});

test('a manually selected single target overrides the library recommendation', () => {
  assert.equal(promptTargetDirection({
    '目标方向': ['电商成交'],
    '提示词库推荐方向': '账号涨粉',
  }), '电商成交');
  assert.equal(promptTargetDirection({
    '目标方向': [],
    '提示词库推荐方向': '复刻生产',
  }), '复刻生产');
  assert.match(targetDirectionInstruction('复刻生产'), /时间顺序/);
  assert.equal(targetDirectionInstruction(['电商成交', '账号涨粉']), '');
});
