'use strict';

const DOUYIN_HOT_PAGE_URL = 'https://so-landing.douyin.com/landings/hotlist?app_theme=light&board_type=0&enter_method=hot_mini_view&is_no_width_reload=0&pd=general';
const DOUYIN_HOT_LIST_URL = 'https://so-landing.douyin.com/aweme/v1/hot/search/list/?detail_list=1&board_type=0&board_sub_type=&need_board_tab=true&need_covid_tab=false&aid=581610&version_code=32.3.0';
const PROMPT_TARGET_DIRECTIONS = Object.freeze(['电商成交', '账号涨粉', '复刻生产']);
const SMART_FILL_STRATEGIES = Object.freeze(['严格匹配', '智能补足']);
const DEFAULT_HOT_DIRECTION_CONFIG = Object.freeze({
  recordId: '',
  name: '传统武术复刻',
  targetDirection: '复刻生产',
  topicDirection: '传统国风舞剑/武术',
  includeKeywords: Object.freeze([
    '舞剑', '武术', '剑术', '功夫', '国风', '传统文化', '汉服', '武侠',
    '太极', '少林', '刀术', '枪术', '身法',
  ]),
  excludeKeywords: Object.freeze(['游戏', '手游']),
  dailyLimit: 10,
  minimumDirectionScore: 60,
  supplementStrategy: '严格匹配',
  smartFillMinimumScore: 65,
  refreshRequested: false,
});

const COMMERCE_KEYWORDS = /美食|小炒|探店|穿搭|好物|测评|开箱|手机|家电|汽车|旅行|护肤|美妆|家居|商品|新品|价格|体验|教程|做法|同款/u;
const GROWTH_KEYWORDS = /热议|回应|官宣|晋级|夺冠|名场面|挑战|反转|首秀|开播|夏日|情绪|故事|为什么|怎么|现场/u;
const REMAKE_KEYWORDS = /舞蹈|舞剑|武术|剑术|功夫|国风|传统文化|汉服|武侠|太极|少林|刀术|枪术|身法|变装|挑战|名场面|小炒|美食|风景|夏日|现场|开箱|教程|动作|运镜|穿搭|演绎/u;
const SENSITIVE_NEWS_KEYWORDS = /政策|会议|地震|洪水|坍塌|事故|辟谣|警方|法院|外交|战争|疾病|去世|逝世/u;
const SMART_FILL_VISUAL_KEYWORDS = /刀|剑|武|功夫|古装|兵器|太极|少林|国风|汉服|武打|格斗|搏击|动作戏/u;

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function buildDouyinTopicUrl(title) {
  return `https://www.douyin.com/search/${encodeURIComponent(cleanText(title))}`;
}

function buildDouyinVideoUrl(videoId, title = '') {
  const id = cleanText(videoId);
  return id ? `https://www.douyin.com/video/${encodeURIComponent(id)}` : buildDouyinTopicUrl(title);
}

function firstOption(value) {
  if (Array.isArray(value)) {
    const first = value[0];
    return cleanText(typeof first === 'string' ? first : first?.name);
  }
  return cleanText(value);
}

function parseKeywordList(value) {
  return [...new Set(String(value || '')
    .split(/[\s,，、;；/|]+/u)
    .map(cleanText)
    .filter(Boolean))];
}

