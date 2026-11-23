import { app, BrowserWindow, ipcMain, dialog, screen, shell, safeStorage } from 'electron';
import path from 'path';
import { exec, spawn } from 'child_process';
import fs from 'fs';
import http from 'http';
import https from 'https';
import crypto from 'crypto';
import { URL, fileURLToPath } from 'url';
import { parsePluginsTxt, parsePluginHeader, compareMods, analyzePlugins, parseCccTxt, analyzeCreationClub } from './parity.mjs';
import { checkFreeSpace, isDiskFull } from './disk.mjs';
import { syncUiBundle } from './ui-integrity.mjs';
import { syncVoiceHelper } from './voice-helper.mjs';
import { prepareConnectionSettings } from './connection-settings.mjs';
import {
  createHashCache,
  enableServerPlugins,
  installServerMods,
  planServerModSync,
  validateManifest
} from './server-mods.mjs';
import { checkLauncherUpdate, downloadInstaller } from './launcher-update.mjs';
import { checkSkse, installSkse, SKSE } from './skse-install.mjs';
import { ensureDepotDownloader, backupGameFiles, downgradeArgs, runDepotDownloader, isValidSteamUsername } from './skyrim-downgrade.mjs';
import {
  NEXUS_API_KEY_PAGE,
  createNexusApi,
  downloadArchive,
  extractProvided,
  nexusFilePageUrl,
  nexusSourcesOf,
  parseNxmUrl,
  planNexusDownloads
} from './nexus-mods.mjs';
import { startGameProcess } from './game-process.mjs';
import { startVoiceHelper, killVoiceHelper } from './voice-process.mjs';
import { createVoiceHandoffServer, VOICE_HANDOFF_PORT } from './voice-handoff.mjs';

// package.json has "type": "module", so Vite bundles this file as ESM —
// __dirname doesn't exist in ESM (it is a CommonJS-only global). Without this,
// any `npm start` failed on the first BrowserWindow with
// "ReferenceError: __dirname is not defined", before the window even opened.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Constants & Env ───
// These values are replaced at build time by the `define` in vite.config.ts —
// at runtime there is no `.env` on the packaged app's side.
// VITE_DISCORD_CLIENT_SECRET was removed on purpose: the secret lives only in
// the web panel (see POST /api/launcher/oauth/exchange).
const DISCORD_CLIENT_ID = process.env.VITE_DISCORD_CLIENT_ID || '';
const DISCORD_REDIRECT_URI = process.env.VITE_DISCORD_REDIRECT_URI || 'http://localhost:19847/callback';
const SERVER_IP = process.env.VITE_SERVER_IP || '127.0.0.1';
// Default 7777 to match the "port" in skymp/config/server-settings.*.json.
// The previous default was 7757, which existed nowhere on the server side.
const SERVER_PORT = parseInt(process.env.VITE_SERVER_PORT || '7777', 10);
const API_PORT = parseInt(process.env.VITE_API_PORT || '7758', 10);
const DIST_REPO = process.env.VITE_GITHUB_DIST_REPO || '';
const PANEL_URL = (process.env.VITE_PANEL_URL || 'http://127.0.0.1:3001').replace(/\/+$/, '');
const AUTH_FILE = path.join(app.getPath('userData'), 'auth.json');
const LAUNCHER_CONFIG_FILE = path.join(app.getPath('userData'), 'launcher-config.json');
const CLIENT_VERSION_FILENAME = 'skymp_client_version.txt';
const MODS_VERSION_FILENAME = 'skymp_mods_version.txt';
const MODS_PARTS_FILENAME = 'skymp_mods_parts.json';

let mainWindow: BrowserWindow | null = null;

function bundledUiDir() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'skymp-ui')
    : path.resolve(__dirname, '../../../skymp/ui');
}

function ensureSkympUi(gamePath: string) {
  if (!gamePath) return { ok: false, repaired: [], error: 'Invalid game path.' };
  return syncUiBundle({
    sourceDir: bundledUiDir(),
    targetDir: path.join(gamePath, 'Data', 'Platform', 'UI')
  });
}

// voice-helper.exe: microphone capture outside CEF for proximity voice.
// Packaged as resources/vendor/ when the C++ build was available at the time
// the installer was generated (scripts/stage-voice-helper.mjs). It may not
// exist: voice is optional and the helper doesn't come out of `npm run build`.
function bundledVoiceHelperPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'vendor', 'voice-helper.exe')
    : path.resolve(__dirname, '../../../voice-helper/build/Release/voice-helper.exe');
}

function ensureVoiceHelper(gamePath: string) {
  if (!gamePath) return { ok: false, repaired: false, error: 'Invalid game path.' };
  // Lives in Data/Platform/, alongside the rest of what SkyrimPlatform uses.
  return syncVoiceHelper({
    sourcePath: bundledVoiceHelperPath(),
    targetPath: deployedVoiceHelperPath(gamePath)
  });
}

function deployedVoiceHelperPath(gamePath: string) {
  return path.join(gamePath, 'Data', 'Platform', 'voice-helper.exe');
}

// ─── Voice ticket handoff ───
// The in-game /voice command issues a 'sender' ticket; CEF passes it on to this
// loopback server (port 19848), which starts voice-helper.exe with --ticket.
// All optional: with no exe, or with CEF unable to do the fetch, speaking
// doesn't start and listening carries on. See docs/technical/VOICE_NATIVE_HELPER.md §11.
let voiceHandoff: ReturnType<typeof createVoiceHandoffServer> | null = null;
let voiceWatchdog: NodeJS.Timeout | null = null;
let voiceHandoffMissingLogged = false;

function resolveVoiceHelperExe(gamePath: string): string | null {
  const deployed = deployedVoiceHelperPath(gamePath);
  if (fs.existsSync(deployed)) return deployed;
  const bundled = bundledVoiceHelperPath();
  return fs.existsSync(bundled) ? bundled : null;
}

async function armVoiceHandoff(gamePath: string) {
  const exePath = resolveVoiceHelperExe(gamePath);
  if (!exePath) {
    if (!voiceHandoffMissingLogged) {
      voiceHandoffMissingLogged = true;
      console.info('[launcher] voice-helper.exe missing; voice handoff disabled for this session.');
    }
    return;
  }

  if (!voiceHandoff) {
    voiceHandoff = createVoiceHandoffServer({
      async onHandoff({ actorId, ticket, host, port }) {
        const args = [
          '--actor-id', `0x${actorId.toString(16).toUpperCase()}`,
          '--ticket', ticket,
          '--host', host,
          '--port', String(port)
        ];
        const r = await startVoiceHelper(exePath, args, gamePath);
        console.info(`[launcher] voice-helper started (pid=${r.pid}) for actor 0x${actorId.toString(16)}`);
        return r;
      }
    });
    try {
      await voiceHandoff.listen();
    } catch (e: any) {
      console.warn(`[launcher] voice handoff could not listen on ${VOICE_HANDOFF_PORT}: ${e?.message}`);
      voiceHandoff = null;
      return;
    }
  }

  voiceHandoff.arm();

  // No game-exit watcher (the spawn is detached). When the game closes,
  // disarm the handoff and kill the helper — voice makes no sense without the game.
  if (voiceWatchdog) clearInterval(voiceWatchdog);
  let sawGameRunning = false;
  voiceWatchdog = setInterval(async () => {
    const running = await isGameRunning();
    if (running) { sawGameRunning = true; return; }
    if (!sawGameRunning) return; // still starting
    clearInterval(voiceWatchdog!);
    voiceWatchdog = null;
    voiceHandoff?.disarm();
    killVoiceHelper();
    console.info('[launcher] game closed; voice handoff disarmed.');
  }, 4000);
}

type LauncherConfig = {
  gamePath?: string;
  display?: {
    width?: number;
    height?: number;
    mode?: 'borderless' | 'windowed' | 'fullscreen';
  };
};

type PluginHeader = {
  masters: string[];
  isMaster: boolean;
  isLight: boolean;
  error?: string;
};

// [VOIP-NOTHROTTLE] - Prevents game stalls while in the background
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 680,
    minWidth: 1024,
    minHeight: 640,
    title: "OATHBOUND RP Launcher",
    icon: path.join(__dirname, '../public/logo.png'),
    resizable: true,
    frame: false,
    transparent: false,
    backgroundColor: '#0a0a0a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
      backgroundThrottling: false,
      // Electron's default sandbox for the preload script has unresolved rough
      // edges with an ESM preload (`.mjs`): the file loads with no error, but
      // contextBridge.exposeInMainWorld never runs, and the renderer sees
      // `window.electronAPI === undefined`. contextIsolation stays on — that
      // already isolates the preload from the page content; the sandbox is an
      // extra layer specifically over the preload's own system calls, and our
      // preload is our own code, not third-party content.
      //
      // I tried switching the preload to CommonJS to keep the sandbox on
      // (2026-08-22) and reverted: this version of vite-plugin-electron targets
      // Vite 8/Rolldown and silently ignores `format: 'cjs'` passed through
      // `rollupOptions` — the file came out `.cjs` outside, ESM inside, which
      // would break on load. With no confirmed way to configure the preload
      // format in this plugin version, `sandbox: false` remains the fix that
      // actually works. See
      // docs/technical/LAUNCHER_DISTRIBUTION.md §7.
      sandbox: false,
    },
  });

  mainWindow.setMenuBarVisibility(false);

  // ─── Navigation hardening ───
  // The main window carries the full electronAPI preload, so it must never be
  // allowed to navigate to (or open) an arbitrary/attacker-controlled origin.
  const allowedOrigin = process.env.VITE_DEV_SERVER_URL
    ? new URL(process.env.VITE_DEV_SERVER_URL).origin
    : 'file://';

  mainWindow.webContents.on('will-navigate', (event, targetUrl) => {
    try {
      const target = new URL(targetUrl);
      const isAllowed = process.env.VITE_DEV_SERVER_URL
        ? target.origin === allowedOrigin
        : target.protocol === 'file:';
      if (!isAllowed) {
        event.preventDefault();
      }
    } catch {
      event.preventDefault();
    }
  });

  mainWindow.webContents.setWindowOpenHandler(() => {
    // No window.open/target=_blank navigation is allowed from the main window.
    // The Discord OAuth popup is created explicitly by the discord-login
    // handler via its own hardened BrowserWindow, not via window.open.
    return { action: 'deny' };
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// One launcher at a time. Also how nxm:// links reach us: Windows starts a
// second launcher with the link in argv, which hands it to this one and quits.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
    handleNxmArgs(argv);
  });
}

