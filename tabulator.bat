@echo off
setlocal
TITLE Beauty Pageant App

SET "SYSTEM_NODE=C:\Program Files\nodejs\node.exe"
SET "BUNDLED_NODE=%~dp0node-v24.12.0-win-x64\node.exe"
SET "APP_ROOT=%~dp0"
SET "APP_PORT=3000"

echo Starting Beauty Pageant App...

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "$appRoot = [IO.Path]::GetFullPath($env:APP_ROOT);" ^
    "$port = [int]$env:APP_PORT;" ^
    "$conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1;" ^
    "if (-not $conn) { exit 0 }" ^
    "$proc = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $conn.OwningProcess);" ^
    "$commandLine = $proc.CommandLine;" ^
    "if ($proc.Name -like 'node*' -and $commandLine -like ('*' + $appRoot + '*server.js*')) { Write-Host ('Stopping previous Beauty Pageant App instance on port ' + $port + '...'); Stop-Process -Id $conn.OwningProcess -Force; Start-Sleep -Seconds 1; exit 0 }" ^
    "Write-Host ('Port ' + $port + ' is already in use by PID ' + $conn.OwningProcess + ' (' + $proc.Name + '). Close that process or change the port in server.js/.env.'); exit 2"

if errorlevel 2 (
    pause
    exit /b 1
)

if exist "%SYSTEM_NODE%" (
    echo Using system Node.js: %SYSTEM_NODE%
    call "%SYSTEM_NODE%" "%~dp0server.js"
) else if exist "%BUNDLED_NODE%" (
    echo Using bundled Node.js: %BUNDLED_NODE%
    call "%BUNDLED_NODE%" "%~dp0server.js"
) else (
    echo Node.js was not found.
    exit /b 1
)

:: Keep window open only if there is an error
if %ERRORLEVEL% neq 0 pause
