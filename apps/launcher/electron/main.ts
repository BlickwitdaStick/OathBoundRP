import { app, BrowserWindow, ipcMain, dialog, screen, shell, safeStorage } from 'electron';
import path from 'path';
import { exec, spawn } from 'child_process';
import fs from 'fs';
import http from 'http';
import https from 'https';
import crypto from 'crypto';
import { URL, fileURLToPath } from 'url';
import { parsePluginsTxt, parsePluginHeader, compareMods, analyzePlugins, parseCccTxt, analyzeCreationClub } from './parity.mjs';
import { avaliarEspaco, ehDiscoCheio } from './disk.mjs';
import { syncUiBundle } from './ui-integrity.mjs';
import { syncVoiceHelper } from './voice-helper.mjs';
import { prepararConfiguracaoConexao } from './connection-settings.mjs';
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
import { iniciarProcessoJogo } from './game-process.mjs';
import { iniciarVoiceHelper, killVoiceHelper } from './voice-process.mjs';
import { createVoiceHandoffServer, VOICE_HANDOFF_PORT } from './voice-handoff.mjs';

// package.json tem "type": "module", entao o Vite empacota este arquivo como
// ESM — __dirname nao existe em ESM (e' global so de CommonJS). Sem isso,
// qualquer `npm start` falhava na primeira BrowserWindow com
// "ReferenceError: __dirname is not defined", antes mesmo da janela abrir.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Constants & Env ───
// Estes valores são substituídos em tempo de build pelo `define` do
// vite.config.ts — em runtime não existe `.env` do lado do app empacotado.
// VITE_DISCORD_CLIENT_SECRET foi removido de propósito: o secret vive só no
// painel web (ver POST /api/launcher/oauth/exchange).
const DISCORD_CLIENT_ID = process.env.VITE_DISCORD_CLIENT_ID || '';
const DISCORD_REDIRECT_URI = process.env.VITE_DISCORD_REDIRECT_URI || 'http://localhost:19847/callback';
const SERVER_IP = process.env.VITE_SERVER_IP || '127.0.0.1';
// Default 7777 pra bater com o "port" de skymp/config/server-settings.*.json.
// O default anterior era 7757, que nao existia em lugar nenhum do lado servidor.
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

// voice-helper.exe: captura de microfone fora do CEF pra voz por proximidade.
// Empacotado como resources/vendor/ quando o build de C++ estava disponivel na
// hora de gerar o instalador (scripts/stage-voice-helper.mjs). Pode nao existir:
// a voz e opcional e o helper nao sai do `npm run build`.
function bundledVoiceHelperPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'vendor', 'voice-helper.exe')
    : path.resolve(__dirname, '../../../voice-helper/build/Release/voice-helper.exe');
}

function ensureVoiceHelper(gamePath: string) {
  if (!gamePath) return { ok: false, repaired: false, error: 'Invalid game path.' };
  // Fica em Data/Platform/, junto do resto do que a SkyrimPlatform usa.
  return syncVoiceHelper({
    sourcePath: bundledVoiceHelperPath(),
    targetPath: deployedVoiceHelperPath(gamePath)
  });
}

function deployedVoiceHelperPath(gamePath: string) {
  return path.join(gamePath, 'Data', 'Platform', 'voice-helper.exe');
}

