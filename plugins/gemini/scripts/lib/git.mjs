import fs from "node:fs";
import path from "node:path";

import { runCommand, runCommandChecked } from "./process.mjs";

/**
 * Verify we are inside a git repository.
 */
export function ensureGitRepository(cwd) {
  const result = runCommand("git", ["rev-parse", "--is-inside-work-tree"], { cwd });
  if (result.status !== 0) {
    throw new Error("Not a git repository. Run this command inside a git repo.");
  }
}

/**
 * Get the repository root.
 */
export function getRepoRoot(cwd) {
  const result = runCommandChecked("git", ["rev-parse", "--show-toplevel"], { cwd });
  return result.stdout.trim();
}

/**
 * Detect the default base branch.
 * Tries: origin/HEAD symref → origin/main → origin/master → local main → local master.
 * Throws if none found instead of silently guessing.
 */
export function detectBaseBranch(cwd) {
  // Try symbolic-ref first
  const symRef = runCommand(
    "git",
    ["symbolic-ref", "refs/remotes/origin/HEAD"],
    { cwd }
  );
  if (symRef.status === 0 && symRef.stdout.trim()) {
    return symRef.stdout.trim().replace("refs/remotes/origin/", "");
  }

  // Try remote branches
  for (const branch of ["main", "master"]) {
    const result = runCommand("git", ["rev-parse", "--verify", `origin/${branch}`], { cwd });
    if (result.status === 0) return branch;
  }

  // Try local branches
  for (const branch of ["main", "master", "trunk", "develop"]) {
    const result = runCommand("git", ["rev-parse", "--verify", branch], { cwd });
    if (result.status === 0) return branch;
  }

  throw new Error(
    "Cannot detect base branch. Use --base <branch> to specify it explicitly."
  );
}

/**
 * Collect git diff based on scope.
 *
 * Scopes:
 * - "working-tree" — unstaged + untracked changes
 * - "branch" — current branch vs base
 * - "auto" (default) — local modifications first (staged+unstaged+untracked),
 *   then branch diff, so we never miss what the user is actively editing
 */
export function getDiff({ base, scope = "auto", cwd }) {
  if (scope === "working-tree") {
    return getWorkingTreeDiff(cwd);
  }

  if (scope === "branch") {
    const resolvedBase = base || detectBaseBranch(cwd);
    return runDiff(["git", "diff", `${resolvedBase}...HEAD`], cwd);
  }

  // auto: prefer local modifications (what the user is editing right now),
  // then fall back to committed branch diff
  const local = getLocalModifications(cwd);
  if (local.trim()) return local;

  const resolvedBase = base || detectBaseBranch(cwd);
  const branch = runDiff(["git", "diff", `${resolvedBase}...HEAD`], cwd);
  if (branch.trim()) return branch;

  return "";
}

/**
 * Get all local modifications: staged + unstaged + untracked file contents.
 */
function getLocalModifications(cwd) {
  const parts = [];

  // Staged changes
  const staged = runDiff(["git", "diff", "--cached"], cwd);
  if (staged.trim()) parts.push(staged);

  // Unstaged changes (tracked files only)
  const unstaged = runDiff(["git", "diff"], cwd);
  if (unstaged.trim()) parts.push(unstaged);

  // Untracked files
  const untracked = getUntrackedFilesDiff(cwd);
  if (untracked.trim()) parts.push(untracked);

  return parts.join("\n");
}

/**
 * Get working tree diff including untracked files.
 */
function getWorkingTreeDiff(cwd) {
  const parts = [];

  const diff = runDiff(["git", "diff"], cwd);
  if (diff.trim()) parts.push(diff);

  const untracked = getUntrackedFilesDiff(cwd);
  if (untracked.trim()) parts.push(untracked);

  return parts.join("\n");
}

/**
 * Generate a pseudo-diff for untracked files so they appear in reviews.
 */
function getUntrackedFilesDiff(cwd) {
  const result = runCommand(
    "git",
    ["ls-files", "--others", "--exclude-standard"],
    { cwd }
  );
  const files = (result.stdout || "").trim().split("\n").filter(Boolean);
  if (files.length === 0) return "";

  const parts = [];
  for (const file of files) {
    // Skip binary-looking files
    if (/\.(png|jpg|jpeg|gif|ico|woff|woff2|ttf|eot|pdf|zip|gz|tar|bin)$/i.test(file)) {
      continue;
    }
    let fileContent;
    try {
      fileContent = fs.readFileSync(path.resolve(cwd || ".", file), "utf8");
    } catch {
      continue;
    }
    if (!fileContent.trim()) continue;

    const lines = fileContent.split("\n");
    const diffLines = lines.map((line, i) => `+${line}`);
    parts.push(
      `diff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${lines.length} @@\n${diffLines.join("\n")}`
    );
  }

  return parts.join("\n");
}

function runDiff(args, cwd) {
  const result = runCommand(args[0], args.slice(1), { cwd });
  return result.stdout || "";
}

/**
 * Get a short summary of changes (file list + stats).
 */
export function getDiffStat({ base, scope = "auto", cwd }) {
  const resolvedBase = base || detectBaseBranch(cwd);
  const result = runCommand("git", ["diff", "--stat", `${resolvedBase}...HEAD`], { cwd });
  return result.stdout || "";
}
