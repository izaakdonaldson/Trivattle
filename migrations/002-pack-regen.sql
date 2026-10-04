ALTER TABLE inventory ADD COLUMN cooldown_anchor INTEGER;
-- Preserve all balances. Start elapsed-time accounting at deployment, not account creation.
UPDATE inventory SET cooldown_anchor = CAST(unixepoch('subsec') * 1000 AS INTEGER);
