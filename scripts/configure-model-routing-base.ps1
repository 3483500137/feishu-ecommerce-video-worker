param(
  [string]$ConfigPath = (Join-Path $PSScriptRoot '..\config.json')
)

$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..')
Set-Location $root
$config = Get-Content -Raw -LiteralPath $ConfigPath | ConvertFrom-Json
$baseToken = [string]$config.base_token
if (-not $baseToken) { throw 'config.json 缺少 base_token' }

$tables = @{
  AccessApi = 'tblCNfWxoesOL8GA'
  Persona = 'tblZrkzhn0ci5dJT'
  XyqContent = 'tblEjufPDjnVGOQJ'
  RelayContent = 'tblduzX6eoAaz2iY'
  LtxContent = 'tbl2Bg5T77HlHkmT'
  PlatformPublish = 'tblT9sUa526I6OYf'
}

function Invoke-LarkJson([string[]]$Arguments) {
  $oldPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $output = & lark-cli @Arguments 2>&1 | Out-String
  $exitCode = $LASTEXITCODE
  $ErrorActionPreference = $oldPreference
  if ($exitCode -ne 0) { throw $output.Trim() }
  return $output | ConvertFrom-Json
}

function Get-BaseFields([string]$TableId) {
  $response = Invoke-LarkJson @('base', '+field-list', '--base-token', $baseToken, '--table-id', $TableId, '--as', 'user', '--format', 'json')
  return @($response.data.fields)
}

function Invoke-LarkJsonBody([string[]]$Arguments, [string]$Json) {
  $runtimeDir = Join-Path $root 'runtime'
  [IO.Directory]::CreateDirectory($runtimeDir) | Out-Null
  $fileName = "feishu-field-{0}.json" -f [guid]::NewGuid().ToString('N')
  $tempPath = Join-Path $runtimeDir $fileName
  try {
    [IO.File]::WriteAllText($tempPath, $Json, (New-Object Text.UTF8Encoding($false)))
    return Invoke-LarkJson ($Arguments + @('--json', "@./runtime/$fileName", '--as', 'user', '--format', 'json'))
  } finally {
    Remove-Item -LiteralPath $tempPath -Force -ErrorAction SilentlyContinue
  }
}

function Ensure-PrimaryTextField([string]$TableId, [string]$OldName, [string]$NewName) {
  $fields = Get-BaseFields $TableId
  if ($fields.name -contains $NewName) { return }
  $field = $fields | Where-Object { $_.name -eq $OldName -and $_.type -eq 'text' } | Select-Object -First 1
  if (-not $field) { throw "表 $TableId 找不到可重命名的主字段 $OldName" }
  $json = @{ name = $NewName; type = 'text'; style = @{ type = 'plain' } } | ConvertTo-Json -Compress -Depth 8
  Invoke-LarkJsonBody @('base', '+field-update', '--base-token', $baseToken, '--table-id', $TableId, '--field-id', $field.id, '--yes') $json | Out-Null
}

function Ensure-Field([string]$TableId, [hashtable]$Definition) {
  $fields = Get-BaseFields $TableId
  if ($fields.name -contains $Definition.name) { return }
  $json = $Definition | ConvertTo-Json -Compress -Depth 12
  $arguments = @('base', '+field-create', '--base-token', $baseToken, '--table-id', $TableId)
  if ($Definition.type -eq 'formula') { $arguments += '--i-have-read-guide' }
  Invoke-LarkJsonBody $arguments $json | Out-Null
}

function Option([string]$Name, [string]$Hue = 'Blue', [string]$Lightness = 'Lighter') {
  return @{ name = $Name; hue = $Hue; lightness = $Lightness }
}

function TextField([string]$Name, [string]$Description = '', [string]$Style = 'plain') {
  $field = @{ name = $Name; type = 'text'; style = @{ type = $Style } }
  if ($Description) { $field.description = $Description }
  return $field
}

function LinkField([string]$Name, [string]$Target, [string]$Description = '') {
  $field = @{ name = $Name; type = 'link'; link_table = $Target; bidirectional = $false }
  if ($Description) { $field.description = $Description }
  return $field
}

function SelectField([string]$Name, [bool]$Multiple, [array]$Options, [array]$DefaultValue = @()) {
  $field = @{ name = $Name; type = 'select'; multiple = $Multiple; options = $Options }
  if ($DefaultValue.Count -gt 0) { $field.default_value = $DefaultValue }
  return $field
}

Ensure-PrimaryTextField $tables.AccessApi '文本' '接入名称'
Ensure-PrimaryTextField $tables.RelayContent '文本' '内容流水号'

