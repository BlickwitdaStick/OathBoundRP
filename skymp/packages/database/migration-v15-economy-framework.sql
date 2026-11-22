-- =============================================================================
-- Migration v15 - Economy Framework: counterparty in the gold ledger, escrow,
--                 contracts and debt
--
-- Apply after migration-v14-inventory-framework.sql.
--
-- Decision: docs/technical/ADR_004_ECONOMY_ACCOUNTS_AND_LEDGER.md
-- Evidence: docs/research/ECONOMY_FRAMEWORK_AUDIT.md
--
-- What this migration does, in one sentence: it gives the GOLD ledger exactly the
-- design v14 gave the ITEM ledger, and creates the three tables that escrow,
-- contracts and debt need in order to exist.
--
-- What it does NOT do: it does not move balances, does not create an `accounts` table with `balance`,
-- does not touch `characters.gold` nor the `treasury` columns. An account is still
-- a REFERENCE `(owner_type, owner_ref)` that `core/economy-service.js`
-- resolves — see ADR 004 §2.1 and the rejected alternative §4.1.
--
-- ⚠️ `MODIFY COLUMN` is not recognized by scripts/check-schema-drift.js (the
-- same warning as v14). The nullability change of `gold_transactions.
-- character_id` below does NOT show up as drift if someone forgets to apply
-- this migration; the symptom will be a treasury ledger INSERT failing at
-- runtime with "Column 'character_id' cannot be null". Check by hand:
--     SHOW COLUMNS FROM gold_transactions LIKE 'character_id';
--
-- Historical note: writing this migration exposed a second defect in the same
-- checker — it delimited the body of an `ALTER TABLE` at the FIRST `;` in the
-- text, unaware that strings exist, so the three `ADD INDEX` clauses below
-- vanished from the expected declaration because of the `;` in the `character_id` COMMENT.
-- Silently, with the command exiting with code 0. The parser was fixed
-- (`instrucoesSql`), and the two COMMENTs with semicolons were kept here on
-- purpose: they are the regression `check-schema-drift.test.js` verifies.
-- =============================================================================
USE `skymp_rp`;

-- -----------------------------------------------------------------------------
-- 1. The gold ledger now names both sides
--
-- Audit finding 1: a stall purchase records `-100` on the buyer and
-- `+95` on the seller, and NOTHING links the two rows. Rebuilding "who paid whom"
-- required guessing from `reason` + closeness of `created_at`, or walking the
-- `idempotency_key` prefix, which is a string convention and not a relation.
--
-- The columns are the same as in v14, with the same names and the same semantics, on
-- purpose: whoever learned to read `inventory_transactions` can already read this one.
--
-- `character_id` stays filled in when the holder is a character — no existing
-- query changes behavior, and `idx_gold_tx_char_date` keeps
-- serving the player's statement. It is NULL when the holder is a city,
-- Hold, faction, escrow or `system`.
-- -----------------------------------------------------------------------------
ALTER TABLE `gold_transactions`
  MODIFY COLUMN `character_id` INT NULL
    COMMENT 'Set when owner_type = character; NULL for the other holders';

ALTER TABLE `gold_transactions`
  ADD COLUMN IF NOT EXISTS `owner_type` VARCHAR(16) NOT NULL DEFAULT 'character'
    COMMENT 'character, city, hold, faction, realm, escrow, system'
    AFTER `character_id`,
  ADD COLUMN IF NOT EXISTS `owner_ref` VARCHAR(64) NOT NULL DEFAULT '0'
    COMMENT 'Holder identifier within the type (characters.id, cities.id, escrow_id, system label)'
    AFTER `owner_type`,
  ADD COLUMN IF NOT EXISTS `counterparty_type` VARCHAR(16) DEFAULT NULL
    COMMENT 'Holder type on the other side of the transfer'
    AFTER `owner_ref`,
  ADD COLUMN IF NOT EXISTS `counterparty_ref` VARCHAR(64) DEFAULT NULL
    COMMENT 'Holder identifier on the other side'
    AFTER `counterparty_type`,
  ADD COLUMN IF NOT EXISTS `transfer_id` CHAR(36) DEFAULT NULL
    COMMENT 'UUID shared by both legs of the same transfer',
  -- Who REQUESTED the movement, which is not always the holder: the guard who fined,
  -- the staff member who adjusted, the buyer who triggered the seller's stall. It was the
  -- `actor` field of briefing §5, and without it "who ordered this gold taken" only
  -- exists in `audit_logs`, which is a conceptually different database.
  ADD COLUMN IF NOT EXISTS `actor_character_id` INT DEFAULT NULL
    COMMENT 'Character that originated the movement; NULL when it was the server',
  ADD INDEX IF NOT EXISTS `idx_gold_tx_owner_date` (`owner_type`, `owner_ref`, `created_at`),
  ADD INDEX IF NOT EXISTS `idx_gold_tx_transfer` (`transfer_id`),
  ADD INDEX IF NOT EXISTS `idx_gold_tx_actor_date` (`actor_character_id`, `created_at`);

