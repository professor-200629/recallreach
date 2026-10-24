import { env } from "cloudflare:workers";
import type { SqlDatabase } from "@/lib/recall/repo";

// RecallReach queries D1 directly through lib/recall/repo.ts; db/schema.ts is kept for
// drizzle-kit migration generation (npm run db:generate).
export function getD1(): SqlDatabase {
  if (!env.DB) {
    throw new Error(
      "Cloudflare D1 binding `DB` is unavailable. Set the `d1` field in .openai/hosting.json to `DB` or let your control plane inject the real binding values before using the database."
    );
  }
  return env.DB as unknown as SqlDatabase;
}
