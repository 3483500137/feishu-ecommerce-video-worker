'use strict';

const path = require('path');
const { assertValidConfig, loadConfig } = require('../src/project-config');
const {
  listRecords,
  ltxJobAction,
  processLtxContent,
  resumeLtxContent,
} = require('../src/worker');

const ROOT = path.resolve(__dirname, '..');
const CONFIG = loadConfig({ root: ROOT, required: true });
const recordId = process.argv[2];

if (!recordId) throw new Error('用法：node scripts/process-ltx-record.js <record-id>');

const fields = [
  '内容流水号', '人设', '参考视频链接', '视频提示词',
  '模型选用', '视频时长', '随机种子', '是否立刻生成视频',
  '生成状态', '生成供应商', '外部任务ID', '中继素材键（内部）',
  '分段提示词（内部）', '最终视频', '失败原因', '提交时间', '完成时间',
];

async function main() {
  assertValidConfig(CONFIG, { features: ['core', 'ltx'] });
  const row = listRecords(CONFIG.ltx_content_table_id, fields)
    .find((item) => item.record_id === recordId);
  if (!row) throw new Error(`找不到 LTX 记录：${recordId}`);
  const action = ltxJobAction(row);
  if (action === 'resume') {
    await resumeLtxContent(row);
    return;
  }
  if (action !== 'generate') {
    throw new Error(`LTX 记录当前不能提交新任务：${recordId} (${action})`);
  }
  await processLtxContent(row);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
