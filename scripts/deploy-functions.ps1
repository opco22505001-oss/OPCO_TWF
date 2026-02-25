Param(
  [string]$ProjectRef = "fuevhcdfgmdjhpdiwtzr",
  [string[]]$Functions = @(
    "auth-login",
    "admin-manage-user-role",
    "admin-dashboard-metrics",
    "admin-audit-logs",
    "admin-event-action",
    "admin-judgment-analytics"
  )
)

$ErrorActionPreference = "Stop"

$supabaseCmd = ".npm-cache\_npx\b96a6bd565c470ce\node_modules\.bin\supabase.cmd"
if (-not (Test-Path $supabaseCmd)) {
  throw "Supabase CLI 경로를 찾을 수 없습니다: $supabaseCmd"
}

foreach ($fn in $Functions) {
  Write-Host "[deploy] $fn"
  cmd /c "$supabaseCmd functions deploy $fn --no-verify-jwt --project-ref $ProjectRef"
}

Write-Host "[deploy] done"
