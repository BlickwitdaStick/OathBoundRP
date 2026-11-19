/**
 * core/action-policy.js
 *
 * Política central de ações — a única fonte de verdade sobre
 * "quem pode fazer o quê em qual estado".
 *
 * TODA ação de gameplay DEVE ser validada aqui antes de executar.
 * Nenhum serviço individual deve implementar suas próprias verificações de estado.
 *
 * Uso:
 *   const { allowed, reason } = actionPolicy.canPerform(characterId, 'woodcutting');
 *   if (!allowed) { sendNotification(actorId, reason); return; }
 */

const characterState = require('./character-state');
// Toca `mp` (com guard) e le config de disco; por isso fica em modulo proprio
// em vez de dentro deste, que precisa continuar testavel sem servidor.
const safeZones = require('./safe-zones');
const { STATES } = characterState;

// ─────────────────────────────────────────────────────────────────────────────
// Definição das restrições por estado
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mapa de estados → lista de categorias de ação BLOQUEADAS naquele estado.
 * Uma ação pode pertencer a múltiplas categorias.
 */
const STATE_RESTRICTIONS = {
  [STATES.RESTRAINED]: {
    blocked: ['gameplay', 'combat', 'trade', 'craft', 'gather', 'move', 'use_item'],
    message: 'You are restrained and cannot do that.'
  },
  [STATES.IMPRISONED]: {
    blocked: ['trade', 'craft', 'gather', 'work', 'combat', 'move_world', 'sell'],
    message: 'You are imprisoned and cannot do that.'
  },
  [STATES.DOWNED]: {
    blocked: ['gameplay', 'combat', 'trade', 'craft', 'gather', 'move', 'use_item', 'speak_rp'],
    message: 'You are downed and cannot act. Wait for help.'
  },
  [STATES.DEAD]: {
    blocked: ['gameplay', 'combat', 'trade', 'craft', 'gather', 'move', 'use_item', 'speak_rp'],
    message: 'You are dead.'
  },
  [STATES.IN_TRADE]: {
    blocked: ['gather', 'work', 'craft', 'combat', 'move_world'],
    message: 'You are in a trade. Cancel it before doing that.'
  },
  [STATES.IN_CRAFT]: {
    blocked: ['gather', 'work', 'trade', 'combat', 'move_world'],
    message: 'You are crafting an item. Finish or cancel it first.'
  },
  [STATES.IN_DIALOG]: {
    blocked: ['gather', 'work', 'trade', 'craft', 'combat'],
    message: 'You are in a conversation. Finish it first.'
  },
  [STATES.BUSY]: {
    blocked: ['gather', 'work', 'craft', 'trade', 'combat'],
    message: 'You are busy with something else.'
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Registro de ações
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Registro central de ações e suas categorias.
 * Cada ação pertence a uma ou mais categorias usadas nas restrições acima.
 *
 * Estrutura: actionId → { categories: string[], label: string }
 */
const _actions = new Map();

/**
 * Registra uma ação na política.
 * Chamado pelos módulos ao se inicializar via module-registry.
 *
 * @param {string} actionId - Identificador único da ação (ex: 'woodcutting')
 * @param {string[]} categories - Categorias da ação (ex: ['gameplay', 'gather'])
 * @param {string} label - Nome legível para mensagens de erro
 */
function registerAction(actionId, categories, label) {
  _actions.set(actionId, { categories, label });
}

// ─────────────────────────────────────────────────────────────────────────────
// Ações CORE pré-registradas (sempre disponíveis)
// ─────────────────────────────────────────────────────────────────────────────
registerAction('speak',       ['speak_rp'],           'Speak');
registerAction('whisper',     ['speak_rp'],           'Whisper');
registerAction('shout',       ['speak_rp'],           'Shout');
registerAction('me',          ['speak_rp'],           '/me');
registerAction('do',          ['speak_rp'],           '/do');
registerAction('try',         ['speak_rp'],           '/try');
registerAction('introduce',   ['speak_rp'],           'Introduce yourself');
registerAction('alias',       ['speak_rp'],           'Give a nickname');
registerAction('woodcutting', ['gameplay', 'gather'], 'Chop wood');
registerAction('mining',      ['gameplay', 'gather'], 'Mine');
registerAction('fishing',     ['gameplay', 'gather'], 'Fish');
registerAction('craft',       ['gameplay', 'craft'],  'Craft');
registerAction('trade',       ['gameplay', 'trade'],  'Trade');
registerAction('sell',        ['gameplay', 'sell'],   'Sell');
registerAction('buy',         ['gameplay', 'sell'],   'Buy');
registerAction('move_world',  ['move', 'move_world'], 'Move between cells');
registerAction('use_item',    ['use_item'],            'Use item');
registerAction('eat',         ['use_item'],            'Eat');
registerAction('drink',       ['use_item'],            'Drink');
registerAction('sleep',       ['use_item'],            'Sleep');
registerAction('public_work', ['gameplay', 'work'],    'Public work');

// ─────────────────────────────────────────────────────────────────────────────
// API Pública
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Verifica se um personagem pode executar uma ação.
 *
 * Duas dimensões, nesta ordem:
 *
 *   1. **Estado** do personagem — algemado, abatido, preso. Sempre checado.
 *   2. **Lugar** onde ele está — zona segura. Só checado quando quem chama
 *      informa `context.actorId`, porque localização é do ator e esta função
 *      recebe `characterId`.
 *
 * O estado vem primeiro de propósito: "você está algemado" é uma explicação
 * melhor que "aqui é zona segura" para quem está algemado dentro de uma.
 *
 * @param {number} characterId
 * @param {string} actionId - ID da ação registrada
 * @param {object} [context]
 * @param {number} [context.actorId] - habilita a checagem de lugar
 * @param {number} [context.targetActorId] - checa os dois lados (ver safe-zones.blocksBetween)
 * @returns {{ allowed: boolean, reason: string }}
 */
function canPerform(characterId, actionId, context = {}) {
  const action = _actions.get(actionId);
  if (!action) {
    // Ação não registrada — bloquear por segurança
    return { allowed: false, reason: `Unknown action: ${actionId}` };
  }

  const currentState = characterState.get(characterId);
  const restrictions = STATE_RESTRICTIONS[currentState];

  if (restrictions) {
    // Verificar se alguma categoria da ação está bloqueada pelo estado atual
    const isBlocked = action.categories.some(cat => restrictions.blocked.includes(cat));
    if (isBlocked) {
      return { allowed: false, reason: restrictions.message };
    }
  }

  // Lugar. Só entra quando o chamador passa o actorId — todos os chamadores
  // antigos continuam funcionando exatamente como antes, sem checagem de lugar.
  if (context.actorId !== undefined && context.actorId !== null) {
    for (const categoria of action.categories) {
      const veredito = context.targetActorId !== undefined && context.targetActorId !== null
        ? safeZones.blocksBetween(context.actorId, context.targetActorId, categoria)
        : safeZones.blocksCategory(context.actorId, categoria);

      if (veredito.blocked) {
        // A mensagem diz de quem é a proteção quando ela não é de quem agiu —
        // sem isso, atacar alguém protegido devolveria "você está em zona
        // segura", que é confuso e parece bug.
        const onde = veredito.zone.label;
        return {
          allowed: false,
          reason: veredito.side === 'target'
            ? `Your target is under the protection of ${onde}.`
            : `You are in ${onde} and can't do that here.`
        };
      }
    }
  }

  return { allowed: true, reason: '' };
}

/**
 * Verifica uma ação e lança erro se não permitida.
 * Útil para código que prefere exceções.
 *
 * @param {number} characterId
 * @param {string} actionId
 * @param {object} [context]
 * @throws {Error} Se a ação não for permitida
 */
function assertCanPerform(characterId, actionId, context = {}) {
  const result = canPerform(characterId, actionId, context);
  if (!result.allowed) throw new Error(result.reason);
}

/**
 * Retorna todas as ações registradas (para debug/staff).
 */
function listActions() {
  return Array.from(_actions.entries()).map(([id, info]) => ({ id, ...info }));
}

module.exports = { canPerform, assertCanPerform, registerAction, listActions };
