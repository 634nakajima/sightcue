const { app, BrowserWindow, systemPreferences, ipcMain, dialog } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');
const oscSender = require('./lib/osc-sender');

let mainWindow;
let pythonProcess;

const PYTHON_PORT = 5555;

// ── Python backend lifecycle (lazy) ─────────────────────────

function findPython() {
  const bundledPath = path.join(process.resourcesPath, 'python-backend', 'vision-backend');
  try {
    fs.accessSync(bundledPath);
    return { cmd: bundledPath, args: [], cwd: path.join(process.resourcesPath, 'python-backend') };
  } catch (e) {
    const pythonDir = path.join(__dirname, 'python');
    return { cmd: 'python3', args: ['run.py'], cwd: pythonDir };
  }
}

function startPythonBackend() {
  if (pythonProcess) return Promise.resolve();
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
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('python:log', text);
      if (!resolved && text.includes('READY')) {
        resolved = true;
        resolve();
      }
    });

    pythonProcess.stderr.on('data', (data) => {
      const text = data.toString();
      process.stderr.write(`[Python:err] ${text}`);
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('python:log', text);
    });

    pythonProcess.on('error', (err) => {
      console.error('[Main] Failed to start Python:', err);
      pythonProcess = null;
      if (!resolved) { resolved = true; reject(err); }
    });

    pythonProcess.on('exit', (code) => {
      console.log(`[Main] Python exited with code ${code}`);
      pythonProcess = null;
    });

    setTimeout(() => {
      if (!resolved) {
        console.log('[Main] Python startup timeout, proceeding anyway...');
        resolved = true;
        resolve();
      }
    }, 120000);
  });
}

function stopPythonBackend() {
  if (pythonProcess) {
    pythonProcess.kill();
    pythonProcess = null;
  }
}

// ── IPC handlers ─────────────────────────

function setupIPC() {
  // Python lifecycle
  ipcMain.handle('python:start', async () => {
    await startPythonBackend();
    return { port: PYTHON_PORT };
  });

  ipcMain.handle('python:stop', () => {
    stopPythonBackend();
    return true;
  });

  ipcMain.handle('python:status', () => {
    return { running: !!pythonProcess, port: PYTHON_PORT };
  });

  // Node.js OSC (for MediaPipe and TM modes)
  ipcMain.on('osc:send', (event, { address, args }) => {
    oscSender.send(address, args);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('osc:monitor', { address, args, timestamp: Date.now() });
    }
  });

  ipcMain.on('osc:sendFloat', (event, { address, value }) => {
    oscSender.sendFloat(address, value);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('osc:monitor', {
        address, args: [{ type: 'f', value }], timestamp: Date.now()
      });
    }
  });

  ipcMain.on('osc:sendLandmarks', (event, payload) => {
    const { hands, face } = payload;

    if (hands) {
      if (hands.left) {
        oscSender.sendFloat('/hand/left/detected', 1);
        oscSender.sendLandmarks('hand', 'left', hands.left.landmarks);
        if (hands.left.gesture) {
          oscSender.sendFloat('/hand/left/gesture/index', hands.left.gestureIndex);
          oscSender.sendFloat('/hand/left/gesture/score', hands.left.gestureScore);
        }
      } else {
        oscSender.sendFloat('/hand/left/detected', 0);
      }
      if (hands.right) {
        oscSender.sendFloat('/hand/right/detected', 1);
        oscSender.sendLandmarks('hand', 'right', hands.right.landmarks);
        if (hands.right.gesture) {
          oscSender.sendFloat('/hand/right/gesture/index', hands.right.gestureIndex);
          oscSender.sendFloat('/hand/right/gesture/score', hands.right.gestureScore);
        }
      } else {
        oscSender.sendFloat('/hand/right/detected', 0);
      }
    }

    if (face && face.length > 0) {
      oscSender.sendFloat('/face/detected', 1);
      oscSender.sendLandmarks('face', null, face);
    } else {
      oscSender.sendFloat('/face/detected', 0);
    }
  });

  ipcMain.handle('osc:updateConfig', (event, { host, port }) => {
    oscSender.setConfig(host, port);
    return oscSender.getStatus();
  });

  ipcMain.handle('osc:getStatus', () => {
    return oscSender.getStatus();
  });

  // TM: model ZIP selection
  ipcMain.handle('select-model-zip', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      filters: [{ name: 'ZIP files', extensions: ['zip'] }],
      properties: ['openFile'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;

    const zipPath = result.filePaths[0];
    const AdmZip = require('adm-zip');
    const zip = new AdmZip(zipPath);
    const extractDir = path.join(app.getPath('userData'), 'models', path.basename(zipPath, '.zip'));
    zip.extractAllTo(extractDir, true);
    return extractDir;
  });

  // TM: cache clearing
  ipcMain.handle('clear-cache', async () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      await mainWindow.webContents.session.clearCache();
    }
    return true;
  });
}

// ── Window creation ─────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  mainWindow.loadFile('renderer/index.html');
}

// ── App lifecycle ─────────────────────────

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

  // Initialize Node.js OSC sender
  oscSender.init();

  // Setup IPC handlers
  setupIPC();

  // Create window WITHOUT starting Python (lazy start on BLIP mode)
  createWindow();
});

app.on('window-all-closed', () => {
  stopPythonBackend();
  oscSender.close();
  app.quit();
});

app.on('before-quit', () => {
  stopPythonBackend();
  oscSender.close();
});
