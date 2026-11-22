# Holdstones and parcels

Every **holdstone** is the seat of an **organization**: a hold (Whiterun), a
town (Riverwood), a faction (the Imperial Legion), a thanedom, or a council
(High Hrothgar, where staff hold in-character meetings). Each organization has
its own ordered **rank ladder** and **members**, and a character can be tied to
several at once: a citizen of Solitude can also be a Legion soldier. Solitude
can therefore have two stones, the Solitude stone and the Imperial Legion's.

A **parcel** is a building or plot controlled by an organization: a set of
doors and containers with an **owner** and a **minimum rank**. When a parcel is
locked, its doors and containers open only for:

- the owner,
- members of **that organization** at or above the parcel's minimum rank,
- staff.

Everyone else sees **"It's locked."** and nothing opens.

This is an original design for OATHBOUND (the idea is similar to MerethRP's
holdstones, but no code was taken from it).

| Piece | Where |
|---|---|
| Stone list (one line per stone) | `skymp/gamemode/data/holdstones.json` |
| Stone activators + model | `Oathbound_Holdstone.esp`, built by `tools/holdstone/` |
| Tables | `migration-v33-holdstones-parcels.sql`, `migration-v41-stone-organizations.sql` |
| Rules (pure, tested) | `skymp/gamemode/core/parcel-locks.js` |
| Service, menu, tool, commands | `skymp/gamemode/holdstone-service.js` |
| Stone panel | `skymp/ui/holdstone-panel.js` / `.css`, markup in `index.html` |
| Flag | `ENABLE_HOLDSTONES` (default `true` in `.env.example`) |

The stone menu and the parceling tool also need
`ENABLE_INTERACTION_FRAMEWORK=true` and `ENABLE_INTERACTION_PROMPT=true`. The
locks work without them.

---

## Stones are placed in the Creation Kit, nothing in game

Each stone is its **own activator** in `Oathbound_Holdstone.esp`, all with the
same runed-monolith model:

| Activator | Editor ID | FormID | Organization |
|---|---|---|---|
| Whiterun Holdstone | `OBHoldstoneWhiterun` | `801` | `whiterun` (hold) |
| Solitude Holdstone | `OBHoldstoneSolitude` | `802` | `solitude` (hold) |
| Riften Holdstone | `OBHoldstoneRiften` | `803` | `riften` (hold) |
| Windhelm Holdstone | `OBHoldstoneWindhelm` | `804` | `windhelm` (hold) |
| Markarth Holdstone | `OBHoldstoneMarkarth` | `805` | `markarth` (hold) |
| Falkreath Holdstone | `OBHoldstoneFalkreath` | `806` | `falkreath` (hold) |
| Morthal Holdstone | `OBHoldstoneMorthal` | `807` | `morthal` (hold) |
| Dawnstar Holdstone | `OBHoldstoneDawnstar` | `808` | `dawnstar` (hold) |
| Winterhold Holdstone | `OBHoldstoneWinterhold` | `809` | `winterhold` (hold) |
| Riverwood Holdstone | `OBHoldstoneRiverwood` | `80A` | `riverwood` (town) |
| High Hrothgar Holdstone | `OBHoldstoneHighHrothgar` | `80B` | `high_hrothgar` (council) |
| Imperial Legion Holdstone | `OBHoldstoneImperialLegion` | `80C` | `imperial_legion` (faction) |

`800` "Holdstone" is the old generic stone; it belongs to no one.

**To place one:** in the Creation Kit load `Oathbound_Holdstone.esp` with your
placement plugin (e.g. `Oathbound_Core.esp`), filter Activators by
`OBHoldstone`, drag the right stone into the cell, save. The server recognizes
it by its activator: pressing **E** on a "High Hrothgar Holdstone" opens High
Hrothgar's menu wherever it stands. Placing two of the same activator gives
that organization two stones.

