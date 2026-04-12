import { binaryAvailable, runCommand } from "./process.mjs";

const DEFAULT_TIMEOUT_MS = 300_000;
const AUTH_CHECK_TIMEOUT_MS = 30_000;

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
  // Use stdin for large prompts to avoid E2BIG (ARG_MAX) errors.
  // Gemini CLI appends stdin content after the -p prompt.
  const useStdin = prompt.length > 100_000;
  const args = ["-p", useStdin ? "" : prompt, "-o", "json"];
  if (model) args.push("-m", model);
  args.push("--approval-mode", approvalMode);
  if (resumeSessionId) args.push("--resume", resumeSessionId);
  args.push(...extraArgs);

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
