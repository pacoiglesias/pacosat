@echo off
chcp 65001 >nul
cd /d %~dp0
rem ================================================================
rem  CAMINO MANUAL DE RESERVA (2.0.1, mejora 31).
rem  El camino normal ya no es este archivo: el ejecutor queda
rem  residente (arranca solo con Windows, oculto) y los botones
rem  de PacoSAT lo despiertan por el protocolo pacosat://.
rem  Este .bat queda por si un dia hace falta arrancarlo a mano:
rem  prepara el emparejamiento si falta y arranca POR despertar.vbs.
rem
rem  (2.3.2, M-4) Ya no se lanza «node ejecutor-local.mjs» a pelo
rem  desde aqui: ese camino saltaba el chequeo de instancia unica
rem  (YaCorre de despertar.vbs) y duplicaba el ejecutor si el
rem  residente estaba vivo. despertar.vbs garantiza instancia
rem  unica, relanza tras una auto-actualizacion (salida 42) y
rem  restaura la copia anterior si el ejecutor muere al arrancar
rem  una y otra vez. El ejecutor, ademas, lleva su propio cerrojo
rem  de instancia: el duplicado ya no puede latir ni reclamar.
rem ================================================================
setlocal EnableDelayedExpansion
title Ejecutor local de PacoSAT - no cierres esta ventana
where node >nul 2>nul
if errorlevel 1 (
  echo No se encontro Node.js en este equipo.
  echo Instalalo desde https://nodejs.org ^(la version LTS^) y vuelve a abrir este archivo.
  pause
  exit /b 1
)
if exist token.txt (
  echo Este equipo ya esta emparejado.
) else if exist codigo.txt (
  echo Emparejando con tu codigo corto: el ejecutor guarda la llave el solo al arrancar.
) else (
  echo Este equipo aun no esta emparejado.
  echo Opcion sencilla: cierra esta ventana y usa INSTALAR.bat ^(te pide el codigo corto de PacoSAT^).
  echo Opcion clasica: pega aqui el token largo del ejecutor ^(no se ve al teclear^):
  for /f "delims=" %%T in ('powershell -NoProfile -Command "$s = Read-Host 'Token del ejecutor' -AsSecureString; [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))"') do set "TOKEN_MANUAL=%%T"
  <nul set /p "=!TOKEN_MANUAL!" >token.txt
)
echo.
echo Arrancando el ejecutor de PacoSAT A MANO (camino de reserva),
echo a traves de despertar.vbs: instancia unica garantizada.
echo El camino normal es que viva residente y lo despierte PacoSAT.
echo Deja esta ventana abierta mientras lo uses.
echo.
cscript //nologo despertar.vbs
pause
