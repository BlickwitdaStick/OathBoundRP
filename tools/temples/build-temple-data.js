#!/usr/bin/env node
/**
 * Builds skymp/gamemode/data/temple-data.json from Skyrim.esm: where a downed
 * player wakes up (death-service.js) and which temple is "nearest" from any
 * vanilla interior cell or worldspace.
 *
 * - temples: the city temples plus Falkreath's House of Arkay (the only small
 *   town with a hall of the dead; Morthal, Dawnstar and Winterhold have none).
 *   For each: the CELL, the spawn point inside it and the point outside its
 *   front door (the exterior side of the door's teleport, in the Tamriel
 *   coordinate frame) used for distance.
 * - tamrielWorlds: Tamriel and the worldspaces carved out of it (WNAM parent
 *   Tamriel). They share Tamriel's coordinates (the Whiterun gate is at
 *   19312,-7424 in Tamriel and 19367,-7433 in WhiterunWorld), so a straight
 *   distance to each temple's door is valid there.
 * - nearestByCell: vanilla interior cells and other worldspaces -> temple key,
 *   found by walking load doors (breadth first) to the first exit into a
 *   Tamriel-frame worldspace and taking the temple nearest that exit.
 *
 * Every temple cell is checked to be a CELL record with the expected editor
 * id; the build fails otherwise (0x162e2 was once used as a cell and froze
 * every player: it is an object in the Blue Palace).
 *
 * Usage: node tools/temples/build-temple-data.js [SkyrimData]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { readCells } = require('./esm-cells');

const DATA = process.argv[2] || process.env.SKYRIM_DATA || 'E:\\SkyrimRP\\Skyrim Special Edition\\Data';
const REPO = path.resolve(__dirname, '..', '..');
const OUT = path.join(REPO, 'skymp', 'gamemode', 'data', 'temple-data.json');

const TAMRIEL = 0x3c;
const XMARKER = 0x3b;
const XMARKER_HEADING = 0x34;

/**
 * The temples. `door` is the front door REFR inside the cell; the spawn is
 * that door's teleport marker (where the game itself places you when you walk
 * in), unless `marker` names an XMarkerHeading REFR to use instead.
 */
const TEMPLES = [
  // Kynareth keeps the spot already used as the respawn point: the
  // XMarkerHeading on the floor near the healers.
  { key: 'whiterun', name: 'Temple of Kynareth, Whiterun', cell: 0x165a7, edid: 'WhiterunTempleofKynareth', door: 0x166c7, marker: { pos: [-14.34, -123.39, 63.32] } },
  { key: 'solitude', name: 'Temple of the Divines, Solitude', cell: 0x16a02, edid: 'SolitudeTempleoftheDivines', door: 0x16b4a },
  { key: 'riften', name: 'Temple of Mara, Riften', cell: 0x16bd7, edid: 'RiftenTempleofMara', door: 0x16cae },
  { key: 'windhelm', name: 'Temple of Talos, Windhelm', cell: 0x16785, edid: 'WindhelmTempleofTalos', door: 0x167fe },
  { key: 'markarth', name: 'Temple of Dibella, Markarth', cell: 0x16df3, edid: 'MarkarthTempleofDibella', door: 0x16f2a },
  { key: 'falkreath', name: 'House of Arkay (Hall of the Dead), Falkreath', cell: 0x13a71, edid: 'FalkreathHouseofArkay', door: 0x14227 }
];

const hex = (n) => n.toString(16);
const deg = (rad) => Math.round(((rad * 180) / Math.PI + 360) % 360);

function dist2(a, b) {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  return dx * dx + dy * dy;
}

