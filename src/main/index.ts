import { app, BrowserWindow, shell, Menu } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppServices } from './services.js';
import { registerIpc } from './ipc/handlers.js';
import { createLogger } from '../core/shared/logger.js';

const log = createLogger('main');
const __dirname_ = path.dirname(fileURLToPath(import.meta.url));

let mainWindow: BrowserWindow | null = null;
let services: AppServices | null = null;

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    backgroundColor: '#0f1115',
    title: 'Nexus Code',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname_, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: false,
      spellcheck: false
    }
  });

  window.once('ready-to-show', () => window.show());

  // External links never open inside the application.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://') && !url.startsWith(process.env.ELECTRON_RENDERER_URL ?? '\u0000')) {
      event.preventDefault();
    }
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void window.loadFile(path.join(__dirname_, '../renderer/index.html'));
  }
  return window;
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  void app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    services = await AppServices.create();
    mainWindow = createWindow();
    services.attachWindow(mainWindow);
    registerIpc(services, () => mainWindow);

    const last = services.settingsStore.public().lastWorkspace;
    if (last) {
      try {
        services.setWorkspace(last);
        void services.indexer.index(last);
      } catch (err) {
        log.warn('Could not reopen the last workspace', { reason: (err as Error).message });
      }
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        mainWindow = createWindow();
        services?.attachWindow(mainWindow);
      }
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => services?.dispose());

  process.on('uncaughtException', (err) => log.error('Uncaught exception', { reason: err.message }));
  process.on('unhandledRejection', (reason) => log.error('Unhandled rejection', { reason: String(reason) }));
}
