#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseArgs } from "./lib/args.mjs";
import { callGemini, getGeminiAvailability, getGeminiAuthStatus } from "./lib/gemini.mjs";
import { ensureGitRepository, getDiff, detectBaseBranch } from "./lib/git.mjs";
import { binaryAvailable } from "./lib/process.mjs";
import { renderSetupReport, renderGeminiResult, renderReviewResult } from "./lib/render.mjs";
import { getConfig, setConfig } from "./lib/state.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const MAX_DIFF_LENGTH = 200_000; // ~50K tokens

// ── Helpers ──────────────────────────────────────────────

function printUsage() {
  console.log(
    [
      "Usage:",
      "  gemini-companion.mjs setup [--json]",
      "  gemini-companion.mjs ask [--model <model>] [--approval-mode <mode>] [--json] <prompt>",
      "  gemini-companion.mjs review [--base <ref>] [--scope <auto|working-tree|branch>] [--model <model>] [--json]",
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

function parseCommandInput(argv, config = {}) {
  return parseArgs(argv, config);
}

function resolveCwd(options) {
  return options.cwd || process.cwd();
}

// ── Setup ────────────────────────────────────────────────

function handleSetup(argv) {
  const { options } = parseCommandInput(argv, {
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

  const nextSteps = [];

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
  const { options, positionals } = parseCommandInput(argv, {
    booleanOptions: ["json"],
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
  const { options, positionals } = parseCommandInput(argv, {
    booleanOptions: ["json"],
    valueOptions: ["base", "scope", "model", "cwd"],
  });

  const cwd = resolveCwd(options);

  try {
    ensureGitRepository(cwd);
  } catch (e) {
    outputResult(
      options.json
        ? { ok: false, error: e.message }
        : `Error: ${e.message}\n`,
      options.json
    );
    process.exitCode = 1;
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

  // Extra context from positionals (e.g. "focus on security")
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
  default:
    if (subcommand) {
      console.error(`Unknown subcommand: ${subcommand}`);
    }
    printUsage();
    process.exitCode = 1;
    break;
}
