import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const STATUS_KEY = "featuretree";
const DEV_ROOT = process.env.PI_DEV_ROOT?.trim() || path.join(os.homedir(), "Dev");
const WORKTREE_ROOT = path.join(DEV_ROOT, "_worktrees");
const REFRESH_MS = 5_000;

let timer: ReturnType<typeof setInterval> | undefined;
let activeRepo: string | undefined;
let lastMainWarningKey: string | undefined;
let generation = 0;

type GitState = {
  root: string;
  repo: string;
  branch: string;
  dirty: number;
  ahead: number;
  behind: number;
  isWorktree: boolean;
  upstream?: string;
};

function trim(value: string): string {
  return value.trim();
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function shorten(value: string, max = 24): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function resolveMaybePath(input: string | undefined, cwd: string): string {
  if (!input?.trim()) return activeRepo ?? cwd;
  const first = input.trim().split(/\s+/)[0];
  if (!first) return activeRepo ?? cwd;
  return path.resolve(cwd, first.replace(/^@/, ""));
}

async function git(pi: ExtensionAPI, cwd: string, args: string[]) {
  return pi.exec("git", ["-C", cwd, ...args], { timeout: 10_000 });
}

async function gitRoot(pi: ExtensionAPI, cwd: string): Promise<string | undefined> {
  const result = await git(pi, cwd, ["rev-parse", "--show-toplevel"]);
  if (result.code !== 0) return undefined;
  return trim(result.stdout) || undefined;
}

async function readState(pi: ExtensionAPI, cwd: string): Promise<GitState | undefined> {
  const root = await gitRoot(pi, cwd);
  if (!root) return undefined;

  const [branchRes, upstreamRes, statusRes, aheadBehindRes, commonDirRes] = await Promise.all([
    git(pi, root, ["branch", "--show-current"]),
    git(pi, root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]),
    git(pi, root, ["status", "--porcelain=v1"]),
    git(pi, root, ["rev-list", "--left-right", "--count", "@{u}...HEAD"]),
    git(pi, root, ["rev-parse", "--git-common-dir"]),
  ]);

  const branch = trim(branchRes.stdout) || "DETACHED";
  const upstream = upstreamRes.code === 0 ? trim(upstreamRes.stdout) : undefined;
  const dirty = trim(statusRes.stdout).split("\n").filter(Boolean).length;

  let ahead = 0;
  let behind = 0;
  if (aheadBehindRes.code === 0) {
    const [left, right] = trim(aheadBehindRes.stdout).split(/\s+/).map((n) => Number.parseInt(n, 10));
    behind = Number.isFinite(left) ? left : 0;
    ahead = Number.isFinite(right) ? right : 0;
  }

  const commonDir = trim(commonDirRes.stdout);
  const isWorktree = Boolean(commonDir && path.resolve(root, commonDir) !== path.join(root, ".git"));

  activeRepo = root;
  return {
    root,
    repo: path.basename(root),
    branch,
    dirty,
    ahead,
    behind,
    isWorktree,
    upstream,
  };
}

function formatState(state: GitState, theme: ExtensionContext["ui"]["theme"]): string {
  const repo = theme.fg("accent", shorten(state.repo, 12));
  const branchColor = state.branch === "main" || state.branch === "master" ? "warning" : "success";
  const branch = theme.fg(branchColor, shorten(state.branch, 18));
  const dirty = state.dirty > 0 ? theme.fg("warning", `Δ${state.dirty}`) : theme.fg("success", "✓");
  const sync = state.upstream
    ? `${state.ahead > 0 ? theme.fg("warning", `↑${state.ahead}`) : ""}${state.behind > 0 ? theme.fg("warning", `↓${state.behind}`) : ""}` || theme.fg("muted", "↕0")
    : theme.fg("muted", "∅");
  const wt = state.isWorktree ? theme.fg("muted", "WT") : "";
  return `${repo}:${branch} ${dirty} ${sync}${wt ? ` ${wt}` : ""}`;
}

function isStaleCtxError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("This extension ctx is stale");
}

