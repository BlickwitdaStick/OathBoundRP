# Reference and study catalog

## Integrate incrementally

| Resource | Recommended use |
|---|---|
| [Ajv](https://github.com/ajv-validator/ajv) | JSON schema for action payloads |
| [dbmate](https://github.com/amacneil/dbmate) | MariaDB migrations runner, after a local pilot |
| [express-mysql-session](https://github.com/chill117/express-mysql-session) | replace `MemoryStore` in the web panel |
| [Helmet](https://github.com/helmetjs/helmet) | HTTP headers and configured CSP |
| [express-rate-limit](https://github.com/express-rate-limit/express-rate-limit) | limit login and sensitive actions |
| [Pino](https://github.com/pinojs/pino) | JSON logs with correlation |
| [Testcontainers Node](https://node.testcontainers.org/modules/mysql/) | integration tests against a real database |

## Study and adapt — do not install as a product dependency

| Reference | What to take from it |
|---|---|
| [SkyMP upstream](https://github.com/skyrim-multiplayer/skymp) | Master API contract, runtime, events and `mp` APIs |
| [txAdmin](https://github.com/citizenfx/txAdmin) | UX for player manager, notes, warns, console and scheduled restarts |
| [GameAP](https://github.com/gameap/gameap) / [Daemon](https://github.com/gameap/daemon) | outbound Agent, heartbeat, tasks and metrics; supports Windows and MariaDB |
| [Pterodactyl Wings](https://github.com/pterodactyl/wings) | control plane/agent separation and process lifecycle |
| [Casbin](https://github.com/apache/casbin-node-casbin) | RBAC/ABAC patterns; integrate only if simple SQL RBAC stops being enough |

## Security references

- [OWASP Session Management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)
- [OWASP CSRF Prevention](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html)
- [OWASP WebSocket Security](https://cheatsheetseries.owasp.org/cheatsheets/WebSocket_Security_Cheat_Sheet.html)
- [RFC 8252 — OAuth for native apps](https://www.rfc-editor.org/info/rfc8252/)
- [RFC 9700 — OAuth Security BCP](https://www.rfc-editor.org/rfc/rfc9700.html)

## Permitted reverse engineering

- Read open-source code and upstream documentation.
- Instrument our own server, launcher and database in a lab.
- Build contract tests for the Master API, login, `actorId`, session and `mp` events.
- Record commit/tag, license, hypothesis, experiment and result before adapting behavior.

## Forbidden

- Bypassing authentication, anti-cheat or controls of third-party servers.
- Distributing or copying code without checking license and attribution.
- Assuming FiveM APIs are SkyMP APIs.
