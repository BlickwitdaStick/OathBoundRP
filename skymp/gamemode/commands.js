const db = require('./database');
const browserModal = require('./core/browser-modal');
const identity = require('./identity-service');
const { createRpChatService } = require('./rp-chat-service');
const commandRegistry = require('./core/command-registry');
const characterState = require('./core/character-state');
const characterNumbers = require('./core/character-numbers');

/** Command of a module that is switched off, or null (lazy: module-registry requires the world). */
function unavailableCommand(command) {
  try {
    return require('./core/module-registry').unavailableCommand(command);
  } catch {
    return null;
  }
}

// In-memory cache of the characters active on the server
// Key: actorId (number), Value: { characterId, firstName, lastName, accountId, profileId }
const activeCharacters = new Map();

function registerActiveCharacter(actorId, character, accountId, profileId) {
  activeCharacters.set(actorId, {
    characterId: character.id,
    firstName: character.first_name,
    lastName: character.last_name,
    accountId: accountId,
    profileId: profileId,
    charNumber: Number.isInteger(character.char_number) ? character.char_number : null
  });
  console.log(`[commands] Cached character name for actor ${actorId.toString(16)}: ${character.first_name} ${character.last_name}`);
  identity.loadKnownIdentities(character.id);
}

function getActiveCharacterData(actorId) {
  return activeCharacters.get(actorId) || null;
}

/**
 * actorIds with a loaded character, right now.
 *
 * `death-service` answers the same question by sweeping up to 50 profileIds with
 * `mp.getActorsByProfileId` — which costs one API call per profileId and also returns
 * whoever has no character. This map already knows the exact answer for free:
 * it is written on login and cleared in `removeActiveCharacter`.
 *
 * Returns a copy: whoever iterates must not hold a reference to the internal Map, which
 * is mutated by login and logout in the middle of any loop.
 */
function listActiveActorIds() {
  return [...activeCharacters.keys()];
}

/** Records the number assigned at login (core/character-numbers.js). */
function setCharacterNumber(actorId, charNumber) {
  const char = activeCharacters.get(actorId);
  if (char) char.charNumber = Number.isInteger(charNumber) ? charNumber : null;
}

/** Online actor holding character number `n`, or null. */
function getActorByCharacterNumber(n) {
  for (const [actorId, character] of activeCharacters.entries()) {
    if (character.charNumber === n) return actorId;
  }
  return null;
}

/** "#12" for display, or "#?" before a number is assigned. */
function formatCharacterNumber(actorId) {
  const char = activeCharacters.get(actorId);
  return char && char.charNumber ? `#${char.charNumber}` : '#?';
}

function getActiveActorByCharacterId(characterId) {
  for (const [actorId, character] of activeCharacters.entries()) {
    if (character.characterId === characterId) {
      return actorId;
    }
  }
  return null;
}

