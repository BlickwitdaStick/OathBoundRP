"use strict";

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { spawnSync } = require("child_process");

const repo = "E:/SkyrimRP/skymp-heavy-rp";
const game = "E:/Tools/steamapps/common/Skyrim Special Edition";
const data = path.join(game, "Data");
const pluginsFile = path.join(game, "OATHBOUND_plugins.txt");
const orderFile = path.join(game, "OATHBOUND_loadorder.txt");
const manifest = path.join(repo, "apps/game-api/mods.json");
const generator = path.join(repo, "apps/game-api/scripts/generate-mods-manifest.js");

const key = s => s.toLowerCase();
const errors = new Set();

function readList(file) {
  const lines = fs.readFileSync(file, "utf8")
    .replace(/^\uFEFF/, "").split(/\r?\n/);
  const entries = [];
  const comments = [];
  const seen = new Set();

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#")) {
      comments.push(line);
      continue;
    }

    const active = line.startsWith("*");
    const name = (active ? line.slice(1) : line).trim();

    if (!/\.(esm|esp|esl)$/i.test(name))
      throw new Error(`Unexpected line in ${file}: ${raw}`);

    const k = key(name);
    if (seen.has(k))
      throw new Error(`Duplicate plugin in ${file}: ${name}`);

    seen.add(k);
    entries.push({ name, active });
  }

  return { entries, comments };
}

function readMasters(file) {
  const b = fs.readFileSync(file);

  if (b.length < 24 || b.toString("ascii", 0, 4) !== "TES4")
    throw new Error(`Invalid Skyrim plugin header: ${file}`);

  const size = b.readUInt32LE(4);
  const flags = b.readUInt32LE(8);

  if (size > b.length - 24)
    throw new Error(`Incomplete plugin header: ${file}`);

  let payload = b.subarray(24, 24 + size);

  if (flags & 0x00040000) {
    if (payload.length < 4)
      throw new Error(`Invalid compressed header: ${file}`);
    payload = zlib.inflateSync(payload.subarray(4));
  }

  const masters = [];
  let offset = 0;
  let extendedSize = null;

  while (offset + 6 <= payload.length) {
    const type = payload.toString("ascii", offset, offset + 4);
    const smallSize = payload.readUInt16LE(offset + 4);
    offset += 6;

    if (type === "XXXX") {
      if (smallSize !== 4 || offset + 4 > payload.length)
        throw new Error(`Invalid extended subrecord: ${file}`);
      extendedSize = payload.readUInt32LE(offset);
      offset += 4;
      continue;
    }

    const subSize = extendedSize === null ? smallSize : extendedSize;
    extendedSize = null;

    if (offset + subSize > payload.length)
      throw new Error(`Invalid subrecord size: ${file}`);

    const sub = payload.subarray(offset, offset + subSize);

    if (type === "MAST") {
      const name = sub.toString("utf8").split("\0")[0].trim();
      if (name) masters.push(name);
    }

    offset += subSize;
  }

  if (offset < payload.length &&
      payload.subarray(offset).some(byte => byte !== 0))
    throw new Error(`Could not parse plugin header: ${file}`);

  return masters;
}

