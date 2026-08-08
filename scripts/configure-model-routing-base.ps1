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
  PromptLibrary = 'tblFrdsO3aZmLPx0'
  HotDirection = 'tblbpUlzTT3Lctxt'
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
  $parsed = $null
  try { $parsed = $output | ConvertFrom-Json } catch {}
  if ($exitCode -ne 0) {
    if ($output -match '800070003' -or $output -match 'no operation produced') { return $parsed }
    if ($parsed -and $parsed.error -and $parsed.error.code -eq 800070003) { return $parsed }
    throw $output.Trim()
  }
  if ($parsed) { return $parsed }
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

function Ensure-AutoNumberField([string]$TableId, [string]$Name, [array]$Rules) {
  $fields = Get-BaseFields $TableId
  $field = $fields | Where-Object { $_.name -eq $Name } | Select-Object -First 1
  $definition = @{ name = $Name; type = 'auto_number'; style = @{ rules = $Rules } }
  $json = $definition | ConvertTo-Json -Compress -Depth 12
  if (-not $field) {
    Invoke-LarkJsonBody @('base', '+field-create', '--base-token', $baseToken, '--table-id', $TableId) $json | Out-Null
    return
  }
  if ($field.type -eq 'auto_number') { return }
  Invoke-LarkJsonBody @('base', '+field-update', '--base-token', $baseToken, '--table-id', $TableId, '--field-id', $field.id, '--yes') $json | Out-Null
}

function Ensure-FieldDescription([string]$TableId, [string]$Name, [hashtable]$Definition) {
  $fields = Get-BaseFields $TableId
  $field = $fields | Where-Object { $_.name -eq $Name } | Select-Object -First 1
  if (-not $field) {
    Ensure-Field $TableId $Definition
    return
  }
  if ([string]$field.description -eq [string]$Definition.description) { return }
  $json = $Definition | ConvertTo-Json -Compress -Depth 12
  Invoke-LarkJsonBody @('base', '+field-update', '--base-token', $baseToken, '--table-id', $TableId, '--field-id', $field.id, '--yes') $json | Out-Null
}

function Remove-FieldIfExists([string]$TableId, [string]$Name) {
  $fields = Get-BaseFields $TableId
  $field = $fields | Where-Object { $_.name -eq $Name } | Select-Object -First 1
  if (-not $field) { return }
  Invoke-LarkJson @('base', '+field-delete', '--base-token', $baseToken, '--table-id', $TableId, '--field-id', $field.id, '--yes', '--as', 'user', '--format', 'json') | Out-Null
}

function Ensure-RenamedLinkField([string]$TableId, [string]$OldName, [string]$NewName, [string]$Target, [string]$Description = '') {
  $fields = Get-BaseFields $TableId
  $targetField = $fields | Where-Object { $_.name -eq $NewName } | Select-Object -First 1
  if ($targetField -and $targetField.type -eq 'link') { return }
  if ($targetField) {
    Invoke-LarkJson @('base', '+field-delete', '--base-token', $baseToken, '--table-id', $TableId, '--field-id', $targetField.id, '--yes', '--as', 'user', '--format', 'json') | Out-Null
    $fields = Get-BaseFields $TableId
  }
  $definition = LinkField $NewName $Target $Description
  $oldField = $fields | Where-Object { $_.name -eq $OldName -and $_.type -eq 'link' } | Select-Object -First 1
  $json = $definition | ConvertTo-Json -Compress -Depth 12
  if ($oldField) {
    Invoke-LarkJsonBody @('base', '+field-update', '--base-token', $baseToken, '--table-id', $TableId, '--field-id', $oldField.id, '--yes') $json | Out-Null
    return
  }
  Ensure-Field $TableId $definition
}

function Ensure-InitialHotDirectionRecord([string]$TableId) {
  $response = Invoke-LarkJson @('base', '+record-list', '--base-token', $baseToken, '--table-id', $TableId, '--limit', '1', '--as', 'user', '--format', 'json')
  if (@($response.data.record_id_list).Count -gt 0) { return }
  $record = @{
    '配置名称' = '传统武术复刻'
    '目标方向' = '复刻生产'
    '热点题材' = '传统国风舞剑/武术'
    '包含关键词' = '舞剑、武术、剑术、功夫、国风、传统文化、汉服、武侠、太极、少林、刀术、枪术、身法'
    '排除关键词' = '游戏、手游'
    '每日热点数量' = 10
    '最低方向匹配分' = 60
    '补足策略' = '智能补足'
    '智能补足最低分' = 65
    '立即刷新热点' = '否'
    '是否启用' = '是'
  } | ConvertTo-Json -Compress -Depth 8
  Invoke-LarkJsonBody @('base', '+record-upsert', '--base-token', $baseToken, '--table-id', $TableId) $record | Out-Null
}