app.whenReady().then(() => {
  if (!gotSingleInstanceLock) return;
  restoreSharedLoadOrderFiles();
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('will-quit', () => {
  if (voiceWatchdog) clearInterval(voiceWatchdog);
  if (loadOrderRestoreWatchdog) clearInterval(loadOrderRestoreWatchdog);
  restoreSharedLoadOrderFiles();
  releaseNxmHandlerSync();
  killVoiceHelper();
  voiceHandoff?.close().catch(() => {});
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// ─── Window Controls ───
ipcMain.on('window-minimize', () => { if (mainWindow) mainWindow.minimize(); });
ipcMain.on('window-close', () => { if (mainWindow) mainWindow.close(); });

// ─── App info (Home) ───
//
// Everything here already existed somewhere in the main process — it had just
// never been exposed to the home screen. `launcherVersion` was already read in
// report-recent-crashes; `clientVersion`/`modsVersion` were already read via
// readStamp() by the update handlers. No network call: the stamps are local
// files written by the last successful install/update.
// Launcher self-update from the OATHBOUND GitHub fork (launcher-update.mjs).
let pendingLauncherUpdate: any = null;
ipcMain.handle('launcher-update-check', async () => {
  try {
    const r = await checkLauncherUpdate({ currentVersion: app.getVersion() });
    pendingLauncherUpdate = r.available ? r.latest : null;
    return { ok: true, ...r };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e), current: app.getVersion() };
  }
});
ipcMain.handle('launcher-update-install', async (event) => {
  if (!pendingLauncherUpdate) return { ok: false, error: 'Check for a launcher update first.' };
  try {
    const dir = path.join(app.getPath('temp'), 'oathbound-launcher-update');
    const file = await downloadInstaller({
      latest: pendingLauncherUpdate,
      dir,
      onProgress: (p: { done: number; total: number }) => {
        try { event.sender.send('launcher-update-progress', p); } catch { /* window closed */ }
      }
    });
    // The installer replaces this launcher, so it must run after we quit.
    spawn(file, [], { detached: true, stdio: 'ignore' }).unref();
    setTimeout(() => app.quit(), 500);
    return { ok: true, version: pendingLauncherUpdate.version };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
});

ipcMain.handle('get-app-info', async () => {
  const config = readLauncherConfig();
  const gamePath = config.gamePath || null;
  return {
    launcherVersion: app.getVersion(),
    clientVersion: gamePath ? readStamp(gamePath, CLIENT_VERSION_FILENAME) : null,
    modsVersion: gamePath ? readStamp(gamePath, MODS_VERSION_FILENAME) : null,
    gamePath,
  };
});

// ─── Local Config ───
function readLauncherConfig(): LauncherConfig {
  try {
    if (fs.existsSync(LAUNCHER_CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(LAUNCHER_CONFIG_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('Error reading launcher config:', e);
  }
  return {};
}

function writeLauncherConfig(config: LauncherConfig) {
  const dir = path.dirname(LAUNCHER_CONFIG_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(LAUNCHER_CONFIG_FILE, JSON.stringify(config, null, 2));
}

ipcMain.handle('get-launcher-config', async () => readLauncherConfig());

ipcMain.handle('save-game-path', async (_event, folderPath) => {
  const check = await validateGamePath(folderPath);
  if (!check.ok) return check;
  const config = readLauncherConfig();
  config.gamePath = folderPath;
  writeLauncherConfig(config);
  return { ok: true, reason: 'ok' };
});

function validateGamePath(folderPath: string) {
  if (!folderPath) return { ok: false, reason: 'empty' };
  const has = (f: string) => {
    try { return fs.existsSync(path.join(folderPath, f)); } catch { return false; }
  };
  if (!has('SkyrimSE.exe')) return { ok: false, reason: 'no-skyrim' };
  let isGog = has('Galaxy64.dll') || has('Galaxy.dll');
  if (!isGog) {
    try { isGog = fs.readdirSync(folderPath).some((n) => /^goggame-.*\.info$/i.test(n)); } catch {}
  }
  if (isGog) return { ok: false, reason: 'gog' };
  return { ok: true, reason: 'ok' };
}

// ─── Game Path & Validation ───
ipcMain.handle('select-game-path', async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Select the Skyrim folder containing SkyrimSE.exe'
  });
  if (result.canceled) return null;
  return result.filePaths[0];
});

// SKSE 2.2.6 from its official site (skse-install.mjs): installed on PLAY when
// missing, after checking the Skyrim build is the one SKSE supports.
ipcMain.handle('ensure-skse', async (event, gamePath) => {
  if (!gamePath) return { ok: false, error: 'Invalid game path.' };
  try {
    const state = await checkSkse(gamePath);
    if (state.skyrimVersionOk === false) {
      return { ok: false, code: 'wrong-skyrim-version', error: 'Your Skyrim is not version 1.6.1170, the version this server uses with SKSE ' + SKSE.version + '. Downgrade Skyrim to 1.6.1170 (Steam depots) and try again.' };
    }
    if (state.installed) return { ok: true, installed: [] };
    const result = await installSkse({
      gamePath,
      sevenZipPath: sevenZipPath(),
      workDir: path.join(app.getPath('temp'), 'oathbound-skse'),
      onProgress: (p: { done: number; total: number }) => {
        try { event.sender.send('skse-progress', p); } catch { /* window closed */ }
      }
    });
    return { ok: true, installed: result.installed };
  } catch (e: any) {
    return { ok: false, error: 'Could not install SKSE: ' + (e?.message || String(e)) };
  }
});

// Downgrade to 1.6.1170 with the player's own Steam account (skyrim-downgrade.mjs).
// DepotDownloader opens its own window; the password and Steam Guard code are
// typed there, never into the launcher.
ipcMain.handle('downgrade-skyrim', async (event, gamePath, username) => {
  if (!gamePath) return { ok: false, error: 'Invalid game path.' };
  if (!isValidSteamUsername(username)) return { ok: false, error: 'Enter your Steam account name (the login name, not your profile name).' };
  if (await isGameRunning()) return { ok: false, error: 'Close Skyrim first.' };
  const send = (phase: string, extra: any = {}) => {
    try { event.sender.send('downgrade-progress', { phase, ...extra }); } catch { /* window closed */ }
  };
  try {
    send('tool');
    const exe = await ensureDepotDownloader({
      toolDir: path.join(app.getPath('userData'), 'depotdownloader'),
      sevenZipPath: sevenZipPath(),
      onProgress: (p: { done: number; total: number }) => send('tool', p)
    });
    const backup = backupGameFiles(gamePath);
    send('steam');
    const code = await runDepotDownloader({ exe, args: downgradeArgs({ gamePath, username }) });
    try { fs.rmSync(path.join(gamePath, '.DepotDownloader'), { recursive: true, force: true }); } catch { /* staging folder */ }
    const state = await checkSkse(gamePath);
    if (state.skyrimVersionOk) return { ok: true, backupDir: backup.dir };
    return { ok: false, error: code === 0
      ? 'The download finished but Skyrim is still not 1.6.1170. Try again, or ask staff for help.'
      : 'The Steam download did not finish (wrong password, cancelled, or Steam refused the old version). Try again.' };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
});

ipcMain.handle('check-game-path', async (_event, folderPath) => {
  return validateGamePath(folderPath);
});

// ─── Skyrim INI Repair ───
function skyrimDocumentsDir() {
  return path.join(app.getPath('documents'), 'My Games', 'Skyrim Special Edition');
}

function readIniSection(iniPath: string, section: string): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const lines = fs.readFileSync(iniPath, 'utf8').split(/\r?\n/);
    let inSec = false;
    const hdr = `[${section}]`.toLowerCase();
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
        inSec = trimmed.toLowerCase() === hdr;
        continue;
      }
      if (!inSec) continue;
      const eq = line.indexOf('=');
      if (eq > 0) out[line.slice(0, eq).trim().toLowerCase()] = line.slice(eq + 1).trim();
    }
  } catch {}
  return out;
}

function updateIniSection(iniPath: string, section: string, values: Record<string, string | number>) {
  let raw = '';
  try { if (fs.existsSync(iniPath)) raw = fs.readFileSync(iniPath, 'utf8'); } catch {}
  const lines = raw.length ? raw.split(/\r?\n/) : [];
  const wanted: Record<string, { key: string; value: string; done: boolean }> = {};
  for (const key of Object.keys(values)) {
    wanted[key.toLowerCase()] = { key, value: String(values[key]), done: false };
  }

  const hdr = `[${section}]`.toLowerCase();
  let inSection = false;
  let sectionEnd = -1;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      if (inSection) {
        sectionEnd = i;
        break;
      }
      inSection = trimmed.toLowerCase() === hdr;
      continue;
    }
    if (!inSection) continue;
    const eq = lines[i].indexOf('=');
    if (eq <= 0) continue;
    const key = lines[i].slice(0, eq).trim().toLowerCase();
    if (wanted[key] && !wanted[key].done) {
      lines[i] = `${wanted[key].key}=${wanted[key].value}`;
      wanted[key].done = true;
    }
  }

  const pending = Object.values(wanted).filter((item) => !item.done).map((item) => `${item.key}=${item.value}`);
  if (inSection) {
    const at = sectionEnd === -1 ? lines.length : sectionEnd;
    if (pending.length) lines.splice(at, 0, ...pending);
  } else {
    if (lines.length && lines[lines.length - 1].trim() !== '') lines.push('');
    lines.push(`[${section}]`, ...Object.values(wanted).map((item) => `${item.key}=${item.value}`));
  }

  const dir = path.dirname(iniPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(iniPath, lines.join('\r\n'));
}

