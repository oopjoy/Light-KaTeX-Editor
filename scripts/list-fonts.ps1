$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$fonts = (New-Object System.Drawing.Text.InstalledFontCollection).Families | ForEach-Object { $_.Name }
$want = @(
  'Cascadia Code', 'Cascadia Mono', 'Consolas',
  'Microsoft YaHei', 'Microsoft YaHei UI',
  'Noto Sans SC', 'Noto Sans Mono CJK SC',
  'Source Han Sans SC', 'Source Han Mono SC',
  'Sarasa Gothic SC', 'Sarasa Mono SC', 'Sarasa Term SC',
  'SimSun', 'SimHei', 'DengXian', 'FangSong', 'KaiTi',
  'Courier New', 'Segoe UI', 'JetBrains Mono', 'Fira Code'
)
foreach ($w in $want) {
  $hit = @($fonts | Where-Object { $_ -eq $w -or $_.StartsWith($w) } | Select-Object -First 3)
  if ($hit.Count -gt 0) {
    Write-Output ("FOUND: {0} => {1}" -f $w, ($hit -join ', '))
  } else {
    Write-Output ("MISS:  {0}" -f $w)
  }
}
Write-Output '--- interesting ---'
$fonts | Where-Object {
  $_ -match 'Mono|Sarasa|Noto|YaHei|Source Han|JetBrains|Fira|Iosevka|Maple|LXGW|Cascadia|Consolas'
} | Sort-Object | ForEach-Object { Write-Output $_ }
