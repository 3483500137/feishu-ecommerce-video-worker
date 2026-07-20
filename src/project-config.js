'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_CONFIG = Object.freeze({
  kimi_base_url: 'https://api.moonshot.cn/v1',
  kimi_model: 'kimi-k2.6',
  xyq_base_url: 'https://xyq.jianying.com',
  ltx_base_url: '',
  poll_interval_seconds: 10,
  max_poll_minutes: 180,
  multipost_account_port: 17386,
  yt_dlp_command: 'yt-dlp',
});

function resolveConfigPath({ root = path.resolve(__dirname, '..'), env = process.env } = {}) {
  return path.resolve(env.FEISHU_ACCOUNT_CLONER_CONFIG || path.join(root, 'config.json'));
}

function loadConfig({ root = path.resolve(__dirname, '..'), env = process.env, required = false } = {}) {
  const configPath = resolveConfigPath({ root, env });
  if (!fs.existsSync(configPath)) {
    if (required) {
      throw new Error(`未找到配置文件：${configPath}。请复制 config.example.json 为 config.json 后填写。`);
    }
    return { ...DEFAULT_CONFIG };
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (error) {
    throw new Error(`配置文件无法解析：${configPath}（${error.message}）`);
  }
  return { ...DEFAULT_CONFIG, ...parsed };
}

function isPlaceholder(value) {
  if (value === null || value === undefined || value === '') return true;
  return /^(your[_-]|example\b|change[_-]?me)|:\/\/(your[-_]|example\.)/i.test(String(value).trim());
}

function validateConfig(config, { features = ['core'], env = process.env } = {}) {
  const errors = [];
  const requiredFields = new Set();
  const requiredEnv = new Set();
  if (features.includes('core')) {
    ['base_token', 'persona_table_id', 'content_table_id', 'persona_image_attachment_field_id']
      .forEach((field) => requiredFields.add(field));
    ['KIMI_API_KEY', 'XYQ_ACCESS_KEY'].forEach((field) => requiredEnv.add(field));
  }
  if (features.includes('ltx')) {
    ['ltx_content_table_id', 'ltx_final_video_attachment_field_id', 'ltx_base_url']
      .forEach((field) => requiredFields.add(field));
    requiredEnv.add('NEWAPI_API_KEY');
  }
  if (features.includes('publishing')) {
    ['platform_account_table_id', 'platform_publish_table_id']
      .forEach((field) => requiredFields.add(field));
  }
  for (const field of requiredFields) {
    if (isPlaceholder(config?.[field])) errors.push(`配置项 ${field} 未填写`);
  }
  for (const field of requiredEnv) {
    if (isPlaceholder(env?.[field])) errors.push(`环境变量 ${field} 未设置`);
  }
  return errors;
}

function assertValidConfig(config, options) {
  const errors = validateConfig(config, options);
  if (errors.length) throw new Error(`配置检查失败：\n- ${errors.join('\n- ')}`);
  return config;
}

module.exports = {
  DEFAULT_CONFIG,
  assertValidConfig,
  isPlaceholder,
  loadConfig,
  resolveConfigPath,
  validateConfig,
};