function activeHotDirectionConfig(rows = [], defaults = DEFAULT_HOT_DIRECTION_CONFIG) {
  const row = rows.find((candidate) => firstOption(candidate?.['是否启用']) === '是');
  if (!row) {
    return {
      ...defaults,
      includeKeywords: [...defaults.includeKeywords],
      excludeKeywords: [...defaults.excludeKeywords],
    };
  }
  const targetDirection = firstOption(row['目标方向']);
  const selectedStrategy = firstOption(row['补足策略']);
  const supplementStrategy = SMART_FILL_STRATEGIES.includes(selectedStrategy)
    ? selectedStrategy
    : defaults.supplementStrategy;
  return {
    recordId: row.record_id || '',
    name: cleanText(row['配置名称']) || defaults.name,
    targetDirection: PROMPT_TARGET_DIRECTIONS.includes(targetDirection)
      ? targetDirection
      : defaults.targetDirection,
    topicDirection: cleanText(row['热点题材']) || defaults.topicDirection,
    includeKeywords: parseKeywordList(row['包含关键词']).length
      ? parseKeywordList(row['包含关键词'])
      : [...defaults.includeKeywords],
    excludeKeywords: parseKeywordList(row['排除关键词']),
    dailyLimit: Math.max(1, Math.min(50, Math.round(Number(row['每日热点数量']) || defaults.dailyLimit))),
    minimumDirectionScore: clampScore(
      row['最低方向匹配分'] === null || row['最低方向匹配分'] === undefined
        ? defaults.minimumDirectionScore
        : row['最低方向匹配分'],
    ),
    supplementStrategy,
    smartFillMinimumScore: clampScore(
      row['智能补足最低分'] === null || row['智能补足最低分'] === undefined
        ? defaults.smartFillMinimumScore
        : row['智能补足最低分'],
    ),
    refreshRequested: firstOption(row['立即刷新热点']) === '是',
  };
}

function formatFeishuDateTime(date, timeZoneOffsetMinutes = 480) {
  const shifted = new Date(date.getTime() + timeZoneOffsetMinutes * 60_000);
  return shifted.toISOString().slice(0, 19).replace('T', ' ');
}

function currentWeekId(now = new Date(), timeZoneOffsetMinutes = 480) {
  const shifted = new Date(now.getTime() + timeZoneOffsetMinutes * 60_000);
  const date = new Date(Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate(),
  ));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((date - yearStart) / 86_400_000) + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function parseFeishuDateTime(value, timeZoneOffsetMinutes = 480) {
  const text = cleanText(value);
  if (!text) return null;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?$/.test(text)
    ? `${text.replace(' ', 'T')}${text.length === 16 ? ':00' : ''}${timeZoneOffsetMinutes === 480 ? '+08:00' : 'Z'}`
    : text;
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? new Date(timestamp) : null;
}

function buildSuggestedVideoPrompt(title, {
  topicDirection = '',
  targetDirection = '',
  summary = '',
  shotAnalysis = '',
} = {}) {
  const topic = cleanText(title);
  return [
    `以抖音热榜话题“${topic}”为选题，创作一条 9:16 竖屏短视频。`,
    topicDirection ? `内容题材必须围绕“${cleanText(topicDirection)}”，同时保留与热点话题的直接关联。` : '',
    targetDirection ? `唯一运营目标为“${cleanText(targetDirection)}”。` : '',
    summary ? `热点内容依据：${cleanText(summary)}` : '',
    shotAnalysis ? `动作与镜头依据：${cleanText(shotAnalysis)}` : '',
    '前 3 秒用与话题直接相关的画面或问题建立钩子，中段围绕一个清晰角度展开，结尾用自然问题引导互动。',
    '明确主体、场景、服装、道具、动作顺序、机位、景别、运镜、节奏、光线、画面比例、音效和建议时长。',
    '禁止加入与热点或所选题材无关的人物、商品、场景和情节；信息不足时保持克制，不虚构视频中未出现的事实。',
    '涉及新闻、人物、赛事、政策、健康或消费信息时只使用可核实内容，不虚构事实、结论、价格、功效或当事人言论。',
  ].filter(Boolean).join('');
}

function clampScore(value) {
  return Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
}

