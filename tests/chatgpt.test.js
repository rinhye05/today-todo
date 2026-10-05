const test = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPairSync, sign, createHash } = require('node:crypto');
const { ChatGPT, configuration, sseEvents } = require('../chatgpt');

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'fixture-key', alg: 'RS256', use: 'sig' };
const scopes = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const issuer = 'https://auth.openai.com';
const config = configuration({ TODO_PUBLIC_URL: 'http://localhost:4173', OPENAI_CLIENT_ID: 'oaiapp_tests', TODO_CHATGPT_PLAN_ENABLED: 'true' });

function jwt(claims) {
  const head = Buffer.from(JSON.stringify({ alg: 'RS256', kid: jwk.kid })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const input = `${head}.${payload}`;
  return `${input}.${sign('sha256', Buffer.from(input), privateKey).toString('base64url')}`;
}

function fixture(t, options = {}) {
  let now = Date.now();
  const calls = [];
  const grants = new Map();
  let refreshes = 0;
  const fetchImpl = async (url, init = {}) => {
    const address = String(url);
    calls.push({ url: address, ...init });
    if (address.endsWith('/.well-known/openid-configuration')) return Response.json({ issuer, authorization_endpoint: `${issuer}/api/accounts/authorize`, token_endpoint: `${issuer}/api/accounts/oauth/token`, jwks_uri: `${issuer}/.well-known/jwks.json`, revocation_endpoint: `${issuer}/revoke` });
    if (address.endsWith('/.well-known/jwks.json')) return Response.json({ keys: [jwk] });
    if (address.endsWith('/oauth/token')) {
      const form = new URLSearchParams(init.body);
      if (form.get('grant_type') === 'refresh_token') {
        refreshes++;
        await new Promise((resolve) => setTimeout(resolve, 5));
        if (options.refreshError) return Response.json({ error: 'invalid_grant' }, { status: 400 });
        return Response.json({ access_token: 'renewed-access', refresh_token: 'rotated-refresh', expires_in: 3600 });
      }
      if (options.tokenError) return Response.json({ error: 'invalid_grant', secret: 'never-exposed' }, { status: 400 });
      const grant = grants.get(form.get('code'));
      assert.ok(grant, 'Only fixture authorization codes can be redeemed');
      const issuedAt = Math.floor(now / 1000);
      const identityToken = jwt({ iss: issuer, aud: config.clientId, sub: grant.subject, email: grant.email, name: '테스트 계정', nonce: grant.nonce, iat: issuedAt, exp: issuedAt + 3600, ...options.claims });
      const parts = identityToken.split('.');
      if (options.invalidSignature) parts[2] = `${parts[2].slice(0, 10)}${parts[2][10] === 'A' ? 'B' : 'A'}${parts[2].slice(11)}`;
      return Response.json({
        id_token: parts.join('.'),
        access_token: `access-${grant.subject}`, refresh_token: `refresh-${grant.subject}`, expires_in: options.expiresIn || 3600,
        scope: options.noPlan ? 'openid profile email' : scopes,
      });
    }
    if (address.endsWith('/models')) return Response.json({ models: [
      { slug: 'model-a', display_name: '첫 모델', visibility: 'list' }, { slug: 'hidden', visibility: 'hide' },
      { slug: 'model-b', display_name: '두 번째 모델', visibility: 'list' },
    ] });
    if (address.endsWith('/responses')) {
      if (options.httpError) return Response.json({ error: { code: options.httpError, message: 'private provider diagnostics' } }, { status: 429 });
      if (options.block) return new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
      const events = [{ type: options.refusal ? 'response.refusal.delta' : 'response.output_text.delta', delta: '안녕 <script>한글</script>' },
        ...(options.interrupted ? [] : [options.failed ? { type: 'response.failed', response: { error: { code: options.failed } } } : options.incomplete ? { type: 'response.incomplete' } : { type: 'response.completed' }])];
      const encoded = Buffer.from(events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join(''));
      return new Response(new ReadableStream({ start(controller) {
        for (let at = 0; at < encoded.length; at += 7) controller.enqueue(encoded.subarray(at, at + 7));
        controller.close();
      } }));
    }
    if (address.endsWith('/revoke')) return new Response('', { status: options.revokeFailure ? 503 : 200 });
    throw new Error(`Unexpected mock request ${address}`);
  };
  const service = new ChatGPT({ config: options.config || config, fetchImpl, now: () => now });
  t.after(() => service.close());
  return {
    service, calls, grants, advance: (ms) => { now += ms; }, refreshCount: () => refreshes,
    async authorize(subject = 'user-a', email = `${subject}@example.test`) {
      const start = await service.begin();
      const authorization = new URL(start.authorizationUrl);
      const code = `fixture-${subject}-${grants.size}`;
      grants.set(code, { subject, email, nonce: authorization.searchParams.get('nonce') });
      const login = { headers: { cookie: start.cookie.split(';')[0] } };
      const callback = new URL(config.redirectUri);
      callback.search = new URLSearchParams({ state: authorization.searchParams.get('state'), code });
      const result = await service.callback(login, callback);
      const request = { headers: { cookie: result[1].split(';')[0] } };
      request.headers['x-csrf-token'] = service.status(request).csrfToken;
      return { request, authorization, login, callback, cookie: result[1] };
    },
  };
}

test('unregistered mode never contacts OpenAI; hosted configuration rejects dynamic clients', async (t) => {
  const f = fixture(t, { config: configuration({}) });
  assert.equal(f.service.status({ headers: {} }).configured, false);
  await assert.rejects(f.service.begin(), { code: 'not_configured' });
  assert.equal(f.calls.length, 0);
  assert.throws(() => configuration({ OPENAI_CLIENT_ID: 'dynamic_agent_client' }));
  assert.throws(() => configuration({ TODO_PUBLIC_URL: 'http://example.com' }));
  assert.throws(() => configuration({ TODO_PUBLIC_URL: 'https://example.com/path' }));
  assert.throws(() => configuration({ OPENAI_CLIENT_ID: 'oaiapp_test', OPENAI_TOKEN_AUTH_METHOD: 'client_secret_basic' }));
});

test('OAuth binds fresh state, nonce, PKCE, callback and approved plan scopes', async (t) => {
  const f = fixture(t);
  const first = await f.service.begin();
  const second = await f.service.begin();
  const a = new URL(first.authorizationUrl);
  const b = new URL(second.authorizationUrl);
  const transactionId = first.cookie.split(';')[0].split('=')[1];
  const transaction = f.service.transactions.get(transactionId);
  assert.notEqual(a.searchParams.get('state'), b.searchParams.get('state'));
  assert.notEqual(a.searchParams.get('nonce'), b.searchParams.get('nonce'));
  assert.equal(a.searchParams.get('code_challenge'), createHash('sha256').update(transaction.verifier).digest('base64url'));
  assert.equal(a.searchParams.get('redirect_uri'), config.redirectUri);
  assert.equal(a.searchParams.get('scope'), scopes);
  assert.match(first.cookie, /HttpOnly; SameSite=Lax/);
  assert.equal(first.authorizationUrl.includes(transaction.verifier), false);
});

test('mismatched, replayed, expired and declined callbacks never exchange a code', async (t) => {
  const f = fixture(t);
  for (const kind of ['mismatch', 'expired', 'declined']) {
    const start = await f.service.begin();
    const authorization = new URL(start.authorizationUrl);
    const callback = new URL(config.redirectUri);
    callback.searchParams.set('state', kind === 'mismatch' ? 'wrong' : authorization.searchParams.get('state'));
    callback.searchParams.set('code', 'not-redeemable');
    if (kind === 'declined') callback.searchParams.set('error', 'access_denied');
    if (kind === 'expired') f.advance(600001);
    const request = { headers: { cookie: start.cookie.split(';')[0] } };
    await assert.rejects(f.service.callback(request, callback));
    await assert.rejects(f.service.callback(request, callback), { code: 'invalid_state' });
  }
  assert.equal(f.calls.filter((call) => call.url.endsWith('/oauth/token')).length, 0);
});

test('verified login isolates sessions, protects cookies, and exposes only display identity', async (t) => {
  const f = fixture(t);
  const a = await f.authorize('a');
  const b = await f.authorize('b');
  assert.notEqual(a.cookie, b.cookie);
  assert.equal(f.service.status(a.request).account.email, 'a@example.test');
  assert.equal(f.service.status(b.request).account.email, 'b@example.test');
  assert.equal(f.service.status(a.request).canInvoke, true);
  const browserStatus = JSON.stringify(f.service.status(a.request));
  for (const token of ['access-a', 'refresh-a', 'id_token', 'subject']) assert.equal(browserStatus.includes(token), false);
  assert.match(f.service.cookie('session', 'fixture', 60), /HttpOnly/);
  const secure = fixture(t, { config: { ...config, origin: 'https://todo.example' } });
  assert.match(secure.service.cookie('session', 'fixture', 60), /^__Host-todo-gpt-session=.*; Secure$/);
});

test('ID tokens with invalid issuer, audience, nonce, expiry or subject are rejected', async (t) => {
  for (const claims of [{ iss: 'https://untrusted.example' }, { aud: 'other-client' }, { nonce: 'other-nonce' }, { exp: 1 }, { sub: '' }, { aud: [config.clientId, 'other'], azp: 'other' }]) {
    const f = fixture(t, { claims });
    await assert.rejects(f.authorize(), { code: 'invalid_identity' });
    assert.equal(f.service.sessions.size, 0);
  }
});

test('identity-only login does not authorize inference or catalog access', async (t) => {
  const f = fixture(t, { noPlan: true });
  const a = await f.authorize();
  assert.equal(f.service.status(a.request).connected, true);
  assert.equal(f.service.status(a.request).canInvoke, false);
  await assert.rejects(f.service.models(a.request), { code: 'plan_permission_required' });
  assert.equal(f.calls.some((call) => call.url.endsWith('/models')), false);
});

test('invalid signatures are rejected and failed revocation is reported after clearing credentials', async (t) => {
  const tampered = fixture(t, { invalidSignature: true });
  await assert.rejects(tampered.authorize(), { code: 'invalid_identity' });
  assert.equal(tampered.service.sessions.size, 0);
  const f = fixture(t, { revokeFailure: true });
  const a = await f.authorize();
  const session = f.service.session(a.request);
  const result = await f.service.logout(a.request);
  assert.equal(result.revoked, false);
  assert.equal(f.service.status(a.request).connected, false);
  assert.deepEqual(session.tokens, {});
  assert.equal(f.calls.filter((call) => call.url.endsWith('/revoke')).length, 2);
});

test('rotating refresh tokens are renewed once for concurrent requests', async (t) => {
  const f = fixture(t, { expiresIn: 90 });
  const a = await f.authorize();
  f.advance(31000);
  const session = f.service.session(a.request);
  const results = await Promise.all([f.service.accessToken(session), f.service.accessToken(session)]);
  assert.deepEqual(results, ['renewed-access', 'renewed-access']);
  assert.equal(f.refreshCount(), 1);
  assert.equal(session.tokens.refresh_token, 'rotated-refresh');
  const form = new URLSearchParams(f.calls.find((call) => call.body?.get('grant_type') === 'refresh_token').body);
  assert.equal(form.get('client_id'), config.clientId);
  assert.equal(form.has('scope'), false);
});

test('confidential clients send secrets only in the Basic authorization header', async (t) => {
  const f = fixture(t, { config: { ...config, authMethod: 'client_secret_basic', clientSecret: 'fixture:secret' } });
  await f.authorize();
  const call = f.calls.find((item) => item.url.endsWith('/oauth/token'));
  assert.match(call.headers.Authorization, /^Basic /);
  assert.equal(call.body.has('client_secret'), false);
  assert.equal(call.url.includes('fixture'), false);
});

test('catalog uses the selected user token and preserves visible account-specific choices', async (t) => {
  const f = fixture(t);
  const a = await f.authorize();
  assert.deepEqual(await f.service.models(a.request), [{ id: 'model-a', name: '첫 모델' }, { id: 'model-b', name: '두 번째 모델' }]);
  await f.service.models(a.request);
  const calls = f.calls.filter((call) => call.url.endsWith('/models'));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers.Authorization, 'Bearer access-user-a');
});