function build() {
  const esm = path.join(DATA, 'Skyrim.esm');
  const { worlds, cells, doors, markers } = readCells(esm, new Set([XMARKER, XMARKER_HEADING]));

  // Where a door leads: the container (interior cell id, or worldspace id for
  // exterior cells) and the arrival point.
  const containerOf = (cellId) => {
    const c = cells.get(cellId);
    if (!c) return null;
    return c.interior ? { kind: 'cell', id: c.id } : { kind: 'world', id: c.world };
  };

  // A worldspace shares Tamriel's coordinates when every gate between it and
  // Tamriel has both sides within GATE_SLACK units (city gates: ~50-450).
  // WNAM parent alone is not enough: Blackreach-style worlds also name
  // Tamriel as parent and use their own coordinates.
  const GATE_SLACK = 1000;
  const gateOk = new Map();
  for (const d of doors.values()) {
    const from = containerOf(d.container);
    const target = doors.get(d.dest.door);
    const to = target && containerOf(target.container);
    if (!from || !to || from.kind !== 'world' || to.kind !== 'world') continue;
    if (from.id !== TAMRIEL || to.id === TAMRIEL) continue;
    const close = Math.sqrt(dist2(d.pos, target.pos)) < GATE_SLACK;
    gateOk.set(to.id, (gateOk.has(to.id) ? gateOk.get(to.id) : true) && close);
  }
  const tamrielWorlds = new Set([TAMRIEL]);
  for (const [id, ok] of gateOk) if (ok && worlds.has(id)) tamrielWorlds.add(id);

  const temples = TEMPLES.map((t) => {
    const cell = cells.get(t.cell);
    if (!cell || !cell.interior || cell.edid !== t.edid) {
      throw new Error(`temple ${t.key}: ${hex(t.cell)} is not interior CELL ${t.edid} (got ${cell ? cell.edid : 'nothing'})`);
    }
    const door = doors.get(t.door);
    if (!door || door.container !== t.cell) throw new Error(`temple ${t.key}: door ${hex(t.door)} is not in cell ${hex(t.cell)}`);
    const outside = doors.get(door.dest.door);
    const out = outside && containerOf(outside.container);
    if (!out || out.kind !== 'world' || !tamrielWorlds.has(out.id)) {
      throw new Error(`temple ${t.key}: front door ${hex(t.door)} does not lead to a Tamriel worldspace`);
    }
    // Arrival inside = the teleport marker of the exterior door.
    let spawnPos = outside.dest.pos;
    let spawnRot = [0, 0, deg(outside.dest.rot[2])];
    let spawnFrom = `teleport marker of door ${hex(outside.id)}`;
    if (t.marker) {
      const m = markers.find((x) => x.container === t.cell && x.base === XMARKER_HEADING &&
        Math.abs(x.pos[0] - t.marker.pos[0]) < 1 && Math.abs(x.pos[1] - t.marker.pos[1]) < 1);
      if (!m) throw new Error(`temple ${t.key}: marker at ${t.marker.pos} not found in cell`);
      // A few units above the marker so the actor is not placed in the floor.
      spawnPos = [Math.round(m.pos[0]), Math.round(m.pos[1]), Math.round(m.pos[2] + 7)];
      spawnRot = [0, 0, deg(m.rot[2])];
      spawnFrom = `XMarkerHeading ${hex(m.id)}`;
    }
    return {
      key: t.key,
      name: t.name,
      cellDesc: `${hex(t.cell)}:Skyrim.esm`,
      editorId: t.edid,
      pos: spawnPos.map((n) => Math.round(n)),
      rot: spawnRot,
      spawnFrom,
      exterior: { worldDesc: `${hex(out.id)}:Skyrim.esm`, pos: door.dest.pos.map((n) => Math.round(n)) }
    };
  });

  const nearestTemple = (pos) => {
    let best = null;
    for (const t of temples) {
      const d = dist2(pos, t.exterior.pos);
      if (!best || d < best.d) best = { key: t.key, d };
    }
    return best;
  };

  // Door graph: node key "c<id>" (interior cell) or "w<id>" (non-Tamriel world).
  const edges = new Map();
  for (const d of doors.values()) {
    const from = containerOf(d.container);
    const target = doors.get(d.dest.door);
    const to = target && containerOf(target.container);
    if (!from || !to) continue;
    const fromKey = from.kind === 'cell' ? `c${from.id}` : `w${from.id}`;
    if (from.kind === 'world' && tamrielWorlds.has(from.id)) continue;
    if (!edges.has(fromKey)) edges.set(fromKey, []);
    edges.get(fromKey).push({ to, pos: d.dest.pos });
  }

  const nearestByCell = {};
  for (const start of edges.keys()) {
    const seen = new Set([start]);
    let frontier = [start];
    let found = null;
    while (frontier.length && !found) {
      const next = [];
      for (const node of frontier) {
        for (const e of edges.get(node) || []) {
          if (e.to.kind === 'world' && tamrielWorlds.has(e.to.id)) {
            const n = nearestTemple(e.pos);
            if (!found || n.d < found.d) found = n;
            continue;
          }
          const k = e.to.kind === 'cell' ? `c${e.to.id}` : `w${e.to.id}`;
          if (!seen.has(k)) { seen.add(k); next.push(k); }
        }
      }
      frontier = next;
    }
    if (found) nearestByCell[hex(Number(start.slice(1)))] = found.key;
  }
  // A temple is its own nearest temple.
  for (const t of temples) nearestByCell[t.cellDesc.split(':')[0]] = t.key;

  const byTemple = {};
  for (const [cell, key] of Object.entries(nearestByCell)) (byTemple[key] = byTemple[key] || []).push(cell);
  for (const list of Object.values(byTemple)) list.sort((a, b) => parseInt(a, 16) - parseInt(b, 16));

  const out = {
    source: 'Skyrim.esm, built by tools/temples/build-temple-data.js',
    defaultTemple: 'whiterun',
    temples,
    tamrielWorlds: [...tamrielWorlds].sort((a, b) => a - b).map(hex),
    cellsByTemple: byTemple
  };
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1) + '\n');
  const counts = Object.entries(byTemple).map(([k, v]) => `${k}=${v.length}`).join(' ');
  console.log(`[temples] wrote ${path.relative(REPO, OUT)}: ${temples.length} temples, ${Object.keys(nearestByCell).length} cells/worlds mapped (${counts})`);
  for (const t of temples) console.log(`  ${t.key.padEnd(10)} ${t.cellDesc.padEnd(18)} ${t.editorId.padEnd(28)} spawn ${t.pos.join(',')} rot ${t.rot[2]} (${t.spawnFrom}) outside ${t.exterior.worldDesc} ${t.exterior.pos.join(',')}`);
}

build();
