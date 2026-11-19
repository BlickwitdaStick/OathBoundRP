# Administrative RBAC

**Status:** design accepted, implementation not started
**Formal decision:** [ADR 005](../technical/ADR_005_ADMIN_RBAC.md)
**Evidence:** [`ADMIN_PLATFORM_AUDIT.md`](../research/ADMIN_PLATFORM_AUDIT.md) §4.1–§4.6
**Rule that does not change:** `vip_level` is monetization. It never was and never will be a permission criterion.

---

## 1. The four rules

1. **Permission is the unit. A role is a grouping.** All code asks about a
   permission, never about a role. There is no `if (role === 'admin')` anywhere.
2. **The database is the authority.** The role→permission map lives in a table, not in a
   file constant. Changing who can do what is an audited row, not a deploy.
3. **Denying is the default, and denying is loud.** A missing permission denies;
   an unknown permission denies **and** shouts in the log; every denial becomes an audit
   row.
4. **No implicit inheritance.** `owner` does not "inherit" from `admin`. Each role has its
   explicit set, even if that duplicates rows. The reason is in §4.

---

## 2. Permission catalog

Dotted namespace `domain.action[.scope]`. The domain is the panel module; the
action is the verb; the scope appears only when a verb has slices with different
risk (`logs.view` vs `logs.view.security`).

