import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';

export const CONNECTION_SETTINGS_ERROR_CODES = Object.freeze({
  INVALID_GAME_PATH: 'INVALID_GAME_PATH',
  EMPTY_TICKET: 'EMPTY_TICKET',
  INVALID_SERVER_HOST: 'INVALID_SERVER_HOST',
  INVALID_SERVER_PORT: 'INVALID_SERVER_PORT',
  INVALID_EXISTING_JSON: 'INVALID_EXISTING_JSON',
  INVALID_EXISTING_SHAPE: 'INVALID_EXISTING_SHAPE',
  WRITE_FAILED: 'WRITE_FAILED',
  VERIFY_FAILED: 'VERIFY_FAILED'
});

export class ConnectionSettingsError extends Error {
  /** @param {keyof typeof CONNECTION_SETTINGS_ERROR_CODES} code @param {string} message @param {unknown} [cause] */
  constructor(code, message, cause) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'ConnectionSettingsError';
    this.code = CONNECTION_SETTINGS_ERROR_CODES[code];
  }
}

const FORBIDDEN_CREDENTIAL_KEYS = ['profileId', 'token', 'launcherTicket'];

/** @param {unknown} value */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** @param {string} host */
function isValidHost(host) {
  if (net.isIP(host)) return true;
  if (host.length > 253 || host.includes('://') || /[\s/:]/.test(host)) return false;
  const labels = host.endsWith('.') ? host.slice(0, -1).split('.') : host.split('.');
  return labels.length > 0 && labels.every(label =>
    label.length >= 1 && label.length <= 63 &&
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label)
  );
}

/** @param {string} host @param {number} port */
function formatServerAddress(host, port) {
  return net.isIP(host) === 6 ? `[${host}]:${port}` : `${host}:${port}`;
}

/**
 * Reads existing JSON without swallowing corruption. Silently overwriting a
 * truncated file would hide the real cause and could drop client options the
 * launcher doesn't know about.
 *
 * @param {string} filePath
 */
function readExistingJson(filePath) {
  if (!fs.existsSync(filePath)) return {};
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (cause) {
    throw new ConnectionSettingsError(
      'INVALID_EXISTING_JSON',
      `The existing connection file does not contain valid JSON: ${path.basename(filePath)}`,
      cause
    );
  }
  if (!isRecord(parsed)) {
    throw new ConnectionSettingsError(
      'INVALID_EXISTING_SHAPE',
      `The existing connection file must contain a JSON object: ${path.basename(filePath)}`
    );
  }
  return parsed;
}

/** @param {Record<string, unknown>} record */
function removeUntrustedCredentials(record) {
  for (const key of FORBIDDEN_CREDENTIAL_KEYS) delete record[key];
}

/**
 * Replaces a file by rename in the same directory. If the destination is
 * read-only, it opens only the window needed for the swap and restores the
 * previous mode on the new file. The temporary file never has the ticket in its name.
 *
 * @param {string} filePath
 * @param {string} contents
 */
function atomicWriteFile(filePath, contents) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });

  const existed = fs.existsSync(filePath);
  const previousMode = existed ? fs.statSync(filePath).mode : null;
  const tempPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
  );
  let destinationModeChanged = false;

  try {
    fs.writeFileSync(tempPath, contents, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    // Flush the bytes before publishing the final name.
    // Windows requires a writable descriptor for FlushFileBuffers/fsync.
    const tempFd = fs.openSync(tempPath, 'r+');
    try { fs.fsyncSync(tempFd); } finally { fs.closeSync(tempFd); }

    if (existed && previousMode !== null && (previousMode & 0o200) === 0) {
      fs.chmodSync(filePath, previousMode | 0o200);
      destinationModeChanged = true;
    }

    // Windows doesn't allow rename over an existing file. Removing the
    // destination leaves a tiny window, but the published bytes are always the
    // complete file. On POSIX, rename replaces atomically.
    try {
      fs.renameSync(tempPath, filePath);
    } catch (cause) {
      if (process.platform !== 'win32' || !fs.existsSync(filePath)) throw cause;
      fs.unlinkSync(filePath);
      fs.renameSync(tempPath, filePath);
    }

    if (previousMode !== null) fs.chmodSync(filePath, previousMode);
  } catch (cause) {
    if (destinationModeChanged && fs.existsSync(filePath) && previousMode !== null) {
      try { fs.chmodSync(filePath, previousMode); } catch {}
    }
    try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch {}
    throw cause;
  }
}

