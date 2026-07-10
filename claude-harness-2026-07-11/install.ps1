# Windows 설치 진입점 — 실제 로직은 install.mjs (Node.js 필요)
& node "$PSScriptRoot\install.mjs"
exit $LASTEXITCODE
