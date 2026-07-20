# 飞书账号复刻工具可移植化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 将现有飞书电商视频工作流整理为可在其他电脑部署、可安全开源的“飞书账号复刻工具”，并发布到 GitHub 仓库。

**Architecture:** 保留飞书多维表格作为任务入口，由本地 Node.js Worker 轮询并调用 Kimi、小云雀、LTX 与 MultiPost。把配置加载、飞书 CLI 调用和媒体上传抽成独立模块，消除对当前电脑绝对路径与私有 skill 的依赖；通过 schema-only 飞书模板和自检命令完成可重复部署。

**Tech Stack:** Node.js 20+、PowerShell、飞书 CLI、Node.js 原生 fetch/FormData、yt-dlp、FFmpeg、可选 Cloudflared、可选 Chrome + MultiPost。

## Global Constraints

- 不提交任何真实 API Key、飞书凭证、Base 数据或个人账号信息。
- 原生产目录保持不变，所有实现和验证在隔离 worktree 完成。
- 核心人设与视频生成功能可跨平台；MultiPost 自动发布功能标注为 Windows 可选模块。
- 所有配置错误必须在启动或自检时给出可操作提示，不得在模块导入阶段崩溃。

### Task 1: 可移植配置与飞书 CLI

**Files:**
- Create: `src/project-config.js`
- Create: `src/lark-cli.js`
- Create: `test/project-config.test.js`
- Create: `test/lark-cli.test.js`
- Modify: `src/worker.js`
- Modify: `src/multipost-account-server.js`
- Modify: `scripts/process-ltx-task.ps1`

**Steps:**
1. 先编写缺少 `config.json` 时仍可导入模块、支持 `FEISHU_ACCOUNT_CLONER_CONFIG` 覆盖路径的失败测试。
2. 实现默认配置合并、占位符检测和按功能验证。
3. 先编写飞书 CLI 路径解析测试，再实现环境变量、本项目依赖和常见全局安装路径解析。
4. 将 Worker、账号服务和 PowerShell 脚本改为运行时加载与验证配置。
5. 运行相关测试并确认旧测试不再依赖本机 `config.json`。

### Task 2: 内置小云雀上传与可移植媒体工具

**Files:**
- Create: `src/xyq-client.js`
- Create: `test/xyq-client.test.js`
- Modify: `src/worker.js`
- Modify: `config.example.json`

**Steps:**
1. 编写 multipart 上传字段、响应解析和错误脱敏测试。
2. 使用 Node.js 原生 `fetch`、`FormData`、`Blob` 实现上传，不再调用外部 Python skill。
3. 将调用链改为异步，并使用可配置的 `yt-dlp` 命令替代 Python 路径注入。
4. 改进 Cloudflared 的跨平台可执行文件发现。
5. 运行媒体相关单元测试。

### Task 3: 重命名、自检与一键启动

**Files:**
- Create: `scripts/doctor.js`
- Create: `test/doctor.test.js`
- Modify: `package.json`
- Modify: `run-worker.ps1`
- Modify: `scripts/install-scheduled-task.ps1`
- Modify: `scripts/install-media-relay-task.ps1`
- Modify: `scripts/install-multipost-account-task.ps1`

**Steps:**
1. 编写自检规则测试，覆盖 Node、配置、环境变量和外部命令。
2. 实现 `npm run doctor`，只显示变量名称和状态，绝不输出秘密值。
3. 将包名、显示名称和 Windows 计划任务名统一为“飞书账号复刻工具”。
4. 保留旧计划任务的显式迁移/卸载说明，避免重复运行。
5. 验证命令行帮助和失败提示。

### Task 4: 飞书模板与开源交付文件

**Files:**
- Add: `templates/feishu-account-cloner-template.base`
- Create: `LICENSE`
- Create: `SECURITY.md`
- Create: `THIRD_PARTY_NOTICES.md`
- Create: `vendor/MultiPost-1.3.8/LICENSE`
- Rewrite: `README.md`
- Modify: `.gitignore`

**Steps:**
1. 解压检查 schema-only Base 模板，确认不含记录、真实 token 或个人数据。
2. 添加 MIT 主许可证、MultiPost Apache-2.0 许可证与修改说明。
3. 重写 README，覆盖架构、导入模板、配置、运行、计划任务、可选模块和故障排查。
4. 确保 `config.json`、日志、下载媒体和本机状态不会进入版本库。

### Task 5: 全量验证与 GitHub 发布

**Files:**
- Verify: all tracked candidates

**Steps:**
1. 运行完整测试、`git diff --check`、自检示例和 npm 打包预览。
2. 扫描 API Key、token、手机号、绝对用户路径与 Base 数据。
3. 阅读并执行 verification-before-completion 与 finishing-a-development-branch 流程。
4. 明确暂存本次项目文件，提交并推送 `codex/portable-account-cloner`。
5. 创建 GitHub PR，并在确认开源内容安全后更新仓库描述与可见性。
