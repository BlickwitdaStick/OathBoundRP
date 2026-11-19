/**
 * trade-service.js — troca entre jogadores, autoritativa no servidor
 *
 * ─── O que existia antes ────────────────────────────────────────────────────
 *
 * 90 linhas que negociavam o **convite** e guardavam `{initiatorId, targetId,
 * status}` num `Map`. Não havia oferta, confirmação, revalidação, transação,
 * timeout nem limpeza em desconexão — e o próprio cabeçalho dizia que a
 * transferência "nunca foi escrita". Ver
 * `docs/research/INVENTORY_TRADE_CRAFTING_AUDIT.md` §12.
 *
 * ─── A regra que organiza este arquivo ──────────────────────────────────────
 *
 * > **Confirmação é sobre uma oferta específica, não sobre a sessão.**
 *
 * Toda mudança de oferta incrementa a `version` da sessão e derruba as duas
 * confirmações. Sem isso existe o golpe clássico: A confirma vendo a oferta X,
 * B troca a oferta por Y e confirma, e A é levado a fechar um negócio que nunca
 * viu. É a mesma razão pela qual `canSee` não autoriza nada no Interaction
 * Framework — o que foi mostrado num instante anterior não vale como
 * autorização agora.
 *
 * O commit **revalida tudo do zero** (distância, estado, posse) e move os dois
 * lados numa `inventory.exchange` só. Uma troca em que só uma perna commita é
 * doação.
 *
 * ─── Estado: PARKED ─────────────────────────────────────────────────────────
 *
 * Este módulo tem descritor em `phase0-basic.js` atrás de
 * `ENABLE_TRADE_SERVICE`, que nasce `false`. Ele não tem UI CEF: os comandos de
 * chat abaixo são a interface inteira, e `trade.request` é a única interação
 * registrada. Nada disto rodou numa sessão real — mesmo peso que a mesma frase
 * tem no `INTERACTION_FRAMEWORK.md`.
 *
 * ─── Ouro ───────────────────────────────────────────────────────────────────
 *
 * §11 do pedido: ouro em troca **é possível e não está feito**. Quando entrar,
 * entra pelas primitivas `tx.*` do `core/transaction-service` dentro da mesma
 * transação da `exchange` — o que hoje o `core/inventory.js` não expõe, porque
 * expor "mexa em ouro também" numa API de item é como o `economy-service`
 * começou. Ver `docs/gameplay/TRADE_SYSTEM.md` §7.
 */

const commands = require('./commands');
const inventory = require('./core/inventory');
const rangeUtils = require('./core/range-utils');
const actionPolicy = require('./core/action-policy');
const interactionRegistry = require('./core/interaction-registry');

const MODULE = 'trade';

/**
 * Alcance da troca, em unidades do Skyrim.
 *
 * O mesmo de fala normal, pelo motivo do `market-stalls`: quem consegue
 * conversar consegue negociar. Inventar um número aqui repetiria o defeito que
 * `core/proximity-ranges.js` existe por ter consertado.
 */
const TRADE_RANGE = require('./core/proximity-ranges').RANGES.say;

/** Uma troca parada morre. §12 do pedido: timeout é obrigatório. */
const SESSION_TTL_MS = 3 * 60 * 1000;

/** Convite não aceito expira antes da sessão: ele é só um toque no ombro. */
const INVITE_TTL_MS = 45 * 1000;

/** Teto por lado. O `core/inventory` tem o dele (32 no total das duas pernas). */
const MAX_ITEMS_PER_SIDE = 12;

/**
 * A máquina de estados.
 *
 * `COMMITTING` existe e não é decorativo: é ele que impede que um segundo
 * `/tradeconfirm`, chegando enquanto a transação roda, entre no `exchange` de
 * novo. A idempotência do `core/inventory` já protegeria o banco — este estado
 * protege a **sessão**, que é memória, e onde o `requestId` não alcança.
 */
const STATES = Object.freeze({
  REQUESTED: 'REQUESTED',
  ACTIVE: 'ACTIVE',
  COMMITTING: 'COMMITTING',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
  EXPIRED: 'EXPIRED'
});

// ─────────────────────────────────────────────────────────────────────────────
// Registro de sessões
// ─────────────────────────────────────────────────────────────────────────────

/** @type {Map<string, object>} sessionId → sessão */
const _sessions = new Map();

/** @type {Map<number, string>} actorId → sessionId. Índice, não autoridade. */
const _byActor = new Map();

function now() {
  return Date.now();
}

function notify(actorId, message) {
  commands.sendNotification(actorId, message);
}