function scorePromptLibraryTopic({ title = '', rank = 0, hotValue = 0 } = {}) {
  const topic = cleanText(title);
  const commerceMatched = COMMERCE_KEYWORDS.test(topic);
  const growthMatched = GROWTH_KEYWORDS.test(topic);
  const remakeMatched = REMAKE_KEYWORDS.test(topic);
  const sensitiveNews = SENSITIVE_NEWS_KEYWORDS.test(topic);
  const normalizedRank = Math.max(1, Number(rank) || 50);
  const heatBonus = Number(hotValue) >= 10_000_000 ? 8 : Number(hotValue) >= 5_000_000 ? 4 : 0;

  const commerceScore = clampScore(38
    + (commerceMatched ? 49 : 0)
    + (remakeMatched ? 8 : 0)
    - (sensitiveNews ? 28 : 0));
  const growthScore = clampScore(88
    - Math.min(38, (normalizedRank - 1) * 2)
    + heatBonus
    + (growthMatched ? 8 : 0));
  const remakeScore = clampScore(42
    + (remakeMatched ? 50 : 0)
    - (sensitiveNews ? 16 : 0));

  const scores = {
    '电商成交': commerceScore,
    '账号涨粉': growthScore,
    '复刻生产': remakeScore,
  };
  const recommendedDirection = PROMPT_TARGET_DIRECTIONS
    .reduce((best, direction) => (scores[direction] > scores[best] ? direction : best), '账号涨粉');
  const signals = [
    commerceMatched ? '具备商品或消费场景' : '',
    growthMatched ? '具备传播钩子' : '',
    remakeMatched ? '具备可视化复刻元素' : '',
    sensitiveNews ? '涉及敏感新闻，需降低商业植入和改编强度' : '',
  ].filter(Boolean);
  const reason = [
    `${recommendedDirection}得分最高`,
    `成交${commerceScore}／涨粉${growthScore}／复刻${remakeScore}`,
    signals.length ? signals.join('；') : '主要依据热榜排名和热度推荐',
  ].join('；');

  return {
    commerceScore,
    growthScore,
    remakeScore,
    recommendedDirection,
    recommendationReason: reason,
  };
}

function targetDirectionInstruction(value) {
  const direction = PROMPT_TARGET_DIRECTIONS.includes(cleanText(value)) ? cleanText(value) : '';
  const instructions = {
    '电商成交': '目标是电商成交：自然植入商品使用场景，突出一个可验证卖点和使用收益，镜头优先展示商品、使用动作与结果；结尾给出自然行动引导，不得虚构价格、优惠、库存、功效或用户反馈。',
    '账号涨粉': '目标是账号涨粉：前 3 秒强化信息差、情绪或反差钩子，中段只讲一个清晰观点或故事，结尾设置易回答的互动问题；弱化硬广感，强化账号人设和持续关注理由。',
    '复刻生产': '目标是复刻生产：按时间顺序明确主体、场景、动作、机位、景别、运镜、节奏、转场和时长，优先保证可重复执行与镜头连续性；不得用“自由发挥”“类似”或“大致”等模糊表述。',
  };
  return instructions[direction] || '';
}

function promptTargetDirection(row = {}) {
  const option = (value) => {
    if (Array.isArray(value)) {
      const first = value[0];
      return cleanText(typeof first === 'string' ? first : first?.name);
    }
    return cleanText(value);
  };
  const selected = option(row['目标方向']);
  if (PROMPT_TARGET_DIRECTIONS.includes(selected)) return selected;
  const recommended = option(row['提示词库推荐方向'] || row['系统推荐方向']);
  return PROMPT_TARGET_DIRECTIONS.includes(recommended) ? recommended : '';
}

