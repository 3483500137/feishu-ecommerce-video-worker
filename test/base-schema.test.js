'use strict';

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const ROOT = path.resolve(__dirname, '..');

test('model-routing schema installer is additive, complete, and defaults relay video to 9:16', () => {
  const script = fs.readFileSync(path.join(ROOT, 'scripts', 'configure-model-routing-base.ps1'), 'utf8');
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.example.json'), 'utf8'));

  for (const tableId of [
    'tblCNfWxoesOL8GA',
    'tblZrkzhn0ci5dJT',
    'tblEjufPDjnVGOQJ',
    'tblduzX6eoAaz2iY',
    'tbl2Bg5T77HlHkmT',
    'tblT9sUa526I6OYf',
  ]) {
    assert.match(script, new RegExp(tableId));
  }

  for (const fieldName of [
    '接入编号', '接入名称', '服务商类型', 'API协议', '接口地址', '模型名称', '模型ID',
    '模型能力', '本机密钥别名', '配置接入', '是否默认', '是否启用', '验证状态',
    '人设文本模型', '人物形象模型', '文本/分析模型', '视频生成模型', '分镜分析模型',
    '发布文案模型', '内容流水号', '生成方式', '画面比例', '实际文本模型', '实际视频模型',
    '外部任务ID', '最终视频', '最终视频链接', '重试生成',
  ]) {
    assert.match(script, new RegExp(fieldName));
  }

  assert.match(script, /SelectField '画面比例'[^\r\n]*@\('9:16'\)/);
  assert.doesNotMatch(script, /field-delete|table-delete|record-delete/i);
  assert.equal(config.access_api_table_id, 'your_access_api_table_id');
  assert.equal(config.relay_content_table_id, 'your_relay_content_table_id');
});
