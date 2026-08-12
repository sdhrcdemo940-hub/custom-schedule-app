@echo off
REM Production Scheduler Setup Script for Windows

echo.
echo ========================================
echo Production Scheduler Setup
echo ========================================
echo.

REM Check if Node.js is installed
where node >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo ERROR: Node.js is not installed!
    echo Please install Node.js from https://nodejs.org/
    pause
    exit /b 1
)

echo [OK] Node.js found
node --version
echo.

REM Install backend dependencies
echo [1/4] Installing backend dependencies...
call npm install
if %ERRORLEVEL% NEQ 0 (
    echo ERROR: Failed to install backend dependencies
    pause
    exit /b 1
)
echo [OK] Backend dependencies installed
echo.

REM Install frontend dependencies
echo [2/4] Installing frontend dependencies...
cd frontend
call npm install
if %ERRORLEVEL% NEQ 0 (
    echo ERROR: Failed to install frontend dependencies
    cd ..
    pause
    exit /b 1
)
echo [OK] Frontend dependencies installed
cd ..
echo.

REM Check if .env exists
echo [3/4] Checking configuration...
if not exist .env (
    echo WARNING: .env file not found!
    echo Please create .env file with your ERPNext API credentials
    echo.
    echo Example .env:
    echo ERPNEXT_URL=http://localhost:8080
    echo ERPNEXT_API_KEY=your_api_key
    echo ERPNEXT_API_SECRET=your_api_secret
    echo PORT=3000
    echo.
) else (
    echo [OK] .env file found
)
echo.

echo [4/4] Setup complete!
echo.
echo ========================================
echo Next Steps:
echo ========================================
echo.
echo 1. Update .env with your ERPNext API credentials
echo.
echo 2. Start Backend (in this terminal):
echo    npm start
echo.
echo 3. In another terminal, start Frontend:
echo    cd frontend
echo    npm start
echo.
echo 4. Open http://localhost:3001 in your browser
echo.
echo ========================================
echo.
pause