function safeHasUI(ctx: ExtensionContext): boolean {
  try {
    return ctx.hasUI;
  } catch (error) {
    if (isStaleCtxError(error)) return false;
    throw error;
  }
}

function safeClearStatus(ctx?: ExtensionContext): void {
  if (!ctx) return;
  try {
    if (safeHasUI(ctx)) ctx.ui.setStatus(STATUS_KEY, undefined);
  } catch (error) {
    if (!isStaleCtxError(error)) throw error;
  }
}

function ignoreStale(promise: Promise<void>): void {
  promise.catch((error) => {
    if (!isStaleCtxError(error)) console.error("[featuretree-status]", error);
  });
}

async function publish(pi: ExtensionAPI, ctx: ExtensionContext, runGeneration = generation): Promise<void> {
  if (runGeneration !== generation || !safeHasUI(ctx)) return;
  const cwd = ctx.cwd;
  const state = await readState(pi, activeRepo ?? cwd);
  if (runGeneration !== generation || !safeHasUI(ctx)) return;

  if (!state) {
    ctx.ui.setStatus(STATUS_KEY, undefined);
    return;
  }
  ctx.ui.setStatus(STATUS_KEY, formatState(state, ctx.ui.theme));
}

function stop(ctx?: ExtensionContext): void {
  generation++;
  if (timer) {
    clearInterval(timer);
    timer = undefined;
  }
  safeClearStatus(ctx);
}

function start(pi: ExtensionAPI, ctx: ExtensionContext): void {
  stop(ctx);
  const runGeneration = ++generation;
  ignoreStale(publish(pi, ctx, runGeneration));
  timer = setInterval(() => ignoreStale(publish(pi, ctx, runGeneration)), REFRESH_MS);
  (timer as unknown as { unref?: () => void }).unref?.();
}

async function ensureClean(pi: ExtensionAPI, root: string): Promise<string | undefined> {
  const status = await git(pi, root, ["status", "--porcelain=v1"]);
  if (status.code !== 0) return "git status failed";
  if (trim(status.stdout)) return "Repo has uncommitted changes";
  return undefined;
}

async function defaultBase(pi: ExtensionAPI, root: string): Promise<string> {
  const originMain = await git(pi, root, ["rev-parse", "--verify", "origin/main"]);
  if (originMain.code === 0) return "origin/main";
  const main = await git(pi, root, ["rev-parse", "--verify", "main"]);
  if (main.code === 0) return "main";
  const originMaster = await git(pi, root, ["rev-parse", "--verify", "origin/master"]);
  if (originMaster.code === 0) return "origin/master";
  return "HEAD";
}

