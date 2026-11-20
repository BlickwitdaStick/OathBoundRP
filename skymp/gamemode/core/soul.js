/**
 * core/soul.js — Soul Affinity, domain layer
 *
 * Complete design: `docs/design/SOUL_AFFINITY.md`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Why this file exists now, even though the system is blocked by Phase 0
 * ─────────────────────────────────────────────────────────────────────────────
 * The design says that no part of Soul Affinity becomes code before the
 * in-game test. That applies to the **service** — the part that interacts with
 * the world, delivers signals, records marks, and advances trees.
 *
 * It does not apply to the **domain**. This module consists of pure functions:
 * it does not open a database, touch `mp`, have side effects, or know that a
 * game exists. It can probably be tested entirely outside the server, and
 * this is exactly the part where mistakes become most costly later — biased
 * distributions or rolls that fail may only become apparent with hundreds of
 * players, when fixing them means changing the souls of characters players
 * care about.
 *
 * It also implements, rather than merely diagramming, the separation between
 * domain and infrastructure required by Constitution §13.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * The three non-negotiable rules (Constitution §8, amendment v1.1)
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. No soul is strictly better than another. This is guaranteed here by a
 *    FIXED BUDGET: a high affinity requires another to be low. This does not
 *    depend on the goodwill of whoever writes content two years from now.
 * 2. The die never says no. `resolve()` returns one of four outcomes, and all
 *    four count as success. There is no return path that means failure.
 * 3. Every roll is auditable. Everything here is deterministic from the seed,
 *    and `resolve()` returns the inputs along with the result so staff can
 *    reproduce any disputed outcome.
 */

const crypto = require('crypto');

// ─────────────────────────────────────────────────────────────────────────────
// Vocabulary
// ─────────────────────────────────────────────────────────────────────────────

/** One for each transformation tree. */
const AFFINITIES = Object.freeze(['arcana', 'divina', 'sombria', 'bestial']);

/** How well the character withstands the cost of what they attempted. */
const TRAITS = Object.freeze(['vontade', 'sensibilidade', 'estabilidade']);

/**
 * Players never see numbers. Resolution also does not use raw numbers — it
 * uses bands. Having only five steps is what keeps the system from becoming a
 * spreadsheet: to everyone, 61 and 63 are the same.
 */
const BANDS = Object.freeze(['surdo', 'fraco', 'comum', 'forte', 'raro']);

/** The four outcomes. ALL count as success — see rule 2 above. */
const OUTCOMES = Object.freeze(['limpo', 'caro', 'complicado', 'marcado']);

/**
 * Fixed budgets. They are the mechanical guarantee of rule 1.
 *
 * 200 across 4 affinities = an average of 50. For someone to get `raro` (85+)
 * in Arcana, the other three must total 115 — meaning they fall below average.
 * You cannot be good at everything, and this is not a balancing choice
 * someone could undo without noticing: it is arithmetic.
 */
const AFFINITY_BUDGET = 200;
const TRAIT_BUDGET = 150;

/**
 * Band thresholds. Deliberately concentrated in the middle: nearly everyone
 * is `comum` at nearly everything, which is what makes `raro` mean something.
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
 * A counter-based, rather than sequential, generator: each value comes from
 * `HMAC(seed, label:n)`.
 *
 * It was chosen over a stateful PRNG for two reasons that matter here:
 * reproducing an old result does not require reproducing the entire sequence
 * that came before (staff need to audit ONE roll, not replay months of
 * gameplay), and streams with different labels are independent — changing
 * trait generation does not shift affinity generation.
 *
 * @param {string} seed  seed in hexadecimal
 * @param {string} label independent stream ('affinities', 'traits', 'resolve')
 */
function stream(seed, label) {
  let counter = 0;
  return function next() {
    const mac = crypto.createHmac('sha256', Buffer.from(String(seed), 'utf8'));
    mac.update(`${label}:${counter++}`);
    // 4 bytes are enough: 2^32 distinct values provide far more precision than
    // anything here requires.
    return mac.digest().readUInt32BE(0) / 0x1_0000_0000;
  };
}

/**
 * The sum of three uniform values: a bell-shaped distribution, inexpensive
 * and dependency-free. This makes the middle common and the extremes rare
 * even before normalization.
 */
function bell(next) {
  return (next() + next() + next()) / 3;
}

