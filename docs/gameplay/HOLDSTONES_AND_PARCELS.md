# Holdstones and parcels

A **holdstone** is one world object per hold that opens the hold menu. Each
hold has an ordered **rank ladder** and a list of **members**. A **parcel**
is a building or plot: a set of doors and containers with an **owner** and a
**minimum rank**. When a parcel is locked, its doors and containers open only
for:

- the owner,
- members of that hold at or above the parcel's minimum rank,
- staff.

Everyone else sees **"It's locked."** and nothing opens.

This is an original design for OATHBOUND (the idea is similar to MerethRP's
holdstones, but no code was taken from it).

| Piece | Where |
|---|---|
| Tables | `skymp/packages/database/migration-v33-holdstones-parcels.sql` |
| Rules (pure, tested) | `skymp/gamemode/core/parcel-locks.js` |
| Service, menu, tool, commands | `skymp/gamemode/holdstone-service.js` |
| Hold panel | `skymp/ui/holdstone-panel.js` / `.css`, markup in `index.html` |
| Flag | `ENABLE_HOLDSTONES` (default `true` in `.env.example`) |

The holdstone menu and the parceling tool also need
`ENABLE_INTERACTION_FRAMEWORK=true` and `ENABLE_INTERACTION_PROMPT=true`. The
locks work without them.

---

## The rank ladder

Every hold starts with four ranks (the migration seeds them for every hold):

| Position | Key | Name | Leader? |
|---|---|---|---|
| 10 | `citizen` | Citizen | no |
| 20 | `guard` | Guard | no |
| 30 | `steward` | Steward | yes |
| 40 | `jarl` | Jarl | yes |

Higher position = more authority. **Leaders** can:

- set the rank of a player whose rank is **below** theirs, to a rank **below**
  theirs (a Steward can make a Guard, but cannot make or remove a Jarl);
- create parcels, rename them, transfer them, set their minimum rank, lock or
  unlock them, and use the parceling tool.

Parcel **owners** (any rank) can lock and unlock their own parcels at the stone.
Staff can do everything.

Staff can change the ladder per hold:

```
/holdstone ranks riften
/holdstone addrank riften thane 35 leader Thane
/holdstone addrank riften citizen 10 member Citizen of Riften   (renames an existing key)
/holdstone delrank riften steward
```

Deleting a rank removes it from everyone who held it, and parcels that used it
as minimum rank become owner-only.

---

## Staff: setting up a hold

1. **Place the holdstone.** Stand where it should go, face that way and type
   `/holdstone spawn whiterun`. The holdstone model (a runed monolith from
   `OathboundHoldstone.esp`, built by `tools/holdstone/`) appears about 2.5 m
   in front of you with its runes facing you, already bound to the hold. It
   is saved with the world, so it stays after restarts. Spawning again moves
   the hold to the new stone and removes the old one; `/holdstone clear`
   removes a spawned stone too.

   To use an object that is already in the world instead (any object: a
   standing stone, a banner, a table, or a holdstone placed in the Creation
   Kit), type `/holdstone place whiterun`, then press **E** on it. The server
   stores it by FormDesc (`hex:Plugin.esm`, never a numeric FormID).
   Fallback: `/holdstone set whiterun 1a2b3:Skyrim.esm`.
   One stone per hold — placing a new one replaces the old one. A holdstone
   model that no hold owns says so when someone presses E on it.
2. **Appoint the leaders.** `/holdrank whiterun 12 jarl` (12 = the player's
   character number, see `/nearby`). The player must be online for the
   command; at the stone, leaders can use any number, online or not.
3. **Create parcels** (or let the Jarl do it at the stone):
   `/parcel create whiterun Dragonsreach Barracks`, then
   `/parcel rank <id> guard`.
4. **Assign doors and containers** with the parceling tool (below), or
   `/parcel add <id> <formDesc> <door|container>`.
5. **Give it to someone:** `/parcelowner <id> 12`, or "Transfer a parcel" at
   the stone.

`/holdstone list` shows every hold with its stone, members and parcel count.
`/parcel list whiterun` and `/parcel info <id>` show parcels and their objects.

All staff commands:

