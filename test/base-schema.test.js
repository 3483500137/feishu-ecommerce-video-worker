'use strict';

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const ROOT = path.resolve(__dirname, '..');

test('model-routing schema installer is additive, complete, and defaults relay video to 9:16', () => {
  const script = fs.readFileSync(path.join(ROOT, 'scripts', 'configure-model-routing-base.ps1'), 'utf8');
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.example.json'), 'utf8'));

  for (const configKey of [
    'access_api_table_id',
    'persona_table_id',
    'content_table_id',
    'relay_content_table_id',
    'ltx_content_table_id',
    'platform_publish_table_id',
  ]) {
    assert.match(script, new RegExp(`config\\.${configKey}`));
  }
  assert.match(script, /foreach \(\$requiredTable in @\('AccessApi', 'Persona', 'XyqContent'\)\)/);
  assert.match(script, /if \(\$tables\.RelayContent\)/);
  assert.match(script, /if \(\$tables\.LtxContent\)/);
  assert.match(script, /if \(\$tables\.PlatformPublish\)/);

  for (const fieldName of [
    '接入编号', '接入名称', '服务商类型', 'API协议', '视频接口样式', '接口地址', '模型名称', '模型ID',
    '模型能力', '本机密钥别名', '配置接入', '是否默认', '是否启用', '验证状态',
    '人设文本模型', '人物形象模型', '文本/分析模型', '视频生成模型', '分镜分析模型',
    '发布文案模型', '内容流水号', '生成方式', '生成视频提示词', '视频生成选用', '画面比例',
    '外部任务ID', '最终视频', '最终视频链接', '重试生成',
  ]) {
    assert.match(script, new RegExp(fieldName));
  }

  assert.match(script, /SelectField '画面比例'[^\r\n]*@\('9:16'\)/);
  assert.match(script, /Ensure-AutoNumberField \$tables\.RelayContent '内容流水号'/);
  assert.match(script, /Ensure-RenamedLinkField \$tables\.RelayContent '视频生成模型' '视频生成选用'/);
  assert.match(script, /Ensure-RenamedSelectField \$tables\.RelayContent '视频提示词选用' \$relayPromptGenerationField/);
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
  assert.match(script, /Remove-FieldIfExists \$tables\.RelayContent '实际文本模型'/);
  assert.match(script, /Remove-FieldIfExists \$tables\.RelayContent '实际视频模型'/);
  assert.match(script, /Remove-FieldIfExists \$tables\.RelayContent '重试生成'/);
  assert.doesNotMatch(script, /table-delete|record-delete/i);
  assert.equal(config.access_api_table_id, 'your_access_api_table_id');
  assert.equal(config.relay_content_table_id, 'your_relay_content_table_id');
});
