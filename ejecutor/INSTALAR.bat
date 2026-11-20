@echo off
chcp 65001 >nul
cd /d %~dp0
rem Instalacion unica (2.0.1): empareja, guarda la e.firma en
rem este equipo y deja el ejecutor RESIDENTE (arranque solo con
rem Windows y despertador desde los botones de PacoSAT). Sobre
rem una instalacion que ya vive, no repite nada: solo aplica la
rem residencia. El detalle, en instalar.mjs y en LEEME.txt.
title Instalador del ejecutor de PacoSAT
where node >nul 2>nul
if errorlevel 1 (
  echo No se encontro Node.js en este equipo.
  echo Instalalo desde https://nodejs.org ^(la version LTS^) y vuelve a abrir este archivo.
  pause
  exit /b 1
)
node instalar.mjs
echo.
pause