function removeActiveCharacter(actorId) {
  // Save where the character logged out, while it is still known here.
  if (typeof mp !== 'undefined' && activeCharacters.has(actorId)) {
    require('./core/position-persistence').getInstance().onDisconnect(actorId);
    require('./core/economy-physical-sync').getInstance().onDisconnect(actorId);
    const survival = require('./survival-service');
    if (survival.isOnline(actorId)) {
      survival.onDisconnect(actorId).catch((err) => console.error('[commands] Survival save at logout failed:', err.message));
    }
  }
  browserModal.forgetActor(actorId);
  if (activeCharacters.has(actorId)) {
    const char = activeCharacters.get(actorId);
    console.log(`[commands] Removed cached character for actor ${actorId.toString(16)}: ${char.firstName} ${char.lastName}`);
    identity.forgetKnownIdentities(char.characterId);
    characterState.cleanup(char.characterId);

    // admin-service's staffCache is keyed by actorId, not by account — and
    // SkyMP reuses actorIds across sessions. Without clearing it here, the role stayed
    // stuck to the slot: whoever later took the same actorId inherited `ban`,
    // `set_gold` and `retire_character` from an admin who had already left.
    // `registerStaffRole` is only called on login (whitelist.js), so nothing
    // rewrote the stale entry for a regular player.
    //
    // Lazy require for the same reason as the staff handlers below:
    // admin-service requires this module at the top, so importing it up there
    // would close the cycle.
    require('./admin-service').removeStaffRole(actorId);

    // Same class of problem, same reason for the lazy require
    // (death-service requires this module at the top): `_lastHealth` keeps the last
    // health reading per actorId, and the reused slot made the next player's first tick
    // become a fake `damage_spike` in the death context —
    // RDM evidence against someone who never took a hit. See the full
    // explanation in death-service.cleanup().
    require('./death-service').cleanup(actorId);

    // The cached soul is keyed by characterId, so it does not suffer from
    // slot reuse — but a cache that only grows is a leak, and rereading it on the
    // next login costs one query. Behind isEnabled because soul-service
    // throws at boot when SOUL_SECRET is missing: with the flag off, not even the
    // require happens.
    if (require('./core/module-registry').isEnabled('soul')) {
      require('./soul-service').cleanup(char.characterId);
    }

    activeCharacters.delete(actorId);

    // Subscribers registered by modules that may be turned off.
    //
    // The lazy `require`s above are the old way, and it works because
    // those five modules are either core or have `isEnabled` to check. A
    // `lab` module without that treatment — `trade` is the first — cannot go into
    // that list: `commands.js` would come to know by fixed name a service
    // the `module-registry` may not have turned on, which is the coupling
    // `governance-service` cites as the worst possible idea.
    //
    // Here the arrow is reversed, for the same reason as the Interaction Framework: whoever
    // needs to know about disconnects subscribes in `initialize()` and is removed in
    // `shutdown()`. `commands.js` does not know who they are.
    for (const assinante of _characterRemovedSubscribers) {
      try {
        assinante(actorId, char);
      } catch (err) {
        console.error('[commands] Disconnect subscriber failed:', err.message);
      }
    }
  }
}

/** @type {Set<(actorId: number, character: object) => void>} */
const _characterRemovedSubscribers = new Set();

/**
 * Subscribes to a character leaving. Returns the unsubscribe function.
 * @param {(actorId: number, character: object) => void} fn
 */
function onCharacterRemoved(fn) {
  if (typeof fn !== 'function') throw new Error('[commands] invalid subscriber');
  _characterRemovedSubscribers.add(fn);
  return () => _characterRemovedSubscribers.delete(fn);
}

function getCharacterName(actorId) {
  if (activeCharacters.has(actorId)) {
    const char = activeCharacters.get(actorId);
    return `${char.firstName} ${char.lastName}`;
  }
  return `Player_${actorId.toString(16)}`;
}

function getDisplayNameForObserver(sourceActorId, observerActorId) {
  const sourceCharacter = getActiveCharacterData(sourceActorId);
  const observerCharacter = getActiveCharacterData(observerActorId);
  return identity.getDisplayName(observerCharacter, sourceCharacter);
}

async function logRpChatEvent(event) {
  const details = JSON.stringify({
    type: event.type,
    actorId: `0x${event.actorId.toString(16)}`,
    characterId: event.characterId || null,
    message: event.message,
    radius: event.radius
  });

  try {
    await db.query(
      'INSERT INTO audit_logs (action, actor_account_id, target_account_id, details) VALUES (?, ?, ?, ?)',
      [`rp_chat:${event.type}`, event.accountId || null, null, details]
    );
  } catch (err) {
    console.log(`[rp-chat-log] ${details}`);
  }
}

// Sends a PRIVATE notification (only the actorId's own screen) through the
// browserModal channel (isVisibleByOwner=true, isVisibleByNeighbors=false — see
// phase0-basic.js). Before this it used the 'global' Debug.Notification, which the
// engine broadcasts to ALL connected clients — leaking criminal records,
// searched inventories and staff messages onto everyone's
// screen. Rendered as a toast by the UI (index.html: handleServerModal).
function sendNotification(actorId, message) {
  if (typeof mp === 'undefined') return;
  try {
    browserModal.pushModal(actorId, 'toast', { message });
  } catch (err) {
    console.error(`[commands] Failed to send notification to actor ${actorId.toString(16)}:`, err.message);
  }
}

