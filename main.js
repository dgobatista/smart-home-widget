'use strict';
// Smart Home Widget — widget de bandeja para Windows.
// Sobe o servidor do dashboard e mostra o painel compacto ao clicar no ícone ao lado do relógio.

const { app, BrowserWindow, Tray, Menu, nativeImage, screen, shell, globalShortcut } = require('electron');
const { PORT, TITLE } = require('./server.js');

const APP_URL = `http://localhost:${PORT}/`;
const SIZE = { width: 400, height: 660 };
const MAX_HEIGHT = 900;
const MARGIN = 12;
const SHORTCUT = 'Control+Alt+H';

let win;
let tray;
let pinned = false;
let hiddenAt = 0;

// Ícone da bandeja: uma casinha desenhada pixel a pixel, para não depender de arquivo de imagem.
function trayIcon() {
  const n = 32;
  const buf = Buffer.alloc(n * n * 4);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const roof = y >= 4 && y < 15 && Math.abs(x - 15.5) <= (y - 3) * 1.25;
      const body = y >= 15 && y < 27 && x >= 7 && x <= 24;
      const door = y >= 19 && x >= 13 && x <= 18;
      if (roof || (body && !door)) buf.set([0x3d, 0xb8, 0xf5, 0xff], (y * n + x) * 4); // BGRA
    }
  }
  return nativeImage.createFromBitmap(buf, { width: n, height: n, scaleFactor: 2 });
}

function placeNearTray() {
  const { workArea } = screen.getPrimaryDisplay();
  win.setBounds({
    x: workArea.x + workArea.width - SIZE.width - MARGIN,
    y: workArea.y + workArea.height - SIZE.height - MARGIN,
    ...SIZE,
  });
}

// Ajusta a altura da janela ao conteúdo, para o painel caber inteiro sem rolagem.
async function fit() {
  const { workArea } = screen.getPrimaryDisplay();
  const content = await win.webContents.executeJavaScript('[...document.body.children].reduce((h, el) => Math.max(h, el.offsetTop + el.offsetHeight), 0) + 16').catch(() => 0);
  const height = Math.min(Math.max(content, 200), MAX_HEIGHT, workArea.height - 2 * MARGIN);
  if (!content || height === SIZE.height) return;
  const bottom = win.getBounds().y + win.getBounds().height;
  SIZE.height = height;
  if (pinned) win.setBounds({ ...win.getBounds(), y: bottom - height, height });
  else placeNearTray();
}

function show() {
  if (!pinned) placeNearTray();
  win.show();
  win.focus();
  fit();
}

function toggle() {
  if (win.isVisible()) return win.hide();
  // o clique na bandeja tira o foco do painel e o esconde; sem isto ele reabriria na hora
  if (Date.now() - hiddenAt > 250) show();
}

function menu() {
  return Menu.buildFromTemplate([
    { label: 'Mostrar / ocultar', accelerator: SHORTCUT, click: toggle },
    {
      label: 'Fixar na tela',
      type: 'checkbox',
      checked: pinned,
      click: (item) => {
        pinned = item.checked;
        if (pinned) show();
      },
    },
    { label: 'Abrir dashboard completo', click: () => shell.openExternal(APP_URL) },
    { type: 'separator' },
    {
      label: 'Iniciar com o Windows',
      type: 'checkbox',
      checked: app.getLoginItemSettings({ path: process.execPath, args: [app.getAppPath()] }).openAtLogin,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked, path: process.execPath, args: [app.getAppPath()] }),
    },
    { label: 'Sair', click: () => app.quit() },
  ]);
}

function createWindow() {
  win = new BrowserWindow({
    ...SIZE,
    show: false,
    frame: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: '#00000000',
    backgroundMaterial: 'acrylic', // vidro fosco do Windows 11
  });
  win.on('blur', () => {
    if (pinned) return;
    hiddenAt = Date.now();
    win.hide();
  });
  win.webContents.on('did-finish-load', () => setTimeout(fit, 2500)); // depois da primeira leitura dos dispositivos
  win.webContents.on('did-fail-load', () => setTimeout(() => win.loadURL(`${APP_URL}?widget`), 1000));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.loadURL(`${APP_URL}?widget`);
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', show);
  app.on('window-all-closed', () => {}); // continua vivo na bandeja
  app.on('will-quit', () => globalShortcut.unregisterAll());
  app.whenReady().then(() => {
    createWindow();
    tray = new Tray(trayIcon());
    tray.setToolTip(TITLE);
    tray.on('click', toggle);
    tray.on('right-click', () => tray.popUpContextMenu(menu()));
    globalShortcut.register(SHORTCUT, toggle);
    win.once('ready-to-show', show);
  });
}