test('Responses streams UTF-8 text and requires completed; input uses optional explicit context', async (t) => {
  const f = fixture(t);
  const a = await f.authorize();
  const output = [];
  await f.service.respond(a.request, { model: 'model-a', prompt: '계획을 세워줘', context: '[{"title":"산책"}]' }, (event) => output.push(event), new AbortController().signal);
  assert.deepEqual(output, [{ type: 'delta', text: '안녕 <script>한글</script>' }, { type: 'completed' }]);
  const body = JSON.parse(f.calls.find((call) => call.url.endsWith('/responses')).body);
  assert.equal(body.store, false);
  assert.equal(body.stream, true);
  assert.equal(body.input.at(-1).content, '계획을 세워줘');
  assert.match(body.input[1].content, /산책/);
  assert.equal(f.service.session(a.request).active, null);
});

test('CSRF, unavailable models and oversized prompts fail before inference', async (t) => {
  const f = fixture(t);
  const a = await f.authorize();
  const body = { model: 'model-a', prompt: 'test' };
  await assert.rejects(f.service.respond({ headers: { cookie: a.request.headers.cookie } }, body, () => {}, new AbortController().signal), { code: 'csrf_failed' });
  await assert.rejects(f.service.respond(a.request, { ...body, model: 'hidden' }, () => {}, new AbortController().signal), { code: 'invalid_model' });
  await assert.rejects(f.service.respond(a.request, { ...body, prompt: 'x'.repeat(4001) }, () => {}, new AbortController().signal), { code: 'invalid_input' });
  assert.equal(f.calls.some((call) => call.url.endsWith('/responses')), false);
});