function main() {
  for (const f of [pluginsFile, orderFile, generator]) {
    if (!fs.existsSync(f))
      throw new Error(`Required file not found: ${f}`);
  }
  if (!fs.existsSync(data))
    throw new Error(`OATHBOUND Data folder not found: ${data}`);

  const pluginList = readList(pluginsFile);
  const loadList = readList(orderFile);

  const dataFiles = new Map();
  for (const f of fs.readdirSync(data, { withFileTypes: true })) {
    if (f.isFile() && /\.(esm|esp|esl)$/i.test(f.name))
      dataFiles.set(key(f.name), f.name);
  }

  const nodes = new Map();
  const addNode = name => {
    const k = key(name);
    if (!nodes.has(k))
      nodes.set(k, dataFiles.get(k) || name);
    return k;
  };

  // Keep the current load order as the stable sorting preference.
  for (const e of loadList.entries) addNode(e.name);
  for (const e of pluginList.entries) addNode(e.name);

  const active = new Set(
    pluginList.entries.filter(e => e.active).map(e => key(e.name))
  );
  const originalActive = new Set(active);
  const autoEnabled = new Set();

  // Discover master dependencies recursively without changing files.
  const mastersByPlugin = new Map();
  const queue = [...nodes.keys()];
  const processed = new Set();

  for (let i = 0; i < queue.length; i++) {
    const k = queue[i];
    if (processed.has(k)) continue;
    processed.add(k);

    const actual = dataFiles.get(k);
    if (!actual) {
      mastersByPlugin.set(k, []);
      continue;
    }

    const masters = readMasters(path.join(data, actual));
    mastersByPlugin.set(k, masters);

    for (const master of masters) {
      const mk = key(master);
      if (!dataFiles.has(mk)) continue;
      if (!nodes.has(mk)) {
        addNode(master);
        queue.push(mk);
      }
    }
  }

  // Every enabled plugin must have all its masters present and enabled.
  let changed = true;
  while (changed) {
    changed = false;

    for (const k of nodes.keys()) {
      if (!active.has(k)) continue;

      if (!dataFiles.has(k)) {
        errors.add(`Enabled plugin is missing from Data: ${nodes.get(k)}`);
        continue;
      }

      for (const master of mastersByPlugin.get(k) || []) {
        const mk = key(master);

        if (!dataFiles.has(mk)) {
          errors.add(`${nodes.get(k)} requires missing master file: ${master}`);
          continue;
        }

        if (!nodes.has(mk)) {
          errors.add(`${nodes.get(k)} requires a master absent from the lists: ${master}`);
          continue;
        }

        if (!active.has(mk)) {
          active.add(mk);
          autoEnabled.add(mk);
          changed = true;
        }
      }
    }
  }

  if (errors.size)
    throw new Error([...errors].join("\n"));

  // Build master-before-dependent constraints.
  const outgoing = new Map();
  const indegree = new Map();

  for (const k of nodes.keys()) {
    outgoing.set(k, new Set());
    indegree.set(k, 0);
  }

  function addEdge(from, to) {
    if (!nodes.has(from) || !nodes.has(to)) return;
    if (from === to) {
      errors.add(`Self-dependency found: ${nodes.get(from)}`);
      return;
    }
    if (!outgoing.get(from).has(to)) {
      outgoing.get(from).add(to);
      indegree.set(to, indegree.get(to) + 1);
    }
  }

  for (const [k, masters] of mastersByPlugin) {
    for (const master of masters)
      addEdge(key(master), k);

  }

  if (errors.size)
    throw new Error([...errors].join("\n"));

  // Stable topological sort: only move plugins when dependencies require it.
  const priority = new Map([...nodes.keys()].map((k, i) => [k, i]));
  const ready = [...nodes.keys()]
    .filter(k => indegree.get(k) === 0)
    .sort((a, b) => priority.get(a) - priority.get(b));

  const sorted = [];

  while (ready.length) {
    const k = ready.shift();
    sorted.push(k);

    for (const next of outgoing.get(k)) {
      indegree.set(next, indegree.get(next) - 1);

      if (indegree.get(next) === 0) {
        ready.push(next);
        ready.sort((a, b) => priority.get(a) - priority.get(b));
      }
    }
  }

  if (sorted.length !== nodes.size) {
    const cycle = [...nodes.keys()]
      .filter(k => indegree.get(k) > 0)
      .map(k => nodes.get(k));
    throw new Error(
      "Dependency cycle detected. No files changed:\n" + cycle.join("\n")
    );
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = path.join(repo, "backups", `OATHBOUND-loadorder-${stamp}`);
  fs.mkdirSync(backupDir, { recursive: true });

  const files = [pluginsFile, orderFile, manifest];
  const existed = new Map();

  for (const f of files) {
    existed.set(f, fs.existsSync(f));
    if (fs.existsSync(f))
      fs.copyFileSync(f, path.join(backupDir, path.basename(f)));
  }

  try {
    const names = sorted.map(k => nodes.get(k));

    const pluginOutput = [
      ...pluginList.comments,
      ...names.map(name => `${active.has(key(name)) ? "*" : ""}${name}`)
    ].join("\r\n") + "\r\n";

    const orderOutput = [
      ...loadList.comments,
      ...names
    ].join("\r\n") + "\r\n";

    fs.writeFileSync(pluginsFile, pluginOutput, "utf8");
    fs.writeFileSync(orderFile, orderOutput, "utf8");

    const result = spawnSync(
      process.execPath,
      [generator, data, "--out", manifest, "--plugins-txt", pluginsFile],
      { cwd: repo, encoding: "utf8", windowsHide: true }
    );

    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.error) throw result.error;
    if (result.status !== 0)
      throw new Error(`Manifest generator exited with code ${result.status}`);

    JSON.parse(fs.readFileSync(manifest, "utf8").replace(/^\uFEFF/, ""));

    console.log("\n========== REPAIR SUCCESS ==========");
    console.log(`Plugins ordered: ${sorted.length}`);
    console.log(`Enabled plugins: ${active.size}`);
    console.log(`Required masters newly enabled: ${autoEnabled.size}`);

    if (autoEnabled.size) {
      console.log([...autoEnabled]
        .map(k => nodes.get(k)).join(", "));
    }

    console.log(`Manifest regenerated: ${manifest}`);
    console.log(`Backups saved: ${backupDir}`);
    console.log("Mereth files were not touched.");
  } catch (err) {
    for (const f of files) {
      const backup = path.join(backupDir, path.basename(f));

      if (existed.get(f) && fs.existsSync(backup))
        fs.copyFileSync(backup, f);
      else if (!existed.get(f) && fs.existsSync(f))
        fs.unlinkSync(f);
    }

    console.error("Repair failed. Original files were restored.");
    console.error(`Backups: ${backupDir}`);
    throw err;
  }
}

try {
  main();
} catch (err) {
  console.error("\nREPAIR STOPPED:");
  console.error(err.message);
  process.exitCode = 1;
}

