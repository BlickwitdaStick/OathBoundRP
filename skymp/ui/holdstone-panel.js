/**
 * holdstone-panel.js
 *
 * Hold menu opened at a holdstone (`gamemode/holdstone-service.js`). Shows the
 * hold, your rank, the rank ladder, members and parcels. Buttons go back
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

  function renderRanks(ranks) {
    const root = $('hs-ranks');
    root.innerHTML = '';
    if (!ranks || ranks.length === 0) {
      root.appendChild(el('div', 'hs-empty', 'No ranks set up for this hold.'));
      return;
    }
    for (const rank of ranks) {
      const chip = el('span', 'hs-rank' + (rank.isLeader ? ' leader' : ''), rank.name);
      chip.title = 'Key: ' + rank.key + (rank.isLeader ? ' (leader)' : '');
      root.appendChild(chip);
    }
  }

  function renderMembers(members) {
    const root = $('hs-members');
    root.innerHTML = '';
    if (!members || members.length === 0) {
      root.appendChild(el('div', 'hs-empty', 'No members yet.'));
      return;
    }
    for (const member of members) {
      const row = el('div', 'hs-row');
      row.appendChild(el('span', 'hs-row-name', member.name));
      row.appendChild(el('span', 'hs-row-meta', member.rank));
      root.appendChild(row);
    }
  }

  function renderParcels(data) {
    const root = $('hs-parcels');
    root.innerHTML = '';
    const parcels = data.parcels || [];
    if (parcels.length === 0) {
      root.appendChild(el('div', 'hs-empty', 'No parcels in this hold.'));
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

  function render(data) {
    state.data = data;
    if (data.targetId != null) state.targetId = data.targetId;
    $('hs-hold-name').textContent = data.holdName || data.holdId || '—';
    $('hs-your-rank').textContent = data.yourRank
      ? 'Your rank: ' + data.yourRank
      : (data.isStaff ? 'Staff' : 'You are not a member of this hold');
    renderRanks(data.ranks);
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