function parseDouyinHotList(payload = {}, { limit = 20 } = {}) {
  const rows = Array.isArray(payload?.data?.word_list) ? payload.data.word_list : [];
  const capturedAt = cleanText(payload?.data?.active_time);
  return rows
    .filter((row) => cleanText(row?.word) && !row?.ad_data)
    .slice(0, Math.max(0, Number(limit) || 0))
    .map((row, index) => {
      const title = cleanText(row.word);
      const rank = index + 1;
      const hotValue = Math.max(0, Number(row.hot_value) || 0);
      const videoId = cleanText(row.group_id);
      const publishedAt = Number(row.event_time) > 0
        ? formatFeishuDateTime(new Date(Number(row.event_time) * 1000))
        : '';
      return {
        topicId: cleanText(row.sentence_id) || `title:${title}`,
        videoId,
        title,
        rank,
        hotValue,
        viewCount: Math.max(0, Number(row.view_count) || 0),
        relatedVideoCount: Math.max(0, Number(row.video_count || row.discuss_video_count) || 0),
        topicUrl: buildDouyinTopicUrl(title),
        videoUrl: buildDouyinVideoUrl(videoId, title),
        coverUrl: cleanText(row?.word_cover?.url_list?.[0]),
        publishedAt,
        suggestion: buildSuggestedVideoPrompt(title),
        capturedAt,
        ...scorePromptLibraryTopic({ title, rank, hotValue }),
      };
    });
}

async function fetchDouyinHotList({
  fetchImpl = fetch,
  limit = 20,
  timeoutMs = 15_000,
} = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(DOUYIN_HOT_LIST_URL, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        Referer: DOUYIN_HOT_PAGE_URL,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/138.0 Safari/537.36',
      },
    });
    if (!response.ok) throw new Error(`抖音热榜请求失败（HTTP ${response.status}）`);
    const payload = await response.json().catch(() => null);
    if (!payload || typeof payload !== 'object') throw new Error('抖音热榜返回了无法解析的数据');
    const topics = parseDouyinHotList(payload, { limit });
    if (!topics.length) throw new Error('抖音热榜没有返回可用话题');
    return topics;
  } finally {
    clearTimeout(timeout);
  }
}

function scoreDirectionalTopic(topic = {}, config = DEFAULT_HOT_DIRECTION_CONFIG, {
  now = new Date(),
} = {}) {
  const searchable = cleanText([
    topic.title,
    topic.summary,
    topic.description,
  ].filter(Boolean).join(' ')).toLowerCase();
  const excluded = config.excludeKeywords.some((keyword) => searchable.includes(keyword.toLowerCase()));
  const sensitiveNews = SENSITIVE_NEWS_KEYWORDS.test(searchable);
  const matchedKeywords = config.includeKeywords
    .filter((keyword) => searchable.includes(keyword.toLowerCase()));
  const directionMatchScore = excluded
    ? 0
    : matchedKeywords.length
      ? clampScore(72 + Math.min(28, (matchedKeywords.length - 1) * 10))
      : 0;
  const rank = Math.max(1, Number(topic.rank) || 50);
  const rankScore = clampScore(102 - rank * 2);
  const heatScore = clampScore(rankScore
    + (Number(topic.hotValue) >= 10_000_000 ? 12 : Number(topic.hotValue) >= 5_000_000 ? 6 : 0));
  const reproducibilityScore = clampScore(Math.max(
    Number(topic.remakeScore) || 0,
    matchedKeywords.length ? 88 : 0,
  ));
  const published = parseFeishuDateTime(topic.publishedAt);
  const ageHours = published ? Math.max(0, (now.getTime() - published.getTime()) / 3_600_000) : null;
  const freshnessScore = ageHours === null ? 50 : ageHours <= 24 ? 100 : ageHours <= 72 ? 75 : 40;
  const priorityScore = clampScore(
    directionMatchScore * 0.5
    + heatScore * 0.25
    + reproducibilityScore * 0.2
    + freshnessScore * 0.05,
  );
  return {
    ...topic,
    targetDirection: config.targetDirection,
    topicDirection: config.topicDirection,
    matchedKeywords,
    excluded,
    sensitiveNews,
    directionMatchScore,
    heatScore,
    reproducibilityScore,
    freshnessScore,
    priorityScore,
  };
}

function selectDirectionalTopics(topics = [], config = DEFAULT_HOT_DIRECTION_CONFIG, options = {}) {
  return topics
    .map((topic) => scoreDirectionalTopic(topic, config, options))
    .filter((topic) => topic.directionMatchScore >= config.minimumDirectionScore)
    .map((topic) => ({ ...topic, matchMethod: '严格匹配' }))
    .sort((left, right) => right.priorityScore - left.priorityScore
      || left.rank - right.rank
      || left.topicId.localeCompare(right.topicId))
    .slice(0, config.dailyLimit);
}