function Ensure-RenamedExistingLinkField([string]$TableId, [string]$OldName, [string]$NewName, [string]$Target, [string]$Description = '') {
  $fields = Get-BaseFields $TableId
  $targetField = $fields | Where-Object { $_.name -eq $NewName -and $_.type -eq 'link' } | Select-Object -First 1
  if ($targetField) { return }
  $oldField = $fields | Where-Object { $_.name -eq $OldName -and $_.type -eq 'link' } | Select-Object -First 1
  if (-not $oldField) {
    Ensure-Field $TableId (LinkField $NewName $Target $Description)
    return
  }
  # This is the reverse side of an existing bidirectional link. Do not send
  # bidirectional=false: Feishu does not permit changing that setting after creation.
  $definition = @{ name = $NewName; type = 'link'; link_table = $Target; description = $Description }
  $json = $definition | ConvertTo-Json -Compress -Depth 12
  Invoke-LarkJsonBody @('base', '+field-update', '--base-token', $baseToken, '--table-id', $TableId, '--field-id', $oldField.id, '--yes') $json | Out-Null
}

function Ensure-RenamedSelectField([string]$TableId, [string]$OldName, [hashtable]$Definition) {
  $fields = Get-BaseFields $TableId
  $targetField = $fields | Where-Object { $_.name -eq $Definition.name } | Select-Object -First 1
  $json = $Definition | ConvertTo-Json -Compress -Depth 12
  if ($targetField -and $targetField.type -eq 'select') {
    Invoke-LarkJsonBody @('base', '+field-update', '--base-token', $baseToken, '--table-id', $TableId, '--field-id', $targetField.id, '--yes') $json | Out-Null
    return
  }
  if ($targetField) {
    Invoke-LarkJson @('base', '+field-delete', '--base-token', $baseToken, '--table-id', $TableId, '--field-id', $targetField.id, '--yes', '--as', 'user', '--format', 'json') | Out-Null
    $fields = Get-BaseFields $TableId
  }
  $oldField = $fields | Where-Object { $_.name -eq $OldName -and $_.type -eq 'select' } | Select-Object -First 1
  if ($oldField) {
    Invoke-LarkJsonBody @('base', '+field-update', '--base-token', $baseToken, '--table-id', $TableId, '--field-id', $oldField.id, '--yes') $json | Out-Null
    return
  }
  Ensure-Field $TableId $Definition
}

function Ensure-SelectFieldDefinition([string]$TableId, [hashtable]$Definition) {
  $fields = Get-BaseFields $TableId
  $field = $fields | Where-Object { $_.name -eq $Definition.name } | Select-Object -First 1
  $json = $Definition | ConvertTo-Json -Compress -Depth 12
  if ($field -and $field.type -eq 'select') {
    Invoke-LarkJsonBody @('base', '+field-update', '--base-token', $baseToken, '--table-id', $TableId, '--field-id', $field.id, '--yes') $json | Out-Null
    return
  }
  if ($field) {
    Invoke-LarkJson @('base', '+field-delete', '--base-token', $baseToken, '--table-id', $TableId, '--field-id', $field.id, '--yes', '--as', 'user', '--format', 'json') | Out-Null
  }
  Ensure-Field $TableId $Definition
}

function Option([string]$Name, [string]$Hue = 'Blue', [string]$Lightness = 'Lighter') {
  return @{ name = $Name; hue = $Hue; lightness = $Lightness }
}

function TextField([string]$Name, [string]$Description = '', [string]$Style = 'plain') {
  $field = @{ name = $Name; type = 'text'; style = @{ type = $Style } }
  if ($Description) { $field.description = $Description }
  return $field
}

function LinkField([string]$Name, [string]$Target, [string]$Description = '', [bool]$Bidirectional = $false, [string]$ReverseFieldName = '') {
  $field = @{ name = $Name; type = 'link'; link_table = $Target; bidirectional = $Bidirectional }
  if ($Bidirectional -and $ReverseFieldName) { $field.bidirectional_link_field_name = $ReverseFieldName }
  if ($Description) { $field.description = $Description }
  return $field
}

