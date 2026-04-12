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

  // Try origin/main
  const main = runCommand("git", ["rev-parse", "--verify", "origin/main"], { cwd });
  if (main.status === 0) return "main";

  // Try origin/master
  const master = runCommand("git", ["rev-parse", "--verify", "origin/master"], { cwd });
  if (master.status === 0) return "master";

  // Try local main
  const localMain = runCommand("git", ["rev-parse", "--verify", "main"], { cwd });
  if (localMain.status === 0) return "main";

  return "main";
}

/**
 * Collect git diff based on scope.
 *
 * Scopes:
 * - "working-tree" — unstaged changes
 * - "branch" — current branch vs base
 * - "auto" (default) — staged > branch > working-tree
 */
export function getDiff({ base, scope = "auto", cwd }) {
  if (scope === "working-tree") {
    return runDiff(["git", "diff"], cwd);
  }

  if (scope === "branch") {
    const resolvedBase = base || detectBaseBranch(cwd);
    return runDiff(["git", "diff", `${resolvedBase}...HEAD`], cwd);
  }

  // auto: prioritize staged, then branch, then working-tree
  const staged = runDiff(["git", "diff", "--cached"], cwd);
  if (staged.trim()) return staged;

  const resolvedBase = base || detectBaseBranch(cwd);
  const branch = runDiff(["git", "diff", `${resolvedBase}...HEAD`], cwd);
  if (branch.trim()) return branch;

  return runDiff(["git", "diff"], cwd);
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