```
/holdstone list | spawn <hold> | place <hold> | set <hold> <formDesc> | clear <hold>
/holdstone ranks <hold> | addrank <hold> <key> <position> <leader|member> <name> | delrank <hold> <key>
/holdrank <hold> <player#> <rank|none>
/parcel list <hold> | info <id> | create <hold> <name> | rename <id> <name> | delete <id>
/parcel rank <id> <rank|none> | lock <id> | unlock <id> | disown <id>
/parcel add <id> <formDesc> <door|container> | remove <formDesc> | tool <id|off>
/parcelowner <id> <player#>
```

---

## The parceling tool (no commands)

1. At the holdstone, a leader (or staff) opens the menu and picks
   **Parceling tool**, entering the parcel number — or clicks **Parcel tool**
   next to the parcel in the hold panel.
2. Walk to a door or container and press **E**. Instead of opening, the menu
   shows:
   - **Add to parcel…** — adds it to the selected parcel;
   - **Remove from parcel** — if it already belongs to a parcel;
   - **Lock this side / make it an exit** — doors only (see load doors);
   - **Stop parceling tool**.
3. When done, pick **Stop parceling tool** (or `/parcel tool off`). Doors open
   normally again. The tool also turns off on logout.

An object belongs to at most one parcel. Holdstones cannot be part of a
parcel. Only doors (`DOOR`) and containers (`CONT`) can be added; anything
else answers "Only doors and containers can be part of a parcel."

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

## Players: using the holdstone

Press **E** on the holdstone and pick **Hold**. The panel shows:

- the hold and **your rank** (or that you are not a member);
- the rank ladder, lowest to highest (leader ranks are highlighted);
- the members and their ranks;
- every parcel: number, owner, who can open it, how many doors and
  containers, and whether it is **Locked** or **Open**.

Owners see **Lock / Unlock** on their own parcels. Leaders also see the
leadership forms (set a rank by player number, create a parcel) and the
**Parcel tool** button. Rename, transfer and minimum rank are in the
holdstone's E menu.

To unlock a shop for opening hours, the owner clicks **Unlock**; anyone can
then open its doors and containers until it is locked again.

---

## What to verify in game

Nothing below has been run on a live server yet. Apply the migration first
(the main session applies migrations; this branch does not touch the live
database).

1. **Boot:** the log shows `[holdstones] N holdstones, N parcels, N locked
   objects loaded.` and no errors from `activation-events`.
2. **Place a stone:** `/holdstone place whiterun`, E on an object → "[Holdstone]
   Whiterun holdstone set to …". Press E again on it → the menu shows **Hold**.
3. **Hold panel:** opens with the ladder Citizen < Guard < Steward < Jarl;
   Esc and × close it.
4. **Ranks:** `/holdrank whiterun <your#> jarl`; reopen the panel → "Your rank:
   Jarl" and the Leadership section. Set a second player to Guard from the
   panel; they get "[Hold] … is now Guard of Whiterun."
5. **Parcel + tool:** create "Test House" with minimum rank `guard`; start the
   tool; E on the house's front door → the parcel menu opens (the door does
   not). Add it. Check the message says whether the inside door was added as
   an exit. Add a chest inside. Stop the tool.
6. **Locks:** a player with no rank presses E on the front door → "It's
   locked." and the door stays shut; on the chest → "It's locked." and no
   container menu. The Guard opens both. Staff opens both. The owner (after
   **Transfer**) opens both.
7. **Exit side:** the rankless player, if teleported inside, can still leave
   through the inside door.
8. **Unlock:** the owner clicks Unlock → the rankless player can open the door;
   Lock again → blocked.
9. **Restart persistence:** after a server restart the locks still apply (the
   index is rebuilt from the database on boot).

Unverified assumptions to watch:

- Reading the other side of a load door from the `XTEL` field of
  `mp.lookupEspmRecordById` (format of `fields[].data` and
  `toGlobalRecordId`). If it never finds the partner, add inside doors by hand.
- `mp.get(ref, 'baseDesc')` returning the base record for world doors and
  containers (used to tell doors from containers).
- Blocking a container through `mp.onActivate` stops the container menu from
  opening, the same way it stops doors.
- NPC activations are never blocked (only characters are checked).
