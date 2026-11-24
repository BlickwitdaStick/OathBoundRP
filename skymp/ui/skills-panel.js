/**
 * skills-panel.js — F3 skills menu (gamemode/skills-service.js)
 *
 * First visit: choose a profession, a combat skill and an armor skill.
 * Afterwards: a rail of tabs (one per skill category, plus Attributes). A
 * category tab shows that category's skills, the chosen skill's progress and
 * its tree by path; Attributes shows the sheet with points to spend. Magic
 * shows the school choice once a teacher unlocked it.
 *
 * Server → CEF: `skillsPanelData` property → window.handleSkillsPanelData.
 * CEF → server: `skills:*` UI events. The server re-checks everything; this
 * file decides nothing. `sendUiEvent` is a global from index.html.
 *
 * Only plain DOM calls (createElement, appendChild, textContent, className):
 * the in-game browser is old CEF and the tests run against a minimal fake DOM.
 */

(function () {
  'use strict';

  const CATEGORY_META = {
    profession: { name: 'Profession', rune: 'ᚲ' },
    combat: { name: 'Combat', rune: 'ᛏ' },
    armor: { name: 'Armor', rune: 'ᛉ' },
    magic: { name: 'Magic', rune: 'ᛗ' }
  };
  const CATEGORY_ORDER = ['profession', 'combat', 'armor', 'magic'];
  const ATTRIBUTES_TAB = 'attributes';

  const state = {
    open: false,
    data: null,
    tab: null,
    selected: {},
    pick: { profession: null, combat: null, armor: null },
    magic: null,
    spend: {}
  };

  function $(id) { return document.getElementById(id); }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function button(text, className, onClick, disabled) {
    const b = el('button', 'sk-btn' + (className ? ' ' + className : ''), text);
    b.type = 'button';
    b.disabled = Boolean(disabled);
    b.onclick = onClick;
    return b;
  }

  function signed(n) { return n > 0 ? '+' + n : String(n); }

  function progressBar(pct, className) {
    const bar = el('div', 'sk-bar' + (className ? ' ' + className : ''));
    const fill = el('div', 'sk-bar-fill');
    fill.style.width = Math.max(0, Math.min(100, pct)) + '%';
    bar.appendChild(fill);
    return bar;
  }

  function skillPct(s) {
    if (s.legendary || !s.needed) return 100;
    return Math.round(100 * s.into / s.needed);
  }

  function tierBadge(s) {
    return el('span', 'sk-tier tier-' + String(s.tier || '').toLowerCase(), s.legendary ? 'Legendary' : s.tier);
  }

  // ── Start choice ───────────────────────────────────────────────────────

  function renderChoice(root, data) {
    root.appendChild(el('p', 'sk-intro', 'Choose your path. Your profession and your combat and armor skills can grow to Master. ' +
      'A Master can later train you in a second one up to Adept. Magic must be taught before it can be chosen.'));
    let step = 0;
    for (const group of data.catalog) {
      if (group.category === 'magic') continue;
      step += 1;
      const section = el('div', 'sk-step');
      const head = el('div', 'sk-step-head');
      head.appendChild(el('span', 'sk-step-num', step));
      head.appendChild(el('span', 'sk-step-title', 'Choose your ' + (CATEGORY_META[group.category] ? CATEGORY_META[group.category].name.toLowerCase() : group.name)));
      const chosen = group.skills.find(s => s.code === state.pick[group.category]);
      if (chosen) head.appendChild(el('span', 'sk-step-chosen', chosen.practitioner || chosen.name));
      section.appendChild(head);
      const grid = el('div', 'sk-cards');
      for (const s of group.skills) {
        const card = el('button', 'sk-card' + (state.pick[group.category] === s.code ? ' selected' : ''));
        card.type = 'button';
        card.appendChild(el('div', 'sk-card-name', s.practitioner || s.name));
        if (s.description) card.appendChild(el('div', 'sk-card-desc', s.description));
        if (s.attribute) card.appendChild(el('div', 'sk-card-attr', 'Governed by ' + s.attribute));
        card.onclick = () => { state.pick[group.category] = s.code; render(); };
        grid.appendChild(card);
      }
      section.appendChild(grid);
      root.appendChild(section);
    }
    const ready = state.pick.profession && state.pick.combat && state.pick.armor;
    const bar = el('div', 'sk-actions sk-sticky');
    bar.appendChild(el('span', 'sk-note', ready ? 'Your path is set. It cannot be changed later.' : 'Pick one of each to begin.'));
    bar.appendChild(button('Begin', 'primary', () => sendUiEvent('skills:choose', state.pick), !ready));
    root.appendChild(bar);
  }

  // ── Chosen: rail + tab content ─────────────────────────────────────────

  function categoriesOf(p) {
    const present = CATEGORY_ORDER.filter(c => p.skills.some(s => s.category === c));
    if (!present.includes('magic')) present.push('magic');
    return present;
  }

  function renderRail(root, p, tabs) {
    const rail = el('nav', 'sk-rail');
    for (const tab of tabs) {
      const isAttr = tab === ATTRIBUTES_TAB;
      const meta = isAttr ? { name: 'Attributes', rune: 'ᚨ' } : CATEGORY_META[tab];
      const b = el('button', 'sk-tab' + (state.tab === tab ? ' active' : ''));
      b.type = 'button';
      b.appendChild(el('span', 'sk-rune', meta.rune));
      b.appendChild(el('span', 'sk-tab-label', meta.name));
      if (isAttr && p.attributePoints > 0) b.appendChild(el('span', 'sk-badge', p.attributePoints));
      if (!isAttr) {
        const top = p.skills.filter(s => s.category === tab).sort((a, b2) => b2.level - a.level)[0];
        if (top) b.appendChild(el('span', 'sk-tab-level', top.level));
        else if (tab === 'magic' && !p.magicUnlocked) b.appendChild(el('span', 'sk-tab-lock', '✕'));
      }
      b.onclick = () => { state.tab = tab; render(); };
      rail.appendChild(b);
    }
    root.appendChild(rail);
  }

  function renderSkillTabs(root, list) {
    if (list.length < 2) return;
    const row = el('div', 'sk-subtabs');
    for (const s of list) {
      const b = el('button', 'sk-subtab' + (state.selected[s.category] === s.code ? ' active' : ''));
      b.type = 'button';
      b.appendChild(el('span', '', s.name + (s.slot === 'secondary' ? ' (trained)' : '')));
      b.appendChild(el('span', 'sk-subtab-level', s.level));
      b.onclick = () => { state.selected[s.category] = s.code; render(); };
      row.appendChild(b);
    }
    root.appendChild(row);
  }

  function renderHero(root, s) {
    const hero = el('div', 'sk-hero');
    const left = el('div', 'sk-hero-main');
    left.appendChild(el('div', 'sk-hero-eyebrow', (s.practitioner || CATEGORY_META[s.category].name) + (s.slot === 'secondary' ? ' · trained' : '')));
    const name = el('div', 'sk-hero-name', s.name);
    left.appendChild(name);
    const meta = el('div', 'sk-hero-meta');
    meta.appendChild(tierBadge(s));
    meta.appendChild(el('span', 'sk-hero-level', 'Level ' + s.level + ' of ' + s.cap));
    if (s.modifier) meta.appendChild(el('span', 'sk-chip', signed(s.modifier) + ' from attribute'));
    left.appendChild(meta);
    left.appendChild(progressBar(skillPct(s), 'big'));
    left.appendChild(el('div', 'sk-hero-exp', s.legendary ? 'Legendary' : (s.needed ? s.into + ' / ' + s.needed + ' EXP to level ' + (s.level + 1) : 'Highest level this skill can reach')));
    hero.appendChild(left);

    const points = el('div', 'sk-hero-points');
    if (s.wholeTree) {
      points.appendChild(el('div', 'sk-points-num', '★'));
      points.appendChild(el('div', 'sk-points-label', 'Master: the whole tree is yours'));
    } else {
      points.appendChild(el('div', 'sk-points-num', s.pointsFree));
      points.appendChild(el('div', 'sk-points-label', 'point' + (s.pointsFree === 1 ? '' : 's') + ' to spend'));
      points.appendChild(el('div', 'sk-points-hint', '1 point every 5 levels'));
    }
    hero.appendChild(points);
    root.appendChild(hero);
    if (s.legendary && s.legendaryBonus) root.appendChild(el('div', 'sk-legend', 'Legendary bonus: ' + s.legendaryBonus));
  }

  function renderTree(root, skill) {
    const owned = new Set(skill.nodes.filter(n => n.owned).map(n => n.code));
    const paths = [];
    for (const n of skill.nodes) if (!paths.includes(n.path)) paths.push(n.path);
    if (!paths.length) return;
    root.appendChild(el('div', 'sk-section-title', 'Skill tree'));
    const columns = el('div', 'sk-paths');
    for (const path of paths) {
      const col = el('div', 'sk-path');
      col.appendChild(el('div', 'sk-path-name', path));
      const chain = el('div', 'sk-chain');
      for (const n of skill.nodes.filter(x => x.path === path)) {
        const reqOk = n.requires.length === 0 || n.requires.some(r => owned.has(r));
        const canBuy = !n.owned && !skill.wholeTree && reqOk && skill.level >= n.minLevel && skill.pointsFree > 0;
        const status = n.owned ? 'owned' : canBuy ? 'available' : 'locked';
        const node = el('div', 'sk-node ' + status);
        node.appendChild(el('span', 'sk-node-mark', n.owned ? '◆' : canBuy ? '◇' : '·'));
        const body = el('div', 'sk-node-body');
        const top = el('div', 'sk-node-top');
        top.appendChild(el('span', 'sk-node-name', n.name));
        top.appendChild(el('span', 'sk-node-req', (n.kind === 'perk' ? 'Perk · ' : '') + 'Lv ' + n.minLevel));
        body.appendChild(top);
        if (n.effect) body.appendChild(el('div', 'sk-node-effect', n.effect));
        if (!n.owned && !canBuy && skill.level < n.minLevel) body.appendChild(el('div', 'sk-node-why', 'Reach level ' + n.minLevel));
        else if (!n.owned && !canBuy && !reqOk) body.appendChild(el('div', 'sk-node-why', 'Learn the step before it'));
        if (canBuy) body.appendChild(button('Learn', 'small primary', () => sendUiEvent('skills:buyNode', { skill: skill.code, node: n.code })));
        node.appendChild(body);
        chain.appendChild(node);
      }
      col.appendChild(chain);
      columns.appendChild(col);
    }
    root.appendChild(columns);
  }

  function renderMagicChoice(root, p) {
    const box = el('div', 'sk-empty');
    if (!p.magicUnlocked) {
      box.appendChild(el('div', 'sk-empty-rune', 'ᛗ'));
      box.appendChild(el('div', 'sk-empty-title', 'Magic is closed to you'));
      box.appendChild(el('div', 'sk-note', 'You have not learned the basics of spellcasting. Find a teacher who will show you.'));
      root.appendChild(box);
      return;
    }
    box.appendChild(el('div', 'sk-empty-title', 'Choose a school of magic'));
    box.appendChild(el('div', 'sk-note', 'Your teacher opened the way. One school can grow to Master.'));
    root.appendChild(box);
    const magic = (state.data.catalog.find(g => g.category === 'magic') || { skills: [] }).skills;
    const grid = el('div', 'sk-cards');
    for (const school of magic) {
      const card = el('button', 'sk-card' + (state.magic === school.code ? ' selected' : ''));
      card.type = 'button';
      card.appendChild(el('div', 'sk-card-name', school.name));
      if (school.description) card.appendChild(el('div', 'sk-card-desc', school.description));
      if (school.attribute) card.appendChild(el('div', 'sk-card-attr', 'Governed by ' + school.attribute));
      card.onclick = () => { state.magic = school.code; render(); };
      grid.appendChild(card);
    }
    root.appendChild(grid);
    const bar = el('div', 'sk-actions');
    bar.appendChild(button('Study this school', 'primary', () => sendUiEvent('skills:chooseMagic', { school: state.magic }), !state.magic));
    root.appendChild(bar);
  }

  function renderCategory(root, p, category) {
    const list = p.skills.filter(s => s.category === category);
    if (!list.length) {
      if (category === 'magic') renderMagicChoice(root, p);
      return;
    }
    if (!list.some(s => s.code === state.selected[category])) state.selected[category] = list[0].code;
    renderSkillTabs(root, list);
    const skill = list.find(s => s.code === state.selected[category]);
    renderHero(root, skill);
    renderTree(root, skill);
  }

  function renderAttributes(root, p) {
    const pending = Object.values(state.spend).reduce((a, b) => a + b, 0);
    const left = p.attributePoints - pending;
    const head = el('div', 'sk-attr-head');
    head.appendChild(el('div', 'sk-note', '50 is average. Every 5 above or below gives ±1 to the skills it governs.'));
    if (p.attributePoints > 0) head.appendChild(el('span', 'sk-chip gold', left + ' point' + (left === 1 ? '' : 's') + ' left'));
    root.appendChild(head);
    const grid = el('div', 'sk-attr-grid');
    for (const a of p.attributes) {
      const add = state.spend[a.key] || 0;
      const value = a.value + add;
      const row = el('div', 'sk-attr' + (add ? ' changed' : ''));
      const top = el('div', 'sk-attr-top');
      top.appendChild(el('span', 'sk-attr-name', a.name));
      top.appendChild(el('span', 'sk-attr-value', value + (add ? ' (' + signed(add) + ')' : '')));
      if (a.modifier) top.appendChild(el('span', 'sk-attr-mod ' + (a.modifier > 0 ? 'up' : 'down'), signed(a.modifier)));
      row.appendChild(top);
      const bar = progressBar(value, 'attr');
      bar.appendChild(el('span', 'sk-bar-mid'));
      row.appendChild(bar);
      if (p.attributePoints > 0) {
        const ctl = el('div', 'sk-attr-ctl');
        ctl.appendChild(button('−', 'small', () => { state.spend[a.key] = Math.max(0, add - 1); render(); }, add === 0));
        ctl.appendChild(button('+', 'small', () => { state.spend[a.key] = add + 1; render(); }, left <= 0 || value >= 100));
        row.appendChild(ctl);
      }
      grid.appendChild(row);
    }
    root.appendChild(grid);
    if (p.attributePoints > 0) {
      const bar = el('div', 'sk-actions');
      bar.appendChild(button('Reset', '', () => { state.spend = {}; render(); }, pending === 0));
      bar.appendChild(button('Confirm', 'primary', () => {
        const spend = state.spend;
        state.spend = {};
        sendUiEvent('skills:spendAttributes', { spend });
      }, pending === 0));
      root.appendChild(bar);
    }
  }

  function renderChosen(root, data) {
    const p = data.profile;
    const tabs = categoriesOf(p).concat([ATTRIBUTES_TAB]);
    if (!tabs.includes(state.tab)) state.tab = tabs[0];
    const body = el('div', 'sk-body');
    renderRail(body, p, tabs);
    const main = el('div', 'sk-main');
    if (state.tab === ATTRIBUTES_TAB) renderAttributes(main, p);
    else renderCategory(main, p, state.tab);
    body.appendChild(main);
    root.appendChild(body);
  }

  function renderHeaderChips(head, data) {
    const p = data && data.profile;
    if (!p || !p.chosen) return;
    const chips = el('div', 'sk-head-chips');
    chips.appendChild(el('span', 'sk-chip', 'Level ' + p.characterLevel));
    if (p.soul) chips.appendChild(el('span', 'sk-chip', 'Soul: ' + p.soul.tier + ' ' + p.soul.level + (p.soul.expBonusPct ? ' (+' + p.soul.expBonusPct + '% EXP)' : '')));
    if (p.race) chips.appendChild(el('span', 'sk-chip', p.race));
    head.appendChild(chips);
  }

  // ── Shell ──────────────────────────────────────────────────────────────

  function render() {
    const panel = $('skills-panel');
    if (!panel) return;
    panel.innerHTML = '';
    const shell = el('div', 'sk-shell');
    const head = el('div', 'sk-head');
    const text = el('div', 'sk-head-text');
    text.appendChild(el('div', 'sk-eyebrow', 'ᛋ  Skills'));
    text.appendChild(el('div', 'sk-title', state.data && state.data.profile && state.data.profile.chosen ? 'Your path' : 'Choose your path'));
    head.appendChild(text);
    renderHeaderChips(head, state.data);
    const close = button('×', 'sk-close', closePanel);
    close.setAttribute('aria-label', 'Close');
    head.appendChild(close);
    shell.appendChild(head);

    const result = state.data && state.data.result;
    if (result && result.message) shell.appendChild(el('div', 'sk-result ' + (result.ok ? 'ok' : 'bad'), result.message));

    const content = el('div', 'sk-content');
    if (!state.data) content.appendChild(el('div', 'sk-note', 'Loading…'));
    else if (!state.data.profile.chosen) renderChoice(content, state.data);
    else renderChosen(content, state.data);
    shell.appendChild(content);
    panel.appendChild(shell);
  }

  // The key press that opened the menu (F3, or the Esc taps that close
  // Skyrim's Tab menu) can reach the page right after focus moves; it must
  // not close the menu again. Same idea as CHAT_OPEN_GUARD_MS in index.html.
  const OPEN_KEY_GUARD_MS = 400;

  function openPanel() {
    state.open = true;
    state.openedAt = Date.now();
    const panel = $('skills-panel');
    if (panel) {
      panel.classList.add('open');
      panel.setAttribute('aria-hidden', 'false');
    }
    render();
    sendUiEvent('skills:open', {});
  }

  function closePanel() {
    state.open = false;
    state.spend = {};
    const panel = $('skills-panel');
    if (panel) {
      panel.classList.remove('open');
      panel.setAttribute('aria-hidden', 'true');
    }
    sendUiEvent('skills:close', {});
  }

  // Server data only fills a menu the player opened (F3 / Tab → Skills), which
  // also focused the browser. It used to open the menu itself, so the value
  // re-delivered at login, or the answer to `skills:open` arriving after the
  // player had already closed it, put the menu on screen with no cursor.
  window.handleSkillsPanelData = (data) => {
    state.data = typeof normalizePayload === 'function' ? normalizePayload(data) : data;
    if (state.open) render();
  };

  window.openSkillsPanel = openPanel;

  /** Scan code of the "Open skills menu" keybind (F3 until the server says otherwise). */
  function skillsKeyCode() {
    const binds = typeof window.getKeybinds === 'function' ? window.getKeybinds() : null;
    return binds && Object.prototype.hasOwnProperty.call(binds, 'skills.open') ? binds['skills.open'] : 61;
  }

  window.addEventListener('keydown', (event) => {
    if (!state.open || event.defaultPrevented) return;
    if (event.repeat || Date.now() - (state.openedAt || 0) < OPEN_KEY_GUARD_MS) return;
    if (event.key === 'Escape') { closePanel(); return; }
    // While the menu has focus the game ignores keys, so its own key closes it
    // from here (same as F2 for the player panel). Not while typing.
    const t = event.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    const code = skillsKeyCode();
    const KB = window.OathboundKeybinds;
    if (KB && code !== null && code !== undefined && KB.scanCodeFromDomCode(event.code) === code) {
      event.preventDefault();
      closePanel();
    }
  });

  window.SkillsPanel = { open: openPanel, close: closePanel, isOpen: () => state.open };
})();
