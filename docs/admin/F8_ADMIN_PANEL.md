# F8 admin panel

An in-game panel for staff, opened with **F8** (rebindable in F2 → Controls,
action "Open admin panel"). It is a faster way to use powers staff already
have; it does not add new ones, except `spawn_npc` (see Permissions).

- Server: `skymp/gamemode/admin-panel-service.js` (+ `admin-service.js` for
  the staff actions, `core/plugin-record-index.js` for item/NPC search).
- Page: `skymp/ui/admin-panel.js`, `skymp/ui/admin-panel.css`, markup in
  `skymp/ui/index.html` (`#admin-panel`).
- Flag: `ENABLE_ADMIN_PANEL` — **on when unset**; set it to `false` to switch
  the panel off. F8 itself also needs `ENABLE_PLAYER_SHORTCUTS=true` (the key
  handler lives there). Without it, staff can type `/adminpanel` (or `/f8`).
- No database change: no migration needed.

## Who can open it

Only accounts with a row in `staff_roles` (moderator, admin, owner). The
server tells each client whether its player is staff (`staff` in the
`playerShortcuts` property); the game-side key handler opens the panel only
when that is true, so **a player pressing F8 gets nothing**. If someone sends
`admin:*` events by hand, the server answers "Staff only." and does nothing.

Every action is checked again on the server with `hasPermission`. The page
hides buttons a role cannot use, as a courtesy only.

## Tabs

### Characters
- Lists **every** character, online and offline: `#number`, name, account
  (Discord name + account id), character id, status, Online chip. Retired
  characters are hidden unless "Show retired" is ticked. First 100 rows;
  narrow with the search box.
- Search: text matches the character name or the account's Discord name; a
  number matches `#number`, character id or account id.
- **Retire** (admin/owner, `retire_character`): asks for a reason (required,
  shown to the player if online). Works for offline characters too:
  status → `retired` (never deleted), `#number` released, `audit_logs` line
  `staff:retireCharacter` with `online=yes|no via=f8`, moderation log
  notification, and a kick after 3 s if the player is online. Retiring an
  already retired character is refused (no second audit line).

### Spawn items
- Searches the item records of the plugins the server loaded (weapons, armor,
  misc, potions/food, ammo, books, ingredients, keys, soul gems, scrolls,
  torches), by name, editor id or FormID (`0x00012eb7`). Filter by type with
  the category buttons (buttons, not a dropdown: the in-game browser does not
  draw dropdown popups). Results come 50 per page; Previous/Next above the
  list page through all of them ("51–100 of 4,860"). Creatures page the same way.
- The index is built from the plugin files in `server-settings.json`
  (`dataDir` + `loadOrder`) the first time the panel opens (≈0.3 s for this
  server's 34 plugins, ~19 000 records) and cached until restart. Names in
  localized plugins come from `mp.getLocalizedString`.
- **Give** N (1–1000) to yourself (leave "to" empty or type `me`) or to a
  player by number (`12` or `#12`). Goes through `giveItemAdmin`: needs
  `add_item` (admin/owner), checks the FormID is an inventory item, writes
  the item ledger and `staff:addItem`.
- If the plugins cannot be read, the tab says so and still accepts a FormID.

### Spawn creatures
- Searches NPC/creature records (`NPC_`) the same way.
- **Spawn** places one ~150 units in front of you, facing you
  (`mp.place` + `locationalData`). Needs `spawn_npc` (admin/owner). Audited as
  `staff:spawnNpc` with base id, new form id, cell and position.
- **Remove** (listed under "Spawned from this panel") destroys a creature
  spawned from the panel (`mp.destroyActor`), audited as `staff:despawnNpc`.
  At most 50 live panel spawns. The list is in memory: after a server
  restart the panel no longer knows them.
- **Unavailable while NPCs are off.** SkyMP treats a missing `npcEnabled` in
  `server-settings.json` as false; this server currently has none, so the tab
  shows "NPCs are disabled on this server…" and Spawn is disabled. It turns
  on by itself once `npcEnabled: true` is set (the separate NPC-spawn work).

### Players
- Everyone online, by `#number`, with their staff role if any.
- **Go to** / **Bring here** (`teleport`, moderator+): audited
  `staff:teleport` / `staff:bring`; the brought player gets a notice.
- **Set gold** (`set_gold`, admin/owner): through the gold ledger,
  `staff:setGold`.
- **Kick** (`kick`, moderator+): reason required, shown to the player,
  `staff:kick` + moderation log.

## Permissions

| Action | Permission | moderator | admin | owner |
|---|---|:-:|:-:|:-:|
| Open panel, list characters/players | any staff role | ✅ | ✅ | ✅ |
| Retire character (online/offline) | `retire_character` | ❌ | ✅ | ✅ |
| Search/give items | `add_item` | ❌ | ✅ | ✅ |
| Search/spawn/remove creatures | `spawn_npc` (new) | ❌ | ✅ | ✅ |
| Go to / bring here | `teleport` | ✅ | ✅ | ✅ |
| Set gold | `set_gold` | ❌ | ✅ | ✅ |
| Kick | `kick` | ✅ | ✅ | ✅ |

`spawn_npc` is new (in `ROLE_PERMISSIONS`, admin and owner). The permission
matrix in `permissions.behavior.test.js` now covers `bringPlayer` and
`retireCharacterById`.

## Tests

- `admin-panel-service.test.js`: non-staff get nothing; per-role refusals on
  the server; offline and online retire; item search + FormID fallback; give
  by number; number targeting for every player action; spawn availability,
  position, record-type check, audit, removal, cap.
- `core/plugin-record-index.test.js`: synthetic plugins (masters → global ids,
  overrides, compressed records, localized names, skipped groups) and search.
- `core/player-shortcuts-service.test.js`: F8 opens only for staff;
  `admin:close` returns focus to the game.
- `core/keybinds.test.js`, `ui/keybinds.test.js`: `admin.open` = F8 (66).
- `ui/index.test.js`: markup, styles, script order, F8 dispatch.

The parser was also run read-only against this server's real plugins
(~19 000 records in 0.3 s, no errors). The page was checked in a browser with fake
server data. **Nothing here has run inside the game yet.**

## What to verify in game

1. As a non-staff player: F8 does nothing (no panel, no focus change).
2. As staff: F8 opens the panel with your role in the header; F8 or Esc closes
   it and the mouse/keyboard go back to the game.
3. Controls tab (F2) shows "Open admin panel — F8"; rebinding it works.
4. Characters: offline characters appear; search by name and by `#number`;
   retire an **offline** test character with a reason → row disappears,
   `characters.status='retired'`, `char_number` NULL, `audit_logs` has
   `staff:retireCharacter ... online=no via=f8`.
5. Retire an online test character → they see the reason and are kicked ~3 s
   later.
6. Items: first open says the plugins are being read, then "iron sword"
   finds Iron Sword with its real (localized) name; give 5 to yourself and to
   a player `#n`; check the inventory and `staff:addItem`.
7. Creatures: with `npcEnabled` unset/false the tab shows the "NPCs are
   disabled" notice and Spawn is greyed out. After NPCs are enabled: spawn a
   wolf, it appears in front of you; Remove makes it disappear.
8. Players: go to / bring here move the right person; set gold changes the
   balance; kick needs a reason.
9. A moderator sees Characters/Players, but no Retire button, and the Items
   and Creatures tabs say their role cannot use them.
