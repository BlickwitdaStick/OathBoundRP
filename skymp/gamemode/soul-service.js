
/**
 * soul-service.js — Soul Affinity, service layer
 *
 * Finalized design: `docs/design/SOUL_AFFINITY.md`.
 * This file IMPLEMENTS that document; it does not reopen any of its decisions.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * The division of responsibilities with core/soul.js
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `core/soul.js` is the domain layer: a generator with a fixed budget,
 * bands, a seed, and resolution into four possible outcomes.
 *
 * It is a pure function — it does not open a database, interact with `mp`,
 * know that a game exists, or depend on anything outside its own domain.
 * This is why it has 28 tests.
 *
 * This file handles everything that interacts with the outside world:
 * it persists the soul, reveals signs, records marks, advances the
 * transformation tree, audits rolls, and feeds the panel.
 *
 * It never decides an outcome — it only asks the domain layer and
 * handles the consequences.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * The three rules this file must preserve
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * 1. **The player never sees numbers** (§II.1).
 *    There must be no path from this file to the UI that carries an affinity
 *    value, band, or seed. `buildPanelPayload` is the only payload producer,
 *    and a test scans the entire object for any of the seven values.
 *
 * 2. **The roll never says no** (§II.2).
 *    `resolveAttempt` has no return value that represents failure — it
 *    returns which of the four possible stories occurred.
 *
 * 3. **Every roll is auditable** (§14.3).
 *    Every resolution records `soul:resolve` with its inputs, weight,
 *    and outcome. Without this, accusations of favoritism cannot be
 *    disproved, and that is how roleplay servers die.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WARNING: Has not yet been run with a connected player
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Just like `hit-events`, `espm`, and `safe-zones`:
 * **confirmed by automated testing, not confirmed in a real session.**
 *
 * What only the client can prove — the sign appearing on the screen and
 * another player being able to read a mark — is covered by Step 9.4 of
 * `docs/technical/FASE_0_ROTEIRO.md`, which has not been executed.
 */

const db = require('./database');
const soul = require('./core/soul');
const commands = require('./commands');
const identity = require('./identity-service');
const panelRefreshBus = require('./core/panel-refresh-bus');
const { EventEmitter } = require('events');

const MODULE = 'soul';

// ─────────────────────────────────────────────────────────────────────────────
// Sign Catalog (§II.1, III.7)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The player receives *signs*, not values.
 *
 * Each key below represents an event that can already be interpreted
 * during the first session — identity, not power.
 *
 * The text lives here, while the key is stored in the database.
 * This follows the same rule as the mark `descriptor`, for two reasons:
 *
 * 1. A player's text never enters a field that another player can read.
 * 2. Rewriting a sentence does not require a database migration.
 *
 * Two sentences exist for each attribute — one for a high band and
 * one for a low band.
 *
 * Neither sentence says whether the attribute is good or bad.
 * Being "deaf" to Sensitivity ("You don't dream. You never have.")
 * is just as playable as being "rare", which is §14.4 appearing on the surface.
 */
const SIGN_CATALOG = Object.freeze({
  arcana_alta:          'Flames obey you a little too quickly.',
  arcana_baixa:         'Magic ignores you as though you were not there.',
  divina_alta:          'The priest watches you too closely and says nothing.',
  divina_baixa:         'You have entered three temples, and none of them seemed to notice.',
  sombria_alta:         'Candles go out on whichever side you sit.',
  sombria_baixa:        'The dead have nothing to tell you, and that is a relief.',
  bestial_alta:         'Dogs growl when you pass, and you do not know why.',
  bestial_baixa:        'No animal fears you. None seeks you out.',
  vontade_alta:         'You have said no to something that nobody else could refuse.',
  vontade_baixa:        'It is easier to agree. It always has been.',
  sensibilidade_alta:   'You hear conversations in empty rooms.',
  sensibilidade_baixa:  'You do not dream. You never have.',
  estabilidade_alta:    'What shakes others passes through you like the wind.',
  estabilidade_baixa:   'Some days, your own name sounds wrong in your mouth.'
});

