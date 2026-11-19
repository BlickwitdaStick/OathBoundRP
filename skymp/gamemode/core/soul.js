/**
 * core/soul.js — Soul Affinity, domain layer
 *
 * Full design: `docs/design/SOUL_AFFINITY.md`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Why this file exists now, if the system is blocked by Phase 0
 * ─────────────────────────────────────────────────────────────────────────────
 * The design says nothing in Soul Affinity becomes code before the
 * in-game test. That applies to the **service** — what talks to the world, delivers
 * signs, records marks and advances trees.
 *
 * It does not apply to the **domain**. This module is a pure function: it does not open the DB, does not
 * touch `mp`, has no side effects and does not know a game exists. It is
 * provable entirely outside the server, and it is exactly the piece where being wrong
 * costs the most later — a skewed distribution or a roll that fails only
 * shows up with hundreds of players, when fixing it already means tampering with the
 * soul of people who are attached to their characters.
 *
 * It is also the separation Constitution §13 asks for between domain and
 * infrastructure, done for real and not as a diagram.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * The three non-negotiable rules (Constitution §8, amendment v1.1)
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. No soul is strictly better than another. Guaranteed here by a
 *    FIXED BUDGET: a high affinity forces another to be low. It does not depend on the
 *    good will of whoever writes content two years from now.
 * 2. The die never says no. `resolve()` returns one of four outcomes, and all
 *    four succeed. There is no return path that means failure.
 * 3. Every roll is auditable. Everything here is deterministic from the seed,
 *    and `resolve()` returns the inputs along with the result so staff
 *    can reproduce any disputed outcome.
 */

const crypto = require('crypto');

// ─────────────────────────────────────────────────────────────────────────────
// Vocabulary
// ─────────────────────────────────────────────────────────────────────────────

/** One per transformation tree. */
const AFFINITIES = Object.freeze(['arcana', 'divina', 'sombria', 'bestial']);

/** How the character bears the cost of what they attempted. */
const TRAITS = Object.freeze(['vontade', 'sensibilidade', 'estabilidade']);

/**
 * The player never sees a number. Resolution does not use the raw number either — it uses
 * the band. Having only five steps is what keeps the system from becoming a spreadsheet:
 * the difference between 61 and 63 does not exist for anyone.
 */
const BANDS = Object.freeze(['surdo', 'fraco', 'comum', 'forte', 'raro']);

/** The four outcomes. ALL of them succeed — see rule 2 at the top. */
const OUTCOMES = Object.freeze(['limpo', 'caro', 'complicado', 'marcado']);

/**
 * Fixed budgets. They are the mechanical guarantee of rule 1.
 *
 * 200 across 4 affinities = average 50. For someone to roll `raro` (85+) in Arcana,
 * the other three must add up to 115 — that is, they end up below average. There is no
 * way to be good at everything, and that is not a balancing choice someone
 * could undo without noticing: it is arithmetic.
 */
const AFFINITY_BUDGET = 200;
const TRAIT_BUDGET = 150;

/**
 * Band boundaries. Concentrated in the middle on purpose: almost everyone is
 * `comum` (common) in almost everything, which is what makes `raro` (rare) mean something.
 */
const BAND_BOUNDS = Object.freeze([
  { band: 'surdo', max: 14 },
  { band: 'fraco', max: 34 },
  { band: 'comum', max: 64 },
  { band: 'forte', max: 84 },
  { band: 'raro', max: 100 }
]);

// ─────────────────────────────────────────────────────────────────────────────
// Deterministic randomness
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A counter-based generator, not a sequential one: each value comes from `HMAC(seed, label:n)`.
 *
 * Chosen over a stateful PRNG for two reasons that matter here:
 * reproducing an old result does not require reproducing the whole sequence that
 * came before (staff need to audit ONE roll, not replay months of
 * play), and streams with different labels are independent — changing trait
 * generation does not shift affinity generation.
 *
 * @param {string} seed  seed in hexadecimal
 * @param {string} label independent stream ('afinidades', 'tracos', 'resolve')
 */
function stream(seed, label) {
  let counter = 0;
  return function next() {
    const mac = crypto.createHmac('sha256', Buffer.from(String(seed), 'utf8'));
    mac.update(`${label}:${counter++}`);
    // 4 bytes are enough: 2^32 distinct values is a resolution far above what
    // anything here uses.
    return mac.digest().readUInt32BE(0) / 0x1_0000_0000;
  };
}

/**
 * Sum of three uniforms: a bell distribution, cheap and with no dependency.
 * It is what makes the middle common and the extremes rare even before
 * normalization.
 */
function bell(next) {
  return (next() + next() + next()) / 3;
}

