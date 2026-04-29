@echo off
setlocal

cd /d "%~dp0"

if "%PORT%"=="" set "PORT=3000"
set "APP_URL=http://localhost:%PORT%"
set "NODE_EXE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"

if not exist "%NODE_EXE%" (
  set "NODE_EXE=node"
)

echo.
echo Basa 3D Works - servidor de desenvolvimento
echo Porta: %PORT%
echo.

echo Encerrando servidor antigo na porta %PORT%, se existir...
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /R /C:":%PORT% .*LISTENING"') do (
  echo Encerrando PID %%P
  taskkill /PID %%P /F >nul 2>nul
)

echo.
echo Iniciando servidor...
start "Basa 3D Works Server" cmd /k ""%NODE_EXE%" src/server.mjs"

timeout /t 2 /nobreak >nul

echo Abrindo %APP_URL%
start "" "%APP_URL%"

endlocal
