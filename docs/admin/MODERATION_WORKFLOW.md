# Moderation workflow

**Status:** design accepted, implementation not started
**Permissions:** [`RBAC.md`](RBAC.md) · **Platform:** [`ADMIN_PLATFORM.md`](ADMIN_PLATFORM.md)
**Whitelist rubric (canonical):** [`../staff/WHITELIST_RUBRIC.md`](../staff/WHITELIST_RUBRIC.md)

---

## 1. The principle

Moderation in Heavy RP is not a sequence of loose punishments. It is a **history
per person** that must answer, months later and for someone who was not
there: *what happened, who decided, based on what, and what was done.*

Today the server answers the first and third halves of that question. A
`/kick` writes `audit_logs` with the reason inside a free-text field and
sends a line to Discord. Nothing links today's kick to last week's warn
and tomorrow's ban.

The **case** is the thing that links them.

---

## 2. The case

A case is the unit of moderation. Actions live inside it.

```
Case #142
  target      Ralof Battleborn (account 87)
  type        metagaming
  status      resolved
  opened_by   moderator Sigrid          2026-08-10 21:14
  reason      "used Discord information in a scene"
  ├─ evidence   screenshot, chat log link
  ├─ action     warn      (moderator Sigrid)   2026-08-10
  ├─ action     kick      (moderator Sigrid)   2026-08-10
  └─ action     tempban   (admin Bjorn, 72 h)  2026-08-11
```

| Field | Rule |
|---|---|
| `id` | sequential; it is the number staff cite |
| `target_account_id` | the **account**, not the character — the person who acts is an account |
| `target_character_id` | optional; filled in when the case is about a character |
| `type` | closed vocabulary (see §2.1) |
| `status` | `open` · `under_review` · `resolved` · `appealed` · `overturned` |
| `reason` | mandatory on opening |
| `evidence` | attachments and links; optional, but required for `status='resolved'` in a 🔴 case |
| `opened_by_account_id` | who opened it |
| `created_at` / `resolved_at` | |

**Actions** (`moderation_actions`) reference the case and carry what is specific
to the action: type, executor, reason, duration, result, `request_id` and the corresponding
`audit_logs` row.

### 2.1 Case types

`metagaming` · `powergaming` · `rdm` (death without RP) · `ooc_conduct` (out-of-character
conduct) · `exploit` · `cheating` · `harassment` · `whitelist_fraud` ·
`other`.

A closed vocabulary, not free text, because the operational question that
justifies the field is *"how many exploit cases this month?"*. Free text does not
answer that. `other` exists and requires an explanation in `reason` — and an `other` that becomes
recurring is the signal that a type is missing.

### 2.2 Can an action exist without a case?

**Yes, and it is the normal path.** Requiring a case to be opened for a "come back
after reading the rules" kick would turn light moderation into bureaucracy, and the predictable
response would be for staff to stop recording.

The rule depends on severity:

| Action | Case required? |
|---|---|
| `warn`, `kick`, `mute` | no — but the action is always recorded and **attachable** to a case later |
| `tempban`, `ban`, `permakill`, account freeze | **yes** |

A loose action can be pulled into a case later, which is how the
history forms in practice: three loose kicks become a case when someone notices
the pattern.

---

## 3. Actions and what each one requires

| Action | Reason | Duration | Case | Effect | Exists? |
|---|---|---|---|---|---|
| `note` | — | — | no | internal note on the profile | ❌ |
| `warn` | ✅ | — | no | record + warning to the player | ❌ |
| `kick` | ✅ | — | no | ends the current session | game ✅ / panel ❌ |
| `mute` | ✅ | ✅ | no | silences chat and voice | ❌ (does not exist in game) |
| `tempban` | ✅ | ✅ | ✅ | blocks login until it expires | ❌ |
| `ban` | ✅ | — | ✅ | blocks login indefinitely | ❌ |
| `unban` | ✅ | — | ✅ | reactivates the account | ❌ |
| `permakill` | ✅ | — | ✅ | `characters.status='retired'` | game ✅ / panel ❌ |
| `account_freeze` | ✅ | — | ✅ | blocks asset movement | ❌ |

