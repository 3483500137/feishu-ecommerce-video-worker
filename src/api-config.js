'use strict';

const crypto = require('crypto');
const { normalizeAccessRecord } = require('./model-routing');
const { redact } = require('./provider-adapters');

function isValidRecordId(value) {
  return /^rec[A-Za-z0-9_-]{6,64}$/.test(String(value || ''));
}

function feishuDateTime(date = new Date()) {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).format(date);
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

function htmlResponse(response, statusCode, body, cookie = '') {
  const headers = {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-ancestors 'none'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  };
  if (cookie) headers['Set-Cookie'] = cookie;
  response.writeHead(statusCode, headers);
  response.end(body);
}

function readJsonBody(request, maxBytes = 64 * 1024) {
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
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject(new Error('无效的 JSON 请求')); }
    });
    request.on('error', reject);
  });
}

function safeJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
}

function firstOption(value) {
  if (!Array.isArray(value)) return String(value || '').trim();
  const first = value[0];
  if (typeof first === 'string') return first.trim();
  return String(first?.name || first?.text || '').trim();
}

function apiConfigPage({ row, csrfToken, masked }) {
  const access = normalizeAccessRecord(row);
  const data = safeJson({
    recordId: access.recordId,
    csrfToken,
    accessName: access.accessName,
    provider: access.provider,
    protocol: access.protocol,
    baseUrl: access.baseUrl,
    modelId: access.modelId,
    modelName: access.modelName,
    capabilities: access.capabilities,
    masked: masked || '',
  });
  return `<!doctype html>
<html lang="zh-CN"><head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="csrf-token" content="${csrfToken}"><title>配置模型接入</title>
  <style>
    :root{font-family:Inter,"Microsoft YaHei",system-ui,sans-serif;color:#1f2937;background:#f4f7fb}body{margin:0;padding:32px}main{max-width:720px;margin:auto;background:#fff;border:1px solid #e5e7eb;border-radius:18px;padding:30px;box-shadow:0 16px 50px #1f293712}h1{margin-top:0}dl{display:grid;grid-template-columns:130px 1fr;gap:8px 14px}dd{margin:0;word-break:break-all}label{display:block;margin:20px 0 8px}input{box-sizing:border-box;width:100%;padding:11px;border:1px solid #cbd5e1;border-radius:9px}button{margin:14px 8px 0 0;padding:10px 16px;border:0;border-radius:9px;background:#2563eb;color:#fff;cursor:pointer}.secondary{background:#eef2ff;color:#1d4ed8}.danger{background:#fef2f2;color:#b91c1c}#status{margin-top:18px;padding:13px;border-radius:10px;background:#eef4ff}#models label{margin:8px 0}#models input{width:auto;margin-right:8px}
  </style>
</head><body><main>
  <h1>配置模型接入</h1>
  <dl><dt>接入名称</dt><dd id="name"></dd><dt>供应商</dt><dd id="provider"></dd><dt>协议</dt><dd id="protocol"></dd><dt>接口地址</dt><dd id="base-url"></dd><dt>模型</dt><dd id="model"></dd><dt>本机密钥</dt><dd id="masked"></dd></dl>
  <label for="secret">导入或替换 API Key / Access Key</label><input id="secret" type="password" autocomplete="new-password" placeholder="密钥只会加密保存在当前电脑">
  <div><button id="save">保存到本机</button><button id="validate" class="secondary">验证并读取模型</button><button id="delete" class="danger">删除本机密钥</button></div>
  <section id="models"></section><button id="import" hidden>把勾选模型导入接入API表</button><p id="status">等待操作。</p>
  <script>
    const input=${data}; const statusNode=document.getElementById('status'); const modelsNode=document.getElementById('models'); const importNode=document.getElementById('import');
    document.getElementById('name').textContent=input.accessName||'未命名'; document.getElementById('provider').textContent=input.provider||'未填写'; document.getElementById('protocol').textContent=input.protocol||'未填写'; document.getElementById('base-url').textContent=input.baseUrl||'未填写'; document.getElementById('model').textContent=(input.modelName||input.modelId||'未填写'); document.getElementById('masked').textContent=input.masked||'未导入';
    async function post(path, extra={}){const response=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({recordId:input.recordId,csrfToken:input.csrfToken,...extra})});const body=await response.json();if(!response.ok||!body.ok)throw new Error(body.error||'操作失败');return body}
    function show(message,error=false){statusNode.textContent=message;statusNode.style.background=error?'#fef2f2':'#ecfdf3';statusNode.style.color=error?'#b91c1c':'#047857'}
    document.getElementById('save').onclick=async()=>{try{const secret=document.getElementById('secret').value;const result=await post('/api-config/save',{secret});document.getElementById('secret').value='';document.getElementById('masked').textContent=result.masked;show('密钥已加密保存，请继续验证。')}catch(error){show(error.message,true)}};
    document.getElementById('validate').onclick=async()=>{try{const result=await post('/api-config/validate');modelsNode.replaceChildren();for(const model of result.models||[]){const label=document.createElement('label');const box=document.createElement('input');box.type='checkbox';box.value=model.id;box.checked=model.id===input.modelId;label.append(box,document.createTextNode((model.name||model.id)+' ('+model.id+')'));modelsNode.append(label)}importNode.hidden=!(result.models||[]).length;show(result.modelFound?'验证成功，当前模型可用。':'密钥有效，但当前模型ID未出现在模型列表中。')}catch(error){show(error.message,true)}};
    importNode.onclick=async()=>{try{const modelIds=[...modelsNode.querySelectorAll('input:checked')].map(node=>node.value);const result=await post('/api-config/import-models',{modelIds});show('已在同一张接入API表创建 '+result.created+' 条模型记录。')}catch(error){show(error.message,true)}};
    document.getElementById('delete').onclick=async()=>{if(!confirm('确定删除当前电脑中的这条密钥？'))return;try{await post('/api-config/delete-secret');document.getElementById('masked').textContent='未导入';show('本机密钥已删除。')}catch(error){show(error.message,true)}};
  </script>
</main></body></html>`;
}

