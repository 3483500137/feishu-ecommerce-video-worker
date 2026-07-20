'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function defaultGlobalRoots(env) {
  const roots = [];
  if (env.APPDATA) roots.push(path.join(env.APPDATA, 'npm', 'node_modules'));
  if (env.ProgramFiles) roots.push(path.join(env.ProgramFiles, 'nodejs', 'node_modules'));
  roots.push('/usr/local/lib/node_modules', '/usr/lib/node_modules');
  return roots;
}

function invocationFor(filePath) {
  return /\.m?js$/i.test(filePath)
    ? { command: process.execPath, prefixArgs: [filePath] }
    : { command: filePath, prefixArgs: [] };
}

function resolveLarkCli({
  root = path.resolve(__dirname, '..'),
  env = process.env,
  existsSync = fs.existsSync,
  globalRoots = defaultGlobalRoots(env),
} = {}) {
  const candidates = [];
  if (env.LARK_CLI_PATH) candidates.push(path.resolve(env.LARK_CLI_PATH));
  candidates.push(path.join(root, 'node_modules', '@larksuite', 'cli', 'scripts', 'run.js'));
  for (const globalRoot of globalRoots) {
    candidates.push(path.join(globalRoot, '@larksuite', 'cli', 'scripts', 'run.js'));
  }
  const selected = candidates.find((candidate) => existsSync(candidate));
  if (!selected) {
    throw new Error('未找到飞书 CLI。请运行 npm install --global @larksuite/cli，或设置 LARK_CLI_PATH。');
  }
  return invocationFor(selected);
}

function runLark(args, {
  root = path.resolve(__dirname, '..'),
  env = process.env,
  asUser = false,
  spawn = spawnSync,
} = {}) {
  const invocation = resolveLarkCli({ root, env });
  const cliArgs = [...invocation.prefixArgs, ...args];
  if (asUser) cliArgs.push('--as', 'user');
  cliArgs.push('--format', 'json');
  const result = spawn(invocation.command, cliArgs, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
    env,
  });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || 'lark-cli request failed').trim());
  }
  let envelope;
  try {
    envelope = JSON.parse(result.stdout.trim());
  } catch {
    throw new Error('飞书 CLI 返回了无法解析的结果，请确认 CLI 版本和登录状态。');
  }
  if (!envelope.ok) throw new Error(envelope.error?.message || '飞书 CLI 请求失败');
  return envelope.data;
}

module.exports = { resolveLarkCli, runLark };
