'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MIME_TYPES = Object.freeze({
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
});

function redact(message, secret) {
  return String(message || '').split(String(secret || '')).join('[REDACTED]');
}

async function uploadXyqAsset(filePath, {
  baseUrl,
  accessKey,
  fetchImpl = fetch,
} = {}) {
  if (!baseUrl) throw new Error('配置项 xyq_base_url 未填写');
  if (!accessKey) throw new Error('环境变量 XYQ_ACCESS_KEY 未设置');
  if (!fs.existsSync(filePath)) throw new Error(`待上传文件不存在：${filePath}`);

  const bytes = fs.readFileSync(filePath);
  const fileName = path.basename(filePath);
  const mimeType = MIME_TYPES[path.extname(fileName).toLowerCase()] || 'application/octet-stream';
  const form = new FormData();
  form.append('accessKey', accessKey);
  form.append('file', new Blob([bytes], { type: mimeType }), fileName);

  let response;
  try {
    response = await fetchImpl(`${String(baseUrl).replace(/\/$/, '')}/api/biz/v1/skill/upload_file`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessKey}` },
      body: form,
    });
  } catch (error) {
    throw new Error(`小云雀上传请求失败：${redact(error.message, accessKey)}`);
  }
  const json = await response.json().catch(() => ({}));
  if (!response.ok || (json.ret !== undefined && String(json.ret) !== '0')) {
    throw new Error(`小云雀上传失败（HTTP ${response.status || 'unknown'}）`);
  }
  const assetId = json.data?.pippit_asset_id || json.data?.asset_id || json.asset_id;
  if (!assetId) throw new Error('小云雀上传成功，但响应中缺少 asset_id');
  return assetId;
}

module.exports = { uploadXyqAsset };
