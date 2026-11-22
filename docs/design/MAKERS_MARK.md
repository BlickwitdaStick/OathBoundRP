# Maker's Mark — game design

**Status: IMPLEMENTED (lab), 2026-08-22.** Level 1 of this document (§4)
is in the code: `crafted_item_signatures` (migration-v24), a rank gate in
`crafting-service.craftItem()`, institutional search in
`governance-service.notifyMakerSignatures`. Like every `lab` module, it is born
behind a flag (`ENABLE_CRAFTING_SERVICE`) and **has never run with a real player**
— only automated tests against a fake database, the same state as Crime/Provenance
and Depot. Level 2 (§4, truly non-fungible items) remains a proposal,
not recommended.

Origin: a request from the project owner on 2026-08-22, motivated by the
Crime/Provenance system (`item_instances`, see [CRIME_SYSTEM_AUDIT.md](../technical/CRIME_SYSTEM_AUDIT.md))
— stolen items carry owner provenance; the complementary idea is that **crafted**
items carry author provenance.

## 0. What changed between the proposal and the implementation

- **§6 pointed out that the `required_profession`/`required_rank` gate did not exist
  in `main`.** While investigating in order to implement it, it turned up whole — tested, 606
  lines — on an orphan branch (`feat/crafting-profession-integration`,
  2026-08-20) that was never merged. It was brought over instead of reimplemented; the
  migration it carried (`v20`) was renumbered to `v23` because `main` already
  had `v20` (Depot) and `v21`/`v22` (Crime) when the merge happened. See the
  merge commit and `docs/gameplay/PROFESSION_FRAMEWORK.md`.
- **`owner_character_id` is not kept in sync with trade/sale/deposit**
  in this round — none of those three services writes to
  `crafted_item_signatures`. The search shows "who received it at craft time", not
  necessarily "who has the item now". Recorded in the column comment
  in `migration-v24-crafted-item-signatures.sql`.
- **Atomicity**: writing the signature is NOT the same transaction as the craft's
  `inventory.exchange` — a deliberate decision, see the header of
  `crafting-service.js` and §4 below.
- No Blacksmith/Enchanter/Cook recipe exists yet (§9,
  unchanged) — the integration test (`crafting-governance-integration.test.js`)
  uses a fictitious `blacksmith` recipe because no real one is registered
  in `seed-forging.sql`.

---

## 1. Goal

A craftsman with enough XP/rank can mark an item they make with their
signature (the craftsman's name, or a custom name requested by whoever ordered it —
"for Lydia, from João the Smith"). This gives old-school RP texture (smiths
who sign their work) and creates an economic reason to buy from a recognized
craftsman instead of the first NPC/PC who shows up.

**Scope confirmed with the project owner**: it is not exclusive to the Blacksmith —
any profession with `category: 'crafting'` in the registry (`smelter`,
`blacksmith`, `tanner`, `enchanter`, `cook`) is a candidate. The gate (minimum rank)
is per profession, not a special case for a single one.

## 2. Problem it solves

Today, two items with the same `baseId` are identical everywhere in the project —
inventory, stall, depot. There is no craftsman reputation: the Blacksmith
rank (when it has gameplay) affects what you can craft, never who
knows you crafted it. "Buying from a good blacksmith" is today indistinguishable from
"buying from anyone".

## 3. Why this is NOT cheap — the main finding of this analysis

Before designing the API, three facts in the current code change the shape of the
proposal:

### 3.1 `character_inventory` is purely fungible, without exception

`migration-v14-inventory-framework.sql` has
`UNIQUE (owner, base_id)` — **one row per (character, item), with only a
count**. Nowhere in the project is there a unit of item with its
own identity inside the normal inventory. Two iron swords with the
same owner are always "2", never "this one and that one".

### 3.2 `item_instances` (crime) already solved a similar problem — but not the way intuition suggests

`markItemStolen` (`core/crime-service.js:178-261`) does not mark **the physical
unit that was stolen**. It does an `UPDATE`/`INSERT` on a row keyed by
`(base_id, current_owner_id, status)` — that is, "this character has, of
item type X, one unit with dirty provenance", not "the third item in the
stack is the stolen one". It works for crime because the question the institutional
search asks is binary: *"is something of this item type you carry
stolen?"* — it does not matter which of the 3 identical swords is the exact one.

