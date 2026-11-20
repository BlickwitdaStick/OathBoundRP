-- =============================================================================
-- Migration v30 - Keybinds por conta
-- Aplicar apos migration-v29-public-work.sql.
--
-- Guarda as teclas que cada conta escolheu na aba Controls do painel (F2):
-- abrir o painel, push-to-talk, ciclar modo de voz, mutar. Uma linha por conta;
-- sem linha = defaults de skymp/gamemode/core/keybinds.js. `bindings_json` e um
-- objeto { "<acao>": <DxScanCode> | null } validado pelo servidor antes de
-- gravar (validateBindings) e relido de forma tolerante (resolveStoredBindings).
-- =============================================================================
USE `skymp_rp`;

CREATE TABLE IF NOT EXISTS `account_keybinds` (
  `account_id` INT NOT NULL,
  `bindings_json` VARCHAR(2000) NOT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`account_id`),
  CONSTRAINT `fk_account_keybinds_account` FOREIGN KEY (`account_id`) REFERENCES `accounts` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
