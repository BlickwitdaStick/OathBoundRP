/**
 * core/survival-needs.js
 *
 * Rules for server-side survival: hunger, exhaustion and cold. Pure (no `mp`,
 * no database), so all of it is tested in core/survival-needs.test.js; the
 * service (survival-service.js) feeds it positions, equipment, meals and game
 * time.
 *
 * Numbers come from Creation Club Survival Mode (ccQDRSSE001-SurvivalMode.esl,
 * its GLOB records) where it has them; the warm / cool / freezing areas are its
 * Survival_RegionInfoSpell conditions, evaluated against the vanilla map
 * regions in data/survival-data.json (tools/survival/build-survival-data.js).
 * Where Survival keeps a number in its scripts instead (exhaustion and cold
 * stages, cold speeds), the value here is ours and says so.
 *
 * No penalties yet (owner, 2026-11-20): needs are tracked and shown, nothing
 * else happens.
 */

'use strict';

/** Need values run 0 (fine) … max. Stage = how many thresholds the value has reached. */
const NEEDS = Object.freeze({
  hunger: {
    max: 1000,
    perGameHour: 7.5,                          // Survival_HungerNeedRate
    stages: [80, 160, 340, 520, 770],          // Survival_HungerStage1..5Value
    names: ['Well Fed', 'Satisfied', 'Peckish', 'Hungry', 'Ravenous', 'Starving'],
    messages: [
      'You feel well fed.', 'You feel satisfied.', 'You are getting peckish.',
      'You are hungry.', 'You are ravenous.', 'You are starving.'
    ]
  },
  exhaustion: {
    max: 960,                                  // Survival_ExhaustionNeedMaxValue
    perGameHour: 9,                            // Survival_ExhaustionNeedRate
    stages: [75, 150, 325, 500, 740],          // ours: hunger's stage spacing scaled to 960
    names: ['Well Rested', 'Rested', 'Slightly Tired', 'Tired', 'Weary', 'Debilitated'],
    messages: [
      'You feel well rested.', 'You feel rested.', 'You are slightly tired.',
      'You are tired.', 'You are weary.', 'You are debilitated by exhaustion.'
    ]
  },
  cold: {
    max: 1000,                                 // Survival_ColdNeedMaxValue
    stages: [80, 160, 340, 520, 770],          // ours: same spacing as hunger
    names: ['Warm', 'Comfortable', 'Chilly', 'Very Cold', 'Freezing', 'Numb'],
    messages: [
      'You feel warm.', 'You feel comfortable.', 'You feel chilly.',
      'You are very cold.', 'You are freezing.', 'You are numb with cold.'
    ]
  }
});

/** Hunger restored per meal size (Survival_HungerRestore*Amount). */
const FOOD_HUNGER = Object.freeze({ verySmall: 2, small: 18, medium: 220, large: 380 });
/** Cold removed by a hot meal (Survival_ColdRestoreMediumAmount). */
const HOT_FOOD_COLD = 200;
/** How long a hot meal keeps you warmer, in game hours (ours). */
const HOT_FOOD_WARMTH_HOURS = 2;

/** Exhaustion removed per game hour of rest (Survival_ExhaustionRestorePerHour). */
const REST_PER_GAME_HOUR = 120;
/** A bedroll only rests you down to this (Survival_ExhaustionRestoreNormalCap); a bed to 0. */
const BEDROLL_REST_FLOOR = 200;
/** Hunger grows at half speed while resting (Survival_NeedSleepReducedMetabolismMult). */
const REST_HUNGER_MULT = 0.5;

/**
 * Cold per area: it climbs toward `ceiling` at `gain` per game hour (slowed by
 * warmth), and falls at `recover` per game hour while above it. Survival makes
 * a freezing area numb you in about 1.33 game hours with no protection
 * (Survival_ColdTargetGameHoursToNumb): 770 / 1.33 ≈ 580. The rest is ours.
 */
const AREAS = Object.freeze({
  freezing: { label: 'a freezing area', ceiling: 1000, gain: 580, recover: 0 },
  cool: { label: 'a cool area', ceiling: 300, gain: 200, recover: 150 },
  warm: { label: 'a warm area', ceiling: 0, gain: 0, recover: 400 },
  temperate: { label: 'a mild area', ceiling: 120, gain: 100, recover: 200 },
  indoors: { label: 'indoors', ceiling: 0, gain: 0, recover: 500 },
  coldIndoors: { label: 'a cold interior', ceiling: 300, gain: 150, recover: 150 }
});