**A maker's mark asks a different question**: not "is this item
suspicious", but "which OF THESE 3 identical swords is the one João signed".
Two swords signed by two different craftsmen, with the same `baseId`, in the
same backpack, is the normal use case — and the current `item_instances` model
was not designed to distinguish that; it was designed
deliberately NOT to need it (see `CRIME_SYSTEM_AUDIT.md` §3,
"Inventory stops being 100% fungible for the subset of stolen
items" — the subset is 1 flag per type, not N tracked objects).

### 3.3 The name does not appear in the game itself

`base_id` is a Skyrim FormDesc (`"162e2:Skyrim.esm"`-style — see the
convention recorded in the project's memory). The server does not control the name
the Skyrim client shows for that object — there is today no
mechanism (client mod, CEF UI, name injection) that replaces "Iron Sword"
with "Iron Sword (signed by João)" on the player's screen. It is only
visible through the project's own UI — exactly as the crime institutional
search already does (it does not change the item's name in Skyrim's HUD,
it shows the provenance in a notification/panel).

## 4. Proposed design — two levels, increasing scope

### Level 1 (recommended to deliver first): signature as type metadata, not object metadata

Accepts the same simplification crime already accepts. A new table,
**decoupled from `item_instances`** (crime is about guilt, this is about
authorship — mixing the two would make a crime feature carry a
responsibility that is not its own):

```sql
CREATE TABLE crafted_item_signatures (
  id              CHAR(36)     PRIMARY KEY,   -- uuid, same pattern as item_instances.id
  base_id         BIGINT       NOT NULL,
  maker_character_id   INT     NOT NULL,
  owner_character_id   INT     NOT NULL,      -- who has it today (equal to maker until sold/traded)
  signature_text  VARCHAR(64)  NULL,           -- custom name requested by the buyer; NULL = uses the craftsman's name
  crafted_at      DATETIME     NOT NULL,
  recipe_id       INT          NOT NULL,
  FOREIGN KEY (maker_character_id) REFERENCES characters(id),
  FOREIGN KEY (owner_character_id) REFERENCES characters(id),
  INDEX idx_signature_owner_base (owner_character_id, base_id)
);
```

Flow:

1. `craftItem` gains an optional `opts.signatureText`.
2. Gate: only accepted if `professionService.getProfessionState(characterId, recipe.crafting_profession_code)`
   has `status === 'active'` **and** `rank >= profession.signatureMinRank`
   (new `server-options`, suggested default = `Math.ceil(profession.maxRank / 2)` — rank 2 of 3, not the
   top, so as not to lock the feature behind a ceiling that today has no content to reach).
3. A successful craft with a signature writes a row to
   `crafted_item_signatures`, in the SAME transaction as the `inventory.exchange`
   (the same pattern `crime-service` already uses: provenance and item movement
   cannot diverge).
4. Search/inspection (reusing the channel `governance-service.showInventorySnapshot`
   already exposes for crime) starts showing, per item type the target carries,
   whether there is a known signature — like crime provenance, same UI
   channel, different data.
5. **Accepted limitation, documented, the same as crime's**: if the character has
   2 iron swords, one signed and one not (or two signed by
   different craftsmen), the system knows that "there is at least one
   signature among your iron swords", not which physical unit is which.
   Enough for RP flavor ("they say one of these is
   Balgruuf's work"), not enough for piece-by-piece proof of individual possession.

### Level 2 (not recommended now): truly non-fungible objects

It would make `character_inventory` stop being purely a count for signed
items — each signed unit becomes its own row, outside the aggregated `count`,
and it would have to propagate through **every** inventory consumer:
`trade`, `market-stalls-service`, `depot-service`, `crime-service`. It is the
same decision the crime system itself deliberately avoided (see §3.2) —
reopening that boundary for a second feature would multiply the risk, not
divide it. It only makes sense if the project one day decides that "a unique,
physically traceable item" is a core capability (e.g. legendary items,
quest relics), and in that case the right decision is to design it once
to serve all cases, not once per feature that asks for uniqueness.

## 5. Sale price — no new mechanism needed

`market-stalls-service.addItem` already accepts an arbitrary `price` set by
whoever lists it (`/stalladd <stallId> <baseId> <count> <price> <label>`) — there
is no automatic quality-based pricing engine in the project today. An item
signed by a recognized craftsman **can already** be listed for more gold
today, with no change at all — it is the player deciding, and the market (other
players) deciding whether to pay. The signature gives the player an *in-game reason*
for that price to be credible ("it's Balgruuf's, he's rank 3"), not a system
multiplier. **Do not implement** automatic price adjustment by signature —
it would be the engine deciding RP value, a role that belongs to the player.

Commissioned work ("make a sword with my wife's name") is
purely RP + Level 1's `signatureText` — it needs no new contract
mechanism; if it grows to the point of needing a formal queue/payment, the
Contract Framework (`docs/gameplay/CONTRACTS.md`) already exists for that and is
reuse, not a new feature.

## 6. Compatibility with current systems

| System | Impact |
|---|---|
| `profession-service.js` | Read only (`getProfessionState`) — no new writes. It needs the real rank/XP gaining XP per craft, which **does not exist yet** (`PROFESSION_FRAMEWORK.md` §11: "XP curve → level-up" not implemented). Without that, `signatureMinRank` is only reachable by a manual staff adjustment (`profession.xp` capability) — acceptable for launching in `lab`, but record it as a real dependency. |
| `crafting-service.js` | Needs the per-recipe `required_profession`/`required_rank` gate to even know WHICH profession crafted the item. **This gate does not exist in `main` today** — `PROFESSION_FRAMEWORK.md` §11 describes a `migration-v20-crafting-profession-gate.sql` that, checked now, does not exist: `v20` in `main` is `depot-service`, not crafting-gate. It is the same warning already recorded in the project's memory ("main is a subset, not the most advanced state" — 3 competing v20 migrations on unmerged branches). **Real prerequisite**: locate/merge that gate before or together with this feature, otherwise "Blacksmith signature" cannot distinguish a Blacksmith's craft from any character's craft. |
| `item_instances` (crime) | Sister table, not direct reuse — see §4. If the same item is later stolen, the two systems coexist: `markItemStolen` still does not know about signatures (it does not need to), and the guard search would show both pieces of information side by side (possession provenance + authorship), from different sources. |
| `market-stalls-service.js` | No schema change needed — price is already free (§5). |
| Contracts (`contracts-service.js`) | Optional future reuse for formal commissions — no mandatory dependency now. |
| Skyrim engine / item name | No change — the name seen in game remains the `base_id`'s. The signature only exists in the project's own UIs. |

## 7. Exploits to consider (same format as the crime audit)

- **Self-assigning a signature without a real craft**: `signatureText` can only be
  written inside the SAME transaction as a successful `inventory.exchange`
  from `craftItem` — never a loose write callable by a player command.
- **Forging the authorship of a famous craftsman**: `maker_character_id` always comes from
  the `characterId` that actually crafted (same argument as `craftItem`),
  never from free client text — only `signatureText` (the dedication) is
  free, never the "signed by". Sanitizing/limiting the size of `signatureText`
  (64 chars, no formatting control) prevents chat injection abuse in the
  search/UI.
- **Craftsman reputation used for a scam** (selling an item "signed by
  so-and-so" that actually is not): solved by construction — the row in
  `crafted_item_signatures` only exists if the craft really happened by
  that character; there is no write path that allows "stamping" an
  existing item after the fact.

## 8. Economic impact

No value creation on its own — it does not change `characters.gold`,
`transaction-service`, or taxes. The economic effect is 100% emergent from the
market (players paying more for reputation), not a system
multiplier. Consistent with the project's line of never letting a system
"decide" RP value on its own (the same principle that kept the
regional economy PARKED until re-engineering).

## 9. Prerequisites — state on 2026-08-22

1. ✅ **The `required_profession`/`required_rank` gate in `crafting_recipes`** —
   brought from `feat/crafting-profession-integration` to `main`
   (`migration-v23-crafting-profession-gate.sql`, see §0).
2. ❌ **At least one real Blacksmith/Enchanter/Cook recipe** —
   still does not exist. Smelter and Tanner are the only ones with
   `required_profession` filled in `seed-forging.sql`. Forging a real
   Blacksmith recipe still requires a confirmed `result_base_id`,
   not an invented one — no PR from this document invented one.
3. ✅ **XP per craft** (`addProfessionXp` inside `craftItem`) — came
   along with item 1, via `crafting.xpPerCraft`.
4. ✅ **`crafted_item_signatures`** (Level 1, §4) and the parameter
   `crafting.signatureMinRank` (default 2) — `migration-v24-crafted-item-signatures.sql`.

## 10. What remains pending

- **A real Blacksmith recipe** (item 2 above) — without it, the Maker's
  Mark is only demonstrable today via Smelter/Tanner (which already have
  `required_profession`) or by an integration test with a fictitious recipe
  (`crafting-governance-integration.test.js`).
- **`owner_character_id` does not follow the item through trade/sale/deposit** (§0) —
  wiring that would require touching `trade-service.js`, `market-stalls-service.js` and
  `core/depot-service.js`, the same "touch every inventory consumer" that
  Level 2 (§4) already discarded as disproportionate scope. Left as a
  known limitation, not a bug.
- **It has never run with a real player** — the same state as every `lab` module in this
  project.
