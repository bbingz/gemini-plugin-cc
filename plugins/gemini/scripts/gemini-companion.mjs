#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseArgs } from "./lib/args.mjs";
import { callGemini, getGeminiAvailability, getGeminiAuthStatus } from "./lib/gemini.mjs";
import { ensureGitRepository, getDiff, detectBaseBranch } from "./lib/git.mjs";
import {
  buildStatusSnapshot,
  buildSingleJobSnapshot,
  cancelJob,
  createJob,
  readStoredJobResult,
  resolveCancelableJob,
  resolveResultJob,
  runJobInBackground,
  runWorker,
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
import { getConfig, setConfig } from "./lib/state.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const SELF = fileURLToPath(import.meta.url);
const MAX_DIFF_LENGTH = 200_000; // ~50K tokens

// ── Helpers ──────────────────────────────────────────────

function printUsage() {
  console.log(
    [
      "Usage:",
      "  gemini-companion.mjs setup [--json]",
      "  gemini-companion.mjs ask [--model <model>] [--approval-mode <mode>] [--background|--wait] [--json] <prompt>",
      "  gemini-companion.mjs review [--base <ref>] [--scope <auto|working-tree|branch>] [--model <model>] [--background|--wait] [--json]",
      "  gemini-companion.mjs status [job-id] [--all] [--json]",
      "  gemini-companion.mjs result [job-id] [--json]",
      "  gemini-companion.mjs cancel [job-id] [--json]",
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
    booleanOptions: ["json"],
    valueOptions: ["cwd"],
  });

  const cwd = resolveCwd(options);
  const report = buildSetupReport(cwd);
  outputResult(options.json ? report : renderSetupReport(report), options.json);
}

function buildSetupReport(cwd) {
  const nodeStatus = binaryAvailable("node", ["--version"], { cwd });
  const npmStatus = binaryAvailable("npm", ["--version"], { cwd });
  const geminiStatus = getGeminiAvailability(cwd);

  if (!geminiStatus.available) {
    return {
      ready: false,
      node: nodeStatus,
      npm: npmStatus,
      gemini: geminiStatus,
      auth: { loggedIn: false, detail: "Gemini CLI not installed" },
      actionsTaken: [],
      nextSteps: ["Install Gemini CLI with `npm install -g @google/gemini-cli`."],
    };
  }

  const authStatus = getGeminiAuthStatus(cwd);
  const nextSteps = [];

  if (!authStatus.loggedIn) {
    nextSteps.push("Run `! gemini` in an interactive terminal to authenticate.");
  }

  return {
    ready: geminiStatus.available && authStatus.loggedIn,
    node: nodeStatus,
    npm: npmStatus,
    gemini: geminiStatus,
    auth: authStatus,
    actionsTaken: [],
    nextSteps,
  };
}

// ── Ask ──────────────────────────────────────────────────

function handleAsk(argv) {
  const { options, positionals } = parseArgs(argv, {
    booleanOptions: ["json", "background", "wait"],
    valueOptions: ["model", "approval-mode", "cwd"],
    aliasMap: { m: "model" },
  });

  const prompt = positionals.join(" ").trim();
  if (!prompt) {
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

  // Background mode
  if (options.background) {
    const workspaceRoot = resolveWorkspaceRoot(cwd);
    const job = createJob({ kind: "ask", command: "ask", prompt, workspaceRoot, cwd });
    const bgArgs = ["ask", prompt];
    if (options.model) bgArgs.push("--model", options.model);
    if (options["approval-mode"]) bgArgs.push("--approval-mode", options["approval-mode"]);

    const submission = runJobInBackground({ job, companionScript: SELF, args: bgArgs, workspaceRoot, cwd });
    outputResult(
      options.json ? submission : renderJobSubmitted(submission),
      options.json
    );
    return;
  }

  const result = callGemini({
    prompt,
    model: options.model || null,
    approvalMode: options["approval-mode"] || "auto_edit",
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

  const base = options.base || detectBaseBranch(cwd);
  const scope = options.scope || "auto";

  const diff = getDiff({ base, scope, cwd });
  if (!diff.trim()) {
    const noChanges = { ok: true, verdict: "no_changes", response: "No changes to review." };
    outputResult(
      options.json ? noChanges : "No changes to review.\n",
      options.json
    );
    return;
  }

  let truncated = false;
  let diffText = diff;
  if (diff.length > MAX_DIFF_LENGTH) {
    diffText = diff.slice(0, MAX_DIFF_LENGTH) + "\n\n... [TRUNCATED — diff too large] ...";
    truncated = true;
  }

  const focusText = positionals.join(" ").trim();
  const focusLine = focusText ? `\nFocus area: ${focusText}\n` : "";

  const prompt = `Review the following git diff. For each issue found, provide:
- severity: critical / high / medium / low
- file and line range
- description and recommendation

Be thorough but concise. Focus on bugs, security issues, and logic errors.
Do not comment on style unless it causes bugs.${focusLine}

\`\`\`diff
${diffText}
\`\`\``;

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

// ── Status ───────────────────────────────────────────────

function handleStatus(argv) {
  const { options, positionals } = parseArgs(argv, {
    booleanOptions: ["json", "all"],
    valueOptions: ["cwd"],
  });

  const cwd = resolveCwd(options);
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const reference = positionals[0] || null;

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
      options.json ? snapshot : renderStatusReport({ totalJobs: 1, running: snapshot.status === "running" ? [snapshot] : [], recent: snapshot.status !== "running" ? [snapshot] : [] }),
      options.json
    );
    return;
  }

  const snapshot = buildStatusSnapshot(workspaceRoot, { showAll: options.all });
  outputResult(
    options.json ? snapshot : renderStatusReport(snapshot),
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

  outputResult(
    options.json
      ? { job: enriched, result }
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

// ── Main ─────────────────────────────────────────────────

const argv = process.argv.slice(2);
const subcommand = argv[0];
const subArgv = argv.slice(1);

switch (subcommand) {
  case "setup":
    handleSetup(subArgv);
    break;
  case "ask":
    handleAsk(subArgv);
    break;
  case "review":
    handleReview(subArgv);
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
  case "_worker": {
    // Internal: background worker. Args: <jobId> <workspaceRoot> <command> [command-args...]
    const [jobId, wsRoot, ...workerArgs] = subArgv;
    runWorker(jobId, wsRoot, SELF, workerArgs);
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
