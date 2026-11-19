# Implementation plan — punishment and permission

**Origin:** the [anti-cheat](ANTICHEAT.md) analysis ended at "evidence, staff judge". When checking how staff *act* on the judgment, I found that they do not: the `ban` permission is granted to admin and owner, and **nothing in the code uses it**.

**Status: PLAN. No line written.** As per [`CONSTITUICAO.md`](../CONSTITUICAO.md) §14 — document and validate architecture before code.

---

## What was verified, and how

Everything below was read in this tree, not inferred from documentation.

| Fact | How I verified it |
|---|---|
| `ban` is granted to admin and owner | `ROLE_PERMISSIONS` in `admin-service.js:71-72` |
| Nothing calls `hasPermission(…, 'ban')` | sweep of `hasPermission(` in `skymp/gamemode` + `apps/web` |
| Three permissions are dead | same sweep: `ban`, `manage_whitelist`, `view_audit` |
| The three enforcement points work | `whitelist.js:124`, `game-api/server.js:185`, `apps/web/server.js:700` |
| Nothing writes to any of them | search for `UPDATE accounts SET status` and `revoked_at =` |
| `onLoginAttempt` is typed and not wired | `types/mp.d.ts:493`, `core/skymp-adapter/index.js:86`, zero uses |
| The whitelist kicks after connecting | `whitelist.js:126` — `mp.kick(userId)` |

This confirms and details findings 4.1, 4.2 and 4.4 of the 2026-08-13 [`ADMIN_PLATFORM_AUDIT.md`](../research/ADMIN_PLATFORM_AUDIT.md), which remain open.

---

# Part I — The ban system, through the 15 points

A ban is a world mechanism with a permanent consequence for a person. It deserves the §15 gate.

**1. Goal.** Give staff a way to remove someone from the server with a reason, a duration, an author and a way to undo it — and a way for that to be audited afterwards.

**2. Problem it solves.** Today the maximum is `/kick`, and the player reconnects in five seconds. The whole rest of the moderation chain — evidence, judgment, the `cheating` category in `MODERATION_WORKFLOW` — ends with no possible consequence. **A public server without bans has no way to defend itself from a hostile person.**

**3. Problems it creates.**
- A new and strong power in staff's hands, with no accountability if it is not audited.
- A mistaken ban is the worst possible experience for a legitimate player, and the least socially reversible.
- If the ban becomes an RP event, it contaminates the world with an administrative decision.

**4. Exploits.**
- **Evasion through a new Discord account.** The ban is on the account; a new account is a new account. Real mitigation: the whitelist is the gate, and staff review it. **Imperfect, and accepted** — without collecting a machine identifier, which this project will not do (see ANTICHEAT §10).
- **Internal escalation:** an admin banning the owner. Needs an explicit rule — see §14.
- **Race:** a player in the middle of a transaction when banned. `transaction-service` is atomic, so it does not corrupt; the next action fails.
- **Ban as a weapon in a staff dispute.** Solved by auditing and by requiring a reason, not by code.

**5. Economy.** No direct impact. The banned person stops acting; gold and items stay where they are — `characters` never suffers a `DELETE`.

**6. Political.** High and **deliberately outside the world**: a ban is administration, not game politics. A Jarl does not ban; staff ban. Confusing the two is the mistake this document most wants to avoid.

**7. Military.** None. Punishment is not in-game force.

**8. Religious.** None.

**9. Social.** The most delicate point. A community accepts punishment when it is **predictable and justified**. A mandatory reason and a queryable record do more for acceptance than any technical sophistication.

**10. Technical.** Cheap: one table, one command, one route, and writes at the three points that already work. No Papyrus calls, no polling, no new load.

**11. Narrative.** **Zero, and it has to be zero.** A ban is OOC. `/permakill` is the narrative one — it ends a character, it is a story consequence. A ban removes a person. **Never mix the two.**