/** @param {string} filePath */
function readWrittenObject(filePath) {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!isRecord(value)) throw new Error('JSON root is not an object');
    return value;
  } catch (cause) {
    throw new ConnectionSettingsError(
      'VERIFY_FAILED',
      `Could not reread the saved configuration: ${path.basename(filePath)}`,
      cause
    );
  }
}

/** @param {Record<string, unknown>} record */
function hasForbiddenCredential(record) {
  return FORBIDDEN_CREDENTIAL_KEYS.some(key => Object.hasOwn(record, key));
}

/**
 * Builds the contents of `Data/Platform/PluginsNoLoad/auth-data-no-load.js`.
 *
 * This is the ONLY place the distributed skymp5-client (AuthService) gets a
 * remote session from: `readAuthDataFromDisk()` does
 * `JSON.parse(contents.slice(2))` and, on the main menu, shows the
 * authorization widget with the player's name and the "Play" button. Clicking
 * "Play" fires `authAttempt` with `{ remote: authData }`, connects to the peer
 * directly and sends `loginWithSkympIo { gameData: { session } }`; the server
 * resolves the session on the OATHBOUND master API (`/api/servers/:masterKey/sessions/:s`).
 *
 * `gameData.session` in `skymp5-client-settings.txt` is NOT read by the client
 * (only `gameData.profileId`, which is the offline mode forbidden by ADR-001).
 * Without this file the widget showed "not authorized" and "Play" answered
 * "login first" — or tried OAuth on SkyMP's public gateway.
 *
 * The format is `//` + JSON: the comment prefix exists because SkyrimPlatform
 * treats the folder as JS plugins (even in PluginsNoLoad).
 *
 * @param {{ticket:string, displayName?:string|null}} input
 */
export function buildRemoteAuthData({ ticket, displayName }) {
  const name = typeof displayName === 'string' ? displayName.trim() : '';
  return {
    session: ticket,
    // `masterApiId` is only shown when there is no name; the client doesn't
    // send it to the server. The real identity is resolved server-side from the session.
    masterApiId: 0,
    discordUsername: name || 'OATHBOUND',
    discordDiscriminator: null,
    discordAvatar: null
  };
}

/** @param {Record<string, unknown>} authData */
export function serializeRemoteAuthData(authData) {
  return `//${JSON.stringify(authData)}`;
}

/** @param {string} contents */
export function parseRemoteAuthData(contents) {
  const text = contents.charCodeAt(0) === 0xfeff ? contents.slice(1) : contents;
  if (!text.startsWith('//')) return null;
  return JSON.parse(text.slice(2)) || null;
}

/**
 * Prepares the two connection contracts read by the SkyMP client.
 * Throws `ConnectionSettingsError` on any inconsistency; the caller must not
 * start the game in that case.
 *
 * Also publishes the remote session in `PluginsNoLoad/auth-data-no-load.js` (see
 * `buildRemoteAuthData`). Nothing here connects automatically: the client only
 * connects when the player clicks "Play" in the menu's authorization widget.
 *
 * @param {{gamePath:string, ticket:string, serverIp:string, serverPort:number|string, discordId?:string, displayName?:string|null}} input
 * @returns {{configPath:string, clientSettingsPath:string, authDataPath:string, config:Record<string, unknown>, clientSettings:Record<string, unknown>}}
 */