function selectSmartFillCandidates(topics = [], strictTopics = [], config = DEFAULT_HOT_DIRECTION_CONFIG, options = {}) {
  const strictIds = new Set(strictTopics.map((topic) => topic.topicId));
  const remaining = Math.max(0, config.dailyLimit - strictIds.size);
  if (!remaining || config.supplementStrategy !== '智能补足') return [];
  return topics
    .filter((topic) => !strictIds.has(topic.topicId))
    .map((topic) => scoreDirectionalTopic(topic, config, options))
    .filter((topic) => !topic.excluded && !topic.sensitiveNews)
    .sort((left, right) => right.heatScore - left.heatScore
      || right.reproducibilityScore - left.reproducibilityScore
      || left.rank - right.rank)
    .slice(0, Math.min(30, Math.max(remaining * 4, 12)));
}

function buildSmartFillRequest(candidates = [], config = DEFAULT_HOT_DIRECTION_CONFIG, { limit } = {}) {
  const desiredCount = Math.max(0, Math.min(
    Number.isFinite(Number(limit)) ? Number(limit) : config.dailyLimit,
    candidates.length,
  ));
  const metadata = candidates.map((topic) => ({
    topicId: topic.topicId,
    标题: topic.title,
    排名: topic.rank,
    热度: topic.hotValue,
    浏览量: topic.viewCount || 0,
    可复刻分: topic.reproducibilityScore || topic.remakeScore || 0,
  }));
  return {
    messages: [
      {
        role: 'system',
        content: '你是短视频热点筛选编辑。只能从给出的候选中选择；不能选择新闻、事故、政策、灾害、政治或敏感事件；不得编造视频内容。只输出合法 JSON。',
      },
      {
        role: 'user',
        content: [
          `当前目标方向：${config.targetDirection}`,
          `当前热点题材：${config.topicDirection}`,
          `请最多选择 ${desiredCount} 条可自然改编为该题材、且仍保留原标题传播钩子的热点。`,
          `候选：${JSON.stringify(metadata)}`,
          '只返回 {"items":[{"topicId":"","semanticScore":0,"reproducibilityScore":0,"reason":""}]}。semanticScore 是题材语义相关性，0-100；低于阈值的候选不要返回。',
        ].join('\n'),
      },
    ],
    temperature: 0.1,
  };
}

function parseSmartFillCandidates(raw, candidates = [], config = DEFAULT_HOT_DIRECTION_CONFIG, {
  now = new Date(),
  limit,
} = {}) {
  const text = cleanText(raw);
  let parsed = {};
  try {
    parsed = JSON.parse(text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, ''));
  } catch {}
  const items = Array.isArray(parsed) ? parsed : Array.isArray(parsed.items) ? parsed.items : [];
  const candidateById = new Map(candidates.map((topic) => [topic.topicId, topic]));
  const maxCount = Math.max(0, Math.min(
    Number.isFinite(Number(limit)) ? Number(limit) : config.dailyLimit,
    candidates.length,
  ));
  const seen = new Set();
  return items
    .map((item) => {
      const topicId = cleanText(item?.topicId);
      const candidate = candidateById.get(topicId);
      const semanticScore = clampScore(item?.semanticScore);
      if (!candidate || seen.has(topicId) || semanticScore < config.smartFillMinimumScore) return null;
      seen.add(topicId);
      const scored = scoreDirectionalTopic(candidate, config, { now });
      if (scored.excluded || scored.sensitiveNews) return null;
      const reproducibilityScore = clampScore(Math.max(
        scored.reproducibilityScore,
        Number(item?.reproducibilityScore) || 0,
      ));
      const priorityScore = clampScore(
        semanticScore * 0.5
        + scored.heatScore * 0.25
        + reproducibilityScore * 0.2
        + scored.freshnessScore * 0.05,
      );
      return {
        ...scored,
        directionMatchScore: semanticScore,
        reproducibilityScore,
        priorityScore,
        matchedKeywords: ['智能补足'],
        matchMethod: '智能补足',
        smartFillReason: cleanText(item?.reason) || '模型判断该热点可自然改编为当前题材。',
      };
    })
    .filter(Boolean)
    .sort((left, right) => right.priorityScore - left.priorityScore || left.rank - right.rank)
    .slice(0, maxCount);
}

