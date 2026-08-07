# 飞书机器人工作流入口

## 作用

机器人运行在客户本机，通过飞书长连接接收单聊消息和群内 @ 消息，因此不需要把本机暴露为公网回调地址。它把消息转换为受限的工作流命令，由本地运行时处理并记录任务事件。

## 飞书应用配置

1. 在飞书开放平台创建企业自建应用并启用机器人能力。
2. 在事件订阅中选择“使用长连接接收事件”，订阅接收消息与卡片操作事件。
3. 开通机器人接收单聊消息、群内 @ 消息及发送回复所需的最小权限，并发布应用到目标成员。
4. 将 App ID 填入 `config.json` 的 `feishu_bot_app_id`。
5. 将 App Secret 以 `feishu_bot_secret_alias` 写入当前 Windows 用户的 DPAPI 凭证库；不要把它写入 Base、`config.json` 或聊天记录。
6. 在 `feishu_bot_allowed_open_ids` 中配置获准用户；生产环境还应同步维护 Base 的“成员授权”表。

## 启动

```powershell
npm install
powershell -ExecutionPolicy Bypass -File .\scripts\install-bot-gateway-task.ps1
```

手工启动用于诊断：

```powershell
npm run start:bot
```

## 用户命令

- 任意自然语言：创建“业务流程诊断”任务。
- `/内容 <需求>`：创建电商内容任务；该业务必须已有已审批的 Workflow Brief。
- `/热点 <方向或要求>`：创建热点提示词库任务；同样要求已审批的 Workflow Brief。
- `/状态 <运行ID>`：查询运行状态。
- `/确认 <运行ID>` 或 `/驳回 <运行ID>`：处理人工关卡。

所有生成、发布、删除等外部副作用仍由工作流状态和人工确认控制；机器人不会绕过它们。
