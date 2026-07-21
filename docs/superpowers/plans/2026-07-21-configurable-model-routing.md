# 可配置多模型接入与中转站生成 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让每位部署者安全导入自己的模型凭据，并在飞书各业务表按阶段选择模型完成文本、分析、图像和视频任务。

**Architecture:** “接入API”一行表示一个模型；本地 DPAPI 凭据库只保存密文；统一路由器把业务记录解析为接入、凭据和协议适配器。现有 Kimi、XYQ 和 LTX 调用逐步迁移，同时保留旧环境变量后备。

**Tech Stack:** Node.js CommonJS、Node test runner、飞书多维表、lark-cli、Windows PowerShell/DPAPI、本地 HTTP 服务。

## Global Constraints

- 一位部署者一套多维表和一个本地 Worker，不实现共享表多租户。
- 不新增模型表，不按模型新增内容表；接入API一行一个模型。
- API 密钥不得以明文进入飞书、config.json或日志。
- 中转站内容的画面比例默认 `9:16`。
- 明确选择模型后不得静默切换，旧字段与旧环境变量保持兼容。
- 不修改 `D:\一键多平台发布\MultiPost 1.3`。

---

### Task 1: 飞书表结构安装脚本与当前表升级

**Files:**
- Create: `scripts/configure-model-routing-base.ps1`
- Modify: `config.example.json`
- Test: `test/base-schema.test.js`

**Interfaces:**
- Consumes: `base_token`、现有七张表 ID。
- Produces: 幂等脚本 `configure-model-routing-base.ps1`，以及 `access_api_table_id`、`relay_content_table_id` 配置项。

- [ ] **Step 1: 写失败测试**

测试读取脚本文本并断言包含七张目标表、接入API核心字段、业务关联字段、中转站默认 `9:16`，且不包含字段删除命令。

- [ ] **Step 2: 运行失败测试**

Run: `node --test test/base-schema.test.js`

Expected: FAIL，因为安装脚本不存在。

- [ ] **Step 3: 实现幂等安装脚本**

脚本先用 `lark-cli base +field-list` 读取真实结构，再仅创建缺少字段或补充缺少选项；所有写入使用 `--as user`，字段关联到固定表 ID，画面比例默认选项为 `9:16`。

- [ ] **Step 4: 执行脚本并回读字段**

Run: `powershell -ExecutionPolicy Bypass -File scripts/configure-model-routing-base.ps1`

Expected: 七张表字段创建成功；第二次运行无重复字段。

- [ ] **Step 5: 运行测试并提交**

Run: `node --test test/base-schema.test.js`

Expected: PASS。

### Task 2: Windows DPAPI 凭据库

**Files:**
- Create: `src/credential-store.js`
- Test: `test/credential-store.test.js`

**Interfaces:**
- Produces: `createCredentialStore({ filePath, protect, unprotect })`，返回 `set(alias, secret)`、`get(alias)`、`remove(alias)`、`metadata(alias)`、`list()`；`protectWithDpapi(secret)` 和 `unprotectWithDpapi(ciphertext)`。

- [ ] **Step 1: 写失败测试**

覆盖密文文件不含原密钥、尾号脱敏、替换密钥、删除密钥、损坏密文报错和别名校验。

- [ ] **Step 2: 运行失败测试**

Run: `node --test test/credential-store.test.js`

Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现注入式凭据库和 DPAPI 适配**

凭据文件使用原子替换；默认保护器通过 PowerShell stdin 调用 `ConvertFrom-SecureString`，解密通过 `ConvertTo-SecureString` 与 `NetworkCredential`，不把密钥拼入命令行。

- [ ] **Step 4: 运行凭据测试**

Run: `node --test test/credential-store.test.js`

Expected: PASS，测试文件中只出现测试保护器产生的密文。

### Task 3: 接入记录解析与能力路由

**Files:**
- Create: `src/model-routing.js`
- Test: `test/model-routing.test.js`

**Interfaces:**
- Produces: `normalizeAccessRecord(row)`、`resolveSelectedAccess({ linkedValue, accessById, capability, defaultPurpose })`、`resolveCredential({ access, credentialStore, env })`、`snapshotAccess(access)`。

- [ ] **Step 1: 写失败测试**

覆盖显式选择、空值取唯一默认、禁用接入、能力不匹配、多个默认冲突、DPAPI凭据优先和旧环境变量后备。

- [ ] **Step 2: 运行失败测试**

Run: `node --test test/model-routing.test.js`

Expected: FAIL，路由模块不存在。

- [ ] **Step 3: 实现纯函数路由器**

路由失败返回分类错误 `CONFIG_REQUIRED`、`ACCESS_DISABLED`、`CAPABILITY_MISMATCH`、`AMBIGUOUS_DEFAULT`，不执行静默模型替换。

- [ ] **Step 4: 运行路由测试**

Run: `node --test test/model-routing.test.js`

Expected: PASS。

### Task 4: 协议适配器

**Files:**
- Create: `src/provider-adapters.js`
- Modify: `src/ltx.js`
- Test: `test/provider-adapters.test.js`

**Interfaces:**
- Produces: `createAdapterRegistry({ fetchImpl })`；适配器统一暴露 `validate(access, secret)`、`listModels(access, secret)`、`complete(request)`、`submitVideo(request)`、`getVideoTask(taskId)`。
- Consumes: Task 3 的标准接入对象。

- [ ] **Step 1: 写失败测试**

使用伪 fetch 覆盖 Chat Completions、`/v1/models`、Videos提交/查询、XYQ请求头、401分类、429重试和日志脱敏。

- [ ] **Step 2: 运行失败测试**

Run: `node --test test/provider-adapters.test.js`