/**
 * A sessão viva de um ator, já expirando o que passou do prazo.
 *
 * A expiração acontece **na leitura**, e não num `setInterval`. Um timer teria
 * que ser desligado no `shutdown` do módulo e é mais uma coisa que sobrevive ao
 * desligamento; a expiração preguiçosa não tem ciclo de vida próprio. O custo é
 * que uma sessão abandonada ocupa memória até alguém tocar nela — e para isso
 * existe o `sweep()`, chamado no `shutdown`.
 *
 * @param {number} actorId
 * @returns {object|null}
 */
function sessionOf(actorId) {
  const id = _byActor.get(actorId);
  if (!id) return null;

  const session = _sessions.get(id);
  if (!session) {
    _byActor.delete(actorId);
    return null;
  }

  const prazo = session.state === STATES.REQUESTED ? INVITE_TTL_MS : SESSION_TTL_MS;
  if (now() - session.touchedAt > prazo) {
    finish(session, STATES.EXPIRED);
    notify(session.a.actorId, 'The trade expired.');
    notify(session.b.actorId, 'The trade expired.');
    return null;
  }
  return session;
}

/** Encerra a sessão e solta os dois índices. */
function finish(session, state) {
  session.state = state;
  _sessions.delete(session.id);
  if (_byActor.get(session.a.actorId) === session.id) _byActor.delete(session.a.actorId);
  if (_byActor.get(session.b.actorId) === session.id) _byActor.delete(session.b.actorId);
}

/** O lado da sessão que corresponde a este ator, e o outro. */
function sidesOf(session, actorId) {
  return session.a.actorId === actorId
    ? { eu: session.a, outro: session.b }
    : { eu: session.b, outro: session.a };
}

/**
 * Qualquer mudança de oferta invalida as duas confirmações. §10 do pedido.
 *
 * A `version` também vai no `requestId` do commit: se alguém conseguisse
 * disparar dois commits de versões diferentes, eles teriam chaves de
 * idempotência diferentes — e é por isso que o estado `COMMITTING` existe.
 */
function touch(session) {
  session.version += 1;
  session.a.confirmedVersion = null;
  session.b.confirmedVersion = null;
  session.touchedAt = now();
}

// ─────────────────────────────────────────────────────────────────────────────
// Fluxo
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A solicita troca com B.
 *
 * @param {number} actorId
 * @param {number} targetActorId
 */
function requestTrade(actorId, targetActorId) {
  const eu = commands.getActiveCharacterData(actorId);
  if (!eu) return false;

  if (!Number.isSafeInteger(targetActorId) || targetActorId <= 0 || targetActorId === actorId) {
    notify(actorId, 'Invalid target.');
    return false;
  }

  const alvo = commands.getActiveCharacterData(targetActorId);
  if (!alvo) {
    notify(actorId, 'That person is not available.');
    return false;
  }

  if (sessionOf(actorId)) {
    notify(actorId, 'You are already in a trade.');
    return false;
  }
  if (sessionOf(targetActorId)) {
    notify(actorId, 'That person is already in a trade.');
    return false;
  }

  const alcance = rangeUtils.assertRange(actorId, targetActorId, TRADE_RANGE);
  if (!alcance.ok) {
    notify(actorId, alcance.reason || 'Target out of range.');
    return false;
  }

  const session = {
    id: `trade-${inventory.newRequestId('t').slice(2)}`,
    state: STATES.REQUESTED,
    version: 0,
    createdAt: now(),
    touchedAt: now(),
    a: { actorId, characterId: eu.characterId, items: new Map(), confirmedVersion: null },
    b: { actorId: targetActorId, characterId: alvo.characterId, items: new Map(), confirmedVersion: null }
  };

  _sessions.set(session.id, session);
  _byActor.set(actorId, session.id);
  _byActor.set(targetActorId, session.id);

  notify(actorId, 'Trade invitation sent.');
  notify(targetActorId, 'Someone wants to trade with you. Use /tradeaccept to open it.');
  commands.broadcastProximityMessage(actorId, '* Extends a hand, proposing a deal.', 500);
  console.log(`[trade] ${session.id}: ${eu.characterId} -> ${alvo.characterId}`);
  return true;
}

/** B aceita o convite. */
function acceptTrade(actorId) {
  const session = sessionOf(actorId);
  if (!session || session.state !== STATES.REQUESTED) {
    notify(actorId, 'No pending trade invitation.');
    return false;
  }
  // Quem convidou não aceita o próprio convite.
  if (session.a.actorId === actorId) {
    notify(actorId, 'Waiting for the other person to accept.');
    return false;
  }

  session.state = STATES.ACTIVE;
  session.touchedAt = now();
  notify(session.a.actorId, 'Trade opened. Use /tradeadd <baseId> <qty> to make an offer.');
  notify(session.b.actorId, 'Trade opened. Use /tradeadd <baseId> <qty> to make an offer.');
  return true;
}

