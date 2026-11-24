/**
 * profession-service.js
 *
 * **The Profession Core.** Granting, revoking, suspending, rank and XP of a
 * character's profession — and no gameplay.
 *
 * ─── What this file explicitly does NOT do ──────────────────────────────────
 *
 * No mining, tree felling, hunting, crafting or contracts live here.
 * `core/profession-registry.js` already documents the difference between a profession
 * being REGISTERED (it exists in the catalog), being ENABLED (it can be granted) and
 * having IMPLEMENTED GAMEPLAY (there is automation behind it) — this file only deals
 * with the first and the second. The thirteen professions of this phase do not have the
 * third. Miner already has a separate consumer (`mining-service.js`),
 * without putting gameplay inside this core.
 *
 * ─── Where the "can they do this now?" decision lives ───────────────────────
 *
 * NOT here. What decides "can this role grant a profession?" is
 * `core/permissions.js`, through the pipeline in `admin-actions.js` — this
 * file is the DOMAIN SERVICE the pipeline calls after it has already
 * decided that, exactly like `admin-service.giveItemAdmin` is called by the
 * `inventory.grant` action. That is why no function here receives `role` or
 * `actorId`: they receive an already resolved `characterId`.
 *
 * The only authorization check that LIVES here is `moduleRegistry
 * .isEnabled('profession')` — it is not a role permission, it is the switch for
 * "this server turned the framework on" (§17 of the briefing: "never enable
 * automatically in production"). It is checked in this layer, and not only in the
 * admin-action's `precondition`, because this module may one day get a
 * second consumer (ResourceNode) that does not go through the pipeline — and the
 * switch has to apply to both.
 *
 * ─── Typed result, not a boolean (same convention as core/economy-service) ─
 *
 * Every write function returns `{ok:true, data}` or `{ok:false, code,
 * message}` for an EXPECTED refusal (profession already active, limit reached, rank
 * out of range). An infrastructure error (DB down) THROWS. The two
 * are never confused: the difference is one that already cost dearly in this project in
 * another service (Finding 7 of `ECONOMY_FRAMEWORK_AUDIT.md`) — a network timeout
 * turning into "profession denied" would be the same class of bug.
 *
 * ─── Concurrency ─────────────────────────────────────────────────────────────
 *
 * `grantProfession` and `reactivateProfession` lock the character's ACTIVE
 * rows (`SELECT ... WHERE character_id = ? AND status = 'active' FOR
 * UPDATE`) before counting against `profession.maxPerCharacter`. Under
 * REPEATABLE READ (InnoDB's default), that takes a next-key lock over the range of the
 * `idx_charprof_character` index — two concurrent grants for the SAME
 * character serialize, so neither of them ends up with 4 professions when the limit is 3.
 * See the equivalent comment in `core/transaction-service.js
 * ._applyGoldDelta`.
 */

'use strict';

const database = require('./database');
const professionRegistry = require('./core/profession-registry');
const moduleRegistry = require('./core/module-registry');
const serverOptions = require('./core/server-options');

// ─────────────────────────────────────────────────────────────────────────────
// Vocabulary
// ─────────────────────────────────────────────────────────────────────────────

const MODULE_ID = 'profession';

/**
 * `active`   — the profession authorizes future gameplay and counts against the limit.
 * `suspended`— staff took it away temporarily; it does NOT authorize gameplay, does NOT count
 *              against the limit while suspended, but the history (rank/XP)
 *              stays. It only goes back to `active` through `reactivateProfession`.
 * `revoked`  — ended. The row is NOT deleted (§8 of the briefing): rank/XP
 *              stay as history, and `grantProfession` on a revoked
 *              code reuses the same row instead of inserting another.
 */
const STATUS = Object.freeze({
  ACTIVE: 'active',
  SUSPENDED: 'suspended',
  REVOKED: 'revoked'
});

/**
 * XP cap of the column's INT UNSIGNED, same logic as `MAX_GOLD` in
 * `core/transaction-service.js`: an increment that overflowed the column
 * saturates silently in MySQL's non-strict mode instead of failing.
 */
