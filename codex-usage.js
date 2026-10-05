const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

// Only account metadata is requested. No threads or model turns are started.
class CodexUsage {
  constructor({ spawnProcess = spawn, timeout = 12000, cacheMs = 25000 } = {}) {
    this.spawnProcess = spawnProcess;
    this.timeout = timeout;
    this.cacheMs = cacheMs;
    this.pending = new Map();
    this.nextId = 0;
    this.cached = null;
    this.inflight = null;
    this.process = null;
    this.ready = null;
  }

  request(method, params = null) {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('사용량 조회 시간이 초과됐어요. 잠시 후 다시 시도해 주세요.'));
      }, this.timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.process.stdin.write(`${JSON.stringify({ id, method, params })}\n`, (error) => {
        if (!error) return;
        const item = this.pending.get(id);
        if (item) { clearTimeout(item.timer); this.pending.delete(id); item.reject(new Error('Codex 연결이 끊겼어요. 다시 시도해 주세요.')); }
      });
    });
  }

  async connect() {
    if (this.ready) return this.ready;
    const localBin = path.join(os.homedir(), '.local', 'bin', 'codex');
    const binary = process.env.TODO_CODEX_BIN || (fs.existsSync(localBin) ? localBin : 'codex');
    const child = this.spawnProcess(binary, ['app-server', '--listen', 'stdio://'], { cwd: __dirname, stdio: ['pipe', 'pipe', 'pipe'] });
    this.process = child;
    // Diagnostics can contain account details; never send raw logs to the browser.
    child.stderr.on('data', () => {});
    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.id != null && message.method) {
        child.stdin.write(`${JSON.stringify({ id: message.id, error: { code: -32601, message: 'Unsupported method' } })}\n`);
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error('사용량을 가져오지 못했어요. 터미널에서 codex login으로 ChatGPT 계정 로그인을 확인해 주세요.'));
      else pending.resolve(message.result || {});
    });
    const disconnected = (error) => {
      if (this.process !== child) return;
      this.process = null;
      this.ready = null;
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
      this.pending.clear();
      lines.close();
    };
    child.on('error', () => disconnected(new Error('Codex CLI를 찾을 수 없어요. codex 설치 또는 TODO_CODEX_BIN 설정을 확인해 주세요.')));
    child.on('exit', () => disconnected(new Error('Codex 연결이 종료됐어요. 새로고침해 주세요.')));
    child.stdin.on('error', () => {});
    this.ready = this.request('initialize', { clientInfo: { name: 'today_todo_usage', title: 'Today Todo Usage', version: '1.0.0' } }).then(() => {
      child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
    }).catch((error) => { this.close(); throw error; });
    return this.ready;
  }

  async read({ force = false } = {}) {
    if (!force && this.cached && Date.now() - this.cached.checkedAt < this.cacheMs) return this.cached;
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      try {
        let result;
        if (process.env.TODO_USAGE_STATUS_URL) {
          const response = await fetch(process.env.TODO_USAGE_STATUS_URL, { signal: AbortSignal.timeout(this.timeout) });
          if (!response.ok) throw new Error('대시보드 사용량 조회에 실패했어요. 서버 주소와 실행 상태를 확인해 주세요.');
          const data = await response.json();
          if (!data.available) throw new Error('대시보드에서 사용량을 가져오지 못했어요. Codex 로그인 상태를 확인해 주세요.');
          result = { rateLimits: data.rate_limits, rateLimitsByLimitId: data.rate_limits_by_id };
        } else {
          await this.connect();
          result = await this.request('account/rateLimits/read');
        }
        this.cached = { available: true, ...normalizeLimits(result), checkedAt: Date.now() };
      } catch (error) {
        const message = error.name === 'TimeoutError' ? '사용량 조회 시간이 초과됐어요.' : error.message;
        this.cached = { available: false, error: message.startsWith('사용량') || message.startsWith('Codex') || message.startsWith('대시보드') ? message : '사용량 조회에 실패했어요. 네트워크와 Codex 로그인을 확인해 주세요.', checkedAt: Date.now() };
      }
      return this.cached;
    })().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  close() {
    const child = this.process;
    this.process = null;
    this.ready = null;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('Codex 연결이 종료됐어요.')); }
    this.pending.clear();
    child?.kill();
  }
}

function normalizeLimits(result) {
  const groups = result.rateLimitsByLimitId && Object.keys(result.rateLimitsByLimitId).length ? result.rateLimitsByLimitId : { codex: result.rateLimits };
  const windows = [];
  for (const [id, group] of Object.entries(groups)) {
    if (!group) continue;
    for (const type of ['primary', 'secondary']) {
      const window = group[type];
      if (!window || window.usedPercent == null || !Number.isFinite(Number(window.usedPercent))) continue;
      windows.push({ id: `${id}-${type}`, name: String(group.limitName || id), remainingPercent: Math.max(0, Math.min(100, 100 - Number(window.usedPercent))), windowMinutes: Number(window.windowDurationMins) || null, resetsAt: Number(window.resetsAt) || null });
    }
  }
  return { windows };
}

module.exports = { CodexUsage, normalizeLimits };
