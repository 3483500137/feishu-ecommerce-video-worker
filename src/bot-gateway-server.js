'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createCredentialStore } = require('./credential-store');
const { startFeishuLongConnectionBot } = require('./bot-gateway');
const { WorkflowRuntime } = require('./workflow/runtime');
const { SkillRegistry } = require('./workflow/skills');
const { loadSkills } = require('./workflow/load-skills');
const { createFeishuMemberAuthorizer, createFeishuWorkflowStore, validateWorkflowBaseConfig } = require('./workflow/feishu-base');
const { runLark } = require('./lark-cli');

const ROOT = path.resolve(__dirname, '..');
const configPath = process.env.FEISHU_ACCOUNT_CLONER_CONFIG || path.join(ROOT, 'config.json');

function loadWorkflowPacks() {
  const root = path.join(ROOT, 'workflow-packs');
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => JSON.parse(fs.readFileSync(path.join(root, entry.name, 'workflow.json'), 'utf8')));
}

function rowsFromEnvelope(data = {}) {
  const fields = data.fields || [];
  return (data.data || []).map((values, index) => {
    const row = { record_id: data.record_id_list?.[index] || '' };
    fields.forEach((field, fieldIndex) => { row[field] = values[fieldIndex]; });
    return row;
  });
}

function createBaseTransport(config) {
  const listRecords = async (tableId, fields) => {
    const definitions = runLark(['base', '+field-list', '--base-token', config.base_token, '--table-id', tableId]).fields || [];
    const ids = fields.map((field) => definitions.find((definition) => definition.name === field)?.id || field);
    const args = ['base', '+record-list', '--base-token', config.base_token, '--table-id', tableId, '--limit', '200'];
    ids.forEach((id) => args.push('--field-id', id));
    return rowsFromEnvelope(runLark(args));
  };
  const createRecord = async (tableId, patch) => runLark(['base', '+record-upsert', '--base-token', config.base_token, '--table-id', tableId, '--json', JSON.stringify(patch)]);
  const updateRecord = async (tableId, recordId, patch) => runLark(['base', '+record-upsert', '--base-token', config.base_token, '--table-id', tableId, '--record-id', recordId, '--json', JSON.stringify(patch)]);
  return { createRecord, listRecords, updateRecord };
}

function main() {
  if (!fs.existsSync(configPath)) throw new Error(`未找到配置文件：${configPath}`);
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const store = createCredentialStore({ filePath: path.join(ROOT, 'runtime', 'credentials.json') });
  const secret = store.get(config.feishu_bot_secret_alias);
  if (!secret) throw new Error('未导入飞书机器人App Secret，请先写入本机DPAPI凭证库');
  const transport = createBaseTransport(config);
  const tables = validateWorkflowBaseConfig(config.workflow_base || {});
  const memberAuthorize = createFeishuMemberAuthorizer({ tableId: tables.member_authorization_table_id, listRecords: transport.listRecords });
  const runtime = new WorkflowRuntime({
    store: createFeishuWorkflowStore({ baseToken: config.base_token, tables, ...transport }),
    authorize: memberAuthorize,
    skills: loadSkills(new SkillRegistry()),
  });
  loadWorkflowPacks().forEach((workflow) => runtime.register(workflow));
  startFeishuLongConnectionBot({ appId: config.feishu_bot_app_id, appSecret: secret, runtime });
  process.stdout.write('Feishu Bot Gateway connected through long connection.\n');
}

if (require.main === module) main();

module.exports = { createBaseTransport, loadWorkflowPacks, main, rowsFromEnvelope };
