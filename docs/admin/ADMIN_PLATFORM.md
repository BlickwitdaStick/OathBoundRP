# SkyMP Heavy RP — Control Panel

**Status:** design accepted, implementation not started
**Evidence:** [`ADMIN_PLATFORM_AUDIT.md`](../research/ADMIN_PLATFORM_AUDIT.md)
**Permissions:** [`RBAC.md`](RBAC.md) · **Moderation:** [`MODERATION_WORKFLOW.md`](MODERATION_WORKFLOW.md)
**Relationship to `docs/skyadmin/`:** that directory is the previous plan and remains
valid as intent. This document is the slice that the audit confirmed to be
buildable, and where the two diverge, this one wins (see audit §7).

---

## 1. What we are building, and what we are not

The target is the conceptual equivalent of a **txAdmin + Heavy RP staff panel**,
native to this architecture. It is not a port: half of what txAdmin does depends on
a server console that SkyMP does not have.

**It is not:**

- an SQL client with a pretty interface — no screen edits a table directly;
- a remote terminal — no route executes a shell;
- a second product — it evolves inside `apps/web`, skyadmin decision SA-001.

---

## 2. Modules and what unlocks them

Sidebar order. The **Blocker** column is the only one that matters for
planning: it says what needs to exist first.

| Module | Content | Blocker |
|---|---|---|
| **Dashboard** | counters, whitelist queue, latest actions, service health | — partially ready |
| **Players** | accounts, profile, session history, moderation | RBAC |
| **Characters** | sheet, inventory, assets, notes, retirement | RBAC |
| **Moderation** | cases, warns, bans, appeals | RBAC + case and ban tables |
| **Whitelist** | queue with 5 states, assessment, reviewer | RBAC (the rest exists) |
| **Staff** | team, roles, permissions, temporary grants | RBAC |
| **Economy** | ledger, transaction search, adjustment, freeze | RBAC |
| **Factions** | factions, members, treasury | RBAC |
| **Properties** | properties and guests | RBAC |
| **World** | fauna census, corpse probe, safe zones | RBAC + **game bridge** |
| **Server** | maintenance, announcement, capacity, queue | RBAC + **game bridge** |
| **Modules** | state of the registry modules | RBAC + **game bridge** |
| **Logs** | filtered audit; separate security tab | RBAC + `audit_logs` v2 |
| **Developer** | health, versions, manifest, schema drift, crash reports | RBAC |

Three modules — World, Server, Modules — depend on a piece that **does not exist**:
a channel between the panel and the game server process. See §5.

---

## 3. Phases

Each phase can be delivered on its own. None depends on an in-game session, except phase 4.

| Phase | Deliverable | Closes |
|---|---|---|
| **1 — Foundation** | RBAC migration, `requirePermission` on every route, denial auditing, MariaDB session, CSRF, helmet/CSP | findings 4.1, 4.3, 4.5, 4.6, 4.9, 4.10 |
| **2 — Read operations** | Players, Characters, Whitelist with 5 states, filtered Logs, Staff | gives staff a usable panel without any risky action |
| **3 — Persistent moderation** | cases, warns, ban with reason/duration/session revocation, Economy admin, Inventory admin | findings 4.2, 4.4, 4.7 |
| **4 — Game bridge** | live sessions, kick from the panel, announcement, maintenance | finding 4.8 — requires a new protocol **and** a real session |
| **5 — Deferred** | World tools, Reports, Modules toggle | depends on 4 and on observed demand |

Phase 1 delivers no new screen. This is deliberate: today anyone in
`staff_roles` can read everyone's criminal record and Discord ID, and building screens
before closing that increases the surface of the problem.

---

## 4. Flow of an action

```
Browser
  └─► Admin API (apps/web)
        ├─ 1. session           → 401 if absent
        ├─ 2. RBAC              → 403 if permission missing  → AUDITS the denial
        ├─ 3. validation        → 400; rejects unknown fields
        ├─ 4. idempotency       → a repeat returns the same result
        └─► Service (single transaction)
              ├─ mutates the domain
              ├─ writes audit_logs (before/after, permission, request_id)
              └─ enqueues the external effect, when there is one
                    └─► Game server, via authenticated channel   [PHASE 4]
```

