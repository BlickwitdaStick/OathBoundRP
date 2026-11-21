'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const service = require('./skills-service');
const skills = require('./core/skills');
const skillActivity = require('./core/skill-activity');

const PLAYER = 0xff000010;
const TEACHER = 0xff000020;
const STAFF = 0xff000030;

function setup({ staffActors = [STAFF] } = {}) {
  service._resetForTest();
  const writes = [];
  const notes = [];
  const sets = [];
  let now = 1_000_000;
  const characters = new Map([
    [PLAYER, { characterId: 1 }],
    [TEACHER, { characterId: 2 }],
    [STAFF, { characterId: 3 }]
  ]);
  const db = {
    async query(sql, params) {
      if (/^\s*SELECT/i.test(sql)) return [];
      writes.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      return { affectedRows: 1 };
    }
  };
  const commands = {
    getActiveCharacterData: (actorId) => characters.get(actorId) || null,
    getActiveActorByCharacterId: (id) => {
      for (const [actorId, c] of characters) if (c.characterId === id) return actorId;
      return null;
    },
    listActiveActorIds: () => [...characters.keys()],
    sendNotification: (actorId, message) => notes.push({ actorId, message })
  };
  const mpApi = {
    get: (actorId, prop) => (prop === 'appearance' ? { raceId: 0x13746, isFemale: false } : null),
    set: (actorId, prop, value) => sets.push({ actorId, prop, value })
  };
  service.configure({
    db,
    commands,
    admin: { hasPermission: (actorId, perm) => perm === service.PERMISSION && staffActors.includes(actorId) },
    mp: () => mpApi,
    logger: { log() {}, warn() {}, error() {} },
    now: () => now,
    trackedPlugins: ['Mundus.esp']
  });
  return {
    writes,
    notes,
    sets,
    advance: (ms) => { now += ms; },
    lastPayload: (actorId, prop = service.PROPERTY) => {
      const hits = sets.filter(s => s.actorId === actorId && s.prop === prop);
      return hits.length ? hits[hits.length - 1].value : null;
    }
  };
}

async function start(characterId = 1, actorId = PLAYER, pick = { profession: 'prospector', combat: 'two_handed', armor: 'heavy_armor' }) {
  return service.chooseStart(characterId, actorId, pick);
}

test('chooseStart: base attributes from race/sex, three primary skills, only once', async () => {
  const t = setup();
  const r = await start();
  assert.equal(r.ok, true, r.message);
  const profile = service.buildProfile(await service.loadState(1));
  assert.equal(profile.chosen, true);
  assert.equal(profile.race, 'Nord');
  assert.deepEqual(profile.skills.map(s => [s.code, s.slot, s.level, s.tier]), [
    ['prospector', 'primary', 1, 'Novice'],
    ['two_handed', 'primary', 1, 'Novice'],
    ['heavy_armor', 'primary', 1, 'Novice']
  ]);
  assert.equal(profile.attributes.find(a => a.key === 'strength').value, 50);
  assert.equal(profile.attributes.find(a => a.key === 'intelligence').modifier, -4);
  assert.ok(t.writes.some(w => /INSERT INTO character_progression/.test(w.sql)));
  assert.equal((await start()).ok, false, 'cannot choose twice');
  assert.equal((await start(2, TEACHER, { profession: 'archery', combat: 'archery', armor: 'light_armor' })).ok, false, 'categories checked');
});

test('awardExp: only owned skills, tier-up notice, client resync', async () => {
  const t = setup();
  await start();
  assert.equal((await service.awardExp(1, 'farmer', 500)).code, 'not_owned');
  const r = await service.awardExp(1, 'prospector', skills.expForLevel(20));
  assert.equal(r.level, 20);
  assert.equal(r.tier, 'Apprentice');
  assert.ok(t.notes.some(n => /Prospecting: you are now an Apprentice/.test(n.message)));
  const payload = t.lastPayload(PLAYER);
  assert.ok(payload, 'progression pushed to the client');
  assert.equal(payload.av.HeavyArmor, 1);
  assert.equal(payload.av.TwoHanded, 1);
  assert.equal(payload.av.OneHanded, 0, 'unowned vanilla skills are zeroed');
  assert.equal(payload.av.CarryWeight, 300);
});

