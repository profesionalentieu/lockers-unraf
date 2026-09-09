@echo off
REM ============================================================
REM  Pañol UNRaf - arranque rapido
REM  Doble clic en este archivo y queda todo prendido.
REM
REM  Abre dos ventanas: el servidor y el nodo simulado.
REM  Para apagar: Ctrl+C en cada ventana, o cerrarlas.
REM ============================================================

echo.
echo   Pañol inteligente - UNRaf
echo   Levantando el sistema...
echo.

REM %~dp0 es la carpeta donde esta este .bat, asi funciona
REM aunque muevas el proyecto de lugar.
cd /d "%~dp0backend"

REM Si no existe la base, la crea sola la primera vez.
if not exist "data\lockers.db" (
    echo   No hay base de datos todavia. Creandola...
    call npm.cmd run seed
    echo.
)

start "Panol - SERVIDOR" cmd /k npm.cmd start

REM Le damos unos segundos al servidor antes de prender el simulador.
timeout /t 4 /nobreak >nul

cd /d "%~dp0"
start "Panol - NODO SIMULADO" cmd /k node gateway/simulador_nodo.js

timeout /t 2 /nobreak >nul

start http://localhost:3000/admin
start http://localhost:3000/

echo.
echo   Listo. Se abrieron dos ventanas de terminal y dos pestañas:
echo     - Panel de Alumnado : http://localhost:3000/admin
echo     - App de usuarios   : http://localhost:3000/
echo.
echo   Para apagar todo, cerra las dos ventanas de terminal.
echo.
echo   NOTA: cuando el hardware este armado, reemplazar la ventana
echo   del NODO SIMULADO por el gateway real:
echo       python gateway\gateway_lora.py --puerto COM4
echo.
pause
