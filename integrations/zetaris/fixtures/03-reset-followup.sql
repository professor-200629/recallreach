-- Resets the demo: removes the fictional follow-up quarantine added by 02-followup-quarantine.sql,
-- so the follow-up step (900 -> 940 bottles contained) can be shown again. Rows already imported
-- into a RecallReach case stay in that case; start a new case to rehearse from the beginning.
--   docker exec -i recallreach-sources psql -U postgres -d recall_pharmacy < integrations/zetaris/fixtures/03-reset-followup.sql
DELETE FROM stock_events WHERE txn_id = 'Q-D' AND consignment_ref = 'RR-104' AND doc_ref = 'DRILL-HOLD-104';
