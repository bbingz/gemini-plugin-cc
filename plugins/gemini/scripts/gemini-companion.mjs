#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseArgs } from "./lib/args.mjs";
import { callGemini, callGeminiStreaming, getGeminiAvailability, getGeminiAuthStatus } from "./lib/gemini.mjs";
import { ensureGitRepository, collectReviewContext } from "./lib/git.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import {
  buildStatusSnapshot,
  buildSingleJobSnapshot,
  cancelJob,
  createJob,
  readStoredJobResult,
  resolveCancelableJob,
  resolveResultJob,
  resolveResumeCandidate,
  runJobInBackground,
  runStreamingJobInBackground,
  runStreamingWorker,
  runWorker,
  waitForJob,
} from "./lib/job-control.mjs";
import { binaryAvailable } from "./lib/process.mjs";
import {
  renderSetupReport,
  renderGeminiResult,
  renderReviewResult,
  renderJobSubmitted,
  renderStatusReport,
  renderStoredJobResult,
  renderCancelReport,
} from "./lib/render.mjs";
import { getConfig, listJobs, readJobFile, readTimingHistory, resolveJobFile, setConfig, upsertJob } from "./lib/state.mjs";
import {
  renderSingleJobDetail,
  renderAggregateTable,
  renderHistoryTable,
  computeAggregateStats,
  filterHistory,
} from "./lib/timing.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const SELF = fileURLToPath(import.meta.url);
const MAX_DIFF_LENGTH = 200_000; // ~50K tokens

function loadReviewSchema() {
  try {
    const schemaPath = path.join(ROOT_DIR, "schemas", "review-output.schema.json");
    return fs.readFileSync(schemaPath, "utf8").trim();
  } catch {
    return null;
  }
}

// ── Helpers ──────────────────────────────────────────────

function printUsage() {
  console.log(
    [
      "Usage:",
      "  gemini-companion.mjs setup [--enable-review-gate|--disable-review-gate] [--json]",
      "  gemini-companion.mjs ask [--model <model>] [--approval-mode <mode>] [--effort <low|medium|high>] [--background|--wait] [--json] <prompt>",
      "  gemini-companion.mjs task [--write] [--resume-last|--fresh] [--model <model>] [--effort <low|medium|high>] [--prompt-file <path>] [--background|--wait] [--json] <prompt>",
      "  gemini-companion.mjs task-resume-candidate [--json]",
      "  gemini-companion.mjs review [--base <ref>] [--scope <auto|working-tree|staged|unstaged|branch>] [--model <model>] [--background|--wait] [--json]",
      "  gemini-companion.mjs adversarial-review [--base <ref>] [--scope <auto|working-tree|staged|unstaged|branch>] [--background|--wait] [--json] [focus ...]",
      "  gemini-companion.mjs status [job-id] [--all] [--wait] [--json]",
      "  gemini-companion.mjs result [job-id] [--json]",
      "  gemini-companion.mjs cancel [job-id] [--json]",
      "  gemini-companion.mjs timing [job-id] [--history] [--stats] [--kind task|ask] [--last N] [--since ISO] [--json]",
    ].join("\n")
  );
}

function outputResult(value, asJson) {
  if (asJson) {
    console.log(JSON.stringify(value, null, 2));
  } else {
    process.stdout.write(typeof value === "string" ? value : JSON.stringify(value, null, 2));
  }
}

import { runCommand } from "./lib/process.mjs";

function resolveWorkspaceRoot(cwd) {
  const result = runCommand("git", ["rev-parse", "--show-toplevel"], { cwd });
  if (result.status === 0 && result.stdout.trim()) {
    return result.stdout.trim();
  }
  return cwd;
}

function resolveCwd(options) {
  return options.cwd || process.cwd();
}

// ── Setup ────────────────────────────────────────────────

function handleSetup(argv) {
  const { options } = parseArgs(argv, {
    booleanOptions: ["json", "enable-review-gate", "disable-review-gate"],
    valueOptions: ["cwd"],
  });

  if (options["enable-review-gate"] && options["disable-review-gate"]) {
    outputResult(
      options.json
        ? { ok: false, error: "Choose either --enable-review-gate or --disable-review-gate." }
        : "Error: Choose either --enable-review-gate or --disable-review-gate.\n",
      options.json
    );
    process.exitCode = 1;
    return;
  }

  const cwd = resolveCwd(options);
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const actionsTaken = [];

  if (options["enable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", true);
    actionsTaken.push("Enabled the stop-time review gate.");
  } else if (options["disable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", false);
    actionsTaken.push("Disabled the stop-time review gate.");
  }

  const report = buildSetupReport(cwd, actionsTaken);
  outputResult(options.json ? report : renderSetupReport(report), options.json);
}