// ─────────────────────────────────────────────────────────────────────────────
// Mark Catalog (§II.3, III.6)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * **Marks are progression.** There are no levels; there is only what
 * has been left behind in you.
 *
 * `visivel` (visible) works with `identity-service`: hiding a visible mark
 * is a legitimate reason to wear a hood.
 *
 * `sentida` (felt) is known only to its bearer until someone notices it.
 *
 * `conhecida` (known) has become part of the character's reputation.
 *
 * A person with many marks is clearly someone who has gone far —
 * narrative status, not numerical status, and not something that can
 * be farmed, because every mark required a scene.
 */
const MARK_CATALOG = Object.freeze({
  mao_fria:        { kind: 'fisica',     visibility: 'visivel',   text: 'The hand that forged that no longer grows warm.' },
  olhos_pálidos:   { kind: 'fisica',     visibility: 'visivel',   text: 'The color left your eyes and never returned.' },
  voz_dupla:       { kind: 'fisica',     visibility: 'visivel',   text: 'Sometimes another voice speaks beneath your own.' },
  sono_partido:    { kind: 'espiritual', visibility: 'sentida',   text: 'You wake three times every night, always at the same time.' },
  peso_no_peito:   { kind: 'espiritual', visibility: 'sentida',   text: 'Something rests on your chest that was not there before.' },
  nome_lembrado:   { kind: 'espiritual', visibility: 'sentida',   text: 'Someone you do not know repeats your name from far away.' },
  fama_de_risco:   { kind: 'social',     visibility: 'conhecida', text: 'Those who understand the matter know what you attempted.' },
  divida_de_favor: { kind: 'social',     visibility: 'conhecida', text: 'Someone paid part of the price for you, and has not forgotten.' }
});

/** Candidate marks for each affinity — the final choice is deterministic. */
const MARKS_BY_AFFINITY = Object.freeze({
  arcana:  ['mao_fria', 'sono_partido', 'fama_de_risco'],
  divina:  ['peso_no_peito', 'divida_de_favor', 'nome_lembrado'],
  sombria: ['olhos_pálidos', 'nome_lembrado', 'fama_de_risco'],
  bestial: ['voz_dupla', 'sono_partido', 'divida_de_favor']
});

// ─────────────────────────────────────────────────────────────────────────────
// Transformation Tree (§III.1, III.8)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One tree for each affinity, exactly as specified in §III.1.
 *
 * `irreversible: true` is what makes `consented_at` mandatory (§14.2).
 *
 * The first node in every tree is deliberately reversible:
 * it is the infection described in §II.6, which **never resolves anything
 * on its own**.
 *
 * It opens a window in which the player can choose to seek a cure,
 * hide the condition, or accept it.
 *
 * This is the alternative to the bite's VETO with a 70% death chance,
 * and the reason the bite cannot be an irreversible node.
 */
const TREES = Object.freeze({
  arcana: [
    { node: 'alteracao', irreversible: false },
    { node: 'ritual', irreversible: false },
    { node: 'arquimago', irreversible: true }
  ],
  divina: [
    { node: 'bencaos', irreversible: false },
    { node: 'milagres', irreversible: false },
    { node: 'santo', irreversible: true }
  ],
  sombria: [
    { node: 'infeccao', irreversible: false },
    { node: 'vampirismo', irreversible: true },
    { node: 'necromancia', irreversible: true },
    { node: 'lorde_vampiro', irreversible: true }
  ],
  bestial: [
    { node: 'infeccao', irreversible: false },
    { node: 'licantropia', irreversible: true },
    { node: 'totens', irreversible: true },
    { node: 'alfa', irreversible: true },
    { node: 'lobo_ancestral', irreversible: true }
  ]
});

/**
 * Nodes that governance classifies as crimes.
 *
 * `soul.path.advanced` is emitted for anyone who wants to listen.
 * `governance-service` will connect to this event when the crime system
 * is designed (§III.9).
 *
 * Here, it is only data, not a consequence — classifying something as
 * a crime is a governance decision, not the responsibility of this layer.
 */
const CRIMINAL_NODES = Object.freeze(['vampirismo', 'necromancia', 'lorde_vampiro']);

// ─────────────────────────────────────────────────────────────────────────────
// In-Memory State
// ─────────────────────────────────────────────────────────────────────────────

/** characterId -> { seed, values } — avoids reloading the soul for every resolution. */
const _soulCache = new Map();

