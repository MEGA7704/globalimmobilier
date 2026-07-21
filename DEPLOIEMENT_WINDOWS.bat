@echo off
setlocal
cd /d "%~dp0"
echo ===============================================
echo GLOBAL IMMOBILIER - DEPLOIEMENT CLOUDFLARE
echo Projet : globalimmobilier
echo URL    : https://globalimmobilier.pages.dev/
echo ===============================================
echo.
npx --yes wrangler@latest login
if errorlevel 1 goto :error
node scripts\deploy-complete.mjs
if errorlevel 1 goto :error
echo.
echo DEPLOIEMENT TERMINE.
pause
exit /b 0
:error
echo.
echo Une erreur est survenue. Verifiez le message ci-dessus.
pause
exit /b 1