Expected: FAIL，适配器模块不存在。

- [ ] **Step 3: 实现注册表和三个适配器**

协议键固定为 `chat-completions`、`videos`、`xyq-skill`；只对幂等请求和未取得任务ID的临时失败执行最多三次指数退避。

- [ ] **Step 4: 运行适配器与LTX回归测试**

Run: `node --test test/provider-adapters.test.js test/ltx.test.js test/ltx-rebuild.test.js`

Expected: PASS。

### Task 5: 本地配置页与模型批量导入

**Files:**
- Create: `src/api-config.js`
- Modify: `src/multipost-account-server.js`
- Modify: `scripts/run-multipost-account-server.ps1`
- Test: `test/api-config.test.js`

**Interfaces:**
- Produces: `createApiConfigHandler({ credentialStore, adapterRegistry, baseClient })`；处理 GET 页面、CSRF会话、保存/替换/删除凭据、验证接入和批量创建模型记录。

- [ ] **Step 1: 写失败测试**

覆盖只监听本机、GET不写入、Host/Origin校验、CSRF拒绝、保存后页面不回显密钥、验证回填和模型勾选批量创建。

- [ ] **Step 2: 运行失败测试**

Run: `node --test test/api-config.test.js`

Expected: FAIL，处理器不存在。

- [ ] **Step 3: 实现独立处理器并挂载到现有17386服务**

路由为 `/api-config`、`/api-config/save`、`/api-config/validate`、`/api-config/import-models`、`/api-config/delete-secret`；响应与日志只使用脱敏元数据。

- [ ] **Step 4: 运行配置页与MultiPost服务回归测试**

Run: `node --test test/api-config.test.js test/multipost-account-server.test.js`

Expected: PASS。

### Task 6: 中转站内容任务状态机

**Files:**
- Create: `src/relay-content.js`
- Test: `test/relay-content.test.js`

**Interfaces:**
- Produces: `relayContentJobAction(row)`、`buildRelayPromptRequest(row, access)`、`buildRelayVideoRequest(row, access)`、`inspectRelayVideoTask(data)`、`buildRelayStartPatch(context)`、`buildRelayFailurePatch(error)`。

- [ ] **Step 1: 写失败测试**

覆盖默认9:16、提示词先行、能力要求、四种生成方式、取得任务ID后只恢复轮询、回填失败、受控重试和触发字段复位。

- [ ] **Step 2: 运行失败测试**

Run: `node --test test/relay-content.test.js`

Expected: FAIL，状态机不存在。

- [ ] **Step 3: 实现纯状态机与请求构建器**

任务快照包含接入编号、接口地址、模型ID、协议和生成参数；失败分类为“需要配置”或“失败”，不自动换模型。

- [ ] **Step 4: 运行状态机测试**

Run: `node --test test/relay-content.test.js`

Expected: PASS。

### Task 7: Worker 集成与旧配置迁移

**Files:**
- Modify: `src/worker.js`
- Modify: `config.example.json`
- Modify: `scripts/run-worker.ps1`
- Test: `test/worker.test.js`
- Test: `test/worker-routing-integration.test.js`

**Interfaces:**
- Consumes: Tasks 2-6 的凭据库、路由、适配器和中转站状态机。
- Produces: 人设、小云雀、LTX、中转站和平台发布统一模型解析；`importLegacyCredentials({ env, store })`。

- [ ] **Step 1: 写失败集成测试**

覆盖Worker缺少Kimi但可执行XYQ任务、缺少XYQ但可执行中转站任务、显式模型快照、默认模型、旧字段映射、发布文案模型和重启恢复外部任务。

- [ ] **Step 2: 运行失败测试**

Run: `node --test test/worker-routing-integration.test.js`

Expected: FAIL，Worker仍在启动时强制检查两个环境变量。

- [ ] **Step 3: 集成统一路由**

删除全局密钥硬失败；读取“接入API”和“中转站生成内容管理”；每类任务仅在执行时解析所需接入；保留 `KIMI_API_KEY`、`XYQ_ACCESS_KEY`、`NEWAPI_API_KEY` 后备并提供一次性DPAPI导入。

- [ ] **Step 4: 运行Worker相关测试**

Run: `node --test test/worker.test.js test/worker-routing-integration.test.js test/multipost-publish.test.js`

Expected: PASS。

### Task 8: 文档、全量验证与安全审计

**Files:**
- Modify: `README.md`
- Create: `docs/model-routing-setup.md`
- Modify: `.gitignore`

**Interfaces:**
- Produces: 部署者从飞书字段安装、密钥导入、模型同步、默认模型设置到任务验证的完整手册。

- [ ] **Step 1: 更新文档与忽略规则**

文档明确DPAPI换机限制、旧环境变量迁移、默认9:16、没有静默回退和本地服务启动方式；忽略 `runtime/credentials.json` 及原子临时文件。

- [ ] **Step 2: 运行全量测试**

Run: `npm test`

Expected: 所有测试 PASS。

- [ ] **Step 3: 搜索密钥泄露风险**

Run: `rg -n "KIMI_API_KEY|XYQ_ACCESS_KEY|NEWAPI_API_KEY|Authorization" src scripts README.md docs config.example.json`

Expected: 只出现环境变量名称、脱敏逻辑和请求头构造，不出现真实密钥。

- [ ] **Step 4: 回读飞书结构并做非收费验收**

使用 `lark-cli base +field-list` 回读五张业务表和“接入API”；从配置页验证模型枚举，但不提交视频生成任务。

- [ ] **Step 5: 提交最终实现**

只暂存本功能新增和修改的文件，保留工作区中与本功能无关的用户改动。

