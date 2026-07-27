'use strict';

const MULTIPOST_KUAISHOU_SCRAPE_ACTION = 'MULTIPOST_EXTENSION_SCRAPE_KUAISHOU_ACCOUNT';
const MULTIPOST_KUAISHOU_REPORT_PUBLISH_ACTION = 'MULTIPOST_EXTENSION_REPORT_KUAISHOU_PUBLISH_RESULT';

function cleanKuaishouText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeKwaiId(value) {
  return cleanKuaishouText(value).replace(/^快手号\s*[:：]?\s*/u, '');
}

function buildKuaishouAccount({ username, kwaiId, avatarUrl }) {
  const cleanUsername = cleanKuaishouText(username);
  if (!cleanUsername) return null;

  const cleanKwaiId = normalizeKwaiId(kwaiId);
  const generatedId = cleanUsername.match(/(\d{6,})$/u)?.[1] || '';
  const accountId = cleanKwaiId || generatedId;

  return {
    provider: 'kuaishou',
    accountId,
    username: cleanUsername,
    description: '',
    profileUrl: 'https://cp.kuaishou.com/profile',
    avatarUrl: cleanKuaishouText(avatarUrl),
    extraData: {
      source: 'creator-page-dom',
      kwaiId: cleanKwaiId,
    },
  };
}

function firstText(documentNode, selectors) {
  for (const selector of selectors) {
    const nodes = documentNode.querySelectorAll(selector);
    for (const node of nodes) {
      const text = cleanKuaishouText(node.textContent);
      if (text) return text;
    }
  }
  return '';
}

function firstAttribute(documentNode, selectors, attributeName) {
  for (const selector of selectors) {
    const nodes = documentNode.querySelectorAll(selector);
    for (const node of nodes) {
      const value = cleanKuaishouText(node.getAttribute(attributeName));
      if (value) return value;
    }
  }
  return '';
}

function readKuaishouAccount(documentNode) {
  return buildKuaishouAccount({
    username: firstText(documentNode, [
      '.user-info-name',
      '.header-info-card .user-name',
      '.user__name',
    ]),
    kwaiId: firstText(documentNode, [
      '.header-info-card .user-kwai-id',
      '.user-kwai-id',
    ]),
    avatarUrl: firstAttribute(documentNode, [
      '.user-info-avatar img',
      '.header-info-card .user-image',
      '.user__head',
    ], 'src'),
  });
}

function buildKuaishouPublishResult({ titleText, status, publishedAt }) {
  const cleanTitleText = cleanKuaishouText(titleText);
  const cleanStatus = cleanKuaishouText(status);
  const cleanPublishedAt = cleanKuaishouText(publishedAt);
  if (!cleanTitleText || cleanStatus !== '已发布' || !cleanPublishedAt) return null;
  return {
    platformKey: 'kuaishou',
    titleText: cleanTitleText,
    publishedAt: cleanPublishedAt,
  };
}

function readKuaishouPublishResult(documentNode) {
  const card = documentNode.querySelector('.video-item--published');
  if (!card) return null;
  return buildKuaishouPublishResult({
    titleText: card.querySelector('.video-item__detail__row__title')?.textContent,
    status: card.querySelector('.video-item__detail__row__status')?.textContent,
    publishedAt: card.querySelector('.video-item__detail__row__date')?.textContent,
  });
}

function installKuaishouPublishResultReporter() {
  if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage || typeof document === 'undefined') return;
  if (globalThis.__MULTIPOST_KUAISHOU_PUBLISH_REPORTER__) return;
  globalThis.__MULTIPOST_KUAISHOU_PUBLISH_REPORTER__ = true;

  let attempts = 0;
  const timer = setInterval(() => {
    attempts += 1;
    const result = readKuaishouPublishResult(document);
    if (!result && attempts < 60) return;
    clearInterval(timer);
    if (!result) return;
    chrome.runtime.sendMessage({
      action: MULTIPOST_KUAISHOU_REPORT_PUBLISH_ACTION,
      result,
    }).catch(() => {});
  }, 2000);
}

function installKuaishouAccountListener() {
  if (typeof chrome === 'undefined' || !chrome.runtime?.onMessage || typeof document === 'undefined') return;
  if (globalThis.__MULTIPOST_KUAISHOU_ACCOUNT_LISTENER__) return;
  globalThis.__MULTIPOST_KUAISHOU_ACCOUNT_LISTENER__ = true;

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.action !== MULTIPOST_KUAISHOU_SCRAPE_ACTION) return false;
    const account = readKuaishouAccount(document);
    sendResponse({
      account,
      error: account ? '' : '快手页面已打开，但未找到可识别的账号昵称或快手号',
    });
    return false;
  });
}

installKuaishouAccountListener();
installKuaishouPublishResultReporter();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    MULTIPOST_KUAISHOU_REPORT_PUBLISH_ACTION,
    MULTIPOST_KUAISHOU_SCRAPE_ACTION,
    buildKuaishouAccount,
    buildKuaishouPublishResult,
    cleanKuaishouText,
    normalizeKwaiId,
    readKuaishouAccount,
    readKuaishouPublishResult,
  };
}
