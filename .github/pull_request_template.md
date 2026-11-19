## What changes

<!-- One or two sentences. The "why" matters more than the "what" — the diff already shows the what. -->

## Services touched

<!-- Tick what you changed. It helps the reviewer know where to look. -->

- [ ] `skymp/gamemode`
- [ ] `apps/web` (panel)
- [ ] `apps/game-api` (port 7758)
- [ ] `apps/bot-discord`
- [ ] `apps/launcher`
- [ ] Schema / migrations
- [ ] Documentation only

## How you verified it

<!-- Paste the test output, or say what you ran by hand. -->

- [ ] Tests pass in the services touched
- [ ] `npm run typecheck` clean (gamemode and/or launcher)
- [ ] New test covering the new behavior

**Was this validated in game?**

- [ ] Yes, I ran it in a real session
- [ ] No — automated tests only

> If you ticked "no", that is fine: almost everything in this project is in that situation. It just matters to be explicit, because the mocked `mp` accepts anything and a green test does not prove it works in game.

## Checklist

- [ ] No secret, real `.env` or Bethesda asset in the diff
- [ ] Gold and items go through `core/transaction-service` (if applicable)
- [ ] Papyrus calls use `actorRef`/`baseRef` (if applicable)
- [ ] Documentation updated, if behavior or architecture changed
- [ ] I read [CONTRIBUTING.md](../CONTRIBUTING.md) §3 — the rules that are not obvious

## Notes for the reviewer

<!-- Any decision you made that deserves discussion? Any part you were -->
<!-- not sure about? Saying so now saves a review round. -->
