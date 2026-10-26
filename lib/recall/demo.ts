import { IDENTITY_HEADERS } from './identity.ts';

// Public demo (RECALLREACH_PUBLIC_DEMO=1 on the Worker). With no Sites dispatcher in front, this
// wrapper plays the dispatcher's role: it removes every identity header a client sends and signs
// each browser in as its own anonymous sandbox user, keyed by a random cookie. There are no real
// accounts, no model key and only fictional data; a visitor can reach only their own sandbox, and
// another visitor's sandbox only by guessing a random 122-bit ID.
export const DEMO_COOKIE = 'rr_demo';
const DEMO_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_AGE_S = 60 * 60 * 24 * 30;

function cookieId(request: Request): string | null {
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const [name, ...value] = part.trim().split('=');
    if (name === DEMO_COOKIE) { const id = value.join('='); return DEMO_ID.test(id) ? id : null; }
  }
  return null;
}

/** A same-origin path to return to after the demo sign-in or sign-out routes; anything else goes home. */
function returnPath(url: URL): string {
  const to = url.searchParams.get('return_to') ?? '/';
  if (!to.startsWith('/') || to.startsWith('//') || to.startsWith('/\\')) return '/';
  try { const u = new URL(to, 'https://demo.local'); return u.origin === 'https://demo.local' ? `${u.pathname}${u.search}` : '/'; } catch { return '/'; }
}

const setCookie = (id: string) => `${DEMO_COOKIE}=${id}; Path=/; Max-Age=${MAX_AGE_S}; HttpOnly; Secure; SameSite=Lax`;
const redirect = (to: string, cookie: string) => new Response(null, { status: 303, headers: { location: to, 'set-cookie': cookie, 'cache-control': 'no-store' } });

export async function demoFetch(request: Request, inner: (request: Request) => Promise<Response>): Promise<Response> {
  const url = new URL(request.url);
  // Sign-out starts a fresh sandbox; sign-in is automatic. Both only redirect within this site.
  if (url.pathname === '/signout-with-chatgpt') return redirect(returnPath(url), `${DEMO_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`);
  const known = cookieId(request), id = known ?? crypto.randomUUID();
  if (url.pathname === '/signin-with-chatgpt' || url.pathname === '/callback') return redirect(returnPath(url), setCookie(id));
  const headers = new Headers(request.headers);
  for (const name of [...headers.keys()]) if (name.toLowerCase().startsWith('oai-authenticated-user')) headers.delete(name);
  headers.set(IDENTITY_HEADERS.userId, `demo-${id}`);
  headers.set(IDENTITY_HEADERS.email, `visitor-${id.slice(0, 8)}@demo.recallreach.invalid`);
  headers.set(IDENTITY_HEADERS.fullName, encodeURIComponent('Demo visitor'));
  headers.set(IDENTITY_HEADERS.fullNameEncoding, 'percent-encoded-utf-8');
  const response = await inner(new Request(request, { headers }));
  if (known) return response;
  const out = new Response(response.body, response);
  out.headers.append('set-cookie', setCookie(id));
  return out;
}