test('refusal text is displayed and logout revokes a refresh token renewed during sign-out', async (t) => {
  const f = fixture(t, { refusal: true, expiresIn: 90 });
  const a = await f.authorize();
  const output = [];
  await f.service.respond(a.request, { model: 'model-a', prompt: 'test' }, (event) => output.push(event), new AbortController().signal);
  assert.equal(output[0].type, 'delta');
  assert.match(output[0].text, /한글/);
  f.advance(31000);
  const renewal = f.service.accessToken(f.service.session(a.request));
  const disconnect = f.service.logout(a.request);
  await Promise.all([renewal, disconnect]);
  assert.equal(f.calls.find((call) => call.url.endsWith('/revoke')).body.get('token'), 'rotated-refresh');
});

test('usage errors, incomplete replies and dropped streams retain partial text without success', async (t) => {
  for (const options of [{ failed: 'subscription_sharing_usage_limit_exceeded' }, { incomplete: true }, { interrupted: true }]) {
    const f = fixture(t, options);
    const a = await f.authorize();
    const output = [];
    await assert.rejects(f.service.respond(a.request, { model: 'model-a', prompt: 'test' }, (event) => output.push(event), new AbortController().signal));
    assert.equal(output[0].type, 'delta');
    assert.equal(output.some((event) => event.type === 'completed'), false);
    assert.equal(f.service.session(a.request).active, null);
  }
});

