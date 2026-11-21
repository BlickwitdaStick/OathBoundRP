export interface AuthData {
  discordId: string;
  username: string;
  globalName: string;
  avatar: string | null;
  loginDate: string;
}

export interface LaunchGameResult {
  ok: boolean;
  pid?: number;
  code?: string;
  error?: string;
}

export interface ServerModsCheck {
  ok: boolean;
  error?: string;
  version?: string;
  plugins?: string[];
  totalFiles?: number;
  missing?: Array<{ path: string; size: number }>;
  /** Base-game plugins (Creation Club) the server needs and the player lacks. */
  missingBase?: string[];
  bytesNeeded?: number;
  /** How the missing files split between Nexus Mods and the game server. */
  nexus?: {
    archives: Array<{ name: string; version: string; size: number; files: number }>;
    nexusBytes: number;
    serverBytes: number;
    serverFiles: number;
  };
  nexusAccount?: NexusAccount | null;
}

export interface NexusAccount {
  connected: boolean;
  name?: string;
  isPremium?: boolean;
  error?: string;
  apiKeyPage: string;
}

export interface ServerModsProgress {
  /** server = game-server download; nexus-* = Nexus Mods steps. */
  phase?: 'server' | 'nexus-wait' | 'nexus-download' | 'nexus-extract' | 'nexus-wrong-file';
  file?: string;
  name?: string;
  page?: string;
  index?: number;
  count?: number;
  bytesDone?: number;
  bytesTotal?: number;
}

export interface ElectronAPI {
  windowMinimize: () => void;
  windowClose: () => void;
  getLauncherConfig: () => Promise<{ gamePath?: string; display?: { width?: number; height?: number; mode?: string } }>;
  getAppInfo: () => Promise<{ launcherVersion: string; clientVersion: string | null; modsVersion: string | null; gamePath: string | null }>;
  saveGamePath: (folderPath: string) => Promise<{ ok: boolean; reason?: string }>;
  selectGamePath: () => Promise<string | null>;
  checkGamePath: (folderPath: string) => Promise<{ ok: boolean; reason: string }>;
  ensureSkyrimIni: (opts?: any) => Promise<any>;
  ensureSkympUi: (folderPath: string) => Promise<{ ok: boolean; repaired: string[]; files?: number; error?: string }>;
  ensureVoiceHelper: (folderPath: string) => Promise<{ ok: boolean; repaired: boolean; skipped?: boolean; reason?: string; error?: string }>;
  getDisplaySettings: () => Promise<any>;
  discordLogin: () => Promise<AuthData | null>;
  discordLogout: () => Promise<boolean>;
  getAuthStatus: () => Promise<AuthData | null>;
  checkServerStatus: () => Promise<{ online: boolean }>;
  joinQueue: () => Promise<any>;
  pollQueue: () => Promise<any>;
  getLocalPlugins: (folderPath: string) => Promise<any>;
  verifyMods: (folderPath: string) => Promise<{ success: boolean; error?: string; loadOrder?: string[] }>;
  checkServerMods: (folderPath: string) => Promise<ServerModsCheck>;
  installServerMods: (folderPath: string, opts?: { useNexus?: boolean }) => Promise<{ ok: boolean; installed?: string[]; nexusInstalled?: number; warnings?: string[]; pluginsChanged?: boolean; code?: string; error?: string }>;
  nexusGetAccount: () => Promise<NexusAccount>;
  nexusSetApiKey: (key: string) => Promise<NexusAccount>;
  nexusForget: () => Promise<NexusAccount>;
  nexusOpenKeyPage: () => Promise<void>;
  nexusReopenPage: () => Promise<void>;
  nexusSkipCurrent: () => Promise<void>;
  enableServerPlugins: (folderPath: string) => Promise<{ ok: boolean; changed?: boolean; error?: string }>;
  onServerModsProgress: (callback: (value: ServerModsProgress) => void) => void;
  analyzePlugins: (folderPath: string, serverLoadOrder?: string[]) => Promise<{ ok: boolean; problems: string[]; plugins: any[] }>;
  syncLoadorder: (folderPath: string, serverLoadOrder: string[]) => Promise<boolean>;
  isGameRunning: () => Promise<boolean>;
  killGame: () => Promise<boolean>;
  checkClientUpdate: (folderPath: string) => Promise<any>;
  installClientUpdate: (folderPath: string) => Promise<any>;
  checkModsUpdate: (folderPath: string) => Promise<any>;
  installModsUpdate: (folderPath: string, force?: boolean) => Promise<any>;
  getRecentCrashes: () => Promise<Array<{ name: string; mtime: number }>>;
  reportRecentCrashes: () => Promise<any>;
  onUpdateProgress: (callback: (value: any) => void) => void;
  onModsUpdateProgress: (callback: (value: any) => void) => void;
  launchGame: (folderPath: string, ticket: string) => Promise<LaunchGameResult>;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