/**
 * Adiciona (ou remove, com quantidade negativa) item da própria oferta.
 *
 * A posse **não é conferida aqui como autoridade** — ela é conferida no commit,
 * dentro da transação, pelo `FOR UPDATE`. A checagem abaixo existe só para dar
 * a mensagem certa na hora certa: ofertar o que não se tem e descobrir três
 * minutos depois, no fechamento, é o tipo de silêncio que faz jogador desistir
 * do sistema.
 */
async function addItem(actorId, baseId, quantity) {
  const session = sessionOf(actorId);
  if (!session || session.state !== STATES.ACTIVE) {
    notify(actorId, 'You are not in an open trade.');
    return false;
  }

  if (!Number.isSafeInteger(baseId) || baseId <= 0) {
    notify(actorId, 'Invalid FormID.');
    return false;
  }
  if (!Number.isSafeInteger(quantity) || quantity === 0) {
    notify(actorId, 'Invalid quantity.');
    return false;
  }

  const { eu } = sidesOf(session, actorId);
  const atual = eu.items.get(baseId) || 0;
  const novo = atual + quantity;

  if (novo < 0) {
    notify(actorId, 'You did not offer that quantity.');
    return false;
  }
  if (novo === 0) {
    eu.items.delete(baseId);
  } else {
    if (!eu.items.has(baseId) && eu.items.size >= MAX_ITEMS_PER_SIDE) {
      notify(actorId, `At most ${MAX_ITEMS_PER_SIDE} item types per side.`);
      return false;
    }
    const emMaos = await inventory.getStack(inventory.character(eu.characterId), baseId);
    if (emMaos < novo) {
      notify(actorId, `You have ${emMaos}, tried to offer ${novo}.`);
      return false;
    }
    eu.items.set(baseId, novo);
  }

  touch(session);
  descrever(session);
  return true;
}

/** Manda a oferta atual para os dois lados. É a UI inteira, por enquanto. */
function descrever(session) {
  const linha = (lado) => lado.items.size === 0
    ? '(nothing)'
    : [...lado.items.entries()].map(([b, q]) => `0x${b.toString(16)}x${q}`).join(', ');

  const a = linha(session.a);
  const b = linha(session.b);
  notify(session.a.actorId, `Trade v${session.version} — you: ${a} | them: ${b}`);
  notify(session.b.actorId, `Trade v${session.version} — you: ${b} | them: ${a}`);
}

/**
 * Confirma a oferta **desta versão**.
 *
 * Quando os dois confirmarem a mesma versão, o commit dispara.
 */
async function confirmTrade(actorId) {
  const session = sessionOf(actorId);
  if (!session || session.state !== STATES.ACTIVE) {
    notify(actorId, 'You are not in an open trade.');
    return false;
  }

  const { eu, outro } = sidesOf(session, actorId);
  if (eu.items.size === 0 && outro.items.size === 0) {
    notify(actorId, 'There is nothing to trade.');
    return false;
  }

  eu.confirmedVersion = session.version;
  session.touchedAt = now();

  if (outro.confirmedVersion !== session.version) {
    notify(actorId, 'Confirmed. Waiting for the other party.');
    notify(outro.actorId, 'The other party confirmed. Use /tradeconfirm to close the deal.');
    return true;
  }

  return commitTrade(session);
}

/**
 * O fechamento. **Revalida tudo do zero** e move as duas pernas numa transação.
 *
 * O que é revalidado, e por que cada um:
 *
 * | Revalidação | O que aconteceu entre a confirmação e agora |
 * |---|---|
 * | os dois ainda logados | um caiu — `getActiveCharacterData` deixa de responder |
 * | mesmo personagem | um trocou de personagem no mesmo ator |
 * | distância | um andou para longe |
 * | estado (algemado, preso) | a guarda chegou no meio da cena |
 * | posse | vendeu na barraca, largou, craftou com o item |
 *
 * As quatro primeiras são desta função. A quinta é do `FOR UPDATE` dentro da
 * `exchange`, e é a única que precisa ser — as outras não têm lock possível.
 */
