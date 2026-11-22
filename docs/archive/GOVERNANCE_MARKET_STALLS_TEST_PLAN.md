# Test Plan - Governance, Guard and Market Stalls

Date: 2026-07-13

> ⚠️ **Superseded by [FASE_0_ROTEIRO.md](../technical/FASE_0_ROTEIRO.md)** (2026-08-06). This plan covers governance and stalls; since it was written, `death-service`, `/painel`, VOIP, the session master API and the queue were added, and the gamemode grew from ~15 to more than 60 commands. Kept as a reference for the visual validation (layer 5), which the new script does not cover.

## Goal

Validate, in layers, the governance/guard and market stall systems before enabling them in real gameplay.

## Validation layers

1. Local static validation
   - Run `npm test` in `skymp/gamemode`.
   - Run `npm run test:systems` in `skymp/gamemode`.
   - Confirm that migrations, commands, permissions and environment flags are aligned.

2. Database validation
   - Apply `migration-v3-governance.sql`.
   - Apply `migration-v4-market-stalls.sql`.
   - Run `RUN_DB_CHECK=1 npm run test:systems`.
   - Confirm the governance, guard, stall, sales and license tables.

3. Server validation without visual assets
   - Turn on `ENABLE_GOVERNANCE_SERVICE=true`.
   - Turn on `ENABLE_MARKET_STALLS_SERVICE=true`.
   - Keep `skymp/config/market-stalls.visual.json` absent or with `enabled=false`.
   - Confirm boot without errors.

4. Gameplay validation with two players
   - Player A receives the guard/inspector role.
   - Player B receives a vendor license.
   - B sets up a stall, lists an item and A inspects it.
   - Player A or C buys an item from the stall.
   - Check gold, tax, stock, persistent inventory and logs.

5. Visual validation
   - Create our own plugin with an approved asset.
   - Configure `defaultStallBaseId` in `skymp/config/market-stalls.visual.json`.
   - Repeat spawn, purchase, pack-up, reconnect and late join.

## Local script

Run inside `skymp/gamemode`:

```powershell
npm run test:systems
```

With a real database:

```powershell
$env:RUN_DB_CHECK='1'
npm run test:systems
Remove-Item Env:\RUN_DB_CHECK
```

## Minimum manual checklist

- `/realmcreate skyrim Skyrim`
- `/citycreate whiterun skyrim whiterun Whiterun`
- `/govadd <actorId> city whiterun guard`
- `/guardduty on`
- `/stalllicense <actorIdVendedor> whiterun 7`
- `/stallplace Feira de Teste`
- `/stalladd <stallId> 0xf 10 5 Septims`
- `/stallitems <stallId>`
- `/stallbuy <stallId> <itemId> 2`
- `/stallinspect <stallId>`
- `/stallsuspend <stallId> teste`
- `/stallpack <stallId>`

## Acceptance criteria

- No critical action depends on data trusted from the client.
- A purchase uses a database transaction and updates gold, stock, tax and inventory atomically.
- A guard/inspector without permission cannot inspect, suspend or confiscate.
- A stall without a visual asset keeps working logically.
- A stall with a visual asset generates `visual_ref_id` and disables the object when packed up.
- A visual spawn failure does not block the economic system.

## Remaining risks

- `ObjectReference.PlaceAtMe` must be confirmed in the SkyMP runtime with the final plugin loaded.
- Visual objects need a registered permission/license before entering the modpack.
- The local test does not prove late-join synchronization or visual persistence after a restart.