/**
 * A binary-choice notification (accept/refuse), the same `browserModal` channel
 * the toast already uses — PLAYER_ACTION_SHORTCUTS_PLAN.md Phase 5. This file only
 * delivers the invitation for the CEF to draw the two buttons; what "accept" means
 * belongs to the caller (the payload's `acceptEvent`/`denyEvent` is the `uiEvent.type`
 * the CEF sends back on click, and registering a handler for
 * that prefix in `core/ui-event-router.js` is the job of the module that called this, never
 * `commands.js`).
 * @param {number} actorId
 * @param {{title: string, message: string, acceptLabel: string, denyLabel: string, acceptEvent: string, denyEvent: string, eventData?: object}} payload
 */
function sendChoice(actorId, payload) {
  if (typeof mp === 'undefined') return;
  try {
    browserModal.pushModal(actorId, 'choice', payload);
  } catch (err) {
    console.error(`[commands] Failed to send choice to actor ${actorId.toString(16)}:`, err.message);
  }
}

// Broadcasts the message to the author and neighbors within a proximity radius
function renderMessageForRecipient(message, recipientActorId) {
  return typeof message === 'function' ? message(recipientActorId) : message;
}

function broadcastProximityMessage(sourceActorId, message, radius = 1500) {
  const logMessage = typeof message === 'function' ? message(sourceActorId) : message;
  console.log(`[chat-log] Broadcast: "${logMessage}"`);
  
  // 1. Show it to the author themselves
  sendNotification(sourceActorId, renderMessageForRecipient(message, sourceActorId));

  if (typeof mp === 'undefined') return;

  // 2. Show it to the neighbors
  try {
    const neighbors = mp.get(sourceActorId, 'neighbors') || [];
    const sourceLoc = mp.get(sourceActorId, 'locationalData');
    if (!sourceLoc || !sourceLoc.pos) return;
    
    const sourcePos = sourceLoc.pos;
    const sourceCell = sourceLoc.cellOrWorldSpaceId || sourceLoc.cellId || sourceLoc.worldOrCell;

    for (const neighborId of neighbors) {
      if (mp.get(neighborId, 'type') === 'MpActor' && neighborId !== sourceActorId) {
        const neighborLoc = mp.get(neighborId, 'locationalData');
        if (neighborLoc && neighborLoc.pos) {
          const neighborCell = neighborLoc.cellOrWorldSpaceId || neighborLoc.cellId || neighborLoc.worldOrCell;
          if (sourceCell && neighborCell && sourceCell !== neighborCell) {
            continue;
          }

          const neighborPos = neighborLoc.pos;
          
          // 3D Euclidean distance
          const dx = sourcePos[0] - neighborPos[0];
          const dy = sourcePos[1] - neighborPos[1];
          const dz = sourcePos[2] - neighborPos[2];
          const distance = Math.sqrt(dx*dx + dy*dy + dz*dz);
          
          if (distance <= radius) {
            sendNotification(neighborId, renderMessageForRecipient(message, neighborId));
          }
        }
      }
    }
  } catch (err) {
    console.error(`[commands] Failed to broadcast message:`, err.message);
  }
}

const rpChat = createRpChatService({
  getCharacterName,
  getDisplayName: getDisplayNameForObserver,
  getCharacterData: getActiveCharacterData,
  sendNotification,
  broadcastProximityMessage,
  logEvent: logRpChatEvent
});