function createApiConfigHandler({ baseClient, credentialStore, adapterRegistry, now = () => new Date() }) {
  const sessions = new Map();

  function rejectForeignRequest(request, response) {
    const host = String(request.headers.host || '');
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/i.test(host)) {
      jsonResponse(response, 403, { ok: false, error: '仅允许本机访问' });
      return true;
    }
    const origin = String(request.headers.origin || '');
    if (origin && origin !== `http://${host}`) {
      jsonResponse(response, 403, { ok: false, error: '请求来源无效' });
      return true;
    }
    return false;
  }

  function validateCsrf(request, body) {
    const cookie = String(request.headers.cookie || '').split(';').map((item) => item.trim()).find((item) => item.startsWith('api_config_csrf='));
    const cookieToken = cookie ? decodeURIComponent(cookie.slice('api_config_csrf='.length)) : '';
    const token = String(body.csrfToken || '');
    const session = sessions.get(token);
    return Boolean(token && token === cookieToken && session && session.recordId === body.recordId && session.expiresAt > Date.now());
  }

  return async function apiConfigHandler(request, response, url) {
    if (!url.pathname.startsWith('/api-config')) return false;
    if (rejectForeignRequest(request, response)) return true;

    if (request.method === 'GET' && url.pathname === '/api-config') {
      const recordId = url.searchParams.get('record_id') || '';
      if (!isValidRecordId(recordId)) {
        htmlResponse(response, 400, '<h1>接入记录参数无效</h1><p>请返回飞书重新点击“配置接入”。</p>');
        return true;
      }
      const row = await baseClient.getAccessRecord(recordId);
      if (!row) {
        htmlResponse(response, 404, '<h1>接入记录不存在</h1>');
        return true;
      }
      row.record_id = recordId;
      const alias = String(row['本机密钥别名'] || `api:${recordId}`);
      const csrfToken = crypto.randomBytes(24).toString('base64url');
      sessions.set(csrfToken, { recordId, expiresAt: Date.now() + 30 * 60 * 1000 });
      const masked = credentialStore.metadata(alias)?.masked || '';
      htmlResponse(response, 200, apiConfigPage({ row, csrfToken, masked }), `api_config_csrf=${encodeURIComponent(csrfToken)}; HttpOnly; SameSite=Strict; Path=/api-config; Max-Age=1800`);
      return true;
    }

    if (request.method !== 'POST') {
      jsonResponse(response, 405, { ok: false, error: 'Method not allowed' });
      return true;
    }
    if ((request.headers['content-type'] || '').split(';')[0] !== 'application/json') {
      jsonResponse(response, 415, { ok: false, error: '仅接受 JSON 请求' });
      return true;
    }

    let body;
    try { body = await readJsonBody(request); }
    catch (error) { jsonResponse(response, 400, { ok: false, error: error.message }); return true; }
    if (!isValidRecordId(body.recordId) || !validateCsrf(request, body)) {
      jsonResponse(response, 403, { ok: false, error: '安全校验失败，请刷新配置页面' });
      return true;
    }

    const row = await baseClient.getAccessRecord(body.recordId);
    if (!row) { jsonResponse(response, 404, { ok: false, error: '接入记录不存在' }); return true; }
    row.record_id = body.recordId;
    const alias = String(row['本机密钥别名'] || `api:${body.recordId}`);

    try {
      if (url.pathname === '/api-config/save') {
        const metadata = credentialStore.set(alias, body.secret);
        const suffix = metadata.masked.slice(-4);
        await baseClient.updateAccessRecord(body.recordId, {
          本机密钥别名: alias,
          密钥尾号: suffix,
          验证状态: '待验证',
          失败原因: null,
        });
        jsonResponse(response, 200, { ok: true, masked: metadata.masked });
        return true;
      }

      if (url.pathname === '/api-config/delete-secret') {
        credentialStore.remove(alias);
        await baseClient.updateAccessRecord(body.recordId, { 密钥尾号: null, 验证状态: '未配置', 失败原因: null });
        jsonResponse(response, 200, { ok: true });
        return true;
      }

      const access = normalizeAccessRecord({ ...row, 本机密钥别名: alias });
      const secret = credentialStore.get(alias);
      if (!secret) throw new Error('尚未在当前电脑导入密钥');
      const adapter = adapterRegistry.get(access.protocol);

      if (url.pathname === '/api-config/validate') {
        const result = await adapter.validate(access, secret);
        await baseClient.updateAccessRecord(body.recordId, {
          验证状态: result.valid ? '有效' : '已失效',
          最近验证时间: feishuDateTime(now()),
          失败原因: result.valid ? null : '接口验证未通过',
        });
        jsonResponse(response, 200, { ok: true, modelFound: result.modelFound, models: result.models || [] });
        return true;
      }

      if (url.pathname === '/api-config/import-models') {
        const models = await adapter.listModels(access, secret);
        const selected = new Set(Array.isArray(body.modelIds) ? body.modelIds.map(String) : []);
        const matches = models.filter((model) => selected.has(model.id));
        for (const model of matches) {
          await baseClient.createAccessRecord({
            接入名称: `${access.accessName || access.provider} / ${model.name || model.id}`,
            服务商类型: access.provider,
            API协议: firstOption(row['API协议']),
            视频接口样式: firstOption(row['视频接口样式']),
            接口地址: access.baseUrl,
            模型名称: model.name || model.id,
            模型ID: model.id,
            模型能力: access.capabilities,
            本机密钥别名: alias,
            密钥尾号: credentialStore.metadata(alias)?.masked.slice(-4) || null,
            是否启用: '是',
            验证状态: '有效',
            最近验证时间: feishuDateTime(now()),
          });
        }
        jsonResponse(response, 200, { ok: true, created: matches.length });
        return true;
      }

      jsonResponse(response, 404, { ok: false, error: 'Not found' });
    } catch (error) {
      const safeError = redact(error.message || String(error), body.secret || '');
      if (url.pathname === '/api-config/validate') {
        try {
          await baseClient.updateAccessRecord(body.recordId, {
            验证状态: error.code === 'AUTH_FAILED' ? '已失效' : '待验证',
            最近验证时间: feishuDateTime(now()),
            失败原因: safeError.slice(0, 1000),
          });
        } catch {}
      }
      jsonResponse(response, error.code === 'AUTH_FAILED' ? 401 : 400, { ok: false, error: safeError });
    }
    return true;
  };
}

module.exports = {
  apiConfigPage,
  createApiConfigHandler,
  feishuDateTime,
  isValidRecordId,
};
