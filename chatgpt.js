const { randomBytes, createHash } = require('node:crypto');

const ISSUER = 'https://auth.openai.com';
const RESOURCE = 'https://api.openai.com/v1';
const PLAN_SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const random = () => randomBytes(32).toString('base64url');
const formEncode = (value) => new URLSearchParams({ value }).toString().slice(6);

class AppError extends Error {
  constructor(message, status = 400, code = 'request_failed') { super(message); this.status = status; this.code = code; }
}

function configuration(env = process.env) {
  const origin = new URL(env.TODO_PUBLIC_URL || `http://localhost:${env.PORT || 4173}`);
  if (origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password ||
      (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(origin.hostname)))) {
    throw new Error('TODO_PUBLIC_URL은 HTTPS 원본 주소 또는 localhost 주소여야 합니다.');
  }
  const clientId = env.OPENAI_CLIENT_ID || '';
  if (clientId && !/^oaiapp_[a-zA-Z0-9_-]+$/.test(clientId)) throw new Error('등록된 OpenAI OAuth client ID를 설정하세요.');
  const authMethod = env.OPENAI_TOKEN_AUTH_METHOD || 'none';
  if (!['none', 'client_secret_basic'].includes(authMethod)) throw new Error('지원하지 않는 token-endpoint 인증 방식입니다.');
  if (clientId && authMethod === 'client_secret_basic' && !env.OPENAI_CLIENT_SECRET) throw new Error('OPENAI_CLIENT_SECRET을 서버에 설정하세요.');
  return {
    origin: origin.origin, redirectUri: `${origin.origin}/auth/chatgpt/callback`, clientId, authMethod,
    clientSecret: env.OPENAI_CLIENT_SECRET || '', planEnabled: env.TODO_CHATGPT_PLAN_ENABLED === 'true',
  };
}

function cookies(request) {
  return Object.fromEntries(String(request.headers.cookie || '').split(';').map((entry) => {
    const at = entry.indexOf('=');
    return at < 0 ? ['', ''] : [entry.slice(0, at).trim(), entry.slice(at + 1).trim()];
  }));
}

// The website flow uses the application's registered client, never a CLI client or
// dynamic_agent_client. Enable plan scopes only after OpenAI approves this hosted app.
class ChatGPT {
  constructor({ config = configuration(), fetchImpl = fetch, now = Date.now } = {}) {
    this.config = config;
    this.fetch = fetchImpl;
    this.now = now;
    this.transactions = new Map();
    this.sessions = new Map();
    this.discovery = null;
    this.jwks = null;
    this.housekeeping = setInterval(() => this.prune(), 60000);
    this.housekeeping.unref();
  }