function buildSetupReport(cwd, actionsTaken = []) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const nodeStatus = binaryAvailable("node", ["--version"], { cwd });
  const npmStatus = binaryAvailable("npm", ["--version"], { cwd });
  const geminiStatus = getGeminiAvailability(cwd);
  const config = getConfig(workspaceRoot);

  if (!geminiStatus.available) {
    return {
      ready: false,
      node: nodeStatus,
      npm: npmStatus,
      gemini: geminiStatus,
      auth: { loggedIn: false, detail: "Gemini CLI not installed" },
      reviewGateEnabled: false,
      actionsTaken,
      nextSteps: ["Install Gemini CLI with `npm install -g @google/gemini-cli`."],
    };
  }

  const authStatus = getGeminiAuthStatus(cwd);
  const nextSteps = [];

  if (!authStatus.loggedIn) {
    nextSteps.push("Run `! gemini` in an interactive terminal to authenticate.");
  }
  if (!config.stopReviewGate) {
    nextSteps.push("Optional: run `/gemini:setup --enable-review-gate` to require a review before stop.");
  }

  return {
    ready: geminiStatus.available && authStatus.loggedIn,
    node: nodeStatus,
    npm: npmStatus,
    gemini: geminiStatus,
    auth: authStatus,
    reviewGateEnabled: Boolean(config.stopReviewGate),
    actionsTaken,
    nextSteps,
  };
}

// ── Ask ──────────────────────────────────────────────────

const VALID_EFFORTS = new Set(["low", "medium", "high"]);

function applyEffort(prompt, effort) {
  if (!effort || !VALID_EFFORTS.has(effort)) return prompt;
  if (effort === "high") {
    return `Think step by step. Be thorough and consider edge cases.\n\n${prompt}`;
  }
  if (effort === "low") {
    return `Be concise. Give the most direct answer.\n\n${prompt}`;
  }
  return prompt; // medium is default
}

async function handleAsk(argv) {
  const { options, positionals } = parseArgs(argv, {
    booleanOptions: ["json", "background", "wait"],
    valueOptions: ["model", "approval-mode", "effort", "cwd"],
    aliasMap: { m: "model" },
  });

  const rawPrompt = positionals.join(" ").trim();
  const prompt = applyEffort(rawPrompt, options.effort);
  if (!rawPrompt) {
    outputResult(
      options.json
        ? { ok: false, error: "No prompt provided." }
        : "Error: No prompt provided. Usage: gemini-companion.mjs ask <prompt>\n",
      options.json
    );
    process.exitCode = 1;
    return;
  }

  const cwd = resolveCwd(options);
  const approvalMode = options["approval-mode"] || "auto_edit";

  // Background mode — use streaming worker
  if (options.background) {
    const workspaceRoot = resolveWorkspaceRoot(cwd);
    const job = createJob({ kind: "ask", command: "ask", prompt, workspaceRoot, cwd });
    const submission = runStreamingJobInBackground({
      job,
      companionScript: SELF,
      config: { prompt, model: options.model || null, approvalMode, cwd },
      workspaceRoot,
      cwd,
    });
    outputResult(
      options.json ? submission : renderJobSubmitted(submission),
      options.json
    );
    return;
  }

  // Foreground — use streaming
  const result = await callGeminiStreaming({
    prompt,
    model: options.model || null,
    approvalMode,
    cwd,
  });

  outputResult(
    options.json ? result : renderGeminiResult(result),
    options.json
  );
  if (!result.ok) process.exitCode = 1;
}

// ── Review ───────────────────────────────────────────────