function SelectField([string]$Name, [bool]$Multiple, [array]$Options, [array]$DefaultValue = @()) {
  $field = @{ name = $Name; type = 'select'; multiple = $Multiple; options = $Options }
  if ($DefaultValue.Count -gt 0) { $field.default_value = $DefaultValue }
  return $field
}

Ensure-PrimaryTextField $tables.AccessApi '文本' '接入名称'
Ensure-PrimaryTextField $tables.PromptLibrary '文本' '热点标题'
Ensure-AutoNumberField $tables.PromptLibrary '提示词编号' @(@{ type = 'text'; text = 'PR-' }, @{ type = 'incremental_number'; length = 5 })
Ensure-AutoNumberField $tables.RelayContent '内容流水号' @(@{ type = 'text'; text = 'RC-' }, @{ type = 'incremental_number'; length = 5 })

$promptLibraryFields = @(
  (SelectField '来源平台' $false @((Option '抖音热榜' 'Carmine'), (Option '手工录入' 'Blue')) @('抖音热榜')),
  (TextField '热榜ID' '抖音热榜话题唯一标识，用于增量更新和去重'),
  (TextField '热点视频ID' '热榜返回的代表视频ID；有值时“视频链接”指向该视频'),
  @{ name = '热榜排名'; type = 'number'; style = @{ type = 'plain'; precision = 0; percentage = $false; thousands_separator = $false } },
  @{ name = '热度值'; type = 'number'; style = @{ type = 'plain'; precision = 0; percentage = $false; thousands_separator = $true } },
  (TextField '热榜链接' '打开抖音对应话题搜索页' 'url'),
  (TextField '视频链接' '抖音代表视频链接；无代表视频时回退为话题搜索页' 'url'),
  (TextField '视频封面' '抖音热点返回的代表视频封面' 'url'),
  (TextField '作者' '上游能提供作者时写入；未知时保持为空'),
  @{ name = '发布时间'; type = 'datetime'; style = @{ format = 'yyyy-MM-dd HH:mm' } },
  (TextField '热点题材' '采集时启用的题材方向快照'),
  (SelectField '热点匹配方式' $false @((Option '严格匹配' 'Gray'), (Option '智能补足' 'Blue'))),
  @{ name = '方向匹配分'; type = 'number'; description = '0-100 分，热点与当前题材关键词的匹配度'; style = @{ type = 'plain'; precision = 0; percentage = $false; thousands_separator = $false } },
  @{ name = '可复刻分'; type = 'number'; description = '0-100 分，动作和镜头是否适合稳定复刻'; style = @{ type = 'plain'; precision = 0; percentage = $false; thousands_separator = $false } },
  @{ name = '综合优先分'; type = 'number'; description = '方向50% + 热度25% + 可复刻20% + 新鲜度5%'; style = @{ type = 'plain'; precision = 0; percentage = $false; thousands_separator = $false } },
  (TextField '视频内容摘要' '模型基于标题、热榜元数据和可见封面生成的克制摘要'),
  (TextField '动作与镜头分析' '用于生成提示词的动作顺序、景别、机位、运镜和节奏依据'),
  (TextField '建议提示词' 'Worker 根据热点生成的创作方向；内容任务选中本记录后，文本模型会据此生成最终视频提示词'),
  @{ name = '提示词相关性分'; type = 'number'; description = '0-100 分，提示词与热点标题、封面和热点题材的相关性'; style = @{ type = 'plain'; precision = 0; percentage = $false; thousands_separator = $false } },
  (TextField '所属周期' '北京时间周周期，例如 2026-W32；只保留当前周期的抖音热点'),
  (TextField '提示词生成模型' '生成热点摘要和建议提示词时使用的文本/视觉模型ID'),
  (LinkField '热点方向配置' $tables.HotDirection '本条热点采集时采用的方向配置'),
  @{ name = '成交适配分'; type = 'number'; description = '0-100 分，衡量热点与商品场景、卖点展示和行动引导的适配度'; style = @{ type = 'plain'; precision = 0; percentage = $false; thousands_separator = $false } },
  @{ name = '涨粉适配分'; type = 'number'; description = '0-100 分，衡量热点传播钩子、互动性和账号人设沉淀的适配度'; style = @{ type = 'plain'; precision = 0; percentage = $false; thousands_separator = $false } },
  @{ name = '复刻适配分'; type = 'number'; description = '0-100 分，衡量热点画面、动作和镜头是否适合稳定复刻生产'; style = @{ type = 'plain'; precision = 0; percentage = $false; thousands_separator = $false } },
  (SelectField '系统推荐方向' $false @((Option '电商成交' 'Orange'), (Option '账号涨粉' 'Blue'), (Option '复刻生产' 'Purple'))),
  (TextField '推荐理由' '三项适配分和命中信号的简要说明'),
  @{ name = '抓取时间'; type = 'datetime'; style = @{ format = 'yyyy-MM-dd HH:mm' } },
  (SelectField '是否启用' $false @((Option '是' 'Green'), (Option '否' 'Gray')) @('是'))
)
foreach ($field in $promptLibraryFields) { Ensure-Field $tables.PromptLibrary $field }

