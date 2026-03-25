const { app, BrowserWindow, systemPreferences } = require('electron');
const path = require('path');
const { spawn } = require('child_process');

let mainWindow;
let pythonProcess;

const PYTHON_PORT = 5555;

function findPython() {
  // In packaged app, use bundled Python backend
  const bundledPath = path.join(process.resourcesPath, 'python-backend', 'vision-backend');
  try {
    require('fs').accessSync(bundledPath);
    return { cmd: bundledPath, args: [], cwd: path.join(process.resourcesPath, 'python-backend') };
  } catch (e) {
    // Development mode: use system python
    const pythonDir = path.join(__dirname, 'python');
    return { cmd: 'python3', args: ['run.py'], cwd: pythonDir };
  }
}

function startPythonBackend() {
  return new Promise((resolve, reject) => {
    const { cmd, args, cwd } = findPython();
    console.log(`[Main] Starting Python backend: ${cmd} ${args.join(' ')} in ${cwd}`);

    pythonProcess = spawn(cmd, args, {
      cwd: cwd,
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
    });

    let resolved = false;

    pythonProcess.stdout.on('data', (data) => {
      const text = data.toString();
      process.stdout.write(`[Python] ${text}`);
      if (!resolved && text.includes('READY')) {
        resolved = true;
        resolve();
      }
    });

    pythonProcess.stderr.on('data', (data) => {
      process.stderr.write(`[Python:err] ${data.toString()}`);
    });

    pythonProcess.on('error', (err) => {
      console.error('[Main] Failed to start Python:', err);
      if (!resolved) reject(err);
    });

    pythonProcess.on('exit', (code) => {
      console.log(`[Main] Python exited with code ${code}`);
      pythonProcess = null;
    });

    // Timeout: resolve anyway after 60s (models may take time to download)
    setTimeout(() => {
      if (!resolved) {
        console.log('[Main] Python startup timeout, proceeding anyway...');
        resolved = true;
        resolve();
      }
    }, 60000);
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 850,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  mainWindow.loadFile('renderer/index.html');
}

app.whenReady().then(async () => {
  // macOS camera permission
  if (process.platform === 'darwin') {
    const status = systemPreferences.getMediaAccessStatus('camera');
    console.log('[Main] Camera permission status:', status);
    if (status !== 'granted') {
      const granted = await systemPreferences.askForMediaAccess('camera');
      console.log('[Main] Camera permission granted:', granted);
    }
  }

  await startPythonBackend();
  createWindow();
});

app.on('window-all-closed', () => {
  if (pythonProcess) {
    pythonProcess.kill();
  }
  app.quit();
});

app.on('before-quit', () => {
  if (pythonProcess) {
    pythonProcess.kill();
    pythonProcess = null;
  }
});
