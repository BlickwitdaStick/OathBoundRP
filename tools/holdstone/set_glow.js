// Sets the rune shader's emissive colour in holdstone.nif. PyNifly exports it
// black (vanilla glow stones animate it up from black with a controller; ours
// has no controller, so it needs a fixed colour or the glow map stays dark).
// The rune shader is the only one with Emissive Mult 2.0 preceded by a black
// Color3; anything else aborts.
const fs = require('fs');
const file = process.argv[2];
const [r, g, b] = [0.55, 0.8, 1.0];
const buf = fs.readFileSync(file);
const two = Buffer.alloc(4); two.writeFloatLE(2.0);
const hits = [];
for (let i = buf.indexOf(two); i >= 0; i = buf.indexOf(two, i + 1)) {
  if (i >= 12 && [12, 8, 4].every((k) => buf.readFloatLE(i - k) === 0)) hits.push(i);
}
if (hits.length !== 1) throw new Error(`expected one black emissive block with mult 2.0, found ${hits.length}`);
const at = hits[0];
buf.writeFloatLE(r, at - 12); buf.writeFloatLE(g, at - 8); buf.writeFloatLE(b, at - 4);
fs.writeFileSync(file, buf);
console.log(`emissive colour set at byte ${at - 12}`);