function iniDisplayKeys(width: number, height: number, mode: string) {
  const fullscreen = mode === 'fullscreen' ? 1 : 0;
  const borderless = mode === 'windowed' || mode === 'fullscreen' ? 0 : 1;
  return { 'iSize W': width, 'iSize H': height, 'bFull Screen': fullscreen, 'bBorderless': borderless };
}

ipcMain.handle('ensure-skyrim-ini', async (_event, opts) => {
  try {
    const dir = skyrimDocumentsDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const prefsPath = path.join(dir, 'SkyrimPrefs.ini');
    const iniPath = path.join(dir, 'Skyrim.ini');

    if (opts?.repairOnly && fs.existsSync(prefsPath)) {
      const display = readIniSection(prefsPath, 'Display');
      const hasRes = parseInt(display['isize w'], 10) > 0 && parseInt(display['isize h'], 10) > 0;
      const hasMode = 'bborderless' in display || 'bfull screen' in display;
      if (hasRes && hasMode) {
        if (!fs.existsSync(iniPath)) {
          fs.writeFileSync(iniPath, ['[General]', 'sLanguage=ENGLISH', 'uGridsToLoad=5', 'uExterior Cell Buffer=36', ''].join('\r\n'));
        }
        return { ok: true, skipped: true };
      }
    }

    let width = parseInt(opts?.width, 10);
    let height = parseInt(opts?.height, 10);
    if (!width || !height) {
      try {
        const display = screen.getPrimaryDisplay();
        width = Math.round(display.size.width * display.scaleFactor);
        height = Math.round(display.size.height * display.scaleFactor);
      } catch {}
    }
    if (!width || !height) {
      width = 1920;
      height = 1080;
    }
    const mode = opts?.mode || 'borderless';
    updateIniSection(prefsPath, 'Display', iniDisplayKeys(width, height, mode));
    if (!fs.existsSync(iniPath)) {
      fs.writeFileSync(iniPath, ['[General]', 'sLanguage=ENGLISH', 'uGridsToLoad=5', 'uExterior Cell Buffer=36', ''].join('\r\n'));
    }

    const config = readLauncherConfig();
    config.display = { width, height, mode };
    writeLauncherConfig(config);
    return { ok: true, width, height, mode };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('ensure-skymp-ui', async (_event, gamePath) => ensureSkympUi(gamePath));

ipcMain.handle('ensure-voice-helper', async (_event, gamePath) => ensureVoiceHelper(gamePath));

ipcMain.handle('get-display-settings', async () => {
  const result: { displays: Array<{ width: number; height: number }>; current: any } = { displays: [], current: null };
  try {
    const seen = new Set<string>();
    const push = (width: number, height: number) => {
      const key = `${width}x${height}`;
      if (width && height && !seen.has(key)) {
        seen.add(key);
        result.displays.push({ width, height });
      }
    };
    try {
      for (const display of screen.getAllDisplays()) {
        push(Math.round(display.size.width * display.scaleFactor), Math.round(display.size.height * display.scaleFactor));
      }
    } catch {}
    for (const [width, height] of [[3840, 2160], [2560, 1440], [1920, 1080], [1600, 900], [1366, 768], [1280, 720]]) {
      push(width, height);
    }
    result.displays.sort((a, b) => (b.width * b.height) - (a.width * a.height));

    const prefsPath = path.join(skyrimDocumentsDir(), 'SkyrimPrefs.ini');
    if (fs.existsSync(prefsPath)) {
      const display = readIniSection(prefsPath, 'Display');
      const width = parseInt(display['isize w'], 10);
      const height = parseInt(display['isize h'], 10);
      const fullscreen = display['bfull screen'] === '1';
      const borderless = display['bborderless'] === '1';
      result.current = { width: width || null, height: height || null, mode: fullscreen ? 'fullscreen' : (borderless ? 'borderless' : 'windowed') };
    }
  } catch (e: any) {
    return { ...result, error: e.message };
  }
  return result;
});

// ─── Auth Flow ───
function readAuthFile() {
  try {
    if (fs.existsSync(AUTH_FILE)) {
      return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('Error reading auth file:', e);
  }
  return null;
}

function writeAuthFile(data: any) {
  try {
    fs.writeFileSync(AUTH_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('Error writing auth file:', e);
  }
}

function clearAuthFile() {
  try {
    if (fs.existsSync(AUTH_FILE)) {
      fs.unlinkSync(AUTH_FILE);
    }
  } catch {}
}


function escapeHtml(value: string): string {
  return String(value ?? '').replace(/[&<>"']/g, (char) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] as string
  ));
}

/**
 * POST JSON to an arbitrary URL (http or https). Unlike `postJsonToApi`,
 * which is pinned to the game server's host/port — the web panel usually
 * lives on another host/port (VITE_PANEL_URL).
 */
function postJsonToUrl(url: string, body: any): Promise<{ status: number, data: any }> {
  return new Promise((resolve) => {
    let parsed: URL;
    try { parsed = new URL(url); } catch { resolve({ status: 0, data: null }); return; }

    const transport = parsed.protocol === 'https:' ? https : http;
    const postData = JSON.stringify(body);

    const req = transport.request({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode || 500, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode || 500, data: null }); }
      });
    });

    req.on('error', () => resolve({ status: 0, data: null }));
    req.write(postData);
    req.end();
  });
}

function httpGetJson(url: string): Promise<any> {
  return new Promise((resolve) => {
    const mod = url.startsWith('https:') ? https : http;
    const req = mod.get(url, { headers: { 'User-Agent': 'Skyrim-Heavy-RP-Launcher' } }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        resolve(httpGetJson(new URL(res.headers.location, url).toString()));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        resolve(null);
        return;
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(20000, () => {
      req.destroy();
      resolve(null);
    });
  });
}

// Free space on the volume that holds `targetPath`. Returns null when it can't
// be measured -- `statfs` may be missing, and in that case `checkFreeSpace`
// carries on on purpose (see disk.mjs).
function freeBytesOn(targetPath: string): number | null {
  try {
    const st = (fs as any).statfsSync(targetPath);
    return st.bsize * st.bavail;
  } catch {
    return null;
  }
}

/**
 * The .zip goes to temp and its contents are extracted into the game folder --
 * which may be on different disks. Checking only one lets half of the cases through.
 */
function checkSpaceForDownload(tmpPath: string, gameDirPath: string, sizeBytes: number) {
  return checkFreeSpace([
    { label: `temporary disk (${path.parse(tmpPath).root})`, freeBytes: freeBytesOn(path.dirname(tmpPath)), neededBytes: sizeBytes },
    { label: `game folder (${path.parse(gameDirPath).root})`, freeBytes: freeBytesOn(gameDirPath), neededBytes: sizeBytes }
  ]);
}

function downloadToFile(url: string, destPath: string, onProgress?: (percent: number) => void, redirectsLeft = 5): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!url.startsWith('https:')) {
      reject(new Error(`Download blocked: unsafe URL scheme (${url})`));
      return;
    }
    const req = https.get(url, { headers: { 'User-Agent': 'Skyrim-Heavy-RP-Launcher' } }, (res) => {
      if (res.statusCode && [301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        if (redirectsLeft <= 0) {
          reject(new Error('Too many redirects'));
          return;
        }
        const nextUrl = new URL(res.headers.location, url).toString();
        if (!nextUrl.startsWith('https:')) {
          reject(new Error(`Download blocked: redirect to unsafe URL scheme (${nextUrl})`));
          return;
        }
        downloadToFile(nextUrl, destPath, onProgress, redirectsLeft - 1).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} while downloading file`));
        return;
      }
      const total = parseInt(String(res.headers['content-length'] || '0'), 10);
      let received = 0;
      const out = fs.createWriteStream(destPath);
      res.on('data', (chunk) => {
        received += chunk.length;
        if (onProgress && total) onProgress(Math.floor((received / total) * 100));
      });
      res.pipe(out);
      out.on('finish', () => out.close(() => resolve()));
      out.on('error', reject);
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(60000, () => req.destroy(new Error('Download timed out')));
  });
}

function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', data => hash.update(data));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

// Hash of the mods manifest. It was MD5 until 2026-08-23; MD5 has practical
// collisions, and the threat model here isn't accidental corruption -- it's a
// player altering a mod ON PURPOSE, which is exactly when collisions matter.
//
// Reading is streamed because fs.readFileSync of the whole file, for a
// reference Skyrim.esm (~280 MB), allocated everything on the heap at once per
// mod and blew the launcher's memory before the game opened.
function hashFileForManifest(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

function extractZip(zipPath: string, destDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tar = spawn('tar', ['-xf', zipPath, '-C', destDir], { windowsHide: true });
    let stderr = '';
    tar.stderr.on('data', data => stderr += data.toString());
    tar.on('error', () => {
      const escape = (value: string) => value.replace(/'/g, "''");
      const ps = spawn('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${escape(zipPath)}' -DestinationPath '${escape(destDir)}' -Force`], { windowsHide: true });
      let psErr = '';
      ps.stderr.on('data', data => psErr += data.toString());
      ps.on('error', reject);
      ps.on('close', code => code === 0 ? resolve() : reject(new Error(psErr || `Expand-Archive exited with code ${code}`)));
    });
    tar.on('close', code => code === 0 ? resolve() : reject(new Error(stderr || `tar exited with code ${code}`)));
  });
}

function isGameRunning(): Promise<boolean> {
  return new Promise((resolve) => {
    exec('tasklist /FI "IMAGENAME eq SkyrimSE.exe" /NH', { windowsHide: true }, (_err, stdout) => {
      resolve(/SkyrimSE\.exe/i.test(stdout || ''));
    });
  });
}