The `MODERATION_WORKFLOW` does not invent capability: the gaps above are the same ones
that the [audit §4.8](../research/ADMIN_PLATFORM_AUDIT.md) measured. `mute` and
`freeze` do not exist in the game and **do not go into the panel before they exist there**.

---

## 4. Ban — the design, because the missing half is small

Both enforcement points already exist and work:

```
whitelist.js:124      accounts.status !== 'active'  → kick
game-api isEligible   accounts.status !== 'active'  → 403 in the queue
master API            game_sessions.revoked_at IS NULL required
```

What is missing is the **writer**. A ban is a single transaction:

```sql
BEGIN;
  INSERT INTO bans (account_id, case_id, type, reason,
                    issued_by_account_id, expires_at);      -- NULL = permanent
  UPDATE accounts SET status = 'banned' WHERE id = ?;
  UPDATE game_sessions SET revoked_at = NOW()
    WHERE account_id = ? AND revoked_at IS NULL;            -- cuts off reconnection
  INSERT INTO audit_logs (...);                             -- same transaction
COMMIT;
```

After the commit, and outside it: a Discord notification (fire-and-forget, as
`moderation-log` already does) and — when the bridge exists — the kick of the online player.

**Three things this design assumes that need to be said:**

1. **Revoking the session does not expel someone who is already inside.** SkyMP queries the master
   API on connection. Until the bridge exists, a ban on an online player only takes effect at the next
   login, and the panel must say so in the confirmation instead of pretending to be immediate.
2. **`tempban` needs something that expires it.** An `expires_at` in the past does not
   reactivate the account by itself. Expiration is a periodic sweep that sets
   `accounts.status='active'` back — and it writes an audit entry itself, because an account that
   can enter again is a state change like any other.
3. **`unban` is an `INSERT`, never a `DELETE`.** The revoked ban stays in the table with
   `revoked_at`, `revoked_by` and a reason. A punishment history that disappears when
   reverted is not a history — it is the same rule as `CONTRIBUTING.md` §3.7.

---

## 5. Character: retire, kill and the restore question

Today `/permakill` writes `status='retired'` and the player needs a new whitelist
application. There is never a `DELETE`. This is right and does not change.

What needs a name — and the RBAC catalog has already separated them — are **two different
acts that today use the same command**:

| Act | What it is | Reversible? |
|---|---|---|
| `characters.retire` | administrative: sheet approved by mistake, duplicate character, player request | yes, by decision |
| `characters.permakill` | narrative: an RP consequence, definitive death in the story | **no** |

Confusing the two is costly in both directions: reverting a narrative CK destroys the
consequence the whole server exists to produce; **not** reverting an
administrative error punishes the player for a staff mistake.

### 5.1 `characters.restore` exists, and it is the most restricted permission in the catalog

It exists because administrative errors happen — the repository itself records
a case in which approving a new sheet resurrected a character that had received
`/permakill`, fixed with a `WHERE c.status='pending'`.

Rules:

1. only `SUPERADMIN`;
2. requires an open case and a reason;
3. **never** restores a character whose record says `permakill` — it restores
   `retire`. Reverting a narrative CK is not a system operation; if it is ever
   necessary, it is an explicit decision outside the panel, with the record saying so.

### 5.2 The warning the Constitution requires and the code does not yet give

Annex A.3 of `CONSTITUICAO.md` records as open: §5 forbids an irreversible choice
**without warning**, and there is no mechanism that warns the player that they
are entering irreversible territory.

This document does not solve that — it is gameplay, not moderation. But it fixes the half
that belongs to moderation: **staff are warned.** Every `permakill`, permanent
ban and identity reveal dialog names the target and declares, in one sentence, that
there is no undo.

---

## 6. Whitelist

States, replacing today's three (`pending`, `approved`, `rejected`):

```
                 ┌──────────────────┐
  application ─► │     PENDING      │
                 └────────┬─────────┘
                          │ reviewer takes it
                 ┌────────▼─────────┐
            ┌────┤  UNDER_REVIEW    ├────┐
            │    └────────┬─────────┘    │
            │             │              │
   ┌────────▼───┐  ┌──────▼──────┐  ┌────▼─────────┐
   │  APPROVED  │  │  REJECTED   │  │NEEDS_CHANGES │
   └────────────┘  └─────────────┘  └──────┬───────┘
                                           │ player resubmits
                                           └──► PENDING
```