-- Backfill: everything that exists today was recorded by a path that only knew how
-- to talk about characters, so `owner_type = 'character'` and `owner_ref = character_id`
-- is the correct reading of the past, not an assumption. `counterparty_*` stays NULL on
-- purpose: that information was never recorded, and inventing it now would be
-- worse than its absence. Same reasoning as v14 §4.
UPDATE `gold_transactions`
   SET `owner_ref` = CAST(`character_id` AS CHAR)
 WHERE `owner_type` = 'character'
   AND `owner_ref` = '0'
   AND `character_id` IS NOT NULL;

-- -----------------------------------------------------------------------------
-- 2. Escrow — the missing holder
--
-- Finding 11: gold could only exist on a character or in a treasury, and neither
-- can HOLD a third party's value. Without this, "reward locked at
-- contract creation" (briefing §8) has nowhere to live.
--
-- Escrow is generic on purpose and comes before contracts: rent deposits,
-- auctions and wagers need the same mechanism. Tying it to contracts would be
-- repeating Finding 2 under another name (ADR 004 §4.3).
--
-- `balance` is what is still locked. It goes to zero when the escrow is
-- released or refunded, and the sum of the `gold_transactions` deltas for
-- (`escrow`, escrow_id) must match it.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `economy_escrow` (
  `escrow_id` CHAR(36) NOT NULL PRIMARY KEY COMMENT 'UUID v4. It is the owner_ref when owner_type = escrow',
  `purpose` VARCHAR(32) NOT NULL COMMENT 'contract, auction, rent_deposit, wager',
  `funder_type` VARCHAR(16) NOT NULL COMMENT 'Who deposited (usually character)',
  `funder_ref` VARCHAR(64) NOT NULL,
  `balance` INT NOT NULL DEFAULT 0 COMMENT 'Septims still locked. Never negative.',
  `status` VARCHAR(16) NOT NULL DEFAULT 'held' COMMENT 'held, released, refunded',
  `idempotency_key` VARCHAR(128) DEFAULT NULL COMMENT 'Creation key. Prevents a duplicate escrow for the same request',
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY `uq_economy_escrow_idempotency` (`idempotency_key`),
  KEY `idx_economy_escrow_funder` (`funder_type`, `funder_ref`, `status`),
  KEY `idx_economy_escrow_status` (`status`, `created_at`),
  CONSTRAINT `ck_economy_escrow_balance` CHECK (`balance` >= 0)
) ENGINE=InnoDB;

-- -----------------------------------------------------------------------------
-- 3. Contracts
--
-- Seven-state machine. `open` only exists with a funded escrow — the value
-- is locked on POST, not on delivery (ADR 004 §2.7). A failure at creation produces
-- NO CONTRACT, never an unpayable contract.
--
-- The escrow FK is RESTRICT: deleting an escrow with a contract pointing to it
-- is the path that leaks locked balance.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `contracts` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `creator_character_id` INT NOT NULL,
  `accepted_by_character_id` INT DEFAULT NULL,
  `title` VARCHAR(96) NOT NULL,
  `description` TEXT DEFAULT NULL,
  `category` VARCHAR(32) NOT NULL DEFAULT 'generic'
    COMMENT 'mercenary, caravan, delivery, bodyguard, crafting, mining, harvest, hunt, arcane, investigation, generic',
  `reward` INT NOT NULL COMMENT 'Septims locked in escrow at creation',
  `escrow_id` CHAR(36) NOT NULL,
  `status` VARCHAR(16) NOT NULL DEFAULT 'open'
    COMMENT 'open, accepted, delivered, settled, cancelled, expired, disputed',
  `review_until` TIMESTAMP NULL DEFAULT NULL COMMENT 'End of the review window after delivered; automatic settle afterwards',
  `expires_at` TIMESTAMP NULL DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `accepted_at` TIMESTAMP NULL DEFAULT NULL,
  `delivered_at` TIMESTAMP NULL DEFAULT NULL,
  `closed_at` TIMESTAMP NULL DEFAULT NULL COMMENT 'settled, cancelled or expired',
  UNIQUE KEY `uq_contracts_escrow` (`escrow_id`),
  KEY `idx_contracts_status_created` (`status`, `created_at`),
  KEY `idx_contracts_creator` (`creator_character_id`, `status`),
  KEY `idx_contracts_worker` (`accepted_by_character_id`, `status`),
  KEY `idx_contracts_expiry_sweep` (`status`, `expires_at`),
  CONSTRAINT `fk_contract_creator` FOREIGN KEY (`creator_character_id`) REFERENCES `characters` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_contract_worker` FOREIGN KEY (`accepted_by_character_id`) REFERENCES `characters` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_contract_escrow` FOREIGN KEY (`escrow_id`) REFERENCES `economy_escrow` (`escrow_id`) ON DELETE RESTRICT,
  CONSTRAINT `ck_contracts_reward` CHECK (`reward` > 0)
) ENGINE=InnoDB;