$hotDirectionFields = @(
  (SelectField '目标方向' $false @((Option '电商成交' 'Orange'), (Option '账号涨粉' 'Blue'), (Option '复刻生产' 'Purple'))),
  (TextField '热点题材' '例如：传统国风舞剑/武术。采集器优先寻找与该题材相关的视频热点'),
  (TextField '包含关键词' '使用逗号、顿号或空格分隔，用于计算题材匹配度'),
  (TextField '排除关键词' '命中后不进入提示词库，例如游戏、手游'),
  @{ name = '每日热点数量'; type = 'number'; style = @{ type = 'plain'; precision = 0; percentage = $false; thousands_separator = $false } },
  @{ name = '最低方向匹配分'; type = 'number'; style = @{ type = 'plain'; precision = 0; percentage = $false; thousands_separator = $false } },
  (SelectField '补足策略' $false @((Option '严格匹配' 'Gray'), (Option '智能补足' 'Blue'))),
  @{ name = '智能补足最低分'; type = 'number'; style = @{ type = 'plain'; precision = 0; percentage = $false; thousands_separator = $false } },
  (SelectField '立即刷新热点' $false @((Option '否' 'Gray'), (Option '是' 'Green')) @('否')),
  (SelectField '是否启用' $false @((Option '是' 'Green'), (Option '否' 'Gray')))
)
foreach ($field in $hotDirectionFields) { Ensure-Field $tables.HotDirection $field }
Ensure-InitialHotDirectionRecord $tables.HotDirection