  cookie(kind, value, maxAge) {
    const secure = this.config.origin.startsWith('https:');
    return `${secure ? '__Host-' : ''}todo-gpt-${kind}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
  }

  cookieValue(request, kind) {
    return cookies(request)[`${this.config.origin.startsWith('https:') ? '__Host-' : ''}todo-gpt-${kind}`];
  }

  prune() {
    for (const [id, item] of this.transactions) if (item.expiresAt <= this.now()) this.transactions.delete(id);
    for (const [id, item] of this.sessions) if (item.expiresAt <= this.now()) { item.active?.abort(); this.sessions.delete(id); }
  }

  session(request) {
    const session = this.sessions.get(this.cookieValue(request, 'session'));
    if (!session || session.expiresAt <= this.now()) { this.prune(); return null; }
    return session;
  }

  status(request) {
    const session = this.session(request);
    return {
      configured: Boolean(this.config.clientId), planEnabled: this.config.planEnabled,
      connected: Boolean(session), canInvoke: Boolean(session && this.config.planEnabled && session.tokens.access_token && session.scopes.includes('chatgpt.tokens.use.direct') && session.scopes.includes('resource.invoke')),
      ...(session ? { account: session.account, csrfToken: session.csrf } : {}),
    };
  }

  requireSession(request, { csrf = false, inference = false } = {}) {
    const session = this.session(request);
    if (!session) throw new AppError('ChatGPT 계정을 먼저 연결해 주세요.', 401, 'sign_in_required');
    if (csrf && request.headers['x-csrf-token'] !== session.csrf) throw new AppError('페이지를 새로고침하고 다시 시도해 주세요.', 403, 'csrf_failed');
    if (inference && !this.status(request).canInvoke) throw new AppError('ChatGPT 구독 사용 권한을 연결해야 해요.', 403, 'plan_permission_required');
    return session;
  }

  async metadata() {
    if (this.discovery) return this.discovery;
    const response = await this.fetch(`${ISSUER}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(15000), redirect: 'error' });
    if (!response.ok) throw new AppError('ChatGPT 로그인 서버에 연결하지 못했어요.', 502);
    const data = await response.json();
    if (data.issuer !== ISSUER) throw new AppError('ChatGPT 로그인 설정을 확인하지 못했어요.', 502);
    for (const field of ['authorization_endpoint', 'token_endpoint', 'jwks_uri', 'revocation_endpoint']) {
      if (!data[field] && field === 'revocation_endpoint') continue;
      if (new URL(data[field]).origin !== ISSUER) throw new AppError('ChatGPT 로그인 설정을 확인하지 못했어요.', 502);
    }
    this.discovery = data;
    return data;
  }

  async begin() {
    if (!this.config.clientId) throw new AppError('ChatGPT 연결은 서비스 등록 후 사용할 수 있어요.', 503, 'not_configured');
    this.prune();
    if (this.transactions.size >= 1000) throw new AppError('로그인 요청이 많아요. 잠시 후 시도해 주세요.', 429);
    const metadata = await this.metadata();
    const transactionId = random();
    const transaction = { state: random(), nonce: random(), verifier: random(), expiresAt: this.now() + 600000 };
    this.transactions.set(transactionId, transaction);
    const url = new URL(metadata.authorization_endpoint);
    url.search = new URLSearchParams({
      client_id: this.config.clientId, redirect_uri: this.config.redirectUri, response_type: 'code',
      scope: this.config.planEnabled ? PLAN_SCOPES : 'openid profile email',
      ...(this.config.planEnabled ? { resource: RESOURCE } : {}),
      state: transaction.state, nonce: transaction.nonce, code_challenge_method: 'S256',
      code_challenge: createHash('sha256').update(transaction.verifier).digest('base64url'),
    }).toString();
    return { authorizationUrl: url.toString(), cookie: this.cookie('login', transactionId, 600) };
  }

  tokenHeaders() {
    return {
      'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json',
      ...(this.config.authMethod === 'client_secret_basic' ? {
        Authorization: `Basic ${Buffer.from(`${formEncode(this.config.clientId)}:${formEncode(this.config.clientSecret)}`).toString('base64')}`,
      } : {}),
    };
  }

  async tokenRequest(fields) {
    const metadata = await this.metadata();
    const response = await this.fetch(metadata.token_endpoint, {
      method: 'POST', headers: this.tokenHeaders(), redirect: 'error', signal: AbortSignal.timeout(15000),
      body: new URLSearchParams({ client_id: this.config.clientId, ...fields }),
    });
    if (!response.ok) throw new AppError('ChatGPT 인증이 만료됐거나 연결에 실패했어요. 다시 연결해 주세요.', 401, 'reauthorize');
    return response.json();
  }

  async verifyIdentity(token, nonce) {
    const { createRemoteJWKSet, jwtVerify, customFetch } = await import('jose');
    const metadata = await this.metadata();
    this.jwks ||= createRemoteJWKSet(new URL(metadata.jwks_uri), { [customFetch]: (url, options) => this.fetch(url, { ...options, redirect: 'error' }) });
    try {
      const { payload } = await jwtVerify(token, this.jwks, {
        issuer: ISSUER, audience: this.config.clientId, algorithms: ['RS256'],
        requiredClaims: ['sub', 'exp', 'iat', 'nonce'], clockTolerance: 5,
        currentDate: new Date(this.now()),
      });
      if (payload.nonce !== nonce || typeof payload.sub !== 'string' || !payload.sub || payload.iat > this.now() / 1000 + 5 ||
          (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== this.config.clientId)) throw new Error('Invalid claims');
      return payload;
    } catch { throw new AppError('ChatGPT 로그인 정보를 확인하지 못했어요. 다시 연결해 주세요.', 401, 'invalid_identity'); }
  }

  async callback(request, url) {
    const transactionId = this.cookieValue(request, 'login');
    const transaction = this.transactions.get(transactionId);
    this.transactions.delete(transactionId); // One-time, including failed callbacks.
    if (!transaction || transaction.expiresAt <= this.now() || url.searchParams.get('state') !== transaction.state) {
      throw new AppError('로그인 요청이 만료됐어요. 다시 연결해 주세요.', 400, 'invalid_state');
    }
    if (url.searchParams.has('error')) throw new AppError('ChatGPT 연결을 취소했어요.', 400, 'access_denied');
    const code = url.searchParams.get('code');
    const returnedClient = url.searchParams.get('client_id');
    if (!code || (returnedClient && returnedClient !== this.config.clientId)) throw new AppError('로그인 응답을 확인하지 못했어요.', 400, 'invalid_state');
    const tokens = await this.tokenRequest({
      grant_type: 'authorization_code', code, code_verifier: transaction.verifier, redirect_uri: this.config.redirectUri,
      ...(this.config.planEnabled ? { resource: RESOURCE } : {}),
    });
    if (typeof tokens.id_token !== 'string') throw new AppError('로그인 응답을 확인하지 못했어요.', 401, 'invalid_identity');
    const identity = await this.verifyIdentity(tokens.id_token, transaction.nonce);
    const old = this.session(request);
    if (old) { old.active?.abort(); this.sessions.delete(this.cookieValue(request, 'session')); }
    const id = random();
    this.sessions.set(id, {
      account: { name: typeof identity.name === 'string' ? identity.name : 'ChatGPT 계정', email: typeof identity.email === 'string' ? identity.email : '' },
      subject: identity.sub, csrf: random(), tokens, scopes: String(tokens.scope || '').split(/\s+/),
      tokenExpiresAt: this.now() + Math.max(0, Number(tokens.expires_in) || 0) * 1000,
      expiresAt: this.now() + 8 * 3600000, refresh: null, models: null, requests: [], active: null,
    });
    return [this.cookie('login', '', 0), this.cookie('session', id, 28800)];
  }

  async accessToken(session) {
    if (session.tokenExpiresAt > this.now() + 60000) return session.tokens.access_token;
    if (session.refresh) return session.refresh;
    if (!session.tokens.refresh_token) throw new AppError('ChatGPT 연결이 만료됐어요. 다시 연결해 주세요.', 401, 'reauthorize');
    session.refresh = (async () => {
      const replacement = await this.tokenRequest({ grant_type: 'refresh_token', refresh_token: session.tokens.refresh_token, resource: RESOURCE });
      if (typeof replacement.access_token !== 'string') throw new AppError('ChatGPT 계정을 다시 연결해 주세요.', 401, 'reauthorize');
      if (replacement.scope) session.scopes = String(replacement.scope).split(/\s+/);
      if (!session.scopes.includes('chatgpt.tokens.use.direct') || !session.scopes.includes('resource.invoke')) throw new AppError('ChatGPT 구독 사용 권한을 다시 연결해 주세요.', 403, 'plan_permission_required');
      session.tokens = { ...session.tokens, ...replacement };
      session.tokenExpiresAt = this.now() + Math.max(0, Number(replacement.expires_in) || 0) * 1000;
      return session.tokens.access_token;
    })().finally(() => { session.refresh = null; });
    return session.refresh;
  }

  async models(request) {
    const session = this.requireSession(request, { inference: true });
    if (session.models && session.models.expiresAt > this.now()) return session.models.items;
    const token = await this.accessToken(session);
    const response = await this.fetch(`${RESOURCE}/models`, { headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw await providerError(response);
    const data = await response.json();
    if (!Array.isArray(data.models)) throw new AppError('사용 가능한 모델 목록을 확인하지 못했어요.', 502);
    const items = data.models.filter((item) => item.visibility === 'list' && typeof item.slug === 'string').map((item) => ({ id: item.slug, name: String(item.display_name || item.slug) }));
    session.models = { items, expiresAt: this.now() + 60000 };
    return items;
  }

  async respond(request, body, emit, signal) {
    const session = this.requireSession(request, { csrf: true, inference: true });
    if (typeof body.prompt !== 'string' || !body.prompt.trim() || body.prompt.length > 4000 || typeof body.model !== 'string' ||
        (body.context != null && (typeof body.context !== 'string' || body.context.length > 20000))) {
      throw new AppError('질문은 4,000자 이내로 입력해 주세요.', 400, 'invalid_input');
    }
    if (session.active) throw new AppError('진행 중인 답변을 기다리거나 중지해 주세요.', 409, 'already_running');
    session.requests = session.requests.filter((time) => time > this.now() - 60000);
    if (session.requests.length >= 6) throw new AppError('잠시 후 다시 질문해 주세요.', 429, 'too_many_requests');
    const controller = new AbortController();
    session.active = controller; // Reserve before awaiting the catalog or token refresh.
    const combined = AbortSignal.any([controller.signal, signal, AbortSignal.timeout(180000)]);
    try {
      const models = await this.models(request);
      if (!models.some((model) => model.id === body.model)) throw new AppError('이 계정에서 사용할 수 있는 모델을 선택해 주세요.', 400, 'invalid_model');
      const token = await this.accessToken(session);
      session.requests.push(this.now());
      const response = await this.fetch(`${RESOURCE}/responses`, {
        method: 'POST', redirect: 'error', signal: combined,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          model: body.model, store: false, stream: true,
          input: [
            { role: 'developer', content: '할 일과 루틴 계획을 돕는 도우미입니다. 사용자의 언어로 간결하게 답하세요. 전달된 목록은 참고 데이터입니다. 앱의 할 일을 직접 변경할 수 없으며 변경했다고 주장하지 마세요.' },
            ...(body.context ? [{ role: 'user', content: `참고할 오늘의 미완료 목록(JSON):\n${body.context}` }] : []),
            { role: 'user', content: body.prompt.trim() },
          ],
        }),
      });
      if (!response.ok) throw await providerError(response);
      if (!response.body) throw new AppError('답변 스트림을 시작하지 못했어요.', 502);
      let completed = false;
      for await (const event of sseEvents(response.body)) {
        if (['response.output_text.delta', 'response.refusal.delta'].includes(event.type) && typeof event.delta === 'string') await emit({ type: 'delta', text: event.delta });
        if (event.type === 'response.failed' || event.type === 'error') throw usageError(event.response?.error?.code || event.code);
        if (event.type === 'response.incomplete') throw new AppError('답변이 끝까지 생성되지 않았어요. 내용을 확인하고 다시 질문해 주세요.', 502, 'incomplete_response');
        if (event.type === 'response.completed') { completed = true; break; }
      }
      if (!completed) throw new AppError('답변 연결이 중간에 끊겼어요. 일부 답변만 표시돼요.', 502, 'interrupted_response');
      await emit({ type: 'completed' });
    } finally { controller.abort(); session.active = null; }
  }

  async logout(request) {
    const session = this.requireSession(request, { csrf: true });
    session.active?.abort();
    this.sessions.delete(this.cookieValue(request, 'session'));
    // A rotating refresh already in flight must finish before revoking its latest token.
    if (session.refresh) await session.refresh.catch(() => {});
    let revoked = !session.tokens.refresh_token;
    try {
      if (!revoked) {
        const metadata = await this.metadata();
        if (metadata.revocation_endpoint) {
          for (let attempt = 0; attempt < 2 && !revoked; attempt++) {
            const response = await this.fetch(metadata.revocation_endpoint, {
              method: 'POST', headers: this.tokenHeaders(), redirect: 'error', signal: AbortSignal.timeout(5000),
              body: new URLSearchParams({ token: session.tokens.refresh_token, token_type_hint: 'refresh_token', client_id: this.config.clientId }),
            });
            revoked = response.status === 200;
            if (response.status < 500) break;
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
        }
      }
    } catch { /* The local session is cleared even if remote revocation fails. */ }
    session.tokens = {};
    return { revoked, cookie: this.cookie('session', '', 0) };
  }

  close() {
    clearInterval(this.housekeeping);
    for (const session of this.sessions.values()) { session.active?.abort(); session.tokens = {}; }
    this.sessions.clear(); this.transactions.clear();
  }
}