function killGameProcesses(): Promise<void> {
  // The voice helper is a child of the launcher — kill it by handle first; the
  // taskkill is a safety net for an orphaned instance from a previous session.
  voiceHandoff?.disarm();
  killVoiceHelper();
  return new Promise((resolve) => {
    exec(
      'taskkill /F /T /IM SkyrimSE.exe & taskkill /F /T /IM skse64_loader.exe & ' +
      'taskkill /F /IM "SkyrimPlatformCEF.exe.hidden" & taskkill /F /IM "SkyrimPlatformCEF.exe" & ' +
      'taskkill /F /IM voice-helper.exe',
      { windowsHide: true },
      () => resolve()
    );
  });
}

function readStamp(gamePath: string, filename: string) {
  try {
    const stampPath = path.join(gamePath, filename);
    if (fs.existsSync(stampPath)) return fs.readFileSync(stampPath, 'utf8').trim();
  } catch {}
  return null;
}

function writeStamp(gamePath: string, filename: string, value: string) {
  fs.writeFileSync(path.join(gamePath, filename), String(value).trim());
}

function readInstalledModsParts(gamePath: string): Record<string, string | null> {
  try {
    const partsPath = path.join(gamePath, MODS_PARTS_FILENAME);
    if (fs.existsSync(partsPath)) return JSON.parse(fs.readFileSync(partsPath, 'utf8')) || {};
  } catch {}
  return {};
}

function writeInstalledModsParts(gamePath: string, value: Record<string, string | null>) {
  fs.writeFileSync(path.join(gamePath, MODS_PARTS_FILENAME), JSON.stringify(value, null, 2));
}

function clientManifestUrl() {
  return DIST_REPO ? `https://github.com/${DIST_REPO}/releases/latest/download/client-update.json` : '';
}

function modsManifestUrl() {
  return DIST_REPO ? `https://github.com/${DIST_REPO}/releases/download/mods/mods-dist.json` : '';
}

function crashlogDirs() {
  const skseDir = path.join(app.getPath('documents'), 'My Games', 'Skyrim Special Edition', 'SKSE');
  return [skseDir, path.join(skseDir, 'Crashlogs')];
}

function collectRecentCrashLogs(limit = 2) {
  const since = Date.now() - 24 * 60 * 60 * 1000;
  const files: Array<{ name: string; fullPath: string; mtime: number }> = [];
  for (const dir of crashlogDirs()) {
    if (!fs.existsSync(dir)) continue;
    let entries: string[] = [];
    try { entries = fs.readdirSync(dir); } catch { continue; }
    for (const entry of entries) {
      if (!/^crash-.*\.(log|txt)$/i.test(entry)) continue;
      const fullPath = path.join(dir, entry);
      let stat: fs.Stats;
      try { stat = fs.statSync(fullPath); } catch { continue; }
      if (!stat.isFile() || stat.mtimeMs < since) continue;
      files.push({ name: entry, fullPath, mtime: stat.mtimeMs });
    }
  }
  return files.sort((a, b) => b.mtime - a.mtime).slice(0, limit);
}

function postJsonToApi(pathname: string, body: any): Promise<any> {
  return new Promise((resolve) => {
    const postData = JSON.stringify(body);
    const req = http.request({
      hostname: SERVER_IP,
      port: API_PORT,
      path: pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve({ ok: res.statusCode && res.statusCode < 300, status: res.statusCode }); }
      });
    });
    req.on('error', (err) => resolve({ ok: false, error: err.message }));
    req.write(postData);
    req.end();
  });
}

ipcMain.handle('discord-login', async () => {
  return new Promise((resolve) => {
    const oauthState = crypto.randomBytes(16).toString('hex');
    let settled = false;
    const finish = (value: any) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const callbackServer = http.createServer(async (req, res) => {
      try {
        const reqUrl = new URL(req.url || '', 'http://localhost:19847');
        const code = reqUrl.searchParams.get('code');
        const state = reqUrl.searchParams.get('state');

        if (!state || state !== oauthState) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<h1>Error: invalid or missing state parameter.</h1>');
          callbackServer.close();
          finish(null);
          return;
        }

        if (!code) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<h1>Error: authorization code not received.</h1>');
          callbackServer.close();
          finish(null);
          return;
        }

        // Exchanging `code` for a token runs in the web panel, not here: the
        // Discord client secret can't travel inside an installer that players
        // download. See POST /api/launcher/oauth/exchange in
        // apps/web/server.js and docs/technical/LAUNCHER_DISTRIBUTION.md.
        const exchange = await postJsonToUrl(`${PANEL_URL}/api/launcher/oauth/exchange`, {
          code,
          redirect_uri: DISCORD_REDIRECT_URI,
        });

        if (exchange.status !== 200 || !exchange.data || !exchange.data.discordId) {
          res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<h1>Error completing the login. Check that the server panel is reachable.</h1>');
          callbackServer.close();
          finish(null);
          return;
        }

        const user = exchange.data;
        const authData = {
          discordId: user.discordId,
          username: user.username,
          globalName: user.globalName || user.username,
          avatar: user.avatar || null,
          // Proof that this Discord account really authenticated, issued by the
          // panel. It is what the queue (apps/game-api) requires — `discordId`
          // alone is public and proves nothing. It is missing if the account
          // doesn't exist in the panel yet (a player who never applied).
          launchTicket: user.launchTicket || null,
          // Multi-use, ~30 days — exchanged for a fresh launchTicket at
          // /api/launcher/session/refresh-ticket without repeating this popup.
          // See migration-v25-launcher-sessions.sql.
          sessionToken: user.sessionToken || null,
          loginDate: new Date().toISOString(),
        };

        writeAuthFile(authData);

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`
          <html>
            <body style="background:#0a0a0a;color:#c9a227;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">
              <div style="text-align:center;">
                <h1>✅ Login successful!</h1>
                <p style="color:#d6d3d1;">Welcome, ${escapeHtml(authData.globalName)}! You can close this window.</p>
              </div>
            </body>
          </html>
        `);

        callbackServer.close();
        if (authWindow && !authWindow.isDestroyed()) {
          authWindow.close();
        }
        finish(authData);
      } catch (err) {
        console.error('OAuth2 callback error:', err);
        res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<h1>Internal error.</h1>');
        callbackServer.close();
        finish(null);
      }
    });

    // Without this, a listen() failure (port 19847 still held by a previous
    // login attempt that didn't close cleanly) became an 'error' event with
    // no listener on the HTTP server -- and Node's default behaviour for an
    // unhandled 'error' is to throw and bring the whole process down,
    // requiring a launcher restart to try again.
    callbackServer.on('error', (err) => {
      console.error('OAuth2 callback server error:', err);
      if (authWindow && !authWindow.isDestroyed()) {
        authWindow.close();
      }
      finish(null);
    });

    callbackServer.listen(19847, '127.0.0.1', () => {
      console.log('OAuth2 callback server listening on 127.0.0.1:19847');
    });

    const authUrl = `https://discord.com/oauth2/authorize?client_id=${DISCORD_CLIENT_ID}&response_type=code&redirect_uri=${encodeURIComponent(DISCORD_REDIRECT_URI)}&scope=identify&state=${oauthState}`;

    let authWindow: BrowserWindow | null = new BrowserWindow({
      width: 500,
      height: 750,
      parent: mainWindow || undefined,
      modal: !!mainWindow,
      title: 'Sign in with Discord',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        webSecurity: true,
        // No preload script: this window only performs the Discord OAuth
        // flow and must never get access to electronAPI.
      }
    });

    authWindow.setMenuBarVisibility(false);
    authWindow.loadURL(authUrl);

    authWindow.on('closed', () => {
      authWindow = null;
      callbackServer.close(() => {});
      // If the window was closed before the OAuth callback fired, don't leave
      // the caller hanging until the 5 minute timeout below.
      finish(null);
    });

    setTimeout(() => {
      callbackServer.close(() => {});
      if (authWindow && !authWindow.isDestroyed()) {
        authWindow.close();
      }
      finish(null);
    }, 5 * 60 * 1000);
  });
});

ipcMain.handle('discord-logout', async () => {
  // Best effort: if the panel is down, the local logout happens anyway.
  // Without this, an auth.json stolen from disk would keep yielding fresh
  // launch tickets even after the owner logged out.
  try {
    const auth = readAuthFile();
    if (auth && auth.sessionToken) {
      await postJsonToUrl(`${PANEL_URL}/api/launcher/session/revoke`, { sessionToken: auth.sessionToken });
    }
  } catch (e) {
    console.error('Error revoking launcher session:', e);
  }
  currentQueueTicket = null;
  clearAuthFile();
  return true;
});

ipcMain.handle('get-auth-status', async () => {
  const auth = readAuthFile();
  if (!auth || !auth.discordId) return null;
  return {
    discordId: auth.discordId,
    username: auth.username,
    globalName: auth.globalName,
    avatar: auth.avatar,
    loginDate: auth.loginDate,
  };
});

// ─── Queue System ───
//
// The queue is authenticated by ticket, not by `discordId`: discordId is
// public, and sending it as proof of identity would let anyone join the queue
// in another player's place. The initial ticket comes from the panel at login;
// each poll consumes the current ticket and receives the next (`pollTicket`),
// so an intercepted ticket is already spent by the time it reaches other hands.

/**
 * Holds the ticket for the next queue poll. Lives only in memory on purpose:
 * it is single-use and short-lived, so persisting it between runs makes no sense.
 */
let currentQueueTicket: string | null = null;

/**
 * Before this function always exchanged for a fresh ticket via `sessionToken`,
 * a second attempt to play in the same launcher session — with no `pollTicket`
 * in memory, e.g. the queue admitted directly the first time, with no wait —
 * resent the login's `launchTicket`, which had already been consumed. The
 * server answered 401 invalid_ticket, and the only way out was redoing the
 * whole Discord OAuth. See migration-v25-launcher-sessions.sql.
 */