test('EXP never reaches Legendary; staff Legendary is 100 and stays 100', async () => {
  setup();
  await start();
  await service.awardExp(1, 'two_handed', 1e12);
  let s = service.buildProfile(await service.loadState(1)).skills.find(x => x.code === 'two_handed');
  assert.equal(s.level, 99);
  assert.equal(s.tier, 'Master');
  const r = await service.staffSetLegendary(1, 'two_handed', true, 'Sunders shields', 3);
  assert.equal(r.ok, true);
  await service.awardExp(1, 'two_handed', 10);
  s = service.buildProfile(await service.loadState(1)).skills.find(x => x.code === 'two_handed');
  assert.equal(s.level, 100);
  assert.equal(s.tier, 'Legendary');
  assert.equal(s.legendaryBonus, 'Sunders shields');
  assert.equal((await service.staffSetLevel(1, 'two_handed', 100, 3)).ok, false, '/skillset cannot reach 100');
});

test('magic is locked until a magic Master or staff teaches it', async () => {
  setup();
  await start();
  await start(2, TEACHER, { profession: 'enchanter', combat: 'one_handed', armor: 'mage_armor' });
  assert.equal((await service.chooseMagic(1, 'destruction')).ok, false);
  assert.match((await service.unlockMagic({ teacherCharacterId: 2, studentCharacterId: 1 })).message, /Master of a school/);
  // Staff unlock for the teacher, who then becomes a Destruction Master.
  assert.equal((await service.unlockMagic({ teacherCharacterId: 3, studentCharacterId: 2, isStaff: true })).ok, true);
  assert.equal((await service.chooseMagic(2, 'destruction')).ok, true);
  await service.staffSetLevel(2, 'destruction', 80, 3);
  assert.equal((await service.unlockMagic({ teacherCharacterId: 2, studentCharacterId: 1 })).ok, true);
  assert.equal((await service.chooseMagic(1, 'restoration')).ok, true);
  assert.equal((await service.chooseMagic(1, 'illusion')).ok, false, 'one primary school');
});

test('training a secondary needs a Master; secondary caps at Adept 59', async () => {
  setup();
  await start();
  await start(2, TEACHER, { profession: 'farmer', combat: 'archery', armor: 'light_armor' });
  assert.match((await service.trainSecondary({ teacherCharacterId: 2, studentCharacterId: 1, skillCode: 'farmer' })).message, /Master/);
  await service.staffSetLevel(2, 'farmer', 85, 3);
  const r = await service.trainSecondary({ teacherCharacterId: 2, studentCharacterId: 1, skillCode: 'farmer' });
  assert.equal(r.ok, true, r.message);
  await service.awardExp(1, 'farmer', 1e12);
  const farmer = service.buildProfile(await service.loadState(1)).skills.find(s => s.code === 'farmer');
  assert.equal(farmer.slot, 'secondary');
  assert.equal(farmer.level, 59);
  assert.equal(farmer.tier, 'Adept');
  assert.equal((await service.trainSecondary({ teacherCharacterId: 2, studentCharacterId: 1, skillCode: 'archery' })).ok, false, 'teacher is not an archery Master');
});

test('tree nodes cost points (1 per 5 levels) and become client perks', async () => {
  const t = setup();
  service.setCatalog({ perkByEditorId: new Map([['Barbarian00', 0xbabe8]]), tracked: new Map(), globalByDesc: new Map(), missingPerks: [], missingPlugins: [], errors: [] });
  await start();
  assert.equal((await service.buyNode(1, 'two_handed', 'barbarian_1')).code, 'points');
  await service.staffSetLevel(1, 'two_handed', 5, 3);
  const r = await service.buyNode(1, 'two_handed', 'barbarian_1');
  assert.equal(r.ok, true, r.message);
  assert.ok(t.lastPayload(PLAYER).perks.includes(0xbabe8));
  await service.staffRemoveSkill(1, 'two_handed', 3);
  assert.ok(t.lastPayload(PLAYER).removePerks.includes(0xbabe8), 'perk removed when the skill is taken away');
});

