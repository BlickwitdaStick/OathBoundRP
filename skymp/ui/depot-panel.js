/**
 * depot-panel.js
 *
 * Task 10 (UI-Depot-Bridge): renders the Regional Depot panel and sends
 * deposits/withdrawals back to the server through the SAME pipeline already
 * used by the interaction menu (`interaction:execute`, `core/interaction-service.js`).
 * This file does not communicate with the database or make any decisions —
 * it only displays what the server sends through `depot:open`/`depot:update`
 * (`core/depot-service.js`, `sendModal`) and translates button clicks into
 * `sendUiEvent` calls.
 *
 * `sendUiEvent` and `normalizePayload` are globals defined in the main
 * `index.html` <script> (`function`, not `const`, so they become properties
 * of `window`) — this file loads AFTER it.
 */

(function () {
  'use strict';

  const state = {
    open: false,
    holdId: null,
    targetId: null,
    capacity: 0
  };

  function $(id) {
    return document.getElementById(id);
  }

  /**
   * There is no precedent for native sound in the project yet (no other CEF
   * file calls this) — guarded in the same way that `sendUiEvent` guards
   * `window.skyrimPlatform`, so it won't break if the audio framework does
   * not expose this method.
   */
  function playInventorySound() {
    try {
      if (window.skyrimPlatform && typeof window.skyrimPlatform.playSound === 'function') {
        window.skyrimPlatform.playSound('ITMPotionUp');
      }
    } catch (err) {
      // Intentionally silent: sound is decorative and must never block the UI.
    }
  }

  function formId(id) {
    return '0x' + Number(id).toString(16);
  }

  function buildRow(item, actionLabel, onAction) {
    const row = document.createElement('div');
    row.className = 'dp-row';

    const info = document.createElement('div');
    info.className = 'dp-row-info';
    const name = document.createElement('span');
    name.className = 'dp-row-name';
    name.textContent = formId(item.baseId);
    const count = document.createElement('span');
    count.className = 'dp-row-count';
    count.textContent = 'x' + item.count;
    info.appendChild(name);
    info.appendChild(count);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'dp-row-btn';
    btn.textContent = actionLabel;
    btn.onclick = () => onAction(item);

    row.appendChild(info);
    row.appendChild(btn);
    return row;
  }

  function renderList(containerId, items, actionLabel, onAction) {
    const container = $(containerId);
    container.innerHTML = '';
    if (!items || items.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'dp-empty';
      empty.textContent = 'Empty.';
      container.appendChild(empty);
      return;
    }
    for (const item of items) {
      container.appendChild(buildRow(item, actionLabel, onAction));
    }
  }

  function requestMove(action, baseId, count) {
    if (!state.targetId) return;
    playInventorySound();
    // `requestId` is not used here: `depot.deposit`/`depot.withdraw` are not
    // marked as `idempotent` in the registry (`core/depot-service.js`), so
    // `interaction-service.js` does not require one. Double-clicks on a slow
    // network are an accepted risk — the same as with any other non-idempotent
    // action in the menu.
    sendUiEvent('interaction:execute', {
      action,
      targetId: state.targetId,
      data: { baseId, count }
    });
  }

  function render(data) {
    state.holdId = data.holdId != null ? data.holdId : state.holdId;
    if (data.targetId != null) state.targetId = data.targetId;
    state.capacity = data.capacity != null ? data.capacity : state.capacity;

    $('dp-hold-name').textContent = state.holdId ? String(state.holdId) : '—';
    $('dp-gold').textContent = (data.gold != null ? data.gold : 0) + ' gold';

    const depotTotal = (data.contents || []).reduce((sum, it) => sum + it.count, 0);
    $('dp-capacity-value').textContent = depotTotal + ' / ' + state.capacity;
    const pct = state.capacity > 0 ? Math.min(100, (depotTotal / state.capacity) * 100) : 0;
    const fill = $('dp-capacity-fill');
    fill.style.width = pct + '%';
    fill.classList.toggle('full', pct >= 100);
    fill.classList.toggle('warn', pct >= 85 && pct < 100);

    renderList('dp-carried-list', data.carried, 'Deposit', (item) => {
      requestMove('depot.deposit', item.baseId, 1);
    });
    renderList('dp-depot-list', data.contents, 'Withdraw', (item) => {
      requestMove('depot.withdraw', item.baseId, 1);
    });
  }

  function open(data) {
    render(normalizePayload(data));
    state.open = true;
    const el = $('depot-panel');
    el.classList.add('open');
    el.setAttribute('aria-hidden', 'false');
  }

  function update(data) {
    // Only redraw if the panel is already open — a `depot:update` arriving
    // after the player has closed it (due to a slow deposit/withdrawal) must
    // not reopen the screen in front of them.
    if (!state.open) return;
    render(normalizePayload(data));
  }

  function close() {
    state.open = false;
    const el = $('depot-panel');
    el.classList.remove('open');
    el.setAttribute('aria-hidden', 'true');
    // Gives the mouse back to the game (core/depot-service.js handleUiEvent).
    if (typeof sendUiEvent === 'function') sendUiEvent('depot:close', {});
  }

  function isOpen() {
    return state.open;
  }

  document.addEventListener('DOMContentLoaded', () => {
    const closeBtn = $('dp-close');
    if (closeBtn) closeBtn.onclick = close;
  });

  window.DepotPanel = { open, update, close, isOpen };
})();