-- Transitions, append-only. A row here is never deleted; a contract that went back
-- to a previous state (does not happen today) would show up as two rows, not as a correction.
CREATE TABLE IF NOT EXISTS `contract_events` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `contract_id` INT NOT NULL,
  `from_status` VARCHAR(16) DEFAULT NULL COMMENT 'NULL when it is the contract creation',
  `to_status` VARCHAR(16) NOT NULL,
  `actor_character_id` INT DEFAULT NULL COMMENT 'NULL when the actor was the server sweep, not a player',
  `reason` VARCHAR(255) DEFAULT NULL,
  `idempotency_key` VARCHAR(128) DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY `uq_contract_events_idempotency` (`idempotency_key`),
  KEY `idx_contract_events_contract` (`contract_id`, `created_at`),
  CONSTRAINT `fk_contract_event_contract` FOREIGN KEY (`contract_id`) REFERENCES `contracts` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_contract_event_actor` FOREIGN KEY (`actor_character_id`) REFERENCES `characters` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB;

-- -----------------------------------------------------------------------------
-- 4. Debt
--
-- A sealed, readable record, NEVER automatic deduction (ADR 004 §4.4). The
-- server does not become a loan shark: collecting is a player role, and that is what turns
-- default into RP material instead of moderation work.
--
-- `creditor_type`/`creditor_ref` use the same holder vocabulary as the ledger,
-- because a creditor can be a character, a city (fine), a faction (guild) or a Hold.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `debts` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `debtor_character_id` INT NOT NULL,
  `creditor_type` VARCHAR(16) NOT NULL COMMENT 'character, city, hold, faction, realm',
  `creditor_ref` VARCHAR(64) NOT NULL,
  `principal` INT NOT NULL COMMENT 'Original amount. Never changes.',
  `remaining` INT NOT NULL COMMENT 'Outstanding balance. Paid down by debt_payments.',
  `reason` VARCHAR(255) NOT NULL,
  `origin_type` VARCHAR(32) NOT NULL DEFAULT 'manual' COMMENT 'fine, contract, rent, tax, manual',
  `origin_ref` VARCHAR(64) DEFAULT NULL COMMENT 'fines.id, contracts.id, ...',
  `status` VARCHAR(16) NOT NULL DEFAULT 'active' COMMENT 'active, paid, defaulted, forgiven',
  `idempotency_key` VARCHAR(128) DEFAULT NULL COMMENT 'Prevents the same event from creating two debts',
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `closed_at` TIMESTAMP NULL DEFAULT NULL,
  UNIQUE KEY `uq_debts_idempotency` (`idempotency_key`),
  KEY `idx_debts_debtor_status` (`debtor_character_id`, `status`),
  KEY `idx_debts_creditor_status` (`creditor_type`, `creditor_ref`, `status`),
  KEY `idx_debts_origin` (`origin_type`, `origin_ref`),
  CONSTRAINT `fk_debt_debtor` FOREIGN KEY (`debtor_character_id`) REFERENCES `characters` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `ck_debts_principal` CHECK (`principal` > 0),
  CONSTRAINT `ck_debts_remaining` CHECK (`remaining` >= 0 AND `remaining` <= `principal`)
) ENGINE=InnoDB;

-- Amortization. `transfer_id` ties the payment to both legs in the gold
-- ledger — that is what lets us prove the debt went down because septims changed hands,
-- and not because someone edited `remaining`.
CREATE TABLE IF NOT EXISTS `debt_payments` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `debt_id` INT NOT NULL,
  `amount` INT NOT NULL,
  `transfer_id` CHAR(36) DEFAULT NULL COMMENT 'NULL when the reduction was forgiveness instead of payment',
  `kind` VARCHAR(16) NOT NULL DEFAULT 'payment' COMMENT 'payment, forgiveness',
  `actor_character_id` INT DEFAULT NULL,
  `idempotency_key` VARCHAR(128) DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY `uq_debt_payments_idempotency` (`idempotency_key`),
  KEY `idx_debt_payments_debt` (`debt_id`, `created_at`),
  KEY `idx_debt_payments_transfer` (`transfer_id`),
  CONSTRAINT `fk_debt_payment_debt` FOREIGN KEY (`debt_id`) REFERENCES `debts` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_debt_payment_actor` FOREIGN KEY (`actor_character_id`) REFERENCES `characters` (`id`) ON DELETE SET NULL,
  CONSTRAINT `ck_debt_payments_amount` CHECK (`amount` > 0)
) ENGINE=InnoDB;

-- =============================================================================
-- END OF MIGRATION v15
-- =============================================================================
