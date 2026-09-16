@echo off
rem Launch Falcon in development. Started from the "Falcon Dev" desktop
rem shortcut, so it locates the repo from its own path rather than relying on
rem whatever directory the shortcut happens to run in.
setlocal
title Falcon Dev

cd /d "%~dp0.."
echo Starting Falcon (dev) from %CD%
echo.

call pnpm dev:desktop

rem Dev server stopped, or never started. Hold the window open so the reason
rem is readable instead of vanishing with the console.
echo.
echo Falcon Dev exited with code %ERRORLEVEL%.
pause
endlocal