// ─────────────────────────────────────────────────────────────────────────────
// Seed
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The soul comes from the approved character sheet, never from chance.
 *
 * This prevents reroll farming (same sheet, same soul — killing the character
 * and recreating the same concept changes nothing) and makes whitelist
 * approval mechanically meaningful, improving the quality of character
 * sheets without needing a new rule.
 *
 * ⚠️ THE SECRET NEVER LEAVES THE SERVER. The character sheet is public: without
 * a secret, anyone could calculate any character's soul from what is written
 * on the panel, and the entire system would stop being hidden. The secret is
 * passed as an argument — this module does not read the environment, because
 * the domain does not know about infrastructure.
 *
 * @param {string} secret        SOUL_SECRET, supplied externally
 * @param {number} characterId
 * @param {{motivations?: string, weaknesses?: string, socialTies?: string}} sheet
 * @returns {string} seed in hexadecimal
 */
function deriveSeed(secret, characterId, sheet = {}) {
  if (!secret || typeof secret !== 'string') {
    throw new Error('soul: server secret is missing — the soul cannot be derived without it');
  }
  if (!Number.isInteger(characterId) || characterId <= 0) {
    throw new Error(`soul: invalid characterId (${characterId})`);
  }

  // Normalize before signing: extra spaces, uppercase letters, or accents
  // must not produce a different soul for the same approved character sheet.
  const normalize = (text) => String(text || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

  // The separator is NUL (U+0000), not a space, and this is a security choice:
  // NUL does not survive the normalization above (which collapses whitespace
  // and trims the ends), so players cannot enter it in a character sheet.
  // Without a separator that cannot be typed, moving a letter from one field
  // to the next would produce the SAME signed material — 'ab'+'c' and 'a'+'bc'
  // — and two different character sheets would produce the same soul.
  //
  // Until 2026-08-06, this was written as a RAW NUL in the source. It worked,
  // but it was invisible: tools such as `grep` and `file` treated the entire
  // file as binary, and readers would see `].join('');` on this line and
  // conclude that the fields were concatenated without a separator. Worse,
  // any editor that removed control characters when saving would change the
  // seed of EVERY soul already derived, without raising an error.
  const FIELD_SEPARATOR = '\u0000';

  const material = [
    characterId,
    normalize(sheet.motivations),
    normalize(sheet.weaknesses),
    normalize(sheet.socialTies)
  ].join(FIELD_SEPARATOR);

  return crypto.createHmac('sha256', secret).update(material).digest('hex');
}

// ─────────────────────────────────────────────────────────────────────────────
// Generation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Distributes `budget` across `keys`, keeping the sum exact and every value
 * within [0, 100].
 *
 * Rounding uses the largest-remainder method: normalizing and rounding each
 * value independently would produce incorrect sums, and an incorrect sum
 * would silently break rule 1 — the worst way to break it.
 */
function distribute(keys, budget, next) {
  const raw = keys.map(() => bell(next));
  const total = raw.reduce((a, b) => a + b, 0) || 1;

  const exact = raw.map(v => (v / total) * budget);
  const floors = exact.map(v => Math.min(100, Math.floor(v)));

  let remaining = budget - floors.reduce((a, b) => a + b, 0);

  // Assign the remainder to the largest fractional parts, respecting the
  // cap of 100.
  const order = exact
    .map((v, i) => ({ i, remainder: v - Math.floor(v) }))
    .sort((a, b) => b.remainder - a.remainder);

  let rounds = 0;
  while (remaining > 0 && rounds < keys.length * 100) {
    for (const { i } of order) {
      if (remaining === 0) break;
      if (floors[i] < 100) {
        floors[i] += 1;
        remaining -= 1;
      }
    }
    rounds += 1;
  }

  const soul = {};
  keys.forEach((key, i) => { soul[key] = floors[i]; });
  return soul;
}

/**
 * Generates the soul from the seed. Deterministic: the same seed produces
 * the same soul across runs and processes.
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

/** Converts a raw value to a band. This is the only way to inspect the soul from now on. */
function band(value) {
  const n = Math.max(0, Math.min(100, Number(value) || 0));
  for (const { band: name, max } of BAND_BOUNDS) {
    if (n <= max) return name;
  }
  return 'raro';
}

/** Numeric index of a band (0–4), used in the weight calculation. */
function bandIndex(value) {
  return BANDS.indexOf(band(value));
}

/**
 * Resistance to corruption — a DERIVED value, not stored.
 *
 * The original proposal made this an eighth attribute. It overlapped almost
 * entirely with Willpower and Stability, and another button is not depth: it
 * is another dimension to balance and explain, with nothing in return.
 *
 * Willpower weighs more than Stability by design: resisting change is more
 * about refusal than balance.
 */
function corruptionResistance(soul) {
  return Math.round((soul.vontade * 0.6) + (soul.estabilidade * 0.4));
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolution
// ─────────────────────────────────────────────────────────────────────────────

const MIN_WEIGHT = -4;
const MAX_WEIGHT = 6;

/**
 * Weights for the four outcomes as a function of `weight`.
 *
 * **No weight is ever zero anywhere on the scale.** This is deliberate and
 * separates this system from a table: even the talented can become marked on
 * a bad day, and someone with no gift can still have a clean moment — a story
 * they will tell for the rest of the character's life.
 *
 * If any weight reached zero, experienced players would know the outcome
 * before trying, eliminating all tension.
 */
function outcomeWeights(weight) {
  const p = Math.max(MIN_WEIGHT, Math.min(MAX_WEIGHT, weight));
  const t = (p - MIN_WEIGHT) / (MAX_WEIGHT - MIN_WEIGHT); // 0 = worst, 1 = best

  return {
    limpo:      2 + 60 * Math.pow(t, 2),
    caro:       10 + 30 * Math.sin(Math.PI * t),
    complicado: 8 + 40 * (1 - t),
    marcado:    2 + 45 * Math.pow(1 - t, 2)
  };
}

/**
 * Resolves an attempt connected to the soul.
 *
 * **Never returns failure.** It returns which of the four stories you got.
 *
 * @param {Object}  params
 * @param {Object}  params.soul
 * @param {string}  params.affinity     which affinity governs the action
 * @param {string}  params.seed         soul seed
 * @param {string}  params.eventId      identifies the action; used in the roll
 * @param {number} [params.attempt]     attempt in this window (0 = first)
 * @param {number} [params.circumstance] staff, component, location, preparation
 * @param {number} [params.difficulty]  difficulty of the action
 * @param {number} [params.pressure]    see `pressureFrom`
 * @returns {{outcome: string, weight: number, roll: number, inputs: Object}}
 *          `inputs` is intended for the audit log: without the recorded inputs,
 *          staff cannot reproduce the result, making accusations of favoritism
 *          impossible to verify.
 */
function resolve({
  soul, affinity, seed, eventId,
  attempt = 0, circumstance = 0, difficulty = 0, pressure = 0
}) {
  if (!soul || typeof soul !== 'object') throw new Error('soul: soul is missing');
  if (!AFFINITIES.includes(affinity)) {
    throw new Error(`soul: unknown affinity '${affinity}' — use one of ${AFFINITIES.join(', ')}`);
  }
  if (!seed) throw new Error('soul: seed is missing');
  if (!eventId) throw new Error('soul: eventId is missing — without it, the roll is not auditable');

  const weight = bandIndex(soul[affinity]) + circumstance - difficulty - pressure;

  const next = stream(seed, `resolve:${eventId}:${attempt}`);
  const roll = next();

  const weights = outcomeWeights(weight);
  const total = OUTCOMES.reduce((sum, outcome) => sum + weights[outcome], 0);

  let accumulated = 0;
  let outcome = OUTCOMES[OUTCOMES.length - 1];
  for (const result of OUTCOMES) {
    accumulated += weights[result] / total;
    if (roll < accumulated) { outcome = result; break; }
  }

  return {
    outcome,
    weight,
    roll,
    inputs: {
      affinity,
      band: band(soul[affinity]),
      circumstance,
      difficulty,
      pressure,
      attempt,
      eventId
    }
  };
}

/**
 * Calculates pressure from the number of recent attempts at the same action.
 *
 * Without this, the exploit is trivial: try a hundred times until you get
 * `limpo`. With this, repeated attempts do not converge on clean success —
 * they converge on marks.
 *
 * This prevents exploits without having to tell the player “no,” and fits the
 * fiction: someone who forces the same thing repeatedly eventually pays for
 * it physically. The cap prevents pressure from becoming a second locked door.
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
