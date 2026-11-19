# Security review of the public services — 2026-08-24

Scope of item `F8-001`: `apps/web`, `apps/game-api`, the local API of
`apps/bot-discord` and the contracts consumed by the launcher. This round was
done without MariaDB; it covers static inspection and tests with the existing
doubles, and does not replace integrated testing in staging.

## Result of this round

| Surface | Status | Evidence |
|---|---|---|
| Rate limits | **Fixed locally** | The three services now limit both the number of buckets (10,000) and a single origin's counter. 9 tests exercise the window, adversarial cardinality and a single origin's persistence. |
| CORS and proxy | **Reviewed** | `apps/web` keeps an allowlist in `PANEL_PUBLIC_URL`. `trust proxy` is only enabled by `TRUST_PROXY=true`; `NODE_ENV=production` alone does not accept `X-Forwarded-For`. The production auditor requires the explicit setting. |
| Web session | **Partial** | Cookies are `httpOnly`, `sameSite=lax`, `secure` in production and expire after 8 h. `express-session`'s `MemoryStore` remains unsuitable for multiple instances/restarts (`F2-004`). |
| Internal secret | **Reviewed** | Game API and bot compare `X-Internal-Secret` in constant time; the auditor checks strength and equality across services. The bot API remains bound to `127.0.0.1`. |
| Inputs and uploads | **Reviewed/fixed** | JSON is capped at 512 KiB on the panel and 64 KiB on the other APIs; crash reports limit count/size, sanitize names and have retention. `discord_id` now requires a 17–20 digit decimal snowflake. |
| HTTP exposure | **Fixed** | Panel, Game API and bot do not publish `X-Powered-By`. |
| Updates | **Reviewed** | Client/modpack manifests fail closed and require SHA-256; the embedded UI is verified/repaired before playing. |
| Replay | **Pending** | Queue tickets are single-use via a conditional `UPDATE`. The Master API still accepts resolving the same `game_session` more than once (`PLAT-15`); changing this requires validating SkyMP's reconnection behavior in staging. |

## Rate limiter model and limits

The rate limiter is local to each process. This protects an instance against
memory growth and basic abuse, but does not sum traffic across replicas.
Before scaling horizontally, move the counting to the proxy/edge or to a
shared store. The bucket cap prevents memory DoS; when the cap is reached, the
oldest entry is discarded in O(1).

## Remaining work to complete F8-001

1. Replace the session `MemoryStore` with a persistent store and test restart and
   two instances (`F2-004`, depends on MariaDB/staging).
2. Exercise Master API replay and reconnection in-game before making
   `game_session` strictly single-use (`PLAT-15`).
3. Put the panel and the Game API behind real HTTPS/proxy and validate IP, cookies,
   CORS and limits end to end.
4. Run the chunked upload and retention test in staging, including a full
   filesystem and pruning concurrency.

## Automated verification

- `apps/web`: 52 tests.
- `apps/game-api`: 59 tests.
- `apps/bot-discord`: 45 tests.
- None of the tests in this round require a real MariaDB or Discord.
