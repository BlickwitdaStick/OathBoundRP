const DEFAULT_LIMITS = {
  maxLength: 240,
  // Anti-flood window, configurable in `chat.oocRateLimitSeconds`. The option's
  // name mentions OOC, but the limiter applies to every channel — whoever
  // tunes it is regulating the message pace in general.
  get windowMs() { return serverOptions.get('chat.oocRateLimitSeconds') * 1000 * 2; },
  maxMessagesPerWindow: 5,
  reportCooldownMs: 60000
};

// Radii live in core/proximity-ranges.js so chat and voice do not diverge.
const { RANGES } = require('./core/proximity-ranges');
const serverOptions = require('./core/server-options');

function createRpChatService(options) {
  const limits = Object.assign({}, DEFAULT_LIMITS, options && options.limits);
  const history = new Map();
  const reportCooldown = new Map();

  function now() {
    return options && options.now ? options.now() : Date.now();
  }

  function random() {
    return options && options.random ? options.random() : Math.random();
  }

  function cleanText(text) {
    if (typeof text !== 'string') return '';
    return text
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, limits.maxLength);
  }

  function getCharacterName(actorId, observerActorId) {
    if (observerActorId && options.getDisplayName) {
      return options.getDisplayName(actorId, observerActorId);
    }
    return options.getCharacterName(actorId);
  }

  function getCharacterData(actorId) {
    return options.getCharacterData ? options.getCharacterData(actorId) : null;
  }

  function sendNotification(actorId, message) {
    options.sendNotification(actorId, message);
  }

  function broadcast(actorId, messageOrFactory, radius) {
    options.broadcastProximityMessage(actorId, messageOrFactory, radius);
  }

  function logEvent(actorId, type, message, radius) {
    if (!options.logEvent) return;
    const charData = getCharacterData(actorId);
    Promise.resolve(options.logEvent({
      actorId,
      type,
      message,
      radius,
      characterId: charData && charData.characterId,
      accountId: charData && charData.accountId
    })).catch((err) => {
      console.error('[rp-chat] Failed to log chat event:', err.message);
    });
  }

  function isRateLimited(actorId) {
    const current = now();
    const previous = history.get(actorId) || [];
    const recent = previous.filter((timestamp) => current - timestamp < limits.windowMs);
    if (recent.length >= limits.maxMessagesPerWindow) {
      history.set(actorId, recent);
      return true;
    }
    recent.push(current);
    history.set(actorId, recent);
    return false;
  }

  function canSendReport(actorId) {
    const current = now();
    const lastReport = reportCooldown.get(actorId) || 0;
    if (lastReport && current - lastReport < limits.reportCooldownMs) {
      return false;
    }
    reportCooldown.set(actorId, current);
    return true;
  }

  function parseInput(text) {
    const cleaned = cleanText(text);
    if (!cleaned) {
      return { handled: true, error: null };
    }
    if (!cleaned.startsWith('/')) {
      return { handled: true, command: 'say', args: cleaned };
    }

    const firstSpace = cleaned.indexOf(' ');
    const command = firstSpace === -1 ? cleaned.toLowerCase() : cleaned.slice(0, firstSpace).toLowerCase();
    const args = firstSpace === -1 ? '' : cleaned.slice(firstSpace + 1).trim();
    return { handled: false, command, args };
  }

  function requireArgs(actorId, args, usage) {
    if (args) return true;
    sendNotification(actorId, `Usage: ${usage}`);
    return false;
  }

  function handleRoll(actorId, args) {
    let max = 20;
    if (args) {
      const parsed = Number.parseInt(args, 10);
      if (!Number.isInteger(parsed) || parsed < 2 || parsed > 100) {
        sendNotification(actorId, 'Usage: /roll [2-100]');
        return true;
      }
      max = parsed;
    }

    const result = Math.floor(random() * max) + 1;
    const message = (observerActorId) => `* ${getCharacterName(actorId, observerActorId)} rolled a d${max} and got ${result}`;
    broadcast(actorId, message, RANGES.emote);
    logEvent(actorId, 'roll', message(actorId), RANGES.emote);
    return true;
  }

  function handleTry(actorId, args) {
    if (!requireArgs(actorId, args, '/try <action>')) return true;
    const success = random() >= 0.5;
    const result = success ? 'succeeds' : 'fails';
    const message = (observerActorId) => `* ${getCharacterName(actorId, observerActorId)} tries to ${args.replace(/^to\s+/i, '')} and ${result}.`;
    broadcast(actorId, message, RANGES.emote);
    logEvent(actorId, 'try', message(actorId), RANGES.emote);
    return true;
  }

  function handleReport(actorId, args) {
    if (!requireArgs(actorId, args, '/report <reason>')) return true;
    if (!canSendReport(actorId)) {
      sendNotification(actorId, 'Please wait before sending another report.');
      return true;
    }

    const charName = getCharacterName(actorId, actorId);
    const message = `[REPORT] ${charName}: ${args}`;
    sendNotification(actorId, 'Report sent to staff.');
    console.log(`[rp-chat] ${message}`);
    logEvent(actorId, 'report', message, 0);
    return true;
  }

  function handleHelp(actorId) {
    sendNotification(actorId, 'Chat: /me /do /s (whisper) /g (shout) /ooc /roll /try /report — /help for everything');
    return true;
  }

  function handleChatInput(actorId, text) {
    const parsed = parseInput(text);
    if (parsed.error) return true;
    if (!parsed.command) return true;

    const command = parsed.command;
    const args = parsed.args || '';

    const rpCommands = new Set([
      'say', '/me', '/do', '/ooc', '/b', '/s', '/sussurrar', '/g', '/gritar',
      '/roll', '/try', '/report', '/rphelp', '/ajuda',
      '/whisper', '/shout'
    ]);

    if (!rpCommands.has(command)) {
      return false;
    }

    if (command !== '/report' && isRateLimited(actorId)) {
      sendNotification(actorId, "You're sending messages too fast. Wait a few seconds.");
      return true;
    }

    switch (command) {
      case 'say': {
        const message = (observerActorId) => `${getCharacterName(actorId, observerActorId)} says: ${args}`;
        broadcast(actorId, message, RANGES.say);
        logEvent(actorId, 'say', message(actorId), RANGES.say);
        return true;
      }
      case '/me': {
        if (!requireArgs(actorId, args, '/me <action>')) return true;
        const message = (observerActorId) => `* ${getCharacterName(actorId, observerActorId)} ${args}`;
        broadcast(actorId, message, RANGES.emote);
        logEvent(actorId, 'me', message(actorId), RANGES.emote);
        return true;
      }
      case '/do': {
        if (!requireArgs(actorId, args, '/do <description>')) return true;
        const message = (observerActorId) => `* ${args} (( ${getCharacterName(actorId, observerActorId)} ))`;
        broadcast(actorId, message, RANGES.emote);
        logEvent(actorId, 'do', message(actorId), RANGES.emote);
        return true;
      }
      case '/ooc':
      case '/b': {
        // `chat.oocEnabled=false` turns off the out-of-character channel. Some
        // Heavy RP servers close in-game OOC on purpose, to push
        // out-of-character conversation to Discord and keep the scene clean.
        if (!serverOptions.get('chat.oocEnabled')) {
          sendNotification(actorId, 'OOC chat is disabled on this server. Use Discord.');
          return true;
        }
        if (!requireArgs(actorId, args, `${command} <message>`)) return true;
        const message = (observerActorId) => `(( OOC: ${getCharacterName(actorId, observerActorId)}: ${args} ))`;
        broadcast(actorId, message, RANGES.ooc);
        logEvent(actorId, 'ooc', message(actorId), RANGES.ooc);
        return true;
      }
      case '/s':
      case '/whisper':
      case '/sussurrar': {
        if (!requireArgs(actorId, args, `${command} <message>`)) return true;
        const message = (observerActorId) => `${getCharacterName(actorId, observerActorId)} whispers: ${args}`;
        broadcast(actorId, message, RANGES.whisper);
        logEvent(actorId, 'whisper', message(actorId), RANGES.whisper);
        return true;
      }
      case '/g':
      case '/shout':
      case '/gritar': {
        if (!requireArgs(actorId, args, `${command} <message>`)) return true;
        const message = (observerActorId) => `${getCharacterName(actorId, observerActorId)} shouts: ${args}`;
        broadcast(actorId, message, RANGES.shout);
        logEvent(actorId, 'shout', message(actorId), RANGES.shout);
        return true;
      }
      case '/roll':
        return handleRoll(actorId, args);
      case '/try':
        return handleTry(actorId, args);
      case '/report':
        return handleReport(actorId, args);
      case '/rphelp':
      case '/help':
      case '/ajuda':
        return handleHelp(actorId);
      default:
        return false;
    }
  }

  return {
    cleanText,
    parseInput,
    handleChatInput
  };
}

module.exports = {
  RANGES,
  createRpChatService
};