function selectSmartFillFallback(candidates = [], config = DEFAULT_HOT_DIRECTION_CONFIG, {
  now = new Date(),
  limit,
} = {}) {
  const maxCount = Math.max(0, Math.min(
    Number.isFinite(Number(limit)) ? Number(limit) : config.dailyLimit,
    candidates.length,
  ));
  return candidates
    .map((candidate) => scoreDirectionalTopic(candidate, config, { now }))
    .filter((topic) => !topic.excluded && !topic.sensitiveNews && SMART_FILL_VISUAL_KEYWORDS.test(topic.title))
    .map((topic) => {
      const directionMatchScore = 78;
      const reproducibilityScore = clampScore(Math.max(topic.reproducibilityScore, 78));
      return {
        ...topic,
        directionMatchScore,
        reproducibilityScore,
        priorityScore: clampScore(
          directionMatchScore * 0.5
          + topic.heatScore * 0.25
          + reproducibilityScore * 0.2
          + topic.freshnessScore * 0.05,
        ),
        matchedKeywords: ['智能补足'],
        matchMethod: '智能补足',
        smartFillReason: '模型暂不可用，按刀剑、武术、功夫、古装、兵器等强相关信号补足；建议结合封面复核。',
      };
    })
    .sort((left, right) => right.priorityScore - left.priorityScore || left.rank - right.rank)
    .slice(0, maxCount);
}

function buildHotTopicPromptRequest(topic = {}, config = DEFAULT_HOT_DIRECTION_CONFIG) {
  const metadata = {
    热点ID: topic.topicId,
    热点视频ID: topic.videoId || '',
    热点标题: topic.title,
    热榜排名: topic.rank,
    热度值: topic.hotValue,
    浏览量: topic.viewCount || 0,
    相关视频数: topic.relatedVideoCount || 0,
    发布时间: topic.publishedAt || '',
    目标方向: config.targetDirection,
    热点题材: config.topicDirection,
    命中关键词: topic.matchedKeywords || [],
    方向匹配分: topic.directionMatchScore || 0,
    可复刻分: topic.reproducibilityScore || 0,
  };
  const content = [{
    type: 'text',
    text: [
      `请分析以下抖音热点元数据：${JSON.stringify(metadata)}`,
      '如果附带封面，只能描述封面中确实可见的内容；不要假装看过完整视频。',
      '请只返回 JSON 对象，字段必须为 summary、shotAnalysis、prompt、relevanceScore。',
      'summary：说明热点与所选题材如何直接相关。',
      'shotAnalysis：给出可执行的动作顺序、景别、机位、运镜和节奏，不得虚构新闻事实。',
      'prompt：生成一段可直接用于视频模型的中文提示词，必须同时锚定热点标题和热点题材，包含人物、场景、服装、道具、动作、镜头、节奏、光线、音效、9:16 和建议时长。',
      'relevanceScore：0-100，衡量生成提示词与热点标题、封面和热点题材的相关性。',
    ].join('\n'),
  }];
  if (topic.coverUrl) {
    content.push({ type: 'image_url', image_url: { url: topic.coverUrl } });
  }
  return {
    messages: [
      {
        role: 'system',
        content: '你是短视频热点分析与视频提示词编辑。严格依据输入元数据和可见封面，不虚构完整视频内容；只输出合法 JSON。',
      },
      { role: 'user', content },
    ],
    temperature: 0.2,
  };
}