test('attribute points come from character level; spending raises the modifier', async () => {
  setup();
  await start();
  assert.equal((await service.spendAttributes(1, { strength: 1 })).ok, false, 'no points at character level 1');
  await service.staffSetLevel(1, 'prospector', 11, 3); // 10 levels gained = character level 3 → 6 points
  let profile = service.buildProfile(await service.loadState(1));
  assert.equal(profile.characterLevel, 3);
  assert.equal(profile.attributePoints, 6);
  assert.equal((await service.spendAttributes(1, { strength: 5 })).ok, true);
  profile = service.buildProfile(await service.loadState(1));
  assert.equal(profile.attributes.find(a => a.key === 'strength').value, 55);
  assert.equal(profile.skills.find(s => s.code === 'prospector').modifier, 1);
  assert.equal(profile.skills.find(s => s.code === 'prospector').effectiveLevel, 12);
  assert.equal(profile.attributePoints, 1);
  // Staff edits change the total but not the player's points.
  await service.staffSetAttribute(1, 'intelligence', 60, 3);
  profile = service.buildProfile(await service.loadState(1));
  assert.equal(profile.attributes.find(a => a.key === 'intelligence').value, 60);
  assert.equal(profile.attributePoints, 1);
});

test('soul has its own track: EXP, tiers, attribute bonus, Legendary by staff', async () => {
  setup();
  await start();
  await service.awardSoulExp(1, skills.expForLevel(40));
  let profile = service.buildProfile(await service.loadState(1));
  assert.equal(profile.soul.level, 40);
  assert.equal(profile.soul.tier, 'Adept');
  assert.equal(profile.soul.attributeBonus, 2);
  assert.equal(profile.attributePoints, 2, 'soul tiers give attribute points');
  assert.equal(profile.soul.expBonusPct, 4);
  await service.staffSetLegendary(1, 'soul', true, null, 3);
  profile = service.buildProfile(await service.loadState(1));
  assert.equal(profile.soul.level, 100);
  assert.equal(profile.soul.tier, 'Legendary');
});

test('combat reports: weapon type picks the skill, throttled per skill', async () => {
  const t = setup();
  await start();
  await service.tick(); // marks the actors as synced this session
  await service.handleReport(PLAYER, { kind: 'hit', weaponType: 6, power: false });
  let s = (await service.loadState(1)).skills.get('two_handed');
  assert.equal(s.exp, service.EXP_RULES.hit);
  await service.handleReport(PLAYER, { kind: 'hit', weaponType: 6 });
  assert.equal(s.exp, service.EXP_RULES.hit, 'second hit within the gap is ignored');
  t.advance(service.EXP_RULES.minGapMs);
  await service.handleReport(PLAYER, { kind: 'hit', weaponType: 5, power: true });
  assert.equal(s.exp, service.EXP_RULES.hit + service.EXP_RULES.powerHit);
  await service.handleReport(PLAYER, { kind: 'hit', weaponType: 1 }); // one-handed: not owned
  assert.equal((await service.loadState(1)).skills.has('one_handed'), false);
  await service.handleReport(PLAYER, { kind: 'struck', weightClass: 1 });
  assert.equal((await service.loadState(1)).skills.get('heavy_armor').exp, service.EXP_RULES.struck);
});

