# 第三方组件说明

## MultiPost Extension 1.3.8

本项目在 `vendor/MultiPost-1.3.8` 中分发基于 [MultiPost Extension](https://github.com/leaper-one/MultiPost-Extension) 1.3.8 的扩展副本，并加入了本地飞书账号同步、快手账号识别和发布结果回写桥接。上游项目采用 Apache License 2.0；完整许可证见 `vendor/MultiPost-1.3.8/LICENSE`。

上游版权归 MultiPost Extension 的贡献者所有。本项目的修改不代表上游作者背书。修改入口主要位于 `kuaishou-account-content.js`、`static/background/kuaishou-account-background.js`、`static/background/multipost-service-worker.js` 及相应 manifest 配置。

## 外部运行时

飞书 CLI、FFmpeg、yt-dlp 与 Cloudflared 不随本项目二进制分发，各自适用其上游许可证。使用者应从官方渠道安装并遵守目标平台、模型服务和内容来源的条款。
