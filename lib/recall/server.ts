import { env } from 'cloudflare:workers';
import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { CaseRepository } from './repo';
import { createHandlers, handle, json, type ExternalSetup } from './http';
import { providerFromEnv } from './agent/provider';
import { ZetarisSource, zetarisConfigFromEnv } from './sources/zetaris';
import { MockZetarisSource } from './sources/mock';
import type { IntegrationEvent } from './sources/external';

// Production wiring. Identity comes from the OpenAI Sites dispatcher's signed-in headers
// (see app/chatgpt-auth.ts); this Worker must only be served behind that dispatcher.
// Secrets and provider settings are read from server-side bindings, never from the client.
const vars = () => env as unknown as Record<string, unknown>;
/** The public demo deployment (see lib/recall/demo.ts): rules mode only, no connected sources, no secrets. */
export const publicDemo = () => vars().RECALLREACH_PUBLIC_DEMO === '1';

function external(onEvent: (e: IntegrationEvent) => void): ExternalSetup {
  if (publicDemo()) return { source: null, mode: 'none', detail: 'Public demo: Zetaris is not connected here. RecallReach was tested against a local Zetaris 2.4.3 instance with fictional data; the record and the demo video are in the repository (docs/INTEGRATIONS.md).' };
  let config;
  try { config = zetarisConfigFromEnv(vars()); } catch (e) { return { source: null, mode: 'none', detail: (e as Error).message }; }
  if (config) return { source: new ZetarisSource(config, onEvent), mode: 'live', detail: `Configured for ${new URL(config.restUrl).host} (organisation ${config.orgId}). Connected only after a successful check.`, tables: config.tables };
  if (vars().RECALLREACH_MOCK_SOURCES === '1') return { source: new MockZetarisSource(onEvent), mode: 'mock', detail: 'MOCK: local fixture data (RECALLREACH_MOCK_SOURCES=1). This is not a Zetaris connection.' };
  return { source: null, mode: 'none', detail: 'Zetaris is not configured. Set ZETARIS_REST_URL, ZETARIS_API_KEY and ZETARIS_ORG_ID as server secrets.' };
}

const handlers = () => createHandlers({
  repo: new CaseRepository(getD1()),
  identify: async () => { const u = await getChatGPTUser(); return u ? { userId: u.userId, displayName: u.displayName } : null; },
  // The public demo never runs a live model, even if a key were set: rules mode only.
  provider: () => providerFromEnv(publicDemo() ? {} : vars()),
  external,
});

export { handle, json };
export const listCases = (r: Request) => handlers().listCases(r);
export const createCase = (r: Request) => handlers().createCase(r);
export const getCase = (r: Request, id: string) => handlers().getCase(r, id);
export const changeCase = (r: Request, id: string) => handlers().changeCase(r, id);
export const exportCase = (r: Request, id: string) => handlers().exportCase(r, id);
export const integrations = (r: Request) => handlers().integrations(r);
export const checkIntegration = (r: Request) => handlers().checkIntegration(r);
