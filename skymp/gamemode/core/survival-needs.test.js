'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const n = require('./survival-needs');
const data = require('../data/survival-data.json');

const TAMRIEL = 0x3c;
const square = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
/** Fake map: each named region is one square in Tamriel. */
function fakeMap(squares) {
  const regions = {};
  for (const [editorId, sq] of Object.entries(squares)) regions[editorId] = { worldspace: '0x3c', areas: [sq] };
  return n.prepareRegions(regions);
}
const outside = (prepared, x, y, z = 0) => n.areaAt(prepared, { interior: false, worldspace: TAMRIEL, pos: [x, y, z] });

describe('survival-needs: stages', () => {
  it('names hunger stages at Survival Mode thresholds', () => {
    assert.equal(n.describe('hunger', 0).name, 'Well Fed');
    assert.equal(n.describe('hunger', 79).name, 'Well Fed');
    assert.equal(n.describe('hunger', 80).name, 'Satisfied');
    assert.equal(n.describe('hunger', 340).name, 'Hungry');
    assert.equal(n.describe('hunger', 1000).name, 'Starving');
    assert.equal(n.describe('exhaustion', 500).name, 'Weary');
    assert.equal(n.describe('cold', 800).name, 'Numb');
  });
});

describe('survival-needs: areas from map regions', () => {
  const map = fakeMap({
    WeatherSnow: square(0, 0, 100, 100),
    WeatherRiften: square(200, 0, 300, 100),
    WeatherWhiterun: square(400, 0, 500, 100),
    WeatherMountains: square(450, 0, 600, 100),
    WeatherPineForest: square(700, 0, 800, 100),
    WeatherTundra: square(900, 0, 1000, 100),
    SurvivalForelhost: square(1100, 0, 1200, 100),
    WeatherFallForest: square(1100, 0, 1200, 100)
  });

  it('snow is freezing, Riften is warm, Whiterun is cool', () => {
    assert.equal(outside(map, 50, 50), 'freezing');
    assert.equal(outside(map, 250, 50), 'warm');
    assert.equal(outside(map, 420, 50), 'cool');
  });

  it('mountains overlapping Whiterun make it freezing, not cool', () => {
    assert.equal(outside(map, 470, 50), 'freezing');
  });

  it('anywhere at Z 19000 or higher is freezing', () => {
    assert.equal(outside(map, 250, 50, 19000), 'freezing');
    assert.equal(outside(map, 5000, 5000, 20000), 'freezing');
  });

  it('southern forest is warm low down; with mountains above Z 2000 it is freezing', () => {
    const withMountains = fakeMap({ WeatherPineForest: square(0, 0, 100, 100), WeatherMountains: square(0, 0, 100, 100) });
    assert.equal(outside(withMountains, 50, 50, 1999), 'freezing', 'mountains alone are freezing');
    const forest = fakeMap({ WeatherPineForest: square(0, 0, 100, 100) });
    assert.equal(outside(forest, 50, 50, 5000), 'warm');
  });

  it('Forelhost is warm fall forest below Z 15150 and freezing above', () => {
    assert.equal(outside(map, 1150, 50, 15000), 'warm');
    assert.equal(outside(map, 1150, 50, 15150), 'freezing');
  });

  it('tundra is cool; outside every region is mild', () => {
    assert.equal(outside(map, 950, 50), 'cool');
    assert.equal(outside(map, -500, -500), 'temperate');
  });

  it('another worldspace does not match Tamriel regions', () => {
    assert.equal(n.areaAt(map, { interior: false, worldspace: 0x4000800, pos: [50, 50, 0] }), 'temperate');
  });

  it('interiors are warm, listed cold interiors are cold', () => {
    assert.equal(n.areaAt(map, { interior: true }), 'indoors');
    assert.equal(n.areaAt(map, { interior: true, coldInterior: true }), 'coldIndoors');
  });
});

describe('survival-needs: the real map (data/survival-data.json)', () => {
  const prepared = n.prepareRegions(data.regions);

  it('has every region the rules name', () => {
    const named = new Set();
    for (const rule of Object.values(n.AREA_RULES)) {
      for (const key of ['anyOf', 'allOf', 'noneOf']) for (const r of rule[key] || []) named.add(r);
    }
    const missing = [...named].filter((r) => !data.regions[r]);
    assert.deepEqual(missing, []);
  });

  it('Skyrim has freezing, cool, warm and mild ground, and Solstheim has freezing ground', () => {
    const seen = new Set();
    for (let x = -250000; x <= 250000; x += 4096) {
      for (let y = -250000; y <= 250000; y += 4096) seen.add(outside(prepared, x, y, 0));
    }
    assert.deepEqual([...seen].sort(), ['cool', 'freezing', 'temperate', 'warm']);
    const solstheim = Number(data.regions.WeatherDLC2SolstheimSnow.worldspace);
    let freezing = false;
    for (let x = -100000; x <= 100000 && !freezing; x += 2048) {
      for (let y = -100000; y <= 150000 && !freezing; y += 2048) {
        freezing = n.areaAt(prepared, { interior: false, worldspace: solstheim, pos: [x, y, 0] }) === 'freezing';
      }
    }
    assert.ok(freezing);
  });

  it("has the vanilla foods with a meal size, and Survival Mode's hot dishes", () => {
    // Sizes can be re-balanced by hosted mods (Gourmet's survival module), so
    // only check they are known sizes.
    for (const id of ['0x64b43', '0xf4315']) assert.ok(n.FOOD_HUNGER[data.foods[id].hunger], id);
    const hot = Object.entries(data.foods).filter(([k, f]) => f.cold && f.warmth && /SurvivalMode\.esl$/i.test(k));
    assert.equal(hot.length, 12);
    for (const key of Object.keys(data.foods)) assert.match(key, /^(0x[0-9a-f]+|[0-9a-f]+:.+\.(esm|esp|esl))$/i, key);
  });
});

