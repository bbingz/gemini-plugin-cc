import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { binaryAvailable, runCommand } from "./process.mjs";
import { TimingAccumulator, dispatchTimingEvent } from "./timing.mjs";

const DEFAULT_TIMEOUT_MS = 300_000;
const AUTH_CHECK_TIMEOUT_MS = 30_000;

// ── Engram sidecar ─────────────────────────────────────

const PARENT_SESSION_ENV = "GEMINI_COMPANION_SESSION_ID";

/**
 * Resolve the Gemini CLI project name for a given cwd by reading
 * ~/.gemini/projects.json and finding the longest matching prefix.
 * Returns null if no match is found.
 */
function resolveGeminiProjectName(cwd) {
  try {
    const projectsPath = path.join(os.homedir(), ".gemini", "projects.json");
    const { projects } = JSON.parse(fs.readFileSync(projectsPath, "utf8"));
    if (!projects) return null;

    let bestMatch = null;
    let bestLen = 0;
    const resolved = path.resolve(cwd || process.cwd());
    for (const [dir, name] of Object.entries(projects)) {
      const rdir = path.resolve(dir);
      if ((resolved === rdir || resolved.startsWith(rdir + path.sep)) && rdir.length > bestLen) {
        bestMatch = name;
        bestLen = rdir.length;
      }
    }
    return bestMatch;
  } catch {
    return null;
  }
}

/**
 * Write an Engram sidecar file next to the Gemini session file so that
 * Engram can deterministically link this session back to its Claude Code parent.
 *
 * Fail-open: errors are silently ignored to never affect the main flow.
 */
function writeEngramSidecar(sessionId, cwd) {
  try {
    if (!sessionId) return;
    const projectName = resolveGeminiProjectName(cwd);
    if (!projectName) return;

    const chatsDir = path.join(os.homedir(), ".gemini", "tmp", projectName, "chats");
    // Ensure chats directory exists (Gemini CLI may not have created it yet for fast calls)
    fs.mkdirSync(chatsDir, { recursive: true });

    const sidecarPath = path.join(chatsDir, `${sessionId}.engram.json`);
    fs.writeFileSync(sidecarPath, JSON.stringify({
      originator: "claude-code",
      parentSessionId: process.env[PARENT_SESSION_ENV] || null,
      createdAt: new Date().toISOString(),
    }));
  } catch {
    // Write failure must not affect main flow
  }
}

// ── Gemini CLI settings ─────────────────────────────────

let _cachedSettingsModel = undefined;

/**
 * Read the default model from ~/.gemini/settings.json.
 * Cached after first read to avoid repeated disk I/O.
 */
function getSettingsModel() {
  if (_cachedSettingsModel !== undefined) return _cachedSettingsModel;
  try {
    const settingsPath = path.join(os.homedir(), ".gemini", "settings.json");
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    _cachedSettingsModel = settings?.model?.name || null;
  } catch {
    _cachedSettingsModel = null;
  }
  return _cachedSettingsModel;
}

// ── Shared argument builder ─────────────────────────────

function buildGeminiArgs({ prompt, model, approvalMode, outputFormat, resumeSessionId, extraArgs }) {
  const useStdin = prompt.length > 100_000;
  const args = ["-p", useStdin ? "" : prompt, "-o", outputFormat];
  // Always pass -m to prevent modelSteering from overriding
  const effectiveModel = model || getSettingsModel();
  if (effectiveModel) args.push("-m", effectiveModel);
  args.push("--approval-mode", approvalMode);
  if (resumeSessionId) args.push("--resume", resumeSessionId);
  if (extraArgs?.length) args.push(...extraArgs);
  return { args, useStdin };
}

// ── Synchronous call (existing) ─────────────────────────

/**
 * Call Gemini CLI in headless mode and return a structured result.
 *
 * stdout may contain a noise prefix (e.g. "MCP issues detected...") before
 * the JSON payload, so we locate the first `{` and parse from there.
 */
export function callGemini({
  prompt,
  model,
  approvalMode = "plan",
  cwd,
  timeout = DEFAULT_TIMEOUT_MS,
  extraArgs = [],
  resumeSessionId = null,
}) {
  const { args, useStdin } = buildGeminiArgs({
    prompt, model, approvalMode, outputFormat: "json", resumeSessionId, extraArgs,
  });

  const result = runCommand("gemini", args, {
    cwd,
    timeout,
    input: useStdin ? prompt : undefined,
  });

  if (result.error) {
    const msg = result.error.code === "ETIMEDOUT"
      ? `Gemini timed out after ${Math.round(timeout / 1000)}s. Try a smaller scope.`
      : result.error.message;
    return { ok: false, error: msg };
  }

  // stdout may have a noise prefix; find the first `{` for JSON
  const stdout = result.stdout || "";
  const jsonStart = stdout.indexOf("{");
  if (jsonStart < 0) {
    // No JSON on stdout — check stderr for a JSON error object
    return parseStderrError(result.stderr, result.status);
  }

  try {
    const parsed = JSON.parse(stdout.slice(jsonStart));
    if (parsed.error) {
      return {
        ok: false,
        error: parsed.error.message,
        code: parsed.error.code,
      };
    }
    const syncResult = {
      ok: true,
      response: parsed.response,
      sessionId: parsed.session_id,
      stats: parsed.stats,
    };
    writeEngramSidecar(syncResult.sessionId, cwd);
    return syncResult;
  } catch (e) {
    return { ok: false, error: `JSON parse failed: ${e.message}` };
  }
}

/**
 * Parse a JSON error object from stderr.  Gemini writes a stack trace
 * followed by a JSON `{ session_id, error }` object on failure.
 */
