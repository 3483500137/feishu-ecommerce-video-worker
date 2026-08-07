'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawnSync } = require('child_process');
const { createApiConfigHandler } = require('./api-config');
const { createCredentialStore } = require('./credential-store');
const { createAdapterRegistry } = require('./provider-adapters');
const {
  claimPublishTask,
  findLatestDispatchedPublishTask,
  isValidTaskId,
  markPublishTaskDispatched,
  markPublishTaskFailed,
  markPublishTaskSucceeded,
  readPublishTask,
} = require('./multipost-publish');

const ROOT = path.resolve(__dirname, '..');
const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const LARK_CLI = path.join(process.env.APPDATA, 'npm', 'node_modules', '@larksuite', 'cli', 'scripts', 'run.js');
const DEFAULT_PORT = 17386;
const DEFAULT_TABLE_ID = 'tbl2D0BNAXAwgH16';
const DEFAULT_ACCESS_API_TABLE_ID = 'tblCNfWxoesOL8GA';

const PLATFORM_KEYS = Object.freeze({
  '抖音': 'douyin',
  '小红书': 'rednote',
  '微信视频号': 'weixinchannel',
  '快手': 'kuaishou',
  '哔哩哔哩': 'bilibili',
  '微博': 'weibo',
  '今日头条': 'toutiaohao',
  '百家号': 'baijiahao',
  '知乎': 'zhihu',
  'YouTube': 'youtube',
  'TikTok': 'tiktok',
});

const PLATFORM_LOGIN_URLS = Object.freeze({
  '抖音': 'https://creator.douyin.com/creator-micro/home',
  '快手': 'https://cp.kuaishou.com/article/publish/video',
});

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `${command} failed`).trim());
  }
  return result.stdout.trim();
}

function runLark(args) {
  const stdout = run(process.execPath, [LARK_CLI, ...args, '--as', 'user', '--format', 'json']);
  const envelope = JSON.parse(stdout);
  if (!envelope.ok) throw new Error(envelope.error?.message || 'lark-cli request failed');
  return envelope.data;
}

function platformKeyFor(platformName) {
  return PLATFORM_KEYS[String(platformName || '').trim()] || '';
}

function platformLoginUrl(platformName) {
  return PLATFORM_LOGIN_URLS[String(platformName || '').trim()] || '';
}

