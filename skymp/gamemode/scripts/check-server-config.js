const fs = require('fs');
const path = require('path');

const PLACEHOLDER = /replace[-_ ]?with|changeme|example|your[-_ ]|<.+>/i;

function validateServerConfig(config, options = {}) {
  const environment = options.environment || 'production';
  const findings = [];
  const error = (code, message) => findings.push({ level: 'ERROR', code, message });
  const warn = (code, message) => findings.push({ level: 'WARN', code, message });

  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    error('CONFIG_INVALID', 'configuração deve ser um objeto JSON');
    return findings;
  }
  if (environment !== 'local' && config.offlineMode !== false) {
    error('AUTH_OFFLINE_MODE', 'offlineMode deve ser false fora do laboratório local');
  }
  if (environment !== 'local' && (!config.master || typeof config.master !== 'string')) {
    error('AUTH_MASTER_MISSING', 'Master API é obrigatória fora do laboratório local');
  }
  if (environment === 'production' && typeof config.master === 'string' && !config.master.startsWith('https://')) {
    error('AUTH_MASTER_TLS', 'Master API de produção deve usar HTTPS');
  }
  if (typeof config.masterKey !== 'string' || config.masterKey.length < 32) {
    error('AUTH_MASTER_KEY_WEAK', 'masterKey deve ter pelo menos 32 caracteres');
  } else if (PLACEHOLDER.test(config.masterKey)) {
    error('AUTH_MASTER_KEY_PLACEHOLDER', 'masterKey ainda contém placeholder');
  }
  if (environment === 'production' && config.isPapyrusHotReloadEnabled === true) {
    error('DEBUG_HOT_RELOAD', 'Papyrus hot reload não pode ficar ativo em produção');
  }
  // NPC switches. SkyMP (ScampServer.cpp) reads npcSettings keys as plugin
  // file names, and WorldState::IsNpcAllowed returns false as soon as it meets
  // a key that is not a loaded plugin — so a "default" entry, or a plugin that
  // is not in loadOrder, can silently block NPCs from every plugin. The
  // "default" entry is also never parsed as a default (the parser looks for a
  // top-level "default" and then reads top-level spawnIn* keys). The project
  // uses npcEnabled alone and filters in the gamemode (NPC_SPAWN_FILTER.md).
  if (config.npcSettings !== undefined && config.npcSettings !== null) {
    if (typeof config.npcSettings !== 'object' || Array.isArray(config.npcSettings)) {
      error('NPC_SETTINGS_INVALID', 'npcSettings must be an object keyed by plugin file name');
    } else {
      const loaded = new Set((Array.isArray(config.loadOrder) ? config.loadOrder : []).map((p) => String(p).toLowerCase()));
      for (const key of Object.keys(config.npcSettings)) {
        if (key.toLowerCase() === 'default') {
          error('NPC_SETTINGS_DEFAULT', 'npcSettings.default is read as a plugin named "default" and can block every NPC; remove it (see docs/technical/NPC_SPAWN_FILTER.md)');
        } else if (!loaded.has(key.toLowerCase())) {
          error('NPC_SETTINGS_UNKNOWN_PLUGIN', `npcSettings key "${key}" is not in loadOrder; SkyMP then refuses NPCs from other plugins too`);
        }
      }
    }
  }
  if (config.npcSettings && config.npcEnabled !== true) {
    warn('NPC_SETTINGS_IGNORED', 'npcSettings has no effect while npcEnabled is not true');
  }
  if (environment === 'production' && ['127.0.0.1', 'localhost'].includes(config.listenHost)) {
    warn('NETWORK_LOOPBACK', 'listenHost de produção está limitado ao loopback');
  }
  return findings;
}

function main(argv = process.argv.slice(2)) {
  const fileArg = argv.find((arg) => !arg.startsWith('--'));
  const envArg = argv.find((arg) => arg.startsWith('--environment='));
  if (!fileArg) {
    console.error('Uso: node check-server-config.js <server-settings.json> --environment=local|staging|production');
    return 2;
  }
  const environment = envArg ? envArg.split('=')[1] : 'production';
  const resolved = path.resolve(fileArg);
  let config;
  try {
    config = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  } catch (err) {
    console.error(`[config-doctor] CONFIG_READ: ${err.message}`);
    return 2;
  }
  const findings = validateServerConfig(config, { environment });
  for (const finding of findings) console.error(`[config-doctor] ${finding.level} ${finding.code}: ${finding.message}`);
  if (findings.some((finding) => finding.level === 'ERROR')) return 1;
  console.log(`[config-doctor] OK: ${resolved} (${environment})`);
  return 0;
}

if (require.main === module) process.exitCode = main();
module.exports = { main, validateServerConfig };