$accessFields = @(
  @{ name = '接入编号'; type = 'auto_number'; style = @{ rules = @(@{ type = 'text'; text = 'API-' }, @{ type = 'incremental_number'; length = 4 }) } },
  (SelectField '服务商类型' $false @((Option '小云雀' 'Blue'), (Option 'Kimi' 'Purple'), (Option 'OpenAI兼容' 'Green'), (Option '中转站' 'Orange'), (Option '其他' 'Gray'))),
  (SelectField 'API协议' $false @((Option 'Chat Completions' 'Purple'), (Option 'Videos' 'Orange'), (Option 'XYQ Skill' 'Blue'))),
  (TextField '接口地址' '不包含密钥的API Base URL' 'url'),
  (TextField '模型名称' '飞书中显示的模型名称'),
  (TextField '模型ID' '请求中实际使用的model值'),
  (SelectField '模型能力' $true @((Option '文本' 'Purple'), (Option '视觉分析' 'Blue'), (Option '图像生成' 'Green'), (Option '视频生成' 'Orange'))),
  (TextField '本机密钥别名' '指向本机DPAPI凭据库，不保存API密钥'),
  (TextField '密钥尾号' '仅显示密钥最后四位'),
  @{ name = '配置接入'; type = 'formula'; expression = 'HYPERLINK("http://127.0.0.1:17386/api-config?record_id="&RECORD_ID(),"配置/验证")'; description = '在当前电脑打开本地密钥配置页' },
  (SelectField '是否默认' $true @((Option '人设文本' 'Purple'), (Option '人物形象' 'Green'), (Option '提示词' 'Blue'), (Option '视频生成' 'Orange'), (Option '发布文案' 'Carmine'))),
  (SelectField '是否启用' $false @((Option '是' 'Green'), (Option '否' 'Gray')) @('是')),
  (SelectField '验证状态' $false @((Option '未配置' 'Gray'), (Option '待验证' 'Blue'), (Option '有效' 'Green'), (Option '已失效' 'Red')) @('未配置')),
  @{ name = '最近验证时间'; type = 'datetime'; style = @{ format = 'yyyy-MM-dd HH:mm' } },
  (TextField '失败原因' '本地验证或调用失败的安全摘要')
)
foreach ($field in $accessFields) { Ensure-Field $tables.AccessApi $field }

foreach ($definition in @(
  @($tables.Persona, (LinkField '人设文本模型' $tables.AccessApi '生成文字人设的模型')),
  @($tables.Persona, (LinkField '人物形象模型' $tables.AccessApi '生成人物形象图片的模型')),
  @($tables.XyqContent, (LinkField '文本/分析模型' $tables.AccessApi '生成提示词或分析参考素材的模型')),
  @($tables.XyqContent, (LinkField '视频生成模型' $tables.AccessApi '实际生成视频的模型')),
  @($tables.RelayContent, (LinkField '文本/分析模型' $tables.AccessApi '生成提示词或分析参考素材的模型')),
  @($tables.RelayContent, (LinkField '视频生成模型' $tables.AccessApi '实际生成视频的模型')),
  @($tables.LtxContent, (LinkField '分镜分析模型' $tables.AccessApi '分析参考视频并生成分镜提示词的模型')),
  @($tables.LtxContent, (LinkField '视频生成模型' $tables.AccessApi '实际生成LTX视频的模型')),
  @($tables.PlatformPublish, (LinkField '发布文案模型' $tables.AccessApi '生成标题、文案和标签的模型'))
)) {
  Ensure-Field $definition[0] $definition[1]
}

$relayFields = @(
  (LinkField '人设' $tables.Persona '选择本条视频使用的人设'),
  (TextField '输入内容要求' '主题、动作、场景和商品要求'),
  @{ name = '参考图片'; type = 'attachment' },
  @{ name = '参考视频'; type = 'attachment' },
  (TextField '参考视频链接' '可下载的HTTP或HTTPS视频链接' 'url'),
  @{ name = '尾帧图片'; type = 'attachment' },
  (TextField '视频提示词' '文本/分析模型生成后可人工调整'),
  (SelectField '生成方式' $false @((Option '文生视频' 'Purple'), (Option '图生视频' 'Green'), (Option '首尾帧' 'Blue'), (Option '参考视频生成' 'Orange'))),
  @{ name = '视频时长'; type = 'number'; style = @{ type = 'plain'; precision = 0; percentage = $false; thousands_separator = $false } },
  (SelectField '画面比例' $false @((Option '9:16' 'Green'), (Option '16:9' 'Blue'), (Option '1:1' 'Purple')) @('9:16')),
  @{ name = '随机种子'; type = 'number'; style = @{ type = 'plain'; precision = 0; percentage = $false; thousands_separator = $false } },
  (SelectField '是否立刻生成视频' $false @((Option '否' 'Gray'), (Option '是' 'Green')) @('否')),
  (SelectField '重试生成' $false @((Option '否' 'Gray'), (Option '重试' 'Orange')) @('否')),
  (SelectField '生成状态' $false @((Option '待生成提示词' 'Gray'), (Option '生成提示词中' 'Blue'), (Option '待生成视频' 'Orange'), (Option '生成中' 'Blue' 'Light'), (Option '已完成' 'Green'), (Option '失败' 'Red'), (Option '需要配置' 'Carmine')) @('待生成提示词')),
  (TextField '实际文本模型' '任务启动时保存的文本模型快照'),
  (TextField '实际视频模型' '任务启动时保存的视频模型快照'),
  (TextField '外部任务ID' '中转站返回的任务ID'),
  @{ name = '最终视频'; type = 'attachment' },
  (TextField '最终视频链接' '中转站生成结果或中继链接' 'url'),
  @{ name = '提交时间'; type = 'datetime'; style = @{ format = 'yyyy-MM-dd HH:mm' } },
  @{ name = '完成时间'; type = 'datetime'; style = @{ format = 'yyyy-MM-dd HH:mm' } },
  (TextField '失败原因' '配置、接口、素材或回填失败原因')
)
foreach ($field in $relayFields) { Ensure-Field $tables.RelayContent $field }

Write-Host '飞书模型路由字段已检查并补齐。'