| State | Means | Who moves it |
|---|---|---|
| `PENDING` | in the queue, no reviewer | — |
| `UNDER_REVIEW` | someone took it | `whitelist.review` |
| `NEEDS_CHANGES` | something specific is missing; assessment mandatory | `whitelist.review` |
| `APPROVED` | allows entry to the server | `whitelist.approve` |
| `REJECTED` | refused; assessment mandatory | `whitelist.review` |

Changes the new states require:

1. **`reviewed_by` becomes an `account_id`.** Today the column is
   `VARCHAR(128)` and **is never filled in** — the `PATCH` writes `reviewer_notes` and
   `reviewed_at`, and the reviewer only shows up indirectly in `audit_logs`. An FK
   to `accounts` answers "who approved?" with a `JOIN`, not with a text
   search.
2. **`UNDER_REVIEW` is what prevents two people from reviewing the same sheet.** It is the
   panel's real concurrency case: a transition is only valid if the previous state is
   the expected one, and whoever loses the race gets "another reviewer took it", not a
   lying `ok:true`.
3. **`NEEDS_CHANGES` needs resubmission.** The current rule blocks a new application
   while there is an active `pending` or `approved` one; `NEEDS_CHANGES` must allow resubmission,
   keeping the original application linked to the new one for the history.
4. **`needs_extra_review` remains a hint, not a gate.** The strong-concept heuristic
   flags the sheet for attention — it never rejects on its own. This is right
   and does not change.

---

## 7. Appeal

An appeal is a **case transition**, not a new entity:
`resolved → appealed → (overturned | resolved)`.

| Rule | Reason |
|---|---|
| Whoever executed the action does not judge their own appeal | the conflict is obvious and the system must prevent it, not rely on discipline |
| `overturned` requires a reason and deletes nothing | the original action stays in the history with the outcome recorded alongside it |
| `overturned` of a ban triggers `unban`; of `retire`, allows `restore`; of `permakill`, **triggers nothing automatically** | §5.1 |

The intake channel (Discord, form, ticket) remains open — see
[`ADMIN_PLATFORM.md`](ADMIN_PLATFORM.md#8-report-queue--preparation-not-construction).

---

## 8. Auditing: what every action records

Against the requested list, with what changes in `audit_logs` ([audit §4.7](../research/ADMIN_PLATFORM_AUDIT.md)):

| Field | Today | After |
|---|---|---|
| `actor_account_id` | ✅ | ✅ |
| `action` | ✅ | ✅ |
| `target_account_id` | ✅ | ✅ + `target_character_id` |
| `permission` | ❌ | ✅ — the permission that authorized it |
| `reason` | inside `details` | ✅ its own column |
| `before` / `after` | only `setGold`, as text | ✅ JSON, on the fields that changed |
| `request_id` | ❌ | ✅ |
| `outcome` | ❌ | ✅ `allowed` · `denied` · `failed` |
| `created_at` | ✅ | ✅ |
| `case_id` | ❌ | ✅ when there is one |

**Denial is audited.** Today it is not: `sendDenied()` warns the player and writes
nothing; the panel's `403` writes nothing. Without this, "someone is testing
permissions they do not have" is invisible — and that is the signal you want to see before the
incident.

**Nobody deletes `audit_logs` through the panel.** There is no destructive write route
on the table and there will not be one. The real protection, however, is at the database: today a
single SQL user serves the panel, `game-api` and the gamemode, with full DML. Closing
that — a user with `INSERT`/`SELECT` and without `DELETE`/`UPDATE` on `audit_logs` — is
an item of the [`ADMIN_SECURITY_MATRIX`](../testing/ADMIN_SECURITY_MATRIX.md) §5, and it is the
difference between "there is no path" and "it is not possible".

---

## 9. Discord

Discord remains a **notification**, never a record. `moderation-log` is not
awaited, swallows errors and can neither delay nor undo a decision already recorded.
The same applies to cases, bans, appeals and whitelist.

What changes: the event starts citing the case number, so that the line in the channel
is actionable — which is the same reason `nomeParaLog` already includes the
`actorId` in hexadecimal next to the name.
