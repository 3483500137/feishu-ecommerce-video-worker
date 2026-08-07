'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createCredentialStore } = require('./credential-store');
const { startFeishuLongConnectionBot } = require('./bot-gateway');
const { WorkflowRuntime } = require('./workflow/runtime');
const { SkillRegistry } = require('./workflow/skills');
const { loadSkills } = require('./workflow/load-skills');

const ROOT = path.resolve(__dirname, '..');
const configPath = process.env.FEISHU_ACCOUNT_CLONER_CONFIG || path.join(ROOT, 'config.json');

function loadWorkflowPacks() {
  const root = path.join(ROOT, 'workflow-packs');
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => JSON.parse(fs.readFileSync(path.join(root, entry.name, 'workflow.json'), 'utf8')));
}

function main() {
  if (!fs.existsSync(configPath)) throw new Error(`未找到配置文件：${configPath}`);
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const store = createCredentialStore({ filePath: path.join(ROOT, 'runtime', 'credentials.json') });
  const secret = store.get(config.feishu_bot_secret_alias);
  if (!secret) throw new Error('未导入飞书机器人App Secret，请先写入本机DPAPI凭证库');
  const allowed = new Set(config.feishu_bot_allowed_open_ids || []);
  const runtime = new WorkflowRuntime({ authorize: ({ actorId }) => allowed.has(actorId), skills: loadSkills(new SkillRegistry()) });
  loadWorkflowPacks().forEach((workflow) => runtime.register(workflow));
  startFeishuLongConnectionBot({ appId: config.feishu_bot_app_id, appSecret: secret, runtime, authorize: (actorId) => allowed.has(actorId) });
  process.stdout.write('Feishu Bot Gateway connected through long connection.\n');
}

if (require.main === module) main();

module.exports = { loadWorkflowPacks, main };
