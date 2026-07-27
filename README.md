# 飞书电商视频本地任务处理器

本程序轮询“人设管理”“小云雀内容管理”“中转站生成内容管理”“LTX内容管理”和“平台发布”，在选项切换为“是”后完成以下流程：

1. 按飞书选择的文本模型生成人设；按选择的图像模型生成人物形象并以附件图片回填飞书。
2. 下载参考视频并上传为小云雀真实素材资产。
3. 上传当前内容记录所选择的人设形象，只替换参考视频中的人物。
4. 按“模型选用”调用 Seedance 2.0、Seedance 2.0 Fast 或 Seedance 2.0 Mini；空值自动回填并使用 Mini。
5. 自动处理小云雀确认步骤并轮询结果。
6. 回填线程 ID、运行 ID、任务链接、最终视频或失败原因。
7. 按“发布文案模型”生成适合短视频平台的简短标题、文案和标签。
8. “确认发布”设为“是”后，校验关联账号、登录状态和当前 Chrome 账号，生成幂等任务并调用 MultiPost 扩展真实发布。
9. 快手后台显示“已发布”后，自动回填“发布成功”和实际发布时间。

模型接入采用“一模型一行”的`接入API`表，API 密钥只存当前电脑的 Windows DPAPI 加密凭据库，不在飞书或 `config.json` 保存明文。完整部署步骤见 [每位部署者配置模型与中转站](docs/model-routing-setup.md)。

## 人设参考图片

“人设管理”中的“参考图片”为可选附件字段：

- 直接粘贴或上传一张正面清晰的人物图片，再把“是否立刻生成人设”设为“是”。
- Worker 会把参考图片上传给小云雀，生成的人物形象沿用参考图中同一个人的脸。
- 参考图片只锁定人脸身份；服装、造型、全身构图和场景仍按“输入人设要求”与生成的人设执行。
- 不填写“参考图片”时，继续使用原有纯文字生成人设流程。

## 三张视频内容表

- `内容管理`：保持原有小云雀 + Seedance 参考视频换人流程不变。
- `中转站生成内容管理`：文本模型先生成提示词，再按所选 Videos 接口生成视频；支持文生视频、图生视频、首尾帧和参考视频生成，画面比例默认 `9:16`。
- `LTX内容管理`：采用相同的参考视频输入和触发方式，由 Kimi 分析分镜、LTX 生成分段、FFmpeg 合成为与参考视频等时长的成片。

LTX 表支持：

- 在“参考视频链接”中填写可下载的视频地址；LTX 内容管理不再使用附件输入。
- “人设”用于关联本条内容的人设记录；“生成供应商”由 Worker 自动回填。
- Worker 自动检测“视频时长”，按 `向上取整(时长÷5秒)` 动态分段并提取边界帧，当前支持最长 60 秒参考视频。
- `LTX 2.3 单帧`：每段使用起始边界帧，连续性相对较弱。
- `LTX 2.3 首尾帧`：每段使用相邻两张边界帧，推荐用于近似复刻。
- LTX 单次规格为竖屏 704×1280、5 秒、121 帧；Worker 将全部片段统一为 720×1280（严格 9:16），按参考视频时长裁切，并复用参考视频原音轨后上传到“最终视频”。
- 该流程属于同类型近似复刻，人物细节、动作、镜头和音频不能保证与参考视频完全一致。
- Worker 会通过 Cloudflare Quick Tunnel 向 LTX 提供临时 HTTPS 边界帧；全部任务结束后自动删除中继图片。

推荐在`接入API`行点击“配置接入”，把 LTX API 密钥保存到本机 DPAPI 凭据库。旧环境变量仅作为迁移期后备，同样不会写入飞书或配置文件：

```powershell
[Environment]::SetEnvironmentVariable('NEWAPI_API_KEY', '替换为新密钥', 'User')
```

安装并启动 Cloudflare 临时中继：

```powershell
winget install --id Cloudflare.cloudflared
powershell -ExecutionPolicy Bypass -File .\scripts\install-media-relay.ps1
```

中继计划任务名称为 `FeishuLtxMediaRelay`，登录 Windows 后自动启动。它只公开 `/health` 和带 128 位随机标识的 `/media/<素材键>` 地址，不开放目录浏览；LTX 任务完成或失败后会删除对应文件。Quick Tunnel 每次重启都会更换公网域名，因此生成期间电脑、中继进程和网络必须保持在线。它适合测试、个人部署和免配置开源体验，不承诺固定域名或生产 SLA。

当前 `ltx_base_url` 如果仍是 HTTP，密钥会以明文网络流量发送；正式使用前应配置 HTTPS 并更换已暴露的密钥。

平台发布安全门禁：

- 仅“文案生成状态=已完成、发布状态=待确认、确认发布=是”的记录会提交。
- 已有 `MultiPost任务ID` 或 `幂等键` 的记录不会重复提交。
- 当前 Chrome 登录账号必须与“平台账号”表中的 `MultiPost账号ID` 一致。
- 登录失效、账号不一致、验证码或平台风控会停止发布并写入失败原因。
- 本地服务只保存任务元数据，不保存平台密码、Cookie 或验证码。

运行：

```powershell
npm test
powershell -ExecutionPolicy Bypass -File .\scripts\run-media-relay.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\run-worker.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\run-multipost-account-server.ps1
```

计划任务名称：`FeishuEcommerceVideoWorker`，每分钟扫描一次且禁止重叠运行。

MultiPost 本地桥接任务名称：`FeishuMultiPostAccountServer`。首次安装或更新工作流目录中的扩展后，需要在 Chrome 扩展管理页重新加载 `vendor\MultiPost-1.3.8`。
