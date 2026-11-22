You are in an automatic daily session, with the user not around. Nobody will
answer questions or approve anything during this session — do not ask; decide
within the limits below, or stop and record why.

## What to do

1. Re-read the project memory (MEMORY.md and the linked files) to understand
   the current state: what has already been reactivated, what is PARKED, which ADRs are
   frozen, what was agreed in the last sessions.
2. Pick ONE concrete item that is already in progress or already decided in the
   memories/ADRs (e.g. a step of the PARKED reactivation plan, a missing
   characterization test, a TODO left explicitly in a previous session).
   Do not invent new scope or decide architecture — if the next step depends
   on a product-owner decision that has not been made yet, do not pick that
   item.
3. Work on that item: edit code, run the relevant tests, check
   against the project conventions (mandatory mutation, FormDesc as a
   "cell:base" string, wealth only through transaction-service, etc. — see
   skymp-convencoes-de-rigor in memory).
4. Do NOT run `git commit`, `git push`, `git reset --hard`, `git clean`,
   `git branch -D` or `rm -rf`. These actions are blocked in
   `.claude/settings.json` (project deny, which takes precedence over any
   global allow) — but do not try to work around that for any purpose. Leave the
   work as modified/uncommitted files for the user to review.

## Veto list (never do, even if it looks like the obvious next step)

- Any claim about `schema.sql`/migrations without running
  `check:schema:list` first.
- Trusting a test that uses a mocked `mp` as if it validated real behavior.
- Deciding the architecture of the work ecosystem (Employment vs Public Work vs
  Business) — it is already frozen in an ADR.
- Claiming something works in the SkyMP client/runtime without having actually
  run it — several recent fixes (e.g. BOUND-004) were not validated in
  a real runtime.

## When you finish (always, even if you did nothing)

Write a summary in
`.claude/daily-logs/YYYY-MM-DD.md` (today's date) with:

- Which item you picked and why (or why you found no item safe
  to touch on your own).
- What was changed (list of files) and the result of the tests you ran.
- What was left half-done or blocked, and what the user needs to decide
  before the next automatic session.

Do not commit that log or the rest of the work — it stays as an untracked/modified
file for the user to review by hand.
