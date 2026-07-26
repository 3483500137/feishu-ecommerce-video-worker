'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { isPlaceholder, loadConfig, resolveConfigPath, validateConfig } = require('../src/project-config');
const { resolveLarkCli } = require('../src/lark-cli');

const ROOT = path.resolve(__dirname, '..');

function defaultCommandExists(command) {
  if (path.isAbsolute(command) && fs.existsSync(command)) return true;
  const locator = process.platform === 'win32' ? 'where.exe' : 'which';
  const result = spawnSync(locator, [command], { encoding: 'utf8', windowsHide: true });
  return result.status === 0 && Boolean(String(result.stdout || '').trim());
}

function inspectSetup({
  config,
  configExists,
  env = process.env,
  commandExists = defaultCommandExists,
  larkCliAvailable,
  nodeVersion = process.versions.node,
} = {}) {
  const items = [];
  const add = (level, name, message) => items.push({ level, name, message });
  const major = Number(String(nodeVersion).split('.')[0]);
  add(major >= 20 ? 'ok' : 'error', 'Node.js', major >= 20 ? `v${nodeVersion}` : '需要 Node.js 20 或更高版本');
  add(configExists ? 'ok' : 'error', 'config.json', configExists ? '已找到' : '未找到，请复制 config.example.json');

  const enabledFeatures = ['core'];
  if (config?.access_api_table_id) enabledFeatures.push('api-routing');
  if (config?.relay_content_table_id) enabledFeatures.push('relay');
  if (config?.ltx_content_table_id || config?.ltx_base_url) enabledFeatures.push('ltx');
  if (config?.platform_account_table_id || config?.platform_publish_table_id) enabledFeatures.push('publishing');
  for (const message of validateConfig(config, { features: enabledFeatures, env })) {
    const name = message.match(/(?:配置项|环境变量)\s+([^\s]+)/)?.[1] || '配置';
    add('error', name, message);
  }
  for (const name of ['base_token', 'persona_table_id', 'content_table_id', 'persona_image_attachment_field_id']) {
    if (!isPlaceholder(config?.[name]) && !items.some((item) => item.name === name)) add('ok', name, '已配置');
  }
  for (const name of ['KIMI_API_KEY', 'XYQ_ACCESS_KEY', 'NEWAPI_API_KEY']) {
    add(isPlaceholder(env?.[name]) ? 'warning' : 'ok', name,
      isPlaceholder(env?.[name]) ? '未设置；使用“接入API”本机密钥时不需要' : '已设置（迁移后可删除）');
  }

  add(larkCliAvailable ? 'ok' : 'error', 'lark-cli', larkCliAvailable ? '已安装' : '未找到 @larksuite/cli');
  for (const command of [config?.yt_dlp_command || 'yt-dlp', 'ffmpeg']) {
    add(commandExists(command) ? 'ok' : 'error', command, commandExists(command) ? '可执行' : '未找到可执行文件');
  }
  add(commandExists('cloudflared') ? 'ok' : 'warning', 'cloudflared', commandExists('cloudflared') ? '可执行' : '仅 LTX 首尾帧模式需要');
  add(fs.existsSync(path.join(ROOT, 'vendor', 'MultiPost-1.3.8', 'manifest.json')) ? 'ok' : 'warning', 'MultiPost', '仅自动发布模块需要');
  return { ok: !items.some((item) => item.level === 'error'), items };
}

function main() {
  const configArgIndex = process.argv.indexOf('--config');
  if (configArgIndex !== -1 && process.argv[configArgIndex + 1]) {
    process.env.FEISHU_ACCOUNT_CLONER_CONFIG = path.resolve(process.argv[configArgIndex + 1]);
  }
  const configPath = resolveConfigPath({ root: ROOT });
  const config = loadConfig({ root: ROOT });
  let larkCliAvailable = true;
  try { resolveLarkCli({ root: ROOT }); } catch { larkCliAvailable = false; }
  const report = inspectSetup({ config, configExists: fs.existsSync(configPath), larkCliAvailable });
  const icons = { ok: '✓', warning: '!', error: '×' };
  for (const item of report.items) process.stdout.write(`${icons[item.level]} ${item.name}: ${item.message}\n`);
  process.stdout.write(report.ok ? '\n自检通过，可以启动 Worker。\n' : '\n自检未通过，请修复标记为 × 的项目。\n');
  if (!report.ok) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = { defaultCommandExists, inspectSetup };