// ─── Handoff do ticket de voz ───
// O comando /voz no jogo emite um ticket de 'sender'; a CEF o repassa pra este
// servidor loopback (porta 19848), que sobe o voice-helper.exe com --ticket.
// Tudo opcional: sem exe, ou sem a CEF conseguindo fazer o fetch, falar nao
// sobe e ouvir segue. Ver docs/technical/VOICE_NATIVE_HELPER.md §11.
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
      console.info('[launcher] voice-helper.exe ausente; handoff de voz desativado nesta sessao.');
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
        const r = await iniciarVoiceHelper(exePath, args, gamePath);
        console.info(`[launcher] voice-helper iniciado (pid=${r.pid}) para actor 0x${actorId.toString(16)}`);
        return r;
      }
    });
    try {
      await voiceHandoff.listen();
    } catch (e: any) {
      console.warn(`[launcher] handoff de voz nao pode escutar em ${VOICE_HANDOFF_PORT}: ${e?.message}`);
      voiceHandoff = null;
      return;
    }
  }

  voiceHandoff.arm();

  // Sem watcher de saida do jogo (o spawn e detached). Quando o jogo fecha,
  // desarma o handoff e mata o helper — a voz nao faz sentido sem o jogo.
  if (voiceWatchdog) clearInterval(voiceWatchdog);
  let vimoJogoRodando = false;
  voiceWatchdog = setInterval(async () => {
    const running = await isGameRunning();
    if (running) { vimoJogoRodando = true; return; }
    if (!vimoJogoRodando) return; // ainda subindo
    clearInterval(voiceWatchdog!);
    voiceWatchdog = null;
    voiceHandoff?.disarm();
    killVoiceHelper();
    console.info('[launcher] jogo encerrado; handoff de voz desarmado.');
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

// [VOIP-NOTHROTTLE] - Previne gargalos no jogo quando em background
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
      // O sandbox padrao do Electron para o preload script tem arestas mal
      // resolvidas com preload em ESM (`.mjs`): o arquivo carrega sem erro,
      // mas o contextBridge.exposeInMainWorld nunca roda, e o renderer ve
      // `window.electronAPI === undefined`. contextIsolation continua ligado
      // — isso ja isola o preload do conteudo da pagina; o sandbox e' uma
      // camada a mais especificamente sobre chamadas de sistema do proprio
      // preload, e o nosso preload e' codigo nosso, nao conteudo de terceiro.
      //
      // Tentei trocar o preload pra CommonJS pra manter o sandbox ligado
      // (22/08/2026) e reverti: o vite-plugin-electron desta versao mira
      // Vite 8/Rolldown e ignora silenciosamente `format: 'cjs'` passado por
      // `rollupOptions` — o arquivo saia `.cjs` por fora, ESM por dentro, o
      // que quebraria ao carregar. Sem uma via confirmada de configurar o
      // formato do preload nesta versao do plugin, `sandbox: false` continua
      // sendo a correcao que de fato funciona. Ver
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

// ─── Info do App (Home) ───
//
// Tudo aqui já existia em algum canto do processo main — só nunca tinha sido
// exposto pra tela inicial. `launcherVersion` já era lido em
// report-recent-crashes; `clientVersion`/`modsVersion` já eram lidos via
// readStamp() pelos handlers de update. Sem chamada de rede: os stamps são
// arquivos locais gravados na última instalação/atualização bem-sucedida.
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
 * POST de JSON para uma URL arbitrária (http ou https). Diferente de
 * `postJsonToApi`, que é fixo no host/porta do servidor de jogo — o painel web
 * costuma ficar em outro host/porta (VITE_PANEL_URL).
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

// Espaco livre do volume que contem `caminho`. Devolve null quando nao da pra
// medir -- `statfs` pode faltar, e nesse caso `avaliarEspaco` segue em frente
// de proposito (ver disk.mjs).
function espacoLivreBytes(caminho: string): number | null {
  try {
    const st = (fs as any).statfsSync(caminho);
    return st.bsize * st.bavail;
  } catch {
    return null;
  }
}

/**
 * O .zip vai pro temp e o conteudo e extraido na pasta do jogo -- que podem
 * estar em discos diferentes. Checar so um deixa passar metade dos casos.
 */
function checarEspacoParaBaixar(tmpPath: string, destinoPath: string, sizeBytes: number) {
  return avaliarEspaco([
    { rotulo: `disco temporario (${path.parse(tmpPath).root})`, livreBytes: espacoLivreBytes(path.dirname(tmpPath)), necessarioBytes: sizeBytes },
    { rotulo: `pasta do jogo (${path.parse(destinoPath).root})`, livreBytes: espacoLivreBytes(destinoPath), necessarioBytes: sizeBytes }
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

// Hash do manifesto de mods. Era MD5 ate 23/08/2026; MD5 tem colisao pratica,
// e o modelo de ameaca aqui nao e corrupcao acidental -- e jogador alterando um
// mod DE PROPOSITO, que e exatamente o caso em que colisao importa.
//
// A leitura e por stream porque fs.readFileSync do arquivo inteiro, para um
// Skyrim.esm de referencia (~280 MB), aloca tudo na heap de uma vez por mod e
// estourava a memoria do launcher antes do jogo abrir.
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
    tar.on('close', code => code === 0 ? resolve() : reject(new Error(stderr || `tar saiu com codigo ${code}`)));
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
  // O helper de voz e filho do launcher — mata pelo handle primeiro; o taskkill
  // e rede de seguranca pra uma instancia orfa de sessao anterior.
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
          res.end('<h1>Erro: parâmetro state inválido ou ausente.</h1>');
          callbackServer.close();
          finish(null);
          return;
        }

        if (!code) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<h1>Erro: código de autorização não recebido.</h1>');
          callbackServer.close();
          finish(null);
          return;
        }

        // A troca de `code` por token roda no painel web, não aqui: o client
        // secret do Discord não pode viajar dentro de um instalador que os
        // jogadores baixam. Ver POST /api/launcher/oauth/exchange em
        // apps/web/server.js e docs/technical/LAUNCHER_DISTRIBUTION.md.
        const exchange = await postJsonToUrl(`${PANEL_URL}/api/launcher/oauth/exchange`, {
          code,
          redirect_uri: DISCORD_REDIRECT_URI,
        });

        if (exchange.status !== 200 || !exchange.data || !exchange.data.discordId) {
          res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<h1>Erro ao concluir o login. Verifique se o painel do servidor está acessível.</h1>');
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
          // Prova de que este Discord autenticou de fato, emitida pelo painel.
          // É o que a fila (apps/game-api) exige — `discordId` sozinho é público
          // e não prova nada. Vem ausente se a conta ainda não existe no painel
          // (jogador que nunca pediu whitelist).
          launchTicket: user.launchTicket || null,
          // Multiuso, ~30 dias — troca por um launchTicket novo em
          // /api/launcher/session/refresh-ticket sem repetir este popup.
          // Ver migration-v25-launcher-sessions.sql.
          sessionToken: user.sessionToken || null,
          loginDate: new Date().toISOString(),
        };

        writeAuthFile(authData);

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`
          <html>
            <body style="background:#0a0a0a;color:#c9a227;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">
              <div style="text-align:center;">
                <h1>✅ Login realizado com sucesso!</h1>
                <p style="color:#d6d3d1;">Bem-vindo, ${escapeHtml(authData.globalName)}! Pode fechar esta janela.</p>
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
        res.end('<h1>Erro interno.</h1>');
        callbackServer.close();
        finish(null);
      }
    });

    // Sem isto, uma falha de listen() (porta 19847 ainda presa por uma
    // tentativa de login anterior que nao fechou limpo) virava um evento
    // 'error' sem listener no servidor HTTP -- e o comportamento padrao do
    // Node pra 'error' sem handler e' lancar e derrubar o processo inteiro,
    // exigindo reiniciar o launcher pra tentar de novo.
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
  // Melhor esforço: se o painel estiver fora do ar, o logout local acontece
  // do mesmo jeito. Sem isto, um auth.json roubado do disco continuaria
  // rendendo launch tickets novos mesmo depois do dono deslogar.
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
// A fila é autenticada por ticket, não por `discordId`: discordId é público, e
// mandá-lo como prova de identidade deixaria qualquer um entrar na fila no
// lugar de outro jogador. O ticket inicial vem do painel no login; cada consulta
// consome o ticket atual e recebe o próximo (`pollTicket`), então um ticket
// interceptado já está gasto quando chega em outras mãos.

/**
 * Guarda o ticket da próxima consulta de fila. Vive só em memória de propósito:
 * é de uso único e curto, não faz sentido persistir entre execuções.
 */
let currentQueueTicket: string | null = null;

/**
 * Antes desta função trocar sempre por um ticket fresco via `sessionToken`,
 * uma segunda tentativa de jogar na mesma sessão do launcher — sem `pollTicket`
 * em memória, ex: a fila admitiu direto na primeira vez, sem fila de espera —
 * reenviava o `launchTicket` do login, que já tinha sido consumido. O servidor
 * respondia 401 invalid_ticket, e a única saída era refazer o OAuth do Discord
 * inteiro. Ver migration-v25-launcher-sessions.sql.
 */
async function nextQueueTicket(): Promise<string | null> {
  // Um pollTicket em memória (emitido pelo game-api enquanto na fila) sempre
  // vence: já está fresco e foi emitido pra esta consulta específica.
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
    // Sessão expirada/revogada (ex: usuário deslogou de outra máquina): cai
    // pro launchTicket abaixo, que na pior das hipóteses dá o mesmo
    // 401 invalid_ticket que já existia antes desta mudança.
  }

  return auth.launchTicket || null;
}

function rememberQueueTicket(response: any) {
  if (response && typeof response.pollTicket === 'string') {
    currentQueueTicket = response.pollTicket;
    delete response.pollTicket; // o renderer não precisa nem deve ver o ticket
  }
  return response;
}

// ─── Server Status ───
//
// A tela inicial mostrava "Online" fixo no JSX, sem checagem nenhuma por
// trás — um bolinha verde e um texto que nunca mudavam, independente do
// apps/game-api estar de pé ou não. `GET /health` já existe no game-api
// (usado só por operação manual); isto é o primeiro consumidor real dele.
ipcMain.handle('check-server-status', async () => {
  const online = await new Promise<boolean>((resolve) => {
    const req = http.get(
      `http://${SERVER_IP}:${API_PORT}/health`,
      { headers: { 'User-Agent': 'Skyrim-Heavy-RP-Launcher' } },
      (res) => {
        res.resume(); // não precisa do corpo, só confirmar que respondeu
        resolve(res.statusCode === 200);
      }
    );
    req.on('error', () => resolve(false));
    // Curto de propósito: isto roda no boot da tela e num intervalo — um
    // timeout de 20s (padrão do httpGetJson) deixaria a UI travada "carregando"
    // por muito tempo toda vez que o servidor estiver mesmo fora do ar.
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

// O ticket vai no corpo do POST, igual ao `join-queue` acima. Já foi query
// string de um GET: query string entra em log de acesso e de proxy, e o ticket
// é credencial — quem o tem consulta a fila como aquela conta. Ver
// `SEC-QS-01` em docs/roadmap/ECOSYSTEM_ADAPTATION_ROADMAP.md.
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
  // O I/O fica aqui; o parsing vive em parity.mjs, testado com plugin
  // sintetico. Lemos so o comeco do arquivo: o bloco de masters fica no
  // cabecalho, e um .esm de Skyrim tem centenas de MB.
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

// ─── Mods hospedados pelo servidor (SkyUI, RaceMenu...) ───
// O game-api publica /client-mods/manifest.json (skymp/client-mods). Antes do
// PLAY o renderer pergunta o que falta, mostra ao jogador e, com o ok dele,
// baixa/verifica/instala. Ver electron/server-mods.mjs.

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
    const space = checarEspacoParaBaixar(path.join(gamePath, 'Data', '.space-check'), gamePath, plan.totalBytes + biggestArchive);
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
  if (!folderPath) return { success: false, error: "Caminho do jogo inválido." };
  try {
    const dataPath = path.join(folderPath, 'Data');
    if (!fs.existsSync(dataPath)) return { success: false, error: "Pasta Data não encontrada." };

    const modsJson: any = await new Promise((resolve) => {
      http.get(`http://${SERVER_IP}:${API_PORT}/mods.json`, (res) => {
        if (res.statusCode !== 200) { resolve(null); return; }
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
      }).on('error', () => resolve(null));
    });

    if (!modsJson || !modsJson.mods) {
      return { success: false, error: "Falha ao baixar mods.json do servidor. Servidor pode estar offline." };
    }

    const allFiles = fs.readdirSync(dataPath);
    const hashOf = (filename: string) => hashFileForManifest(path.join(dataPath, filename));

    const resultado = await compareMods({
      serverMods: modsJson.mods,
      localFiles: allFiles,
      hashOf,
      hashAlgorithm: modsJson.hashAlgorithm
    });
    if (!resultado.success) return resultado;

    return { success: true, loadOrder: modsJson.loadOrder };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('analyze-plugins', async (_event, folderPath, serverLoadOrder) => {
  if (!folderPath) return { ok: false, problems: ['Invalid game path.'], plugins: [] };
  try {
    const dataPath = path.join(folderPath, 'Data');
    if (!fs.existsSync(dataPath)) return { ok: false, problems: ['Pasta Data nao encontrada.'], plugins: [] };

    // A load order real vem do plugins.txt, nao dos arquivos presentes em
    // Data/: um plugin no disco e desativado nao ocupa indice e nao desloca
    // FormID nenhum. Sem o arquivo, parity.mjs cai para os arquivos presentes,
    // que e a direcao segura.
    const pluginsTxtPath = oathboundPluginsTxtPath(folderPath);
    const enabledPlugins = fs.existsSync(pluginsTxtPath)
      ? parsePluginsTxt(fs.readFileSync(pluginsTxtPath, 'utf8')).filter(p => p.enabled).map(p => p.name)
      : undefined;

    const localPlugins = listDataPlugins(folderPath);

    const resultado = analyzePlugins({
      localPlugins,
      serverLoadOrder,
      enabledPlugins,
      readHeader: (nome: string) => readPluginHeader(path.join(dataPath, nome))
    });

    // Creation Club nao passa pelo plugins.txt: o Skyrim AE le o Skyrim.ccc e
    // carrega sozinho o que estiver listado e presente em Data/. Sao plugins
    // que ocupam indice de load order e que a checagem acima nao enxerga.
    //
    // O arquivo fica na raiz do jogo, ao lado do executavel — nao em Data/. E
    // o conteudo dele varia conforme o que a conta Steam possui, entao dois
    // testadores podem carregar listas diferentes sem ter escolhido nada.
    const cccPath = path.join(folderPath, 'Skyrim.ccc');
    const cccEntries = fs.existsSync(cccPath)
      ? parseCccTxt(fs.readFileSync(cccPath, 'utf8'))
      : [];

    const cc = analyzeCreationClub({ cccEntries, localPlugins, serverLoadOrder, enabledPlugins });

    return {
      ...resultado,
      ok: resultado.ok && cc.ok,
      problems: [...resultado.problems, ...cc.problems],
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
  // Sem DIST_REPO, o operador optou por não distribuir via GitHub Releases
  // (dev local, fork em teste) — isso não é o mesmo caso que "configurei a
  // distribuição e ela está fora do ar". Bloquear PLAY aqui puniria quem
  // nunca pediu esse gate, então este caso passa sem erro. Manifesto ausente
  // ou inválido COM DIST_REPO configurado continua falhando fechado abaixo:
  // aí sim alguém decidiu depender do gate e ele está quebrado.
  if (!DIST_REPO) return { updateAvailable: false };
  const manifest = await httpGetJson(clientManifestUrl());
  if (!manifest || !manifest.clientVersion) return { updateAvailable: false, error: 'Manifesto de cliente indisponivel.' };
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
  if (await isGameRunning()) return { success: false, gameRunning: true, error: 'O jogo esta aberto. Feche antes de atualizar.' };
  if (!DIST_REPO) return { success: false, error: 'VITE_GITHUB_DIST_REPO nao configurado.' };

  const send = (phase: string, percent: number) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update-progress', { phase, percent });
  };
  const tmpZip = path.join(app.getPath('temp'), 'skymp_client_update.zip');
  try {
    const manifest = await httpGetJson(clientManifestUrl());
    if (!manifest || !manifest.downloadUrl) return { success: false, error: 'Manifesto de cliente invalido.' };

    const espaco = checarEspacoParaBaixar(tmpZip, gamePath, manifest.sizeBytes);
    if (!espaco.ok) return { success: false, error: espaco.error };

    send('download', 0);
    await downloadToFile(manifest.downloadUrl, tmpZip, percent => send('download', percent));
    if (!manifest.sha256) {
      try { fs.unlinkSync(tmpZip); } catch {}
      return { success: false, error: 'Manifesto de cliente sem SHA256: verificacao de integridade obrigatoria ausente.' };
    }
    send('verify', 0);
    const actual = await sha256File(tmpZip);
    if (actual.toLowerCase() !== String(manifest.sha256).toLowerCase()) {
      try { fs.unlinkSync(tmpZip); } catch {}
      return { success: false, error: 'SHA256 do cliente nao confere.' };
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
    // ENOSPC cru ("no space left on device, write") no meio de uma barra de
    // progresso nao diz ao jogador se o problema e dele, do servidor ou da
    // internet. A checagem previa nao pega tudo: o disco pode encher DURANTE
    // o download, ou a extracao pode precisar de mais que o .zip.
    if (ehDiscoCheio(e)) {
      return { success: false, error: 'O disco encheu durante a operacao. Libere espaco e tente de novo.' };
    }
    return { success: false, error: e.message };
  }
});

ipcMain.handle('check-mods-update', async (_event, gamePath) => {
  if (!DIST_REPO) return { updateAvailable: false, error: 'VITE_GITHUB_DIST_REPO nao configurado.' };
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
  if (await isGameRunning()) return { success: false, gameRunning: true, error: 'O jogo esta aberto. Feche antes de atualizar mods.' };
  if (!DIST_REPO) return { success: false, error: 'VITE_GITHUB_DIST_REPO nao configurado.' };

  const send = (phase: string, percent: number) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('mods-update-progress', { phase, percent });
  };
  const tmpZip = path.join(app.getPath('temp'), 'skymp_mods_update.zip');
  try {
    const manifest = await httpGetJson(modsManifestUrl());
    if (!manifest || (!manifest.downloadUrl && !Array.isArray(manifest.parts))) return { success: false, error: 'Manifesto de mods invalido.' };
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

    // Soma o que ainda falta baixar: partes ja instaladas nao ocupam disco de novo.
    const bytesPendentes = parts.reduce((total: number, p: any) => {
      const jaTem = !force && installedParts[p.name || p.url] && installedParts[p.name || p.url] === (p.contentSig || null);
      return jaTem ? total : total + (Number(p.sizeBytes) || 0);
    }, 0);
    const espacoMods = checarEspacoParaBaixar(tmpZip, gamePath, bytesPendentes);
    if (!espacoMods.ok) return { success: false, error: espacoMods.error };

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
        return { success: false, error: `Parte ${index + 1} sem SHA256: verificacao de integridade obrigatoria ausente.` };
      }
      send('verify', base);
      const actual = await sha256File(tmpZip);
      if (actual.toLowerCase() !== String(part.sha256).toLowerCase()) {
        try { fs.unlinkSync(tmpZip); } catch {}
        return { success: false, error: `SHA256 dos mods nao confere na parte ${index + 1}.` };
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
    // ENOSPC cru ("no space left on device, write") no meio de uma barra de
    // progresso nao diz ao jogador se o problema e dele, do servidor ou da
    // internet. A checagem previa nao pega tudo: o disco pode encher DURANTE
    // o download, ou a extracao pode precisar de mais que o .zip.
    if (ehDiscoCheio(e)) {
      return { success: false, error: 'O disco encheu durante a operacao. Libere espaco e tente de novo.' };
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
        ? Buffer.concat([raw.subarray(0, maxBytes), Buffer.from('\n...[truncado pelo launcher]')]).toString('utf8')
        : raw.toString('utf8');
      return { filename: file.name, mtime: file.mtime, content };
    })
  };

  const result = await postJsonToApi('/api/crashes/client', payload);
  return { ok: !!result?.ok || result?.status === 'ok', sent: crashes.length, response: result };
});

ipcMain.handle('launch-game', async (_event, folderPath, ticket) => {
  if (!folderPath) {
    return { ok: false, code: 'GAME_PATH_REQUIRED', error: 'Caminho do jogo nao configurado.' };
  }
  const exePath = path.join(folderPath, 'skse64_loader.exe');
  if (!fs.existsSync(exePath)) {
    return { ok: false, code: 'SKSE_MISSING', error: 'skse64_loader.exe nao encontrado na pasta do jogo.' };
  }

  try {
    const auth = readAuthFile();
    if (!auth || !auth.discordId) {
      return { ok: false, code: 'NOT_AUTHENTICATED', error: 'Faca login novamente antes de iniciar o jogo.' };
    }
    activateOathboundLoadOrder(folderPath);


    // AUTH-01 + CONNECT-P0: o arquivo realmente consumido pelo cliente recebe
    // a sessao opaca, nunca profileId. O writer tambem grava o destino direto
    // com server-info-ignore, trata read-only, rele e valida os dois JSONs. Se
    // qualquer passo falhar, o SKSE nao nasce com credenciais antigas.
    prepararConfiguracaoConexao({
      gamePath: folderPath,
      ticket,
      serverIp: SERVER_IP,
      serverPort: SERVER_PORT,
      discordId: auth.discordId,
      // Só rótulo do widget de autorização no menu principal; a identidade
      // continua sendo resolvida pelo master API a partir da sessão.
      displayName: auth.globalName || auth.username || null,
    });

    await killGameProcesses();
    const processResult = await iniciarProcessoJogo(exePath, folderPath);
    console.info(`[launcher] Skyrim iniciado com pid=${processResult.pid}`);

    armOathboundLoadOrderRestore();

    // Handoff de voz: liga o listener loopback pra quando o jogador rodar /voz.
    // Nunca bloqueia o PLAY — a voz e opcional.
    armVoiceHandoff(folderPath).catch((e) =>
      console.warn('[launcher] nao foi possivel armar o handoff de voz:', e?.message));

    return { ok: true, pid: processResult.pid };
  } catch (e: any) {
    restoreSharedLoadOrderFiles();

    const code = typeof e?.code === 'string' ? e.code : 'GAME_LAUNCH_FAILED';
    const message = typeof e?.message === 'string' && e.message
      ? e.message
      : 'Nao foi possivel preparar ou iniciar o jogo.';
    console.error(`[launcher] Falha no bootstrap do jogo (${code}):`, e);
    return { ok: false, code, error: message };
  }
});
