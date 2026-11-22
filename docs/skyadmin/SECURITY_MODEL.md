# Security model

## Non-negotiable rules

- `offlineMode` is not allowed outside the lab.
- Session tokens and tickets are opaque; only hashes are stored in the database.
- Never log a token, cookie, `masterKey`, Discord secret or a full sensitive payload.
- Every mutating route requires a session, CSRF, authorization and input validation.
- High-impact actions require a reason and confirmation in the UI.
- The Agent does not expose a public command port; it opens an authenticated outbound connection.

## Controls by layer

| Layer | Control |
|---|---|
| Web | persistent session, secure cookies, CSRF, CSP, rate limit, Helmet |
| API | input schema, per-permission authorization, idempotency, structured logs |
| Database | FKs, indexes, migrations, transactions and least privilege for the SQL user |
| Agent | mTLS or rotating credential, command allowlist, timeout and confirmation |
| SkyMP | Master API, revocable session, whitelist by `account_id` |

## Priority threats

1. A player edits `profileId` locally to take over another account.
2. Staff without permission call an endpoint manually.
3. A repeated POST results in two bans, items or transfers.
4. A token leaked in a log, URL, crash report or frontend.
5. The browser or a user turns a payload into a command on the host.
6. An administrative session stolen via CSRF or an insecure persistent cookie.

## Checklist before a new action

- Which permission is required?
- What is the target and how is it resolved?
- Does the schema reject extra fields and invalid values?
- What is the idempotency key?
- Is there a transaction and an audit entry?
- How does the action expire, fail and get reverted?
- Does the result expose unnecessary data?