**Risk** governs the UI ([§22 of the briefing](ADMIN_PLATFORM.md#7-risk-and-ui)):
🟢 read · 🟡 mutates recoverable state · 🔴 irreversible or high impact.

### 2.1 Players and sessions

| Permission | Risk | What it authorizes | Exists today? |
|---|---|---|---|
| `players.view` | 🟢 | list accounts, view profile, session history | panel: no gate |
| `players.session.view` | 🟢 | see who is connected right now | **blocked** — audit §4.8 |
| `players.kick` | 🟡 | kick from the current session | game: `kick` ✅ · panel: ❌ |
| `players.warn` | 🟡 | record a formal warning | ❌ does not exist |
| `players.mute` | 🟡 | silence chat/voice | ❌ does not exist in game |
| `players.ban` | 🔴 | ban an account (temporary or permanent) | permission declared, **nothing implements it** |
| `players.unban` | 🔴 | revoke a ban | ❌ |
| `players.teleport` | 🟡 | teleport to a player | game: `teleport` ✅ |

### 2.2 Characters

| Permission | Risk | What it authorizes | Exists today? |
|---|---|---|---|
| `characters.view` | 🟢 | sheet, biography, history | panel: no gate |
| `characters.edit` | 🟡 | correct sheet fields | ❌ |
| `characters.rename` | 🟡 | rename (recording the previous name) | ❌ |
| `characters.notes` | 🟡 | staff notes on the character | ❌ |
| `characters.retire` | 🔴 | retire (`status='retired'`) | game: `retire_character` ✅ |
| `characters.permakill` | 🔴 | permanent death | same command as above |
| `characters.restore` | 🔴 | revert a retirement | ❌ — see MODERATION_WORKFLOW §5 |
| `identity.reveal` | 🔴 | reveal the real name behind anonymity | game: `reveal_identity` ✅ |

`characters.retire` and `characters.permakill` are the same operation today
(`/permakill` writes `status='retired'`). They are kept separate in the catalog because
`MODERATION_WORKFLOW` §5 distinguishes administrative retirement from narrative CK,
and the distinction needs a name before it needs code.

### 2.3 Economy and inventory

| Permission | Risk | What it authorizes | Exists today? |
|---|---|---|---|
| `economy.view` | 🟢 | balances, treasuries, ranking | panel: no gate |
| `economy.ledger.search` | 🟢 | search `gold_transactions` | ❌ |
| `economy.adjust` | 🔴 | move a character's gold | game: `set_gold` ✅ |
| `economy.freeze` | 🔴 | freeze a suspicious account | ❌ |
| `inventory.view` | 🟢 | view inventory and `inventory_transactions` | ❌ |
| `inventory.trace` | 🟢 | trace an item through the ledger | ❌ |
| `inventory.grant` | 🔴 | give an item | game: `add_item` ✅ |
| `inventory.remove` | 🔴 | remove an item | ❌ |

**Inherited, non-negotiable invariant:** gold adjustments go through
`core/transaction-service`; giving and removing items go through
`transaction-service.giveItem`/`removeItem`. No panel route writes to
`characters.gold` or `character_inventory` directly. It is the rule that deleted the
old `economy-service.js` (`CONTRIBUTING.md` §3.1) and it applies equally when the
caller is the UI.

### 2.4 Whitelist, staff and world

| Permission | Risk | What it authorizes | Exists today? |
|---|---|---|---|
| `whitelist.view` | 🟢 | read the application queue | panel: no gate |
| `whitelist.review` | 🟡 | move between states, write an assessment | panel: **no gate** |
| `whitelist.approve` | 🟡 | approve (allows entry to the server) | panel: **no gate** |
| `staff.view` | 🟢 | view team and roles | ❌ |
| `staff.manage` | 🔴 | grant/revoke roles and permissions | game: `manage_staff` ✅ |
| `factions.view` / `factions.manage` | 🟢 / 🟡 | factions | view without gate · manage ❌ |
| `world.probe` | 🟡 | fauna census and corpse probe | game: `run_world_probe` ✅ |
| `crafting.recipes.manage` | 🔴 | create/edit a recipe (permanent rule) | game: `manage_recipes` ✅ |

### 2.5 Server, modules and logs

| Permission | Risk | What it authorizes | Exists today? |
|---|---|---|---|
| `server.view` | 🟢 | health, queue, version, manifest | `/health` is public today |
| `server.announce` | 🟡 | global announcement | ❌ |
| `server.maintenance` | 🔴 | maintenance mode / close entry | ❌ |
| `server.restart` | 🔴 | restart the process | **must not exist until ADMIN_PLATFORM §14** |
| `modules.view` | 🟢 | state of the registry modules | ❌ |
| `modules.toggle` | 🔴 | turn a module on/off | ❌ — today it is `ENABLE_*` in `.env` + restart |
| `logs.view` | 🟢 | administrative audit | game: `view_audit` (declared, **nothing checks it**) |
| `logs.view.security` | 🔴 | sensitive events: identity reveal, role change, denials | ❌ |

`logs.view.security` is a separate scope for a concrete reason: `audit_logs`
mixes `identity:staff_reveal` with `staff:teleport`. Whoever can see routine
movement should not see, for free, the list of who was unmasked —
`admin-service.js` spent thirty lines arguing that revealing identity is the
only staff action with no way back, and leaving its **trail** open to every role
would empty out half of that care.

### 2.6 Rename map (the 12 permissions that already exist)

The gamemode uses flat names. The migration is mechanical and **fails closed**:
`hasPermission` already refuses an unknown name with `console.error`, so a
forgotten call denies the action and shows up in the log — the safest possible
behavior for a rename.

| Current name | New name | Callers to update |
|---|---|---|
| `kick` | `players.kick` | `admin-service.js` |
| `teleport` | `players.teleport` | `admin-service.js` (×2) |
| `ban` | `players.ban` | none — **orphan** |
| `add_item` | `inventory.grant` | `admin-service.js` |
| `set_gold` | `economy.adjust` | `admin-service.js`, `economy-regional.js` |
| `retire_character` | `characters.permakill` | `admin-service.js` |
| `reveal_identity` | `identity.reveal` | `admin-service.js` |
| `run_world_probe` | `world.probe` | `fauna-census.js` (×2), `corpse-probe.js` |
| `manage_recipes` | `crafting.recipes.manage` | `crafting-service.js` (×2) |
| `manage_staff` | `staff.manage` | `governance-service.js`, `market-stalls-service.js` (×2) |
| `view_audit` | `logs.view` | none — **orphan** |
| `manage_whitelist` | `whitelist.review` | none — **orphan** |

The three orphans are not renamed: they are **decided**. `players.ban` and
`whitelist.review` get an implementation (panel); so does `logs.view`. No
permission may exist in the catalog without at least one checker — and that becomes a
test (`ADMIN_SECURITY_MATRIX` §3.1).

---

## 3. Roles

A role is an operational label and a grouping of permissions. **Nothing in the code reads the
role name to decide.**

| Role | For whom | Domains it reaches |
|---|---|---|
| `SUPERADMIN` | server owner | everything, including `staff.manage` and `server.*` |
| `ADMIN` | administration | everything except `staff.manage`, `server.restart`, `modules.toggle` |
| `MODERATOR` | front line | `players.*` up to `kick`/`warn`/`mute`, `whitelist.*`, `logs.view`, reads |
| `SUPPORT` | player support | reads + `characters.notes` + `whitelist.review`. **No in-game action** |
| `GAMEMASTER` | events and RP | `players.teleport`, `inventory.grant`, `world.probe`, reads |
| `DEVELOPER` | builders | `modules.view`, `logs.view`, `server.view`, reads. **Nothing on players** |

Two choices worth the argument:

**`GAMEMASTER` gets `inventory.grant` and does not get `economy.adjust`.** Handing
out a sword for an event is reversible and visible; moving gold touches the ledger that the
whole economy uses to balance. They are different risks and the role that runs events
needs the first, not the second.

**`DEVELOPER` does not touch players.** It is the easiest role to grant and the one most
people will have. Giving it `players.kick` because "it's useful for testing" would turn the
most granted permission into the most powerful — which is exactly the argument that
`admin-service.js` used to keep `reveal_identity` away from moderators.

The full role × permission matrix lives in the seed migration and is reproduced in
[`ADMIN_SECURITY_MATRIX.md`](../testing/ADMIN_SECURITY_MATRIX.md) §2, which is where
it is **tested**. Duplicating it here would create a second answer to the same
question.

---

## 4. Why there is no inheritance

The obvious design would be `SUPERADMIN > ADMIN > MODERATOR > SUPPORT` with inheritance.
It was rejected:

1. **The question that matters is "who can `economy.adjust`?"** With explicit
   sets it is a `SELECT`. With inheritance it is a tree traversal that needs to
   be right everywhere it is done — panel, gamemode, tests and the head of
   whoever audits.
2. **This project's roles do not form a line.** `GAMEMASTER` can
   `inventory.grant`, which `MODERATOR` cannot; `MODERATOR` can `players.kick`,
   which `GAMEMASTER` does not need. They are already a lattice, not a ladder — forcing a
   ladder would require inventing exceptions, and exceptions in inheritance are the classic defect.
3. **The cost is duplicated rows in a seed table.** Cheap, visible, and
   an integrity `CHECK` covers the rest.

Briefing §21 asks for a "role inheritance" test. The corresponding test here is the
**opposite**: verify that no role gains a permission not written for
it, even if another role "above" it has it. It is in `ADMIN_SECURITY_MATRIX` §2.2.

---

## 5. Data model

### 5.1 What changes

```sql
-- CATALOG — the closed list of permissions that exist.
CREATE TABLE staff_permission_catalog (
  permission   VARCHAR(64) PRIMARY KEY,
  risk         ENUM('read','mutate','destructive') NOT NULL,
  description  VARCHAR(256) NOT NULL
);

-- ROLES — the closed list of roles.
CREATE TABLE staff_role_definitions (
  role         VARCHAR(32) PRIMARY KEY,
  label        VARCHAR(64) NOT NULL,
  is_system    TINYINT(1) NOT NULL DEFAULT 1   -- a system role is not editable through the UI
);

-- MAP role → permission. It is the source of truth that today is ROLE_PERMISSIONS.
CREATE TABLE staff_role_permissions (
  role        VARCHAR(32) NOT NULL,
  permission  VARCHAR(64) NOT NULL,
  PRIMARY KEY (role, permission),
  CONSTRAINT fk_srp_role FOREIGN KEY (role) REFERENCES staff_role_definitions (role) ON DELETE CASCADE,
  CONSTRAINT fk_srp_perm FOREIGN KEY (permission) REFERENCES staff_permission_catalog (permission)
);

-- Per-person OVERRIDE. It exists for the rare case, and is always temporary by default.
CREATE TABLE staff_permission_overrides (
  id                    INT AUTO_INCREMENT PRIMARY KEY,
  account_id            INT NOT NULL,
  permission            VARCHAR(64) NOT NULL,
  mode                  ENUM('grant','deny') NOT NULL,
  reason                VARCHAR(256) NOT NULL,           -- mandatory
  granted_by_account_id INT NOT NULL,
  granted_at            TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at            TIMESTAMP NULL DEFAULT NULL,
  revoked_at            TIMESTAMP NULL DEFAULT NULL,
  UNIQUE KEY uq_override (account_id, permission, revoked_at),
  CONSTRAINT fk_spo_account FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE,
  CONSTRAINT fk_spo_perm    FOREIGN KEY (permission) REFERENCES staff_permission_catalog (permission)
);
```

`staff_roles` is altered, not replaced — it is the table both readers already
query:

```sql
ALTER TABLE staff_roles
  ADD COLUMN expires_at            TIMESTAMP NULL DEFAULT NULL,
  ADD COLUMN revoked_at            TIMESTAMP NULL DEFAULT NULL,
  ADD COLUMN revoked_by_account_id INT NULL DEFAULT NULL,
  ADD COLUMN revoke_reason         VARCHAR(256) NULL DEFAULT NULL,
  ADD CONSTRAINT fk_staff_role_def FOREIGN KEY (role) REFERENCES staff_role_definitions (role);
-- and, ONLY after both readers aggregate multiple rows:
--   DROP INDEX account_id;   -- the UNIQUE that prevents a simultaneous temporary role
--   ADD KEY idx_staff_account_active (account_id, revoked_at, expires_at);
```

Revoking a role becomes `revoked_at = NOW()` with a reason, **never `DELETE`** —
the same rule that `CONTRIBUTING.md` §3.7 already imposes on characters, for the same reason:
the history of who had which power and when needs to survive the revocation.

`staff_permissions` (today's empty table, whose FK points to a person's *row*
and not to the role) is **discontinued** by the migration. See
[ADR 005](../technical/ADR_005_ADMIN_RBAC.md) §3.

### 5.2 Effective resolution

```
permissions(account) =
      ∪ { staff_role_permissions[r] : r ∈ the account's active roles }
    ∪   { p : active override(account, p, 'grant') }
    ∖   { p : active override(account, p, 'deny') }
```

Active role = `revoked_at IS NULL AND (expires_at IS NULL OR expires_at > NOW())`.
**`deny` always wins.** A deny override is the way to suspend someone from
a capability without taking away the whole role — and it cannot be bypassed by adding
another role.

### 5.3 Migration order, because order matters

`SELECT role FROM staff_roles WHERE account_id = ? LIMIT 1` exists today in two
places. Dropping the `UNIQUE` before changing those two reads would make the second
role row silently ignored — the person gets half the power that
was granted and nobody sees an error.

1. Create the new tables and seed role→permission from the current `ROLE_PERMISSIONS`.
2. Change both readers to aggregate **all** active rows.
3. Only then drop the `UNIQUE(account_id)`.

---

## 6. Middleware contract (panel)

```js
// apps/web — replaces requireStaff on ALL staff routes
requirePermission('whitelist.approve')
```

Obligations, all verifiable by tests:

1. Missing session → `401`. No permission → `403`. **Never `404`** to hide
   a route's existence: staff is a known population and 404 confuses diagnosis.
2. The denial response does not say which permission was missing or which ones the account has.
   The detailed reason goes to the audit, not to the HTTP body.
3. Also checks the staff member's own `accounts.status = 'active'` (closes audit
   §4.10): a banned account loses the panel along with the game.
4. A permission outside the catalog → `500` **at route boot**, not at runtime. A
   route registered with a nonexistent permission is a programming bug and must prevent
   the server from starting, not silently deny in production.
5. Every denial writes `audit_logs` with `outcome='denied'`, the requested permission and the
   `request_id`. It is the probing signal that does not exist today.
6. Per-session permission cache with a short TTL (≤ 60 s) **and** immediate
   invalidation on any write to `staff_roles`/overrides. A revocation that takes
   a TTL to take effect is acceptable for grants; for revocation, it is not.

In the gamemode, `admin-service.hasPermission(actorId, permission)` keeps its
signature — only the origin of the `Set` changes: it now comes from the database at login, with the
same resolution as §5.2. `staffCache` remains keyed by `actorId` and is still
cleared on disconnect (`admin-service.test.js` already covers this).

**If the database is unavailable at login, the result is an empty set.** Staff
without power is a small problem; staff with power inherited from a cache nobody
can invalidate is an incident.

---

## 7. Discord

Discord **suggests**; the database **decides**. Concretely:

| Direction | Allowed? |
|---|---|
| Panel approves whitelist → bot adds a role on Discord | ✅ exists today (`/api/sync-role`) |
| Discord role → staff role in the database | ⚠️ only as a **proposal**, never automatic application |
| Discord role → in-game permission | ❌ **never** |

The suggestion path, if built, produces a row in a review queue
that a `SUPERADMIN` confirms with a reason. Nothing in `staff_roles` is born from
a webhook.

Three reasons: whoever administers the Discord server is not necessarily who
administers the game; a Discord role is editable by anyone with
`MANAGE_ROLES` there, a surface this project does not control; and a Discord
outage cannot change who can ban in game.

**Real pending item, recorded:** `apps/bot-discord/voiceChannels.js` uses the
Discord `STAFF_ROLE_ID` to authorize `/voz-criar` and `/voz-fechar`. It is the only
place where Discord is the authority over an action. The impact is low (a temporary
voice channel, no effect in game or on persistent data) and the alternative —
querying `staff_roles` on every slash command — couples the bot to the database, which today it
does not touch. It is **accepted and documented**, not fixed, with a trigger to
reopen: if a slash command starts having an effect in game or on persistent data,
it migrates to `requirePermission` via the panel before it exists.
