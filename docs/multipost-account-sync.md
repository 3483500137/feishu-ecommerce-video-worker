# MultiPost 账号回填

“平台账号”表选择平台后，“获取MultiPost”公式会生成本机链接。点击链接时，页面向 MultiPost
扩展申请读取当前 Chrome 配置文件中的账号信息，并将平台标识、账号 ID、账号昵称、登录状态及
最近验证时间回填到当前飞书记录。

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-multipost-account-server.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\run-multipost-account-server.ps1
```

首次点击时，需要在 MultiPost 弹窗中允许 `127.0.0.1` 访问扩展。MultiPost 1.3.8 未提供账号识别
的发布平台会回填平台标识，并将登录状态设为“需要人工处理”，不会伪造账号 ID。
