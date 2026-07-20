'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');
const {
  DEFAULT_STATE_PATH,
  DEFAULT_STORAGE_DIR,
  createMediaRequestHandler,
  extractTryCloudflareUrl,
} = require('./media-relay');

const ROOT = path.resolve(__dirname, '..');
const LOG_DIR = path.join(ROOT, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'media-relay.log');

function log(message) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const line = `${new Date().toISOString()} ${message}`;
  fs.appendFileSync(LOG_FILE, `${line}\n`, 'utf8');
  process.stdout.write(`${line}\n`);
}

function resolveCloudflaredPath(env = process.env) {
  if (env.CLOUDFLARED_PATH && fs.existsSync(env.CLOUDFLARED_PATH)) return env.CLOUDFLARED_PATH;
  const locator = process.platform === 'win32' ? 'where.exe' : 'which';
  const located = spawnSync(locator, ['cloudflared'], { encoding: 'utf8', windowsHide: true });
  const fromPath = String(located.stdout || '').split(/\r?\n/).find((entry) => entry && fs.existsSync(entry));
  if (fromPath) return fromPath;
  if (process.platform !== 'win32') {
    throw new Error('未找到 cloudflared，请先安装或设置 CLOUDFLARED_PATH');
  }
  const packagesRoot = path.join(env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Packages');
  if (fs.existsSync(packagesRoot)) {
    const packageDir = fs.readdirSync(packagesRoot)
      .find((name) => name.startsWith('Cloudflare.cloudflared_'));
    if (packageDir) {
      const candidate = path.join(packagesRoot, packageDir, 'cloudflared.exe');
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  throw new Error('未找到cloudflared，请先安装或设置CLOUDFLARED_PATH');
}

function writeState(statePath, state) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const temporaryPath = `${statePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(temporaryPath, statePath);
}

async function main() {
  const port = Number(process.env.MEDIA_RELAY_PORT || 17480);
  const statePath = process.env.MEDIA_RELAY_STATE_PATH || DEFAULT_STATE_PATH;
  const storageDir = process.env.MEDIA_RELAY_STORAGE_DIR || DEFAULT_STORAGE_DIR;
  fs.mkdirSync(storageDir, { recursive: true });
  const server = http.createServer(createMediaRequestHandler({ storageDir }));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  log(`本地媒体中继已监听 http://127.0.0.1:${port}`);

  const cloudflaredPath = resolveCloudflaredPath();
  const tunnel = spawn(cloudflaredPath, [
    'tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`,
  ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });

  let activeBaseUrl = '';
  const onOutput = (chunk) => {
    const text = chunk.toString('utf8');
    const baseUrl = extractTryCloudflareUrl(text);
    if (baseUrl && !activeBaseUrl) {
      activeBaseUrl = baseUrl;
      writeState(statePath, {
        baseUrl,
        port,
        relayPid: process.pid,
        tunnelPid: tunnel.pid,
        startedAt: new Date().toISOString(),
      });
      log(`Cloudflare临时中继已就绪 ${baseUrl}`);
    }
    for (const line of text.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)) {
      if (/\b(ERR|ERROR|WRN|WARN)\b/i.test(line)) log(`cloudflared: ${line}`);
    }
  };
  tunnel.stdout.on('data', onOutput);
  tunnel.stderr.on('data', onOutput);
  tunnel.on('error', (error) => {
    log(`cloudflared启动失败: ${error.message}`);
    process.exitCode = 1;
    server.close();
  });
  tunnel.on('exit', (code) => {
    log(`cloudflared已退出，代码 ${code}`);
    process.exitCode = code || 1;
    server.close();
  });

  const readinessTimer = setTimeout(() => {
    if (!activeBaseUrl) {
      log('等待Cloudflare临时地址超时');
      tunnel.kill();
    }
  }, 60000);
  readinessTimer.unref();

  const cleanup = () => {
    try {
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      if (state.relayPid === process.pid) fs.rmSync(statePath, { force: true });
    } catch {
      // State may not have been created yet.
    }
  };
  const shutdown = () => {
    cleanup();
    if (!tunnel.killed) tunnel.kill();
    server.close(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  process.once('exit', cleanup);
}

if (require.main === module) {
  main().catch((error) => {
    log(`媒体中继启动失败: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { main, resolveCloudflaredPath, writeState };