The placement plugin must be loaded by the server and by every player, after
`Oathbound_Holdstone.esp`.

**To add a stone** (each thanedom, another faction):

1. Append an entry to `skymp/gamemode/data/holdstones.json`: a short `id`
   (`thane_rorikstead`), `name`, `kind` (`hold`, `town`, `faction`,
   `thanedom`, `council`), `hold` (where it sits, or `null`), the next unused
   `formId` and an `editorId`. Never change or reuse a `formId`.
2. `node tools/holdstone/build-plugin.js` rebuilds `Oathbound_Holdstone.esp`
   (in `tools/holdstone/dist/`).
3. Place it in the Creation Kit.
4. Ship the new plugin to the server and the players, upload the new
   `holdstones.json`, restart. On boot the server creates the organization with
   the default ladder of its kind.

---

## Rank ladders

New organizations start with the ladder of their kind (higher = more
authority; ★ = leader):

| Kind | Ladder |
|---|---|
| hold | Citizen < Guard < Steward★ < Jarl★ |
| town | Resident < Guard < Reeve★ |
| faction | Recruit < Member < Officer★ < Leader★ |
| thanedom | Retainer < Housecarl < Thane★ |
| council | Councilor < Elder★ |

Holds keep the ranks and members they already had before migration v41.

**Leaders** can, in their own organization only:

- set the rank of a player whose rank is **below** theirs, to a rank **below**
  theirs (a Steward can make a Guard, but cannot make or remove a Jarl);
- create parcels, rename them, transfer them, set their minimum rank, lock or
  unlock them, and use the parceling tool.

Parcel **owners** (any rank) can lock and unlock their own parcels at the stone.
Staff can do everything everywhere.

Staff change a ladder with commands:

```
/holdstone ranks high_hrothgar
/holdstone addrank high_hrothgar greybeard 30 leader Greybeard
/holdstone addrank imperial_legion leader 40 leader Legate      (renames an existing key)
/holdstone delrank riverwood guard
```

Deleting a rank removes it from everyone who held it, and parcels that used it
as minimum rank become owner-only.

---

## Staff: running a stone

1. **Place the stone** in the Creation Kit (above).
2. **Appoint the leaders:** `/holdrank whiterun 12 jarl`,
   `/holdrank high_hrothgar 12 elder` (12 = the player's character number, see
   `/nearby`). The player must be online for the command; at the stone,
   leaders can use any number, online or not.
3. **Create parcels** (or let the leaders do it at the stone):
   `/parcel create imperial_legion Castle Dour Barracks`, then
   `/parcel rank <id> member`. The parcel is located in the organization's
   hold (none for a council).
4. **Assign doors and containers** with the parceling tool (below), or
   `/parcel add <id> <formDesc> <door|container>`.
5. **Give it to someone:** `/parcelowner <id> 12`, or "Transfer a parcel" at
   the stone.

`/holdstone list` shows every organization, its kind, whether it has a stone,
its members and parcels. `/parcel list <stone>` and `/parcel info <id>` show
parcels and their objects.

All staff commands (`<stone>` is the organization id: `whiterun`,
`high_hrothgar`, `imperial_legion`…):

```
/holdstone list | ranks <stone> | addrank <stone> <key> <position> <leader|member> <name> | delrank <stone> <key>
/holdrank <stone> <player#> <rank|none>
/parcel list <stone> | info <id> | create <stone> <name> | rename <id> <name> | delete <id>
/parcel rank <id> <rank|none> | lock <id> | unlock <id> | disown <id>
/parcel add <id> <formDesc> <door|container> | remove <formDesc> | tool <id|off>
/parcelowner <id> <player#>
```

---

## The parceling tool (no commands)

1. At the stone, a leader (or staff) opens the menu and picks
   **Parceling tool**, entering the parcel number — or clicks **Parcel tool**
   next to the parcel in the stone panel.
