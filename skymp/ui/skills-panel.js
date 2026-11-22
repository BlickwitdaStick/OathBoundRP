/**
 * skills-panel.js — F3 skills menu (gamemode/skills-service.js)
 *
 * First visit: choose a profession, a combat skill and an armor skill.
 * Afterwards: skills with tier/level/EXP, each skill's tree by path, the
 * attribute sheet with points to spend, the soul level, and the choice of a
 * school of magic once a teacher unlocked it.
 *
 * Server → CEF: `skillsPanelData` property → window.handleSkillsPanelData.
 * CEF → server: `skills:*` UI events. The server re-checks everything; this
 * file decides nothing. `sendUiEvent` is a global from index.html.
 */

(function () {
  'use strict';

  const state = {
    open: false,
    data: null,
    selected: null,
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

  // ── Start choice ───────────────────────────────────────────────────────

  function renderChoice(root, data) {
    root.appendChild(el('p', 'sk-intro', 'Choose your path. Your profession and your combat and armor skills can grow to Master. ' +
      'A Master can later train you in a second one up to Adept. Magic must be taught before it can be chosen.'));
    for (const group of data.catalog) {
      if (group.category === 'magic') continue;
      root.appendChild(el('div', 'sk-section-title', group.name));
      const grid = el('div', 'sk-cards');
      for (const s of group.skills) {
        const card = el('button', 'sk-card' + (state.pick[group.category] === s.code ? ' selected' : ''));
        card.type = 'button';
        card.appendChild(el('div', 'sk-card-name', s.practitioner || s.name));
        card.appendChild(el('div', 'sk-card-desc', s.description));
        if (s.attribute) card.appendChild(el('div', 'sk-card-attr', 'Governed by ' + s.attribute));
        card.onclick = () => { state.pick[group.category] = s.code; render(); };
        grid.appendChild(card);
      }
      root.appendChild(grid);
    }
    const ready = state.pick.profession && state.pick.combat && state.pick.armor;
    const bar = el('div', 'sk-actions');
    bar.appendChild(button('Begin', 'primary', () => sendUiEvent('skills:choose', state.pick), !ready));
    root.appendChild(bar);
  }

  // ── Chosen: overview ───────────────────────────────────────────────────

  function renderHeader(root, p) {
    const head = el('div', 'sk-stats');
    const stat = (label, value) => {
      const box = el('div', 'sk-stat');
      box.appendChild(el('div', 'sk-stat-label', label));
      box.appendChild(el('div', 'sk-stat-value', value));
      head.appendChild(box);
    };
    stat('Character level', p.characterLevel);
    stat('Soul', p.soul.tier + ' ' + p.soul.level + (p.soul.expBonusPct ? ' (+' + p.soul.expBonusPct + '% EXP)' : ''));
    stat('Attribute points', p.attributePoints);
    if (p.race) stat('Race', p.race);
    root.appendChild(head);
  }

  function renderSkillList(root, p) {
    const list = el('div', 'sk-list');
    let lastCategory = null;
    for (const s of p.skills) {
      if (s.category !== lastCategory) {
        list.appendChild(el('div', 'sk-list-cat', s.category.charAt(0).toUpperCase() + s.category.slice(1)));
        lastCategory = s.category;
      }
      const row = el('button', 'sk-skill' + (state.selected === s.code ? ' selected' : ''));
      row.type = 'button';
      const top = el('div', 'sk-skill-top');
      top.appendChild(el('span', 'sk-skill-name', s.name + (s.slot === 'secondary' ? ' (trained)' : '')));
      top.appendChild(el('span', 'sk-skill-tier tier-' + s.tier.toLowerCase(), s.tier + ' ' + s.level));
      row.appendChild(top);
      const bar = el('div', 'sk-bar');
      const fill = el('div', 'sk-bar-fill');
      fill.style.width = (s.legendary || !s.needed ? 100 : Math.min(100, Math.round(100 * s.into / s.needed))) + '%';
      bar.appendChild(fill);
      row.appendChild(bar);
      const meta = s.legendary ? 'Legendary' : (s.needed ? s.into + ' / ' + s.needed + ' EXP' : 'Highest level for this skill');
      row.appendChild(el('div', 'sk-skill-meta', meta + (s.modifier ? ' · ' + signed(s.modifier) + ' from attribute' : '')));
      row.onclick = () => { state.selected = s.code; render(); };
      list.appendChild(row);
    }
    if (p.magicUnlocked && !p.skills.some(s => s.category === 'magic')) {
      list.appendChild(el('div', 'sk-list-cat', 'Magic'));
      const magic = (state.data.catalog.find(g => g.category === 'magic') || { skills: [] }).skills;
      const pick = el('div', 'sk-magic');
      for (const school of magic) {
        pick.appendChild(button(school.name, state.magic === school.code ? 'selected' : '', () => { state.magic = school.code; render(); }));
      }
      pick.appendChild(button('Study this school', 'primary', () => sendUiEvent('skills:chooseMagic', { school: state.magic }), !state.magic));
      list.appendChild(pick);
    } else if (!p.magicUnlocked) {
      list.appendChild(el('div', 'sk-note', 'Magic: you have not learned the basics of spellcasting. Find a teacher.'));
    }
    root.appendChild(list);
  }

  function renderTree(root, skill) {
    const box = el('div', 'sk-tree');
    const title = el('div', 'sk-tree-head');
    title.appendChild(el('div', 'sk-tree-name', skill.name));
    title.appendChild(el('div', 'sk-tree-points', skill.wholeTree
      ? 'Master: the whole tree is yours'
      : skill.pointsFree + ' point(s) to spend · 1 point every 5 levels'));
    box.appendChild(title);
    if (skill.legendary && skill.legendaryBonus) box.appendChild(el('div', 'sk-legend', 'Legendary bonus: ' + skill.legendaryBonus));

    const owned = new Set(skill.nodes.filter(n => n.owned).map(n => n.code));
    const paths = [];
    for (const n of skill.nodes) if (!paths.includes(n.path)) paths.push(n.path);
    const columns = el('div', 'sk-paths');
    for (const path of paths) {
      const col = el('div', 'sk-path');
      col.appendChild(el('div', 'sk-path-name', path));
      for (const n of skill.nodes.filter(x => x.path === path)) {
        const reqOk = n.requires.length === 0 || n.requires.some(r => owned.has(r));
        const canBuy = !n.owned && !skill.wholeTree && reqOk && skill.level >= n.minLevel && skill.pointsFree > 0;
        const node = el('div', 'sk-node' + (n.owned ? ' owned' : canBuy ? ' available' : ' locked'));
        node.appendChild(el('div', 'sk-node-name', n.name));
        node.appendChild(el('div', 'sk-node-meta', 'Level ' + n.minLevel + (n.kind === 'perk' ? ' · perk' : '')));
        if (n.effect) node.appendChild(el('div', 'sk-node-effect', n.effect));
        if (canBuy) node.appendChild(button('Learn', 'small', () => sendUiEvent('skills:buyNode', { skill: skill.code, node: n.code })));
        col.appendChild(node);
      }
      columns.appendChild(col);
    }
    box.appendChild(columns);
    root.appendChild(box);
  }

  function renderAttributes(root, p) {
    const box = el('div', 'sk-attrs');
    box.appendChild(el('div', 'sk-section-title', 'Attributes · 50 is average; every 5 above or below is ±1 to its skills'));
    const pending = Object.values(state.spend).reduce((a, b) => a + b, 0);
    const left = p.attributePoints - pending;
    const grid = el('div', 'sk-attr-grid');
    for (const a of p.attributes) {
      const add = state.spend[a.key] || 0;
      const row = el('div', 'sk-attr');
      row.appendChild(el('span', 'sk-attr-name', a.name));
      row.appendChild(el('span', 'sk-attr-value', (a.value + add) + (a.modifier ? ' (' + signed(a.modifier) + ')' : '')));
      if (p.attributePoints > 0) {
        row.appendChild(button('−', 'small', () => { state.spend[a.key] = Math.max(0, add - 1); render(); }, add === 0));
        row.appendChild(button('+', 'small', () => { state.spend[a.key] = add + 1; render(); }, left <= 0 || a.value + add >= 100));
      }
      grid.appendChild(row);
    }
    box.appendChild(grid);
    if (p.attributePoints > 0) {
      const bar = el('div', 'sk-actions');
      bar.appendChild(el('span', 'sk-note', left + ' point(s) left'));
      bar.appendChild(button('Confirm', 'primary', () => {
        const spend = state.spend;
        state.spend = {};
        sendUiEvent('skills:spendAttributes', { spend });
      }, pending === 0));
      box.appendChild(bar);
    }
    root.appendChild(box);
  }

  function renderChosen(root, data) {
    const p = data.profile;
    renderHeader(root, p);
    if (!state.selected || !p.skills.some(s => s.code === state.selected)) {
      state.selected = p.skills.length ? p.skills[0].code : null;
    }
    const body = el('div', 'sk-body');
    renderSkillList(body, p);
    const right = el('div', 'sk-right');
    const skill = p.skills.find(s => s.code === state.selected);
    if (skill) renderTree(right, skill);
    renderAttributes(right, p);
    body.appendChild(right);
    root.appendChild(body);
  }

  // ── Shell ──────────────────────────────────────────────────────────────

  function render() {
    const panel = $('skills-panel');
    if (!panel) return;
    panel.innerHTML = '';
    const shell = el('div', 'sk-shell');
    const head = el('div', 'sk-head');
    const text = el('div');
    text.appendChild(el('div', 'sk-eyebrow', 'Skills'));
    text.appendChild(el('div', 'sk-title', state.data && state.data.profile && state.data.profile.chosen ? 'Your path' : 'Choose your path'));
    head.appendChild(text);
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
