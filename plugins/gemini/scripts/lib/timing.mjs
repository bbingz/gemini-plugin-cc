// plugins/gemini/scripts/lib/timing.mjs

export class TimingAccumulator {
  constructor({ spawnedAt = Date.now(), prompt = "" } = {}) {
    this._t = {
      spawned: spawnedAt,
      firstEvent: null,
      firstToken: null,
      lastToken: null,
      close: null,
    };
    this._toolMs = 0;
    this._retryMs = 0;
    this._promptBytes = Buffer.byteLength(prompt || "", "utf8");
    this._responseBytes = 0;
    this._termination = { reason: "exit", exitCode: 0, signal: null, timedOut: false };
  }

  onFirstEvent(t = Date.now()) {
    if (this._t.firstEvent == null) this._t.firstEvent = t;
  }

  onFirstToken(t = Date.now()) {
    if (this._t.firstToken == null) this._t.firstToken = t;
  }

  onLastToken(t = Date.now()) {
    this._t.lastToken = t;
  }

  onClose(t = Date.now(), { exitCode = 0, timedOut = false, signal = null } = {}) {
    this._t.close = t;
    this._termination = {
      reason: timedOut ? "timeout" : signal ? "signal" : exitCode !== 0 ? "error" : "exit",
      exitCode,
      signal,
      timedOut,
    };
  }

  onToolUseStart(t = Date.now()) {
    this._toolStart = t;
  }

  onToolResult(t = Date.now()) {
    if (this._toolStart != null) {
      this._toolMs += t - this._toolStart;
      this._toolStart = null;
    }
  }

  onStartupStats(event) {
    if (event && Array.isArray(event.phases)) {
      this._coldStartPhases = event.phases.map((p) => ({
        phase: String(p.phase || "unknown"),
        ms: Number(p.ms) || 0,
      }));
    }
  }

  setRequestedModel(m) {
    this._requestedModel = m || null;
  }

  onResult(resultEvent) {
    if (this._usage) return;   // first-wins idempotence
    const stats = resultEvent?.stats || {};
    if (Array.isArray(stats.per_model_usage) && stats.per_model_usage.length > 0) {
      this._usage = stats.per_model_usage.map((u) => ({
        model: u.model ?? "unknown",
        input: u.input_token_count ?? 0,
        output: u.output_token_count ?? 0,
        thoughts: u.thoughts_token_count ?? 0,
      }));
    } else if (
      stats.input_token_count != null ||
      stats.output_token_count != null ||
      stats.thoughts_token_count != null
    ) {
      this._usage = [{
        model: this._requestedModel ?? "unknown",
        input: stats.input_token_count ?? 0,
        output: stats.output_token_count ?? 0,
        thoughts: stats.thoughts_token_count ?? 0,
      }];
    }
  }

  onRetryStart(t = Date.now()) {
    this._retryStart = t;
  }

  onRetryEnd(t = Date.now()) {
    if (this._retryStart != null) {
      const delta = t - this._retryStart;
      this._retryMs += delta;
      // Split bookkeeping: track retry time that occurred before firstToken
      if (this._t.firstToken == null) {
        this._retryMsBeforeFirstToken = (this._retryMsBeforeFirstToken || 0) + delta;
      }
      this._retryStart = null;
    }
  }

  recordResponseBytes(n) {
    this._responseBytes += n;
  }

  build() {
    const spawned = this._t.spawned;
    const close = this._t.close ?? Date.now();
    const firstEvent = this._t.firstEvent;
    const firstToken = this._t.firstToken;
    const lastToken = this._t.lastToken;

    const firstEventMs = firstEvent != null ? firstEvent - spawned : null;
    const rawTtft = firstToken != null && firstEvent != null ? firstToken - firstEvent : null;
    const ttftMs = rawTtft != null
      ? Math.max(0, rawTtft - (this._retryMsBeforeFirstToken || 0))
      : null;
    const rawStream = lastToken != null && firstToken != null ? lastToken - firstToken : 0;
    const retryMsAfterFirstToken = this._retryMs - (this._retryMsBeforeFirstToken || 0);
    const streamMs = Math.max(0, rawStream - this._toolMs - retryMsAfterFirstToken);
    const tailMs = lastToken != null ? Math.max(0, close - lastToken) : null;
    const totalMs = close - spawned;

    const usage = this._usage || [];
    const totalOutputAndThoughts = usage.reduce((s, u) => s + (u.output || 0) + (u.thoughts || 0), 0);
    const tokensPerSec = usage.length > 0 && streamMs > 0
      ? Math.round((totalOutputAndThoughts / (streamMs / 1000)) * 10) / 10
      : null;

    const sum = (firstEventMs || 0) + (ttftMs || 0) + streamMs + this._toolMs + this._retryMs + (tailMs || 0);
    const isCleanExit = this._termination.reason === "exit";
    const invariantOk = isCleanExit ? (sum === totalMs) : null;

    return {
      spawnedAt: new Date(spawned).toISOString(),
      firstEventMs,
      ttftMs,
      streamMs,
      toolMs: this._toolMs,
      retryMs: this._retryMs,
      tailMs,
      totalMs,
      promptBytes: this._promptBytes,
      responseBytes: this._responseBytes,
      exitCode: this._termination.exitCode,
      terminationReason: this._termination.reason,
      timedOut: this._termination.timedOut,
      signal: this._termination.signal,
      requestedModel: this._requestedModel || null,
      usage,
      tokensPerSec,
      coldStartPhases: this._coldStartPhases || null,
      invariantOk,
    };
  }
}

// ─── Render helpers ───────────────────────────────────────────────────────────

const BAR_FRAC = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];

export function renderBar(value, max, width) {
  if (!max || max <= 0 || value <= 0) return " ".repeat(width);
  const filled = Math.max(0, Math.min(width, (value / max) * width));
  const whole = Math.floor(filled);
  const frac = filled - whole;
  const fracChar = BAR_FRAC[Math.round(frac * 8)] || "";
  const usedWidth = whole + (fracChar ? 1 : 0);
  return "█".repeat(whole) + fracChar + " ".repeat(Math.max(0, width - usedWidth));
}

export function formatMs(ms) {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const min = Math.floor(ms / 60_000);
  const sec = Math.floor((ms % 60_000) / 1000);
  return `${min}m ${sec}s`;
}

export function renderStatusSummaryLine(timing) {
  if (!timing) return "—";
  const parts = [];
  if (timing.firstEventMs != null) parts.push(`cold ${formatMs(timing.firstEventMs)}`);
  if (timing.ttftMs != null)       parts.push(`ttft ${formatMs(timing.ttftMs)}`);
  if (timing.streamMs != null)     parts.push(`gen ${formatMs(timing.streamMs)}`);
  if (timing.toolMs > 0)           parts.push(`tool ${formatMs(timing.toolMs)}`);
  if (timing.retryMs > 0)          parts.push(`retry ${formatMs(timing.retryMs)}`);
  if (timing.tokensPerSec != null) parts.push(`${timing.tokensPerSec} tok/s`);
  return parts.join(" · ");
}