function handleReview(argv) {
  const { options, positionals } = parseArgs(argv, {
    booleanOptions: ["json", "background", "wait"],
    valueOptions: ["base", "scope", "model", "cwd"],
  });

  const cwd = resolveCwd(options);

  try {
    ensureGitRepository(cwd);
  } catch (e) {
    outputResult(
      options.json ? { ok: false, error: e.message } : `Error: ${e.message}\n`,
      options.json
    );
    process.exitCode = 1;
    return;
  }

  // Background mode
  if (options.background) {
    const workspaceRoot = resolveWorkspaceRoot(cwd);
    const job = createJob({ kind: "review", command: "review", prompt: "code review", workspaceRoot, cwd });
    const bgArgs = ["review"];
    if (options.base) bgArgs.push("--base", options.base);
    if (options.scope) bgArgs.push("--scope", options.scope);
    if (options.model) bgArgs.push("--model", options.model);
    positionals.forEach((p) => bgArgs.push(p));

    const submission = runJobInBackground({ job, companionScript: SELF, args: bgArgs, workspaceRoot, cwd });
    outputResult(
      options.json ? submission : renderJobSubmitted(submission),
      options.json
    );
    return;
  }

  const scope = options.scope || "auto";
  const base = options.base || null;
  const ctx = collectReviewContext(cwd, { base, scope });

  if (!ctx.content.trim() || ctx.content.replace(/## \w+\n\n\(none\)\n/g, "").trim() === "") {
    const noChanges = { ok: true, verdict: "no_changes", response: "No changes to review." };
    outputResult(
      options.json ? noChanges : "No changes to review.\n",
      options.json
    );
    return;
  }

  let truncated = false;
  let reviewInput = ctx.content;
  if (reviewInput.length > MAX_DIFF_LENGTH) {
    reviewInput = reviewInput.slice(0, MAX_DIFF_LENGTH) + "\n\n... [TRUNCATED — diff too large] ...";
    truncated = true;
  }

  const focusText = positionals.join(" ").trim();
  const focusLine = focusText ? `\nFocus area: ${focusText}\n` : "";
  const schema = loadReviewSchema();
  const schemaBlock = schema
    ? `\n\nYou MUST respond with valid JSON matching this schema:\n\`\`\`json\n${schema}\n\`\`\`\n`
    : "";

  const prompt = `Review the following repository changes.
${ctx.summary}${focusLine}${schemaBlock}

${reviewInput}`;

  const result = callGemini({
    prompt,
    model: options.model || null,
    approvalMode: "plan",
    cwd,
  });

  outputResult(
    options.json ? { ...result, truncated } : renderReviewResult(result, { truncated }),
    options.json
  );
  if (!result.ok) process.exitCode = 1;
}

// ── Adversarial Review ───────────────────────────────────

function handleAdversarialReview(argv) {
  const { options, positionals } = parseArgs(argv, {
    booleanOptions: ["json", "background", "wait"],
    valueOptions: ["base", "scope", "model", "cwd"],
  });

  const cwd = resolveCwd(options);

  try {
    ensureGitRepository(cwd);
  } catch (e) {
    outputResult(
      options.json ? { ok: false, error: e.message } : `Error: ${e.message}\n`,
      options.json
    );
    process.exitCode = 1;
    return;
  }

  // Background mode
  if (options.background) {
    const workspaceRoot = resolveWorkspaceRoot(cwd);
    const job = createJob({ kind: "adversarial-review", command: "adversarial-review", prompt: "adversarial review", workspaceRoot, cwd });
    const bgArgs = ["adversarial-review"];
    if (options.base) bgArgs.push("--base", options.base);
    if (options.scope) bgArgs.push("--scope", options.scope);
    if (options.model) bgArgs.push("--model", options.model);
    positionals.forEach((p) => bgArgs.push(p));

    const submission = runJobInBackground({ job, companionScript: SELF, args: bgArgs, workspaceRoot, cwd });
    outputResult(
      options.json ? submission : renderJobSubmitted(submission),
      options.json
    );
    return;
  }

  const scope = options.scope || "auto";
  const base = options.base || null;
  const ctx = collectReviewContext(cwd, { base, scope });

  if (!ctx.content.trim() || ctx.content.replace(/## \w+\n\n\(none\)\n/g, "").trim() === "") {
    outputResult(
      options.json
        ? { ok: true, verdict: "no_changes", response: "No changes to review." }
        : "No changes to review.\n",
      options.json
    );
    return;
  }

  let reviewInput = ctx.content;
  let truncated = false;
  if (reviewInput.length > MAX_DIFF_LENGTH) {
    reviewInput = reviewInput.slice(0, MAX_DIFF_LENGTH) + "\n\n... [TRUNCATED — diff too large] ...";
    truncated = true;
  }

  const focusText = positionals.join(" ").trim();
  const schema = loadReviewSchema();
  const template = loadPromptTemplate(ROOT_DIR, "adversarial-review");
  const prompt = interpolateTemplate(template, {
    TARGET_LABEL: ctx.mode === "branch" ? `branch (${ctx.summary})` : "working tree changes",
    USER_FOCUS: focusText || "No extra focus provided.",
    REVIEW_INPUT: reviewInput,
    REVIEW_SCHEMA: schema || "(schema unavailable — use the field structure described above)",
  });

  const result = callGemini({
    prompt,
    model: options.model || null,
    approvalMode: "plan",
    cwd,
  });

  outputResult(
    options.json ? { ...result, truncated } : renderReviewResult(result, { truncated }),
    options.json
  );
  if (!result.ok) process.exitCode = 1;
}

// ── Task ────────────────────────────────────────────────

const DEFAULT_CONTINUE_PROMPT = "Continue from the current thread state. Pick the next highest-value step and follow through until the task is resolved.";

function readPromptFromFile(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8").trim();
  } catch (e) {
    throw new Error(`Cannot read prompt file: ${e.message}`);
  }
}

function readStdinIfPiped() {
  try {
    if (process.stdin.isTTY) return null;
    return fs.readFileSync(0, "utf8").trim() || null;
  } catch {
    return null;
  }
}

async function handleTask(argv) {
  const { options, positionals } = parseArgs(argv, {
    booleanOptions: ["json", "background", "wait", "write", "resume-last", "fresh"],
    valueOptions: ["model", "effort", "prompt-file", "cwd", "resume-session-id"],
    aliasMap: { m: "model" },
  });

  // Validate mutually exclusive flags
  if (options["resume-last"] && options.fresh) {
    outputResult(
      options.json
        ? { ok: false, error: "Choose either --resume-last or --fresh, not both." }
        : "Error: Choose either --resume-last or --fresh, not both.\n",
      options.json
    );
    process.exitCode = 1;
    return;
  }

  // Resolve prompt from: --prompt-file > positionals > stdin
  let prompt;
  if (options["prompt-file"]) {
    try {
      prompt = readPromptFromFile(options["prompt-file"]);
    } catch (e) {
      outputResult(
        options.json ? { ok: false, error: e.message } : `Error: ${e.message}\n`,
        options.json
      );
      process.exitCode = 1;
      return;
    }
  } else {
    prompt = positionals.join(" ").trim();
    if (!prompt) {
      const stdinPrompt = readStdinIfPiped();
      if (stdinPrompt) prompt = stdinPrompt;
    }
  }

  // Resume-last with no prompt gets a default continue prompt
  if (!prompt && options["resume-last"]) {
    prompt = DEFAULT_CONTINUE_PROMPT;
  }

  if (!prompt) {
    outputResult(
      options.json
        ? { ok: false, error: "Provide a prompt, a --prompt-file, piped stdin, or use --resume-last." }
        : "Error: Provide a prompt, a --prompt-file, piped stdin, or use --resume-last.\n",
      options.json
    );
    process.exitCode = 1;
    return;
  }

  // Apply effort modifier after prompt is resolved
  prompt = applyEffort(prompt, options.effort);

  const cwd = resolveCwd(options);
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const write = Boolean(options.write);
  const approvalMode = write ? "auto_edit" : "plan";

  // Resolve resume session — explicit ID takes priority (used by background worker)
  let resumeSessionId = options["resume-session-id"] || null;
  if (!resumeSessionId && options["resume-last"]) {
    const candidate = resolveResumeCandidate(workspaceRoot);
    if (candidate?.available) {
      resumeSessionId = candidate.candidate.geminiSessionId;
    }
  }

  const streamConfig = {
    prompt,
    model: options.model || null,
    approvalMode,
    cwd,
    resumeSessionId,
  };

  // Background mode — use streaming worker
  if (options.background) {
    const job = createJob({ kind: "task", command: "task", prompt, workspaceRoot, cwd, write });
    const submission = runStreamingJobInBackground({
      job,
      companionScript: SELF,
      config: streamConfig,
      workspaceRoot,
      cwd,
    });
    outputResult(
      options.json ? submission : renderJobSubmitted(submission),
      options.json
    );
    return;
  }

  // Foreground — use streaming for live progress
  const result = await callGeminiStreaming({
    ...streamConfig,
    onEvent: (event) => {
      // Non-JSON mode: show progress on stderr
      if (!options.json && event.type === "init") {
        process.stderr.write(`[gemini] Model: ${event.model || "?"}\n`);
      }
    },
  });

  // Persist geminiSessionId for future resume
  if (result.ok && result.sessionId) {
    const job = createJob({ kind: "task", command: "task", prompt, workspaceRoot, cwd, write });
    upsertJob(workspaceRoot, {
      id: job.id,
      status: "completed",
      phase: "done",
      geminiSessionId: result.sessionId,
      pid: null,
    });
  }

  outputResult(
    options.json ? { ...result, write, resumed: Boolean(resumeSessionId) } : renderGeminiResult(result),
    options.json
  );
  if (!result.ok) process.exitCode = 1;
}

function handleTaskResumeCandidate(argv) {
  const { options } = parseArgs(argv, {
    booleanOptions: ["json"],
    valueOptions: ["cwd"],
  });

  const cwd = resolveCwd(options);
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const result = resolveResumeCandidate(workspaceRoot) || { available: false, candidate: null };

  outputResult(result, options.json ?? true);
}

// ── Status ───────────────────────────────────────────────

function handleStatus(argv) {
  const { options, positionals } = parseArgs(argv, {
    booleanOptions: ["json", "all", "wait"],
    valueOptions: ["cwd", "timeout-ms", "poll-interval-ms"],
  });

  const cwd = resolveCwd(options);
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const reference = positionals[0] || null;

  // --wait: poll a specific job until it completes
  if (options.wait && reference) {
    const timeoutMs = options["timeout-ms"] ? parseInt(options["timeout-ms"], 10) : undefined;
    const pollIntervalMs = options["poll-interval-ms"] ? parseInt(options["poll-interval-ms"], 10) : undefined;
    const result = waitForJob(workspaceRoot, reference, { timeoutMs, pollIntervalMs });
    if (result.error) {
      outputResult(
        options.json ? result : `Error: ${result.error}\n`,
        options.json
      );
      process.exitCode = 1;
      return;
    }
    outputResult(
      options.json ? result : renderStatusReport({
        totalJobs: 1,
        running: result.status === "running" ? [result] : [],
        recent: result.status !== "running" ? [result] : [],
        waitTimedOut: result.waitTimedOut,
      }, workspaceRoot),
      options.json
    );
    return;
  }

  if (reference) {
    const snapshot = buildSingleJobSnapshot(workspaceRoot, reference);
    if (!snapshot) {
      outputResult(
        options.json ? { error: "Job not found" } : `Job \`${reference}\` not found.\n`,
        options.json
      );
      process.exitCode = 1;
      return;
    }
    outputResult(
      options.json ? snapshot : renderStatusReport({ totalJobs: 1, running: snapshot.status === "running" ? [snapshot] : [], recent: snapshot.status !== "running" ? [snapshot] : [] }, workspaceRoot),
      options.json
    );
    return;
  }

  const snapshot = buildStatusSnapshot(workspaceRoot, { showAll: options.all });
  outputResult(
    options.json ? snapshot : renderStatusReport(snapshot, workspaceRoot),
    options.json
  );
}

// ── Result ───────────────────────────────────────────────

function handleResult(argv) {
  const { options, positionals } = parseArgs(argv, {
    booleanOptions: ["json"],
    valueOptions: ["cwd"],
  });

  const cwd = resolveCwd(options);
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const reference = positionals[0] || null;
  const job = resolveResultJob(workspaceRoot, reference);

  if (!job) {
    outputResult(
      options.json
        ? { error: "No completed job found" }
        : "No completed job found. Run `/gemini:status` to see all jobs.\n",
      options.json
    );
    process.exitCode = 1;
    return;
  }

  const result = readStoredJobResult(workspaceRoot, job.id);
  const enriched = buildSingleJobSnapshot(workspaceRoot, job.id) || job;
  const envelope = readJobFile(resolveJobFile(workspaceRoot, job.id));
  const timing = envelope?.timing ?? null;

  outputResult(
    options.json
      ? { job: enriched, result, timing }
      : renderStoredJobResult(enriched, result),
    options.json
  );
}

// ── Cancel ───────────────────────────────────────────────

function handleCancel(argv) {
  const { options, positionals } = parseArgs(argv, {
    booleanOptions: ["json"],
    valueOptions: ["cwd"],
  });

  const cwd = resolveCwd(options);
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const reference = positionals[0] || null;
  const job = resolveCancelableJob(workspaceRoot, reference);

  if (!job) {
    outputResult(
      options.json
        ? { cancelled: false, reason: "No active job found" }
        : "No active job found to cancel.\n",
      options.json
    );
    process.exitCode = 1;
    return;
  }

  const report = cancelJob(workspaceRoot, job.id);
  outputResult(
    options.json ? report : renderCancelReport(report),
    options.json
  );
}

// ── Timing ───────────────────────────────────────────────

function handleTiming(argv) {
  const { options, positionals } = parseArgs(argv, {
    booleanOptions: ["json", "history", "stats"],
    valueOptions: ["since", "kind", "last", "cwd"],
  });

  const cwd = resolveCwd(options);
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobId = positionals[0] || null;

  const modes = [!!jobId, !!options.history, !!options.stats].filter(Boolean).length;
  if (modes > 1) {
    outputResult(
      options.json
        ? { ok: false, error: "--history / --stats / <job-id> are mutually exclusive" }
        : "Error: --history / --stats / <job-id> are mutually exclusive\n",
      options.json
    );
    process.exitCode = 1;
    return;
  }

  const allRecords = readTimingHistory();

  if (jobId) {
    const envelope = readJobFile(resolveJobFile(workspaceRoot, jobId));
    const timing = envelope?.timing || allRecords.find((r) => r.jobId === jobId)?.timing || null;
    const job = envelope?.id ? envelope : (listJobs(workspaceRoot).find((j) => j.id === jobId) || { id: jobId });
    outputResult(
      options.json
        ? {
            job: { id: job.id, kind: job.kind, status: job.status },
            timing,
            fallback: Array.isArray(timing?.usage) && timing.usage.length > 1,
          }
        : renderSingleJobDetail({ job, timing }),
      options.json
    );
    return;
  }

  if (options.stats) {
    const rows = filterHistory(allRecords, {
      kind: options.kind,
      since: options.since,
    });
    const stats = computeAggregateStats(rows);
    outputResult(
      options.json
        ? { kind: options.kind || "all", ...stats, since: options.since || null }
        : renderAggregateTable(stats, { kind: options.kind || "all" }),
      options.json
    );
    return;
  }

  // --history (default)
  const rows = filterHistory(allRecords, {
    kind: options.kind,
    since: options.since,
    last: options.last ? parseInt(options.last, 10) : 20,
  });
  outputResult(
    options.json ? { rows, count: rows.length } : renderHistoryTable(rows),
    options.json
  );
}

// ── Main ─────────────────────────────────────────────────

async function main() {
  const argv = process.argv.slice(2);
  const subcommand = argv[0];
  const subArgv = argv.slice(1);

  switch (subcommand) {
    case "setup":
      handleSetup(subArgv);
      break;
    case "ask":
      await handleAsk(subArgv);
      break;
    case "task":
      await handleTask(subArgv);
      break;
    case "task-resume-candidate":
      handleTaskResumeCandidate(subArgv);
      break;
    case "review":
      handleReview(subArgv);
      break;
    case "adversarial-review":
      handleAdversarialReview(subArgv);
      break;
    case "status":
      handleStatus(subArgv);
      break;
    case "result":
      handleResult(subArgv);
      break;
    case "cancel":
      handleCancel(subArgv);
      break;
    case "timing":
      handleTiming(subArgv);
      break;
    case "_worker": {
      // Internal: legacy background worker (CLI re-entry, used by review)
      const [jobId, wsRoot, ...workerArgs] = subArgv;
      runWorker(jobId, wsRoot, SELF, workerArgs);
      break;
    }
    case "_stream-worker": {
      // Internal: streaming background worker (direct API, used by task/ask)
      const [jobId, wsRoot, configFile] = subArgv;
      const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
      try { fs.unlinkSync(configFile); } catch { /* ignore */ }
      await runStreamingWorker(jobId, wsRoot, config);
      break;
    }
    default:
      if (subcommand) {
        console.error(`Unknown subcommand: ${subcommand}`);
      }
      printUsage();
      process.exitCode = 1;
      break;
  }
}

main().catch((err) => {
  process.stderr.write(`${err.message || err}\n`);
  process.exitCode = 1;
});
