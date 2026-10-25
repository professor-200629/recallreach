// Trust boundary: RecallReach does not authenticate users itself. It reads the identity that the
// OpenAI Sites dispatcher puts in oai-authenticated-user-* headers after "Sign in with ChatGPT".
// The dispatcher removes any such headers a client sends, so inside a Sites deployment they can
// be trusted. Anywhere the Worker is reachable without that dispatcher in front (a workers.dev
// route, another proxy), a caller could forge them; see docs/DEPLOYMENT.md. In local development
// scripts/vite/sites-vite-plugin.ts plays the dispatcher's role (strips client headers, loopback only).
export type HeaderIdentity = { userId: string; displayName: string; email: string; fullName: string | null };

export const IDENTITY_HEADERS = {
  userId: 'oai-authenticated-user-id',
  email: 'oai-authenticated-user-email',
  fullName: 'oai-authenticated-user-full-name',
  fullNameEncoding: 'oai-authenticated-user-full-name-encoding',
} as const;

/** Reads the dispatcher-provided identity. Both the user ID and email must be present. */
export function identityFromHeaders(headers: Pick<Headers, 'get'>): HeaderIdentity | null {
  const userId = headers.get(IDENTITY_HEADERS.userId), email = headers.get(IDENTITY_HEADERS.email);
  if (!userId || !email) return null;
  const encoded = headers.get(IDENTITY_HEADERS.fullName);
  let fullName: string | null = null;
  if (encoded && headers.get(IDENTITY_HEADERS.fullNameEncoding) === 'percent-encoded-utf-8') { try { fullName = decodeURIComponent(encoded); } catch { fullName = null; } }
  return { userId, displayName: fullName ?? email, email, fullName };
}
