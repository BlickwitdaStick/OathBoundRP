/**
 * holdstone-panel.js
 *
 * Menu opened at a holdstone (`gamemode/holdstone-service.js`). Every stone
 * belongs to an organization (a hold, town, faction, thanedom or council).
 * Shows it, your rank, the rank ladder, members, parcels, and every
 * organization you are tied to. Buttons go back
 * through the SAME pipeline as the interaction menu (`interaction:execute`)
 * and are re-checked by the server; this file decides nothing.
 *
 * Server → CEF: `holdstone:open` / `holdstone:update` via `browserModal`.
 * `sendUiEvent` and `normalizePayload` are globals from index.html, which
 * loads before this file.
 */

(function () {
  'use strict';

  const state = { open: false, targetId: null, data: null };

  function $(id) {
    return document.getElementById(id);
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function execute(action, data) {
    if (!state.targetId) return;
    sendUiEvent('interaction:execute', {
      action,
      targetType: 'object',
      targetId: state.targetId,
      data: data || {}
    });
  }

  /** Carved crest rune per kind of stone. */
  const KIND_RUNES = { hold: 'ᛟ', thanedom: 'ᚦ', town: 'ᚺ', faction: 'ᛉ', council: 'ᛞ' };

  /** The rank ladder, highest first; the viewer's own rank is marked. */
  function renderRanks(ranks, yourRank) {
    const root = $('hs-ranks');
    root.innerHTML = '';
    if (!ranks || ranks.length === 0) {
      root.appendChild(el('div', 'hs-empty', 'No ranks are carved here yet.'));
      return;
    }
    const ladder = ranks.slice().sort((a, b) => (b.position || 0) - (a.position || 0));
    for (const rank of ladder) {
      const mine = yourRank && rank.name === yourRank;
      const step = el('div', 'hs-step' + (rank.isLeader ? ' leader' : '') + (mine ? ' mine' : ''));
      step.appendChild(el('span', 'hs-step-mark', rank.isLeader ? 'ᛝ' : '◆'));
      step.appendChild(el('span', 'hs-step-name', rank.name));
      if (mine) step.appendChild(el('span', 'hs-step-you', 'you'));
      else if (rank.isLeader) step.appendChild(el('span', 'hs-step-tag', 'leads'));
      step.title = 'Key: ' + rank.key;
      root.appendChild(step);
    }
  }

  function renderMembers(members) {
    const root = $('hs-members');
    root.innerHTML = '';
    if (!members || members.length === 0) {
      root.appendChild(el('div', 'hs-empty', 'No one has sworn to this stone yet.'));
      return;
    }
    for (const member of members) {
      const row = el('div', 'hs-row hs-member');
      row.appendChild(el('span', 'hs-row-name', member.name));
      row.appendChild(el('span', 'hs-badge', member.rank));
      root.appendChild(row);
    }
  }

  function renderParcels(data) {
    const root = $('hs-parcels');
    root.innerHTML = '';
    const parcels = data.parcels || [];
    if (parcels.length === 0) {
      root.appendChild(el('div', 'hs-empty', 'No land is parcelled here.'));
      return;
    }
    for (const parcel of parcels) {
      const row = el('div', 'hs-row hs-parcel');
      const info = el('div', 'hs-row-info');
      info.appendChild(el('span', 'hs-row-name', '#' + parcel.id + ' ' + parcel.name));
      const access = parcel.minRank ? parcel.minRank + ' and above' : 'owner only';
      info.appendChild(el('span', 'hs-row-meta',
        (parcel.owner ? 'Owner: ' + parcel.owner : 'No owner') + ' · ' + access + ' · ' +
        parcel.doors + ' doors, ' + parcel.containers + ' containers'));
      row.appendChild(info);

      const status = el('span', 'hs-lock ' + (parcel.locked ? 'locked' : 'open'), parcel.locked ? 'Locked' : 'Open');
      row.appendChild(status);

      if (data.canManage || parcel.mine) {
        const toggle = el('button', 'hs-btn', parcel.locked ? 'Unlock' : 'Lock');
        toggle.type = 'button';
        toggle.onclick = () => execute('holdstone.lock_parcel', { parcelId: parcel.id, locked: !parcel.locked });
        row.appendChild(toggle);
      }
      if (data.canManage) {
        const tool = el('button', 'hs-btn', 'Parcel tool');
        tool.type = 'button';
        tool.title = 'Then press E on doors and containers to add or remove them.';
        tool.onclick = () => execute('holdstone.parcel_tool', { parcelId: parcel.id });
        row.appendChild(tool);
      }
      root.appendChild(row);
    }
  }

  function renderAllegiances(list) {
    const root = $('hs-allegiances');
    if (!root) return;
    root.innerHTML = '';
    if (!list || list.length === 0) {
      root.appendChild(el('div', 'hs-empty', 'You are tied to no stone yet.'));
      return;
    }
    for (const a of list) {
      const chip = el('span', 'hs-chip');
      chip.appendChild(el('span', 'hs-chip-org', a.name));
      chip.appendChild(el('span', 'hs-chip-rank', a.rank));
      chip.title = a.kind;
      root.appendChild(chip);
    }
  }

  function render(data) {
    state.data = data;
    if (data.targetId != null) state.targetId = data.targetId;
    const kind = String(data.kind || 'Holdstone');
    $('hs-eyebrow').textContent = kind + (data.seat && data.seat !== data.orgName ? ' of ' + data.seat : '');
    $('hs-hold-name').textContent = data.orgName || data.orgId || '—';
    const rune = $('hs-crest-rune');
    if (rune) rune.textContent = KIND_RUNES[kind.toLowerCase()] || 'ᛟ';
    const lineage = [];
    if (Array.isArray(data.answersTo) && data.answersTo.length) lineage.push('Answers to ' + data.answersTo[0]);
    if (Array.isArray(data.vassals) && data.vassals.length) lineage.push('Holds sway over ' + data.vassals.join(', '));
    const lineageEl = $('hs-lineage');
    if (lineageEl) lineageEl.textContent = lineage.join(' · ');
    $('hs-your-rank').textContent = data.yourRank
      ? 'You stand as ' + data.yourRank
      : (data.isStaff ? 'You walk here as staff' : 'You are not sworn to this stone');
    const titles = $('hs-titles');
    if (titles) {
      titles.innerHTML = '';
      for (const t of (Array.isArray(data.titles) ? data.titles : [])) titles.appendChild(el('span', 'hs-title-chip', t));
    }
    renderAllegiances(data.allegiances);
    renderRanks(data.ranks, data.yourRank);
    renderMembers(data.members);
    renderParcels(data);

    const manage = $('hs-manage');
    manage.classList.toggle('visible', Boolean(data.canManage));
  }

  function submitRank(event) {
    event.preventDefault();
    const player = parseInt($('hs-rank-player').value, 10);
    const rank = $('hs-rank-key').value.trim();
    if (!player || !rank) return;
    execute('holdstone.set_rank', { player, rank });
  }

  function submitParcel(event) {
    event.preventDefault();
    const name = $('hs-parcel-name').value.trim();
    const minRank = $('hs-parcel-rank').value.trim() || 'none';
    if (!name) return;
    execute('holdstone.create_parcel', { name, minRank });
    $('hs-parcel-name').value = '';
  }

  function open(data) {
    render(normalizePayload(data));
    state.open = true;
    $('holdstone-panel').classList.add('open');
    $('holdstone-panel').setAttribute('aria-hidden', 'false');
  }

  function update(data) {
    if (!state.open) return;
    render(normalizePayload(data));
  }

  function close() {
    state.open = false;
    $('holdstone-panel').classList.remove('open');
    $('holdstone-panel').setAttribute('aria-hidden', 'true');
    sendUiEvent('holdstone:close', {});
  }

  function isOpen() {
    return state.open;
  }

  document.addEventListener('DOMContentLoaded', () => {
    const closeBtn = $('hs-close');
    if (closeBtn) closeBtn.onclick = close;
    const rankForm = $('hs-rank-form');
    if (rankForm) rankForm.addEventListener('submit', submitRank);
    const parcelForm = $('hs-parcel-form');
    if (parcelForm) parcelForm.addEventListener('submit', submitParcel);
  });

  window.HoldstonePanel = { open, update, close, isOpen };
})();