/** Last name of a character created on first login while the whitelist is off (whitelist.js). */
const UNNAMED_LAST_NAME = 'Unnamed';
const NAME_PART = /^[A-Za-z][A-Za-z'-]{0,31}$/;

/**
 * Checks a character name typed by a player: two parts (first, last), letters
 * with ' or -, each starting with a letter. Returns { first, last } or { error }.
 */
function parseRpName(words) {
  if (words.length !== 2) return { error: 'Give a first and a last name, e.g. /rpname Hrolf Stone-Fist.' };
  const [a, b] = words;
  if (!NAME_PART.test(a) || !NAME_PART.test(b)) return { error: 'Names use letters, \' and - only (up to 32 each).' };
  const cap = (w) => w.charAt(0).toUpperCase() + w.slice(1);
  if (cap(b) === UNNAMED_LAST_NAME) return { error: 'Pick a real last name.' };
  return { first: cap(a), last: cap(b) };
}

/**
 * /rpname First Last — a player names the character the server made for them
 * (only while it is still "Unnamed"). Staff: /rpname <player#> First Last, any time.
 */
async function handleRpNameCommand(actorId, args) {
  const words = String(args || '').trim().split(/\s+/).filter(Boolean);
  let target = actorId;
  if (words.length === 3 && /^#?\d+$/.test(words[0])) {
    if (!isStaff(actorId)) return sendNotification(actorId, 'Only staff can rename someone else.');
    target = getActorByCharacterNumber(Number(words[0].replace('#', '')));
    if (!target) return sendNotification(actorId, `Nobody online is #${words[0].replace('#', '')}.`);
    words.shift();
  }
  const character = activeCharacters.get(target);
  if (!character) return sendNotification(actorId, 'No character loaded.');
  if (target === actorId && character.lastName !== UNNAMED_LAST_NAME && !isStaff(actorId)) {
    return sendNotification(actorId, 'Your character already has a name. Ask staff if it must change.');
  }
  const name = parseRpName(words);
  if (name.error) return sendNotification(actorId, name.error);
  const db = require('./database');
  await db.query('UPDATE characters SET first_name = ?, last_name = ? WHERE id = ?', [name.first, name.last, character.characterId]);
  character.firstName = name.first;
  character.lastName = name.last;
  sendNotification(target, `Your character is now ${name.first} ${name.last}.`);
  if (target !== actorId) sendNotification(actorId, `Renamed to ${name.first} ${name.last}.`);
}

function parseActorId(raw) {
  if (!raw) return NaN;
  const normalized = raw.toLowerCase().startsWith('0x') ? raw.slice(2) : raw;
  return Number.parseInt(normalized, 16);
}

// ─────────────────────────────────────────────────────────────────────────────
// CORE commands (always active, regardless of modules)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Range of an introduction, in Skyrim units.
 *
 * The same as the `broadcastProximityMessage` that announces the scene right below, and
 * it has to stay that way: introducing yourself from a distance at which nobody reads
 * `* so-and-so introduces themselves` would be an introduction without a scene.
 */
const INTRODUCE_RANGE = 450;

async function handleIntroduceCommand(actorId, args) {
  const targetActorId = parseActorId(args);
  const sourceCharacter = getActiveCharacterData(actorId);
  const targetCharacter = getActiveCharacterData(targetActorId);

  if (!sourceCharacter) {
    sendNotification(actorId, 'Your character is not loaded yet.');
    return;
  }
  if (!targetCharacter || targetActorId === actorId) {
    sendNotification(actorId, 'Usage: /introduce <player#> (someone else, online)');
    return;
  }

  const realName = identity.getCharacterFullName(sourceCharacter);
  await identity.upsertKnownIdentity(
    targetCharacter.characterId,
    sourceCharacter.characterId,
    realName,
    'introduced'
  );
  await identity.auditIdentityEvent(
    sourceCharacter.accountId,
    targetCharacter.accountId,
    'identity:introduce',
    `sourceCharacterId=${sourceCharacter.characterId} targetCharacterId=${targetCharacter.characterId}`
  );

  sendNotification(actorId, `You introduced yourself to ${getDisplayNameForObserver(targetActorId, actorId)}.`);
  sendNotification(targetActorId, `${realName} introduced themselves to you.`);
  broadcastProximityMessage(
    actorId,
    (observerActorId) => `* ${getDisplayNameForObserver(actorId, observerActorId)} introduces themselves.`,
    INTRODUCE_RANGE
  );
}

async function handleAliasCommand(actorId, args) {
  const parts = args.split(' ');
  const targetActorId = parseActorId(parts[0]);
  const alias = identity.sanitizeDisplayName(parts.slice(1).join(' '));
  const sourceCharacter = getActiveCharacterData(actorId);
  const targetCharacter = getActiveCharacterData(targetActorId);

  if (!sourceCharacter || !targetCharacter || targetActorId === actorId || !alias) {
    sendNotification(actorId, 'Usage: /alias <player#> <name you know them by>');
    return;
  }

  await identity.upsertKnownIdentity(
    sourceCharacter.characterId,
    targetCharacter.characterId,
    alias,
    'alias'
  );
  await identity.auditIdentityEvent(
    sourceCharacter.accountId,
    targetCharacter.accountId,
    'identity:alias',
    `observerCharacterId=${sourceCharacter.characterId} targetCharacterId=${targetCharacter.characterId} alias=${alias}`
  );

  sendNotification(actorId, `You will now recognize this person as: ${alias}.`);
}

/**
 * `identity.introduce` in the Interaction Framework.
 *
 * ─── Why this interaction exists ────────────────────────────────────────────
 *
 * Until 2026-08-13 "Introduce yourself" was a button the **CEF** made up:
 * `DEFAULT_INTERACTION_SECTIONS` in `skymp/ui/index.html` added three
 * actions to the server's, unconditionally, for every target. Two of them were
 * dead buttons (`/trade` and `/groupinvite`, which did not exist) and were removed;
 * this was the only live one, and it was still an action that showed up without the
 * server having authorized anything.
 *
 * By registering it here, the menu list comes **entirely** from the server — which
 * is the condition for `canSee` to mean anything. See
 * `docs/research/CORE_FRAMEWORK_AUDIT.md` §7.
 *
 * ─── What `canSee` hides, and why ───────────────────────────────────────────
 *
 * The action disappears when the target **already knows** the character. Introducing yourself twice
 * is neither an error nor an exploit — `upsertKnownIdentity` is idempotent —, but it is
 * a button that does nothing, and an RP menu that offers empty gestures teaches the
 * player to ignore it.
 *
 * The range is the same as the `broadcastProximityMessage` the command already uses to
 * announce the scene (450). Both numbers must be the same: introducing yourself from
 * a distance at which nobody sees `* so-and-so introduces themselves` would be an
 * introduction without a scene.
 */
function registerIdentityInteractions() {
  const interactionRegistry = require('./core/interaction-registry');

  interactionRegistry.unregisterModule('identity');

  interactionRegistry.register({
    id: 'identity.introduce',
    module: 'identity',
    target: interactionRegistry.TARGET_TYPES.PLAYER,
    section: 'social',
    label: 'Introduce yourself',
    order: 10,
    distance: INTRODUCE_RANGE,
    // Introducing yourself is speech: whoever is restrained, downed or dead does not do it.
    // `action-policy` already answers that through the `introduce` action, registered there
    // since forever — reusing it is what avoids a second state table.
    policyAction: 'introduce',
    audit: interactionRegistry.AUDIT_LEVELS.TRACE,
    // Synchronous and free: reads the observer's in-memory cache, loaded at their
    // login. A `canSee` that went to the DB would cost one query per action
    // per aim — exactly what §22 of the request says not to do.
    canSee: ctx => !identity.getKnownDisplayName(ctx.target.characterId, ctx.characterId),
    execute: async ctx => {
      await handleIntroduceCommand(ctx.actorId, `0x${ctx.target.actorId.toString(16)}`);
      return { message: null };
    }
  });
}

// Staff commands (CORE — available regardless of modules)
function registerCoreCommands() {
  registerIdentityInteractions();

  commandRegistry.register(['/introduce', '/apresentar'], (actorId, args) => {
    handleIntroduceCommand(actorId, args).catch(err => {
      console.error('[identity] Failed to introduce character:', err.message);
      sendNotification(actorId, 'Could not record the introduction.');
    });
  }, {
    module: 'identity', phase: 'core',
    description: 'Introduce your character to someone', usage: '/introduce <player#>',
    // Tarefa 11 (Legacy Command Cleanup): redundante desde que virou
    // `identity.introduce` no Interaction Framework (linha 352 deste
    // arquivo) — some do menu de interação quando o alvo já conhece o
    // personagem, e o prompt `[E]` chega no mesmo lugar. O comando continua
    // registrado (fallback de rede ruim/staff), só não aparece num /help
    // futuro que passe `playerFacing: true`.
    hidden: true
  });

  commandRegistry.register(['/alias', '/apelido'], (actorId, args) => {
    handleAliasCommand(actorId, args).catch(err => {
      console.error('[identity] Failed to set alias:', err.message);
      sendNotification(actorId, 'Could not save the nickname.');
    });
  }, { module: 'identity', phase: 'core', description: 'Set the name you know someone by', usage: '/alias <player#> <name>' });

  commandRegistry.register('/rpname', (actorId, args) => {
    handleRpNameCommand(actorId, args).catch((err) => {
      console.error('[identity] /rpname failed:', err.message);
      sendNotification(actorId, 'Could not save the name.');
    });
  }, { module: 'identity', phase: 'core', description: 'Name your new character (once); staff can rename anyone', usage: '/rpname <First> <Last>  ·  staff: /rpname <player#> <First> <Last>' });

  commandRegistry.register('/anim', (actorId, args) => {
    if (args) {
      const parts = args.split(' ');
      const adminService = require('./admin-service');
      adminService.playAnimation(actorId, parseInt(parts[0], 16), parts[1] || 'IdleStop');
    }
  }, { module: 'admin', phase: 'core', description: '[Staff] Play an animation on an actor', usage: '/anim <player#> <animName>' });

  commandRegistry.register('/additem', (actorId, args) => {
    if (args) {
      const parts = args.split(' ');
      require('./admin-service').giveItemAdmin(actorId, parseInt(parts[0], 16), parseInt(parts[1], 16), parseInt(parts[2]) || 1);
    }
  }, { module: 'admin', phase: 'core', description: '[Staff] Give an item to a player', usage: '/additem <player#> <baseId> <count>' });

  commandRegistry.register('/clearitem', (actorId, args) => {
    if (args) {
      const parts = args.split(' ');
      require('./admin-service').clearItemAdmin(actorId, parseInt(parts[0], 16), parseInt(parts[1], 16)).catch((err) => {
        console.error('[admin] /clearitem failed:', err.message);
        sendNotification(actorId, '[Staff] Could not clear the item.');
      });
    }
  }, { module: 'admin', phase: 'core', description: '[Staff] Remove every copy of an item from a player (items that keep coming back)', usage: '/clearitem <player#> <baseId>' });

  commandRegistry.register('/tp', (actorId, args) => {
    if (args) require('./admin-service').teleportTo(actorId, parseInt(args, 16));
  }, { module: 'admin', phase: 'core', description: '[Staff] Teleport to a player', usage: '/tp <player#>' });

  commandRegistry.register('/kick', (actorId, args) => {
    if (args) {
      const parts = args.split(' ');
      const reason = parts.slice(1).join(' ') || 'No reason given';
      require('./admin-service').kickPlayer(actorId, parseInt(parts[0], 16), reason);
    }
  }, { module: 'admin', phase: 'core', description: '[Staff] Kick a player', usage: '/kick <player#> [reason]' });

  commandRegistry.register('/permakill', (actorId, args) => {
    if (args) {
      const parts = args.split(' ');
      const reason = parts.slice(1).join(' ');
      require('./admin-service').retireCharacter(actorId, parseInt(parts[0], 16), reason);
    }
  }, { module: 'admin', phase: 'core', description: '[Staff] Retire a character permanently (soft-delete)', usage: '/permakill <player#> <reason>' });

  commandRegistry.register('/setgold', (actorId, args) => {
    if (args) {
      const parts = args.split(' ');
      require('./admin-service').setGold(actorId, parseInt(parts[0], 16), parseInt(parts[1]));
    }
  }, { module: 'admin', phase: 'core', description: '[Staff] Set a player\'s gold', usage: '/setgold <player#> <amount>' });

  // Alias técnico em inglês pelo mesmo padrão de /apresentar → /introduce.
  // `parseActorId` (e não `parseInt(args, 16)` como os outros de staff) porque
  // este é o comando que a staff digita copiando um id de um log ou do painel,
  // onde ele aparece com o prefixo `0x`.
  commandRegistry.register(['/revealidentity', '/revelaridentidade'], (actorId, args) => {
    const targetActorId = parseActorId(args);
    if (!Number.isFinite(targetActorId)) {
      sendNotification(actorId, 'Usage: /revealidentity <player#>');
      return;
    }
    require('./admin-service').revealIdentity(actorId, targetActorId).catch(err => {
      console.error('[identity] Falha ao revelar identidade:', err.message);
      sendNotification(actorId, '[Staff] Could not reveal the identity.');
    });
  }, { module: 'admin', phase: 'core', description: '[Staff] Reveal a character\'s real name (audited)', usage: '/revealidentity <player#>' });

  // /status — character state diagnostics (staff)
  commandRegistry.register('/status', (actorId, args) => {
    const charData = getActiveCharacterData(actorId);
    if (!charData) return;
    const state = characterState.get(charData.characterId);
    const meta = characterState.getMetadata(charData.characterId);
    sendNotification(actorId, `[Staff] ${formatCharacterNumber(actorId)} | State: ${state} | ${JSON.stringify(meta)} | actorId 0x${actorId.toString(16)}`);
  }, { module: 'admin', phase: 'core', description: '[Staff] Show your character number, state and actorId', usage: '/status' });

  // /whoami — your own character number.
  commandRegistry.register(['/whoami', '/id'], (actorId) => {
    const char = getActiveCharacterData(actorId);
    if (!char) { sendNotification(actorId, 'Your character is not loaded yet.'); return; }
    sendNotification(actorId, `You are ${char.firstName} ${char.lastName}, character ${formatCharacterNumber(actorId)}.`);
  }, { module: 'identity', phase: 'core', description: 'Show your character number', usage: '/whoami' });

  // /nearby — who is around you, with the numbers commands take.
  commandRegistry.register(['/nearby', '/players'], (actorId) => {
    sendNotification(actorId, describeNearby(actorId));
  }, { module: 'identity', phase: 'core', description: 'List people near you with their character numbers', usage: '/nearby' });
}

/** Radius for /nearby, in game units (about one city block). */
const NEARBY_RADIUS = 3000;

/**
 * People near `actorId`, closest first, as "#12 Name (8m)". Names respect who
 * the observer knows: strangers show as "Stranger" but still have a number, so
 * you can /introduce yourself or /trade with someone whose name you don't know.
 */
function describeNearby(actorId) {
  if (typeof mp === 'undefined') return 'Nobody nearby.';
  const self = mp.get(actorId, 'locationalData');
  if (!self || !self.pos) return 'Your position is not known yet.';
  const people = [];
  for (const otherId of activeCharacters.keys()) {
    if (otherId === actorId) continue;
    const loc = mp.get(otherId, 'locationalData');
    if (!loc || !loc.pos) continue;
    const cellOf = (l) => l.cellOrWorldDesc || l.cellOrWorldSpaceId || l.cellId || null;
    const sameCell = cellOf(loc) === cellOf(self);
    if (!sameCell) continue;
    const d = Math.hypot(loc.pos[0] - self.pos[0], loc.pos[1] - self.pos[1], loc.pos[2] - self.pos[2]);
    if (d > NEARBY_RADIUS) continue;
    people.push({ d, label: `${formatCharacterNumber(otherId)} ${getDisplayNameForObserver(otherId, actorId)} (${Math.round(d / 70)}m)` });
  }
  if (people.length === 0) return 'Nobody nearby.';
  people.sort((a, b) => a.d - b.d);
  return `Nearby: ${people.map((p) => p.label).join('  ·  ')}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main chat input handler
// ─────────────────────────────────────────────────────────────────────────────

/** Chat-service commands, listed by /help (they don't live in the registry). */
const CHAT_HELP = [
  '/me <action>', '/do <description>', '/s <message> (whisper)', '/g <message> (shout)',
  '/ooc <message>', '/roll [2-100]', '/try <action>', '/report <reason>'
];

function isStaff(actorId) {
  try {
    return Boolean(require('./admin-service').getRole(actorId));
  } catch {
    return false;
  }
}

/**
 * /help: chat commands, then every registered player-facing command. Staff
 * commands ([Staff] in the description) only for staff.
 */
function sendHelp(actorId) {
  const staff = isStaff(actorId);
  const seen = new Set();
  const registered = commandRegistry.list({ playerFacing: true })
    .filter((c) => staff || !/^\[staff\]/i.test(c.description))
    .filter((c) => { const key = c.usage; if (seen.has(key)) return false; seen.add(key); return true; })
    .map((c) => c.usage)
    .sort();
  sendNotification(actorId, `Chat: ${CHAT_HELP.join('  ·  ')}`);
  if (registered.length) {
    sendNotification(actorId, `${staff ? 'Commands (incl. staff)' : 'Commands'}: ${registered.join('  ·  ')}`);
  }
}

/** True when a usage string declares a required argument, e.g. `/tp <actorId>`. */
function needsArguments(usage) {
  return typeof usage === 'string' && /<[^>]+>/.test(usage);
}

function handleChatInput(actorId, text) {
  if (!text || typeof text !== 'string') return;

  const trimmed = text.trim();
  const firstWord = trimmed.split(/\s+/)[0].toLowerCase();
  if (firstWord === '/help' || firstWord === '/commands' || firstWord === '/?') {
    sendHelp(actorId);
    return;
  }

  // 1. Tentar o rp-chat-service (comandos /falar, /me, /do, etc.)
  if (rpChat.handleChatInput(actorId, text)) {
    return;
  }

  // 2. Tentar o command-registry (comandos de módulos)
  if (trimmed.startsWith('/')) {
    const parts = trimmed.split(/\s+/);
    const command = parts[0].toLowerCase();
    const args = parts.slice(1).join(' ');

    // A command typed without the arguments it needs used to do nothing at all
    // (most staff handlers start with `if (args)`): answer with its usage.
    const entry = commandRegistry.list().find((c) => c.command === command);
    if (entry && !args && needsArguments(entry.usage)) {
      sendNotification(actorId, `Usage: ${entry.usage}${entry.description ? ` — ${entry.description}` : ''}`);
      return;
    }

    // Player slots (`<player#>`) take a character number: `/tp 12`, `/trade #12`.
    // Handlers still receive an actorId, so none of them had to change.
    let dispatchArgs = args;
    if (entry) {
      const resolved = characterNumbers.resolveTargetArgs(entry.usage, args, getActorByCharacterNumber);
      if (resolved.error) {
        sendNotification(actorId, resolved.error);
        return;
      }
      dispatchArgs = resolved.args;
    }

    const handled = commandRegistry.dispatch(actorId, command, dispatchArgs);
    if (!handled) {
      const off = unavailableCommand(command);
      sendNotification(actorId, off
        ? `${command} is part of "${off.module}", which is turned off on this server (${off.enabledBy}).`
        : `Unknown command: ${command}. Type /help for the list.`);
    }
    return;
  }

  // 3. Default chat (local speech)
  const charName = getCharacterName(actorId);
  broadcastProximityMessage(actorId, `${charName} says: ${text}`, 1200);
}