test('weapon and armor classification', () => {
  assert.equal(service.skillForWeaponType(0), 'unarmed');
  assert.equal(service.skillForWeaponType(2), 'one_handed');
  assert.equal(service.skillForWeaponType(6), 'two_handed');
  assert.equal(service.skillForWeaponType(9), 'archery');
  assert.equal(service.skillForWeaponType(8), null);
  assert.equal(service.skillForWeightClass(0), 'light_armor');
  assert.equal(service.skillForWeightClass(2), 'mage_armor');
  assert.equal(service.skillForWeightClass(-1), null);
});

test('profession activity maps legacy profession codes to skills', async () => {
  setup();
  await start();
  await service.handleActivity({ characterId: 1, professionCode: 'miner', amount: 30, source: 'mining_gather' });
  assert.equal((await service.loadState(1)).skills.get('prospector').exp, 30);
  assert.equal(await service.handleActivity({ characterId: 1, professionCode: 'unknown', amount: 30 }), null);
});

test('skill-activity bus reaches the service while it runs', async () => {
  setup();
  await start();
  skillActivity._reset();
  const unsubscribe = skillActivity.subscribe(service.handleActivity);
  skillActivity.report({ characterId: 1, skill: 'prospector', amount: 12, source: 'jobs_mining' });
  await new Promise(r => setImmediate(r));
  assert.equal((await service.loadState(1)).skills.get('prospector').exp, 12);
  unsubscribe();
});

test('mod forms (Mundus/Pilgrim): mirrored from reports, re-sent at login, unresolved kept', async () => {
  const t = setup();
  service.setCatalog({
    perkByEditorId: new Map(),
    tracked: new Map([
      [0x0200080d, { kind: 'perk', formDesc: '0x80d:Mundus.esp' }],
      [0x000e5f4c, { kind: 'spell', formDesc: '0xe5f4c:Skyrim.esm' }],
      [0x000e5f47, { kind: 'spell', formDesc: '0xe5f47:Skyrim.esm' }]
    ]),
    globalByDesc: new Map([['0x80d:mundus.esp', 0x0200080d], ['0xe5f4c:skyrim.esm', 0x000e5f4c], ['0xe5f47:skyrim.esm', 0x000e5f47]]),
    missingPerks: [], missingPlugins: [], errors: []
  });
  await start();
  await service.handleReport(PLAYER, { kind: 'mods', sentAt: 1, perks: [0x0200080d], spells: [0x000e5f4c] });
  assert.equal((await service.loadState(1)).modForms.size, 0, 'ignored before this session was synced');
  await service.tick();
  await service.handleReport(PLAYER, { kind: 'mods', sentAt: 1, perks: [0x0200080d, 0x12345], spells: [0x000e5f4c] });
  assert.deepEqual([...(await service.loadState(1)).modForms].sort(), ['perk|0x80d:Mundus.esp', 'spell|0xe5f4c:Skyrim.esm']);
  // Switched stone: Warrior → Mage. The perk could not be resolved this time: kept.
  await service.handleReport(PLAYER, { kind: 'mods', sentAt: 2, perks: [], spells: [0x000e5f47], unresolved: [0x0200080d] });
  assert.deepEqual([...(await service.loadState(1)).modForms].sort(), ['perk|0x80d:Mundus.esp', 'spell|0xe5f47:Skyrim.esm']);
  const payload = service.buildClientPayload(await service.loadState(1));
  assert.ok(payload.perks.includes(0x0200080d));
  assert.deepEqual(payload.spells, [0x000e5f47]);
  assert.deepEqual(payload.tracked.perks, [0x0200080d]);
  assert.ok(t.writes.some(w => /DELETE FROM character_mod_forms/.test(w.sql)));
});

