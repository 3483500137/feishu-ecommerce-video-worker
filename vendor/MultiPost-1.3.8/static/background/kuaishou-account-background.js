'use strict';

const MULTIPOST_KUAISHOU_REFRESH_ACTION = 'MULTIPOST_EXTENSION_REFRESH_KUAISHOU_ACCOUNT_INFO';
const MULTIPOST_KUAISHOU_SCRAPE_ACTION = 'MULTIPOST_EXTENSION_SCRAPE_KUAISHOU_ACCOUNT';
const MULTIPOST_KUAISHOU_REPORT_PUBLISH_ACTION = 'MULTIPOST_EXTENSION_REPORT_KUAISHOU_PUBLISH_RESULT';
const MULTIPOST_ACCOUNT_STORAGE_KEY = 'multipost_account_info';

function parseAccountStorage(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return { ...value };
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function mergeAccountStorage(value, account) {
  const accounts = parseAccountStorage(value);
  accounts.kuaishou = account;
  return accounts;
}

async function scrapeKuaishouTab(tabId) {
  try {
    return await chrome.tabs.sendMessage(tabId, {
      action: MULTIPOST_KUAISHOU_SCRAPE_ACTION,
    });
  } catch {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['kuaishou-account-content.js'],
    });
    return chrome.tabs.sendMessage(tabId, {
      action: MULTIPOST_KUAISHOU_SCRAPE_ACTION,
    });
  }
}

async function refreshKuaishouAccount() {
  const tabs = await chrome.tabs.query({ url: 'https://cp.kuaishou.com/*' });
  if (!tabs.length) {
    return {
      accountInfo: {},
      error: '没有找到已打开的快手创作者平台，请先打开快手创作者平台并完成登录',
    };
  }

  let lastError = '';
  for (const tab of tabs) {
    if (!tab.id) continue;
    try {
      const result = await scrapeKuaishouTab(tab.id);
      if (!result?.account) {
        lastError = result?.error || '未从快手页面识别到账号';
        continue;
      }

      const stored = await chrome.storage.local.get(MULTIPOST_ACCOUNT_STORAGE_KEY);
      const accountInfo = mergeAccountStorage(stored[MULTIPOST_ACCOUNT_STORAGE_KEY], result.account);
      await chrome.storage.local.set({
        [MULTIPOST_ACCOUNT_STORAGE_KEY]: JSON.stringify(accountInfo),
      });
      return { accountInfo, account: result.account, error: '' };
    } catch (error) {
      lastError = error?.message || String(error);
    }
  }

  return {
    accountInfo: {},
    error: lastError || '快手创作者平台已打开，但没有检测到登录账号',
  };
}

async function reportKuaishouPublishResult(result) {
  const response = await fetch('http://127.0.0.1:17386/api/multipost/publish-task/succeeded', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(result || {}),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.ok) {
    throw new Error(payload.error || `本地发布结果回写失败 HTTP ${response.status}`);
  }
  return payload;
}

function installKuaishouBackgroundListener() {
  if (typeof chrome === 'undefined' || !chrome.runtime?.onMessage) return;
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.action === MULTIPOST_KUAISHOU_REPORT_PUBLISH_ACTION) {
      reportKuaishouPublishResult(message.result)
        .then(sendResponse)
        .catch((error) => sendResponse({
          ok: false,
          error: error?.message || String(error),
        }));
      return true;
    }
    if (message?.action !== MULTIPOST_KUAISHOU_REFRESH_ACTION) return false;
    refreshKuaishouAccount()
      .then(sendResponse)
      .catch((error) => sendResponse({
        accountInfo: {},
        error: error?.message || String(error),
      }));
    return true;
  });
}

installKuaishouBackgroundListener();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    MULTIPOST_ACCOUNT_STORAGE_KEY,
    MULTIPOST_KUAISHOU_REFRESH_ACTION,
    mergeAccountStorage,
    parseAccountStorage,
    reportKuaishouPublishResult,
  };
}
