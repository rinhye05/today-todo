const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { CodexUsage, normalizeLimits } = require('../codex-usage');

test('usage supports multiple buckets, clamps percentages, and omits account data', () => {
  const result = normalizeLimits({ rateLimitsByLimitId: {
    codex: { primary: { usedPercent: 24, windowDurationMins: 300, resetsAt: 1790000000 }, secondary: { usedPercent: 105, windowDurationMins: 10080 } },
    other: { limitName: 'Other', primary: { usedPercent: -5 }, secondary: { usedPercent: 'invalid' } },
  }, secret: 'must not appear' });
  assert.equal(result.windows.length, 3);
  assert.deepEqual(result.windows.map((window) => window.remainingPercent), [76, 0, 100]);
  assert.equal(result.windows[0].windowMinutes, 300);
  assert.equal(JSON.stringify(result).includes('secret'), false);
});

test('older single-bucket responses and absent windows are handled', () => {
  assert.equal(normalizeLimits({ rateLimits: { primary: { usedPercent: 12 } } }).windows[0].remainingPercent, 88);
  assert.deepEqual(normalizeLimits({}).windows, []);
  assert.deepEqual(normalizeLimits({ rateLimits: { primary: {} } }).windows, []);
});

function mockProcess(handler) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new Writable({ write(chunk, encoding, callback) {
    const message = JSON.parse(String(chunk));
    if (message.id) handler(message, (result) => child.stdout.write(`${JSON.stringify({ id: message.id, result })}\n`));
    callback();
  } });
  child.kill = () => { child.stdout.end(); child.emit('exit', 0); };
  return child;
}

test('concurrent reads share a process/request and reuse the cached snapshot', async () => {
  const methods = [];
  let starts = 0;
  const client = new CodexUsage({ spawnProcess: () => {
    starts++;
    return mockProcess((message, reply) => {
      methods.push(message.method);
      setImmediate(() => reply(message.method === 'initialize' ? {} : { rateLimits: { primary: { usedPercent: 40 } } }));
    });
  } });
  try {
    const [first, second] = await Promise.all([client.read(), client.read()]);
    assert.equal(first.available, true);
    assert.equal(first.windows[0].remainingPercent, 60);
    assert.equal(first, second);
    assert.equal(await client.read(), first);
    assert.equal(starts, 1);
    assert.deepEqual(methods, ['initialize', 'account/rateLimits/read']);
    const forced = await client.read({ force: true });
    assert.equal(forced.available, true);
    assert.equal(starts, 1);
    assert.deepEqual(methods, ['initialize', 'account/rateLimits/read', 'account/rateLimits/read']);
  } finally { client.close(); }
});

test('CLI startup failures become actionable messages without raw diagnostics', async () => {
  const client = new CodexUsage({ spawnProcess: () => {
    const child = mockProcess(() => {});
    setImmediate(() => child.emit('error', Object.assign(new Error('private diagnostic'), { code: 'ENOENT' })));
    return child;
  } });
  const result = await client.read();
  assert.equal(result.available, false);
  assert.match(result.error, /Codex CLI/);
  assert.equal(result.error.includes('private diagnostic'), false);
  client.close();
});

test('an unresponsive app-server times out rather than hanging the HTTP request', async () => {
  const client = new CodexUsage({ spawnProcess: () => mockProcess(() => {}), timeout: 20 });
  const result = await client.read();
  assert.equal(result.available, false);
  assert.match(result.error, /시간이 초과/);
  client.close();
});
