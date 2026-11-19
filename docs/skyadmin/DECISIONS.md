# Current architectural decisions

| ID | Decision | Reason |
|---|---|---|
| SA-001 | Evolve `apps/web`, no parallel panel | preserves login, whitelist and current context |
| SA-002 | MariaDB is the source of truth | it is already a central dependency and avoids premature infrastructure |
| SA-003 | `profileId online === accountId` | removes ambiguity between Discord and internal identity |
| SA-004 | Discord ID is not a gameplay key | it is an external identity, mutable in the product's context |
| SA-005 | Actions go through a catalog and a persistent queue | avoids a free shell, enables auditing, timeouts and safe retries |
| SA-006 | No Redis/BullMQ in the first version | a MariaDB transactional outbox covers the initial need |
| SA-007 | The Agent opens an outbound connection | reduces network surface and allows a Windows host behind NAT |
| SA-008 | Simple SQL RBAC before Casbin/Cerbos | lower operational cost and full transparency of permissions |

## Pending decisions

- Choose the definitive migrations runner after a pilot with MariaDB.
- Define ban duration and scope.
- Define the Agent's authentication protocol (mTLS or an initial rotating credential).
- Define the policy for multiple characters per account.
- Validate PKCE in the launcher's OAuth flow before changing production.
