# 飞书电商视频本地任务处理器

本程序轮询“人设管理”和“内容管理”，在选项切换为“是”后完成以下流程：

1. Kimi 生成人设；小云雀生成人物形象并以附件图片回填飞书。
2. 下载参考视频并上传为小云雀真实素材资产。
3. 上传当前内容记录所选择的人设形象，只替换参考视频中的人物。
4. 按“模型选用”调用 Seedance 2.0、Seedance 2.0 Fast 或 Seedance 2.0 Mini；空值自动回填并使用 Mini。
5. 自动处理小云雀确认步骤并轮询结果。
6. 回填线程 ID、运行 ID、任务链接、最终视频或失败原因。

运行：

```powershell
npm test
powershell -ExecutionPolicy Bypass -File .\scripts\run-worker.ps1
```

计划任务名称：`FeishuEcommerceVideoWorker`，每分钟扫描一次且禁止重叠运行。
