'use strict';

const STANDARD_WORKFLOW_TABLES = Object.freeze([
  'workflow_config_table_id', 'skill_registry_table_id', 'business_task_table_id', 'task_run_table_id',
  'task_event_table_id', 'artifact_table_id', 'member_authorization_table_id', 'metrics_table_id',
]);

function validateWorkflowBaseConfig(config = {}) {
  const missing = STANDARD_WORKFLOW_TABLES.filter((name) => !String(config[name] || '').trim());
  if (missing.length) throw new Error(`工作流Base配置缺少：${missing.join('、')}`);
  return { ...config };
}

function createFeishuWorkflowStore({ baseToken, tables, createRecord, updateRecord, listRecords }) {
  if (!baseToken) throw new Error('缺少飞书Base token');
  validateWorkflowBaseConfig(tables);
  return {
    async createRun(run) {
      await createRecord(tables.task_run_table_id, {
        '运行ID': run.id, '工作流ID': run.workflow_id, '工作流版本': run.workflow_version,
        '状态': run.state, '输入（内部）': JSON.stringify(run.input), '来源': run.source,
        '幂等键': run.idempotency_key, '创建人ID（内部）': run.created_by, '创建时间': run.created_at,
      });
      return { ...run };
    },
    async getRun(runId) {
      const rows = await listRecords(tables.task_run_table_id, ['运行ID', '工作流ID', '工作流版本', '状态', '输入（内部）', '来源', '幂等键', '创建人ID（内部）', '创建时间', '更新时间']);
      const row = rows.find((candidate) => candidate['运行ID'] === runId);
      if (!row) return null;
      let input = {};
      try { input = JSON.parse(row['输入（内部）'] || '{}'); } catch {}
      return {
        id: runId, record_id: row.record_id, workflow_id: row['工作流ID'], workflow_version: row['工作流版本'], state: row['状态'],
        input, source: row['来源'] || '', idempotency_key: row['幂等键'] || '', created_by: row['创建人ID（内部）'] || '',
        created_at: row['创建时间'] || '', updated_at: row['更新时间'] || '',
      };
    },
    async updateRun(runId, patch) {
      const current = await this.getRun(runId);
      if (!current) throw new Error('未找到工作流运行记录');
      await updateRecord(tables.task_run_table_id, current.record_id, { '状态': patch.state, '更新时间': patch.updated_at });
      return { id: runId, ...patch };
    },
    async appendEvent(event) {
      await createRecord(tables.task_event_table_id, {
        '事件ID': event.id, '运行ID': event.run_id, '事件类型': event.type, '操作者ID（内部）': event.actor_id,
        '发生时间': event.at, '幂等键': event.idempotency_key || '', '载荷（内部）': JSON.stringify(event.payload || {}),
      });
      return { ...event };
    },
    async listEvents(runId) {
      const rows = await listRecords(tables.task_event_table_id, ['运行ID', '事件类型', '幂等键']);
      return rows.filter((row) => row['运行ID'] === runId).map((row) => ({ run_id: runId, type: row['事件类型'], idempotency_key: row['幂等键'] || '' }));
    },
    async recordMetric(metric) { await createRecord(tables.metrics_table_id, { '运行ID': metric.run_id, '事件': metric.event, '记录时间': metric.at }); return { ...metric }; },
  };
}

function firstOption(value) {
  if (Array.isArray(value)) return String(typeof value[0] === 'string' ? value[0] : value[0]?.name || '').trim();
  return String(value || '').trim();
}

function optionValues(value) {
  return Array.isArray(value)
    ? value.map((item) => String(typeof item === 'string' ? item : item?.name || '').trim()).filter(Boolean)
    : String(value || '').trim().split(/[，,\s]+/).filter(Boolean);
}

function createFeishuMemberAuthorizer({ tableId, listRecords }) {
  if (!tableId) throw new Error('缺少成员授权表ID');
  return async ({ actorId, workflowId, action }) => {
    const rows = await listRecords(tableId, ['飞书OpenID', '是否启用', '可访问工作流', '是否可审批']);
    const member = rows.find((row) => String(row['飞书OpenID'] || '').trim() === String(actorId || '').trim());
    if (!member || firstOption(member['是否启用']) !== '是') return false;
    const workflows = optionValues(member['可访问工作流']);
    if (!workflows.includes(workflowId)) return false;
    return !['approve', 'reject'].includes(action) || firstOption(member['是否可审批']) === '是';
  };
}

module.exports = { STANDARD_WORKFLOW_TABLES, createFeishuMemberAuthorizer, createFeishuWorkflowStore, validateWorkflowBaseConfig };