async function nextQueueTicket(): Promise<string | null> {
  // A pollTicket in memory (issued by game-api while queued) always wins:
  // it is already fresh and was issued for this specific poll.
  if (currentQueueTicket) return currentQueueTicket;

  const auth = readAuthFile();
  if (!auth) return null;

  if (auth.sessionToken) {
    const refresh = await postJsonToUrl(`${PANEL_URL}/api/launcher/session/refresh-ticket`, {
      sessionToken: auth.sessionToken,
    });
    if (refresh.status === 200 && refresh.data && typeof refresh.data.launchTicket === 'string') {
      return refresh.data.launchTicket;
    }
    // Expired/revoked session (e.g. the user logged out on another machine):
    // falls back to the launchTicket below, which at worst gives the same
    // 401 invalid_ticket that already existed before this change.
  }

  return auth.launchTicket || null;
}

function rememberQueueTicket(response: any) {
  if (response && typeof response.pollTicket === 'string') {
    currentQueueTicket = response.pollTicket;
    delete response.pollTicket; // the renderer neither needs nor should see the ticket
  }
  return response;
}

// ─── Server Status ───
//
// The home screen showed a hard-coded "Online" in the JSX, with no check at
// all behind it — a green dot and a label that never changed, regardless of
// whether apps/game-api was up. `GET /health` already exists in game-api
// (used only by manual operations); this is its first real consumer.
ipcMain.handle('check-server-status', async () => {
  const online = await new Promise<boolean>((resolve) => {
    const req = http.get(
      `http://${SERVER_IP}:${API_PORT}/health`,
      { headers: { 'User-Agent': 'Skyrim-Heavy-RP-Launcher' } },
      (res) => {
        res.resume(); // we don't need the body, only to confirm it answered
        resolve(res.statusCode === 200);
      }
    );
    req.on('error', () => resolve(false));
    // Short on purpose: this runs when the screen boots and on an interval — a
    // 20s timeout (httpGetJson's default) would leave the UI stuck "loading"
    // for a long time whenever the server really is down.
    req.setTimeout(4000, () => {
      req.destroy();
      resolve(false);
    });
  });
  return { online };
});

ipcMain.handle('join-queue', async () => {
  const ticket = await nextQueueTicket();
  if (!ticket) return { status: 'error', message: 'not_authenticated' };

  const response = await postJsonToUrl(
    `http://${SERVER_IP}:${API_PORT}/api/queue/join`,
    { ticket }
  );

  if (response.status === 0) return { status: 'error', message: 'connection_failed' };
  if (!response.data) return { status: 'error', message: 'invalid_response' };
  return rememberQueueTicket(response.data);
});

// The ticket goes in the POST body, like `join-queue` above. It used to be the
// query string of a GET: query strings end up in access and proxy logs, and
// the ticket is a credential — whoever holds it polls the queue as that
// account. See `SEC-QS-01` in docs/roadmap/ECOSYSTEM_ADAPTATION_ROADMAP.md.
ipcMain.handle('poll-queue', async () => {
  const ticket = await nextQueueTicket();
  if (!ticket) return { status: 'error', message: 'not_authenticated' };

  const response = await postJsonToUrl(
    `http://${SERVER_IP}:${API_PORT}/api/queue/status`,
    { ticket }
  );

  if (response.status === 0) return { status: 'error', message: 'connection_failed' };
  if (!response.data) return { status: 'error', message: 'invalid_response' };
  return rememberQueueTicket(response.data);
});

// ─── Mod Manager ───
// ─── OATHBOUND LOAD-ORDER ISOLATION ───

function sharedPluginsTxtPath(): string {
  const localAppData = process.env.LOCALAPPDATA ||
    path.join(process.env.USERPROFILE || '', 'AppData', 'Local');

  return path.join(localAppData, 'Skyrim Special Edition', 'plugins.txt');
}

function sharedLoadOrderTxtPath(): string {
  const localAppData = process.env.LOCALAPPDATA ||
    path.join(process.env.USERPROFILE || '', 'AppData', 'Local');

  return path.join(localAppData, 'Skyrim Special Edition', 'loadorder.txt');
}

function oathboundPluginsTxtPath(gamePath: string): string {
  return path.join(gamePath, 'OATHBOUND_plugins.txt');
}

function oathboundLoadOrderTxtPath(gamePath: string): string {
  return path.join(gamePath, 'OATHBOUND_loadorder.txt');
}

function oathboundPluginsBackupPath(): string {
  return path.join(app.getPath('userData'), 'plugins.txt.before-oathbound');
}

function oathboundPluginsMissingMarkerPath(): string {
  return path.join(app.getPath('userData'), 'plugins.txt.before-oathbound.missing');
}

function oathboundLoadOrderBackupPath(): string {
  return path.join(app.getPath('userData'), 'loadorder.txt.before-oathbound');
}

function oathboundLoadOrderMissingMarkerPath(): string {
  return path.join(app.getPath('userData'), 'loadorder.txt.before-oathbound.missing');
}

function restoreSharedLoadOrderFiles(): void {
  const restoreOne = (
    shared: string,
    backup: string,
    missingMarker: string,
    label: string
  ): void => {
    try {
      if (fs.existsSync(backup)) {
        const dir = path.dirname(shared);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        fs.copyFileSync(backup, shared);
        fs.unlinkSync(backup);

        if (fs.existsSync(missingMarker)) {
          fs.unlinkSync(missingMarker);
        }

        console.info(`[OATHBOUND] Restored original Skyrim ${label}.`);
        return;
      }

      if (fs.existsSync(missingMarker)) {
        if (fs.existsSync(shared)) fs.unlinkSync(shared);
        fs.unlinkSync(missingMarker);

        console.info(`[OATHBOUND] Restored original missing ${label} state.`);
      }
    } catch (e) {
      console.error(`[OATHBOUND] Failed to restore shared Skyrim ${label}:`, e);
    }
  };

  restoreOne(
    sharedPluginsTxtPath(),
    oathboundPluginsBackupPath(),
    oathboundPluginsMissingMarkerPath(),
    'plugins.txt'
  );

  restoreOne(
    sharedLoadOrderTxtPath(),
    oathboundLoadOrderBackupPath(),
    oathboundLoadOrderMissingMarkerPath(),
    'loadorder.txt'
  );
}

function activateOathboundLoadOrder(gamePath: string): void {
  restoreSharedLoadOrderFiles();

  const sourcePlugins = oathboundPluginsTxtPath(gamePath);
  const sourceLoadOrder = oathboundLoadOrderTxtPath(gamePath);

  if (!fs.existsSync(sourcePlugins)) {
    throw new Error(`OATHBOUND plugin list not found: ${sourcePlugins}`);
  }

  if (!fs.existsSync(sourceLoadOrder)) {
    throw new Error(`OATHBOUND load order file not found: ${sourceLoadOrder}`);
  }

  const sharedPlugins = sharedPluginsTxtPath();
  const sharedLoadOrder = sharedLoadOrderTxtPath();

  const pluginsBackup = oathboundPluginsBackupPath();
  const pluginsMissingMarker = oathboundPluginsMissingMarkerPath();
  const loadOrderBackup = oathboundLoadOrderBackupPath();
  const loadOrderMissingMarker = oathboundLoadOrderMissingMarkerPath();

  const dir = path.dirname(sharedPlugins);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  // Preserve the original shared state of BOTH files.
  if (fs.existsSync(sharedPlugins)) {
    fs.copyFileSync(sharedPlugins, pluginsBackup);
  } else {
    fs.writeFileSync(pluginsMissingMarker, '');
  }

  if (fs.existsSync(sharedLoadOrder)) {
    fs.copyFileSync(sharedLoadOrder, loadOrderBackup);
  } else {
    fs.writeFileSync(loadOrderMissingMarker, '');
  }

  // Activate OATHBOUND's isolated configuration.
  fs.copyFileSync(sourcePlugins, sharedPlugins);
  fs.copyFileSync(sourceLoadOrder, sharedLoadOrder);

  console.info(
    `[OATHBOUND] Activated isolated plugin list from ${sourcePlugins}`
  );
  console.info(
    `[OATHBOUND] Activated isolated load order from ${sourceLoadOrder}`
  );
}
let loadOrderRestoreWatchdog: NodeJS.Timeout | null = null;

function armOathboundLoadOrderRestore(): void {
  if (loadOrderRestoreWatchdog) {
    clearInterval(loadOrderRestoreWatchdog);
  }

  let sawGameRunning = false;
  let checks = 0;

  loadOrderRestoreWatchdog = setInterval(async () => {
    checks++;

    const running = await isGameRunning();

    if (running) {
      sawGameRunning = true;
      return;
    }

    if (!sawGameRunning && checks < 30) {
      return;
    }

    clearInterval(loadOrderRestoreWatchdog!);
    loadOrderRestoreWatchdog = null;

    restoreSharedLoadOrderFiles();

    console.info('[OATHBOUND] Skyrim closed; original load order restored.');
  }, 2000);
}

function listDataPlugins(folderPath: string) {
  const dataPath = path.join(folderPath, 'Data');
  if (!fs.existsSync(dataPath)) return [];
  return fs.readdirSync(dataPath).filter(file =>
    file.toLowerCase().endsWith('.esp') ||
    file.toLowerCase().endsWith('.esl') ||
    file.toLowerCase().endsWith('.esm')
  );
}

