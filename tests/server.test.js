const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { request: httpRequest } = require('node:http');
const { ChatGPT, configuration } = require('../chatgpt');
const { createAppServer } = require('../server');

// Node's fetch may replace a custom Host header. http.request lets these tests
// exercise a fixed public origin through an ephemeral loopback test port.
function localFetch(url, options = {}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, options, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: response.statusCode, headers: response.headers })));
      response.on('error', reject);
    });
    request.on('error', reject);
    request.end(options.body);
  });
}

test('HTTP routes protect the account boundary and return a disabled integration honestly', async (t) => {
  const chatgpt = new ChatGPT({ config: configuration({}), fetchImpl: async () => { throw new Error('No external requests allowed'); } });
  const server = createAppServer({ chatgpt, localUsage: null });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.close(); server.closeAllConnections(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (path, options = {}) => localFetch(`${base}${path}`, { ...options, headers: { Host: 'localhost:4173', ...options.headers } });
  const session = await call('/api/chatgpt/session');
  assert.equal(session.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await session.json(), { configured: false, planEnabled: false, connected: false, canInvoke: false, authOrigin: 'http://localhost:4173' });
  const usage = await (await call('/api/usage')).json();
  assert.equal(usage.available, false);
  assert.equal(usage.pollable, false);
  assert.equal(usage.source, 'chatgpt');
  assert.equal(usage.windows, undefined);
  const start = await call('/auth/chatgpt/start', { method: 'POST', headers: { Origin: 'http://localhost:4173', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(start.status, 503);
  assert.equal((await start.json()).code, 'not_configured');
  assert.equal((await call('/api/chatgpt/models')).status, 401);
  assert.equal((await call('/api/chatgpt/respond', { method: 'POST', headers: { Origin: 'http://localhost:4173' }, body: '{}' })).status, 401);
  assert.equal((await call('/api/chatgpt/respond')).status, 405);
  assert.equal((await call('/auth/chatgpt/start', { method: 'POST', headers: { Origin: 'https://another.example' } })).status, 403);
  assert.equal((await call('/auth/chatgpt/start', { method: 'POST' })).status, 403);
  assert.equal((await call('/api/chatgpt/session', { headers: { Host: 'another.example' } })).status, 403);
  for (const path of ['/.env', '/.env.example', '/chatgpt.js', '/package-lock.json', '/tests/chatgpt.test.js']) assert.equal((await call(path)).status, 404);
  assert.equal((await call('/chatgpt-ui.js')).status, 200);
  const callback = await call('/auth/chatgpt/callback?state=unknown&code=ignored', { redirect: 'manual', headers: { 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(callback.status, 303);
  assert.equal(callback.headers.get('location'), '/?chatgpt=invalid_state');
  assert.equal(callback.headers.get('referrer-policy'), 'no-referrer');
  assert.match(callback.headers.get('set-cookie'), /Max-Age=0/);
});

test('HTTP disconnect cancels inference and streaming failures never report completion', async (t) => {
  let aborted = false;
  let responseMode = 'failure';
  const chatgpt = new ChatGPT({ config: configuration({ OPENAI_CLIENT_ID: 'oaiapp_test', TODO_CHATGPT_PLAN_ENABLED: 'true' }), fetchImpl: async (url, options) => {
    if (String(url).endsWith('/responses')) {
      if (responseMode === 'cancel') return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => { aborted = true; reject(options.signal.reason); }, { once: true }));
      return new Response('data: {"type":"response.output_text.delta","delta":"部分"}\n\ndata: {"type":"response.failed","response":{"error":{"code":"subscription_sharing_usage_limit_exceeded"}}}\n\n');
    }
    throw new Error('No external requests allowed');
  } });
  const session = {
    account: { name: 'fixture', email: '' }, csrf: 'fixture-csrf', tokens: { access_token: 'fixture-access' }, scopes: ['chatgpt.tokens.use.direct', 'resource.invoke'],
    tokenExpiresAt: Date.now() + 3600000, expiresAt: Date.now() + 3600000,
    models: { items: [{ id: 'fixture-model', name: 'fixture model' }], expiresAt: Date.now() + 3600000 }, requests: [], active: null,
  };
  chatgpt.sessions.set('fixture-session', session);
  const server = createAppServer({ chatgpt, localUsage: null });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.close(); server.closeAllConnections(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { Host: 'localhost:4173', Origin: 'http://localhost:4173', Cookie: 'todo-gpt-session=fixture-session', 'X-CSRF-Token': 'fixture-csrf', 'Content-Type': 'application/json' };
  const response = await localFetch(`${base}/api/chatgpt/respond`, { method: 'POST', headers, body: JSON.stringify({ model: 'fixture-model', prompt: 'test' }) });
  assert.match(response.headers.get('content-type'), /application\/x-ndjson/);
  const events = (await response.text()).trim().split('\n').map(JSON.parse);
  assert.equal(events[0].type, 'delta');
  assert.equal(events[1].type, 'error');
  assert.equal(events[1].code, 'subscription_sharing_usage_limit_exceeded');
  assert.equal(events.some((event) => event.type === 'completed'), false);
  assert.equal(session.active, null);
  responseMode = 'cancel';
  const controller = new AbortController();
  const pending = localFetch(`${base}/api/chatgpt/respond`, { method: 'POST', headers, body: JSON.stringify({ model: 'fixture-model', prompt: 'test' }), signal: controller.signal });
  while (!session.active) await new Promise((resolve) => setTimeout(resolve, 1));
  controller.abort();
  await assert.rejects(pending);
  for (let attempt = 0; attempt < 50 && !aborted; attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(aborted, true);
  assert.equal(session.active, null);
});