function parseHotTopicPromptAnalysis(raw, topic = {}, config = DEFAULT_HOT_DIRECTION_CONFIG) {
  const text = cleanText(raw);
  let parsed = {};
  try {
    parsed = JSON.parse(text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, ''));
  } catch {}
  const summary = cleanText(parsed.summary)
    || `热点“${cleanText(topic.title)}”与题材“${cleanText(config.topicDirection)}”命中关键词：${(topic.matchedKeywords || []).join('、') || '待人工复核'}。`;
  const shotAnalysis = cleanText(parsed.shotAnalysis)
    || '按起势、主体动作、变化动作、收势的顺序组织画面；使用全景交代环境、中景呈现动作、近景强化表情与道具。';
  const generatedPrompt = cleanText(parsed.prompt);
  const prompt = generatedPrompt || buildSuggestedVideoPrompt(topic.title, {
    topicDirection: config.topicDirection,
    targetDirection: config.targetDirection,
    summary,
    shotAnalysis,
  });
  return {
    summary,
    shotAnalysis,
    prompt: `热点依据：“${cleanText(topic.title)}”。${prompt}`,
    relevanceScore: clampScore(parsed.relevanceScore || (generatedPrompt ? 85 : 70)),
  };
}

function buildWeeklyCleanupPlan(existingRows = [], {
  now = new Date(),
  currentPeriod = currentWeekId(now),
  config = null,
  retainTopicIds = [],
} = {}) {
  const retained = new Set(retainTopicIds.map(cleanText).filter(Boolean));
  return existingRows
    .filter((row) => firstOption(row['来源平台']) === '抖音热榜')
    .filter((row) => {
      const storedPeriod = cleanText(row['所属周期']);
      const captured = parseFeishuDateTime(row['抓取时间']);
      const outsideCurrentPeriod = storedPeriod
        ? storedPeriod !== currentPeriod
        : !captured || currentWeekId(captured) !== currentPeriod;
      if (outsideCurrentPeriod) return true;
      if (retained.has(cleanText(row['热榜ID']))) return false;
      if (!config) return false;
      const directionScore = scoreDirectionalTopic({
        title: row['热点标题'],
        rank: row['热榜排名'],
        hotValue: row['热度值'],
        remakeScore: row['复刻适配分'],
        publishedAt: row['发布时间'],
      }, config, { now }).directionMatchScore;
      return directionScore < config.minimumDirectionScore;
    })
    .map((row) => row.record_id)
    .filter(Boolean);
}

function promptLibraryRecordPatch(topic, { syncedAt = '' } = {}) {
  return {
    '热点标题': topic.title,
    '来源平台': '抖音热榜',
    '热榜ID': topic.topicId,
    '热点视频ID': topic.videoId || '',
    '热榜排名': topic.rank,
    '热度值': topic.hotValue,
    '热榜链接': topic.topicUrl,
    '视频链接': topic.videoUrl || topic.topicUrl,
    '视频封面': topic.coverUrl || '',
    '作者': topic.author || '',
    '发布时间': topic.publishedAt || null,
    '热点题材': topic.topicDirection || '',
    '热点匹配方式': topic.matchMethod || '严格匹配',
    '方向匹配分': topic.directionMatchScore || 0,
    '可复刻分': topic.reproducibilityScore || topic.remakeScore || 0,
    '综合优先分': topic.priorityScore || 0,
    '视频内容摘要': topic.summary || '',
    '动作与镜头分析': topic.shotAnalysis || '',
    '建议提示词': topic.suggestion,
    '提示词相关性分': topic.relevanceScore || 0,
    '所属周期': topic.periodId || currentWeekId(parseFeishuDateTime(topic.capturedAt) || new Date()),
    '提示词生成模型': topic.promptModel || '',
    ...(topic.directionConfigRecordId
      ? { '热点方向配置': [{ id: topic.directionConfigRecordId }] }
      : {}),
    '成交适配分': topic.commerceScore,
    '涨粉适配分': topic.growthScore,
    '复刻适配分': topic.remakeScore,
    '系统推荐方向': topic.recommendedDirection,
    '推荐理由': topic.recommendationReason,
    '抓取时间': topic.capturedAt || syncedAt,
    '是否启用': '是',
  };
}

