'use strict';

(() => {
const MULTIPOST_DOUYIN_REFRESH_ACTION = 'MULTIPOST_EXTENSION_REFRESH_DOUYIN_ACCOUNT_INFO';
const MULTIPOST_ACCOUNT_STORAGE_KEY = 'multipost_account_info';
const DOUYIN_ACCOUNT_ENDPOINT = 'https://creator.douyin.com/web/api/media/user/info/';

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

function douyinAccountFromResponse(payload) {
  const user = payload?.user;
  const accountId = String(user?.sec_uid || '').trim();
  const username = String(user?.nickname || '').trim();
  if (!accountId || !username) return null;
  return {
    provider: 'douyin',
    accountId,
    username,
    description: String(user?.signature || ''),
    profileUrl: `https://www.douyin.com/user/${accountId}`,
    avatarUrl: user?.avatar_larger?.url_list?.[0] || '',
    extraData: null,
  };
}

async function refreshDouyinAccount({
  fetchImpl = globalThis.fetch,
  storage = globalThis.chrome?.storage?.local,
} = {}) {
  if (typeof fetchImpl !== 'function' || !storage) {
    throw new Error('MultiPost 抖音账号实时校验不可用');
  }
  const response = await fetchImpl(DOUYIN_ACCOUNT_ENDPOINT, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    credentials: 'include',
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(`读取当前抖音账号失败 HTTP ${response.status}`);

  const payload = await response.json();
  const stored = await storage.get(MULTIPOST_ACCOUNT_STORAGE_KEY);
  const accountInfo = parseAccountStorage(stored[MULTIPOST_ACCOUNT_STORAGE_KEY]);
  const account = douyinAccountFromResponse(payload);

  if (!account) {
    delete accountInfo.douyin;
    await storage.set({
      [MULTIPOST_ACCOUNT_STORAGE_KEY]: JSON.stringify(accountInfo),
    });
    return {
      accountInfo: {},
      account: null,
      error: '当前抖音创作者平台未登录',
    };
  }

  accountInfo.douyin = account;
  await storage.set({
    [MULTIPOST_ACCOUNT_STORAGE_KEY]: JSON.stringify(accountInfo),
  });
  return { accountInfo, account, error: '' };
}

function installDouyinBackgroundListener() {
  if (typeof chrome === 'undefined' || !chrome.runtime?.onMessage) return;
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.action !== MULTIPOST_DOUYIN_REFRESH_ACTION) return false;
    refreshDouyinAccount()
      .then(sendResponse)
      .catch((error) => sendResponse({
        accountInfo: {},
        account: null,
        error: error?.message || String(error),
      }));
    return true;
  });
}

installDouyinBackgroundListener();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    DOUYIN_ACCOUNT_ENDPOINT,
    MULTIPOST_ACCOUNT_STORAGE_KEY,
    MULTIPOST_DOUYIN_REFRESH_ACTION,
    douyinAccountFromResponse,
    parseAccountStorage,
    refreshDouyinAccount,
  };
}
})();
