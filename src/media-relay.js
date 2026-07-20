'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { randomBytes: nodeRandomBytes } = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_STATE_PATH = path.join(ROOT, 'runtime', 'media-relay-state.json');
const DEFAULT_STORAGE_DIR = path.join(ROOT, 'runtime', 'media-relay');
const IMAGE_EXTENSIONS = new Set(['.avif', '.bmp', '.gif', '.jpeg', '.jpg', '.png', '.webp']);
const MIME_BY_EXTENSION = Object.freeze({
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
});

function safeSegment(value, fallback) {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || fallback;
}

function buildRelayAssetKey({ recordId, role, filePath, randomBytes = nodeRandomBytes }) {
  const extension = path.extname(filePath).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(extension)) throw new Error(`LTX只支持图片附件: ${path.basename(filePath)}`);
  const token = randomBytes(16).toString('hex');
  return `${safeSegment(recordId, 'record')}-${safeSegment(role, 'frame')}-${token}${extension}`;
}

function parseRelayAssetKeys(value) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (!value) return [];
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function extractTryCloudflareUrl(line) {
  return String(line || '').match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i)?.[0] || '';
}

function createMediaRequestHandler({ storageDir = DEFAULT_STORAGE_DIR } = {}) {
  return (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cache-Control', 'no-store');
    if (request.method !== 'GET') {
      response.writeHead(405, { Allow: 'GET' });
      response.end();
      return;
    }
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    if (pathname === '/health') {
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    const encodedKey = pathname.startsWith('/media/') ? pathname.slice('/media/'.length) : '';
    let assetKey = '';
    try {
      assetKey = decodeURIComponent(encodedKey);
    } catch {
      // Invalid URL encoding is treated as a missing asset.
    }
    const extension = path.extname(assetKey).toLowerCase();
    const validKey = /^[a-zA-Z0-9_-]+-[a-zA-Z0-9_-]+-[0-9a-f]{32}\.[a-z0-9]+$/.test(assetKey)
      && path.basename(assetKey) === assetKey
      && IMAGE_EXTENSIONS.has(extension);
    const filePath = validKey ? path.join(storageDir, assetKey) : '';
    if (!filePath || !fs.existsSync(filePath)) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, {
      'Content-Type': MIME_BY_EXTENSION[extension],
      'Content-Length': fs.statSync(filePath).size,
    });
    fs.createReadStream(filePath).pipe(response);
  };
}

function readRelayState(statePath) {
  let state;
  try {
    state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {
    throw new Error('Cloudflare临时中继尚未启动，请先运行媒体中继服务');
  }
  const baseUrl = String(state.baseUrl || '').replace(/\/+$/, '');
  if (!/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/i.test(baseUrl)) {
    throw new Error('Cloudflare临时中继状态无效，请重启媒体中继服务');
  }
  return { ...state, baseUrl };
}

function createRelayMediaStore({
  statePath = process.env.MEDIA_RELAY_STATE_PATH || DEFAULT_STATE_PATH,
  storageDir = process.env.MEDIA_RELAY_STORAGE_DIR || DEFAULT_STORAGE_DIR,
  randomBytes = nodeRandomBytes,
  fetchImpl = globalThis.fetch,
  healthAttempts = 5,
  healthRetryMs = 1500,
} = {}) {
  return {
    async upload(filePath, { recordId, role }) {
      const assetKey = buildRelayAssetKey({ recordId, role, filePath, randomBytes });
      const state = readRelayState(statePath);
      await fsp.mkdir(storageDir, { recursive: true });
      await fsp.copyFile(filePath, path.join(storageDir, assetKey));
      let healthError;
      for (let attempt = 1; attempt <= healthAttempts; attempt += 1) {
        try {
          const response = await fetchImpl(`${state.baseUrl}/health`, {
            signal: AbortSignal.timeout(10000),
          });
          if (!response.ok) throw new Error(`HTTP ${response.status || 'error'}`);
          healthError = null;
          break;
        } catch (error) {
          healthError = error;
          if (attempt < healthAttempts) {
            await new Promise((resolve) => setTimeout(resolve, healthRetryMs));
          }
        }
      }
      if (healthError) {
        await fsp.rm(path.join(storageDir, assetKey), { force: true });
        throw new Error(`Cloudflare临时中继不可访问: ${healthError.message}`);
      }
      return {
        assetKey,
        url: `${state.baseUrl}/media/${encodeURIComponent(assetKey)}`,
      };
    },
    async remove(assetKeys) {
      const keys = [...new Set((assetKeys || []).map(String).filter(Boolean))];
      await Promise.all(keys.map(async (assetKey) => {
        if (path.basename(assetKey) !== assetKey) return;
        await fsp.rm(path.join(storageDir, assetKey), { force: true });
      }));
    },
  };
}

module.exports = {
  DEFAULT_STATE_PATH,
  DEFAULT_STORAGE_DIR,
  IMAGE_EXTENSIONS,
  buildRelayAssetKey,
  createMediaRequestHandler,
  createRelayMediaStore,
  extractTryCloudflareUrl,
  parseRelayAssetKeys,
  readRelayState,
};
