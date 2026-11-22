-- v24 — Maker's Mark (docs/design/MAKERS_MARK.md)
--
-- ═══════════════════════════════════════════════════════════════════════════
-- Why it is a new table, and not a column on `item_instances`
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `item_instances` (migration-v21-crime-provenance.sql) is about GUILT: who
-- stole what, from whom. A maker's mark is about AUTHORSHIP: who made
-- what, for whom. Mixing the two would make a crime feature carry a
-- responsibility that is not its own — see MAKERS_MARK.md §4 and §6.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- The same simplification crime already accepted (MAKERS_MARK.md §3)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `character_inventory` is purely fungible (UNIQUE per owner+item, count
-- only — migration-v14-inventory-framework.sql). A row here does not
-- track ONE specific physical object inside a stack of identical
-- items; it says "among the items of this type this character
-- has, there is at least one signed by this maker, with this dedication". It is the
-- same degree of fidelity the institutional crime search already uses for
-- provenance — enough for RP flavor, not enough to prove which exact
-- physical unit is the signed one.

USE `skymp_rp`;

CREATE TABLE IF NOT EXISTS `crafted_item_signatures` (
  `id` CHAR(36) NOT NULL PRIMARY KEY COMMENT 'UUID v4, same convention as item_instances.id',
  `base_id` INT NOT NULL COMMENT 'Native Skyrim FormID (decimal), same convention as character_inventory.base_id',
  `recipe_id` INT NOT NULL COMMENT 'Recipe that produced the item (crafting_recipes.id, migration-v23)',
  `maker_character_id` INT NOT NULL COMMENT 'Who crafted and signed it',
  `owner_character_id` INT NOT NULL COMMENT 'Who received the item when crafted. NOT updated on trade/sale/deposit in this round -- no inventory consumer (trade/market-stall/depot) writes here. See the limitation in MAKERS_MARK.md',
  `signature_text` VARCHAR(64) DEFAULT NULL COMMENT 'Dedication requested by the buyer; NULL uses only the maker name',
  `crafted_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT `fk_signature_maker` FOREIGN KEY (`maker_character_id`) REFERENCES `characters` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_signature_owner` FOREIGN KEY (`owner_character_id`) REFERENCES `characters` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_signature_recipe` FOREIGN KEY (`recipe_id`) REFERENCES `crafting_recipes` (`id`) ON DELETE CASCADE,
  INDEX `idx_signature_owner_base` (`owner_character_id`, `base_id`)
) ENGINE=InnoDB;