/**
 * Survival_RegionInfoSpell, effect by effect (region editor ids; Z = height).
 * A rule matches when: Z >= orMinZ (if set) — or else none of noneOf, all of
 * allOf, Z >= minZ, Z < maxZ, and at least one of anyOf.
 */
const SOLSTHEIM_SNOW = ['WeatherDLC2SolstheimSnow', 'WeatherDLC2SolstheimMtns', 'WeatherDLC2SolstheimSnowHeavy'];
const AREA_RULES = Object.freeze({
  /** Survival_RegionEffectFreezingArea */
  freezing: {
    orMinZ: 19000,
    anyOf: [
      'WeatherSnow', 'WeatherCoast', 'WeatherCoastFog', 'WeatherMountains', 'WeatherMountainsNoPrecip',
      'WeatherTundraMarsh', 'WeatherWinterhold', 'WeatherSkuldafn', 'DLC01VampCastleStorm', 'DLC01WeatherCanyon',
      'DLC01WeatherIce', 'DLC01WeatherPlayground', 'DLC1FalmerValleyBorder', ...SOLSTHEIM_SNOW
    ]
  },
  /** Survival_RegionEffectSouthForestMtnsFreezingArea: high in the southern forests' mountains */
  southForestMountains: { anyOf: ['WeatherPineForest', 'WeatherTundra'], allOf: ['WeatherMountains'], minZ: 2000 },
  /** Survival_RegionEffectFallForestFreezingArea: up at Forelhost and Arcwind Point */
  fallForestPeaks: { anyOf: ['SurvivalForelhost', 'SurvivalArcwindPoint'], minZ: 15150 },
  /** Survival_RegionEffectCoolArea */
  cool: {
    noneOf: ['WeatherMountains', 'WeatherSnow'],
    anyOf: ['WeatherTundra', 'WeatherReach', 'WeatherWindhelm', 'WeatherWhiterun', 'WeatherSolitude',
      'WeatherMarkarth', 'BlackreachRegion', 'DLC01WeatherGrove']
  },
  /** Survival_RegionEffectWarmArea */
  warm: {
    noneOf: ['WeatherSnow', ...SOLSTHEIM_SNOW],
    maxZ: 19000,
    anyOf: ['WeatherPineForest', 'WeatherFallForest', 'WeatherRiften', 'AudioExtFallForestDLC1FortDawnguard',
      'WeatherRavenRock01', 'WeatherVolcanicAsh01', 'WeatherVolcanicAsh02']
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Stages
// ─────────────────────────────────────────────────────────────────────────────

function stageOf(need, value) {
  const { stages } = NEEDS[need];
  let s = 0;
  while (s < stages.length && value >= stages[s]) s += 1;
  return s;
}

function describe(need, value) {
  const stage = stageOf(need, value);
  return { stage, name: NEEDS[need].names[stage], message: NEEDS[need].messages[stage] };
}

function clamp(need, value) {
  return Math.min(NEEDS[need].max, Math.max(0, value));
}

// ─────────────────────────────────────────────────────────────────────────────
// Map
// ─────────────────────────────────────────────────────────────────────────────

function pointInPolygon(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i, i += 1) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Prepares data/survival-data.json regions: worldspace ids as numbers and a
 * bounding box per area, so most areas are skipped without the polygon test.
 */
function prepareRegions(regions) {
  const out = [];
  for (const [editorId, r] of Object.entries(regions || {})) {
    const worldspace = Number(r.worldspace);
    for (const pts of r.areas || []) {
      const xs = pts.map((p) => p[0]);
      const ys = pts.map((p) => p[1]);
      out.push({ editorId, worldspace, pts, box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] });
    }
  }
  return out;
}

/** Editor ids of the regions containing (x, y) in `worldspace`. */
function regionsAt(prepared, worldspace, x, y) {
  const hits = new Set();
  for (const a of prepared) {
    if (a.worldspace !== worldspace || hits.has(a.editorId)) continue;
    const [x0, y0, x1, y1] = a.box;
    if (x < x0 || x > x1 || y < y0 || y > y1) continue;
    if (pointInPolygon(x, y, a.pts)) hits.add(a.editorId);
  }
  return hits;
}

function ruleMatches(rule, inRegions, z) {
  const has = (r) => inRegions.has(r);
  if (rule.orMinZ !== undefined && z >= rule.orMinZ) return true;
  if (rule.noneOf && rule.noneOf.some(has)) return false;
  if (rule.allOf && !rule.allOf.every(has)) return false;
  if (rule.minZ !== undefined && z < rule.minZ) return false;
  if (rule.maxZ !== undefined && z >= rule.maxZ) return false;
  return !rule.anyOf || rule.anyOf.some(has);
}

/**
 * The kind of place a character is in: a key of AREAS.
 * @param {{interior:boolean, coldInterior?:boolean, worldspace?:number, pos?:number[]}} place
 */
function areaAt(prepared, place) {
  if (place.interior) return place.coldInterior ? 'coldIndoors' : 'indoors';
  if (!Array.isArray(place.pos)) return 'temperate';
  const [x, y, z] = place.pos;
  const inRegions = regionsAt(prepared, place.worldspace, x, y);
  if (ruleMatches(AREA_RULES.freezing, inRegions, z)
    || ruleMatches(AREA_RULES.southForestMountains, inRegions, z)
    || ruleMatches(AREA_RULES.fallForestPeaks, inRegions, z)) return 'freezing';
  if (ruleMatches(AREA_RULES.cool, inRegions, z)) return 'cool';
  if (ruleMatches(AREA_RULES.warm, inRegions, z)) return 'warm';
  // Outside every Survival region: city worldspaces and the like.
  return 'temperate';
}

// ─────────────────────────────────────────────────────────────────────────────
// Warmth
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How much of the cold gain is blocked, 0…0.8. Per worn piece, from
 * Survival_ColdResist*ArmorBonus: warm 0.10, normal 0.05, cold 0.02, doubled
 * for body and head pieces (keyword Survival_BodyAndHead). A torch or a hot
 * meal adds 0.12 each (Survival_ColdResistTorchBonus / FoodBonus, 25 of 206).
 * @param {{kind:'warm'|'normal'|'cold', bodyOrHead:boolean}[]} pieces
 */
function warmthOf(pieces, { torch = false, hotMeal = false } = {}) {
  const per = { warm: 0.10, normal: 0.05, cold: 0.02 };
  let w = 0;
  for (const p of pieces || []) w += (per[p.kind] || 0) * (p.bodyOrHead ? 2 : 1);
  if (torch) w += 0.12;
  if (hotMeal) w += 0.12;
  return Math.min(0.8, Math.round(w * 1000) / 1000);
}

// ─────────────────────────────────────────────────────────────────────────────
// Time passing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Needs after `hours` game hours.
 * @param {{hunger:number, exhaustion:number, cold:number}} needs
 * @param {{area:string, warmth?:number, resting?:null|{floor:number}}} ctx
 */
function advance(needs, hours, ctx) {
  const h = Math.max(0, Number(hours) || 0);
  const resting = ctx.resting || null;
  const next = { ...needs };

  next.hunger = clamp('hunger', needs.hunger + NEEDS.hunger.perGameHour * h * (resting ? REST_HUNGER_MULT : 1));

  if (resting) {
    const floor = Math.max(0, resting.floor || 0);
    next.exhaustion = needs.exhaustion > floor
      ? Math.max(floor, needs.exhaustion - REST_PER_GAME_HOUR * h)
      : needs.exhaustion;
  } else {
    next.exhaustion = clamp('exhaustion', needs.exhaustion + NEEDS.exhaustion.perGameHour * h);
  }

  const area = AREAS[ctx.area] || AREAS.temperate;
  const warmth = Math.min(0.8, Math.max(0, ctx.warmth || 0));
  if (needs.cold < area.ceiling) {
    next.cold = Math.min(area.ceiling, needs.cold + area.gain * (1 - warmth) * h);
  } else if (needs.cold > area.ceiling) {
    next.cold = Math.max(area.ceiling, needs.cold - area.recover * h);
  }
  next.cold = clamp('cold', next.cold);
  return next;
}

/**
 * Needs after eating.
 * @param {{hunger?:string, cold?:boolean, warmth?:boolean}|null} food - from survival-data foods
 * @returns {{needs:object, warmthHours:number}|null} null when it is not a survival food
 */
function eat(needs, food) {
  if (!food) return null;
  const next = { ...needs };
  if (food.hunger && FOOD_HUNGER[food.hunger]) next.hunger = clamp('hunger', needs.hunger - FOOD_HUNGER[food.hunger]);
  if (food.cold) next.cold = clamp('cold', needs.cold - HOT_FOOD_COLD);
  return { needs: next, warmthHours: food.warmth ? HOT_FOOD_WARMTH_HOURS : 0 };
}

module.exports = {
  NEEDS,
  AREAS,
  AREA_RULES,
  FOOD_HUNGER,
  HOT_FOOD_COLD,
  HOT_FOOD_WARMTH_HOURS,
  REST_PER_GAME_HOUR,
  BEDROLL_REST_FLOOR,
  stageOf,
  describe,
  pointInPolygon,
  prepareRegions,
  regionsAt,
  areaAt,
  warmthOf,
  advance,
  eat
};
