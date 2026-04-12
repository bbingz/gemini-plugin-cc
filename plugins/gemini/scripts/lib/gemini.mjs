import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { binaryAvailable, runCommand } from "./process.mjs";

const DEFAULT_TIMEOUT_MS = 300_000;
const AUTH_CHECK_TIMEOUT_MS = 30_000;

// ── Shared argument builder ─────────────────────────────

function buildGeminiArgs({ prompt, model, approvalMode, outputFormat, resumeSessionId, extraArgs }) {
  const useStdin = prompt.length > 100_000;
  const args = ["-p", useStdin ? "" : prompt, "-o", outputFormat];
  if (model) args.push("-m", model);
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
    return {
      ok: true,
      response: parsed.response,
      sessionId: parsed.session_id,
      stats: parsed.stats,
    };
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

  return new Promise((resolve) => {
    const child = spawn("gemini", args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
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

      try { onEvent(event); } catch { /* callback errors don't break us */ }

      if (event.type === "init") {
        sessionId = event.session_id || null;
      } else if (event.type === "message" && event.role === "assistant") {
        if (event.content != null) {
          responseChunks.push(event.content);
        }
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

      if (timedOut) {
        resolve({
          ok: false,
          error: `Gemini timed out after ${Math.round(timeout / 1000)}s. Try a smaller scope.`,
        });
        return;
      }

      if (exitCode !== 0) {
        const stderrResult = parseStderrError(stderrBuf, exitCode);
        // Include partial response for recovery if available
        if (responseChunks.length > 0) {
          stderrResult.partialResponse = responseChunks.join("");
        }
        resolve(stderrResult);
        return;
      }

      // Build final response from accumulated assistant deltas
      const response = responseChunks.join("");

      resolve({
        ok: true,
        response,
        sessionId,
        stats,
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
