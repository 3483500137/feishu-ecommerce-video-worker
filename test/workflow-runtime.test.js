'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { MemoryWorkflowStore, WorkflowRuntime, WorkflowRuntimeError, validateWorkflowDefinition } = require('../src/workflow/runtime');
const { SkillRegistry } = require('../src/workflow/skills');
const { createFeishuMemberAuthorizer } = require('../src/workflow/feishu-base');
const { WORKFLOW_TABLE_DEFINITIONS, provisionWorkflowBase } = require('../scripts/provision-workflow-base');

const definition = {
  id: 'sample', version: '1.0.0', initial_state: 'draft', states: ['draft', 'review', 'done'],
  transitions: [
    { event: 'submit', from: 'draft', to: 'review' },
    { event: 'approve', from: 'review', to: 'done', requires_human: true },
  ],
};

test('workflow runtime records creation, state transitions, metrics, and idempotent events', async () => {
  const store = new MemoryWorkflowStore();
  const runtime = new WorkflowRuntime({ store, authorize: () => true, now: () => new Date('2026-08-07T00:00:00.000Z') });
  runtime.register(definition);
  const run = await runtime.createRun({ workflowId: 'sample', actorId: 'user-1' });
  const review = await runtime.transition({ runId: run.id, event: 'submit', actorId: 'user-1', idempotencyKey: 'message-1' });
  const duplicate = await runtime.transition({ runId: run.id, event: 'submit', actorId: 'user-1', idempotencyKey: 'message-1' });
  assert.equal(review.state, 'review');
  assert.equal(duplicate.state, 'review');
  assert.equal((await store.listEvents(run.id)).length, 2);
  assert.equal(store.metrics.length, 1);
});

test('workflow runtime enforces human confirmation, authorization, and discovery prerequisites', async () => {
  const runtime = new WorkflowRuntime({ authorize: ({ actorId }) => actorId === 'allowed' });
  runtime.register({ ...definition, id: 'discovery-required', requires_discovery: true });
  await assert.rejects(() => runtime.createRun({ workflowId: 'discovery-required', actorId: 'allowed' }), (error) => error.code === 'DISCOVERY_REQUIRED');
  const run = await runtime.createRun({ workflowId: 'discovery-required', actorId: 'allowed', input: { workflow_brief_approved: true } });
  await runtime.transition({ runId: run.id, event: 'submit', actorId: 'allowed' });
  await assert.rejects(() => runtime.transition({ runId: run.id, event: 'approve', actorId: 'allowed' }), (error) => error.code === 'HUMAN_CONFIRMATION_REQUIRED');
  await assert.rejects(() => runtime.transition({ runId: run.id, event: 'approve', actorId: 'blocked', payload: { human_confirmed: true } }), (error) => error.code === 'UNAUTHORIZED');
  const approved = await runtime.transition({ runId: run.id, event: 'approve', actorId: 'allowed', payload: { human_confirmed: true } });
  assert.equal(approved.state, 'done');
  assert.equal(runtime.store.decisions.length, 1);
});

test('workflow and skill definitions validate their required contracts', async () => {
  assert.throws(() => validateWorkflowDefinition({}), WorkflowRuntimeError);
  const skills = new SkillRegistry();
  skills.register({ id: 'sample.skill', version: '1.0.0', name: 'Sample', permissions: [] }, async () => ({ status: 'ok' }));
  assert.deepEqual(await skills.execute('sample.skill', {}), { skill_id: 'sample.skill', skill_version: '1.0.0', status: 'ok' });
});

test('member authorization requires an enabled workflow grant and approval role', async () => {
  const authorize = createFeishuMemberAuthorizer({
    tableId: 'tbl-members',
    listRecords: async () => [{ '飞书OpenID': 'open-1', '是否启用': ['是'], '可访问工作流': ['sample'], '是否可审批': ['否'] }],
  });
  assert.equal(await authorize({ actorId: 'open-1', workflowId: 'sample', action: 'create' }), true);
  assert.equal(await authorize({ actorId: 'open-1', workflowId: 'other', action: 'create' }), false);
  assert.equal(await authorize({ actorId: 'open-1', workflowId: 'sample', action: 'approve' }), false);
  const incomplete = createFeishuMemberAuthorizer({
    tableId: 'tbl-members',
    listRecords: async () => [{ '飞书OpenID': 'open-2', '是否启用': [], '可访问工作流': [], '是否可审批': ['是'] }],
  });
  assert.equal(await incomplete({ actorId: 'open-2', workflowId: 'sample', action: 'create' }), false);
});

test('workflow Base provisioner creates only missing standard tables and returns a complete mapping', () => {
  const calls = [];
  let next = 1;
  const run = (args) => {
    calls.push(args);
    if (args[1] === '+base-block-list') return { blocks: [{ type: 'table', name: '工作流配置', id: 'tbl-existing' }] };
    return { table_id: `tbl-${next++}` };
  };
  const result = provisionWorkflowBase({ config: { base_token: 'base-token' }, run });
  assert.equal(WORKFLOW_TABLE_DEFINITIONS.length, 9);
  assert.equal(calls.filter((args) => args[1] === '+table-create').length, 8);
  assert.equal(result.workflow_base.workflow_config_table_id, 'tbl-existing');
  assert.equal(Object.keys(result.workflow_base).length, 9);
});
