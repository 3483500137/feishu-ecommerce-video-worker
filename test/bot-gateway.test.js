'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createBotGateway, parseBotCommand, textFromFeishuContent } = require('../src/bot-gateway');
const { WorkflowRuntime } = require('../src/workflow/runtime');

const discovery = {
  id: 'workflow-discovery', version: '1.0.0', initial_state: 'intake', states: ['intake', 'awaiting_approval', 'approved'],
  transitions: [{ event: 'submit', from: 'intake', to: 'awaiting_approval' }, { event: 'approve', from: 'awaiting_approval', to: 'approved', requires_human: true }],
};

test('bot gateway creates a run, deduplicates messages, and rejects unauthorized users', async () => {
  const replies = [];
  const runtime = new WorkflowRuntime({ authorize: ({ actorId }) => actorId === 'open-1' });
  runtime.register(discovery);
  const gateway = createBotGateway({ runtime, authorize: (actorId) => actorId === 'open-1', sendReply: async (reply) => replies.push(reply) });
  const event = { sender: { sender_id: { open_id: 'open-1' } }, message: { message_id: 'om-1', content: JSON.stringify({ text: '帮我诊断内容流程' }) } };
  const first = await gateway.handleMessageEvent(event);
  const duplicate = await gateway.handleMessageEvent(event);
  const denied = await gateway.handleMessageEvent({ sender: { sender_id: { open_id: 'open-2' } }, message: { message_id: 'om-2', content: JSON.stringify({ text: 'hello' }) } });
  assert.equal(first.run.workflow_id, 'workflow-discovery');
  assert.equal(duplicate.duplicate, true);
  assert.equal(denied.unauthorized, true);
  assert.equal(replies.length, 2);
});

test('bot commands and Feishu text content are parsed deterministically', () => {
  assert.deepEqual(parseBotCommand('/内容 做一条新品视频'), { type: 'create', workflowId: 'ecommerce-content', text: '做一条新品视频' });
  assert.deepEqual(parseBotCommand('/确认 run-1'), { type: 'approve', runId: 'run-1' });
  assert.equal(textFromFeishuContent(JSON.stringify({ text: '你好' })), '你好');
});
