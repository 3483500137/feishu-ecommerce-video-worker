'use strict';

const { randomUUID } = require('node:crypto');

class WorkflowRuntimeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WorkflowRuntimeError';
    this.code = code;
  }
}

function assertString(value, label) {
  if (!String(value || '').trim()) throw new WorkflowRuntimeError('INVALID_DEFINITION', `${label}不能为空`);
}

function validateWorkflowDefinition(definition = {}) {
  assertString(definition.id, '工作流ID');
  assertString(definition.version, '工作流版本');
  assertString(definition.initial_state, '初始状态');
  if (!Array.isArray(definition.states) || !definition.states.length) {
    throw new WorkflowRuntimeError('INVALID_DEFINITION', '工作流至少需要一个状态');
  }
  if (!definition.states.includes(definition.initial_state)) {
    throw new WorkflowRuntimeError('INVALID_DEFINITION', '初始状态必须出现在状态列表中');
  }
  if (!Array.isArray(definition.transitions)) {
    throw new WorkflowRuntimeError('INVALID_DEFINITION', '工作流必须声明状态迁移');
  }
  definition.transitions.forEach((transition, index) => {
    assertString(transition.event, `迁移${index + 1}的事件`);
    assertString(transition.from, `迁移${index + 1}的起始状态`);
    assertString(transition.to, `迁移${index + 1}的目标状态`);
    if (!definition.states.includes(transition.from) || !definition.states.includes(transition.to)) {
      throw new WorkflowRuntimeError('INVALID_DEFINITION', `迁移${index + 1}引用了未声明状态`);
    }
  });
  return Object.freeze({ ...definition, states: [...definition.states], transitions: [...definition.transitions] });
}

class MemoryWorkflowStore {
  constructor() {
    this.runs = new Map();
    this.events = new Map();
    this.metrics = [];
    this.decisions = [];
  }

  async createRun(run) {
    this.runs.set(run.id, { ...run });
    this.events.set(run.id, []);
    return { ...run };
  }

  async getRun(runId) {
    const run = this.runs.get(runId);
    return run ? { ...run } : null;
  }

  async updateRun(runId, patch) {
    const run = this.runs.get(runId);
    if (!run) throw new WorkflowRuntimeError('RUN_NOT_FOUND', '未找到任务运行记录');
    const updated = { ...run, ...patch };
    this.runs.set(runId, updated);
    return { ...updated };
  }

  async appendEvent(event) {
    const events = this.events.get(event.run_id) || [];
    events.push({ ...event });
    this.events.set(event.run_id, events);
    return { ...event };
  }

  async listEvents(runId) {
    return [...(this.events.get(runId) || [])].map((event) => ({ ...event }));
  }

  async recordMetric(metric) {
    this.metrics.push({ ...metric });
    return { ...metric };
  }

  async recordDecision(decision) {
    this.decisions.push({ ...decision });
    return { ...decision };
  }
}

class WorkflowRuntime {
  constructor({ store = new MemoryWorkflowStore(), now = () => new Date(), authorize = () => true, skills = null } = {}) {
    this.store = store;
    this.now = now;
    this.authorize = authorize;
    this.skills = skills;
    this.workflows = new Map();
  }

  register(definition) {
    const workflow = validateWorkflowDefinition(definition);
    this.workflows.set(workflow.id, workflow);
    return workflow;
  }

  workflow(workflowId) {
    const workflow = this.workflows.get(workflowId);
    if (!workflow) throw new WorkflowRuntimeError('WORKFLOW_NOT_FOUND', `未安装工作流：${workflowId}`);
    return workflow;
  }

  async createRun({ workflowId, actorId, input = {}, idempotencyKey = '', source = 'api' } = {}) {
    const workflow = this.workflow(workflowId);
    if (!(await this.authorize({ actorId, workflowId, action: 'create' }))) {
      throw new WorkflowRuntimeError('UNAUTHORIZED', '当前成员无权创建此工作流任务');
    }
    if (workflow.requires_discovery && !input.workflow_brief_approved) {
      throw new WorkflowRuntimeError('DISCOVERY_REQUIRED', '请先完成并审批 Workflow Brief');
    }
    const timestamp = this.now().toISOString();
    const run = await this.store.createRun({
      id: randomUUID(), workflow_id: workflow.id, workflow_version: workflow.version,
      state: workflow.initial_state, input: { ...input }, source, idempotency_key: idempotencyKey,
      created_by: actorId || '', created_at: timestamp, updated_at: timestamp,
    });
    await this.store.appendEvent({
      id: randomUUID(), run_id: run.id, type: 'run.created', actor_id: actorId || '',
      at: timestamp, payload: { source, workflow_id: workflow.id },
    });
    return run;
  }

  async transition({ runId, event, actorId, payload = {}, idempotencyKey = '' } = {}) {
    const run = await this.store.getRun(runId);
    if (!run) throw new WorkflowRuntimeError('RUN_NOT_FOUND', '未找到任务运行记录');
    if (!(await this.authorize({ actorId, workflowId: run.workflow_id, action: event, run }))) {
      throw new WorkflowRuntimeError('UNAUTHORIZED', '当前成员无权操作此任务');
    }
    const existing = await this.store.listEvents(runId);
    if (idempotencyKey && existing.some((item) => item.idempotency_key === idempotencyKey)) return run;
    const workflow = this.workflow(run.workflow_id);
    const transition = workflow.transitions.find((candidate) => candidate.event === event && candidate.from === run.state);
    if (!transition) throw new WorkflowRuntimeError('INVALID_TRANSITION', `状态“${run.state}”不能执行“${event}”`);
    if (transition.requires_human && !payload.human_confirmed) {
      throw new WorkflowRuntimeError('HUMAN_CONFIRMATION_REQUIRED', '此操作需要人工确认');
    }
    const timestamp = this.now().toISOString();
    const updated = await this.store.updateRun(runId, { state: transition.to, updated_at: timestamp });
    await this.store.appendEvent({
      id: randomUUID(), run_id: runId, type: `transition.${event}`, actor_id: actorId || '', at: timestamp,
      idempotency_key: idempotencyKey, payload: { from: run.state, to: transition.to, ...payload },
    });
    if (transition.requires_human && typeof this.store.recordDecision === 'function') {
      await this.store.recordDecision({
        id: randomUUID(), run_id: runId, decision: event, actor_id: actorId || '', at: timestamp,
        from_state: run.state, to_state: transition.to, payload: { ...payload },
      });
    }
    if (transition.skill && this.skills) {
      const result = await this.skills.execute(transition.skill, { ...run.input, ...payload }, { run: updated, actor_id: actorId || '' });
      await this.store.appendEvent({
        id: randomUUID(), run_id: runId, type: 'skill.executed', actor_id: actorId || '', at: timestamp,
        payload: { skill_id: result.skill_id, skill_version: result.skill_version, status: result.status || '' },
      });
    }
    await this.store.recordMetric({ run_id: runId, workflow_id: run.workflow_id, event, at: timestamp });
    return updated;
  }
}

module.exports = { MemoryWorkflowStore, WorkflowRuntime, WorkflowRuntimeError, validateWorkflowDefinition };
