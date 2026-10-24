import { sqliteTable,text,integer } from 'drizzle-orm/sqlite-core';
export const recallCases=sqliteTable('recall_cases',{
  id:text('id').primaryKey(),ownerId:text('owner_id').notNull(),name:text('name').notNull(),
  payload:text('payload').notNull(),version:integer('version').notNull().default(1),
  createdAt:text('created_at').notNull(),updatedAt:text('updated_at').notNull(),
});
