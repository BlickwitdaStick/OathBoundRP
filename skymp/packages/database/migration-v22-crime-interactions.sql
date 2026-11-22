-- v22 - Task 13: Criminal Interactions and Guard Authority
--
-- `confiscations` ALREADY EXISTS since `migration-v3-governance.sql` (line 132) —
-- verified with `check:schema:list` before writing this migration, after
-- an initial wrong assumption that the table did not exist. This migration
-- only ADDS the evidence column Task 13 needs: the link to
-- `item_instances`, so the Evidence Logic (core/crime-service.js
-- markItemConfiscated) knows which tracked instance that confiscation
-- corresponds to.

ALTER TABLE `confiscations`
  ADD COLUMN `item_instance_id` CHAR(36) DEFAULT NULL COMMENT 'Links to item_instances (migration-v21-crime-provenance.sql) when the confiscated item was stolen/hot',
  ADD CONSTRAINT `fk_confiscation_item_instance` FOREIGN KEY (`item_instance_id`) REFERENCES `item_instances` (`id`) ON DELETE SET NULL;