function readPluginHeader(filePath: string): PluginHeader {
  // The I/O lives here; the parsing lives in parity.mjs, tested with a
  // synthetic plugin. We read only the start of the file: the masters block is
  // in the header, and a Skyrim .esm is hundreds of MB.
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const head = Buffer.alloc(24);
    fs.readSync(fd, head, 0, 24, 0);
    if (head.length >= 8) {
      const dataSize = head.readUInt32LE(4);
      const cap = Math.min(dataSize, 1024 * 1024);
      const corpo = Buffer.alloc(cap);
      fs.readSync(fd, corpo, 0, cap, 24);
      return parsePluginHeader(Buffer.concat([head, corpo]));
    }
    return parsePluginHeader(head);
  } catch (e: any) {
    return { masters: [], isMaster: false, isLight: false, error: e.message };
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

ipcMain.handle('get-local-plugins', async (_event, folderPath) => {
  if (!folderPath) return { plugins: [], pluginsTxt: [] };
  try {
    const plugins = listDataPlugins(folderPath);
    const pluginsTxtPath = oathboundPluginsTxtPath(folderPath);
    const pluginsTxt = fs.existsSync(pluginsTxtPath)
      ? parsePluginsTxt(fs.readFileSync(pluginsTxtPath, 'utf8'))
      : [];
    return { plugins, pluginsTxt };
  } catch {
    return { plugins: [], pluginsTxt: [] };
  }
});

// ─── Server-hosted mods (SkyUI, RaceMenu...) ───
// game-api publishes /client-mods/manifest.json (skymp/client-mods). Before
// PLAY the renderer asks what's missing, shows it to the player and, with
// their OK, downloads/verifies/installs. See electron/server-mods.mjs.

function gameApiBaseUrl() {
  const host = SERVER_IP.includes(':') ? `[${SERVER_IP}]` : SERVER_IP;
  return `http://${host}:${API_PORT}`;
}

function serverModsHashCache() {
  return createHashCache(path.join(app.getPath('userData'), 'server-mods-hash-cache.json'));
}

async function fetchServerModsManifest() {
  const res = await fetch(`${gameApiBaseUrl()}/client-mods/manifest.json`, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching the server mods list`);
  return validateManifest(await res.json());
}

// ─── Nexus Mods ───
// Hosted mods that are on Nexus come from Nexus (electron/nexus-mods.mjs);
// the game server only sends what Nexus cannot (OATHBOUND's own files,
// patched files, anything a player skips).

const NEXUS_ACCOUNT_FILE = path.join(app.getPath('userData'), 'nexus-account.json');
const NEXUS_APP_NAME = 'OATHBOUND RP Launcher';
const NXM_COMMAND_KEY = 'HKCU\\Software\\Classes\\nxm\\shell\\open\\command';
let nexusSessionKey: string | null = null;

function sevenZipPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'vendor', '7za.exe')
    : path.resolve(__dirname, '../node_modules/7zip-bin/win/x64/7za.exe');
}

function readNexusApiKey(): string | null {
  if (nexusSessionKey) return nexusSessionKey;
  try {
    const saved = JSON.parse(fs.readFileSync(NEXUS_ACCOUNT_FILE, 'utf8'));
    if (saved?.encryptedKey && safeStorage.isEncryptionAvailable()) {
      return safeStorage.decryptString(Buffer.from(saved.encryptedKey, 'base64'));
    }
  } catch { /* no saved key */ }
  return null;
}

function saveNexusApiKey(key: string) {
  nexusSessionKey = key;
  // Never written in plain text: without OS encryption the key lives only
  // for this session.
  if (!safeStorage.isEncryptionAvailable()) return;
  fs.writeFileSync(NEXUS_ACCOUNT_FILE, JSON.stringify({
    encryptedKey: safeStorage.encryptString(key).toString('base64')
  }));
}

function nexusApi(key: string) {
  return createNexusApi({ apiKey: key, appName: NEXUS_APP_NAME, appVersion: app.getVersion() });
}

async function nexusAccount() {
  const key = readNexusApiKey();
  if (!key) return { connected: false, apiKeyPage: NEXUS_API_KEY_PAGE };
  try {
    const user = await nexusApi(key).validate();
    return { connected: true, name: user.name, isPremium: user.isPremium, apiKeyPage: NEXUS_API_KEY_PAGE };
  } catch (e: any) {
    return { connected: false, error: e?.message || String(e), apiKeyPage: NEXUS_API_KEY_PAGE };
  }
}

ipcMain.handle('nexus-get-account', () => nexusAccount());

ipcMain.handle('nexus-set-api-key', async (_event, rawKey) => {
  const key = typeof rawKey === 'string' ? rawKey.trim() : '';
  if (!/^[A-Za-z0-9+/=_\-.]{20,400}$/.test(key)) return { connected: false, error: 'That does not look like a Nexus Mods API key.', apiKeyPage: NEXUS_API_KEY_PAGE };
  try {
    const user = await nexusApi(key).validate();
    saveNexusApiKey(key);
    return { connected: true, name: user.name, isPremium: user.isPremium, apiKeyPage: NEXUS_API_KEY_PAGE };
  } catch (e: any) {
    return { connected: false, error: e?.message || String(e), apiKeyPage: NEXUS_API_KEY_PAGE };
  }
});

ipcMain.handle('nexus-forget', () => {
  nexusSessionKey = null;
  try { fs.rmSync(NEXUS_ACCOUNT_FILE, { force: true }); } catch { /* already gone */ }
  return { connected: false, apiKeyPage: NEXUS_API_KEY_PAGE };
});

ipcMain.handle('nexus-open-key-page', () => shell.openExternal(NEXUS_API_KEY_PAGE));

// nxm:// handling. Free Nexus accounts only get a download link through the
// "Mod Manager Download" button, which opens an nxm:// link. The launcher
// takes over the nxm handler while it waits and gives it back afterwards
// (Vortex / Mod Organizer keep working).
type NxmWaiter = { modId: number; fileId: number; page: string; resolve: (n: any) => void; reject: (e: any) => void };
let nxmWaiter: NxmWaiter | null = null;
let previousNxmCommand: string | null | undefined;

function handleNxmArgs(argv: string[]) {
  const raw = argv.find(a => typeof a === 'string' && a.toLowerCase().startsWith('nxm://'));
  if (!raw) return;
  const link = parseNxmUrl(raw);
  if (!link || !nxmWaiter) return;
  if (link.modId === nxmWaiter.modId && link.fileId === nxmWaiter.fileId) {
    const w = nxmWaiter;
    nxmWaiter = null;
    w.resolve(link);
  } else if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('server-mods-progress', { phase: 'nexus-wrong-file' });
  }
}

function regQueryDefault(key: string): Promise<string | null> {
  return new Promise((resolve) => {
    exec(`reg query "${key}" /ve`, { windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null);
      const m = /REG_(?:EXPAND_)?SZ\s+(.*)$/m.exec(stdout);
      resolve(m ? m[1].trim() : null);
    });
  });
}

async function claimNxmHandler() {
  if (previousNxmCommand !== undefined) return;
  const prev = await regQueryDefault(NXM_COMMAND_KEY);
  previousNxmCommand = prev && !prev.toLowerCase().includes(process.execPath.toLowerCase()) ? prev : null;
  if (app.isPackaged) app.setAsDefaultProtocolClient('nxm');
  else app.setAsDefaultProtocolClient('nxm', process.execPath, [path.resolve(process.argv[1] || '.')]);
}

function releaseNxmHandlerSync() {
  if (previousNxmCommand === undefined) return;
  const prev = previousNxmCommand;
  previousNxmCommand = undefined;
  try {
    if (prev) {
      spawn('reg', ['add', NXM_COMMAND_KEY, '/ve', '/d', prev, '/f'], { windowsHide: true, stdio: 'ignore' });
    } else if (app.isPackaged) {
      app.removeAsDefaultProtocolClient('nxm');
    } else {
      app.removeAsDefaultProtocolClient('nxm', process.execPath, [path.resolve(process.argv[1] || '.')]);
    }
  } catch { /* best effort */ }
}

function waitForNxm(source: any, timeoutMs = 20 * 60 * 1000) {
  return new Promise<any>((resolve, reject) => {
    const page = nexusFilePageUrl(source);
    const timer = setTimeout(() => {
      if (nxmWaiter?.page === page) nxmWaiter = null;
      reject(Object.assign(new Error('Timed out waiting for the Nexus download button.'), { code: 'SKIPPED' }));
    }, timeoutMs);
    nxmWaiter = {
      modId: source.modId,
      fileId: source.fileId,
      page,
      resolve: (n) => { clearTimeout(timer); resolve(n); },
      reject: (e) => { clearTimeout(timer); reject(e); }
    };
    shell.openExternal(page).catch(() => {});
  });
}

ipcMain.handle('nexus-reopen-page', () => {
  if (nxmWaiter) shell.openExternal(nxmWaiter.page).catch(() => {});
});

ipcMain.handle('nexus-skip-current', () => {
  const w = nxmWaiter;
  nxmWaiter = null;
  w?.reject(Object.assign(new Error('Skipped'), { code: 'SKIPPED' }));
});

ipcMain.handle('check-server-mods', async (_event, gamePath) => {
  if (!gamePath) return { ok: false, error: 'Invalid game path.' };
  try {
    const manifest = await fetchServerModsManifest();
    const cache = serverModsHashCache();
    const plan = await planServerModSync({ manifest, gamePath, hashCache: cache });
    cache.save();
    const nexusPlan = planNexusDownloads({ sources: nexusSourcesOf(manifest), toDownload: plan.toDownload });
    return {
      ok: true,
      version: manifest.version,
      plugins: manifest.plugins,
      totalFiles: manifest.files.length,
      missing: plan.toDownload.map(f => ({ path: f.path, size: f.size })),
      missingBase: plan.missingBase,
      bytesNeeded: plan.totalBytes,
      nexus: {
        archives: nexusPlan.archives.map(a => ({
          name: a.source.name, version: a.source.version, size: a.source.size, files: a.provides.length
        })),
        nexusBytes: nexusPlan.nexusBytes,
        serverBytes: nexusPlan.serverBytes,
        serverFiles: nexusPlan.remaining.length
      },
      nexusAccount: nexusPlan.archives.length > 0 ? await nexusAccount() : null
    };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
});

ipcMain.handle('install-server-mods', async (_event, gamePath, opts) => {
  if (!gamePath) return { ok: false, error: 'Invalid game path.' };
  if (await isGameRunning()) return { ok: false, error: 'Close Skyrim before installing server mods.' };
  const useNexus = opts?.useNexus !== false;
  const send = (value: any) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('server-mods-progress', value);
  };
  const warnings: string[] = [];
  try {
    const manifest = await fetchServerModsManifest();
    const cache = serverModsHashCache();
    let plan = await planServerModSync({ manifest, gamePath, hashCache: cache });
    const nexusPlan = planNexusDownloads({ sources: nexusSourcesOf(manifest), toDownload: plan.toDownload });
    const nexusKey = useNexus && nexusPlan.archives.length > 0 ? readNexusApiKey() : null;

    // Room for the biggest archive plus everything it unpacks into Data/.
    const biggestArchive = nexusKey ? Math.max(0, ...nexusPlan.archives.map(a => a.source.size || a.bytes)) : 0;
    const space = checkSpaceForDownload(path.join(gamePath, 'Data', '.space-check'), gamePath, plan.totalBytes + biggestArchive);
    if (!space.ok) return { ok: false, error: space.error };

    let nexusInstalled = 0;
    if (nexusKey) {
      const api = nexusApi(nexusKey);
      const downloadsDir = path.join(gamePath, 'OATHBOUND_Downloads');
      try {
        const user = await api.validate();
        const count = nexusPlan.archives.length;
        for (let index = 0; index < count; index++) {
          const { source, provides } = nexusPlan.archives[index];
          const base = { name: source.name, index, count };
          try {
            const archivePath = path.join(downloadsDir, source.fileName);
            const haveArchive = source.size > 0 && fs.existsSync(archivePath) && fs.statSync(archivePath).size === source.size;
            if (!haveArchive) {
              let link = null;
              if (!user.isPremium) {
                await claimNxmHandler();
                send({ phase: 'nexus-wait', ...base, page: nexusFilePageUrl(source) });
                link = await waitForNxm(source);
              }
              send({ phase: 'nexus-download', ...base, bytesDone: 0, bytesTotal: source.size });
              const url = await api.downloadLink(source, link);
              await downloadArchive({
                url, dest: archivePath, expectedSize: source.size,
                onProgress: (bytesDone: number, bytesTotal: number) => send({ phase: 'nexus-download', ...base, bytesDone, bytesTotal })
              });
            }
            send({ phase: 'nexus-extract', ...base });
            const result = await extractProvided({
              sevenZipPath: sevenZipPath(), archivePath, provides, gamePath,
              workDir: path.join(downloadsDir, `extract-${source.fileId}`)
            });
            nexusInstalled += result.installed.length;
            if (result.mismatched.length > 0) {
              warnings.push(`${source.name}: ${result.mismatched.length} file(s) differ from the server's copy and come from the server.`);
            }
            try { fs.rmSync(archivePath, { force: true }); } catch { /* disk space only */ }
          } catch (e: any) {
            if (e?.code === 'SKIPPED') warnings.push(`${source.name}: skipped on Nexus, downloaded from the server.`);
            else if (e?.code === 'BAD_KEY' || e?.code === 'RATE_LIMITED') throw e;
            else warnings.push(`${source.name}: ${e?.message || e} Downloaded from the server instead.`);
          }
        }
      } catch (e: any) {
        warnings.push(`Nexus Mods: ${e?.message || e} The rest comes from the server.`);
      } finally {
        nxmWaiter = null;
        releaseNxmHandlerSync();
      }
      plan = await planServerModSync({ manifest, gamePath, hashCache: cache });
    }

    const result = await installServerMods({
      gamePath,
      baseUrl: gameApiBaseUrl(),
      toDownload: plan.toDownload,
      onProgress: (p: any) => send({ phase: 'server', ...p })
    });
    // Rehash what was just written so the next check is instant.
    await planServerModSync({ manifest, gamePath, hashCache: cache });
    cache.save();
    const plugins = enableServerPlugins({ gamePath, plugins: manifest.plugins });
    console.info(`[launcher] server mods: ${nexusInstalled} file(s) from Nexus, ${result.installed.length} from the server; plugin lists ${plugins.changed ? 'updated' : 'unchanged'}.`);
    if (plugins.removed.length > 0) console.info(`[launcher] removed plugins the server no longer sends: ${plugins.removed.join(', ')}`);
    for (const w of warnings) console.warn(`[launcher] ${w}`);
    return { ok: true, installed: result.installed, nexusInstalled, warnings, pluginsChanged: plugins.changed };
  } catch (e: any) {
    console.error('[launcher] server mods install failed:', e);
    return { ok: false, code: e?.code, error: e?.message || String(e), warnings };
  }
});

