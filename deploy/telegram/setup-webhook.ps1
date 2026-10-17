$ErrorActionPreference = 'Stop'

function Read-PrivateValue([string]$Prompt) {
    $secureValue = Read-Host $Prompt -AsSecureString
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureValue)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
}

$siteOrigin = (Read-Host 'Site HTTPS origin, for example https://img.example.com').Trim().TrimEnd('/')
$siteUri = $null
if (-not [Uri]::TryCreate($siteOrigin, [UriKind]::Absolute, [ref]$siteUri) -or
    $siteUri.Scheme -ne 'https' -or $siteUri.AbsolutePath -ne '/' -or
    $siteUri.Query -or $siteUri.Fragment -or $siteUri.UserInfo) {
    throw 'Enter the HTTPS site origin without a path, query or credentials.'
}
$botToken = Read-PrivateValue 'Bot Token (hidden)'
$webhookSecret = Read-PrivateValue 'TG_WEBHOOK_SECRET, identical to Pages (hidden)'
if ($botToken -notmatch '^\d+:[A-Za-z0-9_-]+$' -or $webhookSecret -notmatch '^[A-Za-z0-9_-]{32,256}$') {
    throw 'Invalid Bot Token or Webhook secret format.'
}
try {
    $baseUri = 'https://api.telegram.org/bot' + $botToken
    $current = Invoke-RestMethod -Uri ($baseUri + '/getWebhookInfo') -Method Post -TimeoutSec 20
    if (-not $current.ok) { throw 'Unable to inspect Webhook.' }
    if ($current.result.url -and $current.result.url -ne ($siteOrigin + '/telegram/webhook')) {
        Write-Host ('Current Webhook: ' + ([Uri]$current.result.url).GetLeftPart([UriPartial]::Authority))
        $replace = Read-Host 'This Bot already has a different Webhook. Replace it? Type YES to continue'
        if ($replace -cne 'YES') { Write-Host 'No changes made.'; return }
    }
    $payload = @{
        url = $siteOrigin + '/telegram/webhook'
        secret_token = $webhookSecret
        allowed_updates = @('message')
        max_connections = 1
        drop_pending_updates = $false
    } | ConvertTo-Json -Compress
    $result = Invoke-RestMethod -Uri ($baseUri + '/setWebhook') -Method Post -ContentType 'application/json' -Body $payload -TimeoutSec 20
    if (-not $result.ok) { throw 'Webhook registration rejected.' }
    Write-Host 'Webhook registered. Send /start and then a small photo to the Bot to verify the complete upload flow.'
} catch {
    # PowerShell web errors may include the token-bearing URI; do not expose them.
    throw 'Telegram setup failed. Check the Token, network and existing Bot configuration. No secret values have been printed.'
} finally {
    $botToken = $null
    $webhookSecret = $null
    $baseUri = $null
    $payload = $null
}
