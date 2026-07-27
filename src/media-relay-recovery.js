'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { DEFAULT_STATE_PATH, readRelayState } = require('./media-relay');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_TIMEOUT_MS = 60000;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function isHealthy(baseUrl, fetchImpl = globalThis.fetch) {
  try {
    const response = await fetchImpl(`${String(baseUrl).replace(/\/+$/, '')}/health`, {
      signal: AbortSignal.timeout(10000),
    });
    return Boolean(response.ok);
  } catch {
    return false;
  }
}

async function localRelayIsHealthy(port, fetchImpl = globalThis.fetch) {
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    return Boolean(response.ok);
  } catch {
    return false;
  }
}

async function localRelayPid(port, fetchImpl = globalThis.fetch) {
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/identity`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return null;
    const identity = await response.json();
    const pid = Number(identity?.relayPid);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function processIsAlive(pid) {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) return false;
  try {
    process.kill(numericPid, 0);
    return true;
  } catch {
    return false;
  }
}

function startRelayServer({ spawnImpl = spawn } = {}) {
  const child = spawnImpl(process.execPath, [path.join(ROOT, 'src', 'media-relay-server.js')], {
    cwd: ROOT,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref?.();
  return child;
}

async function waitForLocalRelayStop(port, { fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!await localRelayIsHealthy(port, fetchImpl)) return;
    await delay(250);
  }
  throw new Error('Cloudflare临时中继停止超时，无法安全重启');
}

async function waitForHealthyTunnel({
  statePath = DEFAULT_STATE_PATH,
  previousBaseUrl = '',
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  pollMs = 1000,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      const state = readRelayState(statePath);
      const changed = !previousBaseUrl || state.baseUrl !== previousBaseUrl;
      if (changed && await isHealthy(state.baseUrl, fetchImpl)) return state;
      lastError = changed ? `中继地址 ${state.baseUrl} 尚未就绪` : '中继仍在使用失效地址';
    } catch (error) {
      lastError = error.message;
    }
    await delay(pollMs);
  }
  throw new Error(`Cloudflare临时中继自动恢复超时: ${lastError || '未获得可访问地址'}`);
}

async function recoverMediaRelay({
  statePath = DEFAULT_STATE_PATH,
  state,
  fetchImpl = globalThis.fetch,
  spawnImpl = spawn,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const current = state || readRelayState(statePath);
  if (await isHealthy(current.baseUrl, fetchImpl)) return current;

  const localHealthy = await localRelayIsHealthy(current.port || 17480, fetchImpl);
  if (localHealthy && processIsAlive(current.relayPid)) {
    const localPid = await localRelayPid(current.port || 17480, fetchImpl);
    if (localPid !== Number(current.relayPid)) {
      throw new Error('本地中继身份无法确认，已停止自动重启以避免影响其他进程');
    }
    process.kill(Number(current.relayPid), 'SIGTERM');
    await waitForLocalRelayStop(current.port || 17480, { fetchImpl });
    startRelayServer({ spawnImpl });
    return waitForHealthyTunnel({
      statePath,
      previousBaseUrl: current.baseUrl,
      fetchImpl,
      timeoutMs,
    });
  }
  if (localHealthy && !processIsAlive(current.relayPid)) {
    throw new Error('本地中继端口被未知进程占用，无法安全重启 Cloudflare 临时中继');
  }

  // State may survive a reboot while both processes are gone.  Do not delete it:
  // the new server replaces it atomically once Cloudflare returns a new URL.
  if (!processIsAlive(current.relayPid)) startRelayServer({ spawnImpl });
  return waitForHealthyTunnel({
    statePath,
    previousBaseUrl: current.baseUrl,
    fetchImpl,
    timeoutMs,
  });
}

module.exports = {
  isHealthy,
  localRelayIsHealthy,
  localRelayPid,
  processIsAlive,
  recoverMediaRelay,
  startRelayServer,
  waitForLocalRelayStop,
  waitForHealthyTunnel,
};
