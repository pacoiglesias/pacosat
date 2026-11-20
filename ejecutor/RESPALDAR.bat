@echo off
chcp 65001 >nul
title Respaldo del ejecutor de PacoSAT
setlocal

rem Carpeta donde vive este .bat (la del ejecutor)
set "ORIGEN=%~dp0"

rem Destino: carpeta hermana, con fecha y hora, FUERA de la del ejecutor
for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd-HHmm"') do set "STAMP=%%i"
set "DESTINO=%ORIGEN%..\respaldo-ejecutor-%STAMP%"

echo.
echo  Respaldo del ejecutor de PacoSAT
echo  Origen:  %ORIGEN%
echo  Destino: %DESTINO%
echo.

mkdir "%DESTINO%" 2>nul
set "FALTA="

if exist "%ORIGEN%token.txt" (
  copy /Y "%ORIGEN%token.txt" "%DESTINO%\" >nul
  echo  - token.txt copiado
) else (
  echo  - OJO: no encontre token.txt
  set "FALTA=1"
)

if exist "%ORIGEN%url.txt" (
  copy /Y "%ORIGEN%url.txt" "%DESTINO%\" >nul
  echo  - url.txt copiado
) else (
  echo  - url.txt no estaba - no es grave
)

if exist "%ORIGEN%efirma-local\" (
  robocopy "%ORIGEN%efirma-local" "%DESTINO%\efirma-local" /E /NFL /NDL /NJH /NJS >nul
  echo  - efirma-local copiada entera ^(.cer, .key y perfiles.json^)
) else (
  echo  - OJO: no encontre la carpeta efirma-local
  set "FALTA=1"
)

echo.
if defined FALTA (
  echo  Respaldo INCOMPLETO: falto lo marcado con OJO. Avisame.
) else (
  echo  Respaldo COMPLETO en: %DESTINO%
)
echo  Esa carpeta es tu acceso: guardala y no la compartas.
echo.
pause
