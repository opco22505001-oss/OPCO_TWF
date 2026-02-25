Param(
  [switch]$WithSql
)

$ErrorActionPreference = "Stop"

Write-Host "[verify] JS syntax check start"
node --check js/main.js
node --check js/admin.js

if ($WithSql) {
  Write-Host "[verify] SQL file basic check"
  Get-ChildItem supabase/migrations/*.sql | ForEach-Object {
    if ((Get-Content -Raw $_.FullName).Trim().Length -eq 0) {
      throw "Empty SQL file: $($_.Name)"
    }
  }
}

Write-Host "[verify] done"
