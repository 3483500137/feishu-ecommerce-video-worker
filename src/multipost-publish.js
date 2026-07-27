'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_TASK_DIR = path.join(ROOT, 'runtime', 'multipost-publish-tasks');

const VIDEO_PLATFORM_KEYS = Object.freeze({
  '抖音': 'VIDEO_DOUYIN',
  '小红书': 'VIDEO_XHS',
  '微信视频号': 'VIDEO_WEIXIN',
  '快手': 'VIDEO_KUAISHOU',
  '哔哩哔哩': 'VIDEO_BILIBILI',
  '微博': 'VIDEO_WEIBO',
  '今日头条': 'VIDEO_TOUTIAO',
  '百家号': 'VIDEO_BAIJIAHAO',
  '知乎': 'VIDEO_ZHIHU',
  YouTube: 'VIDEO_YOUTUBE',
  TikTok: 'VIDEO_TIKTOK',
});

function cleanText(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function normalizeTags(value) {
  const raw = Array.isArray(value)
    ? value
    : cleanText(value).split(/[\s,，、]+/);
  return [...new Set(raw
    .map((tag) => cleanText(tag).replace(/^#+/, ''))
    .filter(Boolean))];
}

function scheduledTimestamp(value) {
  if (value === null || value === undefined || value === '') return 0;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return 0;
    return value < 10_000_000_000 ? value * 1000 : value;
  }
  const text = cleanText(value);
  if (!text) return 0;
  const hasTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text);
  const normalized = text.includes('T') ? text : text.replace(' ', 'T');
  const timestamp = Date.parse(hasTimezone ? normalized : `${normalized}+08:00`);
  if (!Number.isFinite(timestamp)) throw new Error(`计划发布时间格式无效：${text}`);
  return timestamp;
}

function videoNameFromUrl(videoUrl) {
  try {
    const pathname = new URL(videoUrl).pathname;
    const base = path.posix.basename(pathname);
    const decoded = decodeURIComponent(base);
    return decoded && /\.[A-Za-z0-9]{2,5}$/.test(decoded) ? decoded : 'final.mp4';
  } catch {
    return 'final.mp4';
  }
}

function buildExtensionPublishPayload({
  platform,
  title,
  content,
  tags,
  videoUrl,
  scheduledPublishTime,
}) {
  const platformKey = VIDEO_PLATFORM_KEYS[cleanText(platform)];
  if (!platformKey) throw new Error(`MultiPost 扩展暂不支持平台：${platform || '空值'}`);
  const cleanTitle = cleanText(title);
  const cleanContent = cleanText(content);
  const cleanVideoUrl = cleanText(videoUrl);
  const normalizedTags = normalizeTags(tags);
  if (!cleanTitle) throw new Error('发布标题为空');
  if (!cleanContent) throw new Error('发布文案为空');
  if (!cleanVideoUrl || !/^https?:\/\//i.test(cleanVideoUrl)) throw new Error('最终视频链接无效');
  if (!normalizedTags.length) throw new Error('发布标签为空');

  return {
    platforms: [{ name: platformKey }],
    isAutoPublish: true,
    data: {
      title: cleanTitle,
      content: cleanContent,
      tags: normalizedTags,
      video: {
        name: videoNameFromUrl(cleanVideoUrl),
        url: cleanVideoUrl,
        type: 'video/mp4',
      },
      scheduledPublishTime: scheduledTimestamp(scheduledPublishTime),
    },
  };
}

function buildPublishIdempotencyKey({ recordId, accountRecordId, videoUrl, attempt = 0 }) {
  const normalizedAttempt = Math.max(0, Math.trunc(Number(attempt) || 0));
  const baseSource = [cleanText(recordId), cleanText(accountRecordId), cleanText(videoUrl)].join('|');
  const source = normalizedAttempt > 0 ? `${baseSource}|retry:${normalizedAttempt}` : baseSource;
  if (!cleanText(recordId) || !cleanText(accountRecordId) || !cleanText(videoUrl)) {
    throw new Error('无法生成发布幂等键：记录、账号或视频链接为空');
  }
  return `mpx-${crypto.createHash('sha256').update(source).digest('hex').slice(0, 32)}`;
}

function createPublishTaskId(recordId, now = new Date()) {
  const suffix = cleanText(recordId).replace(/[^A-Za-z0-9_-]/g, '').slice(-12) || 'task';
  return `mpx-${now.toISOString().replace(/\D/g, '').slice(0, 17)}-${suffix}`;
}

function isValidTaskId(taskId) {
  return /^mpx-[A-Za-z0-9_-]{4,96}$/.test(cleanText(taskId));
}

function taskPath(taskId, taskDir = DEFAULT_TASK_DIR) {
  if (!isValidTaskId(taskId)) throw new Error('MultiPost 本地任务 ID 无效');
  return path.join(taskDir, `${taskId}.json`);
}

function writePublishTask(task, taskDir = DEFAULT_TASK_DIR) {
  if (!task || !isValidTaskId(task.taskId)) throw new Error('MultiPost 本地任务无效');
  fs.mkdirSync(taskDir, { recursive: true });
  const target = taskPath(task.taskId, taskDir);
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(task, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, target);
  return task;
}

function readPublishTask(taskId, taskDir = DEFAULT_TASK_DIR) {
  const target = taskPath(taskId, taskDir);
  if (!fs.existsSync(target)) return null;
  return JSON.parse(fs.readFileSync(target, 'utf8'));
}

function updatePublishTask(taskId, patch, taskDir = DEFAULT_TASK_DIR) {
  const current = readPublishTask(taskId, taskDir);
  if (!current) return null;
  const updated = { ...current, ...patch, updatedAt: new Date().toISOString() };
  return writePublishTask(updated, taskDir);
}

function claimPublishTask(taskId, taskDir = DEFAULT_TASK_DIR) {
  const task = readPublishTask(taskId, taskDir);
  if (!task || task.status !== 'queued') return null;
  return updatePublishTask(taskId, {
    status: 'dispatching',
    claimedAt: new Date().toISOString(),
  }, taskDir);
}

function markPublishTaskDispatched(taskId, taskDir = DEFAULT_TASK_DIR) {
  const task = readPublishTask(taskId, taskDir);
  if (!task || !['dispatching', 'queued'].includes(task.status)) return null;
  return updatePublishTask(taskId, {
    status: 'dispatched',
    dispatchedAt: new Date().toISOString(),
    error: null,
  }, taskDir);
}

function markPublishTaskFailed(taskId, error, taskDir = DEFAULT_TASK_DIR) {
  const task = readPublishTask(taskId, taskDir);
  if (!task) return null;
  return updatePublishTask(taskId, {
    status: 'failed',
    failedAt: new Date().toISOString(),
    error: cleanText(error).slice(0, 1000) || '未知错误',
  }, taskDir);
}

function findLatestDispatchedPublishTask({
  platformKey,
  titleText,
  maxAgeMs = 2 * 60 * 60 * 1000,
}, taskDir = DEFAULT_TASK_DIR) {
  if (!fs.existsSync(taskDir)) return null;
  const now = Date.now();
  const normalizedTitleText = cleanText(titleText);
  const candidates = fs.readdirSync(taskDir)
    .filter((name) => /^mpx-[A-Za-z0-9_-]+\.json$/.test(name))
    .map((name) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(taskDir, name), 'utf8'));
      } catch {
        return null;
      }
    })
    .filter((task) => {
      if (!task || !['dispatching', 'dispatched'].includes(task.status)) return false;
      if (cleanText(task.expectedAccount?.platformKey) !== cleanText(platformKey)) return false;
      const expectedTitle = cleanText(task.payload?.data?.title);
      if (!expectedTitle || !normalizedTitleText.includes(expectedTitle)) return false;
      const createdAt = Date.parse(task.createdAt || task.updatedAt || '');
      return Number.isFinite(createdAt) && now - createdAt <= maxAgeMs;
    })
    .sort((left, right) => Date.parse(right.dispatchedAt || right.updatedAt || right.createdAt)
      - Date.parse(left.dispatchedAt || left.updatedAt || left.createdAt));
  return candidates[0] || null;
}

function markPublishTaskSucceeded(taskId, result = {}, taskDir = DEFAULT_TASK_DIR) {
  const task = readPublishTask(taskId, taskDir);
  if (!task) return null;
  return updatePublishTask(taskId, {
    status: 'succeeded',
    succeededAt: new Date().toISOString(),
    publishedAt: cleanText(result.publishedAt),
    workUrl: cleanText(result.workUrl),
    error: null,
  }, taskDir);
}

module.exports = {
  DEFAULT_TASK_DIR,
  VIDEO_PLATFORM_KEYS,
  buildExtensionPublishPayload,
  buildPublishIdempotencyKey,
  claimPublishTask,
  createPublishTaskId,
  findLatestDispatchedPublishTask,
  isValidTaskId,
  markPublishTaskDispatched,
  markPublishTaskFailed,
  markPublishTaskSucceeded,
  normalizeTags,
  readPublishTask,
  scheduledTimestamp,
  updatePublishTask,
  writePublishTask,
};