Rules that cut across every phase:

1. **The UI never talks to the database.** Not even for reads.
2. **The domain mutation and the audit row are the same transaction.** An audit
   that can fail on its own is not an audit.
3. **Money and items go through the services that already exist** — `transaction-service`
   and nothing else. The panel is just another caller.
4. **Every 🟡/🔴 action requires a non-empty `reason`**, validated on the server.
5. **One idempotency key per user attempt.** A double click does not create two
   bans, and no network `retry` creates two gold adjustments.

---

## 5. Actions on a connected player — the real ceiling

Audit §4.8 measured what the `mp` API offers. The summary that decides the scope:

| Action | Viable? | How |
|---|---|---|
| **kick** | ✅ | `mp.kick` is already used by `admin-service` and by `connection-monitor` |
| **teleport** | ✅ | `mp.set(actorId, 'locationalData')`, already used |
| **announce** | ✅ | `commands.sendNotification` in a sweep |
| **offline account ban** | ✅ | a database write; enforcement already exists at two points |
| **online account ban** | ⚠️ | needs a kick — therefore, needs the bridge |
| **warn** | ⚠️ | persists today; in-game delivery needs the bridge |
| **freeze** | ❌ | does not exist; would require Papyrus + observation in a real session |
| **spectate** | ❌ | does not exist |
| **mute** | ❌ | does not exist; `voip-service` would have to expose a per-actor cutoff |
| **ping** | ❌ | **the `mp` API does not expose latency.** There will be no ping column |

The panel **will not list an action that does not work**. A grayed-out button saying "coming soon"
is better than a button that answers `ok` with no effect — and the audit found a
permission (`ban`) that has existed for months in exactly that state.

### 5.1 Active sessions panel

Data per session, and only this:

| Field | Source | Available? |
|---|---|---|
| account | `game_sessions.account_id` | ✅ |
| character | `commands.getActiveCharacterData(actorId)` | only inside the gamemode |
| Discord | `discord_identities` | ✅ |
| `connectedAt` | `game-api` queue (`markConnected`) | ✅ in memory |
| cell | `mp.get(actorId, 'locationalData').cellOrWorldDesc` | only inside the gamemode |
| character state | `core/character-state` | only inside the gamemode |
| ping | — | ❌ does not exist |

**Deliberately outside the panel:** IP, raw `actorId` for a role without
`players.session.view`, and any character identity that the anonymity system
protects. Revealing a real name remains `identity.reveal`, an audited
act — a session list that showed the real name for free would bypass
that control from the outside, which is the defect that `admin-service.js` spent thirty
lines avoiding from the inside.

**No aggressive polling.** The gamemode already pays for 2 s polling to discover
connections. The panel receives a snapshot pushed at a fixed interval, or queries
on demand when the tab is open. The panel never becomes a second load on
the server loop.

### 5.2 The channel, when it exists

Recommended design, inherited from skyadmin decision SA-007 and from the
GameAP/Wings patterns: **the game process opens the outbound connection** to the panel,
authenticated, and receives only commands from a closed catalog. The panel never
opens a port on the game host.

Reasons: the host is Windows, often behind NAT; a command port
exposed on the game server is the worst possible surface; and a closed catalog
makes "payload became a command" not even expressible.

This is still **not designed in detail** — protocol, authentication,
reconnection and execution confirmation are work for a dedicated session, and it only
makes sense after Phase 0 has had a real session with a connected player.

---

## 6. Server control and feature flags

### 6.1 What can be done safely

| Capability | How it works today | Can the panel do it? |
|---|---|---|
| Capacity / queue | `QUEUE_CAPACITY` in the `game-api` `.env`, read at boot | read yes; write requires a new internal endpoint |
| Maintenance mode | does not exist | buildable: a flag the queue checks before admitting |
| Announcement | does not exist | buildable in Phase 4 |
| Module state | `ENABLE_*` in `.env`, read when the gamemode **loads** | read yes; **hot toggle no** |
| Gameplay options | `server-options.<env>.json`, validated at boot | read yes; hot write no |
| **Process restart** | `launch_server.bat` by hand | **no** |

