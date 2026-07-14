-- product-grain taste: add the 'product' value to SubjectType so POS line items
-- can be fanned into the taste graph at SKU/category grain.
--
-- This MUST be the only statement in the migration: Postgres rejects
-- `ALTER TYPE ... ADD VALUE` when sent in a multi-command string alongside
-- other statements.
ALTER TYPE "SubjectType" ADD VALUE 'product';