function featureBranch(slug: string): string {
  return slug.startsWith("feat/") || slug.startsWith("fix/") || slug.startsWith("chore/") ? slug : `feat/${slug}`;
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => start(pi, ctx));
  pi.on("session_shutdown", async (_event, ctx) => stop(ctx));
  pi.on("agent_end", async (_event, ctx) => ignoreStale(publish(pi, ctx)));
  pi.on("tool_execution_end", async (_event, ctx) => ignoreStale(publish(pi, ctx)));

  pi.on("before_agent_start", async (_event, ctx) => {
    const cwd = ctx.cwd;
    const state = await readState(pi, activeRepo ?? cwd);
    if (!state) return;

    const onMain = state.branch === "main" || state.branch === "master";
    const warningKey = `${state.root}:${state.branch}`;
    if (onMain && safeHasUI(ctx) && lastMainWarningKey !== warningKey) {
      lastMainWarningKey = warningKey;
      ctx.ui.notify("Featuretree: you are on main/master. Prefer /feature-start <slug> before code changes.", "warning");
    }

    return {
      message: {
        customType: "featuretree-status",
        display: false,
        content: [
          "Current git featuretree status:",
          `repo=${state.repo}`,
          `root=${state.root}`,
          `branch=${state.branch}`,
          `upstream=${state.upstream ?? "none"}`,
          `dirty_files=${state.dirty}`,
          `unpushed_commits=${state.ahead}`,
          `remote_commits_missing=${state.behind}`,
          `worktree=${state.isWorktree ? "yes" : "no"}`,
          "Preferred workflow: one feature per branch/worktree; test before commit; push before merge to main.",
        ].join("\n"),
      },
    };
  });

  pi.on("tool_call", async (event, ctx) => {
    const input = event.input as { path?: string; command?: string; cwd?: string } | undefined;
    const candidates = [input?.cwd, input?.path]
      .filter((value): value is string => Boolean(value && !value.startsWith("-")))
      .map((value) => path.resolve(ctx.cwd, value.replace(/^@/, "")));

    for (const candidate of candidates) {
      if (!isInside(candidate, DEV_ROOT)) continue;
      const root = await gitRoot(pi, existsSync(candidate) ? candidate : path.dirname(candidate));
      if (root) {
        activeRepo = root;
        ignoreStale(publish(pi, ctx));
        return;
      }
    }
  });

  pi.registerCommand("feature-status", {
    description: "Show current feature tree Git status (usage: /feature-status [path])",
    handler: async (args, ctx) => {
      const cwd = resolveMaybePath(args, ctx.cwd);
      const state = await readState(pi, cwd);
      if (!state) {
        ctx.ui.notify(`No git repo at ${cwd}`, "warning");
        return;
      }
      await publish(pi, ctx);
      ctx.ui.notify(
        [
          `repo: ${state.repo}`,
          `root: ${state.root}`,
          `branch: ${state.branch}`,
          `upstream: ${state.upstream ?? "none"}`,
          `uncommitted files: ${state.dirty}`,
          `unpushed commits: ${state.ahead}`,
          `remote commits missing locally: ${state.behind}`,
          `worktree: ${state.isWorktree ? "yes" : "no"}`,
        ].join("\n"),
        "info",
      );
    },
  });

  pi.registerCommand("feature-start", {
    description: "Create feature branch in worktree (usage: /feature-start slug [repo-path])",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const slug = slugify(parts[0] ?? "");
      if (!slug) {
        ctx.ui.notify("Usage: /feature-start slug [repo-path]", "warning");
        return;
      }

      const repoArg = parts[1];
      const sourcePath = repoArg ? path.resolve(ctx.cwd, repoArg.replace(/^@/, "")) : (activeRepo ?? ctx.cwd);
      const sourceRoot = await gitRoot(pi, sourcePath);
      if (!sourceRoot) {
        ctx.ui.notify(`No git repo at ${sourcePath}`, "error");
        return;
      }

      const dirtyReason = await ensureClean(pi, sourceRoot);
      if (dirtyReason) {
        ctx.ui.notify(`${dirtyReason}. Commit/stash before feature-start.`, "warning");
        return;
      }

      await git(pi, sourceRoot, ["fetch", "--all", "--prune"]);
      const branch = featureBranch(slug);
      const base = await defaultBase(pi, sourceRoot);
      const target = path.join(WORKTREE_ROOT, path.basename(sourceRoot), branch.replace(/[\/]/g, "-"));

      if (existsSync(target)) {
        activeRepo = target;
        ctx.ui.notify(`Worktree exists: ${target}`, "info");
        await publish(pi, ctx);
        return;
      }

      const result = await git(pi, sourceRoot, ["worktree", "add", "-b", branch, target, base]);
      if (result.code !== 0) {
        ctx.ui.notify(`feature-start failed:\n${result.stderr || result.stdout}`, "error");
        return;
      }

      activeRepo = target;
      await publish(pi, ctx);
      ctx.ui.notify(`Feature worktree ready:\n${target}\nbranch: ${branch}\nbase: ${base}`, "info");
    },
  });

  pi.registerCommand("feature-use", {
    description: "Set active feature repo for status (usage: /feature-use path)",
    handler: async (args, ctx) => {
      const cwd = resolveMaybePath(args, ctx.cwd);
      const root = await gitRoot(pi, cwd);
      if (!root) {
        ctx.ui.notify(`No git repo at ${cwd}`, "warning");
        return;
      }
      activeRepo = root;
      await publish(pi, ctx);
      ctx.ui.notify(`Active feature repo: ${root}`, "info");
    },
  });
}
