'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { runLark } = require('../src/lark-cli');

function text(name) {
  return { type: 'text', name };
}

function select(name, multiple, options) {
  return { type: 'select', name, multiple, options: options.map((option) => ({ name: option })) };
}

const WORKFLOW_TABLE_DEFINITIONS = Object.freeze([
  { configKey: 'workflow_config_table_id', name: '工作流配置', fields: [text('工作流ID'), text('版本'), text('清单JSON'), select('是否启用', false, ['是', '否'])] },
  { configKey: 'skill_registry_table_id', name: '技能注册', fields: [text('技能ID'), text('版本'), text('名称'), text('配置JSON'), select('是否启用', false, ['是', '否'])] },
  { configKey: 'business_task_table_id', name: '业务任务', fields: [text('业务任务ID'), text('工作流ID'), text('标题'), text('状态'), text('输入（内部）'), text('创建时间')] },
  { configKey: 'task_run_table_id', name: '任务运行', fields: [text('运行ID'), text('工作流ID'), text('工作流版本'), text('状态'), text('输入（内部）'), text('来源'), text('幂等键'), text('创建人ID（内部）'), text('创建时间'), text('更新时间')] },
  { configKey: 'task_event_table_id', name: '任务事件', fields: [text('事件ID'), text('运行ID'), text('事件类型'), text('操作者ID（内部）'), text('发生时间'), text('幂等键'), text('载荷（内部）')] },
  { configKey: 'artifact_table_id', name: '工件', fields: [text('工件ID'), text('运行ID'), text('类型'), text('名称'), text('URI'), text('元数据（内部）'), text('创建时间')] },
  { configKey: 'human_decision_table_id', name: '人工决策', fields: [text('决策ID'), text('运行ID'), text('决策'), text('决策人ID（内部）'), text('发生时间'), text('迁移前状态'), text('迁移后状态'), text('载荷（内部）')] },
  { configKey: 'member_authorization_table_id', name: '成员授权', fields: [text('飞书OpenID'), select('是否启用', false, ['是', '否']), select('可访问工作流', true, ['workflow-discovery', 'ecommerce-content', 'hot-prompt-library']), select('是否可审批', false, ['是', '否'])] },
  { configKey: 'metrics_table_id', name: '运行指标', fields: [text('运行ID'), text('工作流ID'), text('事件'), text('记录时间')] },
]);

function tableId(data = {}) {
  return data.table_id || data.table?.table_id || data.table?.id || '';
}

function provisionWorkflowBase({ config, run = runLark } = {}) {
  if (!String(config?.base_token || '').trim()) throw new Error('config.json 缺少 base_token');
  const blocks = run(['base', '+base-block-list', '--base-token', config.base_token], { asUser: true }).blocks || [];
  const existing = new Map(blocks.filter((block) => block.type === 'table').map((block) => [block.name, block.id]));
  const created = [];
  const workflowBase = {};
  for (const definition of WORKFLOW_TABLE_DEFINITIONS) {
    let id = existing.get(definition.name);
    if (!id) {
      const data = run([
        'base', '+table-create', '--base-token', config.base_token, '--name', definition.name,
        '--fields', JSON.stringify(definition.fields),
      ], { asUser: true });
      id = tableId(data);
      if (!id) throw new Error(`创建“${definition.name}”后未返回表ID`);
      created.push(definition.name);
    }
    workflowBase[definition.configKey] = id;
  }
  return { created, workflow_base: workflowBase };
}

function main() {
  const configPath = process.env.FEISHU_ACCOUNT_CLONER_CONFIG || path.resolve(__dirname, '..', 'config.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  process.stdout.write(`${JSON.stringify(provisionWorkflowBase({ config }), null, 2)}\n`);
}

if (require.main === module) main();

module.exports = { WORKFLOW_TABLE_DEFINITIONS, provisionWorkflowBase, tableId };