$accessFields = @(
  @{ name = '接入编号'; type = 'auto_number'; style = @{ rules = @(@{ type = 'text'; text = 'API-' }, @{ type = 'incremental_number'; length = 4 }) } },
  (SelectField '服务商类型' $false @((Option '小云雀' 'Blue'), (Option 'Kimi' 'Purple'), (Option 'OpenAI兼容' 'Green'), (Option '中转站' 'Orange'), (Option '其他' 'Gray'))),
  (SelectField 'API协议' $false @((Option 'Chat Completions' 'Purple'), (Option 'Videos' 'Orange'), (Option 'XYQ Skill' 'Blue'))),
  (SelectField '视频接口样式' $false @((Option 'OpenAI Videos' 'Green'), (Option 'NewAPI Video Generations' 'Orange'), (Option 'APIMesh Videos Generations' 'Blue')) @('OpenAI Videos')),
  (TextField '接口地址' '不包含密钥的API Base URL' 'url'),
  (TextField '模型名称' '飞书中显示的模型名称'),
  (TextField '模型ID' '请求中实际使用的model值'),
  (SelectField '模型能力' $true @((Option '文本' 'Purple'), (Option '视觉分析' 'Blue'), (Option '图像生成' 'Green'), (Option '视频生成' 'Orange'))),
  (TextField '本机密钥别名' '指向本机DPAPI凭据库，不保存API密钥'),
  (TextField '密钥尾号' '仅显示密钥最后四位'),
  @{ name = '配置接入'; type = 'formula'; expression = 'HYPERLINK("http://127.0.0.1:17386/api-config?record_id="&RECORD_ID(),"配置/验证")'; description = '记录保存后，在当前电脑打开本地密钥配置页' },
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
  @($tables.XyqContent, (LinkField '提示词库' $tables.PromptLibrary '可选；选中后先用文本/分析模型根据该热点建议生成视频提示词，再调用小云雀生成视频')),
  @($tables.RelayContent, (LinkField '文本/分析模型' $tables.AccessApi '生成提示词或分析参考素材的模型')),
  @($tables.RelayContent, (LinkField '提示词库' $tables.PromptLibrary '可选；配合“生成视频提示词=是/重新生成”，把该热点建议加入视频提示词生成')),
  @($tables.LtxContent, (LinkField '分镜分析模型' $tables.AccessApi '分析参考视频并生成分镜提示词的模型')),
  @($tables.LtxContent, (LinkField '视频生成模型' $tables.AccessApi '实际生成LTX视频的模型')),
  @($tables.PlatformPublish, (LinkField '发布文案模型' $tables.AccessApi '生成标题、文案和标签的模型'))
)) {
  Ensure-Field $definition[0] $definition[1]
}
Ensure-Field $tables.XyqContent @{ name = '最终视频文件'; type = 'attachment'; description = 'Worker 下载最终视频后上传到这里，用于飞书内在线预览' }
Ensure-RenamedLinkField $tables.RelayContent '视频生成模型' '视频生成选用' $tables.AccessApi '选择实际生成视频时使用的模型'
Ensure-Field $tables.RelayContent (LinkField '平台发布' $tables.PlatformPublish '关联本条中转站内容对应的平台发布任务' $true '中转站生成内容管理')
Ensure-RenamedExistingLinkField $tables.PlatformPublish '中转站生成内容管理' '中转站内容' $tables.RelayContent '从中转站生成内容管理选择待发布的视频；与“内容”（小云雀内容）二选一。'
$relayPromptGenerationField = SelectField '生成视频提示词' $false @((Option '否' 'Gray'), (Option '是' 'Green'), (Option '重新生成' 'Orange')) @('否')
$relayPromptGenerationField.description = '控制是否生成视频提示词：选“是”会按输入要求和参考素材生成；选“重新生成”会覆盖当前视频提示词重新生成；选“否”则跳过提示词生成，可手动填写。'
Ensure-RenamedSelectField $tables.XyqContent '视频提示词选用' $relayPromptGenerationField
Ensure-RenamedSelectField $tables.RelayContent '视频提示词选用' $relayPromptGenerationField
$targetDirectionField = SelectField '目标方向' $false @((Option '电商成交' 'Orange'), (Option '账号涨粉' 'Blue'), (Option '复刻生产' 'Purple'))
$targetDirectionField.description = '只能单选。手动选择会覆盖提示词库的系统推荐；留空则使用提示词库“系统推荐方向”。'
Ensure-SelectFieldDefinition $tables.XyqContent $targetDirectionField
Ensure-SelectFieldDefinition $tables.RelayContent $targetDirectionField
$seedField = @{ name = '随机种子'; type = 'number'; description = '可选，填写整数即可，例如 1、42、20260722。作用：在同一视频模型、同一提示词和相近参数下，使用相同随机种子会尽量生成风格/构图/动作更接近的结果，便于复现或微调；换一个数字会让画面随机变化。不会填写就留空，系统会自动随机生成。'; style = @{ type = 'plain'; precision = 0; percentage = $false; thousands_separator = $false } }
$generateVideoField = SelectField '是否立刻生成视频' $false @((Option '否' 'Gray'), (Option '是' 'Green'), (Option '重试生成' 'Orange')) @('否')
$generateVideoField.description = '控制视频任务提交：选“是”提交一次视频生成；选“重试生成”会清除旧任务ID并重新提交一次；选“否”不提交视频。'
Ensure-SelectFieldDefinition $tables.RelayContent $generateVideoField

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
  $seedField,
  (SelectField '生成状态' $false @((Option '待生成提示词' 'Gray'), (Option '生成提示词中' 'Blue'), (Option '待生成视频' 'Orange'), (Option '生成中' 'Blue' 'Light'), (Option '已完成' 'Green'), (Option '失败' 'Red'), (Option '需要配置' 'Carmine')) @('待生成提示词')),
  (TextField '外部任务ID' '中转站返回的任务ID'),
  @{ name = '最终视频'; type = 'attachment' },
  (TextField '最终视频链接' '中转站生成结果或中继链接' 'url'),
  @{ name = '提交时间'; type = 'datetime'; style = @{ format = 'yyyy-MM-dd HH:mm' } },
  @{ name = '完成时间'; type = 'datetime'; style = @{ format = 'yyyy-MM-dd HH:mm' } },
  (TextField '失败原因' '配置、接口、素材或回填失败原因')
)
foreach ($field in $relayFields) { Ensure-Field $tables.RelayContent $field }
Ensure-FieldDescription $tables.RelayContent '随机种子' $seedField
Remove-FieldIfExists $tables.RelayContent '实际文本模型'
Remove-FieldIfExists $tables.RelayContent '实际视频模型'
Remove-FieldIfExists $tables.RelayContent '重试生成'

Write-Host '飞书模型路由字段已检查并补齐。'