**12. How it generates stories.** It does not, and it should not. It protects other people's stories.

**13. How it can be abused.** §4 covers it. The defense is mandatory auditing, a mandatory reason, and the hierarchy rule.

**14. How to balance — the five rules.**

1. **Ban is for the account, `/permakill` is for the character.** Never the same command, never the same flow. One is administration, the other is story.
2. **Never `DELETE`.** Same rule as characters: the ban history survives, an unban is a new row, not a deletion.
3. **Mandatory reason**, as with `/permakill`.
4. **You do not ban equals or superiors.** An admin does not ban another admin or the owner. Without this rule, `ban` is an escalation path.
5. **Only admin and owner** — never a moderator. It is the same choice already made for `retire_character`, for the same reason: permanent removal is not a front-line decision.

**15. Integration.** `audit_logs` (the `cheating` category and the others from `MODERATION_WORKFLOW`), `accounts.status`, `game_sessions.revoked_at`, the `game-api` queue, and the panel.

---

# Part II — The four items

Ordered by dependency, not by size.

## Item 1 — Ban with a record

**Migration v29.** The next free one — the last is `v28-crafting-stations`.

> I checked this twice on purpose: an `ls | tail` sorts alphabetically and shows v9 as the last, because `v9` comes after `v25` in that order. Choosing the wrong number would create two migrations with the same name on different branches, and the conflict would only show up in the database of whoever applied both. Use `ls | sort -V`, or `npm run check:schema:list`, which sorts by number.

*(In passing: v16 and v17 are missing from the sequence. `check-schema-drift` sorts by number and handles the gap without problems, but someone should confirm they were removed on purpose.)*

```sql
CREATE TABLE IF NOT EXISTS `account_bans` (
  `id`              INT AUTO_INCREMENT PRIMARY KEY,
  `account_id`      INT NOT NULL,
  `reason`          TEXT NOT NULL,           -- mandatory, rule 3
  `banned_by`       INT NOT NULL,            -- account of whoever banned
  `banned_at`       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `expires_at`      TIMESTAMP NULL,          -- NULL = permanent
  `lifted_at`       TIMESTAMP NULL,          -- unban: a new state row, never DELETE
  `lifted_by`       INT NULL,
  `lift_reason`     TEXT NULL,
  KEY `idx_ban_conta_ativo` (`account_id`, `lifted_at`)
);
```

**The write, in one transaction.** `accounts.status` and `game_sessions` live in the same database, so it can be atomic — and the order matters:

1. `INSERT` into `account_bans`
2. `UPDATE accounts SET status='banned'`
3. `UPDATE game_sessions SET revoked_at=NOW()` for that account's active sessions

**If 2 and 3 were inverted, the player would be disconnected and reconnect** — the session dies before the gate closes. It deserves a comment in the code, because the order looks arbitrary and is not.

**Lazy expiration, no scheduler.** Login already reads `accounts.status`. When it is `banned`, one extra query to `account_bans`: if the active ban has `expires_at < NOW()`, mark it expired, return the account to `active` and let them in. It costs one query **only on the rare path** (banned account), and avoids a job that would have to run and be monitored.

**Surfaces:**
- `/ban <actorId> <duration> <reason>` and `/unban <accountId> <reason>` — same registration pattern as `/permakill` in `commands.js:450`
- A panel route, behind the `ban` permission (which Item 3 makes queryable)
- `audit_logs` in both directions

**Tests:** role matrix (a moderator **cannot**), mandatory reason, hierarchy (admin does not ban admin or owner), transaction order, lazy expiration, unban does not resurrect a revoked session.

## Item 2 — Refuse at the handshake (`mp.onLoginAttempt`)

Today: connects, runs a code path, receives a `profileId`, **then** gets `mp.kick`. A banned person enters the process before being expelled.