function cleanText(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function buildMinimalAccountInfo(platformKey, accountInfoMap) {
  const key = String(platformKey || '').trim();
  const account = accountInfoMap && typeof accountInfoMap === 'object'
    ? accountInfoMap[key]
    : null;
  if (!key || !account || typeof account !== 'object') return {};
  return {
    [key]: {
      provider: String(account.provider || key).trim(),
      accountId: String(account.accountId || '').trim(),
      username: String(account.username || '').trim(),
    },
  };
}

function feishuDateTime(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  ].join('-') + ` ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function buildAccountPatch(platformName, accountInfoMap, now = new Date()) {
  const platformKey = platformKeyFor(platformName);
  if (!platformKey) throw new Error(`不支持的平台：${platformName || '空值'}`);

  const accounts = accountInfoMap && typeof accountInfoMap === 'object' ? accountInfoMap : {};
  const account = accounts[platformKey]
    || Object.values(accounts).find((item) => cleanText(item?.provider) === platformKey)
    || null;
  const rawAccountId = cleanText(account?.accountId);
  const accountId = rawAccountId && rawAccountId.toLowerCase() !== 'unknown' ? rawAccountId : '';
  const username = cleanText(account?.username);
  const verified = Boolean(account && accountId && username);

  return {
    'MultiPost平台标识': platformKey,
    'MultiPost账号ID': accountId || null,
    '账号昵称': username || null,
    '登录状态': verified ? '有效' : '需要人工处理',
    '最近验证时间': feishuDateTime(now),
  };
}

function updatePlatformAccount(recordId, patch) {
  const tableId = CONFIG.platform_account_table_id || DEFAULT_TABLE_ID;
  return runLark([
    'base', '+record-upsert',
    '--base-token', CONFIG.base_token,
    '--table-id', tableId,
    '--record-id', recordId,
    '--json', JSON.stringify(patch),
  ]);
}

function updatePlatformPublish(recordId, patch) {
  return runLark([
    'base', '+record-upsert',
    '--base-token', CONFIG.base_token,
    '--table-id', CONFIG.platform_publish_table_id,
    '--record-id', recordId,
    '--json', JSON.stringify(patch),
  ]);
}

function rowFromRecordEnvelope(data) {
  if (Array.isArray(data?.record_not_found) && data.record_not_found.length > 0) return null;
  const fields = Array.isArray(data?.fields) ? data.fields : [];
  const values = Array.isArray(data?.data?.[0]) ? data.data[0] : null;
  const recordId = data?.record_id_list?.[0] || '';
  if (!values || !recordId) return null;
  const row = { record_id: recordId };
  fields.forEach((field, index) => { row[field] = values[index]; });
  return row;
}

function createAccessBaseClient() {
  const tableId = CONFIG.access_api_table_id || DEFAULT_ACCESS_API_TABLE_ID;
  const projection = [
    '接入编号', '接入名称', '服务商类型', 'API协议', '视频接口样式', '接口地址', '模型名称', '模型ID',
    '模型能力', '本机密钥别名', '密钥尾号', '是否默认', '是否启用', '验证状态',
  ];
  return {
    getAccessRecord(recordId) {
      const args = [
        'base', '+record-get', '--base-token', CONFIG.base_token, '--table-id', tableId, '--record-id', recordId,
      ];
      for (const field of projection) args.push('--field-id', field);
      return rowFromRecordEnvelope(runLark(args));
    },
    updateAccessRecord(recordId, patch) {
      return runLark([
        'base', '+record-upsert', '--base-token', CONFIG.base_token, '--table-id', tableId,
        '--record-id', recordId, '--json', JSON.stringify(patch),
      ]);
    },
    createAccessRecord(fields) {
      return runLark([
        'base', '+record-upsert', '--base-token', CONFIG.base_token, '--table-id', tableId,
        '--json', JSON.stringify(fields),
      ]);
    },
  };
}

function createDefaultApiConfigHandler() {
  const credentialStore = createCredentialStore({
    filePath: path.join(ROOT, 'runtime', 'credentials.json'),
  });
  return createApiConfigHandler({
    baseClient: createAccessBaseClient(),
    credentialStore,
    adapterRegistry: createAdapterRegistry(),
  });
}

function jsonResponse(response, statusCode, body) {
  const payload = JSON.stringify(body);
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(payload);
}

function htmlResponse(response, statusCode, body) {
  response.writeHead(statusCode, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'none'; frame-ancestors 'none'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(body);
}

function accountPage({ recordId, platformName }) {
  const loginUrl = platformLoginUrl(platformName);
  const safeData = JSON.stringify({
    recordId,
    platformName,
    platformKey: platformKeyFor(platformName),
    loginUrl,
  })
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>获取 MultiPost 账号</title>
  <style>
    :root { color-scheme: light; font-family: Inter, "Microsoft YaHei", system-ui, sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f4f7fb; color: #1f2937; }
    main { width: min(560px, calc(100vw - 40px)); padding: 32px; border: 1px solid #e5e7eb; border-radius: 18px; background: white; box-shadow: 0 16px 50px #1f293712; }
    h1 { margin: 0 0 12px; font-size: 22px; }
    p { margin: 8px 0; line-height: 1.65; }
    #status { padding: 14px 16px; border-radius: 12px; background: #eef4ff; color: #1d4ed8; }
    #status.success { background: #ecfdf3; color: #047857; }
    #status.error { background: #fef2f2; color: #b91c1c; }
    button { margin-top: 18px; padding: 10px 18px; border: 0; border-radius: 10px; background: #2563eb; color: white; cursor: pointer; font-size: 14px; }
    button.secondary { margin-left: 8px; background: #eef2ff; color: #1d4ed8; }
    #login-actions { margin-top: 18px; padding: 16px; border-radius: 12px; background: #fffbeb; }
    #login-actions p { margin: 0; color: #92400e; font-size: 14px; }
    #login-actions button { margin-top: 12px; }
    dl { display: grid; grid-template-columns: 130px 1fr; gap: 8px 12px; margin: 20px 0 0; }
    dt { color: #6b7280; } dd { margin: 0; word-break: break-all; }
  </style>
</head>
<body>
  <main>
    <h1>获取 MultiPost 账号</h1>
    <p>平台：<strong id="platform"></strong></p>
    <p id="status">正在连接 MultiPost 扩展……</p>
    <dl id="result" hidden>
      <dt>平台标识</dt><dd id="provider"></dd>
      <dt>账号 ID</dt><dd id="accountId"></dd>
      <dt>账号昵称</dt><dd id="username"></dd>
      <dt>登录状态</dt><dd id="loginStatus"></dd>
    </dl>
    <section id="login-actions" hidden>
      <p>打开官方创作者平台确认账号状态；未登录时页面会要求扫码。登录后回到这里刷新账号。</p>
      <button id="login" type="button">打开快手创作者平台（未登录时扫码）</button>
      <button id="refresh" class="secondary" type="button">登录完成，刷新账号</button>
    </section>
    <button id="retry" type="button" hidden>重新获取</button>
  </main>
  <script>
    const input = ${safeData};
    const buildMinimalAccountInfo = ${buildMinimalAccountInfo.toString()};
    const statusNode = document.getElementById('status');
    const resultNode = document.getElementById('result');
    const loginActionsNode = document.getElementById('login-actions');
    const loginNode = document.getElementById('login');
    const refreshNode = document.getElementById('refresh');
    const retryNode = document.getElementById('retry');
    document.getElementById('platform').textContent = input.platformName;
    loginNode.textContent = '打开' + input.platformName + '创作者平台（未登录时扫码）';

    function setStatus(message, kind = '') {
      statusNode.textContent = message;
      statusNode.className = kind;
    }

    function requestExtension(action, data = {}, timeoutMs = 60000) {
      return new Promise((resolve, reject) => {
        const traceId = crypto.randomUUID();
        const timer = setTimeout(() => {
          window.removeEventListener('message', onMessage);
          reject(new Error('未检测到 MultiPost 扩展响应，请确认扩展已安装并启用'));
        }, timeoutMs);
        function onMessage(event) {
          const message = event.data || {};
          if (event.source !== window || message.type !== 'response' || message.traceId !== traceId) return;
          clearTimeout(timer);
          window.removeEventListener('message', onMessage);
          if (message.code !== 0) reject(new Error(message.message || 'MultiPost 扩展调用失败'));
          else resolve(message.data || {});
        }
        window.addEventListener('message', onMessage);
        window.postMessage({ type: 'request', action, data, traceId }, '*');
      });
    }

    function notifyExtension(action, data = {}) {
      window.postMessage({
        type: 'request',
        action,
        data,
        traceId: crypto.randomUUID()
      }, '*');
    }

    function selectedAccount(accountInfo) {
      const account = accountInfo && accountInfo[input.platformKey];
      if (!account) return null;
      const accountId = String(account.accountId || '').trim();
      const username = String(account.username || '').trim();
      if (!accountId || accountId.toLowerCase() === 'unknown' || !username) return null;
      return account;
    }

    function delay(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }

    async function readAccountInfo({ refresh = false } = {}) {
      const refreshActions = {
        kuaishou: 'MULTIPOST_EXTENSION_REFRESH_KUAISHOU_ACCOUNT_INFO',
        douyin: 'MULTIPOST_EXTENSION_REFRESH_DOUYIN_ACCOUNT_INFO'
      };
      const refreshAction = refreshActions[input.platformKey];
      if (refreshAction && refresh) {
        let extensionResult;
        try {
          extensionResult = await requestExtension(
            refreshAction,
            {},
            10000
          );
        } catch {
          throw new Error('当前 MultiPost 扩展未加载账号实时校验桥接，请在扩展管理页重新加载工作流目录中的 MultiPost 扩展');
        }
        if (extensionResult.error) throw new Error(extensionResult.error);
        return extensionResult.accountInfo || {};
      }
      const extensionResult = await requestExtension('MULTIPOST_EXTENSION_GET_ACCOUNT_INFOS');
      return extensionResult.accountInfo || {};
    }

    async function persistAccount(accountInfo) {
      const response = await fetch('/api/multipost/account', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recordId: input.recordId,
          platformName: input.platformName,
          accountInfo: buildMinimalAccountInfo(input.platformKey, accountInfo)
        })
      });
      const payload = await response.json();
      if (!response.ok || !payload.ok) throw new Error(payload.error || '飞书回填失败');
      const patch = payload.patch;
      document.getElementById('provider').textContent = patch['MultiPost平台标识'] || '—';
      document.getElementById('accountId').textContent = patch['MultiPost账号ID'] || '未取得';
      document.getElementById('username').textContent = patch['账号昵称'] || '未取得';
      document.getElementById('loginStatus').textContent = patch['登录状态'];
      resultNode.hidden = false;
      return patch;
    }

    async function syncAccount() {
      retryNode.hidden = true;
      resultNode.hidden = true;
      setStatus('正在请求 MultiPost 扩展授权……');
      try {
        const trust = await requestExtension('MULTIPOST_EXTENSION_REQUEST_TRUST_DOMAIN');
        if (trust.trusted === false) throw new Error('你没有允许 127.0.0.1 访问 MultiPost 扩展');
        setStatus('正在读取当前浏览器的 MultiPost 账号……');
        const accountInfo = await readAccountInfo({ refresh: ['kuaishou', 'douyin'].includes(input.platformKey) });
        const patch = await persistAccount(accountInfo);
        if (patch['登录状态'] === '有效') {
          loginActionsNode.hidden = true;
          setStatus('账号信息已回填飞书，可以关闭此页面。', 'success');
        } else {
          loginActionsNode.hidden = !input.loginUrl;
          setStatus('尚未检测到已登录账号。请打开官方创作者平台确认登录状态，再回到这里刷新账号。', 'error');
          retryNode.hidden = false;
        }
      } catch (error) {
        loginActionsNode.hidden = !input.loginUrl;
        setStatus(error.message || String(error), 'error');
        retryNode.hidden = false;
      }
    }

    async function refreshAfterLogin() {
      refreshNode.disabled = true;
      retryNode.hidden = true;
      setStatus('正在让 MultiPost 刷新账号，请稍候……');
      if (input.platformKey !== 'kuaishou') {
        notifyExtension('MULTIPOST_EXTENSION_REFRESH_ACCOUNT_INFOS', { isFocused: false });
      }
      try {
        for (let attempt = 0; attempt < 20; attempt += 1) {
          if (attempt > 0) await delay(3000);
          const accountInfo = await readAccountInfo({ refresh: ['kuaishou', 'douyin'].includes(input.platformKey) });
          if (!selectedAccount(accountInfo)) continue;
          const patch = await persistAccount(accountInfo);
          if (patch['登录状态'] === '有效') {
            loginActionsNode.hidden = true;
            setStatus('登录成功，账号信息已回填飞书，可以关闭此页面。', 'success');
            return;
          }
        }
        throw new Error('暂未检测到登录账号。请确认创作者平台已登录，再点击“登录完成，刷新账号”。');
      } catch (error) {
        setStatus(error.message || String(error), 'error');
        retryNode.hidden = false;
      } finally {
        refreshNode.disabled = false;
      }
    }

    loginNode.addEventListener('click', () => {
      const opened = window.open(input.loginUrl, 'multipost-platform-login');
      if (!opened) {
        setStatus('浏览器阻止了登录窗口，请允许此页面打开弹窗后重试。', 'error');
        return;
      }
      setStatus('已打开' + input.platformName + '创作者平台；未登录时请在官方页面扫码。');
    });
    refreshNode.addEventListener('click', refreshAfterLogin);
    retryNode.addEventListener('click', syncAccount);
    syncAccount();
  </script>
</body>
</html>`;
}

