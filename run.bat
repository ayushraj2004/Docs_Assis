@echo off
echo ========================================
echo   RAG Document Assistant - Setup
echo ========================================

echo [1] Creating virtual environment...
python -m venv venv

echo [2] Activating virtual environment...
call venv\Scripts\activate.bat

echo [3] Installing dependencies...
pip install -r requirements.txt

echo [4] Done! Starting server...
echo.
echo  Open http://localhost:5000 in your browser
echo.
python app.py
pause
