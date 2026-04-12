#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { stateRootDir } from "./lib/state.mjs";

const SESSION_ID_ENV = "GEMINI_COMPANION_SESSION_ID";

function readHookInput() {
  try {
    const raw = fs.readFileSync(0, "utf8").trim();
    if (!raw) return {};
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function appendEnvVar(name, value) {
  if (!process.env.CLAUDE_ENV_FILE || value == null || value === "") {
    return;
  }
  fs.appendFileSync(
    process.env.CLAUDE_ENV_FILE,
    `export ${name}=${shellEscape(value)}\n`,
    "utf8"
  );
}

function terminateProcess(pid) {
  if (!pid) return;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Process already gone
    }
  }
}

/**
 * Scan ALL workspace state directories for jobs belonging to this session.
 * A session may have spawned jobs in multiple repos/worktrees.
 */
function cleanupAllSessionJobs(sessionId) {
  if (!sessionId) return;

  const root = stateRootDir();
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return; // No state directory yet
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const stateFile = path.join(root, entry.name, "state.json");
    if (!fs.existsSync(stateFile)) continue;

    // Use the directory name as a pseudo workspace root for updateState
    const wsDir = path.join(root, entry.name);
    cleanupWorkspaceSessionJobs(wsDir, sessionId);
  }
}

function cleanupWorkspaceSessionJobs(stateDir, sessionId) {
  // updateState expects a workspaceRoot and computes stateDir from it.
  // We need to work at the stateDir level directly. Read + lock manually.
  const stateFile = path.join(stateDir, "state.json");
  const lockFile = stateFile + ".lock";

  let lockFd;
  try {
    lockFd = fs.openSync(lockFile, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY);
    fs.closeSync(lockFd);
  } catch {
    return; // Can't acquire lock during teardown — skip
  }

  try {
    const raw = fs.readFileSync(stateFile, "utf8");
    const state = JSON.parse(raw);
    const sessionJobs = (state.jobs || []).filter((j) => j.sessionId === sessionId);
    if (sessionJobs.length === 0) return;

    for (const job of sessionJobs) {
      if (job.status === "running" || job.status === "queued") {
        terminateProcess(job.pid);
      }
    }

    state.jobs = state.jobs.filter((j) => j.sessionId !== sessionId);
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + "\n");
  } catch {
    // State file unreadable — skip
  } finally {
    try { fs.unlinkSync(lockFile); } catch { /* ignore */ }
  }
}

function handleSessionStart(input) {
  appendEnvVar(SESSION_ID_ENV, input.session_id);
}

function handleSessionEnd(input) {
  const sessionId = input.session_id || process.env[SESSION_ID_ENV];
  cleanupAllSessionJobs(sessionId);
}

function main() {
  const input = readHookInput();
  const eventName = process.argv[2] ?? input.hook_event_name ?? "";

  if (eventName === "SessionStart") {
    handleSessionStart(input);
  } else if (eventName === "SessionEnd") {
    handleSessionEnd(input);
  }
}

main();