/**
 * A small, dedicated, explicitly named event bus — following the pattern
 * used by `panel-refresh-bus`, rather than creating a generic channel in
 * `module-registry`.
 *
 * That generalization was evaluated and deliberately postponed.
 * See the header of `core/module-registry.js`.
 */
const _emitter = new EventEmitter();
_emitter.setMaxListeners(20);

let _secret = null;

// ─────────────────────────────────────────────────────────────────────────────
// Lifecycle
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The server secret comes from the environment and is read during boot,
 * not during `require`.
 *
 * **Without it, the module does not start.**
 *
 * Failing loudly here is deliberate: deriving a soul using an empty secret
 * would produce souls that anyone could recalculate from the character sheet,
 * which is publicly visible in the panel.
 *
 * This is the same lesson as the `.env` file that nobody was loading:
 * the failure mode must point toward the safe option.
 *
 * The damage would be silent and permanent because the soul is frozen
 * at the character's first spawn.
 */
async function initSoulService() {
  _secret = process.env.SOUL_SECRET || null;
  if (!_secret) {
    throw new Error(
      '[soul] SOUL_SECRET is missing. The soul is derived using HMAC(secret, character sheet) — without a secret, ' +
      'anyone can calculate any character\'s soul from their public character sheet. ' +
      'Set SOUL_SECRET in skymp/gamemode/.env before enabling ENABLE_SOUL_SERVICE.'
    );
  }
  _soulCache.clear();
  console.log('[soul] Soul Affinity service started.');
}

function shutdownSoulService() {
  _soulCache.clear();
  _emitter.removeAllListeners();
  _secret = null;
}

/**
 * Clears a character's cached soul upon disconnection.
 *
 * The cache is keyed by characterId, not actorId, so it does not suffer
 * from the slot-reuse problem that affected `staffCache` and `_lastHealth`.
 *
 * It still needs to be cleared: a cache that only grows is a memory leak.
 *
 * The soul does not change between sessions, so reloading it on the next
 * login costs one database query and prevents stale data from being served
 * if staff modifies the character sheet.
 */
function cleanup(characterId) {
  _soulCache.delete(characterId);
}

// ─────────────────────────────────────────────────────────────────────────────
// The Soul
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ensures that the character has a soul, deriving it from the approved
 * character sheet.
 *
 * Idempotent and **immutable**: once saved, the soul is never derived again.
 *
 * If staff edits the character sheet afterward — which the panel allows —
 * deriving the soul again would change the soul of someone who may have
 * played with it for months, without warning.
 *
 * Persisting it at the first spawn is the only behavior compatible with
 * the principle that "marks are progression."
 *
 * @param {number} characterId
 * @returns {Promise<{seed: string, values: Object}|null>}
 */