async function commitTrade(session) {
  session.state = STATES.COMMITTING;

  const falhar = (motivo) => {
    finish(session, STATES.CANCELLED);
    notify(session.a.actorId, `Trade cancelled: ${motivo}`);
    notify(session.b.actorId, `Trade cancelled: ${motivo}`);
    return false;
  };

  for (const lado of [session.a, session.b]) {
    const vivo = commands.getActiveCharacterData(lado.actorId);
    if (!vivo || vivo.characterId !== lado.characterId) {
      return falhar('the other party left.');
    }
  }

  const alcance = rangeUtils.assertRange(session.a.actorId, session.b.actorId, TRADE_RANGE);
  if (!alcance.ok) return falhar(alcance.reason || 'you moved too far apart.');

  for (const lado of [session.a, session.b]) {
    // `core/action-policy` é a autoridade sobre "este personagem pode negociar
    // agora", e `trade` já é uma ação registrada lá desde antes deste arquivo.
    // Chamar a política em vez de ler `character-state` direto é o que faz
    // algemado, preso, abatido, morto e zona segura valerem aqui sem que este
    // arquivo precise conhecer nenhum dos cinco.
    const veredito = actionPolicy.canPerform(lado.characterId, 'trade', {
      actorId: lado.actorId,
      targetActorId: lado === session.a ? session.b.actorId : session.a.actorId
    });
    if (!veredito.allowed) return falhar(veredito.reason.toLowerCase());
  }

  const legs = [];
  if (session.a.items.size > 0) {
    legs.push({
      from: inventory.character(session.a.characterId, session.a.actorId),
      to: inventory.character(session.b.characterId, session.b.actorId),
      items: [...session.a.items.entries()].map(([baseId, quantity]) => ({ baseId, quantity }))
    });
  }
  if (session.b.items.size > 0) {
    legs.push({
      from: inventory.character(session.b.characterId, session.b.actorId),
      to: inventory.character(session.a.characterId, session.a.actorId),
      items: [...session.b.items.entries()].map(([baseId, quantity]) => ({ baseId, quantity }))
    });
  }

  // A versão entra na chave: um commit da v3 e outro da v4 são pedidos
  // diferentes, e nunca devem se deduplicar entre si.
  const resultado = await inventory.exchange({
    legs,
    reason: 'trade',
    module: MODULE,
    requestId: `${session.id}.v${session.version}`
  });

  if (!resultado.ok) {
    return falhar(resultado.reason);
  }

  finish(session, STATES.COMPLETED);
  notify(session.a.actorId, 'Deal closed.');
  notify(session.b.actorId, 'Deal closed.');
  commands.broadcastProximityMessage(session.a.actorId, '* Shakes hands, sealing the deal.', 500);
  console.log(`[trade] ${session.id} concluida (transfer=${resultado.transferId})`);
  return true;
}

/** Qualquer um dos dois cancela, a qualquer momento antes do `COMMITTING`. */
function cancelTrade(actorId, motivo = 'the trade was cancelled.') {
  const session = sessionOf(actorId);
  if (!session) return false;
  if (session.state === STATES.COMMITTING) {
    notify(actorId, 'The trade is already being closed.');
    return false;
  }

  finish(session, STATES.CANCELLED);
  notify(session.a.actorId, motivo);
  notify(session.b.actorId, motivo);
  return true;
}

/**
 * Desconexão. **O item nunca esteve em custódia**, então não há nada a
 * devolver: as ofertas são intenção em memória, e a troca só move item no
 * commit. Este é o motivo de a oferta não ser "depositada" numa sessão — um
 * modelo de custódia precisaria de uma tabela e de um caminho de recuperação
 * para item preso numa sessão que morreu com o servidor.
 *
 * Chamado pelo `initialize()` do módulo, via `commands.removeActiveCharacter`.
 */
function onDisconnect(actorId) {
  const id = _byActor.get(actorId);
  if (!id) return;
  const session = _sessions.get(id);
  if (!session) {
    _byActor.delete(actorId);
    return;
  }
  if (session.state === STATES.COMMITTING) return; // deixa o commit terminar
  finish(session, STATES.CANCELLED);
  const { outro } = sidesOf(session, actorId);
  notify(outro.actorId, 'The other party left. Trade cancelled.');
}

/** Encerra tudo. Chamado no `shutdown` do módulo. */
function sweep() {
  for (const session of [..._sessions.values()]) {
    finish(session, STATES.EXPIRED);
  }
  _byActor.clear();
}

// ─────────────────────────────────────────────────────────────────────────────
// Superfície
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Registra `trade.request` no Interaction Framework.
 *
 * Só o convite é interação: o resto da troca acontece dentro de uma sessão que
 * já tem os dois lados, e um menu contextual sobre o outro jogador não é o
 * lugar de "adicionar item à minha oferta".
 */
