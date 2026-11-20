/**
 * player-panel.js
 *
 * Player panel (Status | Governance | Economy | Social).
 * Visual identity borrowed from Prisma UI itself (prismaui.dev): dark glass
 * card, "live" status chip, pills, clean list-based data display.
 *
 * Depends on globals already defined in index.html: `mp`, `sendUiEvent`,
 * `normalizePayload`. Must be included AFTER the inline script in index.html.
 *
 * Flow:
 *   - Server calls openPanel() (via /painel) → sets browserVisible/Focused
 *     and sends a snapshot of each section through the `panelData` property.
 *   - `window.handlePanelData({channel, data})` is called by the SkyMP client
 *     (see phase0-basic.js, property 'panelData') and updates the corresponding tab.
 *   - The name and status chip in the header (channel 'status') remain visible
 *     on every tab — they identify the panel and do not belong exclusively
 *     to the Status tab.
 *   - Switching tabs requests an on-demand refresh through `panel:refresh:<section>`.
 */

(function () {
  const ppState = {
    open: false,
    activeTab: 'status',
    data: { status: null, governance: null, economy: null, social: null, professions: null, soul: null },
    // Controls tab. `saved` = what the server last confirmed (per account);
    // `draft` = the player's unsaved edits; `capturing` = action waiting for
    // a key press.
    keybinds: { saved: null, draft: null, capturing: null, message: '' },
    // Set when the panel asked the server for data and nothing came back in
    // SERVER_TIMEOUT_MS: the panel then says so instead of waiting forever.
    serverSilent: false,
    waitTimer: null
  };

  const SERVER_TIMEOUT_MS = 6000;

  const KB = window.OathboundKeybinds;

  const PROFESSION_STATUS_LABELS = { active: 'Active', suspended: 'Suspended', revoked: 'Revoked' };

  const STATE_LABELS = {
    NORMAL: 'In order', BUSY: 'Busy', DOWNED: 'Downed', DEAD: 'Dead',
    RESTRAINED: 'Restrained', IMPRISONED: 'Imprisoned', IN_TRADE: 'Trading',
    IN_CRAFT: 'Crafting', IN_DIALOG: 'In a hearing'
  };
  const BAD_STATES = new Set(['RESTRAINED', 'IMPRISONED', 'DOWNED', 'DEAD']);
  const KNOWN_SOURCE_LABELS = { introduced: 'introduced', alias: 'nickname', staff: 'staff', disguise: 'disguise' };

  function $(id) {
    return document.getElementById(id);
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function gold(value) {
    return `${Number(value || 0).toLocaleString('en-US')} gold`;
  }

  /**
   * Clean data row: label on the left, value on the right, hairline underneath.
   * `value` is escaped by default — pass plain text, never prebuilt HTML.
   * Only use `opts.rawValueHtml: true` if `value` is HTML reliably generated
   * by this file (e.g. markup from another helper), never text from the server
   * unless it has first been passed through escapeHtml.
   */
  function row(label, value, opts = {}) {
    const valueClass = opts.valueClass ? ` ${opts.valueClass}` : '';
    const sub = opts.sub ? `<span class="sub">${escapeHtml(opts.sub)}</span>` : '';
    const safeValue = opts.rawValueHtml ? value : escapeHtml(value);
    return `
      <div class="pp-row">
        <span class="label">${escapeHtml(label)}${sub}</span>
        <span class="value${valueClass}">${safeValue}</span>
      </div>
    `;
  }

  function openPlayerPanelShell() {
    ppState.open = true;
    $('player-panel').classList.add('open');
  }

  function closePlayerPanel() {
    ppState.open = false;
    $('player-panel').classList.remove('open');
    sendUiEvent('panel:close', {});
  }

  function switchTab(tab) {
    ppState.activeTab = tab;
    for (const btn of document.querySelectorAll('#player-panel .pp-tab')) {
      btn.classList.toggle('active', btn.dataset.tab === tab);
    }
    for (const section of document.querySelectorAll('#player-panel .pp-section')) {
      section.classList.toggle('active', section.id === `pp-section-${tab}`);
    }
    if (tab === 'controls') {
      // Not a panel-service section: bindings come from the keybinds module.
      sendUiEvent('keybinds:get', {});
    } else {
      sendUiEvent(`panel:refresh:${tab}`, {});
    }
    renderTab(tab);
  }

  function renderTab(tab) {
    const data = ppState.data[tab];
    if (tab === 'status') renderStatus(data);
    else if (tab === 'governance') renderGovernance(data);
    else if (tab === 'economy') renderEconomy(data);
    else if (tab === 'social') renderSocial(data);
    else if (tab === 'professions') renderProfessions(data);
    else if (tab === 'soul') renderSoul(data);
    else if (tab === 'controls') renderControls();
  }

  // ── Controls tab (rebindable keys) ────────────────────────────────────────
  function renderControls() {
    const body = $('pp-section-controls');
    if (!body) return;
    const kb = ppState.keybinds;
    if (!KB) {
      body.innerHTML = '<div class="pp-empty">Keybinds are unavailable (keybinds.js not loaded).</div>';
      return;
    }
    if (!kb.draft) {
      body.innerHTML = '<div class="pp-empty">Waiting for the server…</div>';
      return;
    }

    const dirty = !KB.sameBindings(kb.draft, kb.saved);
    const rows = KB.ACTIONS.map((action) => {
      const capturing = kb.capturing === action.id;
      const code = kb.draft[action.id];
      const keyText = capturing ? 'Press a key… (Esc to cancel)' : KB.keyLabel(code);
      return `
        <div class="pp-row pp-keybind${capturing ? ' capturing' : ''}">
          <span class="label">${escapeHtml(action.label)}<span class="sub">${escapeHtml(action.hint)}</span></span>
          <span class="value pp-keybind-controls">
            <button type="button" class="pp-keycap" data-kb-change="${escapeHtml(action.id)}">${escapeHtml(keyText)}</button>
            ${code !== null && !capturing ? `<button type="button" class="pp-kb-clear" data-kb-clear="${escapeHtml(action.id)}" title="Unbind">×</button>` : ''}
          </span>
        </div>
      `;
    }).join('');

    body.innerHTML = `
      <div class="pp-h">Keybinds</div>
      ${rows}
      ${kb.message ? `<div class="pp-empty pp-kb-message">${escapeHtml(kb.message)}</div>` : ''}
      <div class="pp-kb-actions">
        <button type="button" class="pp-kb-btn primary" data-kb-save ${dirty ? '' : 'disabled'}>Save</button>
        <button type="button" class="pp-kb-btn" data-kb-revert ${dirty ? '' : 'disabled'}>Undo changes</button>
        <button type="button" class="pp-kb-btn" data-kb-reset>Reset to defaults</button>
      </div>
      <div class="pp-empty">Saved to your account. Keys are ignored while you type in chat.</div>
    `;

    for (const btn of body.querySelectorAll('[data-kb-change]')) {
      btn.addEventListener('click', () => {
        kb.capturing = kb.capturing === btn.dataset.kbChange ? null : btn.dataset.kbChange;
        kb.message = '';
        renderControls();
      });
    }
    for (const btn of body.querySelectorAll('[data-kb-clear]')) {
      btn.addEventListener('click', () => {
        kb.draft = Object.assign({}, kb.draft, { [btn.dataset.kbClear]: null });
        kb.message = '';
        renderControls();
      });
    }
    const save = body.querySelector('[data-kb-save]');
    if (save) save.addEventListener('click', () => {
      kb.capturing = null;
      kb.message = 'Saving…';
      sendUiEvent('keybinds:set', { bindings: kb.draft });
      renderControls();
    });
    const revert = body.querySelector('[data-kb-revert]');
    if (revert) revert.addEventListener('click', () => {
      kb.capturing = null;
      kb.draft = Object.assign({}, kb.saved);
      kb.message = '';
      renderControls();
    });
    const reset = body.querySelector('[data-kb-reset]');
    if (reset) reset.addEventListener('click', () => {
      kb.capturing = null;
      kb.message = 'Resetting…';
      sendUiEvent('keybinds:reset', {});
      renderControls();
    });
  }

  /**
   * While an action is waiting for a key, swallow the next key press (capture
   * phase, so Escape does not also close the panel) and assign it.
   * @returns {boolean} true if the event was consumed
   */
  function handleCaptureKey(event) {
    const kb = ppState.keybinds;
    if (!kb.capturing || !KB) return false;
    // stopImmediatePropagation, not stopPropagation: every keydown handler in
    // this UI (panel, interaction menu, depot) listens on `window` itself, and
    // stopPropagation does not stop other listeners on the same target — Esc
    // used to cancel the rebind AND close the panel.
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.code === 'Escape') {
      kb.capturing = null;
      kb.message = '';
      renderControls();
      return true;
    }
    const code = KB.scanCodeFromDomCode(event.code);
    if (code === null) {
      kb.message = `That key can't be bound (${event.code || event.key}).`;
      renderControls();
      return true;
    }
    const result = KB.assignKey(kb.draft, kb.capturing, code);
    kb.draft = result.draft;
    kb.message = result.movedFrom
      ? `${KB.keyLabel(code)} was used by "${KB.labelOf(result.movedFrom)}", which is now unbound.`
      : '';
    kb.capturing = null;
    renderControls();
    return true;
  }

  /** Name and status chip in the header — always visible, regardless of which tab is open. */
  function updateHeader(data) {
    $('pp-char-name').textContent = data ? data.name : '—';
    const chip = $('pp-status-chip');
    const isBad = data && BAD_STATES.has(data.state);
    chip.classList.toggle('warn', Boolean(isBad));
    $('pp-status-text').textContent = data ? (STATE_LABELS[data.state] || data.state) : 'In order';
  }

  function gaugeRow(label, value, cls) {
    const raw = Number(value) || 0;
    const v = Math.max(0, Math.min(100, raw));
    return `
      <div class="pp-gauge">
        <div class="pp-gauge-label"><span>${label}</span><span class="value">${Math.round(raw)}</span></div>
        <div class="pp-gauge-track"><div class="pp-gauge-fill ${cls}" style="width:${v}%"></div></div>
      </div>
    `;
  }

  function renderStatus(data) {
    const body = $('pp-section-status');
    if (!data) {
      body.innerHTML = ppState.serverSilent
        ? '<div class="pp-empty pp-error">The server did not send your character data. Try again in a moment; if it keeps happening, the server console shows <code>[player-panel]</code> lines explaining why.</div>'
        : '<div class="pp-empty">Waiting for the server…</div>';
      return;
    }

    const v = data.vitals || { health: 0, magicka: 0, stamina: 0 };

    body.innerHTML = `
      <div class="pp-h">Vitality</div>
      ${gaugeRow('Health', v.health, 'health')}
      ${gaugeRow('Magicka', v.magicka, 'magicka')}
      ${gaugeRow('Stamina', v.stamina, 'stamina')}

      <div class="pp-h">Summary</div>
      ${row('Gold', gold(data.gold), { valueClass: 'accent' })}
      ${row('Condition', STATE_LABELS[data.state] || data.state, { valueClass: BAD_STATES.has(data.state) ? 'warn' : '' })}
    `;
  }

  function renderGovernance(data) {
    const body = $('pp-section-governance');
    if (!data) {
      body.innerHTML = '<div class="pp-empty">No records of positions, warrants, or fines.</div>';
      return;
    }

    const memberships = (data.memberships || [])
      .map(m => row(m.label || m.role, m.onDuty ? 'On duty' : 'Off duty', { sub: ` · ${m.scopeType}:${m.scopeId}` }))
      .join('');

    const warrant = data.activeWarrant
      ? row('Active warrant', data.activeWarrant.severity, { valueClass: 'warn', sub: data.activeWarrant.reason ? ` · ${data.activeWarrant.reason}` : '' })
      : '';

    const fines = (data.recentFines || [])
      .map(f => row('Fine', gold(f.amount), { sub: f.reason ? ` · ${f.reason}` : '' }))
      .join('');

    const items = memberships + warrant + fines;
    body.innerHTML = `
      <div class="pp-h">Position &amp; Justice</div>
      ${items || '<div class="pp-empty">You have no positions, warrants, or fines on record.</div>'}
      <div class="pp-hint">Guard actions are still handled through the interaction menu (right-click another player).</div>
    `;
  }

  function renderEconomy(data) {
    const body = $('pp-section-economy');
    if (!data) {
      body.innerHTML = '<div class="pp-empty">No economic data available yet.</div>';
      return;
    }

    const stalls = (data.stalls || [])
      .map(s => row(s.name, `${s.items} items`, { sub: ` · ${s.status}` }))
      .join('') || '<div class="pp-empty">No stalls are registered in your name.</div>';

    body.innerHTML = `
      <div class="pp-h">Treasury</div>
      ${row('Gold', gold(data.gold), { valueClass: 'accent' })}
      ${row('Local tax', `${Math.round((data.localTaxRate || 0) * 100)}%`)}

      <div class="pp-h">Registered Stalls</div>
      ${stalls}
      <div class="pp-hint">Use the interaction menu at a stall to buy, sell, or manage items.</div>
    `;
  }

  /** Social row: same layout as `row()`, but with a nickname button + inline form. */
  function socialRow(person) {
    const sourceLabel = KNOWN_SOURCE_LABELS[person.source] || person.source || '';
    return `
      <div class="pp-row social" data-character-id="${escapeHtml(person.characterId)}">
        <span class="label">${escapeHtml(person.name)}</span>
        <span class="value">
          ${escapeHtml(sourceLabel)}
          <button type="button" class="pp-rename-btn" data-rename-toggle>Nickname</button>
        </span>
        <form class="pp-rename-form" data-rename-form>
          <input type="text" class="pp-rename-input" data-rename-input placeholder="How do you recognize this person?" maxlength="64" />
          <button type="submit" class="pp-rename-save">Save</button>
        </form>
      </div>
    `;
  }

  function renderSocial(data) {
    const body = $('pp-section-social');
    if (!data) {
      body.innerHTML = '<div class="pp-empty">No known contacts yet.</div>';
      return;
    }

    const known = (data.knownPeople || []).map(socialRow).join('')
      || '<div class="pp-empty">You do not know anyone yet.</div>';

    body.innerHTML = `
      <div class="pp-h">Known Faces</div>
      ${known}
      <div class="pp-hint">${escapeHtml(data.hint || '')}</div>
    `;

    bindSocialRenameHandlers(body);
  }

  function renderProfessions(data) {
    const body = $('pp-section-professions');
    if (!data) {
      body.innerHTML = '<div class="pp-empty">No profession data available yet.</div>';
      return;
    }

    const linhas = (data.professions || [])
      .map(p => row(p.label, `rank ${p.rank}`, {
        sub: ` · ${PROFESSION_STATUS_LABELS[p.status] || p.status} · xp ${p.xp}`,
        valueClass: p.status === 'suspended' ? 'warn' : ''
      }))
      .join('') || '<div class="pp-empty">You do not have any professions.</div>';

    body.innerHTML = `
      <div class="pp-h">Professions</div>
      ${linhas}
    `;
  }

  /**
   * Soul: phrases only, never numbers — the same rule already followed by
   * `soul-service.buildPanelPayload` (see `/alma`). Signs and marks arrive
   * ready-made from the server; this file does not decide the text, it only
   * displays it.
   */
  function renderSoul(data) {
    const body = $('pp-section-soul');
    if (!data) {
      body.innerHTML = '<div class="pp-empty">No soul data available yet.</div>';
      return;
    }

    const sinais = (data.sinais || []).map(s => `<div class="pp-empty">${escapeHtml(s)}</div>`).join('');
    const marcas = (data.marcas || []).map(m => `<div class="pp-empty">${escapeHtml(m.texto)}</div>`).join('');
    const caminhos = (data.caminhos || [])
      .map(c => row(c.arvore, c.no))
      .join('');

    const nada = !sinais && !marcas && !caminhos;

    body.innerHTML = nada
      ? '<div class="pp-empty">There is nothing you know about yourself yet.</div>'
      : `
        <div class="pp-h">Signs</div>
        ${sinais || '<div class="pp-empty">No signs have been revealed.</div>'}
        <div class="pp-h">Marks</div>
        ${marcas || '<div class="pp-empty">No marks.</div>'}
        ${caminhos ? `<div class="pp-h">Path</div>${caminhos}` : ''}
      `;
  }

  /** Click/submit delegation for the newly created "Nickname" buttons inserted via innerHTML. */
  function bindSocialRenameHandlers(body) {
    for (const toggleBtn of body.querySelectorAll('[data-rename-toggle]')) {
      toggleBtn.addEventListener('click', () => {
        const rowEl = toggleBtn.closest('.pp-row.social');
        const form = rowEl.querySelector('[data-rename-form]');
        const input = rowEl.querySelector('[data-rename-input]');
        form.classList.toggle('open');
        if (form.classList.contains('open')) input.focus();
      });
    }

    for (const form of body.querySelectorAll('[data-rename-form]')) {
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        const rowEl = form.closest('.pp-row.social');
        const input = form.querySelector('[data-rename-input]');
        const alias = input.value.trim();
        const targetCharacterId = Number(rowEl.dataset.characterId);
        if (!alias || !targetCharacterId) return;

        sendUiEvent('panel:social:rename', { targetCharacterId, alias });
        form.classList.remove('open');
        input.value = '';
      });
    }
  }

  // ── API exposed to the rest of the UI / server ────────────────────────────
  window.openPlayerPanel = function () {
    openPlayerPanelShell();
    sendUiEvent('panel:open', {});
    ppState.serverSilent = false;
    clearTimeout(ppState.waitTimer);
    ppState.waitTimer = setTimeout(() => {
      if (ppState.data.status) return;
      ppState.serverSilent = true;
      // Controls still works: fall back to the default keys if the server's copy never came.
      const kb = ppState.keybinds;
      if (!kb.draft && KB) {
        kb.draft = Object.assign({}, KB.DEFAULT_BINDINGS);
        kb.message = 'Could not load your saved keybinds from the server; showing the defaults.';
      }
      renderTab(ppState.activeTab);
    }, SERVER_TIMEOUT_MS);
    renderTab(ppState.activeTab);
  };

  window.togglePlayerPanel = function () {
    if (ppState.open) {
      closePlayerPanel();
    } else {
      window.openPlayerPanel();
    }
  };

  /**
   * Server → panel. Current format: `{ channels: { status, governance, ... }, sentAt }`
   * (every section the server has sent, see player-panel-service.sendPanelData).
   * The old one-section `{ channel, data }` form is still accepted.
   * A repeated `sentAt` is ignored so a re-delivered value can never reopen a
   * panel the player just closed.
   */
  window.handlePanelData = function (payload) {
    const msg = normalizePayload(payload);
    if (!msg) return;
    if (msg.sentAt !== undefined && msg.sentAt === ppState.lastSentAt) return;
    ppState.lastSentAt = msg.sentAt;

    const channels = msg.channels && typeof msg.channels === 'object'
      ? msg.channels
      : (msg.channel ? { [msg.channel]: msg.data } : null);
    if (!channels) return;
    ppState.serverSilent = false;
    clearTimeout(ppState.waitTimer);

    for (const [channel, data] of Object.entries(channels)) ppState.data[channel] = data;
    if (channels.status) updateHeader(channels.status);
    if (!ppState.open) openPlayerPanelShell();
    if (Object.hasOwn(channels, ppState.activeTab)) renderTab(ppState.activeTab);
  };

  // ── Initialization (script loaded at the end of <body>, DOM already ready) ─
  for (const btn of document.querySelectorAll('#player-panel .pp-tab')) {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  }
  const closeBtn = $('pp-close');
  if (closeBtn) closeBtn.addEventListener('click', closePlayerPanel);
  updateHeader(null);
  updateFootHint();
  renderTab('status');

  /**
   * Server → UI: the account's current bindings (sent by the keybind client
   * snippet whenever they change). Keeps unsaved edits unless the server
   * confirmed something new (save/reset), and tells the rest of the UI
   * (voice push-to-talk) through the `oathbound:keybinds` DOM event.
   */
  window.handleKeybindsUpdate = function (bindings) {
    const msg = normalizePayload(bindings);
    if (!msg || typeof msg !== 'object') return;
    const kb = ppState.keybinds;
    const hadUnsavedEdits = kb.draft && kb.saved && !KB.sameBindings(kb.draft, kb.saved);
    const savedChanged = !kb.saved || !KB.sameBindings(kb.saved, msg);
    kb.saved = Object.assign({}, msg);
    if (!kb.draft || !hadUnsavedEdits || savedChanged) kb.draft = Object.assign({}, msg);
    if (kb.message === 'Saving…' || kb.message === 'Resetting…') kb.message = savedChanged ? 'Saved.' : '';
    if (kb.message.startsWith('Could not load')) kb.message = '';
    if (ppState.activeTab === 'controls') renderControls();
    updateFootHint();
    document.dispatchEvent(new CustomEvent('oathbound:keybinds', { detail: Object.assign({}, msg) }));
  };

  function updateFootHint() {
    const hint = $('pp-foot-hint');
    if (!hint) return;
    const saved = ppState.keybinds.saved;
    const code = saved ? saved['panel.open'] : 60;
    hint.textContent = KB && code !== null && code !== undefined
      ? `${KB.keyLabel(code)} or Esc to close`
      : 'Esc to close';
  }

  window.getKeybinds = function () {
    return ppState.keybinds.saved ? Object.assign({}, ppState.keybinds.saved) : null;
  };

  // Capture phase: a pending rebind must see the key before anything else.
  window.addEventListener('keydown', (event) => {
    handleCaptureKey(event);
  }, true);

  window.addEventListener('keydown', (event) => {
    if (event.defaultPrevented) return;
    // Typing (chat box, nickname field) never toggles the panel.
    const t = event.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (event.key === 'Escape' && ppState.open) closePlayerPanel();
    // While the panel has focus the game ignores keys, so the bound
    // "open panel" key also closes it from here.
    const saved = ppState.keybinds.saved;
    const panelCode = saved ? saved['panel.open'] : 60;
    if (KB && panelCode !== null && KB.scanCodeFromDomCode(event.code) === panelCode) {
      window.togglePlayerPanel();
    }
  });
})();