// ─────────────────────────────────────────────────────────────────────────────
// Semente
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The soul comes from the approved character sheet, never from chance.
 *
 * That kills reroll-farming (same sheet, same soul — killing the character and
 * recreating the same concept changes nothing) and makes the whitelist application count
 * mechanically, which improves sheet quality without needing a new
 * rule.
 *
 * ⚠️ THE SECRET NEVER LEAVES THE SERVER. The sheet is public: without a secret, anyone
 * could compute any character's soul from what is written
 * in the panel, and the whole system would stop being hidden. The secret is passed
 * as an argument — this module does not read the environment, because the domain does not know
 * infrastructure.
 *
 * @param {string} secret        SOUL_SECRET, coming from outside
 * @param {number} characterId
 * @param {{motivations?: string, weaknesses?: string, socialTies?: string}} ficha  the character sheet
 * @returns {string} hex seed
 */
function deriveSeed(secret, characterId, ficha = {}) {
  if (!secret || typeof secret !== 'string') {
    throw new Error('soul: server secret missing — the soul cannot be derived without it');
  }
  if (!Number.isInteger(characterId) || characterId <= 0) {
    throw new Error(`soul: characterId invalido (${characterId})`);
  }

  // Normalize before signing: an extra space, uppercase or an accent must not
  // produce a different soul for the same approved sheet.
  const normalize = (texto) => String(texto || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

  // The separator is NUL (U+0000), not a space, and the choice is about security: NUL
  // does not survive the `normalize()` above (which collapses whitespace and trims
  // the ends), so no player can write it in the sheet. Without a
  // separator that is impossible to type, moving a letter from one field to the next
  // would produce the SAME signed material -- 'ab'+'c' and 'a'+'bc' -- and two
  // different sheets would be born with the same soul.
  //
  // It was written as a RAW NUL in the source until 2026-08-06. It worked, but it was
  // invisible: the whole file counted as binary for `grep` and `file`,
  // and whoever read this line saw `].join('');` and would conclude the fields are
  // concatenated with no separator at all. Worse: any editor that strips
  // control characters on save would change the seed of EVERY soul already
  // derived, without any error showing up.
  const SEPARADOR_DE_CAMPO = '\u0000';

  const material = [
    characterId,
    normalize(ficha.motivations),
    normalize(ficha.weaknesses),
    normalize(ficha.socialTies)
  ].join(SEPARADOR_DE_CAMPO);

  return crypto.createHmac('sha256', secret).update(material).digest('hex');
}

// ─────────────────────────────────────────────────────────────────────────────
// Generation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Splits `budget` across `keys`, keeping the sum exact and every value in
 * [0, 100].
 *
 * Rounding is done by largest remainder: normalizing and rounding each value
 * in isolation would produce wrong sums, and a wrong sum silently breaks rule 1
 * — which is the worst way to break it.
 */
function distribute(keys, budget, next) {
  const raw = keys.map(() => bell(next));
  const total = raw.reduce((a, b) => a + b, 0) || 1;

  const exact = raw.map(v => (v / total) * budget);
  const floors = exact.map(v => Math.min(100, Math.floor(v)));

  let restante = budget - floors.reduce((a, b) => a + b, 0);

  // The leftover goes to whoever has the largest remainder, respecting the cap of 100.
  const ordem = exact
    .map((v, i) => ({ i, resto: v - Math.floor(v) }))
    .sort((a, b) => b.resto - a.resto);

  let volta = 0;
  while (restante > 0 && volta < keys.length * 100) {
    for (const { i } of ordem) {
      if (restante === 0) break;
      if (floors[i] < 100) {
        floors[i] += 1;
        restante -= 1;
      }
    }
    volta += 1;
  }

  const alma = {};
  keys.forEach((k, i) => { alma[k] = floors[i]; });
  return alma;
}

/**
 * Generates the soul from the seed. Deterministic: same seed, same soul,
 * across runs and across processes.
 *
 * @param {string} seed
 * @returns {Object} seven values — four affinities and three traits
 */
function generateSoul(seed) {
  if (!seed || typeof seed !== 'string') {
    throw new Error('soul: invalid seed');
  }
  return {
    ...distribute(AFFINITIES, AFFINITY_BUDGET, stream(seed, 'afinidades')),
    ...distribute(TRAITS, TRAIT_BUDGET, stream(seed, 'tracos'))
  };
}

/** Translates a raw value into its band. It is the only way to look at the soul from here on. */
function band(value) {
  const n = Math.max(0, Math.min(100, Number(value) || 0));
  for (const { band: nome, max } of BAND_BOUNDS) {
    if (n <= max) return nome;
  }
  return 'raro';
}

/** Numeric index of the band (0–4), to go into the weight math. */
function bandIndex(value) {
  return BANDS.indexOf(band(value));
}

/**
 * Resistance to corruption — a DERIVED value, not a stored one.
 *
 * The original proposal had this as an eighth attribute. It overlapped Will and
 * Stability almost entirely, and an extra knob is not depth: it is one more
 * dimension to balance and to explain, with nothing in return.
 *
 * Will weighs more than Stability on purpose: resisting being changed is
 * more refusal than balance.
 */
function corruptionResistance(soul) {
  return Math.round((soul.vontade * 0.6) + (soul.estabilidade * 0.4));
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolution
// ─────────────────────────────────────────────────────────────────────────────

const PESO_MIN = -4;
const PESO_MAX = 6;

/**
 * Weights of the four outcomes as a function of `peso` (weight).
 *
 * **No weight is zero at any point of the scale.** That is deliberate and it is what
 * separates this system from a table: the gifted can still be marked on a bad
 * day, and someone with no gift at all can still have a clean moment — which is the
 * story that person will tell for the rest of the character's life.
 *
 * If any of these reached zero, the experienced player would know the outcome
 * before trying, and then there would be no tension at all.
 */
function outcomeWeights(peso) {
  const p = Math.max(PESO_MIN, Math.min(PESO_MAX, peso));
  const t = (p - PESO_MIN) / (PESO_MAX - PESO_MIN); // 0 = pior, 1 = melhor

  return {
    limpo:      2 + 60 * Math.pow(t, 2),
    caro:       10 + 30 * Math.sin(Math.PI * t),
    complicado: 8 + 40 * (1 - t),
    marcado:    2 + 45 * Math.pow(1 - t, 2)
  };
}

/**
 * Resolves an attempt tied to the soul.
 *
 * **Never returns failure.** It returns which of the four stories you got.
 *
 * @param {Object}  params
 * @param {Object}  params.soul
 * @param {string}  params.affinity      which affinity governs the act
 * @param {string}  params.seed          the soul's seed
 * @param {string}  params.eventId       identifies the act; it goes into the roll
 * @param {number} [params.attempt]      attempt in this window (0 = first)
 * @param {number} [params.circumstance] master, component, place, preparation
 * @param {number} [params.difficulty]   difficulty of the act
 * @param {number} [params.pressure]     see `pressureFrom`
 * @returns {{outcome: string, peso: number, roll: number, inputs: Object}}
 *          `inputs` exists to go straight into the audit log: without the inputs
 *          recorded, staff cannot reproduce it and an accusation of
 *          favoritism becomes unfalsifiable.
 */
function resolve({
  soul, affinity, seed, eventId,
  attempt = 0, circumstance = 0, difficulty = 0, pressure = 0
}) {
  if (!soul || typeof soul !== 'object') throw new Error('soul: missing soul');
  if (!AFFINITIES.includes(affinity)) {
    throw new Error(`soul: unknown affinity '${affinity}' — use one of ${AFFINITIES.join(', ')}`);
  }
  if (!seed) throw new Error('soul: missing seed');
  if (!eventId) throw new Error('soul: missing eventId — without it the roll is not auditable');

  const peso = bandIndex(soul[affinity]) + circumstance - difficulty - pressure;

  const next = stream(seed, `resolve:${eventId}:${attempt}`);
  const roll = next();

  const weights = outcomeWeights(peso);
  const total = OUTCOMES.reduce((soma, o) => soma + weights[o], 0);

  let acumulado = 0;
  let outcome = OUTCOMES[OUTCOMES.length - 1];
  for (const o of OUTCOMES) {
    acumulado += weights[o] / total;
    if (roll < acumulado) { outcome = o; break; }
  }

  return {
    outcome,
    peso,
    roll,
    inputs: { affinity, banda: band(soul[affinity]), circumstance, difficulty, pressure, attempt, eventId }
  };
}

/**
 * Pressure from the number of recent attempts at the same act.
 *
 * Without this the exploit is trivial: try a hundred times until `limpo` (clean) comes up. With this,
 * insisting does not converge to a clean success — it converges to marks.
 *
 * It is anti-exploit without having to say "no" to the player, and it is honest with the
 * fiction: whoever forces the same thing many times ends up paying for it in the
 * body. The cap exists so pressure does not become a second closed door.
 */
function pressureFrom(recentAttempts) {
  const n = Math.max(0, Number(recentAttempts) || 0);
  return Math.min(4, Math.floor(n / 2));
}

module.exports = {
  AFFINITIES,
  TRAITS,
  BANDS,
  OUTCOMES,
  AFFINITY_BUDGET,
  TRAIT_BUDGET,
  deriveSeed,
  generateSoul,
  band,
  bandIndex,
  corruptionResistance,
  outcomeWeights,
  resolve,
  pressureFrom
};
