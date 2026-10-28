const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { autoUpdater } = require('electron-updater');

const APP_NAME = 'EasyDownloader';
let serverProcess;
let mainWindow;
let shuttingDown = false;
let quitAfterServerExit = false;
let updateStatus = { state: 'idle' };

autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = false;

function notifyUpdate(state, details = {}) {
  updateStatus = { state, ...details };
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update-status', updateStatus);
}

autoUpdater.on('checking-for-update', () => notifyUpdate('checking'));
autoUpdater.on('update-available', info => notifyUpdate('available', { version: info.version }));
autoUpdater.on('update-not-available', () => notifyUpdate('current'));
autoUpdater.on('download-progress', progress => notifyUpdate('downloading', { percent: Math.floor(progress.percent) }));
autoUpdater.on('update-downloaded', info => notifyUpdate('downloaded', { version: info.version }));
autoUpdater.on('error', error => notifyUpdate('error', { message: error.message }));

ipcMain.handle('check-for-update', async () => {
  if (!app.isPackaged) return { state: 'unavailable-in-development' };
  await autoUpdater.checkForUpdates();
  return { state: 'checking' };
});
ipcMain.handle('download-update', async () => {
  notifyUpdate('downloading', { percent: 0 });
  await autoUpdater.downloadUpdate();
  return { state: 'downloading' };
});
ipcMain.handle('install-update', () => {
  autoUpdater.quitAndInstall(false, true);
  return { state: 'installing' };
});

app.setAppUserModelId('com.easydownloader.app');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

function runtimePaths() {
  if (app.isPackaged) {
    return {
      node: path.join(process.resourcesPath, 'runtime', 'node.exe'),
      server: path.join(process.resourcesPath, 'app', 'server.mjs'),
      tools: path.join(process.resourcesPath, 'tools')
    };
  }
  const root = path.resolve(__dirname, '..');
  return {
    node: 'node.exe',
    server: path.join(root, 'server.mjs'),
    tools: path.join(root, 'tools')
  };
}

function choosePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function waitForServer(url, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const check = async () => {
      if (shuttingDown) return reject(new Error('Application is closing.'));
      if (serverProcess?.exitCode !== null && serverProcess?.exitCode !== undefined) {
        return reject(new Error(`Local service exited with code ${serverProcess.exitCode}.`));
      }
      try {
        const response = await fetch(`${url}/api/config`, { signal: AbortSignal.timeout(1200) });
        if (response.ok) return resolve();
      } catch { /* The service may still be starting. */ }
      if (Date.now() >= deadline) return reject(new Error('Local service did not start in time.'));
      setTimeout(check, 250);
    };
    check();
  });
}

function logFile() {
  const dir = path.join(app.getPath('userData'), 'logs');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'service.log');
  try {
    if (fs.statSync(file).size > 5 * 1024 * 1024) fs.renameSync(file, `${file}.1`);
  } catch { /* First launch. */ }
  return fs.openSync(file, 'a');
}

async function startService() {
  const paths = runtimePaths();
  for (const file of [paths.node, paths.server]) {
    if (!fs.existsSync(file)) throw new Error(`Required application file is missing: ${file}`);
  }

  const port = await choosePort();
  const userData = app.getPath('userData');
  fs.mkdirSync(userData, { recursive: true });
  const output = logFile();
  serverProcess = spawn(paths.node, [paths.server], {
    cwd: path.dirname(paths.server),
    windowsHide: true,
    stdio: ['ignore', output, output],
    env: {
      ...process.env,
      LOCAL_DOWNLOADER_PORT: String(port),
      EASY_DOWNLOADER_NO_BROWSER: '1',
      EASY_DOWNLOADER_TOOLS_DIR: paths.tools,
      EASY_DOWNLOADER_DATA_DIR: userData
    }
  });
  serverProcess.once('error', error => {
    if (!shuttingDown) dialog.showErrorBox(APP_NAME, `无法启动本地服务：${error.message}`);
  });
  serverProcess.once('exit', (code, signal) => {
    serverProcess = null;
    if (quitAfterServerExit) app.quit();
    else if (!shuttingDown) {
      dialog.showErrorBox(APP_NAME, `本地服务意外退出（${signal || code}）。可查看应用数据目录中的 logs/service.log。`);
      app.quit();
    }
  });

  const url = `http://127.0.0.1:${port}`;
  await waitForServer(url);
  return url;
}

async function createWindow() {
  const url = await startService();
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 860,
    minWidth: 760,
    minHeight: 620,
    show: false,
    title: APP_NAME,
    backgroundColor: '#f4f6fc',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.send('update-status', updateStatus);
  });
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
    app.quit();
  });
  await mainWindow.loadURL(url);
  if (app.isPackaged) {
    setTimeout(() => autoUpdater.checkForUpdates().catch(error => {
      notifyUpdate('error', { message: error.message });
    }), 1800).unref();
  }
}

app.whenReady().then(() => createWindow()).catch(error => {
  dialog.showErrorBox(APP_NAME, `启动失败：${error.message}\n\n如需排错，请查看应用数据目录中的 logs/service.log。`);
  app.quit();
});

app.on('before-quit', event => {
  if (shuttingDown || !serverProcess) return;
  event.preventDefault();
  shuttingDown = true;
  quitAfterServerExit = true;
  const child = serverProcess;
  child.kill('SIGTERM');
  const forceExit = setTimeout(() => {
    if (serverProcess === child) {
      spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
    }
  }, 5000);
  child.once('exit', () => clearTimeout(forceExit));
});
