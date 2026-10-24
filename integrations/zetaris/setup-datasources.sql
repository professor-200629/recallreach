-- Register RecallReach's three fictional source systems in YOUR local Zetaris.
-- Run in the Zetaris SQL Editor, signed in as administrator, ONE statement at a time
-- (Zetaris runs one Lightning SQL statement per call). Creating datasources changes
-- your Zetaris instance; nothing here writes to the source databases.
--
-- Prerequisite: the fixture database is running and attached to the Zetaris network
-- under the name recallreach-sources (docs/INTEGRATIONS.md, "Load the fictional source systems").
-- The login below is the read-only account created by fixtures/01-sources.sql. It needs no
-- password (fixtures/00-reader-auth.sh), so no secret appears in these statements.

-- 1. Distributor ERP
CREATE DATASOURCE recall_distributor DESCRIBE BY "Fictional distributor ERP (RecallReach demo)" OPTIONS (jdbcdriver "org.postgresql.Driver", jdbcurl "jdbc:postgresql://recallreach-sources:5432/recall_distributor", username "recallreach_reader")

-- 2.
REGISTER DATASOURCE TABLES FROM recall_distributor

-- 3. Pharmacy stock systems
CREATE DATASOURCE recall_pharmacy DESCRIBE BY "Fictional pharmacy stock systems (RecallReach demo)" OPTIONS (jdbcdriver "org.postgresql.Driver", jdbcurl "jdbc:postgresql://recallreach-sources:5432/recall_pharmacy", username "recallreach_reader")

-- 4.
REGISTER DATASOURCE TABLES FROM recall_pharmacy

-- 5. Distributor returns desk
CREATE DATASOURCE recall_returns DESCRIBE BY "Fictional returns desk (RecallReach demo)" OPTIONS (jdbcdriver "org.postgresql.Driver", jdbcurl "jdbc:postgresql://recallreach-sources:5432/recall_returns", username "recallreach_reader")

-- 6.
REGISTER DATASOURCE TABLES FROM recall_returns

-- 7. Check (read-only). Expect five batches: DEMO-042 4, DEMO-043 1, VL-2207 5, VL-2207A 1, VL2207 1.
SELECT batch_no, COUNT(*) AS rows FROM recall_distributor.dispatches GROUP BY batch_no

-- If step 7 says "table not found", run SHOW DATASOURCE TABLES recall_distributor and
-- use the names it shows in ZETARIS_TABLES (.dev.vars).
