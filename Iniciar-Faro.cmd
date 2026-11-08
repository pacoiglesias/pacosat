@echo off
setlocal
cd /d "%~dp0"
node -e "process.exit(Number(process.versions.node.split('.')[0])<24?1:0)" >nul 2>nul
if errorlevel 1 (
  echo Faro necesita Node.js 24 o superior.
  pause
  exit /b 1
)
if not exist "node_modules\@nodecfdi\sat-ws-descarga-masiva\package.json" goto instalar
if not exist "node_modules\@xmldom\xmldom\package.json" goto instalar
if not exist "node_modules\nodemailer\package.json" goto instalar
if not exist "node_modules\pdfjs-dist\package.json" goto instalar
goto iniciar
:instalar
echo Instalando componentes del SAT y correo. Este paso requiere internet.
call npm.cmd ci --omit=dev --ignore-scripts --no-audit --no-fund --fetch-retries=1 --fetch-timeout=20000
if errorlevel 1 echo No se instalaron todos los componentes. Podras usar el expediente local y reintentar al reiniciar.
:iniciar
node local-server.mjs --open
pause

