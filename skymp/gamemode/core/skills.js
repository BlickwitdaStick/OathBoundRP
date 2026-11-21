/**
 * core/skills.js — Skills, levels, tiers, EXP and attributes (domain layer)
 *
 * Pure functions only: no database, no `mp`. skills-service.js persists and
 * applies what this module decides; core/skill-trees.js holds the tree nodes.
 *
 * ─── One level system for everything ────────────────────────────────────────
 * Every skill AND the soul use the same scale:
 *
 *   Novice 1-19 · Apprentice 20-39 · Adept 40-59 · Expert 60-79 · Master 80-99
 *   Legendary 100 — granted ONLY by staff. Earned EXP stops at level 99.
 *
 * ─── Slots ──────────────────────────────────────────────────────────────────
 * Each category (profession, combat, armor, magic) has one PRIMARY skill that
 * levels to Master, and may have one SECONDARY skill, trained by a Master of
 * that skill (or staff), capped at Adept 59. Magic is locked until the
 * character is taught the basics of spellcasting.
 *
 * A skill only earns EXP if the character owns it: you get better at what you
 * practise, and only at what you have been taught.
 *
 * ─── Attributes ─────────────────────────────────────────────────────────────
 * Eight attributes start from the race/sex table. Each character level above
 * 1 gives ATTRIBUTE_POINTS_PER_LEVEL points (cap 100 per attribute). 50 is
 * neutral; every full 5 points above adds +1 to the skills that attribute
 * governs, every full 5 below subtracts 1 (45 → -1, 55 → +1).
 *
 * The character level rises with the sum of skill levels gained. The soul has
 * its own EXP track; each soul tier above Novice adds one attribute point and
 * every 10 soul levels add +1% to all skill EXP.
 */

'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Tiers and levels
// ─────────────────────────────────────────────────────────────────────────────

const TIERS = Object.freeze([
  Object.freeze({ key: 'novice', name: 'Novice', min: 1, max: 19 }),
  Object.freeze({ key: 'apprentice', name: 'Apprentice', min: 20, max: 39 }),
  Object.freeze({ key: 'adept', name: 'Adept', min: 40, max: 59 }),
  Object.freeze({ key: 'expert', name: 'Expert', min: 60, max: 79 }),
  Object.freeze({ key: 'master', name: 'Master', min: 80, max: 99 }),
  Object.freeze({ key: 'legendary', name: 'Legendary', min: 100, max: 100 })
]);

const MIN_LEVEL = 1;
/** Highest level EXP can reach. */
const MAX_EARNED_LEVEL = 99;
/** Staff only. */
const LEGENDARY_LEVEL = 100;
/** Secondary (trained) skills stop at the top of Adept. */
const SECONDARY_CAP = 59;
const MASTER_LEVEL = 80;

function clampLevel(level) {
  const n = Math.floor(Number(level) || 0);
  return Math.max(MIN_LEVEL, Math.min(LEGENDARY_LEVEL, n));
}

/** @returns {{key: string, name: string, min: number, max: number}} */
function tierOf(level) {
  const l = clampLevel(level);
  for (const t of TIERS) if (l <= t.max) return t;
  return TIERS[TIERS.length - 1];
}

function tierIndex(level) {
  return TIERS.indexOf(tierOf(level));
}

/**
 * EXP needed to go from `level` to `level + 1`: 99 + level².
 * Level 1 → 100, level 30 → 999, level 98 → 9,703. Slow at the top on purpose.
 */
function expToNext(level) {
  const l = Math.floor(Number(level) || 0);
  if (l < MIN_LEVEL || l >= MAX_EARNED_LEVEL) return 0;
  return 99 + l * l;
}

/** Total EXP needed to reach `level` from level 1 (closed form of the sum above). */
function expForLevel(level) {
  const l = Math.max(MIN_LEVEL, Math.min(MAX_EARNED_LEVEL, Math.floor(Number(level) || 0)));
  const n = l - 1;
  return 99 * n + (n * (n + 1) * (2 * n + 1)) / 6;
}