function publishPage(taskId) {
  const safeTaskId = JSON.stringify(taskId)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>MultiPost 发布任务</title>
  <style>
    :root { color-scheme: light; font-family: Inter, "Microsoft YaHei", system-ui, sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f4f7fb; color: #1f2937; }
    main { width: min(620px, calc(100vw - 40px)); padding: 32px; border: 1px solid #e5e7eb; border-radius: 18px; background: white; box-shadow: 0 16px 50px #1f293712; }
    h1 { margin: 0 0 12px; font-size: 24px; }
    p { line-height: 1.7; }
    #status { padding: 16px; border-radius: 12px; background: #eef4ff; color: #1d4ed8; }
    #status.success { background: #ecfdf3; color: #047857; }
    #status.error { background: #fef2f2; color: #b91c1c; }
    code { word-break: break-all; color: #4b5563; }
  </style>
</head>
<body>
  <main>
    <h1>MultiPost 发布任务</h1>
    <p>任务 ID：<code id="task-id"></code></p>
    <p id="status">正在校验扩展、平台账号与幂等任务……</p>
  </main>
  <script>
    const taskId = ${safeTaskId};
    const statusNode = document.getElementById('status');
    document.getElementById('task-id').textContent = taskId;

    function setStatus(message, kind = '') {
      statusNode.textContent = message;
      statusNode.className = kind;
    }

    function requestExtension(action, data = {}, timeoutMs = 15000) {
      return new Promise((resolve, reject) => {
        const traceId = crypto.randomUUID();
        const timer = setTimeout(() => {
          window.removeEventListener('message', onMessage);
          reject(new Error('未检测到 MultiPost 扩展响应，请确认扩展已安装并启用'));
        }, timeoutMs);
        function onMessage(event) {
          const message = event.data || {};
          if (event.source !== window || message.type !== 'response' || message.traceId !== traceId) return;
          clearTimeout(timer);
          window.removeEventListener('message', onMessage);
          if (message.code !== 0) reject(new Error(message.message || 'MultiPost 扩展调用失败'));
          else resolve(message.data || {});
        }
        window.addEventListener('message', onMessage);
        window.postMessage({ type: 'request', action, data, traceId }, '*');
      });
    }

    function notifyExtension(action, data = {}) {
      window.postMessage({
        type: 'request',
        action,
        data,
        traceId: crypto.randomUUID()
      }, '*');
    }

    async function post(path, body) {
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const payload = await response.json();
      if (!response.ok || !payload.ok) throw new Error(payload.error || '本地发布服务调用失败');
      return payload;
    }

    function accountMatches(expected, accountInfo) {
      if (!expected || !expected.platformKey || !expected.accountId) return false;
      const actual = accountInfo && accountInfo[expected.platformKey];
      if (!actual) return false;
      const actualAccountId = String(actual.accountId || '').trim();
      const expectedAccountId = String(expected.accountId || '').trim();
      if (actualAccountId) return actualAccountId === expectedAccountId;
      const actualUsername = String(actual.username || '').trim();
      const expectedUsername = String(expected.username || '').trim();
      return Boolean(actualUsername && actualUsername === expectedUsername);
    }

    function accountLabel(account) {
      if (!account) return '未检测到';
      const username = String(account.username || '').trim();
      const accountId = String(account.accountId || '').trim();
      return [username, accountId ? '(' + accountId + ')' : ''].filter(Boolean).join(' ') || '未检测到';
    }

    async function dispatch() {
      let claimed = false;
      try {
        const trust = await requestExtension('MULTIPOST_EXTENSION_REQUEST_TRUST_DOMAIN');
        if (trust.trusted === false) throw new Error('未允许 127.0.0.1 使用 MultiPost 扩展');
        await requestExtension('MULTIPOST_EXTENSION_CHECK_SERVICE_STATUS');
        const claim = await post('/api/multipost/publish-task/claim', { taskId });
        claimed = true;
        const task = claim.task;
        const accountRefreshActions = {
          kuaishou: 'MULTIPOST_EXTENSION_REFRESH_KUAISHOU_ACCOUNT_INFO',
          douyin: 'MULTIPOST_EXTENSION_REFRESH_DOUYIN_ACCOUNT_INFO'
        };
        const accountRefreshAction = accountRefreshActions[task.expectedAccount?.platformKey];
        const accountResult = accountRefreshAction
          ? await requestExtension(accountRefreshAction, {}, 10000)
          : await requestExtension('MULTIPOST_EXTENSION_GET_ACCOUNT_INFOS');
        if (accountResult.error) throw new Error(accountResult.error);
        if (!accountMatches(task.expectedAccount, accountResult.accountInfo || {})) {
          const actualAccount = accountResult.accountInfo?.[task.expectedAccount?.platformKey];
          throw new Error(
            '当前 Chrome 登录账号与飞书绑定账号不一致，已停止发布。'
            + '飞书绑定账号：' + accountLabel(task.expectedAccount) + '；'
            + 'Chrome 实际账号：' + accountLabel(actualAccount)
          );
        }
        setStatus('校验通过，正在提交给 MultiPost 扩展并打开平台发布页……');
        notifyExtension('MULTIPOST_EXTENSION_PUBLISH', task.payload);
        await new Promise((resolve) => setTimeout(resolve, 1200));
        await post('/api/multipost/publish-task/dispatched', { taskId });
        setStatus('已提交到 MultiPost。扩展将上传视频并执行平台发布，请勿关闭新打开的发布页面。', 'success');
      } catch (error) {
        if (claimed) {
          try {
            await post('/api/multipost/publish-task/failed', {
              taskId,
              error: error.message || String(error)
            });
          } catch {}
        }
        setStatus(error.message || String(error), 'error');
      }
    }

    dispatch();
  </script>
</body>
</html>`;
}

function readJsonBody(request, maxBytes = 128 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('请求内容过大'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(new Error('无效的 JSON 请求'));
      }
    });
    request.on('error', reject);
  });
}

function isValidRecordId(value) {
  return /^rec[A-Za-z0-9_-]{6,64}$/.test(String(value || ''));
}

function createAccountServer(options = {}) {
  const update = options.updatePlatformAccount || updatePlatformAccount;
  const updatePublish = options.updatePlatformPublish || updatePlatformPublish;
  const readTask = options.readPublishTask || readPublishTask;
  const claimTask = options.claimPublishTask || claimPublishTask;
  const markDispatched = options.markPublishTaskDispatched || markPublishTaskDispatched;
  const markFailed = options.markPublishTaskFailed || markPublishTaskFailed;
  const findDispatchedTask = options.findLatestDispatchedPublishTask || findLatestDispatchedPublishTask;
  const markSucceeded = options.markPublishTaskSucceeded || markPublishTaskSucceeded;
  const apiConfigHandler = options.apiConfigHandler || null;
  return http.createServer(async (request, response) => {
    const host = request.headers.host || `127.0.0.1:${DEFAULT_PORT}`;
    const url = new URL(request.url || '/', `http://${host}`);

    if (apiConfigHandler) {
      try {
        if (await apiConfigHandler(request, response, url)) return;
      } catch (error) {
        jsonResponse(response, 500, { ok: false, error: error.message || String(error) });
        return;
      }
    }

    if (request.method === 'GET' && url.pathname === '/health') {
      jsonResponse(response, 200, { ok: true, service: 'multipost-account' });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/multipost/account') {
      const recordId = url.searchParams.get('record_id') || '';
      const platformName = url.searchParams.get('platform') || '';
      if (!isValidRecordId(recordId) || !platformKeyFor(platformName)) {
        htmlResponse(response, 400, '<h1>链接参数无效</h1><p>请返回飞书重新选择平台后再点击链接。</p>');
        return;
      }
      htmlResponse(response, 200, accountPage({ recordId, platformName }));
      return;
    }

    if (request.method === 'GET' && url.pathname === '/multipost/publish') {
      const taskId = url.searchParams.get('task_id') || '';
      const task = isValidTaskId(taskId) ? readTask(taskId) : null;
      if (!task) {
        htmlResponse(response, 404, '<h1>发布任务不存在</h1><p>请返回飞书检查 MultiPost任务ID 和发布状态。</p>');
        return;
      }
      htmlResponse(response, 200, publishPage(taskId));
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/multipost/account') {
      if ((request.headers['content-type'] || '').split(';')[0] !== 'application/json') {
        jsonResponse(response, 415, { ok: false, error: '仅接受 JSON 请求' });
        return;
      }
      try {
        const body = await readJsonBody(request);
        if (!isValidRecordId(body.recordId)) throw new Error('飞书记录 ID 无效');
        const patch = buildAccountPatch(body.platformName, body.accountInfo);
        await Promise.resolve(update(body.recordId, patch));
        jsonResponse(response, 200, { ok: true, patch });
      } catch (error) {
        jsonResponse(response, 400, { ok: false, error: error.message || String(error) });
      }
      return;
    }

    const publishTaskAction = request.method === 'POST'
      ? url.pathname.match(/^\/api\/multipost\/publish-task\/(claim|dispatched|failed|succeeded)$/)
      : null;
    if (publishTaskAction) {
      if ((request.headers['content-type'] || '').split(';')[0] !== 'application/json') {
        jsonResponse(response, 415, { ok: false, error: '仅接受 JSON 请求' });
        return;
      }
      try {
        const body = await readJsonBody(request);
        const action = publishTaskAction[1];
        if (action === 'succeeded') {
          const matching = findDispatchedTask({
            platformKey: body.platformKey,
            titleText: body.titleText,
          });
          if (!matching) throw new Error('未找到与平台结果匹配的待回写 MultiPost 任务');
          const publishedAt = String(body.publishedAt || '').trim() || feishuDateTime();
          const task = markSucceeded(matching.taskId, {
            publishedAt,
            workUrl: body.workUrl,
          });
          if (!task) throw new Error('无法完成 MultiPost 发布任务');
          const patch = {
            '发布状态': '发布成功',
            '实际发布时间': publishedAt,
            '失败原因': null,
          };
          if (task.workUrl) patch['作品链接'] = task.workUrl;
          await Promise.resolve(updatePublish(task.recordId, patch));
          jsonResponse(response, 200, { ok: true, task });
          return;
        }

        if (!isValidTaskId(body.taskId)) throw new Error('MultiPost 本地任务 ID 无效');
        if (action === 'claim') {
          const task = claimTask(body.taskId);
          if (!task) {
            jsonResponse(response, 409, { ok: false, error: '任务已被处理或不可重复发布' });
            return;
          }
          jsonResponse(response, 200, { ok: true, task });
          return;
        }

        if (action === 'dispatched') {
          const task = markDispatched(body.taskId);
          if (!task) throw new Error('无法确认 MultiPost 任务已提交');
          await Promise.resolve(updatePublish(task.recordId, {
            '发布状态': '发布中',
            '失败原因': null,
          }));
          jsonResponse(response, 200, { ok: true, task });
          return;
        }

        const task = markFailed(body.taskId, body.error);
        if (!task) throw new Error('无法记录 MultiPost 发布失败');
        await Promise.resolve(updatePublish(task.recordId, {
          '发布状态': '发布失败',
          '失败原因': String(task.error || body.error || '未知错误').slice(0, 1000),
        }));
        jsonResponse(response, 200, { ok: true, task });
      } catch (error) {
        jsonResponse(response, 400, { ok: false, error: error.message || String(error) });
      }
      return;
    }

    jsonResponse(response, 404, { ok: false, error: 'Not found' });
  });
}

function start() {
  const port = Number(CONFIG.multipost_account_port) || DEFAULT_PORT;
  const server = createAccountServer({ apiConfigHandler: createDefaultApiConfigHandler() });
  server.listen(port, '127.0.0.1', () => {
    process.stdout.write(`MultiPost account server listening on http://127.0.0.1:${port}\n`);
  });
  return server;
}

if (require.main === module) start();

module.exports = {
  DEFAULT_PORT,
  PLATFORM_KEYS,
  accountPage,
  buildAccountPatch,
  buildMinimalAccountInfo,
  createAccessBaseClient,
  createAccountServer,
  createDefaultApiConfigHandler,
  feishuDateTime,
  isValidRecordId,
  platformKeyFor,
  platformLoginUrl,
  publishPage,
  rowFromRecordEnvelope,
  start,
  updatePlatformPublish,
};