const MAX_XP = 2147483647;

// ─────────────────────────────────────────────────────────────────────────────
// Auxiliares
// ─────────────────────────────────────────────────────────────────────────────

/** @param {object} dependencies */
function _deps(dependencies = {}) {
  return {
    db: dependencies.db || database,
    registry: dependencies.registry || professionRegistry,
    moduleRegistry: dependencies.moduleRegistry || moduleRegistry,
    serverOptions: dependencies.serverOptions || serverOptions
  };
}

function _isModuleEnabled(deps) {
  return deps.moduleRegistry.isEnabled(MODULE_ID);
}

function _rowToState(row) {
  if (!row) return null;
  return {
    characterId: row.character_id,
    professionCode: row.profession_code,
    status: row.status,
    rank: row.rank,
    xp: row.xp,
    grantedByCharacterId: row.granted_by_character_id,
    joinedAt: row.joined_at,
    updatedAt: row.updated_at
  };
}

function _isPositiveInt(v) {
  return Number.isSafeInteger(v) && v > 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Consultas
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every row of the character, any status. Whoever only wants the active ones
 * filters the result — the API does not hide history from whoever asked for everything.
 * @param {number} characterId
 * @param {object} [dependencies]
 */
async function getCharacterProfessions(characterId, dependencies = {}) {
  const deps = _deps(dependencies);
  if (!_isPositiveInt(characterId)) throw new Error('[profession-service] invalid characterId');
  const rows = await deps.db.query(
    'SELECT * FROM character_professions WHERE character_id = ? ORDER BY profession_code',
    [characterId]
  );
  return rows.map(_rowToState);
}

/** @param {number} characterId @param {string} professionCode @param {object} [dependencies] */
async function getProfessionState(characterId, professionCode, dependencies = {}) {
  const deps = _deps(dependencies);
  if (!_isPositiveInt(characterId)) throw new Error('[profession-service] invalid characterId');
  const rows = await deps.db.query(
    'SELECT * FROM character_professions WHERE character_id = ? AND profession_code = ?',
    [characterId, professionCode]
  );
  return rows.length > 0 ? _rowToState(rows[0]) : null;
}

/**
 * `true` only when the profession is ACTIVE — a suspended one does not authorize
 * gameplay (§8 of the briefing), so it does not count as "has the profession" for
 * whoever checks this before allowing a future action.
 * @param {number} characterId @param {string} professionCode @param {object} [dependencies]
 */
async function hasProfession(characterId, professionCode, dependencies = {}) {
  const state = await getProfessionState(characterId, professionCode, dependencies);
  return !!state && state.status === STATUS.ACTIVE;
}

// ─────────────────────────────────────────────────────────────────────────────
// Granting
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Counts how many ACTIVE professions the character has, locking the
 * rows involved — it must be called inside the caller's transaction.
 * @param {object} conn
 * @param {number} characterId
 */
async function _lockActiveCount(conn, characterId) {
  const [rows] = await conn.query(
    "SELECT id FROM character_professions WHERE character_id = ? AND status = 'active' FOR UPDATE",
    [characterId]
  );
  return rows.length;
}

/**
 * Grants a profession. If a REVOKED row already exists for the same pair
 * (character, profession), it reuses the row — the old rank and XP become
 * valid again. This is an explicit decision, not the only possible reading of §8 of the
 * briefing: the alternative (zeroing rank/XP for a "fresh start") is reasonable too.
 * Documented in docs/gameplay/PROFESSION_FRAMEWORK.md §"Regranting after
 * revoking" for whoever wants to change the behavior.
 *
 * @param {object} opts
 * @param {number} opts.characterId
 * @param {string} opts.professionCode
 * @param {number|null} [opts.grantedByCharacterId]
 * @param {object} [dependencies]
 * @returns {Promise<{ok:true,data:object}|{ok:false,code:string,data?:object}>}
 */
async function grantProfession(opts, dependencies = {}) {
  const deps = _deps(dependencies);
  const { characterId, professionCode, grantedByCharacterId = null } = opts || {};

  if (!_isModuleEnabled(deps)) return { ok: false, code: 'module_disabled' };
  if (!_isPositiveInt(characterId)) return { ok: false, code: 'invalid_character' };

  const validacao = deps.registry.validate(professionCode);
  if (!validacao.ok) return { ok: false, code: validacao.reason };

  const maxPerCharacter = deps.serverOptions.get('profession.maxPerCharacter');

  const conn = await deps.db.getConnection();
  try {
    await conn.beginTransaction();

    const [existentes] = await conn.query(
      'SELECT id, status, rank, xp FROM character_professions WHERE character_id = ? AND profession_code = ? FOR UPDATE',
      [characterId, professionCode]
    );
    const existente = existentes[0] || null;

    if (existente && existente.status === STATUS.ACTIVE) {
      await conn.rollback();
      return { ok: false, code: 'already_active' };
    }
    if (existente && existente.status === STATUS.SUSPENDED) {
      await conn.rollback();
      return { ok: false, code: 'suspended_use_reactivate' };
    }

    const ativos = await _lockActiveCount(conn, characterId);
    if (ativos >= maxPerCharacter) {
      await conn.rollback();
      return { ok: false, code: 'max_professions_reached', data: { max: maxPerCharacter, active: ativos } };
    }

    if (existente) {
      // Reaproveita a linha revogada.
      await conn.query(
        "UPDATE character_professions SET status = 'active', granted_by_character_id = ?, joined_at = CURRENT_TIMESTAMP WHERE id = ?",
        [grantedByCharacterId, existente.id]
      );
    } else {
      await conn.query(
        `INSERT INTO character_professions
          (character_id, profession_code, status, rank, xp, granted_by_character_id)
         VALUES (?, ?, 'active', 0, 0, ?)`,
        [characterId, professionCode, grantedByCharacterId]
      );
    }

    await conn.commit();
    const estado = await getProfessionState(characterId, professionCode, dependencies);
    return { ok: true, data: estado };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Revoking / suspending / reactivating
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generic status transition: locks the row, checks the required source
 * status and writes the new one. The four lifecycle operations
 * (revoke/suspend/reactivate) are the same shape with different
 * source/destination — a single function avoids four copies of the same `FOR UPDATE`.
 *
 * @param {object} opts
 * @param {number} opts.characterId
 * @param {string} opts.professionCode
 * @param {string[]} opts.fromStatuses accepted source statuses
 * @param {string} opts.toStatus
 * @param {string} opts.wrongStatusCode refusal code if the current status does not match
 * @param {boolean} [opts.recheckCapacity] checks the limit before writing (reactivation)
 * @param {object} deps
 */
async function _transition(opts, deps) {
  const { characterId, professionCode, fromStatuses, toStatus, wrongStatusCode, recheckCapacity } = opts;

  if (!_isModuleEnabled(deps)) return { ok: false, code: 'module_disabled' };
  if (!_isPositiveInt(characterId)) return { ok: false, code: 'invalid_character' };

  const conn = await deps.db.getConnection();
  try {
    await conn.beginTransaction();

    const [rows] = await conn.query(
      'SELECT id, status FROM character_professions WHERE character_id = ? AND profession_code = ? FOR UPDATE',
      [characterId, professionCode]
    );
    const linha = rows[0] || null;

    if (!linha) {
      await conn.rollback();
      return { ok: false, code: 'not_found' };
    }
    if (!fromStatuses.includes(linha.status)) {
      await conn.rollback();
      return { ok: false, code: wrongStatusCode, data: { currentStatus: linha.status } };
    }

    if (recheckCapacity) {
      const maxPerCharacter = deps.serverOptions.get('profession.maxPerCharacter');
      const ativos = await _lockActiveCount(conn, characterId);
      if (ativos >= maxPerCharacter) {
        await conn.rollback();
        return { ok: false, code: 'max_professions_reached', data: { max: maxPerCharacter, active: ativos } };
      }
    }

    await conn.query('UPDATE character_professions SET status = ? WHERE id = ?', [toStatus, linha.id]);
    await conn.commit();

    return { ok: true, data: await getProfessionState(characterId, professionCode, { db: deps.db }) };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/** @param {{characterId:number, professionCode:string}} opts @param {object} [dependencies] */
async function revokeProfession(opts, dependencies = {}) {
  const deps = _deps(dependencies);
  return _transition({
    ...opts,
    fromStatuses: [STATUS.ACTIVE, STATUS.SUSPENDED],
    toStatus: STATUS.REVOKED,
    wrongStatusCode: 'already_revoked'
  }, deps);
}

/** @param {{characterId:number, professionCode:string}} opts @param {object} [dependencies] */
async function suspendProfession(opts, dependencies = {}) {
  const deps = _deps(dependencies);
  return _transition({
    ...opts,
    fromStatuses: [STATUS.ACTIVE],
    toStatus: STATUS.SUSPENDED,
    wrongStatusCode: 'not_active'
  }, deps);
}

/**
 * Returns a SUSPENDED profession to active. It recounts against
 * `profession.maxPerCharacter` — suspending one and granting another up to the limit,
 * then reactivating the first, must not sneak past the cap.
 * @param {{characterId:number, professionCode:string}} opts @param {object} [dependencies]
 */
async function reactivateProfession(opts, dependencies = {}) {
  const deps = _deps(dependencies);
  return _transition({
    ...opts,
    fromStatuses: [STATUS.SUSPENDED],
    toStatus: STATUS.ACTIVE,
    wrongStatusCode: 'not_suspended',
    recheckCapacity: true
  }, deps);
}

// ─────────────────────────────────────────────────────────────────────────────
// Rank
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {object} opts
 * @param {number} opts.characterId
 * @param {string} opts.professionCode
 * @param {number} opts.rank inteiro, 0..profession.maxRank
 * @param {object} [dependencies]
 */
async function setProfessionRank(opts, dependencies = {}) {
  const deps = _deps(dependencies);
  const { characterId, professionCode, rank } = opts || {};

  if (!_isModuleEnabled(deps)) return { ok: false, code: 'module_disabled' };
  if (!_isPositiveInt(characterId)) return { ok: false, code: 'invalid_character' };

  const maxRank = deps.serverOptions.get('profession.maxRank');
  if (!Number.isInteger(rank) || rank < 0 || rank > maxRank) {
    return { ok: false, code: 'invalid_rank', data: { min: 0, max: maxRank } };
  }

  const conn = await deps.db.getConnection();
  try {
    await conn.beginTransaction();

    const [rows] = await conn.query(
      'SELECT id, status, rank FROM character_professions WHERE character_id = ? AND profession_code = ? FOR UPDATE',
      [characterId, professionCode]
    );
    const linha = rows[0] || null;

    if (!linha) {
      await conn.rollback();
      return { ok: false, code: 'not_found' };
    }
    if (linha.status !== STATUS.ACTIVE) {
      await conn.rollback();
      return { ok: false, code: 'not_active', data: { currentStatus: linha.status } };
    }

    const rankAnterior = linha.rank;
    await conn.query('UPDATE character_professions SET rank = ? WHERE id = ?', [rank, linha.id]);
    await conn.commit();

    return { ok: true, data: { previousRank: rankAnterior, rank } };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// XP
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Adjusts profession XP. A negative `amount` is only accepted when
 * `staffCharacterId` is present — that is what §10 of the briefing asks for
 * ("reject negatives unless the operation is explicitly administrative"), and it is
 * checked HERE, not only in the admin action layer, because this function is the
 * public API a future consumer (ResourceNode, crafting) will call
 * directly, without going through the pipeline — and the invitation to give negative XP without
 * an administrative reason must not depend on the caller remembering to
 * check it again.
 *
 * XP never goes negative: a decrement larger than the balance zeroes it instead of
 * throwing, because "staff took away too much XP by mistake" is a normal correction, not
 * a programming error.
 *
 * @param {object} opts
 * @param {number} opts.characterId
 * @param {string} opts.professionCode
 * @param {number} opts.amount integer, != 0
 * @param {string} [opts.context] where the gain came from (e.g. 'admin_adjust'; 'gather' in future phases)
 * @param {number|null} [opts.staffCharacterId] presence = administrative adjustment, allows a negative amount
 * @param {object} [dependencies]
 */
async function addProfessionXp(opts, dependencies = {}) {
  const deps = _deps(dependencies);
  const { characterId, professionCode, amount, staffCharacterId = null } = opts || {};

  if (!_isModuleEnabled(deps)) return { ok: false, code: 'module_disabled' };
  if (!_isPositiveInt(characterId)) return { ok: false, code: 'invalid_character' };
  if (!Number.isSafeInteger(amount) || amount === 0) return { ok: false, code: 'invalid_amount' };
  if (amount < 0 && !_isPositiveInt(staffCharacterId)) {
    return { ok: false, code: 'negative_requires_admin' };
  }

  // Practice counts for the skills system (skills-service.js maps the
  // profession code to a skill) whether or not the character also has a row
  // in the older profession table: a profession picked in the F3 menu has none,
  // and its crafting used to earn nothing. Staff corrections are not practice.
  if (amount > 0 && !_isPositiveInt(staffCharacterId)) {
    require('./core/skill-activity').report({ characterId, professionCode, amount, source: (opts && opts.context) || 'profession_xp' });
  }

  const conn = await deps.db.getConnection();
  try {
    await conn.beginTransaction();

    const [rows] = await conn.query(
      'SELECT id, status, xp FROM character_professions WHERE character_id = ? AND profession_code = ? FOR UPDATE',
      [characterId, professionCode]
    );
    const linha = rows[0] || null;

    if (!linha) {
      await conn.rollback();
      return { ok: false, code: 'not_found' };
    }
    if (linha.status !== STATUS.ACTIVE) {
      await conn.rollback();
      return { ok: false, code: 'not_active', data: { currentStatus: linha.status } };
    }

    const xpAnterior = Number(linha.xp);
    const xpNovo = Math.max(0, Math.min(MAX_XP, xpAnterior + amount));

    await conn.query('UPDATE character_professions SET xp = ? WHERE id = ?', [xpNovo, linha.id]);
    await conn.commit();

    return { ok: true, data: { previousXp: xpAnterior, xp: xpNovo, delta: xpNovo - xpAnterior } };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Player command — read only, only one's own sheet
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `/professions` — the player sees their own professions. No capability: it is not a
 * staff action, it is reading one's own sheet, the same way `/status` (in
 * `commands.js`) asks no permission for the player to see their own character.
 */
function commandDefs() {
  return [
    {
      name: ['/professions', '/profissoes'],
      description: 'Show your professions',
      usage: '/professions',
      handler: async (actorId) => {
        // `sendNotification` (not `mp.sendChatMessage`, which does not exist in this
        // API) is the gamemode's only individual notification path — see
        // commands.js. A lazy `require` for the same reason as the rest of the
        // file: commands.js registers this command, so importing it at the
        // top would close the cycle.
        const commands = require('./commands');
        const personagem = commands.getActiveCharacterData(actorId);
        if (!personagem) return;

        const estados = await getCharacterProfessions(personagem.characterId);
        if (estados.length === 0) {
          commands.sendNotification(actorId, '[Professions] You have no professions.');
          return;
        }
        const linhas = estados.map((estado) => {
          const prof = professionRegistry.get(estado.professionCode);
          const nome = prof ? prof.label : estado.professionCode;
          return `${nome} — status=${estado.status} rank=${estado.rank} xp=${estado.xp}`;
        });
        commands.sendNotification(actorId, `[Professions]\n${linhas.join('\n')}`);
      }
    }
  ];
}

module.exports = {
  MODULE_ID,
  STATUS,
  MAX_XP,
  getCharacterProfessions,
  getProfessionState,
  hasProfession,
  grantProfession,
  revokeProfession,
  suspendProfession,
  reactivateProfession,
  setProfessionRank,
  addProfessionXp,
  commandDefs,
  // Exposed only for tests.
  _rowToState
};
