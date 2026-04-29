#!/bin/bash
# Build Python backend with PyInstaller
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PYTHON_DIR="$PROJECT_DIR/python"

cd "$PYTHON_DIR"

echo "Installing PyInstaller..."
pip3 install pyinstaller

echo "Building Python backend..."
python3 -m PyInstaller \
  --onedir \
  --name vision-backend \
  --distpath "$PROJECT_DIR/release/python-backend" \
  --workpath "$PROJECT_DIR/release/python-build" \
  --specpath "$PROJECT_DIR/release" \
  --noconfirm \
  --collect-all torch \
  --collect-all transformers \
  --collect-all sentence_transformers \
  --collect-all tokenizers \
  --hidden-import=flask \
  --hidden-import=flask_socketio \
  --hidden-import=engineio.async_drivers.threading \
  --add-data "$PYTHON_DIR/config.yaml:." \
  run.py

# Copy data directory
mkdir -p "$PROJECT_DIR/release/python-backend/vision-backend/data"

echo "Python backend built to: release/python-backend/vision-backend/"
echo "Size: $(du -sh "$PROJECT_DIR/release/python-backend/vision-backend/" | cut -f1)"
