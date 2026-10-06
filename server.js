const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { once } = require('node:events');
const { ChatGPT, AppError, configuration } = require('./chatgpt');
const { CodexUsage } = require('./codex-usage');

const root = __dirname;
const publicFiles = new Set(['index.html', 'styles.css', 'planner.css', 'app.js', 'preferences.js', 'routine-core.js', 'planner-core.js', 'planner.js', 'deadline-core.js', 'reminders.js', 'usage.js', 'chatgpt-ui.js', 'sw.js', 'sync-config.js', 'todo.webmanifest', 'favicon.svg', 'favicon-32.png', 'apple-touch-icon.png', 'todo-192.png', 'todo-512.png', 'todo-maskable-512.png']);
const contentTypes = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};

function json(response, data, status = 200) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(data));
}

async function readBody(request) {
  if (!String(request.headers['content-type'] || '').startsWith('application/json')) throw new AppError('JSON 요청이 필요합니다.', 415);
  if (Number(request.headers['content-length']) > 131072) throw new AppError('요청이 너무 큽니다.', 413);
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 131072) throw new AppError('요청이 너무 큽니다.', 413);
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || Array.isArray(body) || typeof body !== 'object') throw new Error();
    return body;
  } catch { throw new AppError('요청 내용을 읽지 못했습니다.', 400); }
}