function parseStderrError(stderr, exitCode) {
  const text = stderr || "";
  // Find the first `{` that parses as valid JSON with an error field
  let idx = 0;
  while ((idx = text.indexOf("{", idx)) >= 0) {
    try {
      const errObj = JSON.parse(text.slice(idx));
      if (errObj.error) {
        return {
          ok: false,
          error: errObj.error.message,
          code: errObj.error.code,
        };
      }
      break; // valid JSON but no error field
    } catch {
      idx += 1;
    }
  }
  return {
    ok: false,
    error: `gemini exited with code ${exitCode}`,
    stderr: text,
  };
}

// ── Streaming call (async) ───────────────────────────────

/**
 * Call Gemini CLI in streaming mode (-o stream-json).
 * Returns a Promise resolving to the same { ok, response, sessionId, stats } shape.
 *
 * @param {Object} options
 * @param {function} options.onEvent - Called for each parsed NDJSON event
 *   Event types: { type: "init", session_id, model }
 *                { type: "message", role, content, delta? }
 *                { type: "result", status, stats }
 */
export function callGeminiStreaming({
  prompt,
  model,
  approvalMode = "plan",
  cwd,
  timeout = DEFAULT_TIMEOUT_MS,
  extraArgs = [],
  resumeSessionId = null,
  onEvent = () => {},
}) {
  const { args, useStdin } = buildGeminiArgs({
    prompt, model, approvalMode, outputFormat: "stream-json", resumeSessionId, extraArgs,
  });

  const timing = new TimingAccumulator({ spawnedAt: Date.now(), prompt });
  const effectiveModelName = model || getSettingsModel();
  if (effectiveModelName) timing.setRequestedModel(effectiveModelName);

  return new Promise((resolve) => {
    const child = spawn("gemini", args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        GEMINI_TELEMETRY_ENABLED: "1",
        GEMINI_CLI_TELEMETRY: "1",
      },
    });

    let sessionId = null;
    let stats = null;
    let responseChunks = [];
    let stderrBuf = "";
    let lineBuffer = "";
    let timedOut = false;
    const decoder = new StringDecoder("utf8");

    // Timeout handler
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
    }, timeout);

    // Write large prompt via stdin
    if (useStdin) {
      child.stdin.write(prompt);
    }
    child.stdin.end();

    // Parse NDJSON lines from stdout, handling noise prefixes and partial chunks
    child.stdout.on("data", (chunk) => {
      lineBuffer += decoder.write(chunk);
      let newlineIdx;
      while ((newlineIdx = lineBuffer.indexOf("\n")) >= 0) {
        const rawLine = lineBuffer.slice(0, newlineIdx);
        lineBuffer = lineBuffer.slice(newlineIdx + 1);
        processLine(rawLine);
      }
    });

    child.stderr.on("data", (chunk) => {
      stderrBuf += chunk.toString();
    });

    function processLine(raw) {
      // Find first `{` on this line — skip any noise prefix
      const jsonStart = raw.indexOf("{");
      if (jsonStart < 0) return;

      let event;
      try {
        event = JSON.parse(raw.slice(jsonStart));
      } catch {
        return; // Not valid JSON — skip
      }

      dispatchTimingEvent(event, timing);

      try { onEvent(event); } catch { /* callback errors don't break us */ }

      // Closure-state side effects (NOT timing-related)
      if (event.type === "init") {
        sessionId = event.session_id || null;
      } else if (event.type === "message" && event.role === "assistant" && event.content != null) {
        responseChunks.push(event.content);
      } else if (event.type === "result") {
        stats = event.stats || null;
      }
    }

    child.on("close", (exitCode) => {
      clearTimeout(timer);

      // Flush decoder and process any remaining data
      lineBuffer += decoder.end();
      if (lineBuffer.trim()) {
        processLine(lineBuffer);
        lineBuffer = "";
      }

      timing.onClose(Date.now(), {
        exitCode,
        timedOut,
        signal: child.signalCode || null,
      });

      if (timedOut) {
        resolve({
          ok: false,
          error: `Gemini timed out after ${Math.round(timeout / 1000)}s. Try a smaller scope.`,
          timing: timing.build(),
        });
        return;
      }

      if (exitCode !== 0) {
        const stderrResult = parseStderrError(stderrBuf, exitCode);
        // Include partial response for recovery if available
        if (responseChunks.length > 0) {
          stderrResult.partialResponse = responseChunks.join("");
        }
        stderrResult.timing = timing.build();
        resolve(stderrResult);
        return;
      }

      // Build final response from accumulated assistant deltas
      const response = responseChunks.join("");

      writeEngramSidecar(sessionId, cwd);
      resolve({
        ok: true,
        response,
        sessionId,
        stats,
        timing: timing.build(),
      });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, error: err.message });
    });
  });
}

// ── Utilities ───────────────────────────────────────────

/**
 * Get Gemini CLI availability (binary + version).
 */
export function getGeminiAvailability(cwd) {
  return binaryAvailable("gemini", ["-v"], { cwd });
}

/**
 * Check whether Gemini is authenticated:
 * 1. OAuth credentials file exists
 * 2. A short test call succeeds
 */
export function getGeminiAuthStatus(cwd) {
  // Test-call directly — works for both OAuth and API key auth
  const test = callGemini({
    prompt: "ping",
    approvalMode: "plan",
    cwd,
    timeout: AUTH_CHECK_TIMEOUT_MS,
  });

  if (!test.ok) {
    return { loggedIn: false, detail: test.error };
  }

  return {
    loggedIn: true,
    detail: "authenticated",
    model: Object.keys(test.stats?.models || {})[0] || "unknown",
  };
}