// Register the CORE commands when the module loads
registerCoreCommands();

module.exports = {
  registerActiveCharacter,
  removeActiveCharacter,
  getActiveCharacterData,

  // An alias of `getActiveCharacterData`, not decoration: `phase0-basic.js`
  // passes `commands.getCharacterData` to `createTargetResolvers` and to
  // `createInteractionService` since 2026-08-13, and the name was never on this
  // object. `createTargetResolvers` throws when it receives `undefined`, and the
  // throw happens in the module body — meaning **the server did not start**,
  // and no test caught it because none of them loads `phase0-basic.js`.
  //
  // The alias, and not a rename: `getActiveCharacterData` is the name used by
  // a dozen callers and several tests, and the core prefers `getCharacter`
  // because for it there is no "active" — there is "the server knows who it is".
  getCharacterData: getActiveCharacterData,

  getActiveActorByCharacterId,
  setCharacterNumber,
  getActorByCharacterNumber,
  formatCharacterNumber,
  parseRpName,
  UNNAMED_LAST_NAME,
  listActiveActorIds,
  handleChatInput,
  broadcastProximityMessage,
  sendNotification,
  sendChoice,
  onCharacterRemoved,
  // look-keys-service.js: I = introduce, names on the group compass.
  handleIntroduceCommand,
  getDisplayNameForObserver
};