ipcMain.handle('enable-server-plugins', async (_event, gamePath) => {
  if (!gamePath) return { ok: false, error: 'Invalid game path.' };
  try {
    const manifest = await fetchServerModsManifest();
    return { ok: true, ...enableServerPlugins({ gamePath, plugins: manifest.plugins }) };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
});

ipcMain.handle('verify-mods', async (_event, folderPath) => {
  if (!folderPath) return { success: false, error: "Invalid game path." };
  try {
    const dataPath = path.join(folderPath, 'Data');
    if (!fs.existsSync(dataPath)) return { success: false, error: "Data folder not found." };

    const modsJson: any = await new Promise((resolve) => {
      http.get(`http://${SERVER_IP}:${API_PORT}/mods.json`, (res) => {
        if (res.statusCode !== 200) { resolve(null); return; }
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
      }).on('error', () => resolve(null));
    });

    if (!modsJson || !modsJson.mods) {
      return { success: false, error: "Failed to download mods.json from the server. The server may be offline." };
    }

    const allFiles = fs.readdirSync(dataPath);
    const hashOf = (filename: string) => hashFileForManifest(path.join(dataPath, filename));

    const analysis = await compareMods({
      serverMods: modsJson.mods,
      localFiles: allFiles,
      hashOf,
      hashAlgorithm: modsJson.hashAlgorithm
    });
    if (!analysis.success) return analysis;

    return { success: true, loadOrder: modsJson.loadOrder };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('analyze-plugins', async (_event, folderPath, serverLoadOrder) => {
  if (!folderPath) return { ok: false, problems: ['Invalid game path.'], plugins: [] };
  try {
    const dataPath = path.join(folderPath, 'Data');
    if (!fs.existsSync(dataPath)) return { ok: false, problems: ['Data folder not found.'], plugins: [] };

    // The real load order comes from plugins.txt, not from the files present
    // in Data/: a plugin that is on disk but disabled takes no index and
    // shifts no FormID. Without the file, parity.mjs falls back to the files
    // present, which is the safe direction.
    const pluginsTxtPath = oathboundPluginsTxtPath(folderPath);
    const enabledPlugins = fs.existsSync(pluginsTxtPath)
      ? parsePluginsTxt(fs.readFileSync(pluginsTxtPath, 'utf8')).filter(p => p.enabled).map(p => p.name)
      : undefined;

    const localPlugins = listDataPlugins(folderPath);

    const analysis = analyzePlugins({
      localPlugins,
      serverLoadOrder,
      enabledPlugins,
      readHeader: (name: string) => readPluginHeader(path.join(dataPath, name))
    });

    // Creation Club doesn't go through plugins.txt: Skyrim AE reads
    // Skyrim.ccc and loads by itself whatever is listed there and present in
    // Data/. Those are plugins that take a load order index and that the check
    // above doesn't see.
    //
    // The file is in the game root, next to the executable — not in Data/.
    // And its contents vary with what the Steam account owns, so two testers
    // can load different lists without having chosen anything.
    const cccPath = path.join(folderPath, 'Skyrim.ccc');
    const cccEntries = fs.existsSync(cccPath)
      ? parseCccTxt(fs.readFileSync(cccPath, 'utf8'))
      : [];

    const cc = analyzeCreationClub({ cccEntries, localPlugins, serverLoadOrder, enabledPlugins });

    return {
      ...analysis,
      ok: analysis.ok && cc.ok,
      problems: [...analysis.problems, ...cc.problems],
      creationClub: cc.effective
    };
  } catch (e: any) {
    return { ok: false, problems: [e.message], plugins: [] };
  }
});

ipcMain.handle('sync-loadorder', async () => {
  // Preserve the full local OATHBOUND plugin list.
  // The server manifest may contain only a subset of the installed plugins.
  return true;
});

ipcMain.handle('is-game-running', async () => isGameRunning());

ipcMain.handle('kill-game', async () => {
  await killGameProcesses();
  return true;
});

ipcMain.handle('check-client-update', async (_event, gamePath) => {
  // Without DIST_REPO, the operator chose not to distribute via GitHub
  // Releases (local dev, fork under test) — that isn't the same case as "I set
  // up distribution and it is down". Blocking PLAY here would punish someone
  // who never asked for this gate, so this case passes with no error. A missing
  // or invalid manifest WITH DIST_REPO configured still fails closed below:
  // there, someone did decide to depend on the gate and it is broken.
  if (!DIST_REPO) return { updateAvailable: false };
  const manifest = await httpGetJson(clientManifestUrl());
  if (!manifest || !manifest.clientVersion) return { updateAvailable: false, error: 'Client manifest unavailable.' };
  const installedVersion = gamePath ? readStamp(gamePath, CLIENT_VERSION_FILENAME) : null;
  return {
    updateAvailable: installedVersion !== manifest.clientVersion,
    installedVersion,
    version: manifest.clientVersion,
    notes: manifest.notes || '',
    sizeBytes: manifest.sizeBytes || 0
  };
});

ipcMain.handle('install-client-update', async (_event, gamePath) => {
  if (!gamePath) return { success: false, error: 'Invalid game path.' };
  if (await isGameRunning()) return { success: false, gameRunning: true, error: 'The game is open. Close it before updating.' };
  if (!DIST_REPO) return { success: false, error: 'VITE_GITHUB_DIST_REPO is not configured.' };

  const send = (phase: string, percent: number) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update-progress', { phase, percent });
  };
  const tmpZip = path.join(app.getPath('temp'), 'skymp_client_update.zip');
  try {
    const manifest = await httpGetJson(clientManifestUrl());
    if (!manifest || !manifest.downloadUrl) return { success: false, error: 'Invalid client manifest.' };

    const downloadSpace = checkSpaceForDownload(tmpZip, gamePath, manifest.sizeBytes);
    if (!downloadSpace.ok) return { success: false, error: downloadSpace.error };

    send('download', 0);
    await downloadToFile(manifest.downloadUrl, tmpZip, percent => send('download', percent));
    if (!manifest.sha256) {
      try { fs.unlinkSync(tmpZip); } catch {}
      return { success: false, error: 'Client manifest has no SHA256: the mandatory integrity check is missing.' };
    }
    send('verify', 0);
    const actual = await sha256File(tmpZip);
    if (actual.toLowerCase() !== String(manifest.sha256).toLowerCase()) {
      try { fs.unlinkSync(tmpZip); } catch {}
      return { success: false, error: 'Client SHA256 does not match.' };
    }
    send('verify', 100);
    await killGameProcesses();
    await new Promise(resolve => setTimeout(resolve, 900));
    send('extract', 0);
    await extractZip(tmpZip, gamePath);
    send('extract', 100);
    writeStamp(gamePath, CLIENT_VERSION_FILENAME, manifest.clientVersion);
    try { fs.unlinkSync(tmpZip); } catch {}
    return { success: true, version: manifest.clientVersion };
  } catch (e: any) {
    try { fs.unlinkSync(tmpZip); } catch {}
    // A raw ENOSPC ("no space left on device, write") in the middle of a
    // progress bar doesn't tell the player whether the problem is theirs, the
    // server's or the internet's. The upfront check doesn't catch everything:
    // the disk can fill up DURING the download, or extraction may need more
    // than the .zip.
    if (isDiskFull(e)) {
      return { success: false, error: 'The disk filled up during the operation. Free up space and try again.' };
    }
    return { success: false, error: e.message };
  }
});

ipcMain.handle('check-mods-update', async (_event, gamePath) => {
  if (!DIST_REPO) return { updateAvailable: false, error: 'VITE_GITHUB_DIST_REPO is not configured.' };
  const manifest = await httpGetJson(modsManifestUrl());
  if (!manifest || !manifest.modsVersion) return { updateAvailable: false, error: 'Manifesto de mods indisponivel.' };
  const installedVersion = gamePath ? readStamp(gamePath, MODS_VERSION_FILENAME) : null;
  return {
    updateAvailable: installedVersion !== manifest.modsVersion,
    installedVersion,
    version: manifest.modsVersion,
    notes: manifest.notes || '',
    mandatory: !!manifest.mandatory,
    sizeBytes: manifest.sizeBytes || 0
  };
});

ipcMain.handle('install-mods-update', async (_event, gamePath, force) => {
  if (!gamePath) return { success: false, error: 'Invalid game path.' };
  if (await isGameRunning()) return { success: false, gameRunning: true, error: 'The game is open. Close it before updating mods.' };
  if (!DIST_REPO) return { success: false, error: 'VITE_GITHUB_DIST_REPO is not configured.' };

  const send = (phase: string, percent: number) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('mods-update-progress', { phase, percent });
  };
  const tmpZip = path.join(app.getPath('temp'), 'skymp_mods_update.zip');
  try {
    const manifest = await httpGetJson(modsManifestUrl());
    if (!manifest || (!manifest.downloadUrl && !Array.isArray(manifest.parts))) return { success: false, error: 'Invalid mods manifest.' };
    const installedVersion = readStamp(gamePath, MODS_VERSION_FILENAME);
    if (!force && installedVersion === manifest.modsVersion) {
      return { success: true, version: manifest.modsVersion, alreadyCurrent: true };
    }

    const parts = Array.isArray(manifest.parts) && manifest.parts.length > 0
      ? manifest.parts
      : [{ url: manifest.downloadUrl, sha256: manifest.sha256, sizeBytes: manifest.sizeBytes, contentSig: manifest.contentSig, name: 'single' }];
    const installedParts = force ? {} : readInstalledModsParts(gamePath);
    const finalParts: Record<string, string | null> = {};

    await killGameProcesses();
    await new Promise(resolve => setTimeout(resolve, 900));

    // Add up what is still left to download: parts already installed don't take disk space again.
    const pendingBytes = parts.reduce((total: number, p: any) => {
      const alreadyHave = !force && installedParts[p.name || p.url] && installedParts[p.name || p.url] === (p.contentSig || null);
      return alreadyHave ? total : total + (Number(p.sizeBytes) || 0);
    }, 0);
    const modsSpace = checkSpaceForDownload(tmpZip, gamePath, pendingBytes);
    if (!modsSpace.ok) return { success: false, error: modsSpace.error };

    let downloaded = 0;
    let skipped = 0;
    for (let index = 0; index < parts.length; index++) {
      const part = parts[index];
      const partKey = part.name || part.url;
      finalParts[partKey] = part.contentSig || null;
      const base = Math.round((index / parts.length) * 100);
      const span = Math.max(1, Math.round(100 / parts.length));
      if (!force && part.contentSig && installedParts[partKey] === part.contentSig) {
        skipped += 1;
        send('extract', Math.min(100, base + span));
        continue;
      }
      downloaded += 1;
      send('download', base);
      await downloadToFile(part.url, tmpZip, percent => send('download', Math.min(100, base + Math.round(percent * span / 100))));
      if (!part.sha256) {
        try { fs.unlinkSync(tmpZip); } catch {}
        return { success: false, error: `Part ${index + 1} has no SHA256: the mandatory integrity check is missing.` };
      }
      send('verify', base);
      const actual = await sha256File(tmpZip);
      if (actual.toLowerCase() !== String(part.sha256).toLowerCase()) {
        try { fs.unlinkSync(tmpZip); } catch {}
        return { success: false, error: `Mods SHA256 does not match for part ${index + 1}.` };
      }
      send('extract', base);
      await extractZip(tmpZip, gamePath);
      try { fs.unlinkSync(tmpZip); } catch {}
    }

    send('extract', 100);
    writeInstalledModsParts(gamePath, finalParts);
    writeStamp(gamePath, MODS_VERSION_FILENAME, manifest.modsVersion);
    return { success: true, version: manifest.modsVersion, downloaded, skipped };
  } catch (e: any) {
    try { fs.unlinkSync(tmpZip); } catch {}
    // A raw ENOSPC ("no space left on device, write") in the middle of a
    // progress bar doesn't tell the player whether the problem is theirs, the
    // server's or the internet's. The upfront check doesn't catch everything:
    // the disk can fill up DURING the download, or extraction may need more
    // than the .zip.
    if (isDiskFull(e)) {
      return { success: false, error: 'The disk filled up during the operation. Free up space and try again.' };
    }
    return { success: false, error: e.message };
  }
});

// ─── Game Launch ───
ipcMain.handle('get-recent-crashes', async () => {
  return collectRecentCrashLogs(5).map(file => ({
    name: file.name,
    mtime: file.mtime
  }));
});

ipcMain.handle('report-recent-crashes', async () => {
  const auth = readAuthFile();
  const config = readLauncherConfig();
  const crashes = collectRecentCrashLogs(2);
  if (crashes.length === 0) return { ok: true, sent: 0 };

  const payload = {
    discordId: auth?.discordId || null,
    username: auth?.globalName || auth?.username || null,
    clientVersion: config.gamePath ? readStamp(config.gamePath, CLIENT_VERSION_FILENAME) : null,
    launcherVersion: app.getVersion(),
    crashes: crashes.map(file => {
      const raw = fs.readFileSync(file.fullPath);
      const maxBytes = 60 * 1024;
      const content = raw.length > maxBytes
        ? Buffer.concat([raw.subarray(0, maxBytes), Buffer.from('\n...[truncated by the launcher]')]).toString('utf8')
        : raw.toString('utf8');
      return { filename: file.name, mtime: file.mtime, content };
    })
  };

  const result = await postJsonToApi('/api/crashes/client', payload);
  return { ok: !!result?.ok || result?.status === 'ok', sent: crashes.length, response: result };
});

ipcMain.handle('launch-game', async (_event, folderPath, ticket) => {
  if (!folderPath) {
    return { ok: false, code: 'GAME_PATH_REQUIRED', error: 'Game path is not configured.' };
  }
  const exePath = path.join(folderPath, 'skse64_loader.exe');
  if (!fs.existsSync(exePath)) {
    return { ok: false, code: 'SKSE_MISSING', error: 'skse64_loader.exe not found in the game folder.' };
  }

  try {
    const auth = readAuthFile();
    if (!auth || !auth.discordId) {
      return { ok: false, code: 'NOT_AUTHENTICATED', error: 'Log in again before starting the game.' };
    }
    activateOathboundLoadOrder(folderPath);


    // AUTH-01 + CONNECT-P0: the file the client actually reads receives the
    // opaque session, never profileId. The writer also writes the destination
    // directly with server-info-ignore, handles read-only, re-reads and
    // validates both JSONs. If any step fails, SKSE doesn't start with stale credentials.
    prepareConnectionSettings({
      gamePath: folderPath,
      ticket,
      serverIp: SERVER_IP,
      serverPort: SERVER_PORT,
      discordId: auth.discordId,
      // Only the label of the authorization widget on the main menu; identity
      // is still resolved by the master API from the session.
      displayName: auth.globalName || auth.username || null,
    });

    await killGameProcesses();
    const processResult = await startGameProcess(exePath, folderPath);
    console.info(`[launcher] Skyrim started with pid=${processResult.pid}`);

    armOathboundLoadOrderRestore();

    // Voice handoff: turns on the loopback listener for when the player runs /voice.
    // Never blocks PLAY — voice is optional.
    armVoiceHandoff(folderPath).catch((e) =>
      console.warn('[launcher] could not arm the voice handoff:', e?.message));

    return { ok: true, pid: processResult.pid };
  } catch (e: any) {
    restoreSharedLoadOrderFiles();

    const code = typeof e?.code === 'string' ? e.code : 'GAME_LAUNCH_FAILED';
    const message = typeof e?.message === 'string' && e.message
      ? e.message
      : 'Could not prepare or start the game.';
    console.error(`[launcher] Game bootstrap failed (${code}):`, e);
    return { ok: false, code, error: message };
  }
});