**`server.restart` is out.** There is no supervisor, no player
draining, no rollback if the process does not come back. A button that takes down the
server without any of that is the definition of an irreversible action without warning, which
`CONSTITUICAO.md` §5 forbids. The trigger to reopen it is infrastructure: a supervisor
that guarantees the process comes back, draining with warning, and a restore test
rehearsed in staging.

**Hot `modules.toggle` is out for now.** `core/module-registry` decides
on/off from `process.env` at load time, and `server-options.js` validates at
boot and aborts on an invalid value — on purpose. Toggling a module in game
would mean `shutdown()` in the middle of a session with players inside, and no
module was written assuming that. The panel **displays** the state; changing it remains
`.env` + a planned restart.

### 6.2 Flags: allowlist, never arbitrary environment

If and when the panel writes configuration, the rule that
`core/server-options.js` already applies to the options file holds:

1. **Explicit allowlist.** Only flags that are in a list in the code, with type,
   range and who consumes them, are allowed. There is no "edit environment variable".
2. **Only what does something gets in.** `server-options.js` keeps
   `DECLARED_BUT_UNWIRED` with 18 options precisely because configuration that
   *looks like* it exists and does nothing is worse than absent configuration. The panel inherits
   this discipline: a flag with no consumer shows up marked as inert, or does not show up.
3. **A flag change is an audited action**, with before/after, like any other.
4. **Nothing that is a secret.** `INTERNAL_API_SECRET`, `SESSION_SECRET`,
   `MASTER_KEY`, database credentials and the Discord token are never readable or
   editable through the panel, for any role.

---

## 7. Risk and UI

Three levels, with distinct visual treatment — 🟢 read, 🟡 mutates recoverable
state, 🔴 irreversible or high impact. The level comes from
`staff_permission_catalog.risk`, the same data the RBAC uses, so that UI and
authorization cannot disagree.

A 🔴 action — **ban, permakill, gold adjustment, item removal, account
freeze, identity reveal, role change** — requires, without exception:

1. color and position distinct from common actions; never adjacent to a 🟢 button;
2. a dialog that **names the target** and describes the consequence in one sentence
   ("This character will no longer be able to join the server");
3. a mandatory reason field, with a real minimum, also validated on the server;
4. when there is an undo, say what it is; when there is none, say so.

Interface priorities, in order: **clarity · speed · few clicks ·
explicit risk**. Where the last two conflict, risk wins — one extra click
before a permakill is the cheapest click in the system.

---

## 8. Report queue — preparation, not construction

`player report`, `bug report`, `RP report` and `staff ticket` share a shape:
someone opens it, someone triages, someone resolves, everything is recorded. It is the same
format as moderation cases ([`MODERATION_WORKFLOW.md`](MODERATION_WORKFLOW.md) §2).

**Do not build it now.** A report queue without staff to handle it is worse than
having no queue: it creates an expectation of a response that nobody fulfills. The trigger is
operational, not technical — when there is staff at scale and reports arriving
through Discord in a way that no longer fits, the queue is born reusing the case
model, and the Discord integration comes after that, never before.

Recorded here so that whoever builds the cases leaves the model able to receive
`source` (`staff`, `player_report`, `bug`) without a new migration.

---

## 9. World tools — the limit that is already known

`fauna-census` and `corpse-probe` exist and are authorized by `world.probe`. They
are **on-demand observation** instruments, and they stay that way.

What the panel **will not** do: stream NPCs continuously. The gamemode already
documents that Papyrus calls are expensive (`CONTRIBUTING.md` §3.8) and that
`safe-zones.js` queries position on demand instead of subscribing to cell events
precisely because of cost. A live map of every actor would invert that decision
and turn the panel into a load on the game loop — for the benefit of a screen
nobody asked for.

Entity inspection, NPC census, corpse diagnostics, safe zones and
player position come in as a **one-off, authorized and audited query**,
after the bridge from §5.2.
