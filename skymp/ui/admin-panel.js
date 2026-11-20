/**
 * admin-panel.js — F8 staff panel (page side)
 *
 * Tabs: Characters | Items | Creatures | Players. The server
 * (skymp/gamemode/admin-panel-service.js) is the authority: it decides who is
 * staff, what each role may do, and checks it again on every action. This
 * file only draws what it is sent and turns clicks into `admin:*` UI events.
 * Buttons a role cannot use are hidden as a courtesy, never as security.
 *
 * Server → page: `window.handleAdminPanelData({ channels, sentAt })`, from the
 * `adminPanelData` property. Channels: meta, characters, players, items,
 * creatures, spawned, result.
 *
 * Depends on globals from index.html: `sendUiEvent`, `normalizePayload`.
 * Loaded after player-panel.js (reuses its .pp-* styles).
 */

(function () {
  'use strict';

  const ITEM_TYPES = [
    ['', 'All items'], ['WEAP', 'Weapons'], ['ARMO', 'Armor & clothing'], ['MISC', 'Misc'],
    ['ALCH', 'Potions & food'], ['AMMO', 'Arrows & bolts'], ['BOOK', 'Books'], ['INGR', 'Ingredients'],
    ['KEYM', 'Keys'], ['SLGM', 'Soul gems'], ['SCRL', 'Scrolls'], ['LIGH', 'Torches']
  ];
  const TYPE_LABELS = Object.fromEntries(ITEM_TYPES.filter(([k]) => k));
  TYPE_LABELS.NPC_ = 'NPC';
  const SEARCH_DEBOUNCE_MS = 250;
  const DEFAULT_KEY = 66; // F8

  const st = {
    open: false,
    tab: 'characters',
    lastSentAt: null,
    lastOpenSeq: null,
    lastResultSeq: null,
    data: { meta: null, characters: null, players: null, items: null, creatures: null, spawned: null },
    expanded: null,          // { kind: 'retire'|'gold'|'kick', id }
    selectedItem: null,
    selectedCreature: null,
    resultTimer: null
  };

  const $ = (id) => document.getElementById(id);

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function send(type, data) {
    if (typeof sendUiEvent === 'function') sendUiEvent(type, data || {});
  }

  function can(what) {
    return Boolean(st.data.meta && st.data.meta.can && st.data.meta.can[what]);
  }

  function debounce(fn, ms) {
    let t = null;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  }

  // ── open / close ─────────────────────────────────────────────────────────
  function openShell() {
    st.open = true;
    $('admin-panel').classList.add('open');
    render();
  }

  function openAdminPanel() {
    openShell();
    send('admin:open');
  }

  function closeAdminPanel() {
    if (!st.open) return;
    st.open = false;
    st.expanded = null;
    $('admin-panel').classList.remove('open');
    send('admin:close');
  }

  function switchTab(tab) {
    st.tab = tab;
    st.expanded = null;
    for (const btn of document.querySelectorAll('#admin-panel .pp-tab')) {
      btn.classList.toggle('active', btn.dataset.adminTab === tab);
    }
    for (const section of document.querySelectorAll('#admin-panel .pp-section')) {
      section.classList.toggle('active', section.id === `ap-section-${tab}`);
    }
    if (tab === 'players') send('admin:players:refresh');
    if (tab === 'items' && !st.data.items) searchItems();
    if (tab === 'creatures' && !st.data.creatures) searchCreatures();
    render();
  }

  // ── result banner ────────────────────────────────────────────────────────
  function showResult(ok, message) {
    const el = $('ap-result');
    if (!el) return;
    el.textContent = message || (ok ? 'Done.' : 'Failed.');
    el.className = `ap-result show ${ok ? 'ok' : 'err'}`;
    clearTimeout(st.resultTimer);
    st.resultTimer = setTimeout(() => { el.className = 'ap-result'; }, ok ? 4000 : 8000);
  }

  // ── searches ─────────────────────────────────────────────────────────────
  function searchCharacters() {
    send('admin:characters:search', {
      query: $('ap-char-query').value,
      includeRetired: $('ap-char-retired').checked
    });
  }

  function searchItems() {
    send('admin:items:search', { query: $('ap-item-query').value, type: $('ap-item-type').value || undefined });
  }

  function searchCreatures() {
    send('admin:creatures:search', { query: $('ap-creature-query').value });
  }

  // ── rendering ────────────────────────────────────────────────────────────
  function render() {
    renderHeader();
    if (st.tab === 'characters') renderCharacters();
    else if (st.tab === 'items') renderItems();
    else if (st.tab === 'creatures') renderCreatures();
    else if (st.tab === 'players') renderPlayers();
  }

  function renderHeader() {
    const meta = st.data.meta;
    const role = $('ap-role');
    if (role) role.textContent = meta && meta.role ? meta.role : '…';
  }

  function waiting(el) {
    el.innerHTML = '<div class="pp-empty">Waiting for the server…</div>';
  }

  function inlineForm(kind, id, placeholder, buttonLabel, buttonClass, inputType) {
    if (!st.expanded || st.expanded.kind !== kind || st.expanded.id !== id) return '';
    return `
      <div class="ap-inline" data-inline="${esc(kind)}">
        <input class="ap-input grow" data-inline-input type="${inputType || 'text'}" maxlength="500" placeholder="${esc(placeholder)}">
        <button type="button" class="ap-btn ${buttonClass}" data-inline-confirm>${esc(buttonLabel)}</button>
        <button type="button" class="ap-btn" data-inline-cancel>Cancel</button>
      </div>`;
  }

  function wireInline(container, onConfirm) {
    const form = container.querySelector('[data-inline]');
    if (!form) return;
    const input = form.querySelector('[data-inline-input]');
    const confirm = () => onConfirm(input.value);
    form.querySelector('[data-inline-confirm]').addEventListener('click', confirm);
    form.querySelector('[data-inline-cancel]').addEventListener('click', () => { st.expanded = null; render(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); confirm(); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); st.expanded = null; render(); }
    });
    setTimeout(() => input.focus(), 0);
  }

  function toggleExpanded(kind, id) {
    st.expanded = st.expanded && st.expanded.kind === kind && st.expanded.id === id ? null : { kind, id };
    render();
  }

  // Characters
  function renderCharacters() {
    const list = $('ap-char-list');
    const data = st.data.characters;
    if (!data) return waiting(list);
    if (!data.characters.length) {
      list.innerHTML = '<div class="pp-empty">No characters match.</div>';
      return;
    }
    const retireAllowed = can('retire');
    list.innerHTML = data.characters.map((c) => `
      <div class="ap-item">
        <span class="ap-num">${c.number ? `#${c.number}` : '—'}</span>
        <div class="ap-main">
          <div class="ap-name">${esc(c.name || '(no name)')}</div>
          <div class="ap-sub">Account ${esc(c.accountName ? `${c.accountName} ` : '')}(id ${esc(c.accountId)}) · character ${esc(c.characterId)}</div>
        </div>
        ${c.online ? '<span class="ap-chip online">Online</span>' : ''}
        <span class="ap-chip${c.status === 'retired' ? ' retired' : ''}">${esc(c.status)}</span>
        <div class="ap-actions">
          ${retireAllowed && c.status !== 'retired' ? `<button type="button" class="ap-btn danger" data-retire="${esc(c.characterId)}">Retire</button>` : ''}
        </div>
      </div>
      ${inlineForm('retire', c.characterId, `Reason for retiring ${c.name} (required, shown to the player)`, 'Retire permanently', 'danger')}
    `).join('') + (data.more ? '<div class="pp-empty">Showing the first 100. Narrow the search to see more.</div>' : '');

    for (const btn of list.querySelectorAll('[data-retire]')) {
      btn.addEventListener('click', () => toggleExpanded('retire', Number(btn.dataset.retire)));
    }
    wireInline(list, (reason) => {
      if (!reason.trim()) return showResult(false, 'A reason is required to retire a character.');
      send('admin:characters:retire', {
        characterId: st.expanded.id,
        reason,
        list: { query: $('ap-char-query').value, includeRetired: $('ap-char-retired').checked }
      });
      st.expanded = null;
      render();
    });
  }

  function indexNotice(data) {
    const meta = st.data.meta;
    if (data && data.note) return `<div class="ap-notice">${esc(data.note)}</div>`;
    if (meta && meta.index && meta.index.status === 'building') {
      return '<div class="ap-notice">Reading the game plugins for the first time… search will be ready in a moment.</div>';
    }
    return '';
  }

  function recordRows(results, selected, attr) {
    if (!results.length) return '<div class="pp-empty">Nothing found.</div>';
    return results.map((r) => `
      <div class="ap-item${selected && selected.baseId === r.baseId ? ' selected' : ''}" data-${attr}="${esc(r.baseId)}" style="cursor:pointer">
        <div class="ap-main">
          <div class="ap-name">${esc(r.name)}</div>
          <div class="ap-sub">${esc(r.editorId || '')} · ${esc(r.idHex)}${r.plugin ? ` · ${esc(r.plugin)}` : ''}</div>
        </div>
        <span class="ap-chip">${esc(TYPE_LABELS[r.type] || r.type)}</span>
      </div>`).join('');
  }

  // Items
  function renderItems() {
    const list = $('ap-item-list');
    const bar = $('ap-item-bar');
    const data = st.data.items;
    if (!can('giveItem')) {
      list.innerHTML = '<div class="ap-notice">Your staff role cannot give items (admin or owner only).</div>';
      bar.style.display = 'none';
      return;
    }
    if (!data) { waiting(list); bar.style.display = 'none'; return; }
    list.innerHTML = indexNotice(data) + recordRows(data.results, st.selectedItem, 'item');
    for (const row of list.querySelectorAll('[data-item]')) {
      row.addEventListener('click', () => {
        st.selectedItem = data.results.find((r) => String(r.baseId) === row.dataset.item) || null;
        renderItems();
      });
    }
    bar.style.display = st.selectedItem ? 'flex' : 'none';
    if (st.selectedItem) $('ap-item-selected').textContent = st.selectedItem.name;
  }

  // Creatures
  function renderCreatures() {
    const list = $('ap-creature-list');
    const bar = $('ap-creature-bar');
    const spawnedEl = $('ap-spawned');
    const meta = st.data.meta;
    const data = st.data.creatures;
    if (!can('spawnNpc')) {
      list.innerHTML = '<div class="ap-notice">Your staff role cannot spawn creatures (admin or owner only).</div>';
      bar.style.display = 'none';
      spawnedEl.innerHTML = '';
      return;
    }
    const unavailable = meta && meta.npcSpawn && !meta.npcSpawn.available
      ? `<div class="ap-notice">${esc(meta.npcSpawn.reason)}</div>` : '';
    if (!data) {
      list.innerHTML = `${unavailable}<div class="pp-empty">Waiting for the server…</div>`;
      bar.style.display = 'none';
    }
    else {
      list.innerHTML = unavailable + indexNotice(data) + recordRows(data.results, st.selectedCreature, 'creature');
      for (const row of list.querySelectorAll('[data-creature]')) {
        row.addEventListener('click', () => {
          st.selectedCreature = data.results.find((r) => String(r.baseId) === row.dataset.creature) || null;
          renderCreatures();
        });
      }
      bar.style.display = st.selectedCreature ? 'flex' : 'none';
      if (st.selectedCreature) $('ap-creature-selected').textContent = st.selectedCreature.name;
      $('ap-creature-spawn').disabled = Boolean(meta && meta.npcSpawn && !meta.npcSpawn.available);
    }

    const spawned = st.data.spawned && st.data.spawned.list ? st.data.spawned.list : [];
    spawnedEl.innerHTML = spawned.length ? `
      <div class="pp-h">Spawned from this panel</div>
      ${spawned.map((s) => `
        <div class="ap-item">
          <div class="ap-main">
            <div class="ap-name">${esc(s.name || s.baseIdHex)}</div>
            <div class="ap-sub">${esc(s.formIdHex)} · base ${esc(s.baseIdHex)}</div>
          </div>
          <div class="ap-actions"><button type="button" class="ap-btn danger" data-despawn="${esc(s.formId)}">Remove</button></div>
        </div>`).join('')}` : '';
    for (const btn of spawnedEl.querySelectorAll('[data-despawn]')) {
      btn.addEventListener('click', () => send('admin:creatures:despawn', { formId: Number(btn.dataset.despawn) }));
    }
  }

  // Players
  function renderPlayers() {
    const list = $('ap-player-list');
    const data = st.data.players;
    if (!data) return waiting(list);
    if (!data.players.length) {
      list.innerHTML = '<div class="pp-empty">No one is online.</div>';
      return;
    }
    list.innerHTML = data.players.map((p) => {
      const id = p.number;
      const actions = id ? [
        can('teleport') ? `<button type="button" class="ap-btn" data-act="goto" data-n="${id}">Go to</button>` : '',
        can('teleport') ? `<button type="button" class="ap-btn" data-act="bring" data-n="${id}">Bring here</button>` : '',
        can('setGold') ? `<button type="button" class="ap-btn" data-act="gold" data-n="${id}">Set gold</button>` : '',
        can('kick') ? `<button type="button" class="ap-btn danger" data-act="kick" data-n="${id}">Kick</button>` : ''
      ].join('') : '<span class="ap-sub">No number yet</span>';
      return `
        <div class="ap-item">
          <span class="ap-num">${id ? `#${id}` : '—'}</span>
          <div class="ap-main">
            <div class="ap-name">${esc(p.name)}</div>
            <div class="ap-sub">character ${esc(p.characterId)} · account ${esc(p.accountId)}</div>
          </div>
          ${p.staffRole ? `<span class="ap-chip retired">${esc(p.staffRole)}</span>` : ''}
          <div class="ap-actions">${actions}</div>
        </div>
        ${inlineForm('gold', id, 'New gold amount (whole number)', 'Set gold', 'primary', 'number')}
        ${inlineForm('kick', id, 'Reason (required, shown to the player)', 'Kick', 'danger')}`;
    }).join('');

    for (const btn of list.querySelectorAll('[data-act]')) {
      btn.addEventListener('click', () => {
        const n = Number(btn.dataset.n);
        const act = btn.dataset.act;
        if (act === 'goto') send('admin:players:goto', { number: n });
        else if (act === 'bring') send('admin:players:bring', { number: n });
        else toggleExpanded(act, n);
      });
    }
    wireInline(list, (value) => {
      const { kind, id } = st.expanded;
      if (kind === 'gold') {
        const amount = Number(value);
        if (!Number.isInteger(amount) || amount < 0) return showResult(false, 'Gold must be a whole number, 0 or more.');
        send('admin:players:setgold', { number: id, amount });
      } else if (kind === 'kick') {
        if (!value.trim()) return showResult(false, 'A reason is required to kick.');
        send('admin:players:kick', { number: id, reason: value });
      }
      st.expanded = null;
      render();
    });
  }

  // ── server → page ────────────────────────────────────────────────────────
  window.handleAdminPanelData = function (payload) {
    const msg = typeof normalizePayload === 'function' ? normalizePayload(payload) : payload;
    if (!msg || !msg.channels) return;
    if (msg.sentAt !== undefined && msg.sentAt === st.lastSentAt) return;
    st.lastSentAt = msg.sentAt;
    const ch = msg.channels;

    if (ch.meta && ch.meta.denied) {
      // Not staff: the server already showed "Staff only."; just make sure nothing is open.
      if (st.open) { st.open = false; $('admin-panel').classList.remove('open'); }
      return;
    }
    for (const key of Object.keys(st.data)) {
      if (Object.prototype.hasOwnProperty.call(ch, key)) st.data[key] = ch[key];
    }
    if (ch.meta && ch.meta.openSeq != null && ch.meta.openSeq !== st.lastOpenSeq) {
      st.lastOpenSeq = ch.meta.openSeq;
      if (!st.open) openShell();
    }
    if (ch.result && ch.result.seq !== st.lastResultSeq) {
      const first = st.lastResultSeq === null && !st.open;
      st.lastResultSeq = ch.result.seq;
      if (!first) showResult(ch.result.ok, ch.result.message);
    }
    if (st.open) render();
  };

  window.openAdminPanel = openAdminPanel;
  window.closeAdminPanel = closeAdminPanel;
  window.isAdminPanelOpen = () => st.open;

  // ── wiring (script loaded at the end of <body>) ──────────────────────────
  for (const btn of document.querySelectorAll('#admin-panel .pp-tab')) {
    btn.addEventListener('click', () => switchTab(btn.dataset.adminTab));
  }
  $('ap-close').addEventListener('click', closeAdminPanel);

  $('ap-item-type').innerHTML = ITEM_TYPES.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('');

  $('ap-char-query').addEventListener('input', debounce(searchCharacters, SEARCH_DEBOUNCE_MS));
  $('ap-char-retired').addEventListener('change', searchCharacters);
  $('ap-item-query').addEventListener('input', debounce(searchItems, SEARCH_DEBOUNCE_MS));
  $('ap-item-type').addEventListener('change', searchItems);
  $('ap-creature-query').addEventListener('input', debounce(searchCreatures, SEARCH_DEBOUNCE_MS));
  $('ap-players-refresh').addEventListener('click', () => send('admin:players:refresh'));

  $('ap-item-give').addEventListener('click', () => {
    if (!st.selectedItem) return;
    const count = Number($('ap-item-count').value);
    if (!Number.isInteger(count) || count < 1) return showResult(false, 'Count must be a whole number, 1 or more.');
    const target = $('ap-item-target').value.trim();
    send('admin:items:give', {
      baseId: st.selectedItem.baseId,
      count,
      target: !target || /^(me|self)$/i.test(target) ? 'self' : target
    });
  });

  $('ap-creature-spawn').addEventListener('click', () => {
    if (st.selectedCreature) send('admin:creatures:spawn', { baseId: st.selectedCreature.baseId });
  });

  window.addEventListener('keydown', (event) => {
    if (!st.open || event.defaultPrevented) return;
    const t = event.target;
    const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
    if (event.key === 'Escape') { closeAdminPanel(); return; }
    if (typing) return;
    // With the page focused the game ignores keys, so the bound key closes from here.
    const binds = typeof window.getKeybinds === 'function' ? window.getKeybinds() : null;
    const code = binds && binds['admin.open'] !== undefined ? binds['admin.open'] : DEFAULT_KEY;
    if (window.OathboundKeybinds && code !== null && window.OathboundKeybinds.scanCodeFromDomCode(event.code) === code) {
      event.preventDefault();
      closeAdminPanel();
    }
  });

  const hint = $('ap-foot-hint');
  document.addEventListener('oathbound:keybinds', (e) => {
    const code = e.detail ? e.detail['admin.open'] : DEFAULT_KEY;
    if (hint && window.OathboundKeybinds) {
      hint.textContent = code !== null && code !== undefined ? `${window.OathboundKeybinds.keyLabel(code)} or Esc to close · every action is logged` : 'Esc to close · every action is logged';
    }
  });
})();
