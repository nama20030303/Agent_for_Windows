<#
.SYNOPSIS
  Pre-configures Nexus Code with a provider API key, so the application is ready
  to work on first launch without opening Settings.

.DESCRIPTION
  Writes %APPDATA%\NexusCode\config\bootstrap.json. On the next launch Nexus Code
  imports the key into the OS-encrypted credential store (Windows DPAPI), skips
  onboarding, and overwrites and deletes this plaintext file.

  The key is never written to the repository, the logs or any project file.

.EXAMPLE
  .\provision-credentials.ps1
  Prompts for the key without echoing it to the screen.

.EXAMPLE
  .\provision-credentials.ps1 -ApiKey $env:MY_KEY -Model 'am/nemotron-3-ultra-550b-a55b'
#>
[CmdletBinding()]
param(
  [string] $ApiKey,
  [string] $BaseUrl = 'https://api.nemotron.ai/v1',
  [string] $Model   = 'am/nemotron-3-ultra-550b-a55b'
)

$ErrorActionPreference = 'Stop'

if (-not $ApiKey) {
  $secure = Read-Host -Prompt 'Provider API key' -AsSecureString
  $ApiKey = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
    [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
}

if ([string]::IsNullOrWhiteSpace($ApiKey)) {
  throw 'No API key supplied.'
}

$configDir = Join-Path $env:APPDATA 'NexusCode\config'
New-Item -ItemType Directory -Path $configDir -Force | Out-Null

$target = Join-Path $configDir 'bootstrap.json'
[ordered]@{
  apiKey  = $ApiKey.Trim()
  baseUrl = $BaseUrl
  model   = $Model
} | ConvertTo-Json | Set-Content -Path $target -Encoding UTF8 -NoNewline

# Restrict the plaintext file to the current user until the app imports and wipes it.
$acl = Get-Acl $target
$acl.SetAccessRuleProtection($true, $false)
$acl.SetAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
  $env:USERNAME, 'FullControl', 'Allow')))
Set-Acl -Path $target -AclObject $acl

Write-Host "Credential staged at $target" -ForegroundColor Green
Write-Host "Model:    $Model"
Write-Host "Endpoint: $BaseUrl"
Write-Host ''
Write-Host 'Start Nexus Code: the key will be moved into encrypted storage and this file deleted.'