test('cancellation aborts upstream inference and releases the session lock', async (t) => {
  const f = fixture(t, { block: true });
  const a = await f.authorize();
  const controller = new AbortController();
  const promise = f.service.respond(a.request, { model: 'model-a', prompt: 'test' }, () => {}, controller.signal);
  while (!f.calls.some((call) => call.url.endsWith('/responses'))) await new Promise((resolve) => setTimeout(resolve, 1));
  await assert.rejects(f.service.respond(a.request, { model: 'model-a', prompt: 'test' }, () => {}, controller.signal), { code: 'already_running' });
  controller.abort();
  await assert.rejects(promise);
  assert.equal(f.service.session(a.request).active, null);
});

test('logout revokes refresh tokens and clears only the selected session', async (t) => {
  const f = fixture(t);
  const a = await f.authorize('a');
  const b = await f.authorize('b');
  const result = await f.service.logout(a.request);
  assert.equal(result.revoked, true);
  assert.equal(f.service.status(a.request).connected, false);
  assert.equal(f.service.status(b.request).connected, true);
  assert.match(result.cookie, /Max-Age=0/);
  assert.equal(f.calls.find((call) => call.url.endsWith('/revoke')).body.get('token'), 'refresh-a');
});

test('SSE parser handles CRLF split across chunks and ignores transport markers', async () => {
  const body = new ReadableStream({ start(controller) {
    for (const part of ['event: response\r\ndata: {"type":"response.completed"}\r', '\n\r', '\ndata: [DONE]\n\n']) controller.enqueue(Buffer.from(part));
    controller.close();
  } });
  const result = [];
  for await (const event of sseEvents(body)) result.push(event);
  assert.deepEqual(result, [{ type: 'response.completed' }]);
});