2. Walk to a door or container and press **E**. Instead of opening, the menu
   shows:
   - **Add to parcel…** — adds it to the selected parcel;
   - **Remove from parcel** — if it already belongs to a parcel;
   - **Lock this side / make it an exit** — doors only (see load doors);
   - **Stop parceling tool**.
3. When done, pick **Stop parceling tool** (or `/parcel tool off`). Doors open
   normally again. The tool also turns off on logout.

An object belongs to at most one parcel. Stones cannot be part of a parcel.
Only doors (`DOOR`) and containers (`CONT`) can be added; anything else
answers "Only doors and containers can be part of a parcel."

### Load doors (both sides)

A door that loads a new cell is two separate objects, one in each cell. When
you add one side, the server tries to read the other side from the door's
teleport data and adds it automatically as an **exit**: it is part of the
parcel but **never locks**, so nobody can be trapped inside. If you want the
inside locked too (a vault, a cell), press E on it with the tool and pick
**Lock this side / make it an exit**.

If the other side was not found (the message does not mention it), go inside
and add it by hand with the tool, then decide whether it locks.

---

## Players: using a stone

Press **E** on a stone and pick **Open the stone**. The panel shows:

- the organization, its kind and the hold it sits in;
- **your rank** there (or that you are not tied to it);
- **your allegiances**: every organization you are tied to, with your rank;
- the rank ladder, lowest to highest (leader ranks are highlighted);
- the members and their ranks;
- every parcel: number, owner, who can open it, how many doors and
  containers, and whether it is **Locked** or **Open**.

Owners see **Lock / Unlock** on their own parcels. Leaders also see the
leadership forms (set a rank by player number, create a parcel) and the
**Parcel tool** button. Rename, transfer and minimum rank are in the stone's
E menu.

---

## What to verify in game

Nothing below has been run on a live server yet.

1. **Boot:** the log shows `[holdstones] N organizations (N with a stone), …`
   and no errors from `activation-events` or `holdstones.json`.
2. **A Creation Kit stone works untouched:** E on the High Hrothgar Holdstone
   placed in the Creation Kit opens the High Hrothgar panel (kind Council). The
   E prompt shows "Open the stone" when you look at it.
3. **Two stones in one city:** the Solitude and Imperial Legion stones open
   different panels with different ladders.
4. **Ranks:** `/holdrank high_hrothgar <your#> elder`; reopen the panel →
   "Your rank: Elder", the Leadership section, and High Hrothgar under "Your
   allegiances". Add a Whiterun rank too; both appear at any stone.
5. **Parcel + tool:** create "Test House" with minimum rank `guard` at the
   Whiterun stone; start the tool; E on the house's front door → the parcel
   menu opens (the door does not). Add it; check whether the inside door was
   added as an exit. Add a chest inside. Stop the tool.
6. **Locks:** a player with no Whiterun rank presses E on the front door →
   "It's locked." and the door stays shut; on the chest → "It's locked." and no
   container menu. A Whiterun Guard opens both; a Legion Leader with no
   Whiterun rank does not. Staff open both. The owner (after **Transfer**)
   opens both.
7. **Exit side:** a rankless player inside can still leave through the inside
   door.
8. **Unlock:** the owner clicks Unlock → anyone can open; Lock again → blocked.
9. **Restart persistence:** after a restart the locks and ranks still apply.

Unverified assumptions to watch:

- `mp.get(ref, 'baseDesc')` returning the activator of a stone placed in a
  plugin as `801:Oathbound_Holdstone.esp` (light plugin, local FormID). If E
  on a placed stone does nothing, check the server log line for that stone's
  base desc.
- Reading the other side of a load door from the `XTEL` field of
  `mp.lookupEspmRecordById`. If it never finds the partner, add inside doors by
  hand.
- Blocking a container through `mp.onActivate` stops the container menu from
  opening, the same way it stops doors.
- NPC activations are never blocked (only characters are checked).
