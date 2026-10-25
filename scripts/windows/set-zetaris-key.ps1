# Saves your Zetaris API key (and organisation ID) into .dev.vars without showing the key,
# then tests them with one read-only query (SELECT 1) against ZETARIS_REST_URL.
# Run it yourself; it asks for the key with hidden input. .dev.vars is gitignored.
#
# Usage (PowerShell):  powershell -ExecutionPolicy Bypass -File scripts\windows\set-zetaris-key.ps1
# Options: -OrgId <number> overrides ZETARIS_ORG_ID. If $env:ZETARIS_API_KEY is set, it is used
# instead of the prompt. The key is never printed.
param([string]$OrgId, [string]$Path = (Join-Path $PSScriptRoot '..\..\.dev.vars'))

$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $Path)) { throw "Not found: $Path. Copy .dev.vars.example to .dev.vars first." }
$Path = (Resolve-Path -LiteralPath $Path).Path
$script:lines = @(Get-Content -LiteralPath $Path)

function Get-Var([string]$Name) {
  foreach ($l in $script:lines) { if ($l -match "^\s*$Name\s*=\s*(.*?)\s*$") { return $Matches[1].Trim('"') } }
  return ''
}
function Set-Var([string]$Name, [string]$Value) {
  $script:found = $false
  $script:lines = @($script:lines | ForEach-Object { if ($_ -match "^\s*$Name\s*=") { $script:found = $true; "$Name=$Value" } else { $_ } })
  if (-not $script:found) { $script:lines += "$Name=$Value" }
}

if (-not $OrgId) { $OrgId = Get-Var 'ZETARIS_ORG_ID' }
if ($OrgId -notmatch '^\d+$') { $OrgId = "$(Read-Host 'Zetaris organisation ID (a number, from Management > Organisation)')".Trim() }
if ($OrgId -notmatch '^\d+$') { throw 'The organisation ID must be a number. Nothing was changed.' }

$key = $env:ZETARIS_API_KEY
if (-not $key) {
  $secure = Read-Host 'Paste your Zetaris API key (it stays hidden), then press Enter' -AsSecureString
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { $key = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}
$key = "$key".Trim().Trim('"')
if (-not $key -or $key -match '\s') { throw 'The API key was empty or contained spaces. Nothing was changed.' }

Set-Var 'ZETARIS_ORG_ID' $OrgId
Set-Var 'ZETARIS_API_KEY' $key
[IO.File]::WriteAllText($Path, ($script:lines -join "`n") + "`n")  # UTF-8 without BOM, LF endings
Write-Output "Saved ZETARIS_ORG_ID=$OrgId and ZETARIS_API_KEY ($($key.Length) characters, not shown) to $Path"

$rest = (Get-Var 'ZETARIS_REST_URL').TrimEnd('/')
if (-not $rest) { Write-Output 'ZETARIS_REST_URL is not set, so the key was not tested.'; exit 0 }
$body = @{ queryId = [guid]::NewGuid().ToString(); sql = 'SELECT 1'; source = 'SqlEditor'; limit = 1 } | ConvertTo-Json -Compress
$headers = @{ Authorization = "Bearer $key"; 'X-Org-ID' = $OrgId; 'X-Request-ID' = [guid]::NewGuid().ToString() }
try {
  $r = Invoke-RestMethod -Method Post -Uri "$rest/sql-editor/sqls/run" -Headers $headers -ContentType 'application/json' -Body $body -TimeoutSec 60
  $first = @($r.data | ForEach-Object { $_ })[0]
  if ("$first" -eq '1') { Write-Output 'Test passed: Zetaris accepted the key and SELECT 1 returned 1.' }
  else { Write-Output 'Zetaris answered, but SELECT 1 did not return 1. Tell Claude what happened.'; exit 1 }
} catch {
  $status = $null
  if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }
  # Zetaris 2.4 answers a wrong key or organisation ID with HTTP 400 {"msg":"Not Allowed"}.
  $refused = $status -in 401, 403 -or ($status -eq 400 -and "$($_.ErrorDetails.Message)" -match 'Not Allowed')
  if ($refused) { Write-Output "Test failed: Zetaris rejected the key or organisation ID (HTTP $status). Copy the whole key and run this again, or create a new key."; exit 1 }
  Write-Output "Could not test the key: $($_.Exception.Message)"; exit 1
}
