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
    // Flush an in-flight retry window (otherwise retry time is lost to tail/other)
    if (this._retryStart != null) {
      this.onRetryEnd(t);
    }
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
    if (this._requestedModel) return;  // first-wins
    if (m) this._requestedModel = m;
  }

  onResult(resultEvent) {
    if (this._usage) return;  // first-wins idempotence
    const stats = resultEvent?.stats || {};

    // Preferred: stats.models is an object keyed by model name
    if (stats.models && typeof stats.models === "object" && !Array.isArray(stats.models)) {
      const entries = Object.entries(stats.models);
      if (entries.length > 0) {
        this._usage = entries.map(([modelName, m]) => ({
          model: modelName,
          input: m?.input_tokens ?? 0,
          output: m?.output_tokens ?? 0,
          thoughts: m?.thoughts_token_count ?? 0,  // not emitted by v0.37.1; forward-compat
        }));
        return;
      }
    }

    // Fallback: flat stats fields (rare, older CLIs)
    if (stats.input_tokens != null || stats.output_tokens != null) {
      this._usage = [{
        model: this._requestedModel ?? "unknown",
        input: stats.input_tokens ?? 0,
        output: stats.output_tokens ?? 0,
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

function formatBytes(n) {
  if (n == null) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function renderSingleJobDetail({ job, timing }) {
  if (!timing) {
    return `Job ${job?.id || "?"} has no timing data.`;
  }
  const lines = [];
  lines.push(`Job ${job?.id || "?"} · ${job?.kind || "?"} · ${job?.status || "?"}`);
  lines.push(`  Prompt      ${formatBytes(timing.promptBytes)}`);
  lines.push(`  Response    ${formatBytes(timing.responseBytes)}`);
  lines.push(`  Requested   ${timing.requestedModel || "—"}`);
  if (timing.usage && timing.usage.length > 0) {
    for (const u of timing.usage) {
      const toks = (u.output + u.thoughts) / 1000;
      lines.push(`  Actual      ${u.model}  (${toks.toFixed(0)}K tok)`);
    }
    if (timing.usage.length > 1) {
      lines.push(`              ⚠ silent fallback detected`);
    }
  }
  lines.push("");

  const segs = [
    ["cold",  timing.firstEventMs],
    ["ttft",  timing.ttftMs],
    ["gen",   timing.streamMs],
    ["tool",  timing.toolMs],
    ["retry", timing.retryMs],
    ["tail",  timing.tailMs],
  ].filter(([, v]) => v != null && v >= 0);
  const total = timing.totalMs || 0;

  for (const [name, ms] of segs) {
    const bar = renderBar(ms, total, 20);
    const pct = total > 0 ? ((ms / total) * 100).toFixed(1) : "0.0";
    lines.push(`  ${name.padEnd(6)} ${bar}  ${formatMs(ms).padStart(8)}  (${pct.padStart(4)}%)`);
  }
  lines.push("  " + "─".repeat(36));
  lines.push(`  total  ${" ".repeat(20)}  ${formatMs(total).padStart(8)}   100%`);
  lines.push("");
  if (timing.tokensPerSec != null) {
    lines.push(`  Throughput: ${timing.tokensPerSec} tok/s  (includes thoughts)`);
  }
  if (timing.coldStartPhases && timing.coldStartPhases.length > 0) {
    const parts = timing.coldStartPhases.map((p) => `${p.phase} ${formatMs(p.ms)}`).join(" · ");
    lines.push(`  Cold-start breakdown: ${parts}`);
  }
  return lines.join("\n");
}

// ─── Aggregate helpers ────────────────────────────────────────────────────────

export function percentile(values, p) {
  const filtered = values.filter((v) => v != null && typeof v === "number");
  if (filtered.length === 0) return null;
  const sorted = filtered.slice().sort((a, b) => a - b);
  const rank = Math.ceil(p * sorted.length);
  const idx = Math.max(0, Math.min(sorted.length - 1, rank - 1));
  return sorted[idx];
}

const PERCENTILE_CUTOFFS = {
  p50: 1,
  p95: 20,
  p99: 100,
};

export function computeAggregateStats(records) {
  const n = records.length;
  const pick = (key) => records.map((r) => r.timing?.[key]);
  const allPercentiles = ["p50", "p95", "p99"];
  const metrics = ["firstEventMs", "ttftMs", "streamMs", "toolMs", "retryMs", "totalMs"];

  const percentiles = {};
  for (const p of allPercentiles) {
    if (n < PERCENTILE_CUTOFFS[p]) {
      percentiles[p] = null;
      continue;
    }
    const row = {};
    for (const m of metrics) {
      row[m] = percentile(pick(m), Number(p.slice(1)) / 100);
    }
    percentiles[p] = row;
  }

  // Slowest
  let slowest = null;
  for (const r of records) {
    const total = r.timing?.totalMs || 0;
    if (!slowest || total > slowest.totalMs) {
      slowest = {
        jobId: r.jobId || r.job?.id,
        totalMs: total,
        fallback: Array.isArray(r.timing?.usage) && r.timing.usage.length > 1,
      };
    }
  }

  // Fallback rate
  let fallbackCount = 0;
  for (const r of records) {
    if (Array.isArray(r.timing?.usage) && r.timing.usage.length > 1) fallbackCount++;
  }
  const fallbackRate = n > 0 ? Math.round((fallbackCount / n) * 1000) / 1000 : 0;

  return { n, percentiles, slowest, fallbackRate };
}

export function renderAggregateTable(stats, { kind = "all" } = {}) {
  const lines = [];
  lines.push(`${kind} (n=${stats.n})`);
  lines.push(`                   cold        ttft        gen         tool        retry       total`);
  for (const p of ["p50", "p95", "p99"]) {
    const row = stats.percentiles[p];
    if (!row) {
      lines.push(`  ${p.padEnd(14)}  —           —           —           —           —           —`);
      continue;
    }
    const cells = ["firstEventMs", "ttftMs", "streamMs", "toolMs", "retryMs", "totalMs"]
      .map((m) => formatMs(row[m]).padEnd(12))
      .join("");
    lines.push(`  ${p.padEnd(14)}  ${cells}`);
  }
  if (stats.slowest) {
    const fb = stats.slowest.fallback ? " · fallback" : "";
    lines.push(`  slowest         ${stats.slowest.jobId} · ${formatMs(stats.slowest.totalMs)}${fb}`);
  }
  lines.push(`  fallback rate   ${(stats.fallbackRate * 100).toFixed(1)}%`);
  return lines.join("\n");
}

export function filterHistory(records, { kind, last, since } = {}) {
  let out = records.slice();
  if (kind) out = out.filter((r) => r.kind === kind);
  if (since) out = out.filter((r) => r.ts && r.ts >= since);
  // Newest first
  out.sort((a, b) => (b.ts || "").localeCompare(a.ts || ""));
  if (last) out = out.slice(0, last);
  return out;
}

export function renderHistoryTable(rows) {
  const lines = [];
  lines.push("id              kind    total      cold    ttft    gen     tool    retry   tok/s   fb   completedAt");
  for (const r of rows) {
    const t = r.timing || {};
    const fb = (t.usage?.length || 0) > 1 ? "!" : " ";
    lines.push([
      (r.jobId || "?").padEnd(16),
      (r.kind || "?").padEnd(8),
      formatMs(t.totalMs).padEnd(10),
      formatMs(t.firstEventMs).padEnd(8),
      formatMs(t.ttftMs).padEnd(8),
      formatMs(t.streamMs).padEnd(8),
      formatMs(t.toolMs).padEnd(8),
      formatMs(t.retryMs).padEnd(8),
      (t.tokensPerSec != null ? `${t.tokensPerSec}` : "—").padEnd(8),
      fb,
      "  ",
      (r.ts || "—").slice(0, 19),
    ].join(""));
  }
  return lines.join("\n");
}
