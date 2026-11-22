import { contextBridge, ipcRenderer } from 'electron';

const api = {
  windowMinimize: () => ipcRenderer.send('window-minimize'),
  windowClose: () => ipcRenderer.send('window-close'),
  getLauncherConfig: () => ipcRenderer.invoke('get-launcher-config'),
  getAppInfo: () => ipcRenderer.invoke('get-app-info'),
  checkLauncherUpdate: () => ipcRenderer.invoke('launcher-update-check'),
  installLauncherUpdate: () => ipcRenderer.invoke('launcher-update-install'),
  onLauncherUpdateProgress: (cb: (p: { done: number; total: number }) => void) => {
    const h = (_e: unknown, p: { done: number; total: number }) => cb(p);
    ipcRenderer.on('launcher-update-progress', h);
    return () => { ipcRenderer.removeListener('launcher-update-progress', h); };
  },
  saveGamePath: (folderPath: string) => ipcRenderer.invoke('save-game-path', folderPath),
  selectGamePath: () => ipcRenderer.invoke('select-game-path'),
  checkGamePath: (folderPath: string) => ipcRenderer.invoke('check-game-path', folderPath),
  ensureSkyrimIni: (opts?: any) => ipcRenderer.invoke('ensure-skyrim-ini', opts),
  ensureSkympUi: (folderPath: string) => ipcRenderer.invoke('ensure-skymp-ui', folderPath),
  ensureVoiceHelper: (folderPath: string) => ipcRenderer.invoke('ensure-voice-helper', folderPath),
  ensureSkse: (folderPath: string) => ipcRenderer.invoke('ensure-skse', folderPath),
  onSkseProgress: (cb: (p: { done: number; total: number }) => void) => {
    const h = (_e: unknown, p: { done: number; total: number }) => cb(p);
    ipcRenderer.on('skse-progress', h);
    return () => { ipcRenderer.removeListener('skse-progress', h); };
  },
  getDisplaySettings: () => ipcRenderer.invoke('get-display-settings'),
  discordLogin: () => ipcRenderer.invoke('discord-login'),
  discordLogout: () => ipcRenderer.invoke('discord-logout'),
  getAuthStatus: () => ipcRenderer.invoke('get-auth-status'),
  checkServerStatus: () => ipcRenderer.invoke('check-server-status'),
  joinQueue: () => ipcRenderer.invoke('join-queue'),
  pollQueue: () => ipcRenderer.invoke('poll-queue'),
  getLocalPlugins: (folderPath: string) => ipcRenderer.invoke('get-local-plugins', folderPath),
  verifyMods: (folderPath: string) => ipcRenderer.invoke('verify-mods', folderPath),
  checkServerMods: (folderPath: string) => ipcRenderer.invoke('check-server-mods', folderPath),
  installServerMods: (folderPath: string, opts?: { useNexus?: boolean }) => ipcRenderer.invoke('install-server-mods', folderPath, opts),
  nexusGetAccount: () => ipcRenderer.invoke('nexus-get-account'),
  nexusSetApiKey: (key: string) => ipcRenderer.invoke('nexus-set-api-key', key),
  nexusForget: () => ipcRenderer.invoke('nexus-forget'),
  nexusOpenKeyPage: () => ipcRenderer.invoke('nexus-open-key-page'),
  nexusReopenPage: () => ipcRenderer.invoke('nexus-reopen-page'),
  nexusSkipCurrent: () => ipcRenderer.invoke('nexus-skip-current'),
  enableServerPlugins: (folderPath: string) => ipcRenderer.invoke('enable-server-plugins', folderPath),
  onServerModsProgress: (callback: (value: any) => void) => {
    ipcRenderer.removeAllListeners('server-mods-progress');
    ipcRenderer.on('server-mods-progress', (_event, value) => callback(value));
  },
  analyzePlugins: (folderPath: string, serverLoadOrder?: string[]) => ipcRenderer.invoke('analyze-plugins', folderPath, serverLoadOrder),
  syncLoadorder: (folderPath: string, serverLoadOrder: string[]) => ipcRenderer.invoke('sync-loadorder', folderPath, serverLoadOrder),
  isGameRunning: () => ipcRenderer.invoke('is-game-running'),
  killGame: () => ipcRenderer.invoke('kill-game'),
  checkClientUpdate: (folderPath: string) => ipcRenderer.invoke('check-client-update', folderPath),
  installClientUpdate: (folderPath: string) => ipcRenderer.invoke('install-client-update', folderPath),
  checkModsUpdate: (folderPath: string) => ipcRenderer.invoke('check-mods-update', folderPath),
  installModsUpdate: (folderPath: string, force?: boolean) => ipcRenderer.invoke('install-mods-update', folderPath, force),
  getRecentCrashes: () => ipcRenderer.invoke('get-recent-crashes'),
  reportRecentCrashes: () => ipcRenderer.invoke('report-recent-crashes'),
  onUpdateProgress: (callback: (value: any) => void) => {
    ipcRenderer.removeAllListeners('update-progress');
    ipcRenderer.on('update-progress', (_event, value) => callback(value));
  },
  onModsUpdateProgress: (callback: (value: any) => void) => {
    ipcRenderer.removeAllListeners('mods-update-progress');
    ipcRenderer.on('mods-update-progress', (_event, value) => callback(value));
  },
  launchGame: (folderPath: string, ticket: string) => ipcRenderer.invoke('launch-game', folderPath, ticket)
};

contextBridge.exposeInMainWorld('electronAPI', api);
