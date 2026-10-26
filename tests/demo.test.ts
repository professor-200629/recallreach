import test from 'node:test';
import assert from 'node:assert/strict';
import { DEMO_COOKIE, demoFetch } from '../lib/recall/demo.ts';
import { identityFromHeaders } from '../lib/recall/identity.ts';

const ID = '3f2b6c1e-8a4d-4c2e-9b7a-1d2e3f4a5b6c';
const seen: Request[] = [];
const inner = async (r: Request) => { seen.push(r); return new Response(`ok ${r.method} ${await r.text()}`, { status: 200, headers: { 'content-type': 'text/plain' } }); };
const cookieOf = (res: Response) => /rr_demo=([^;]*)/.exec(res.headers.get('set-cookie') ?? '')?.[1];

test('public demo: forged identity headers are removed and each new browser gets its own sandbox identity', async () => {
  const res = await demoFetch(new Request('https://demo.example/api/cases', { headers: { 'oai-authenticated-user-id': 'victim', 'oai-authenticated-user-email': 'victim@example.com', 'OAI-Authenticated-User-Full-Name': 'Victim' } }), inner);
  const id = cookieOf(res), who = identityFromHeaders(seen.at(-1)!.headers)!;
  assert.match(id ?? '', /^[0-9a-f-]{36}$/);
  assert.equal(who.userId, `demo-${id}`); assert.notEqual(who.email, 'victim@example.com'); assert.equal(who.fullName, 'Demo visitor');
  assert.match(res.headers.get('set-cookie')!, /HttpOnly; Secure; SameSite=Lax/);
  const other = cookieOf(await demoFetch(new Request('https://demo.example/'), inner));
  assert.notEqual(other, id, 'a second browser gets a different sandbox');
});

test('public demo: a returning browser keeps its sandbox; a malformed cookie gets a new one', async () => {
  const back = await demoFetch(new Request('https://demo.example/api/cases', { headers: { cookie: `theme=dark; ${DEMO_COOKIE}=${ID}` } }), inner);
  assert.equal(identityFromHeaders(seen.at(-1)!.headers)!.userId, `demo-${ID}`);
  assert.equal(back.headers.get('set-cookie'), null);
  const bad = await demoFetch(new Request('https://demo.example/', { headers: { cookie: `${DEMO_COOKIE}=victim` } }), inner);
  assert.notEqual(identityFromHeaders(seen.at(-1)!.headers)!.userId, 'demo-victim');
  assert.ok(cookieOf(bad));
});

test('public demo: request bodies pass through unchanged', async () => {
  const res = await demoFetch(new Request('https://demo.example/api/cases', { method: 'POST', body: '{"action":"sample"}', headers: { 'content-type': 'application/json', cookie: `${DEMO_COOKIE}=${ID}` } }), inner);
  assert.equal(await res.text(), 'ok POST {"action":"sample"}');
});

test('public demo: sign-in and sign-out only redirect within the site', async () => {
  const signIn = await demoFetch(new Request('https://demo.example/signin-with-chatgpt?return_to=%2F%3Ftab%3Dabout'), inner);
  assert.equal(signIn.status, 303); assert.equal(signIn.headers.get('location'), '/?tab=about'); assert.ok(cookieOf(signIn));
  for (const to of ['https://evil.example/', '//evil.example/', '/\\evil.example']) {
    const r = await demoFetch(new Request(`https://demo.example/signin-with-chatgpt?return_to=${encodeURIComponent(to)}`), inner);
    assert.equal(r.headers.get('location'), '/', `refuses ${to}`);
  }
  const out = await demoFetch(new Request('https://demo.example/signout-with-chatgpt', { headers: { cookie: `${DEMO_COOKIE}=${ID}` } }), inner);
  assert.equal(out.status, 303); assert.match(out.headers.get('set-cookie')!, /rr_demo=; Path=\/; Max-Age=0/);
});
