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

// Cache em memoria dos personagens ativos no servidor
// Chave: actorId (number), Valor: { characterId, firstName, lastName, accountId, profileId }
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
 * actorIds com personagem carregado, agora.
 *
 * O `death-service` responde a mesma pergunta varrendo até 50 profileIds com
 * `mp.getActorsByProfileId` — o que custa uma ida à API por profileId e devolve
 * também quem não tem personagem. Este mapa já sabe a resposta exata e de graça:
 * ele é escrito no login e limpo no `removeActiveCharacter`.
 *
 * Devolve cópia: quem itera não pode segurar referência para o Map interno, que
 * é mutado por login e logout no meio de qualquer laço.
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

    // O staffCache do admin-service e chaveado por actorId, nao por conta — e o
    // SkyMP reaproveita actorId entre sessoes. Sem limpar aqui, o cargo ficava
    // preso ao slot: quem entrasse depois no mesmo actorId herdava `ban`,
    // `set_gold` e `retire_character` de um admin que ja tinha saido.
    // `registerStaffRole` so e chamado no login (whitelist.js), entao nada
    // reescrevia a entrada obsoleta pra um jogador comum.
    //
    // require preguicoso pelo mesmo motivo dos handlers de staff abaixo:
    // admin-service requer este modulo no topo, entao importar la em cima
    // fecharia o ciclo.
    require('./admin-service').removeStaffRole(actorId);

    // Mesma classe de problema, mesmo motivo de require preguicoso
    // (death-service requer este modulo no topo): `_lastHealth` guarda a ultima
    // leitura de vida por actorId, e o slot reaproveitado fazia o primeiro tick
    // do jogador seguinte virar um `damage_spike` falso no contexto de morte —
    // evidencia de RDM contra quem nao levou golpe nenhum. Ver a explicacao
    // completa em death-service.cleanup().
    require('./death-service').cleanup(actorId);

    // A alma em cache e chaveada por characterId, entao nao sofre do
    // reaproveitamento de slot — mas cache que so cresce e vazamento, e reler no
    // proximo login custa uma query. Atras do isEnabled porque o soul-service
    // lanca no boot quando falta SOUL_SECRET: com a flag desligada, nem o
    // require acontece.
    if (require('./core/module-registry').isEnabled('soul')) {
      require('./soul-service').cleanup(char.characterId);
    }

    activeCharacters.delete(actorId);

    // Assinantes registrados por módulos que podem estar desligados.
    //
    // Os `require` preguiçosos acima são a forma antiga, e ela funciona porque
    // aqueles cinco módulos ou são core ou têm `isEnabled` para consultar. Um
    // módulo `lab` sem esse tratamento — `trade` é o primeiro — não pode entrar
    // naquela lista: `commands.js` passaria a conhecer por nome fixo um serviço
    // que o `module-registry` talvez não tenha ligado, que é o acoplamento que
    // o `governance-service` cita como a pior ideia possível.
    //
    // Aqui a seta se inverte, pelo mesmo motivo do Interaction Framework: quem
    // precisa saber da desconexão assina no `initialize()` e é removido no
    // `shutdown()`. `commands.js` não sabe quem são.
    for (const assinante of _characterRemovedSubscribers) {
      try {
        assinante(actorId, char);
      } catch (err) {
        console.error('[commands] Assinante de desconexao falhou:', err.message);
      }
    }
  }
}

/** @type {Set<(actorId: number, character: object) => void>} */
const _characterRemovedSubscribers = new Set();

/**
 * Assina a saída de um personagem. Devolve a função de cancelamento.
 * @param {(actorId: number, character: object) => void} fn
 */
