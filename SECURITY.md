# 安全说明

## 支持范围

仅维护 GitHub 默认分支的最新版本。请勿在 Issue、日志或截图中提交 API Key、飞书凭证、浏览器 Cookie、账号信息或含真实数据的 Base 导出文件。

## 报告漏洞

请通过 GitHub 仓库的 Security 页面私下报告漏洞。报告应包含受影响版本、复现步骤和影响范围，不要公开可用的凭证或真实用户数据。

## 凭证处理

- API Key 只通过用户级环境变量读取，不写入仓库。
- `config.json`、`runtime/` 和 `logs/` 默认被 Git 忽略。
- 飞书模板使用 `--only-schema` 导出，不含数据记录。
- MultiPost 会使用本机浏览器登录态；不要把 Chrome 用户目录复制或提交到仓库。
