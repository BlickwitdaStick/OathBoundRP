-- seed-forging.sql
-- Recipes based on the Ars Metallica and Cloaks & Capes mods
--
-- `required_profession` filled in on 2026-08-20, after
-- migration-v23-crafting-profession-gate.sql added the column and
-- crafting-service.craftItem() started really checking it. Mapping per
-- RECIPE (not per `station_type`): 1001/1002 smelt scrap into ingots —
-- Smelter work (`smelter`), not Blacksmith work (`blacksmith`), even though both
-- run at the same `forge`.
--
-- ⚠️ There is no recipe here to FORGE a weapon/armor from an
-- ingot — the one that would give the `blacksmith` real work. Adding one
-- would require a real weapon/armor `result_base_id` from the mod in use, and this
-- file already has the precedent of what goes wrong when a FormID is invented: recipe
-- 1003 used `999999` as a placeholder. It was removed from the seed and migration
-- v28 cleans existing installs. A new Blacksmith recipe only goes in with
-- the confirmed FormID of the mod actually shipped.
-- Recipe names are player-facing; migration-v31-english-seed-labels.sql renames old rows.
USE skymp_rp;

-- Smelt Iron Armor (yields 2 Iron Ingots) — Smelter
INSERT INTO crafting_recipes (id, name, station_type, result_base_id, result_count, requires_perk, required_profession, required_rank)
VALUES (1001, 'Smelt: Iron Armor', 'forge', 371940, 2, NULL, 'smelter', NULL)
ON DUPLICATE KEY UPDATE required_profession = VALUES(required_profession);

INSERT INTO crafting_ingredients (recipe_id, base_id, count)
VALUES (1001, 77385, 1) -- 1x Iron Armor
ON DUPLICATE KEY UPDATE count=count;

-- Smelt Steel Sword (yields 1 Steel Ingot) — Smelter
INSERT INTO crafting_recipes (id, name, station_type, result_base_id, result_count, requires_perk, required_profession, required_rank)
VALUES (1002, 'Smelt: Steel Sword', 'forge', 371941, 1, NULL, 'smelter', NULL)
ON DUPLICATE KEY UPDATE required_profession = VALUES(required_profession);

INSERT INTO crafting_ingredients (recipe_id, base_id, count)
VALUES (1002, 80265, 1) -- 1x Steel Sword
ON DUPLICATE KEY UPDATE count=count;
