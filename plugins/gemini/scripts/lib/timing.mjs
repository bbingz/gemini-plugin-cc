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
    const ttftMs = firstToken != null && firstEvent != null ? firstToken - firstEvent : null;
    const rawStream = lastToken != null && firstToken != null ? lastToken - firstToken : 0;
    const streamMs = Math.max(0, rawStream - this._toolMs - this._retryMs);
    const tailMs = lastToken != null ? Math.max(0, close - lastToken) : null;
    const totalMs = close - spawned;

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
      // Filled by later tasks:
      requestedModel: null,
      usage: [],
      tokensPerSec: null,
      coldStartPhases: null,
    };
  }
}
