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
  const isWin = process.platform === 'win32';
  const exeName = isWin ? 'vision-backend.exe' : 'vision-backend';
  const backendDir = path.join(process.resourcesPath, 'python-backend');
  const bundledPath = path.join(backendDir, exeName);

  let dirContents;
  try {
    const entries = fs.readdirSync(backendDir);
    dirContents = entries.length ? entries.join(', ') : '(empty)';
  } catch (e) {
    dirContents = `(not found: ${e.message})`;
  }

  try {
    fs.accessSync(bundledPath, fs.constants.F_OK);
    return { cmd: bundledPath, args: [], cwd: backendDir };
  } catch (e) {
    if (app.isPackaged) {
      throw new Error(
        `Bundled backend not found.\nLooked for: ${bundledPath}\npython-backend contents: ${dirContents}`
      );
    }
    // Development fallback
    const pythonCmd = isWin ? 'python' : 'python3';
    return { cmd: pythonCmd, args: ['run.py'], cwd: path.join(__dirname, 'python') };
  }
}

function startPythonBackend() {
  if (pythonProcess) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let pythonConfig;
    try {
      pythonConfig = findPython();
    } catch (e) {
      return reject(e);
    }
    const { cmd, args, cwd, shell } = pythonConfig;
    console.log(`[Main] Starting Python backend: ${cmd} ${args.join(' ')} in ${cwd}`);

    pythonProcess = spawn(cmd, args, {
      cwd: cwd,
      env: { ...process.env, PYTHONUNBUFFERED: '1', SIGHTCUE_DATA_DIR: app.getPath('userData') },
      shell: !!shell,
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
      console.error('[Main] Failed to spawn Python process:', err);
      pythonProcess = null;
      if (!resolved) { resolved = true; reject(new Error(`Spawn failed: ${err.message}`)); }
    });

    pythonProcess.on('exit', (code) => {
      console.log(`[Main] Python exited with code ${code}`);
      pythonProcess = null;
      if (!resolved) {
        resolved = true;
        reject(new Error(`Python process exited early with code ${code}`));
      }
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
    // handsEnabled/faceEnabled say whether each tracker is running, so "not
    // detected" (0) is still reported when nothing is in frame. faceDetected is
    // separate from the point list: a face can be tracked while every one of
    // its points is deselected or outside the region.
    const { hands, face, faceDetected, handsEnabled, faceEnabled } = payload;
    const monitorMessages = [];

    const sendAndMonitor = (address, value) => {
      oscSender.sendFloat(address, value);
      monitorMessages.push({ address, args: [{ type: 'f', value }] });
    };

    const sendLmAndMonitor = (type, side, landmarks) => {
      for (const lm of landmarks) {
        const prefix = type === 'hand' ? `/hand/${side}/${lm.name}` : `/face/${lm.name}`;
        // Axes the renderer filtered out are absent from the landmark
        for (const axis of ['x', 'y', 'z']) {
          const value = lm[axis];
          if (typeof value !== 'number') continue;
          sendAndMonitor(`${prefix}/${axis}`, value);
        }
      }
    };

    if (handsEnabled) {
      for (const side of ['left', 'right']) {
        const hand = hands && hands[side];
        if (hand) {
          sendAndMonitor(`/hand/${side}/detected`, 1);
          sendLmAndMonitor('hand', side, hand.landmarks);
          if (hand.gesture) {
            sendAndMonitor(`/hand/${side}/gesture/index`, hand.gestureIndex);
            sendAndMonitor(`/hand/${side}/gesture/score`, hand.gestureScore);
          }
        } else {
          sendAndMonitor(`/hand/${side}/detected`, 0);
        }
      }
    }

    if (faceEnabled) {
      sendAndMonitor('/face/detected', faceDetected ? 1 : 0);
      if (faceDetected && face && face.length > 0) {
        sendLmAndMonitor('face', null, face);
      }
    }

    // Sent even when empty: the batch is the full set of landmark addresses
    // being emitted right now, so the monitor can prune everything else.
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('osc:monitorBatch', {
        messages: monitorMessages,
        prune: ['/hand/', '/face/'],
        timestamp: Date.now(),
      });
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
      backgroundThrottling: false,
    },
  });

  mainWindow.loadFile('renderer/index.html');
}

// ── App lifecycle ─────────────────────────

app.whenReady().then(async () => {
  // Initialize Node.js OSC sender
  oscSender.init();

  // Setup IPC handlers
  setupIPC();

  // Create window WITHOUT starting Python (lazy start on BLIP mode)
  createWindow();

  // macOS camera permission — must run after a window exists so the system
  // dialog has a parent to attach to.
  if (process.platform === 'darwin') {
    const status = systemPreferences.getMediaAccessStatus('camera');
    console.log('[Main] Camera permission status:', status);
    if (status !== 'granted') {
      const granted = await systemPreferences.askForMediaAccess('camera');
      console.log('[Main] Camera permission granted:', granted);
    }
  }
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