async function ensureSoul(characterId) {
  if (_soulCache.has(characterId)) return _soulCache.get(characterId);

  const existentes = await db.query(
    `SELECT soul_seed, arcana, divina, sombria, bestial, vontade, sensibilidade, estabilidade
     FROM character_soul WHERE character_id = ?`,
    [characterId]
  );

  if (existentes.length > 0) {
    const linha = existentes[0];
    const registro = {
      seed: linha.soul_seed,
      values: {
        arcana: linha.arcana, divina: linha.divina, sombria: linha.sombria, bestial: linha.bestial,
        vontade: linha.vontade, sensibilidade: linha.sensibilidade, estabilidade: linha.estabilidade
      }
    };
    _soulCache.set(characterId, registro);
    return registro;
  }

  const fichas = await db.query(
    'SELECT motivations, weaknesses, social_ties FROM characters WHERE id = ?',
    [characterId]
  );
  if (fichas.length === 0) {
    console.error(`[soul] Character ${characterId} does not exist — soul was not derived.`);
    return null;
  }
  const ficha = fichas[0];

  const seed = soul.deriveSeed(_secret, characterId, {
    motivations: ficha.motivations,
    weaknesses: ficha.weaknesses,
    socialTies: ficha.social_ties
  });
  const values = soul.generateSoul(seed);

  // `INSERT IGNORE`: two concurrent spawns of the same character could
  // arrive here at the same time. The second write must not overwrite
  // the first.
  //
  // The primary key is character_id, so the database handles this.
  await db.query(
    `INSERT IGNORE INTO character_soul
       (character_id, soul_seed, arcana, divina, sombria, bestial, vontade, sensibilidade, estabilidade)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [characterId, seed, values.arcana, values.divina, values.sombria, values.bestial,
     values.vontade, values.sensibilidade, values.estabilidade]
  );

  const registro = { seed, values };
  _soulCache.set(characterId, registro);
  console.log(`[soul] Soul derived for character ${characterId}.`);
  return registro;
}

// ─────────────────────────────────────────────────────────────────────────────
// Signs
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Chooses the soul's most characteristic sign.
 *
 * "Most characteristic" means the attribute whose band is **farthest
 * from `comum` (common)** — what makes the character most different
 * from the rest of the world, and therefore what is worth interpreting.
 *
 * Ties are resolved using the fixed attribute order, not a random roll.
 * Two characters with the same soul must receive the same sign; otherwise,
 * the sign would no longer be reproducible and would violate §14.3.
 */
function _chooseSign(values) {
  const COMUM = soul.BANDS.indexOf('comum');
  const atributos = [...soul.AFFINITIES, ...soul.TRAITS];

  let escolhido = atributos[0];
  let maiorDistancia = -1;

  for (const attr of atributos) {
    const distancia = Math.abs(soul.bandIndex(values[attr]) - COMUM);
    if (distancia > maiorDistancia) {
      maiorDistancia = distancia;
      escolhido = attr;
    }
  }

  const alto = soul.bandIndex(values[escolhido]) >= COMUM;
  return `${escolhido}_${alto ? 'alta' : 'baixa'}`;
}

/**
 * Reveals a sign and delivers it to the player.
 *
 * **Every character receives their first sign during their first session**
 * (§II.1).
 *
 * This is not power: it is identity.
 *
 * It solves the most dangerous problem for a roleplay server, which is
 * not balance — it is having an empty first hour.
 *
 * @returns {Promise<string|null>} the revealed key, or null if the character already had it
 */
async function revealSign(characterId, signKey, source = 'first_spawn') {
  if (!SIGN_CATALOG[signKey]) {
    console.error(`[soul] Unknown sign '${signKey}' — nothing revealed.`);
    return null;
  }

  const jaTem = await db.query(
    'SELECT id FROM character_signs WHERE character_id = ? AND sign_key = ?',
    [characterId, signKey]
  );
  if (jaTem.length > 0) return null;

  await db.query(
    'INSERT INTO character_signs (character_id, sign_key, source) VALUES (?, ?, ?)',
    [characterId, signKey, source]
  );

  const actorId = commands.getActiveActorByCharacterId(characterId);
  if (actorId) {
    commands.sendNotification(actorId, SIGN_CATALOG[signKey]);
    panelRefreshBus.requestRefresh(actorId, 'social');
  }

  _emitter.emit('soul.sign.revealed', { characterId, signKey, source });
  console.log(`[soul] Sign '${signKey}' revealed for character ${characterId} (${source}).`);
  return signKey;
}

/**
 * Entry point for the first spawn: ensures the soul exists and delivers
 * the first sign.
 *
 * Idempotent — calling this again does not reveal a second sign.
 */
async function onFirstSpawn(characterId) {
  const registro = await ensureSoul(characterId);
  if (!registro) return null;
  return revealSign(characterId, _chooseSign(registro.values), 'first_spawn');
}

// ─────────────────────────────────────────────────────────────────────────────
// Marks
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Records a mark.
 *
 * A mark is **never removed** — at most, it can be covered up, which is
 * also playable and costly.
 *
 * For this reason, there is no `removeMark`.
 */
async function createMark(characterId, descriptor, originEventId = null) {
  const catalogo = MARK_CATALOG[descriptor];
  if (!catalogo) {
    console.error(`[soul] Unknown mark '${descriptor}' — nothing recorded.`);
    return null;
  }

  await db.query(
    'INSERT INTO character_marks (character_id, kind, visibility, descriptor, origin_event_id) VALUES (?, ?, ?, ?, ?)',
    [characterId, catalogo.kind, catalogo.visibility, descriptor, originEventId]
  );

  const actorId = commands.getActiveActorByCharacterId(characterId);
  if (actorId) {
    commands.sendNotification(actorId, catalogo.text);
    panelRefreshBus.requestRefresh(actorId, 'social');
  }

  _emitter.emit('soul.mark.created', { characterId, descriptor, ...catalogo });
  console.log(`[soul] Mark '${descriptor}' recorded for character ${characterId} (event ${originEventId || 'no origin'}).`);
  return descriptor;
}

/**
 * Marks that an observer can perceive on a target.
 *
 * WARNING: **Identity Firewall** (§III.12, test 8).
 *
 * Only marks with `visivel` (visible) are returned from here, and the
 * bearer's name is processed through `identity-service`.
 *
 * Anyone who does not know the bearer sees `Unknown`.
 *
 * Without this, a mark could leak a character's real name through a path
 * that `identity-service` does not control.
 *
 * This is exactly the defect that caused `disguise-service` to be deleted.
 *
 * Descriptors are catalog keys and never contain anyone's name.
 * This makes the leak impossible by design, rather than relying on
 * code review to catch it.
 */
async function describeVisibleMarks(observerCharacterId, targetCharacterId) {
  const linhas = await db.query(
    `SELECT descriptor FROM character_marks
     WHERE character_id = ? AND visibility = 'visivel'
     ORDER BY created_at ASC`,
    [targetCharacterId]
  );

  const observador = observerCharacterId ? { characterId: observerCharacterId } : null;
  const alvo = { characterId: targetCharacterId };
  const nome = identity.getDisplayName(observador, alvo);

  return {
    portador: nome,
    marcas: linhas
      .filter(l => MARK_CATALOG[l.descriptor])
      .map(l => MARK_CATALOG[l.descriptor].text)
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolution
// ─────────────────────────────────────────────────────────────────────────────

/** Pressure window (§III.5). Repeated attempts do not converge toward a clean result; they converge toward a mark. */
const PRESSURE_WINDOW_MINUTES = 60;

/**
 * Resolves an attempt connected to the soul and handles its consequences.
 *
 * **It never returns failure.**
 *
 * It returns which of the four possible stories occurred:
 * clean, costly, complicated, or marked — and all four are successful.
 *
 * This is §II.2, and it is what separates this system from a locked door.
 *
 * @param {object} p
 * @param {number} p.characterId
 * @param {string} p.affinity      which affinity governs the action
 * @param {string} p.eventId       identifies the action; used in the roll and audit
 * @param {number} [p.circumstance] master present, correct component, consecrated location
 * @param {number} [p.difficulty]   difficulty of the action
 * @returns {Promise<{outcome: string, mark: string|null}|null>}
 */
async function resolveAttempt({ characterId, affinity, eventId, circumstance = 0, difficulty = 0 }) {
  const registro = await ensureSoul(characterId);
  if (!registro) return null;

  // Pressure is derived from the audit log itself: how many times this
  // character attempted this same action during the last hour.
  //
  // Reading from the log instead of maintaining an in-memory counter is
  // deliberate. An in-memory counter resets when the server restarts,
  // and "restart the server to clear pressure" would be an exploit
  // created by the implementation.
  const tentativas = await db.query(
    `SELECT COUNT(*) AS n FROM audit_logs
     WHERE action = 'soul:resolve'
       AND details LIKE ?
       AND created_at >= NOW() - INTERVAL ? MINUTE`,
    [`%"characterId":${characterId},%"eventId":"${eventId}"%`, PRESSURE_WINDOW_MINUTES]
  );
  const anteriores = Number(tentativas[0]?.n || 0);
  const pressure = soul.pressureFrom(anteriores);

  const resultado = soul.resolve({
    soul: registro.values,
    affinity,
    seed: registro.seed,
    eventId,
    attempt: anteriores,
    circumstance,
    difficulty,
    pressure
  });

  // ── Audit (§14.3) ──────────────────────────────────────────────────────────
  //
  // The seed is NOT stored here, and this is a security decision, not a
  // space-saving measure.
  //
  // The panel's `GET /api/audit` endpoint returns the entire `details` object
  // to any staff member in the browser.
  //
  // Storing the seed there would expose it outside the server — and with
  // the public code in this repository, anyone could reproduce ALL future
  // rolls for that character, not just the one being challenged.
  //
  // Reproduction is still possible, as required by §14.3:
  // the seed is in `character_soul`, accessible to anyone with database
  // access, and the fingerprint below proves which soul was used without
  // revealing the soul itself.
  const character = await db.query('SELECT account_id FROM characters WHERE id = ?', [characterId]);
  await db.query(
    'INSERT INTO audit_logs (action, actor_account_id, target_account_id, details) VALUES (?, ?, ?, ?)',
    [
      'soul:resolve', null, character[0]?.account_id || null,
      JSON.stringify({
        characterId,
        eventId,
        outcome: resultado.outcome,
        weight: resultado.weight,
        roll: resultado.roll,
        inputs: resultado.inputs,
        seedRef: registro.seed.slice(0, 8),
        modulo: MODULE
      })
    ]
  );

  // ── Consequence ────────────────────────────────────────────────────────────
  let mark = null;
  if (resultado.outcome === 'marcado') {
    // The mark is selected deterministically by the roll itself:
    // the same soul attempting the same action on the same attempt
    // receives the same mark.
    //
    // Otherwise, the result would no longer be reproducible by staff.
    const candidatas = MARKS_BY_AFFINITY[affinity];
    const escolhida = candidatas[Math.floor(resultado.roll * candidatas.length) % candidatas.length];
    mark = await createMark(characterId, escolhida, eventId);
  }

  _emitter.emit('soul.resolved', { characterId, ...resultado, mark });

  const actorId = commands.getActiveActorByCharacterId(characterId);
  if (actorId) panelRefreshBus.requestRefresh(actorId, 'social');

  return { outcome: resultado.outcome, mark };
}

// ─────────────────────────────────────────────────────────────────────────────
// Transformation Tree
// ─────────────────────────────────────────────────────────────────────────────

/** The character's current state in a tree, or null if they have never entered it. */
async function getPath(characterId, tree) {
  const linhas = await db.query(
    'SELECT tree, node, entered_at, consented_at FROM character_paths WHERE character_id = ? AND tree = ?',
    [characterId, tree]
  );
  return linhas[0] || null;
}

/**
 * Advances the character by one node in the tree.
 *
 * **An irreversible node refuses to advance without consent** (§14.2,
 * and required test 6).
 *
 * This implements the alternative to the bite's VETO with a 70% death
 * chance: no single event determines a character's fate, and permanently
 * changing another character's soul without consent is the supernatural
 * equivalent of RDM.
 *
 * The first node in every tree is always reversible.
 * It represents the infection, which opens a window of choice
 * (seek a cure / hide it / accept it) rather than resolving anything.
 *
 * @param {object} p
 * @param {number}  p.characterId
 * @param {string}  p.tree
 * @param {boolean} [p.consent] explicit player consent
 * @returns {Promise<{node: string, blocked?: string}|null>}
 */
async function advancePath({ characterId, tree, consent = false }) {
  const trilha = TREES[tree];
  if (!trilha) {
    console.error(`[soul] Unknown tree '${tree}'.`);
    return null;
  }

  const atual = await getPath(characterId, tree);
  const indiceAtual = atual ? trilha.findIndex(n => n.node === atual.node) : -1;
  const proximo = trilha[indiceAtual + 1];

  if (!proximo) return { node: atual ? atual.node : trilha[0].node, blocked: 'fim_da_arvore' };

  if (proximo.irreversible && !consent) {
    // A silent refusal would be worse than having no rule at all:
    // the player needs to know that a door exists and that opening it
    // requires an explicit decision.
    //
    // This is A.3 of the Appendix — a warning before an irreversible action.
    const actorId = commands.getActiveActorByCharacterId(characterId);
    if (actorId) {
      commands.sendNotification(actorId, 'This step cannot be undone. It will only happen if you explicitly agree.');
    }
    console.log(`[soul] Character ${characterId} blocked at '${proximo.node}' (${tree}): consent not provided.`);
    return { node: atual ? atual.node : null, blocked: 'consentimento_ausente' };
  }

  await db.query(
    `INSERT INTO character_paths (character_id, tree, node, consented_at)
     VALUES (?, ?, ?, ${proximo.irreversible ? 'NOW()' : 'NULL'})
     ON DUPLICATE KEY UPDATE
       node = VALUES(node),
       entered_at = NOW(),
       consented_at = ${proximo.irreversible ? 'NOW()' : 'consented_at'}`,
    [characterId, tree, proximo.node]
  );

  _emitter.emit('soul.path.advanced', {
    characterId, tree, node: proximo.node,
    irreversible: proximo.irreversible,
    // Governance classifies necromancy and vampirism as crimes —
    // turning a hunt into a legal process rather than a lynching (§III.9).
    //
    // This layer only emits the data; classification is its decision.
    criminal: CRIMINAL_NODES.includes(proximo.node)
  });

  if (indiceAtual === -1 && !proximo.irreversible) {
    _emitter.emit('soul.infection.started', { characterId, tree, node: proximo.node });
  }

  const actorId = commands.getActiveActorByCharacterId(characterId);
  if (actorId) panelRefreshBus.requestRefresh(actorId, 'social');

  console.log(`[soul] Character ${characterId} advanced to '${proximo.node}' in ${tree}.`);
  return { node: proximo.node };
}

// ─────────────────────────────────────────────────────────────────────────────
// Panel
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Payload for the Social tab.
 *
 * WARNING: **This is the test that protects the entire system**
 * (§III.12, item 7, "write first").
 *
 * Nothing here may contain an affinity value, band, or seed.
 *
 * The player receives sentences — signs they have already read, marks
 * they carry, and their current position in each transformation tree.
 *
 * Numbers belong to the server; the fiction belongs to the player.
 *
 * If someone adds a numerical field, the test scans the entire object
 * and fails.
 *
 * The rule does not depend on code review remembering to enforce it.
 */
async function buildPanelPayload(characterId) {
  const [sinais, marcas, trilhas] = await Promise.all([
    db.query('SELECT sign_key FROM character_signs WHERE character_id = ? ORDER BY revealed_at ASC', [characterId]),
    db.query('SELECT descriptor FROM character_marks WHERE character_id = ? ORDER BY created_at ASC', [characterId]),
    db.query('SELECT tree, node FROM character_paths WHERE character_id = ?', [characterId])
  ]);

  return {
    sinais: sinais.map(s => SIGN_CATALOG[s.sign_key]).filter(Boolean),
    marcas: marcas
      .filter(m => MARK_CATALOG[m.descriptor])
      .map(m => ({ texto: MARK_CATALOG[m.descriptor].text, visibilidade: MARK_CATALOG[m.descriptor].visibility })),
    caminhos: trilhas.map(t => ({ arvore: t.tree, no: t.node }))
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Events and Commands
// ─────────────────────────────────────────────────────────────────────────────

function onSoulEvent(evento, handler) { _emitter.on(evento, handler); }
function offSoulEvent(evento, handler) { _emitter.off(evento, handler); }

function commandDefs() {
  return [
    {
      name: ['/soul', '/alma'],
      description: 'Shows what your character knows about their own soul — signs, marks, and path',
      usage: '/soul',
      handler: (actorId) => {
        const character = commands.getActiveCharacterData(actorId);
        if (!character) return;
        buildPanelPayload(character.characterId)
          .then(payload => {
            // This command is for players who have not opened the panel.
            // It provides the same content and follows the same rule:
            // sentences, never numbers.
            if (payload.sinais.length === 0 && payload.marcas.length === 0) {
              commands.sendNotification(actorId, 'You do not know anything about yourself yet.');
              return;
            }
            for (const frase of payload.sinais) commands.sendNotification(actorId, frase);
            for (const marca of payload.marcas) commands.sendNotification(actorId, marca.texto);
          })
          .catch(err => console.error('[soul] Failed to build /soul:', err.message));
      }
    }
  ];
}

module.exports = {
  commandDefs,
  initSoulService,
  shutdownSoulService,
  cleanup,
  ensureSoul,
  onFirstSpawn,
  revealSign,
  createMark,
  describeVisibleMarks,
  resolveAttempt,
  getPath,
  advancePath,
  buildPanelPayload,
  onSoulEvent,
  offSoulEvent,
  SIGN_CATALOG,
  MARK_CATALOG,
  TREES,
  // Exposed only for testing: sign selection is deterministic and must
  // be testable without a database.
  _chooseSign,
  _soulCache
};