function promptLibraryScorePatch({ title = '', rank = 0, hotValue = 0 } = {}) {
  const score = scorePromptLibraryTopic({ title, rank, hotValue });
  return {
    '成交适配分': score.commerceScore,
    '涨粉适配分': score.growthScore,
    '复刻适配分': score.remakeScore,
    '系统推荐方向': score.recommendedDirection,
    '推荐理由': score.recommendationReason,
  };
}

function needsPromptLibraryScore(row = {}) {
  const storedScores = ['成交适配分', '涨粉适配分', '复刻适配分']
    .every((field) => row[field] !== null && row[field] !== undefined && row[field] !== '');
  const direction = Array.isArray(row['系统推荐方向'])
    ? cleanText(row['系统推荐方向'][0]?.name || row['系统推荐方向'][0])
    : cleanText(row['系统推荐方向']);
  return !storedScores || !PROMPT_TARGET_DIRECTIONS.includes(direction) || !cleanText(row['推荐理由']);
}

function buildPromptLibrarySyncPlan(existingRows = [], topics = [], options = {}) {
  const byTopicId = new Map();
  const byTitle = new Map();
  const updatesByRecordId = new Map();
  for (const row of existingRows) {
    const topicId = cleanText(row['热榜ID']);
    const title = cleanText(row['热点标题'] || row['文本']);
    const source = Array.isArray(row['来源平台'])
      ? cleanText(row['来源平台'][0]?.name || row['来源平台'][0])
      : cleanText(row['来源平台']);
    if (topicId) byTopicId.set(topicId, row);
    if (title && source === '抖音热榜') byTitle.set(title, row);
    if (row.record_id && title && source === '抖音热榜' && needsPromptLibraryScore(row)) {
      updatesByRecordId.set(row.record_id, {
        recordId: row.record_id,
        patch: promptLibraryScorePatch({
          title,
          rank: row['热榜排名'],
          hotValue: row['热度值'],
        }),
      });
    }
  }

  const creates = [];
  for (const topic of topics) {
    const existing = byTopicId.get(topic.topicId) || byTitle.get(topic.title);
    const patch = promptLibraryRecordPatch(topic, options);
    if (existing?.record_id) updatesByRecordId.set(existing.record_id, { recordId: existing.record_id, patch });
    else creates.push(patch);
  }
  return { creates, updates: [...updatesByRecordId.values()] };
}

function promptLibraryContent(row = {}) {
  return cleanText(row['建议提示词'] || row['热点标题'] || row['文本']);
}

module.exports = {
  DEFAULT_HOT_DIRECTION_CONFIG,
  DOUYIN_HOT_LIST_URL,
  DOUYIN_HOT_PAGE_URL,
  PROMPT_TARGET_DIRECTIONS,
  SMART_FILL_STRATEGIES,
  activeHotDirectionConfig,
  buildDouyinTopicUrl,
  buildDouyinVideoUrl,
  buildHotTopicPromptRequest,
  buildSmartFillRequest,
  buildPromptLibrarySyncPlan,
  buildSuggestedVideoPrompt,
  buildWeeklyCleanupPlan,
  currentWeekId,
  fetchDouyinHotList,
  parseHotTopicPromptAnalysis,
  parseSmartFillCandidates,
  parseDouyinHotList,
  promptLibraryContent,
  promptLibraryRecordPatch,
  promptLibraryScorePatch,
  promptTargetDirection,
  scoreDirectionalTopic,
  scorePromptLibraryTopic,
  selectDirectionalTopics,
  selectSmartFillCandidates,
  selectSmartFillFallback,
  targetDirectionInstruction,
};