function registerInteractions() {
  interactionRegistry.register({
    id: 'trade.request',
    module: MODULE,
    target: interactionRegistry.TARGET_TYPES.PLAYER,
    label: 'Propose a trade',
    section: 'social',
    order: 20,
    distance: TRADE_RANGE,
    policyAction: 'trade',
    audit: interactionRegistry.AUDIT_LEVELS.TRACE,
    idempotent: false,
    // Some do menu de quem já está numa troca, dos dois lados. Um botão que só
    // responde "voce ja esta numa troca" ensina o jogador a ignorar o menu.
    canSee: async ctx => !sessionOf(ctx.actorId) && !sessionOf(ctx.target.actorId),
    execute: async ctx => {
      const ok = requestTrade(ctx.actorId, ctx.target.actorId);
      return { message: ok ? 'Invitation sent.' : 'Could not propose the trade.' };
    }
  });
}

/**
 * Ponte pro `trade-overlay` da CEF (`index.html`) — mesmo formato de
 * `player-panel-service.js handleUiEvent`. Até 22/08/2026 o botão "Fechar"
 * da overlay chamava `mp.trigger('cef::trade:cancel', {})`, que não tinha
 * NENHUM listener server-side (grep confirmou) — aceitar/confirmar/cancelar
 * dependiam 100% de `/tradeaccept`/`/tradeconfirm`/`/tradecancel`
 * digitados, mesmo com uma UI na tela sugerindo o contrário. Ver
 * `docs/technical/PLAYER_ACTION_SHORTCUTS_PLAN.md` Fase 1.
 *
 * As três funções (`acceptTrade`/`confirmTrade`/`cancelTrade`) já existem e
 * já são o que os comandos de texto chamam — isto não duplica lógica, só
 * dá a ela um segundo chamador.
 * @param {number} actorId
 * @param {{type?: string}} uiEvent
 * @returns {Promise<boolean>|boolean}
 */
function handleUiEvent(actorId, uiEvent) {
  if (!uiEvent || typeof uiEvent.type !== 'string') return false;

  switch (uiEvent.type) {
    case 'trade:accept':
      return acceptTrade(actorId);
    case 'trade:confirm':
      return confirmTrade(actorId);
    case 'trade:cancel':
      return cancelTrade(actorId);
    default:
      return false;
  }
}

function commandDefs() {
  return [
    {
      name: '/trade',
      description: '[Trade] Proposes a trade to someone',
      usage: '/trade <actorId>',
      handler: (actorId, args) => {
        const alvo = Number.parseInt(String(args).trim().replace(/^0x/i, ''), 16);
        if (!Number.isSafeInteger(alvo)) return notify(actorId, 'Usage: /trade <actorId>');
        requestTrade(actorId, alvo);
      }
    },
    {
      name: '/tradeaccept',
      description: '[Trade] Accepts the pending invitation',
      usage: '/tradeaccept',
      handler: (actorId) => acceptTrade(actorId)
    },
    {
      name: '/tradeadd',
      description: '[Trade] Adds an item to your offer (negative quantity removes)',
      usage: '/tradeadd <baseId> <qty>',
      handler: (actorId, args) => {
        const [bruto, qtd] = String(args).trim().split(/\s+/);
        const baseId = Number.parseInt(String(bruto || '').replace(/^0x/i, ''), 16);
        const quantity = Number.parseInt(qtd, 10);
        if (!Number.isSafeInteger(baseId) || !Number.isSafeInteger(quantity)) {
          return notify(actorId, 'Usage: /tradeadd <baseId> <qty>');
        }
        return addItem(actorId, baseId, quantity);
      }
    },
    {
      name: '/tradeconfirm',
      description: '[Trade] Confirms the current offer',
      usage: '/tradeconfirm',
      handler: (actorId) => confirmTrade(actorId)
    },
    {
      name: '/tradecancel',
      description: '[Trade] Cancels the trade',
      usage: '/tradecancel',
      handler: (actorId) => cancelTrade(actorId)
    }
  ];
}

module.exports = {
  STATES,
  SESSION_TTL_MS,
  INVITE_TTL_MS,
  TRADE_RANGE,
  MAX_ITEMS_PER_SIDE,

  requestTrade,
  acceptTrade,
  addItem,
  confirmTrade,
  cancelTrade,
  onDisconnect,
  sweep,

  registerInteractions,
  commandDefs,
  handleUiEvent,

  // Só para teste: a sessão é memória, e o teste precisa envelhecê-la sem
  // esperar três minutos e inspecionar o estado sem passar pela UI.
  _sessions,
  _sessionOf: sessionOf
};
