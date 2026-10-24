import { sqliteTable,text,integer,index } from 'drizzle-orm/sqlite-core';
export const recallCases=sqliteTable('recall_cases',{
  id:text('id').primaryKey(),ownerId:text('owner_id').notNull(),name:text('name').notNull(),
  payload:text('payload').notNull(),version:integer('version').notNull().default(1),
  createdAt:text('created_at').notNull(),updatedAt:text('updated_at').notNull(),
});
// Meterless H-MEM state for one case (records + trust ledger), owned like its case.
export const caseMemory=sqliteTable('case_memory',{
  caseId:text('case_id').primaryKey(),ownerId:text('owner_id').notNull(),engine:text('engine').notNull(),
  state:text('state').notNull(),version:integer('version').notNull().default(1),updatedAt:text('updated_at').notNull(),
});
// Results of real connection attempts to external systems, shown on the integration status screen.
export const integrationChecks=sqliteTable('integration_checks',{
  id:text('id').primaryKey(),ownerId:text('owner_id').notNull(),integration:text('integration').notNull(),
  mode:text('mode').notNull(),operation:text('operation').notNull(),ok:integer('ok').notNull(),
  latencyMs:integer('latency_ms').notNull(),detail:text('detail').notNull(),at:text('at').notNull(),
},t=>[index('integration_checks_owner_at').on(t.ownerId,t.at)]);