test('staff commands need manage_skills; /legendary parses multi-word skills', async () => {
  const t = setup();
  await start();
  const defs = Object.fromEntries(service.commandDefs().map(d => [d.name, d.handler]));
  await defs['/legendary'](PLAYER, `${PLAYER} two handed Unbreakable grip`);
  assert.ok(t.notes.some(n => n.actorId === PLAYER && n.message === 'Staff only.'));
  await defs['/skillexp'](STAFF, `${PLAYER} two handed 150`);
  assert.equal((await service.loadState(1)).skills.get('two_handed').exp, 150);
  await defs['/legendary'](STAFF, `${PLAYER} two handed Unbreakable grip`);
  const s = (await service.loadState(1)).skills.get('two_handed');
  assert.equal(s.legendary, true);
  assert.equal(s.legendaryBonus, 'Unbreakable grip');
  await defs['/legendary'](STAFF, `${PLAYER} two handed off`);
  assert.equal((await service.loadState(1)).skills.get('two_handed').legendary, false);
  await defs['/skills'](PLAYER, '');
  assert.ok(t.notes.some(n => n.actorId === PLAYER && /^Character level 1/.test(n.message)));
});

test('F3 UI events: open sends the catalog, choose returns a result', async () => {
  const t = setup();
  assert.equal(await service.handleUiEvent(PLAYER, { type: 'skills:open', data: {} }), true);
  let panel = t.lastPayload(PLAYER, service.PANEL_PROPERTY);
  assert.equal(panel.profile.chosen, false);
  assert.deepEqual(panel.catalog.map(c => c.category), ['profession', 'combat', 'armor', 'magic']);
  await service.handleUiEvent(PLAYER, { type: 'skills:choose', data: { profession: 'hunter', combat: 'archery', armor: 'light_armor' } });
  panel = t.lastPayload(PLAYER, service.PANEL_PROPERTY);
  assert.equal(panel.result.ok, true);
  assert.equal(panel.profile.skills.length, 3);
  assert.equal(await service.handleUiEvent(PLAYER, { type: 'panel:open' }), false);
});

test('client snippets are plain strings with the expected hooks', () => {
  assert.match(service.UPDATE_OWNER_SNIPPET, /addPerk/);
  assert.match(service.UPDATE_OWNER_SNIPPET, /addSpell\(obSpell, false\)/);
  assert.match(service.REPORT_SNIPPET, /ctx\.sendEvent\(\{ kind: 'mods'/);
  assert.match(service.REPORT_SNIPPET, /'spellCast'/);
  // Must parse as a function body (that is how SkyMP evaluates them).
  assert.doesNotThrow(() => new Function('ctx', service.UPDATE_OWNER_SNIPPET));
  assert.doesNotThrow(() => new Function('ctx', service.REPORT_SNIPPET));
  assert.doesNotThrow(() => new Function('ctx', service.PANEL_UPDATE_OWNER_SNIPPET));
});

test('older launchers: the F3 menu files go out once per session, and the injector is valid JS', async () => {
  const t = setup();
  const bundle = service.loadUiBundle();
  assert.ok(bundle && bundle.js.includes('window.openSkillsPanel'), 'reads skymp/ui/skills-panel.js');
  await service.tick();
  const first = t.lastPayload(PLAYER);
  assert.equal(first.ui.js, bundle.js);
  await service.awardExp(1, 'nothing', 1); // no-op, just to show nothing is resent
  await start();
  const later = t.lastPayload(PLAYER);
  assert.equal(later.ui, undefined, 'not resent after the first payload');
  assert.doesNotThrow(() => new Function(`return ${service.CEF_INJECTOR}`));
  assert.match(service.UPDATE_OWNER_SNIPPET, /executeJavaScript/);
});

test('Tab → Skills: the vanilla StatsMenu is closed and the F3 menu opens instead', () => {
  const s = service.REPORT_SNIPPET;
  assert.match(s, /e\.name === 'StatsMenu'/);
  assert.match(s, /isMenuOpen\('StatsMenu'\)/);
  assert.match(s, /isMenuOpen\('TweenMenu'\)/);
  assert.match(s, /tapKey\(1\)/, 'Esc closes the vanilla menus');
  assert.match(s, /handlePlayerShortcutKey\("skills:open"\)/);
  assert.match(s, /> 3000/, 'gives up instead of looping');
});