function createAppServer({ chatgpt = new ChatGPT(), localUsage = process.env.TODO_USAGE_MODE === 'local-codex' ? new CodexUsage() : null } = {}) {
  const origin = new URL(chatgpt.config.origin);
  const local = ['localhost', '127.0.0.1'].includes(origin.hostname) && origin.protocol === 'http:';
  const allowedHosts = new Set([origin.host, ...(local ? [`localhost:${origin.port}`, `127.0.0.1:${origin.port}`] : [])]);

  const server = http.createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Frame-Options', 'DENY');
    let url;
    try { url = new URL(request.url, chatgpt.config.origin); } catch { response.writeHead(400).end('Bad request'); return; }
    const pathname = url.pathname;
    try {
      if (pathname.startsWith('/api/') || pathname.startsWith('/auth/')) {
        // Use the configured origin behind an HTTPS reverse proxy.
        // Never derive OAuth redirects from incoming or forwarded host headers.
        if (!allowedHosts.has(request.headers.host)) throw new AppError('허용되지 않은 서버 주소입니다.', 403);
        const requestOrigin = local ? `http://${request.headers.host}` : chatgpt.config.origin;
        if (request.headers.origin && request.headers.origin !== requestOrigin) throw new AppError('다른 사이트에서 요청할 수 없습니다.', 403);
        if (request.headers['sec-fetch-site'] === 'cross-site' && pathname !== '/auth/chatgpt/callback') throw new AppError('다른 사이트에서 요청할 수 없습니다.', 403);
        if (request.method === 'POST' && request.headers.origin !== requestOrigin) throw new AppError('페이지에서 다시 요청해 주세요.', 403);
        const methods = {
          '/api/usage': 'GET', '/api/chatgpt/session': 'GET', '/api/chatgpt/models': 'GET',
          '/api/chatgpt/respond': 'POST', '/api/chatgpt/logout': 'POST',
          '/auth/chatgpt/start': 'POST', '/auth/chatgpt/callback': 'GET',
        };
        if (!methods[pathname]) { json(response, { error: 'Not found' }, 404); return; }
        if (request.method !== methods[pathname]) { response.setHeader('Allow', methods[pathname]); json(response, { error: 'Method not allowed' }, 405); return; }

        if (pathname === '/api/chatgpt/session') { json(response, { ...chatgpt.status(request), authOrigin: chatgpt.config.origin }); return; }
        if (pathname === '/auth/chatgpt/start') {
          if (request.headers.host !== origin.host) throw new AppError(`ChatGPT 연결은 ${chatgpt.config.origin}에서 진행해 주세요.`, 400);
          const result = await chatgpt.begin();
          response.setHeader('Set-Cookie', result.cookie);
          json(response, { authorizationUrl: result.authorizationUrl }); return;
        }
        if (pathname === '/auth/chatgpt/callback') {
          try {
            const cookies = await chatgpt.callback(request, url);
            response.setHeader('Set-Cookie', cookies);
            response.writeHead(303, { Location: '/?chatgpt=connected', 'Cache-Control': 'no-store' }).end();
          } catch (error) {
            response.setHeader('Set-Cookie', chatgpt.cookie('login', '', 0));
            const allowed = new Set(['invalid_state', 'access_denied', 'invalid_identity', 'reauthorize']);
            const code = allowed.has(error.code) ? error.code : 'connection_failed';
            response.writeHead(303, { Location: `/?chatgpt=${code}`, 'Cache-Control': 'no-store' }).end();
          }
          return;
        }
        if (pathname === '/api/chatgpt/models') { json(response, { models: await chatgpt.models(request) }); return; }
        if (pathname === '/api/chatgpt/logout') {
          const result = await chatgpt.logout(request);
          response.setHeader('Set-Cookie', result.cookie);
          json(response, { disconnected: true, revoked: result.revoked }); return;
        }
        if (pathname === '/api/chatgpt/respond') {
          chatgpt.requireSession(request, { csrf: true, inference: true });
          const body = await readBody(request);
          const controller = new AbortController();
          const disconnected = () => controller.abort();
          response.on('close', disconnected);
          const emit = async (event) => {
            if (controller.signal.aborted) return;
            if (!response.headersSent) response.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
            if (!response.write(`${JSON.stringify(event)}\n`)) await once(response, 'drain', { signal: controller.signal });
          };
          try { await chatgpt.respond(request, body, emit, controller.signal); }
          catch (error) {
            if (controller.signal.aborted) return;
            if (!response.headersSent) throw error;
            await emit({ type: 'error', error: publicError(error), code: error.code || 'request_failed' });
          } finally { response.removeListener('close', disconnected); }
          response.end(); return;
        }
        if (pathname === '/api/usage') {
          if (localUsage) {
            if (!local) throw new AppError('로컬 계정 사용량은 localhost에서만 조회할 수 있습니다.', 403);
            const data = await localUsage.read({ force: url.searchParams.get('refresh') === '1' });
            json(response, { ...data, source: 'local-codex', pollable: true });
          } else {
            const connected = chatgpt.status(request).connected;
            json(response, {
              available: false, pollable: false, source: 'chatgpt', code: connected ? 'usage_not_supported' : 'sign_in_required',
              error: connected ? '연결한 ChatGPT 계정의 잔여 사용량을 이 앱에서 조회할 수 없어요. ChatGPT 설정에서 확인해 주세요.' : 'GPT 도우미에서 ChatGPT 계정을 연결해 주세요. 잔여 사용량은 조회 지원이 확인되면 표시해요.',
              checkedAt: Date.now(),
            });
          }
          return;
        }
      }

      if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405, { Allow: 'GET, HEAD' }).end(); return; }
      const relativePath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
      if (!publicFiles.has(relativePath)) { response.writeHead(404).end('Not found'); return; }
      fs.readFile(path.join(root, relativePath), (error, content) => {
        if (error) { response.writeHead(error.code === 'ENOENT' ? 404 : 500).end('Not found'); return; }
        response.writeHead(200, { 'Content-Type': contentTypes[path.extname(relativePath)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
        response.end(request.method === 'HEAD' ? undefined : content);
      });
    } catch (error) {
      if (!response.destroyed && !response.headersSent) json(response, { error: publicError(error), code: error.code || 'request_failed' }, error instanceof AppError ? error.status : 500);
    }
  });
  server.on('close', () => { chatgpt.close(); localUsage?.close(); });
  return server;
}

function publicError(error) {
  if (error instanceof AppError) return error.message;
  if (['TimeoutError', 'AbortError'].includes(error.name)) return '응답 시간이 초과됐어요. 잠시 후 다시 시도해 주세요.';
  return '연결에 실패했어요. 잠시 후 다시 시도해 주세요.';
}

if (require.main === module) {
  // Supports .env without a dependency; shell variables retain priority.
  const envFile = path.join(root, '.env');
  if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
  const config = configuration();
  const port = Number(process.env.PORT || 4173);
  const host = process.env.TODO_HOST || '127.0.0.1';
  if (process.env.TODO_USAGE_MODE === 'local-codex' && (!['127.0.0.1', 'localhost'].includes(host) || config.origin.startsWith('https:'))) throw new Error('로컬 Codex 사용량 모드는 localhost에서만 사용할 수 있습니다.');
  const server = createAppServer({ chatgpt: new ChatGPT({ config }) }).listen(port, host, () => console.log(`Todo app running at ${config.origin}`));
  const shutdown = () => { server.close(); server.closeAllConnections(); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { createAppServer, readBody };