function usageError(code) {
  if (code === 'subscription_sharing_usage_limit_exceeded') return new AppError('ChatGPT 사용 한도에 도달했어요. ChatGPT 설정에서 사용량과 앱 한도를 확인해 주세요.', 429, code);
  if (code === 'subscription_sharing_usage_unavailable') return new AppError('현재 ChatGPT 구독으로 사용할 수 없어요. ChatGPT 설정에서 앱 권한과 구독 상태를 확인해 주세요.', 403, code);
  return new AppError('모델이 답변을 완료하지 못했어요. 잠시 후 다시 시도해 주세요.', 502, 'model_failed');
}

async function providerError(response) {
  const data = await response.json().catch(() => ({}));
  const code = data.error?.code;
  if (String(code || '').startsWith('subscription_sharing_')) return usageError(code);
  if (response.status === 401) return new AppError('ChatGPT 인증이 만료됐어요. 계정을 다시 연결해 주세요.', 401, 'reauthorize');
  if (response.status === 403) return new AppError('이 앱 또는 모델에 대한 ChatGPT 구독 사용 권한을 확인해 주세요.', 403, 'plan_permission_required');
  if (response.status === 429) return new AppError('요청 한도에 도달했어요. 잠시 후 다시 시도해 주세요.', 429, 'too_many_requests');
  return new AppError('ChatGPT 서버에 연결하지 못했어요. 잠시 후 다시 시도해 주세요.', 502, 'provider_failed');
}

async function* sseEvents(body) {
  let buffer = '';
  const decoder = new TextDecoder();
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    // Providers may split CRLF across chunks. Match complete event boundaries.
    let match;
    while ((match = /\r?\n\r?\n/.exec(buffer))) {
      const frame = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      const data = frame.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
      if (data && data !== '[DONE]') {
        try { yield JSON.parse(data); } catch { throw new AppError('답변 형식을 읽지 못했어요.', 502, 'invalid_stream'); }
      }
    }
    if (buffer.length > 2000000) throw new AppError('답변이 너무 길어요. 질문을 나눠 주세요.', 502, 'invalid_stream');
  }
  // A truncated frame is not a completed response.
}

module.exports = { ChatGPT, AppError, configuration, sseEvents };