/**
 * Level reached with `exp` total EXP, never above `cap` (99 by default).
 * Legendary is not reachable through EXP.
 */
function levelFromExp(exp, cap = MAX_EARNED_LEVEL) {
  const e = Math.max(0, Math.floor(Number(exp) || 0));
  const top = Math.max(MIN_LEVEL, Math.min(MAX_EARNED_LEVEL, cap));
  let lo = MIN_LEVEL;
  let hi = top;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (expForLevel(mid) <= e) lo = mid; else hi = mid - 1;
  }
  return lo;
}

/**
 * Progress inside the current level, for display.
 * @returns {{level, tier, exp, into, needed}}
 */
function progressOf(exp, { cap = MAX_EARNED_LEVEL, legendary = false } = {}) {
  if (legendary) {
    return { level: LEGENDARY_LEVEL, tier: tierOf(LEGENDARY_LEVEL).name, exp: Number(exp) || 0, into: 0, needed: 0 };
  }
  const level = levelFromExp(exp, cap);
  const atCap = level >= cap;
  return {
    level,
    tier: tierOf(level).name,
    exp: Math.max(0, Math.floor(Number(exp) || 0)),
    into: atCap ? 0 : Math.max(0, Math.floor(Number(exp) || 0) - expForLevel(level)),
    needed: atCap ? 0 : expToNext(level)
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Attributes
// ─────────────────────────────────────────────────────────────────────────────

const ATTRIBUTES = Object.freeze([
  'agility', 'endurance', 'intelligence', 'luck', 'personality', 'speed', 'strength', 'willpower'
]);

const ATTRIBUTE_NAMES = Object.freeze({
  agility: 'Agility',
  endurance: 'Endurance',
  intelligence: 'Intelligence',
  luck: 'Luck',
  personality: 'Personality',
  speed: 'Speed',
  strength: 'Strength',
  willpower: 'Willpower'
});

const ATTRIBUTE_CAP = 100;
const ATTRIBUTE_NEUTRAL = 50;
const ATTRIBUTE_POINTS_PER_LEVEL = 3;

/** [agility, endurance, intelligence, luck, personality, speed, strength, willpower] */
function attrs(values) {
  const out = {};
  ATTRIBUTES.forEach((key, i) => { out[key] = values[i]; });
  return Object.freeze(out);
}

/**
 * Base attributes by race and sex (owner's table, 2026-11-21).
 * `raceIds` are the vanilla Skyrim.esm RACE records, playable and vampire.
 */
const RACES = Object.freeze({
  argonian: Object.freeze({
    name: 'Argonian', raceIds: Object.freeze([0x13740, 0x8883a]),
    male: attrs([50, 30, 40, 50, 30, 50, 40, 30]), female: attrs([40, 30, 50, 50, 30, 40, 40, 40])
  }),
  breton: Object.freeze({
    name: 'Breton', raceIds: Object.freeze([0x13741, 0x8883c]),
    male: attrs([30, 30, 50, 50, 40, 40, 40, 50]), female: attrs([30, 30, 50, 50, 40, 40, 30, 50])
  }),
  dark_elf: Object.freeze({
    name: 'Dark Elf', raceIds: Object.freeze([0x13742, 0x8883d]),
    male: attrs([40, 40, 40, 50, 30, 50, 40, 30]), female: attrs([40, 30, 40, 50, 40, 50, 40, 30])
  }),
  high_elf: Object.freeze({
    name: 'High Elf', raceIds: Object.freeze([0x13743, 0x88840]),
    male: attrs([40, 40, 50, 50, 40, 30, 30, 40]), female: attrs([40, 30, 50, 50, 40, 40, 30, 40])
  }),
  imperial: Object.freeze({
    name: 'Imperial', raceIds: Object.freeze([0x13744, 0x88844]),
    male: attrs([30, 40, 40, 50, 50, 40, 40, 30]), female: attrs([30, 40, 40, 50, 50, 30, 40, 40])
  }),
  khajiit: Object.freeze({
    name: 'Khajiit', raceIds: Object.freeze([0x13745, 0x88845]),
    male: attrs([50, 30, 40, 50, 40, 40, 40, 30]), female: attrs([50, 40, 40, 50, 40, 40, 30, 30])
  }),
  nord: Object.freeze({
    name: 'Nord', raceIds: Object.freeze([0x13746, 0x88794]),
    male: attrs([40, 50, 30, 50, 30, 40, 50, 30]), female: attrs([40, 40, 30, 50, 40, 40, 50, 30])
  }),
  orc: Object.freeze({
    name: 'Orc', raceIds: Object.freeze([0x13747, 0xa82b9]),
    male: attrs([35, 50, 30, 50, 30, 30, 45, 50]), female: attrs([35, 50, 40, 50, 25, 30, 45, 45])
  }),
  redguard: Object.freeze({
    name: 'Redguard', raceIds: Object.freeze([0x13748, 0x88846]),
    male: attrs([40, 50, 30, 50, 30, 40, 50, 30]), female: attrs([40, 50, 30, 50, 40, 40, 40, 30])
  }),
  wood_elf: Object.freeze({
    name: 'Wood Elf', raceIds: Object.freeze([0x13749, 0x88884]),
    male: attrs([50, 30, 40, 50, 40, 50, 30, 30]), female: attrs([50, 30, 40, 50, 40, 50, 30, 30])
  })
});

/** RACE form id → race key, or null for a race not in the table. */
function raceKeyFromRaceId(raceId) {
  const id = Number(raceId) >>> 0;
  for (const [key, race] of Object.entries(RACES)) {
    if (race.raceIds.includes(id)) return key;
  }
  return null;
}

function baseAttributes(raceKey, isFemale) {
  const race = RACES[raceKey];
  if (!race) throw new Error(`skills: unknown race '${raceKey}'`);
  return { ...(isFemale ? race.female : race.male) };
}

/** Sanitises an attribute object: every key present, integers. */
function normalizeAttributes(obj) {
  const out = {};
  for (const key of ATTRIBUTES) out[key] = Math.trunc(Number(obj && obj[key]) || 0);
  return out;
}

/** base + added, each clamped to 0..100. */
function totalAttributes(base, added) {
  const b = normalizeAttributes(base);
  const a = normalizeAttributes(added);
  const out = {};
  for (const key of ATTRIBUTES) out[key] = Math.max(0, Math.min(ATTRIBUTE_CAP, b[key] + a[key]));
  return out;
}

/**
 * 50 → 0; each full 5 above → +1; each full 5 below → -1.
 * 45 → -1, 41 → -1, 40 → -2, 55 → +1, 59 → +1, 100 → +10.
 */
function attributeModifier(value) {
  const v = Math.max(0, Math.min(ATTRIBUTE_CAP, Math.trunc(Number(value) || 0)));
  const d = v - ATTRIBUTE_NEUTRAL;
  return d >= 0 ? Math.floor(d / 5) : (-Math.floor(-d / 5) || 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Skill catalog
// ─────────────────────────────────────────────────────────────────────────────

const CATEGORIES = Object.freeze(['profession', 'combat', 'armor', 'magic']);

const CATEGORY_NAMES = Object.freeze({
  profession: 'Profession',
  combat: 'Combat',
  armor: 'Armor',
  magic: 'Magic'
});

/**
 * `attribute` — which attribute's modifier applies (null = none; Luck has no
 *               skill, it only nudges drop/yield chances).
 * `vanillaAv` — the Skyrim actor value this skill drives on the player's
 *               client, or null when Skyrim has no matching skill.
 */
const SKILLS = Object.freeze([
  // Professions
  { code: 'outfitter', name: 'Outfitting', practitioner: 'Outfitter', category: 'profession', attribute: 'agility', vanillaAv: 'Smithing',
    description: 'Light armor, clothes, leather goods, backpacks, boxes and bandoliers.' },
  { code: 'metal_worker', name: 'Metalworking', practitioner: 'Metal Worker', category: 'profession', attribute: 'endurance', vanillaAv: 'Smithing',
    description: 'Smelting with charcoal, heavy armor and weapons.' },
  { code: 'carpenter', name: 'Carpentry', practitioner: 'Carpenter', category: 'profession', attribute: 'strength', vanillaAv: null,
    description: 'Bows, crossbows, practice weapons, arrows and wood goods at a carpentry bench; turns wood into charcoal.' },
  { code: 'alchemist', name: 'Alchemy', practitioner: 'Alchemist', category: 'profession', attribute: 'intelligence', vanillaAv: 'Alchemy',
    description: 'Picking flowers and making potions.' },
  { code: 'enchanter', name: 'Enchanting', practitioner: 'Enchanter', category: 'profession', attribute: 'intelligence', vanillaAv: 'Enchanting',
    description: 'Enchanting items.' },
  { code: 'farmer', name: 'Farming', practitioner: 'Farmer', category: 'profession', attribute: 'endurance', vanillaAv: null,
    description: 'Farming and turning crops into goods such as flour.' },
  { code: 'innkeeper', name: 'Innkeeping', practitioner: 'InnKeeper', category: 'profession', attribute: 'personality', vanillaAv: null,
    description: 'Cooking and brewing food and drink.' },
  { code: 'hunter', name: 'Hunting', practitioner: 'Hunter', category: 'profession', attribute: 'agility', vanillaAv: null,
    description: 'Pelts and goods from animals by harvesting, and fishing. Tougher creatures need a higher tier.' },
  { code: 'prospector', name: 'Prospecting', practitioner: 'Prospector', category: 'profession', attribute: 'strength', vanillaAv: null,
    description: 'Mining ore nodes. Iron: Novice, Corundum: Apprentice, Moonstone: Adept, Orichalcum: Expert, Ebony and rarer: Master.' },
  // Combat
  { code: 'one_handed', name: 'One-Handed', category: 'combat', attribute: 'strength', vanillaAv: 'OneHanded',
    description: 'All one-handed weapons.' },
  { code: 'two_handed', name: 'Two-Handed', category: 'combat', attribute: 'strength', vanillaAv: 'TwoHanded',
    description: 'All two-handed weapons.' },
  { code: 'archery', name: 'Archery', category: 'combat', attribute: 'agility', vanillaAv: 'Marksman',
    description: 'Bows and crossbows.' },
  { code: 'dual_wielding', name: 'Dual Wielding', category: 'combat', attribute: 'agility', vanillaAv: null,
    description: 'Fighting with a one-handed weapon in each hand.' },
  { code: 'unarmed', name: 'Unarmed', category: 'combat', attribute: 'speed', vanillaAv: null,
    description: 'Fighting with fists only.' },
  // Armor
  { code: 'heavy_armor', name: 'Heavy Armor', category: 'armor', attribute: 'endurance', vanillaAv: 'HeavyArmor',
    description: 'Fighting in heavy armor.' },
  { code: 'light_armor', name: 'Light Armor', category: 'armor', attribute: 'speed', vanillaAv: 'LightArmor',
    description: 'Fighting in light armor.' },
  { code: 'mage_armor', name: 'Mage Armor', category: 'armor', attribute: 'willpower', vanillaAv: null,
    description: 'Robes and clothing: no penalties, very light protection, enough to survive.' },
  // Magic
  { code: 'alteration', name: 'Alteration', category: 'magic', attribute: 'willpower', vanillaAv: 'Alteration', description: 'Alteration spells.' },
  { code: 'restoration', name: 'Restoration', category: 'magic', attribute: 'willpower', vanillaAv: 'Restoration', description: 'Restoration spells.' },
  { code: 'destruction', name: 'Destruction', category: 'magic', attribute: 'willpower', vanillaAv: 'Destruction', description: 'Destruction spells.' },
  { code: 'illusion', name: 'Illusion', category: 'magic', attribute: 'personality', vanillaAv: 'Illusion', description: 'Illusion spells.' },
  { code: 'conjuration', name: 'Conjuration', category: 'magic', attribute: 'intelligence', vanillaAv: 'Conjuration', description: 'Conjuration spells.' }
].map(s => Object.freeze(s)));

const SKILLS_BY_CODE = Object.freeze(Object.fromEntries(SKILLS.map(s => [s.code, s])));

/** The soul uses the same levels but is not a skill (no slot, no tree). */
const SOUL_CODE = 'soul';

function getSkill(code) {
  return SKILLS_BY_CODE[String(code || '').toLowerCase()] || null;
}

function skillsInCategory(category) {
  return SKILLS.filter(s => s.category === category);
}

/**
 * Finds a skill by code, name or practitioner ("Prospector", "one-handed",
 * "Metal Worker", "metal_worker"), for commands typed in chat.
 */
function findSkill(text) {
  const q = String(text || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!q) return null;
  if (SKILLS_BY_CODE[q]) return SKILLS_BY_CODE[q];
  const norm = (s) => String(s || '').toLowerCase().replace(/[\s-]+/g, '_');
  return SKILLS.find(s => norm(s.name) === q || norm(s.practitioner) === q) || null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Owned skills, caps and EXP
// ─────────────────────────────────────────────────────────────────────────────

function capForSlot(slot) {
  return slot === 'secondary' ? SECONDARY_CAP : MAX_EARNED_LEVEL;
}

/**
 * Level of an owned skill row `{exp, slot, legendary}`.
 * Legendary always reads 100, whatever the slot.
 */
function levelOfRow(row) {
  if (!row) return 0;
  if (row.legendary) return LEGENDARY_LEVEL;
  return levelFromExp(row.exp, capForSlot(row.slot));
}

/**
 * Adds EXP to an owned skill row, stopping at its slot cap.
 * @param {{exp: number, slot: string, legendary?: boolean}} row
 * @param {number} amount positive EXP
 * @param {{bonusPct?: number}} [opts] soul bonus in percent
 * @returns {{exp, gained, levelBefore, levelAfter, tierBefore, tierAfter, capped}}
 */
function addExp(row, amount, { bonusPct = 0 } = {}) {
  const current = Math.max(0, Math.floor(Number(row && row.exp) || 0));
  const levelBefore = levelOfRow(row);
  const capExp = expForLevel(capForSlot(row && row.slot));
  const raw = Math.max(0, Number(amount) || 0) * (1 + Math.max(0, Number(bonusPct) || 0) / 100);
  const add = Math.floor(raw);
  // Legendary rows keep counting EXP for the record but stay at 100.
  const next = row && row.legendary ? current + add : Math.min(capExp, current + add);
  const after = { ...row, exp: next };
  const levelAfter = levelOfRow(after);
  return {
    exp: next,
    gained: next - current,
    levelBefore,
    levelAfter,
    tierBefore: tierOf(levelBefore).name,
    tierAfter: tierOf(levelAfter).name,
    capped: !(row && row.legendary) && next >= capExp
  };
}

/**
 * Skill level with the governing attribute's modifier applied, 1..100.
 * This is the level gates and the vanilla actor value use.
 */
function effectiveLevel(skillCode, row, attributes) {
  const skill = getSkill(skillCode);
  const level = levelOfRow(row);
  if (!skill || level <= 0) return 0;
  const mod = skill.attribute ? attributeModifier((attributes || {})[skill.attribute] ?? ATTRIBUTE_NEUTRAL) : 0;
  return Math.max(MIN_LEVEL, Math.min(LEGENDARY_LEVEL, level + mod));
}

/** 1 skill point per 5 levels (19 at level 99, 20 at Legendary). */
function skillPointsForLevel(level) {
  return Math.floor(clampLevel(level) / 5);
}

/** Master (80+) owns the whole tree without spending points. */
function hasWholeTree(level) {
  return clampLevel(level) >= MASTER_LEVEL;
}

// ─────────────────────────────────────────────────────────────────────────────
// Slot rules
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Can a character take `skillCode` in `slot`?
 * @param {Array<{skill_code: string, slot: string}>} owned
 * @param {{magicUnlocked?: boolean}} ctx
 * @returns {{ok: true} | {ok: false, code: string, message: string}}
 */
function canTake(owned, skillCode, slot, { magicUnlocked = false } = {}) {
  const skill = getSkill(skillCode);
  if (!skill) return { ok: false, code: 'unknown_skill', message: `Unknown skill '${skillCode}'.` };
  if (slot !== 'primary' && slot !== 'secondary') return { ok: false, code: 'bad_slot', message: 'Slot must be primary or secondary.' };
  const list = Array.isArray(owned) ? owned : [];
  if (list.some(r => r.skill_code === skill.code)) {
    return { ok: false, code: 'already_owned', message: `You already know ${skill.name}.` };
  }
  if (skill.category === 'magic' && !magicUnlocked) {
    return { ok: false, code: 'magic_locked', message: 'You must first learn the basics of spellcasting from a teacher.' };
  }
  const inCategory = list.filter(r => {
    const s = getSkill(r.skill_code);
    return s && s.category === skill.category;
  });
  const primary = inCategory.find(r => r.slot === 'primary');
  if (slot === 'primary' && primary) {
    return { ok: false, code: 'primary_taken', message: `You already chose your ${CATEGORY_NAMES[skill.category].toLowerCase()} skill.` };
  }
  if (slot === 'secondary') {
    if (!primary) {
      return { ok: false, code: 'no_primary', message: `Choose a ${CATEGORY_NAMES[skill.category].toLowerCase()} skill of your own first.` };
    }
    if (inCategory.some(r => r.slot === 'secondary')) {
      return { ok: false, code: 'secondary_taken', message: `You already trained a second ${CATEGORY_NAMES[skill.category].toLowerCase()} skill.` };
    }
  }
  return { ok: true };
}

/**
 * Validates the F3 start choice: one profession, one combat skill, one armor
 * skill (all required, all primary). Magic is chosen later, once unlocked.
 */
function validateStartChoice({ profession, combat, armor } = {}) {
  const pick = [
    ['profession', profession],
    ['combat', combat],
    ['armor', armor]
  ];
  for (const [category, code] of pick) {
    const skill = getSkill(code);
    if (!skill || skill.category !== category) {
      return { ok: false, code: 'bad_choice', message: `Choose one ${CATEGORY_NAMES[category].toLowerCase()} skill.` };
    }
  }
  return { ok: true, skills: pick.map(([, code]) => getSkill(code).code) };
}

/**
 * Can `teacherLevel` (the teacher's level in the skill) teach it as a
 * secondary? Only a Master (80+) can, or staff.
 */
function canTeach(teacherLevel, { isStaff = false } = {}) {
  return isStaff || clampLevel(teacherLevel) >= MASTER_LEVEL;
}

// ─────────────────────────────────────────────────────────────────────────────
// Character level, attribute points and the soul
// ─────────────────────────────────────────────────────────────────────────────

/** Every 5 skill levels gained (across all skills) is one character level. */
const SKILL_LEVELS_PER_CHARACTER_LEVEL = 5;
const MAX_CHARACTER_LEVEL = 99;

/** @param {number[]} skillLevels levels of every owned skill */
function characterLevel(skillLevels) {
  const gained = (skillLevels || []).reduce((sum, l) => sum + Math.max(0, Math.min(MAX_EARNED_LEVEL, Number(l) || 0) - 1), 0);
  return Math.min(MAX_CHARACTER_LEVEL, 1 + Math.floor(gained / SKILL_LEVELS_PER_CHARACTER_LEVEL));
}

/** Soul tiers above Novice each add an attribute point (Legendary = 5). */
function soulAttributeBonus(soulLevel) {
  return tierIndex(soulLevel);
}

/** +1% EXP on every skill per 10 soul levels (Legendary = +10%). */
function soulExpBonusPct(soulLevel) {
  return Math.floor(clampLevel(soulLevel) / 10);
}

/** Points available to spend = level points + soul bonus − points already spent. */
function attributePointsAvailable({ characterLevel: level, soulLevel = 1, spent = 0 }) {
  const earned = (Math.max(1, Number(level) || 1) - 1) * ATTRIBUTE_POINTS_PER_LEVEL + soulAttributeBonus(soulLevel);
  return Math.max(0, earned - Math.max(0, Number(spent) || 0));
}

/**
 * Spends attribute points.
 * @param {{base: object, added: object, available: number, spend: object}} p
 *        `spend` = {strength: 2, agility: 1}; only positive integers.
 * @returns {{ok: true, added: object, used: number} | {ok: false, code, message}}
 */
function spendAttributePoints({ base, added, available, spend }) {
  const s = normalizeAttributes(spend);
  let used = 0;
  for (const key of ATTRIBUTES) {
    if (s[key] < 0) return { ok: false, code: 'negative', message: 'Points can only be added.' };
    used += s[key];
  }
  if (used === 0) return { ok: false, code: 'nothing', message: 'Choose at least one point to spend.' };
  if (used > available) return { ok: false, code: 'not_enough', message: `You only have ${available} point(s) to spend.` };
  const b = normalizeAttributes(base);
  const a = normalizeAttributes(added);
  const out = {};
  for (const key of ATTRIBUTES) {
    out[key] = a[key] + s[key];
    if (b[key] + out[key] > ATTRIBUTE_CAP) {
      return { ok: false, code: 'over_cap', message: `${ATTRIBUTE_NAMES[key]} cannot go above ${ATTRIBUTE_CAP}.` };
    }
  }
  return { ok: true, added: out, used };
}

/**
 * Points the player spent (staff edits are tracked in the same `added` object,
 * so the service passes its own count; this helper is the plain sum).
 */
function sumAdded(added) {
  const a = normalizeAttributes(added);
  return ATTRIBUTES.reduce((sum, key) => sum + Math.max(0, a[key]), 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Vanilla stats driven by attributes (applied on the player's client)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Attribute → Skyrim actor values. At 50 everywhere these are vanilla
 * defaults (100/100/100, carry 300, speed 100).
 */
function derivedStats(attributes) {
  const a = normalizeAttributes(attributes);
  const d = (key) => a[key] - ATTRIBUTE_NEUTRAL;
  return {
    Health: Math.max(30, Math.round(100 + 2 * d('endurance') + 0.5 * d('strength'))),
    Magicka: Math.max(30, Math.round(100 + 2 * d('intelligence') + d('willpower'))),
    Stamina: Math.max(30, Math.round(100 + d('agility') + d('endurance'))),
    CarryWeight: Math.max(100, Math.round(300 + 4 * d('strength'))),
    SpeedMult: Math.max(80, Math.min(130, Math.round(100 + 0.5 * d('speed'))))
  };
}

/** Luck nudges drop/yield rolls: +0.2% per point above 50, never negative. */
function luckBonusChance(luck) {
  return Math.max(0, (Math.min(ATTRIBUTE_CAP, Number(luck) || 0) - ATTRIBUTE_NEUTRAL) * 0.002);
}

/**
 * Vanilla skill AVs from owned skills. Two skills may drive the same AV
 * (Outfitting and Metalworking both drive Smithing): the higher one wins.
 * Skills the character does not own are set to 0 so a vanilla trainer or
 * book on the client cannot give them a head start the server never saw.
 * @param {Object<string, {exp, slot, legendary}>} rowsByCode
 */
function vanillaSkillValues(rowsByCode, attributes) {
  const out = {};
  for (const skill of SKILLS) {
    if (!skill.vanillaAv) continue;
    const row = rowsByCode && rowsByCode[skill.code];
    const value = row ? effectiveLevel(skill.code, row, attributes) : 0;
    out[skill.vanillaAv] = Math.max(out[skill.vanillaAv] || 0, value);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Profession gates (tier-based)
// ─────────────────────────────────────────────────────────────────────────────

/** Minimum tier to mine each ore. Anything not listed needs Master. */
const ORE_TIERS = Object.freeze({
  iron: 'novice',
  corundum: 'apprentice',
  moonstone: 'adept',
  orichalcum: 'expert',
  ebony: 'master'
});

/**
 * Minimum tier to harvest a creature. Anything not listed needs Adept: a
 * novice hunter can skin a deer, not a troll.
 */
const CREATURE_TIERS = Object.freeze({
  rabbit: 'novice', fox: 'novice', deer: 'novice', elk: 'novice', goat: 'novice', fish: 'novice', mudcrab: 'novice', skeever: 'novice',
  wolf: 'apprentice', horker: 'apprentice', slaughterfish: 'apprentice', spider: 'apprentice', sabre_cat: 'apprentice',
  bear: 'adept', troll: 'adept', chaurus: 'adept', ice_wolf: 'adept', snow_sabre_cat: 'adept',
  frost_troll: 'expert', mammoth: 'expert', cave_bear: 'expert', snow_bear: 'expert', spriggan: 'expert',
  dragon: 'master', giant: 'master'
});

function tierMinLevel(tierKey) {
  const t = TIERS.find(x => x.key === tierKey);
  return t ? t.min : TIERS[4].min;
}

/** @returns {{ok: boolean, required: string, requiredLevel: number}} */
function checkTierGate(table, key, fallbackTier, level) {
  const tierKey = table[String(key || '').toLowerCase()] || fallbackTier;
  const requiredLevel = tierMinLevel(tierKey);
  return { ok: clampLevel(level) >= requiredLevel, required: TIERS.find(x => x.key === tierKey).name, requiredLevel };
}

function canMine(ore, prospectorLevel) {
  return checkTierGate(ORE_TIERS, ore, 'master', prospectorLevel);
}

function canHarvestCreature(creature, hunterLevel) {
  return checkTierGate(CREATURE_TIERS, creature, 'adept', hunterLevel);
}

module.exports = {
  TIERS,
  MIN_LEVEL,
  MAX_EARNED_LEVEL,
  LEGENDARY_LEVEL,
  SECONDARY_CAP,
  MASTER_LEVEL,
  ATTRIBUTES,
  ATTRIBUTE_NAMES,
  ATTRIBUTE_CAP,
  ATTRIBUTE_NEUTRAL,
  ATTRIBUTE_POINTS_PER_LEVEL,
  RACES,
  CATEGORIES,
  CATEGORY_NAMES,
  SKILLS,
  SOUL_CODE,
  SKILL_LEVELS_PER_CHARACTER_LEVEL,
  MAX_CHARACTER_LEVEL,
  ORE_TIERS,
  CREATURE_TIERS,
  clampLevel,
  tierOf,
  tierIndex,
  expToNext,
  expForLevel,
  levelFromExp,
  progressOf,
  raceKeyFromRaceId,
  baseAttributes,
  normalizeAttributes,
  totalAttributes,
  attributeModifier,
  getSkill,
  skillsInCategory,
  findSkill,
  capForSlot,
  levelOfRow,
  addExp,
  effectiveLevel,
  skillPointsForLevel,
  hasWholeTree,
  canTake,
  validateStartChoice,
  canTeach,
  characterLevel,
  soulAttributeBonus,
  soulExpBonusPct,
  attributePointsAvailable,
  spendAttributePoints,
  sumAdded,
  derivedStats,
  luckBonusChance,
  vanillaSkillValues,
  tierMinLevel,
  canMine,
  canHarvestCreature
};