function onCharacterRemoved(fn) {
  if (typeof fn !== 'function') throw new Error('[commands] assinante invalido');
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

// Envia uma notificação PRIVADA (só a tela do próprio actorId) via o canal
// browserModal (isVisibleByOwner=true, isVisibleByNeighbors=false — ver
// phase0-basic.js). Antes disso usava Debug.Notification 'global', que a
// engine transmite pra TODOS os clientes conectados — vazando ficha
// criminal, inventário revistado e mensagens de staff pra tela de todo
// mundo. Renderizado como toast pela UI (index.html: handleServerModal).
function sendNotification(actorId, message) {
  if (typeof mp === 'undefined') return;
  try {
    browserModal.pushModal(actorId, 'toast', { message });
  } catch (err) {
    console.error(`[commands] Failed to send notification to actor ${actorId.toString(16)}:`, err.message);
  }
}

/**
 * Notificação de escolha binária (aceitar/recusar), mesmo canal `browserModal`
 * que o toast já usa — PLAYER_ACTION_SHORTCUTS_PLAN.md Fase 5. Este arquivo só
 * entrega o convite pra CEF desenhar os dois botões; o que "aceitar" significa
 * é de quem chamou (o `acceptEvent`/`denyEvent` do payload é o `uiEvent.type`
 * que a CEF manda de volta ao clicar, e o dono de registrar um handler pra
 * esse prefixo no `core/ui-event-router.js` é o módulo que chamou isto, nunca
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

// Transmite a mensagem para o autor e vizinhos dentro de um raio de proximidade
function renderMessageForRecipient(message, recipientActorId) {
  return typeof message === 'function' ? message(recipientActorId) : message;
}

function broadcastProximityMessage(sourceActorId, message, radius = 1500) {
  const logMessage = typeof message === 'function' ? message(sourceActorId) : message;
  console.log(`[chat-log] Broadcast: "${logMessage}"`);
  
  // 1. Mostrar para o próprio autor
  sendNotification(sourceActorId, renderMessageForRecipient(message, sourceActorId));

  if (typeof mp === 'undefined') return;

  // 2. Mostrar para os vizinhos
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
          
          // Distância Euclidiana 3D
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

function parseActorId(raw) {
  if (!raw) return NaN;
  const normalized = raw.toLowerCase().startsWith('0x') ? raw.slice(2) : raw;
  return Number.parseInt(normalized, 16);
}

// ─────────────────────────────────────────────────────────────────────────────
// Comandos CORE (sempre ativos, independente de módulos)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Alcance de uma apresentacao, em unidades do Skyrim.
 *
 * O mesmo do `broadcastProximityMessage` que anuncia a cena logo abaixo, e
 * precisa continuar sendo: apresentar-se de uma distancia em que ninguem le o
 * `* fulano se apresenta` seria uma apresentacao sem cena.
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
 * `identity.introduce` no Interaction Framework.
 *
 * ─── Por que esta interação existe ──────────────────────────────────────────
 *
 * Até 13/08/2026 "Apresentar-se" era um botão que a **CEF** inventava:
 * `DEFAULT_INTERACTION_SECTIONS` em `skymp/ui/index.html` acrescentava três
 * ações às do servidor, incondicionalmente, para todo alvo. Duas delas eram
 * botões mortos (`/trade` e `/groupinvite`, que não existem) e foram removidas;
 * esta era a única viva, e continuava sendo uma ação que aparecia sem o
 * servidor ter autorizado nada.
 *
 * Registrando-a aqui, a lista do menu passa a vir **inteira** do servidor — que
 * é a condição para o `canSee` significar alguma coisa. Ver
 * `docs/research/CORE_FRAMEWORK_AUDIT.md` §7.
 *
 * ─── O que o `canSee` esconde, e por quê ────────────────────────────────────
 *
 * A ação some quando o alvo **já conhece** o personagem. Apresentar-se duas
 * vezes não é erro nem exploit — `upsertKnownIdentity` é idempotente —, mas é
 * um botão que não faz nada, e um menu de RP que oferece gestos vazios ensina o
 * jogador a ignorá-lo.
 *
 * O alcance é o mesmo do `broadcastProximityMessage` que o comando já usa para
 * anunciar a cena (450). Os dois números precisam ser o mesmo: apresentar-se de
 * uma distância em que ninguém vê o `* fulano se apresenta` seria uma
 * apresentação sem cena.
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
    // Apresentar-se é fala: quem está algemado, abatido ou morto não o faz.
    // A `action-policy` já responde isso pela ação `introduce`, registrada lá
    // desde sempre — reusar é o que evita uma segunda tabela de estados.
    policyAction: 'introduce',
    audit: interactionRegistry.AUDIT_LEVELS.TRACE,
    // Sincrono e de graca: le o cache em memoria do observador, carregado no
    // login dele. Um `canSee` que fosse ao banco custaria uma query por acao
    // por mira — exatamente o que o §22 do pedido manda nao fazer.
    canSee: ctx => !identity.getKnownDisplayName(ctx.target.characterId, ctx.characterId),
    execute: async ctx => {
      await handleIntroduceCommand(ctx.actorId, `0x${ctx.target.actorId.toString(16)}`);
      return { message: null };
    }
  });
}

// Comandos de Staff (CORE — disponíveis independente de módulos)
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

  // /status — diagnóstico de estado do personagem (staff)
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
// Handler principal de input do chat
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

  // 3. Chat padrão (falar no local)
  const charName = getCharacterName(actorId);
  broadcastProximityMessage(actorId, `${charName} says: ${text}`, 1200);
}

// Registrar comandos CORE ao carregar o módulo
registerCoreCommands();

module.exports = {
  registerActiveCharacter,
  removeActiveCharacter,
  getActiveCharacterData,

  // Apelido de `getActiveCharacterData`, e não decoração: `phase0-basic.js`
  // passa `commands.getCharacterData` para `createTargetResolvers` e para
  // `createInteractionService` desde 13/08/2026, e o nome nunca esteve neste
  // objeto. `createTargetResolvers` lança quando o recebe `undefined`, e o
  // lançamento acontece no corpo do módulo — ou seja, **o servidor não subia**,
  // e nenhum teste pegava porque nenhum deles carrega `phase0-basic.js`.
  //
  // O apelido, e não a renomeação: `getActiveCharacterData` é o nome usado por
  // uma dúzia de chamadores e por vários testes, e o core prefere `getCharacter`
  // porque para ele não existe "ativo" — existe "o servidor sabe quem é".
  getCharacterData: getActiveCharacterData,

  getActiveActorByCharacterId,
  setCharacterNumber,
  getActorByCharacterNumber,
  formatCharacterNumber,
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