`mp.onLoginAttempt(profileId) → boolean` is already typed (`mp.d.ts:493`) and documented in the adapter (`skymp-adapter/index.js:86`). It just needs to be wired.

**Safety rule for the change: add, do not replace.** The hook comes in as an additional gate; the whitelist's `mp.kick` **remains**, via the adapter's capability detection. If the hook does not exist in the deployed build, nothing regresses. Only after Phase 0 confirms it do we evaluate removing the old path.

It is the same discipline as `death-service`, where polling stayed as a safety net until `mp.onDeath` was confirmed in game.

## Item 3 — One source of permission for both sides

**Root cause** of two of the three dead permissions: `ROLE_PERMISSIONS` lives in `admin-service.js` (gamemode) and the panel uses a binary `requireStaff`. The granularity exists on only one side of the wall.

**Fix:** extract the matrix into a pure module — no `db`, no `mp`, no `express` — that both import. Same pattern as `core/soul.js` and `parity.mjs`: domain separated from infrastructure, testable on its own.

The panel gets `requirePermission('manage_whitelist')` in place of the generic `requireStaff`, and `view_audit` means something again.

**It does not go to the database now.** The `staff_permissions` table exists in the schema and has never been read — it would be the natural destination, and it is a good idea **later**. Doing both changes together (unify *and* move to the database) would mix a fix with an architecture migration, and if something broke you would not know which of the two did it.

## Item 4 — The test that catches dead permissions

The project has a test that catches *"the handler forgot to check"*. It has nothing that catches *"the permission is granted and nobody uses it"* — which is how `ban` survived the audit and the gamemode's 1136 tests.

**It reuses a pattern that already exists here.** `core/server-options.js` has `SPEC` (what works) and `DECLARED_BUT_UNWIRED` (what does nothing yet), and a test prevents the file from gaining a new key without someone classifying it. The same shape works for permissions:

```js
// Granted permissions that no handler checks yet.
// Leaving this list is the goal; entering it requires justification in the PR.
const CONCEDIDAS_SEM_USO = ['view_audit'];
```

The test asserts that the set of dead permissions is **exactly** this list. Each resolved item forces the list to be updated, and a new item breaks the test.

**Practical order:** write the test first, with the three current ones in the list. Item 1 removes `ban`, Item 3 removes `manage_whitelist`. `view_audit` stays declared as debt until someone wires the audit route — visible, not forgotten.

---

## Execution order

| # | Depends on | Why in this position |
|---|---|---|
| **4** | nothing | Written first, it makes the debt visible and protects the following items |
| **1** | 4 | What unblocks the whole moderation chain |
| **3** | 4 | Root cause of two dead ones; the panel starts reading the same model |
| **2** | 1 | Refusing early only makes sense once something exists that marks whom to refuse |

**Nothing here depends on Phase 0** — it is administration infrastructure, not a world mechanic. That distinguishes it from the [ANTICHEAT](ANTICHEAT.md)'s ActorValue detection, which needs a real session to calibrate a threshold.

## What is left out, and why

- **Cheat detection.** Rejected in scanner form ([ANTICHEAT](ANTICHEAT.md)); the server version waits for Phase 0.
- **Machine identifier against ban evasion.** Invasive collection, for the same reasons as ANTICHEAT §10. Evasion via a new account remains a declared limitation, with the whitelist as the gate.
- **`staff_permissions` in the database.** A good idea, after Item 3 settles.
- **IP bans.** High collateral damage (CGNAT is common in Brazil, and it takes down the player's whole household). If it ever comes in, it needs its own analysis.

## A class of bug worth looking for

`ban` survived because the check existed **in one direction only**: we tested whether the handler checks the permission, never whether the permission has a handler.

It is the same shape as the launcher's parity bug, where the check walked the server's list asking *"does the player have this?"* and never the player's list asking *"does the server know this?"*.

**Two cases are not a coincidence.** A sweep for one-directional checks elsewhere is worth doing — there are probably more.