export function prepareConnectionSettings(input) {
  const gamePath = typeof input?.gamePath === 'string' ? input.gamePath.trim() : '';
  if (!gamePath || gamePath.includes('\0')) {
    throw new ConnectionSettingsError("INVALID_GAME_PATH", "The game path is invalid.");
  }

  const ticket = typeof input?.ticket === 'string' ? input.ticket : '';
  if (!ticket.trim() || ticket.includes('\0')) {
    throw new ConnectionSettingsError("EMPTY_TICKET", "The launch ticket is empty or invalid.");
  }

  const serverIp = typeof input?.serverIp === 'string' ? input.serverIp.trim() : '';
  if (!isValidHost(serverIp)) {
    throw new ConnectionSettingsError("INVALID_SERVER_HOST", "The server host is invalid.");
  }

  const serverPort = typeof input?.serverPort === 'string' && /^\d+$/.test(input.serverPort)
    ? Number(input.serverPort)
    : input?.serverPort;
  if (!Number.isInteger(serverPort) || serverPort < 1 || serverPort > 65535) {
    throw new ConnectionSettingsError('INVALID_SERVER_PORT', 'The server port must be between 1 and 65535.');
  }

  const pluginsDirectory = path.join(gamePath, 'Data', 'Platform', 'Plugins');
  const configPath = path.join(pluginsDirectory, 'skymp_config.json');
  const clientSettingsPath = path.join(pluginsDirectory, 'skymp5-client-settings.txt');
  const authDataDirectory = path.join(gamePath, 'Data', 'Platform', 'PluginsNoLoad');
  const authDataPath = path.join(authDataDirectory, 'auth-data-no-load.js');
  const authData = buildRemoteAuthData({ ticket, displayName: input.displayName });

  // Read both before changing either: corrupted legacy JSON fails without
  // leaving half of the configuration updated.
  const config = { ...readExistingJson(configPath) };
  const clientSettings = { ...readExistingJson(clientSettingsPath) };
  const legacyGameData = isRecord(clientSettings.gameData) ? clientSettings.gameData : {};
  const gameData = { ...legacyGameData };

  removeUntrustedCredentials(config);
  removeUntrustedCredentials(clientSettings);
  removeUntrustedCredentials(gameData);

  config.session = `ticket:${ticket}`;
  config.serverAddress = formatServerAddress(serverIp, serverPort);
  if (input.discordId !== undefined) config.discordId = String(input.discordId);

  gameData.session = ticket;
  clientSettings.gameData = gameData;
  clientSettings['server-info-ignore'] = true;
  clientSettings['server-ip'] = serverIp;
  clientSettings['server-port'] = serverPort;
  clientSettings.master = '';

  try {
    atomicWriteFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    atomicWriteFile(clientSettingsPath, `${JSON.stringify(clientSettings, null, 2)}\n`);
    fs.mkdirSync(authDataDirectory, { recursive: true });
    // No trailing newline: the client does JSON.parse(slice(2)) of the whole
    // file, and JSON.parse tolerates whitespace, but we keep the exact format
    // the client itself writes in writeAuthDataToDisk.
    atomicWriteFile(authDataPath, serializeRemoteAuthData(authData));
  } catch (cause) {
    throw new ConnectionSettingsError("WRITE_FAILED", "Failed to save the connection configuration.", cause);
  }

  const writtenConfig = readWrittenObject(configPath);
  const writtenSettings = readWrittenObject(clientSettingsPath);
  const writtenGameData = isRecord(writtenSettings.gameData) ? writtenSettings.gameData : null;
  let writtenAuthData = null;
  try {
    writtenAuthData = parseRemoteAuthData(fs.readFileSync(authDataPath, 'utf8'));
  } catch (cause) {
    throw new ConnectionSettingsError(
      'VERIFY_FAILED',
      `Could not reread the saved configuration: ${path.basename(authDataPath)}`,
      cause
    );
  }
  const valid =
    isRecord(writtenAuthData) &&
    writtenAuthData.session === ticket &&
    !hasForbiddenCredential(writtenAuthData) &&
    writtenConfig.session === `ticket:${ticket}` &&
    writtenConfig.serverAddress === formatServerAddress(serverIp, serverPort) &&
    !hasForbiddenCredential(writtenConfig) &&
    writtenSettings['server-info-ignore'] === true &&
    writtenSettings['server-ip'] === serverIp &&
    writtenSettings['server-port'] === serverPort &&
    writtenSettings.master === '' &&
    writtenGameData !== null &&
    writtenGameData.session === ticket &&
    !hasForbiddenCredential(writtenSettings) &&
    !hasForbiddenCredential(writtenGameData);

  if (!valid) {
    throw new ConnectionSettingsError("VERIFY_FAILED", "The saved configuration does not match the requested connection.");
  }

  return { configPath, clientSettingsPath, authDataPath, config: writtenConfig, clientSettings: writtenSettings };
}
