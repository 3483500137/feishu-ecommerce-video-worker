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
    'tblFrdsO3aZmLPx0',
    'tblbpUlzTT3Lctxt',
    'tblEjufPDjnVGOQJ',
    'tblduzX6eoAaz2iY',
    'tbl2Bg5T77HlHkmT',
    'tblT9sUa526I6OYf',
  ]) {
    assert.match(script, new RegExp(tableId));
  }

  for (const fieldName of [
    '接入编号', '接入名称', '服务商类型', 'API协议', '视频接口样式', '接口地址', '模型名称', '模型ID',
    '模型能力', '本机密钥别名', '配置接入', '是否默认', '是否启用', '验证状态',
    '人设文本模型', '人物形象模型', '文本/分析模型', '视频生成模型', '分镜分析模型',
    '发布文案模型', '内容流水号', '生成方式', '生成视频提示词', '视频生成选用', '画面比例',
    '外部任务ID', '最终视频', '最终视频链接', '重试生成', '提示词编号', '热点标题',
    '来源平台', '热榜ID', '热榜排名', '热度值', '热榜链接', '建议提示词', '抓取时间', '提示词库',
    '成交适配分', '涨粉适配分', '复刻适配分', '系统推荐方向', '推荐理由', '目标方向',
    '热点视频ID', '视频链接', '视频封面', '发布时间', '热点题材', '方向匹配分', '可复刻分',
    '综合优先分', '视频内容摘要', '动作与镜头分析', '提示词相关性分', '所属周期',
    '提示词生成模型', '热点方向配置', '配置名称', '包含关键词', '排除关键词',
    '每日热点数量', '最低方向匹配分', '补足策略', '智能补足最低分', '立即刷新热点',
    '热点匹配方式',
  ]) {
    assert.match(script, new RegExp(fieldName));
  }

  assert.match(script, /SelectField '画面比例'[^\r\n]*@\('9:16'\)/);
  assert.match(script, /Ensure-AutoNumberField \$tables\.RelayContent '内容流水号'/);
  assert.match(script, /Ensure-RenamedLinkField \$tables\.RelayContent '视频生成模型' '视频生成选用'/);
  assert.match(script, /LinkField '平台发布' \$tables\.PlatformPublish '关联本条中转站内容对应的平台发布任务' \$true '中转站生成内容管理'/);
  assert.match(script, /Ensure-RenamedSelectField \$tables\.RelayContent '视频提示词选用' \$relayPromptGenerationField/);
  assert.match(script, /Ensure-RenamedSelectField \$tables\.XyqContent '视频提示词选用' \$relayPromptGenerationField/);
  assert.match(script, /SelectField '目标方向' \$false/);
  assert.doesNotMatch(script, /SelectField '目标方向' \$true/);
  assert.match(script, /Ensure-SelectFieldDefinition \$tables\.XyqContent \$targetDirectionField/);
  assert.match(script, /Ensure-SelectFieldDefinition \$tables\.RelayContent \$targetDirectionField/);
  assert.match(script, /SelectField '生成视频提示词'[^\r\n]*@\('否'\)/);
  assert.match(script, /Ensure-SelectFieldDefinition \$tables\.RelayContent \$generateVideoField/);
  assert.match(script, /SelectField '是否立刻生成视频'[^\r\n]*Option '重试生成' 'Orange'/);
  assert.match(script, /Option '重新生成' 'Orange'/);
  assert.doesNotMatch(script, /SelectField '视频生成选用'/);
  assert.doesNotMatch(script, /SelectField '重试生成'/);
  assert.match(script, /Ensure-FieldDescription \$tables\.RelayContent '随机种子'/);
  assert.match(script, /例如 1、42、20260722/);
  assert.match(script, /NewAPI Video Generations/);
  assert.match(script, /APIMesh Videos Generations/);
  assert.match(script, /Ensure-RenamedExistingLinkField/);
  assert.match(script, /Remove-FieldIfExists \$tables\.RelayContent '实际文本模型'/);
  assert.match(script, /Remove-FieldIfExists \$tables\.RelayContent '实际视频模型'/);
  assert.match(script, /Remove-FieldIfExists \$tables\.RelayContent '重试生成'/);
  assert.match(script, /type = 'formula'; expression = 'HYPERLINK\("http:\/\/127\.0\.0\.1:17386\/api-config\?record_id="/);
  assert.doesNotMatch(script, /IF\(ISBLANK\([^)]*\),[^)]*HYPERLINK/);
  assert.doesNotMatch(script, /table-delete|record-delete/i);
  assert.equal(config.access_api_table_id, 'your_access_api_table_id');
  assert.equal(config.relay_content_table_id, 'your_relay_content_table_id');
  assert.equal(config.prompt_library_table_id, 'your_prompt_library_table_id');
  assert.equal(config.hot_direction_table_id, 'your_hot_direction_table_id');
});