describe('survival-needs: time passing', () => {
  const start = { hunger: 0, exhaustion: 0, cold: 0 };

  it('hunger and exhaustion grow per game hour at Survival Mode rates', () => {
    const after = n.advance(start, 10, { area: 'indoors' });
    assert.equal(after.hunger, 75);
    assert.equal(after.exhaustion, 90);
    assert.equal(after.cold, 0);
  });

  it('needs stop at their maximum', () => {
    const after = n.advance(start, 1000, { area: 'freezing' });
    assert.deepEqual(after, { hunger: 1000, thirst: 1000, exhaustion: 960, cold: 1000 });
  });

  it('a freezing area numbs you in about 1.33 game hours; warm clothes slow it', () => {
    assert.equal(n.describe('cold', n.advance(start, 1.34, { area: 'freezing' }).cold).name, 'Numb');
    const dressed = n.advance(start, 1.34, { area: 'freezing', warmth: 0.5 });
    assert.equal(n.describe('cold', dressed.cold).name, 'Very Cold');
  });

  it('a cool area chills you only to its ceiling; going inside warms you up', () => {
    const chilled = n.advance(start, 10, { area: 'cool' });
    assert.equal(chilled.cold, n.AREAS.cool.ceiling);
    const inside = n.advance({ ...start, cold: 900 }, 1, { area: 'indoors' });
    assert.equal(inside.cold, 400);
  });

  it('resting in a bed removes exhaustion and slows hunger; a bedroll stops at 200', () => {
    const tired = { hunger: 100, exhaustion: 600, cold: 0 };
    const bed = n.advance(tired, 2, { area: 'indoors', resting: { floor: 0 } });
    assert.equal(bed.exhaustion, 360);
    assert.equal(bed.hunger, 107.5);
    const bedroll = n.advance(tired, 10, { area: 'indoors', resting: { floor: n.BEDROLL_REST_FLOOR } });
    assert.equal(bedroll.exhaustion, 200);
  });
});

describe('survival-needs: food and warmth', () => {
  it('meals restore hunger by size; hot dishes also warm you', () => {
    const needs = { hunger: 500, exhaustion: 0, cold: 600 };
    assert.equal(n.eat(needs, { hunger: 'medium' }).needs.hunger, 280);
    const stew = n.eat(needs, { hunger: 'large', cold: true, warmth: true });
    assert.deepEqual(stew.needs, { hunger: 120, exhaustion: 0, cold: 400 });
    assert.equal(stew.warmthHours, n.HOT_FOOD_WARMTH_HOURS);
    assert.equal(n.eat(needs, null), null);
  });

  it('warmth adds up per piece, more for body and head, capped at 0.8', () => {
    assert.equal(n.warmthOf([]), 0);
    assert.equal(n.warmthOf([{ kind: 'warm', bodyOrHead: true }, { kind: 'normal', bodyOrHead: false }]), 0.25);
    assert.equal(n.warmthOf([{ kind: 'cold', bodyOrHead: true }], { torch: true, hotMeal: true }), 0.28);
    assert.equal(n.warmthOf(Array(20).fill({ kind: 'warm', bodyOrHead: true })), 0.8);
  });
});

describe('survival-needs: thirst', () => {
  it('thirst grows faster than hunger; drinks restore it by size', () => {
    const n2 = require('./survival-needs');
    const after = n2.advance({ hunger: 0, thirst: 0, exhaustion: 0, cold: 0 }, 2, { area: 'indoors' });
    assert.equal(after.thirst, 20);
    assert.ok(after.thirst > after.hunger);
    const drunk = n2.eat({ hunger: 100, thirst: 500, exhaustion: 0, cold: 0 }, { thirst: 'medium' });
    assert.equal(drunk.needs.thirst, 280);
    assert.equal(drunk.needs.hunger, 100);
    assert.equal(n2.describe('thirst', 600).name, 'Dehydrated');
  });

  it('characters saved before thirst existed start at 0', () => {
    const n2 = require('./survival-needs');
    const after = n2.advance({ hunger: 0, exhaustion: 0, cold: 0 }, 1, { area: 'indoors' });
    assert.equal(after.thirst, 10);
  });
});
