'use strict';

const { WorkflowRuntimeError } = require('./workflow/runtime');

function textFromFeishuContent(content) {
  if (typeof content !== 'string') return '';
  try {
    const parsed = JSON.parse(content);
    return String(parsed.text || parsed.content || '').trim();
  } catch {
    return content.trim();
  }
}

function actorIdFromEvent(event = {}) {
  return String(event.sender?.sender_id?.open_id || event.sender?.sender_id?.user_id || event.operator?.operator_id?.open_id || '').trim();
}

function parseBotCommand(text = '') {
  const content = String(text).trim();
  if (/^(?:\/)?(?:状态|status)\s+(.+)$/i.test(content)) return { type: 'status', runId: content.replace(/^(?:\/)?(?:状态|status)\s+/i, '').trim() };
  if (/^(?:\/)?(?:确认|confirm)\s+(.+)$/i.test(content)) return { type: 'approve', runId: content.replace(/^(?:\/)?(?:确认|confirm)\s+/i, '').trim() };
  if (/^(?:\/)?(?:驳回|reject)\s+(.+)$/i.test(content)) return { type: 'reject', runId: content.replace(/^(?:\/)?(?:驳回|reject)\s+/i, '').trim() };
  if (/^(?:\/)?(?:热点|hot)(?:\s|$)/i.test(content)) return { type: 'create', workflowId: 'hot-prompt-library', text: content.replace(/^(?:\/)?(?:热点|hot)(?:\s|$)/i, '').trim() };
  if (/^(?:\/)?(?:内容|content)(?:\s|$)/i.test(content)) return { type: 'create', workflowId: 'ecommerce-content', text: content.replace(/^(?:\/)?(?:内容|content)(?:\s|$)/i, '').trim() };
  return { type: 'create', workflowId: 'workflow-discovery', text: content };
}

class MessageDedupe {
  constructor() { this.ids = new Set(); }
  has(id) { return this.ids.has(id); }
  add(id) { if (id) this.ids.add(id); }
}

function formatRun(run) {
  return `任务已登记：${run.workflow_id}\n运行ID：${run.id}\n当前状态：${run.state}`;
}

function createBotGateway({ runtime, authorize = () => true, sendReply = async () => {}, dedupe = new MessageDedupe() } = {}) {
  if (!runtime) throw new Error('Bot Gateway需要WorkflowRuntime');

  async function handleCommand({ messageId, actorId, text, source = 'feishu-message' } = {}) {
    if (!messageId) throw new Error('飞书事件缺少message_id');
    if (dedupe.has(messageId)) return { duplicate: true };
    dedupe.add(messageId);
    if (!(await authorize(actorId))) {
      await sendReply({ messageId, text: '你没有访问此工作流机器人的权限。' });
      return { unauthorized: true };
    }
    const command = parseBotCommand(text);
    try {
      if (command.type === 'status') {
        const run = await runtime.store.getRun(command.runId);
        const response = run ? `运行ID：${run.id}\n工作流：${run.workflow_id}\n状态：${run.state}` : '未找到该任务运行记录。';
        await sendReply({ messageId, text: response });
        return { command, run };
      }
      if (command.type === 'approve' || command.type === 'reject') {
        const run = await runtime.transition({
          runId: command.runId, event: command.type, actorId, payload: { human_confirmed: true }, idempotencyKey: messageId,
        });
        await sendReply({ messageId, text: `任务已${command.type === 'approve' ? '确认' : '驳回'}，当前状态：${run.state}` });
        return { command, run };
      }
      const run = await runtime.createRun({
        workflowId: command.workflowId, actorId, source, idempotencyKey: messageId,
        input: { request_text: command.text, workflow_brief_approved: command.workflowId === 'workflow-discovery' },
      });
      await sendReply({ messageId, text: formatRun(run) });
      return { command, run };
    } catch (error) {
      const message = error instanceof WorkflowRuntimeError ? error.message : '机器人暂时无法处理该请求，请稍后重试。';
      await sendReply({ messageId, text: message });
      return { command, error };
    }
  }

  return {
    handleMessageEvent(event) {
      return handleCommand({
        messageId: event?.message?.message_id,
        actorId: actorIdFromEvent(event),
        text: textFromFeishuContent(event?.message?.content),
      });
    },
    handleCardAction(event) {
      const value = event?.action?.value || {};
      const eventName = value.action === 'approve' ? '确认' : value.action === 'reject' ? '驳回' : '状态';
      return handleCommand({ messageId: event?.open_message_id || event?.action?.request_id, actorId: actorIdFromEvent(event), text: `${eventName} ${value.run_id || ''}`, source: 'feishu-card' });
    },
    handleCommand,
  };
}

function startFeishuLongConnectionBot({ appId, appSecret, runtime, authorize, sdk } = {}) {
  if (!appId || !appSecret) throw new Error('缺少飞书机器人App ID或本机密钥');
  const lark = sdk || require('@larksuiteoapi/node-sdk');
  const client = new lark.Client({ appId, appSecret });
  const sendReply = async ({ messageId, text }) => client.im.message.reply({
    path: { message_id: messageId }, data: { msg_type: 'text', content: JSON.stringify({ text }) },
  });
  const gateway = createBotGateway({ runtime, authorize, sendReply });
  const dispatcher = new lark.EventDispatcher({})
    .register({ 'im.message.receive_v1': (data) => gateway.handleMessageEvent(data) })
    .register({ 'card.action.trigger': (data) => gateway.handleCardAction(data) });
  const wsClient = new lark.WSClient({ appId, appSecret });
  wsClient.start({ eventDispatcher: dispatcher });
  return { client, dispatcher, gateway, wsClient };
}

module.exports = { MessageDedupe, actorIdFromEvent, createBotGateway, parseBotCommand, startFeishuLongConnectionBot, textFromFeishuContent };
