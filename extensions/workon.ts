import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

const WORKON_DIR = path.join(os.homedir(), ".pi", "agent", "workon");
const DEV_ROOT = process.env.PI_DEV_ROOT?.trim() || path.join(os.homedir(), "Dev");
const WORKTREE_ROOT = path.join(DEV_ROOT, "_worktrees");
const STATUS_KEY = "workon";
const MAIN_BRANCHES = new Set(["main", "master"]);
const DEFAULT_WORKON_LOOP_MAX_SLICES = Math.max(1, Math.min(70, Number.parseInt(process.env.PI_WORKON_LOOP_MAX_SLICES ?? "70", 10) || 70));
const WORKON_LOOP_REVIEW_SENTENCE = "Schau dir das Zielbild und die bisherige Umsetzung nochmals an. Waehle als naechsten Slice einen sinnvoll zusammenhaengenden Umfang, der gut in ein 270k-Token-Kontextfenster passt; vermeide kuenstliche Mini-Slices. Wenn kein sinnvoller weiterer Slice mehr uebrig ist, stoppe und finalisiere.";

interface WorkonDevPorts {
  web: number;
  api: number;
  db: number;
  extra: number;
}

interface WorkonDependencyBootstrap {
  status: "not-needed" | "already-present" | "installed" | "failed";
  command?: string;
  summary: string;
  outputTail?: string;
}

type WorkonMode = "workon" | "workonplan" | "workonhardplan" | "workonloop";
type WorkonLoopStatus = "running" | "done";
type WorkonLoopOutcome = "next" | "done";

interface WorkonHardPlanPaths {
  planDir: string;
  briefPath: string;
  scoutPath: string;
  plannerPath: string;
  planPath: string;
  planReviewPath: string;
  implementationReviewPath: string;
  plannotatorConfigPath: string;
}

interface WorkonLoopRecord {
  statePath: string;
  goal: string;
  maxSlices: number;
}

interface WorkonLoopGateCommand {
  command: string;
  exitCode: number;
  summary?: string;
}

interface WorkonLoopFinalGate {
  passed: boolean;
  commands: WorkonLoopGateCommand[];
  docker?: WorkonLoopGateCommand[];
  notes?: string;
}

interface WorkonLoopSliceHistory {
  sliceIndex: number;
  sliceId: string;
  outcome: WorkonLoopOutcome;
  implementedSummary: string;
  nextPrompt?: string;
  finalGate?: WorkonLoopFinalGate;
  completedAt: string;
}

interface WorkonLoopState {
  version: 1;
  recordId: string;
  slug: string;
  worktreePath: string;
  branch: string;
  originalGoal: string;
  status: WorkonLoopStatus;
  activeSliceId: string;
  sliceIndex: number;
  maxSlices: number;
  createdAt: string;
  updatedAt: string;
  history: WorkonLoopSliceHistory[];
}

interface WorkonLoopFinishSliceParams {
  sliceId: string;
  outcome: WorkonLoopOutcome;
  implementedSummary: string;
  nextPrompt?: string;
  finalGate?: WorkonLoopFinalGate;
}

interface CleanupRecordLookup {
  record?: WorkonRecord;
  ambiguous?: WorkonRecord[];
}

interface WorkonRecord {
  version: 1;
  id: string;
  slug: string;
  task: string;
  docker?: boolean;
  createdAt: string;
  repoRoot: string;
  repoName: string;
  worktreePath: string;
  branch: string;
  base: string;
  references: string[];
  handoffPath: string;
  markdownPath: string;
  envPath: string;
  composeProject: string;
  devPorts: WorkonDevPorts;
  dependencyBootstrap?: WorkonDependencyBootstrap;
  mode?: WorkonMode;
  hardPlan?: WorkonHardPlanPaths;
  loop?: WorkonLoopRecord;
  devUrl?: string;
}

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface WorkonUiContext {
  cwd: string;
  hasUI?: boolean;
  ui?: {
    notify?: (message: string, type?: "info" | "warning" | "error") => void;
    setStatus?: (key: string, value: string | undefined) => void;
    confirm?: (title: string, message: string) => Promise<boolean> | boolean;
  };
  shutdown?: () => void;
}

function trim(value: string): string {
  return value.trim();
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/\/+/g, "/")
    .slice(0, 90);
}

function pathSlug(value: string): string {
  return slugify(value).replace(/[\/]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 90);
}

function hashNumber(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen({ port, host: "127.0.0.1", exclusive: true });
  });
}

async function allocateDevPorts(repoName: string, slug: string): Promise<WorkonDevPorts> {
  const slotCount = 2000;
  const startSlot = hashNumber(`${repoName}/${slug}`) % slotCount;
  for (let attempt = 0; attempt < slotCount; attempt++) {
    const base = 30000 + ((startSlot + attempt) % slotCount) * 10;
    const ports = [base, base + 1, base + 2, base + 3];
    if ((await Promise.all(ports.map(isPortAvailable))).every(Boolean)) {
      return { web: base, api: base + 1, db: base + 2, extra: base + 3 };
    }
  }
  const fallback = 30000 + startSlot * 10;
  return { web: fallback, api: fallback + 1, db: fallback + 2, extra: fallback + 3 };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function parseArgs(args: string): { slug?: string; task: string; noDocker: boolean } {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  const filtered: string[] = [];
  let noDocker = false;
  for (const part of parts) {
    if (part === "--nodocker" || part === "--no-docker") {
      noDocker = true;
      continue;
    }
    if (part === "--docker") continue; // legacy no-op; Docker is default now.
    filtered.push(part);
  }
  const slug = slugify(filtered.shift() ?? "");
  return { slug: slug || undefined, task: filtered.join(" ").trim(), noDocker };
}

function branchForSlug(slug: string, task: string): string {
  if (/^(feat|fix|chore|docs|test|refactor)\//.test(slug)) return slug;
  const haystack = `${slug} ${task}`.toLowerCase();
  const prefix = /(bug|fix|fehler|error|crash|kaputt|broken|hotfix)/.test(haystack) ? "fix" : "feat";
  return `${prefix}/${slug}`;
}

async function git(pi: ExtensionAPI, cwd: string, args: string[], timeout = 60_000): Promise<GitResult> {
  return (await pi.exec("git", ["-C", cwd, ...args], { timeout })) as GitResult;
}

async function gitRoot(pi: ExtensionAPI, cwd: string): Promise<string | undefined> {
  const result = await git(pi, cwd, ["rev-parse", "--show-toplevel"], 10_000);
  if (result.code !== 0) return undefined;
  return trim(result.stdout) || undefined;
}

async function currentBranch(pi: ExtensionAPI, root: string): Promise<string> {
  const result = await git(pi, root, ["branch", "--show-current"], 10_000);
  return trim(result.stdout) || "DETACHED";
}

async function defaultBase(pi: ExtensionAPI, root: string, current: string): Promise<string> {
  await git(pi, root, ["fetch", "--all", "--prune"], 120_000).catch(() => undefined);
  const originMain = await git(pi, root, ["rev-parse", "--verify", "origin/main"], 10_000);
  if (originMain.code === 0) return "origin/main";
  const main = await git(pi, root, ["rev-parse", "--verify", "main"], 10_000);
  if (main.code === 0) return "main";
  const originMaster = await git(pi, root, ["rev-parse", "--verify", "origin/master"], 10_000);
  if (originMaster.code === 0) return "origin/master";
  return current && current !== "DETACHED" ? current : "HEAD";
}

async function hasDirtyFiles(pi: ExtensionAPI, root: string): Promise<boolean> {
  const status = await git(pi, root, ["status", "--porcelain=v1"], 10_000);
  return status.code === 0 && trim(status.stdout).length > 0;
}

async function branchExists(pi: ExtensionAPI, root: string, branch: string): Promise<boolean> {
  const result = await git(pi, root, ["rev-parse", "--verify", branch], 10_000);
  return result.code === 0;
}

function collectReferences(task: string, cwd: string): string[] {
  const refs = new Set<string>();
  const tokens = task
    .split(/\s+/)
    .map((token) => token.replace(/^["'`(<]+|["'`),.;:!?]+$/g, ""))
    .filter(Boolean);

  for (const token of tokens) {
    if (/^https?:\/\//.test(token)) {
      refs.add(token);
      continue;
    }
    if (token === "/" || token === "." || token === "..") continue;
    if (!/[./\\]/.test(token)) continue;
    const resolved = path.isAbsolute(token) ? token : path.resolve(cwd, token.replace(/^@/, ""));
    if (existsSync(resolved)) refs.add(resolved);
  }

  return [...refs];
}

function detectProjectHints(root: string): string[] {
  const hints: string[] = [];
  const pkgPath = path.join(root, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { scripts?: Record<string, string> };
      const scripts = Object.keys(pkg.scripts ?? {});
      const installCommand = detectDependencyInstallCommand(root);
      if (installCommand) {
        hints.push(`deps: new Git worktrees do not copy ignored \`node_modules\`; run \`${installCommand}\` first if dependency bootstrap did not already install them`);
      }
      if (scripts.includes("dev")) hints.push("dev: `npm run dev`");
      if (scripts.includes("typecheck")) hints.push("check: `npm run typecheck`");
      if (scripts.includes("test")) hints.push("test: `npm test`");
      if (scripts.includes("build")) hints.push("build: `npm run build`");
    } catch {
      // ignore invalid package.json
    }
  }
  if (existsSync(path.join(root, "docker-compose.yml")) || existsSync(path.join(root, "compose.yml"))) {
    hints.push("docker: project has compose file; use the handoff compose project so each worktree gets its own isolated testserver");
  }
  return hints;
}

function dependencyCommand(binary: string, args: string): string {
  if (hasCommand(binary)) return `${binary} ${args}`;
  if ((binary === "pnpm" || binary === "yarn") && hasCommand("corepack")) return `corepack ${binary} ${args}`;
  return `${binary} ${args}`;
}

function detectDependencyInstallCommand(root: string): string | undefined {
  const pkgPath = path.join(root, "package.json");
  if (!existsSync(pkgPath)) return undefined;

  let packageManager: string | undefined;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { packageManager?: string };
    packageManager = typeof pkg.packageManager === "string" ? pkg.packageManager.split("@")[0] : undefined;
  } catch {
    // keep default npm fallback for malformed package.json; install will report the real error.
  }

  const has = (name: string) => existsSync(path.join(root, name));
  if (packageManager === "pnpm" || has("pnpm-lock.yaml")) return dependencyCommand("pnpm", "install --frozen-lockfile");
  if (packageManager === "yarn" || has("yarn.lock")) {
    const args = has(".yarnrc.yml") ? "install --immutable" : "install --frozen-lockfile";
    return dependencyCommand("yarn", args);
  }
  if (packageManager === "bun" || has("bun.lock") || has("bun.lockb")) return dependencyCommand("bun", "install --frozen-lockfile");
  if (has("package-lock.json") || has("npm-shrinkwrap.json")) return "npm ci";
  return "npm install";
}

function outputTail(value: string, maxLines = 30, maxChars = 4000): string | undefined {
  const text = trim(value);
  if (!text) return undefined;
  const byLines = text.split(/\r?\n/).slice(-maxLines).join("\n");
  return byLines.length > maxChars ? byLines.slice(-maxChars) : byLines;
}

function hasComposeFile(root: string): boolean {
  return ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"].some((file) => existsSync(path.join(root, file)));
}

function hasDockerValidationTarget(root: string): boolean {
  return hasComposeFile(root) || existsSync(path.join(root, "Dockerfile")) || existsSync(path.join(root, "docker"));
}

function workonLoopStatePath(recordId: string): string {
  return path.join(WORKON_DIR, "loops", `${pathSlug(recordId)}.json`);
}

function makeLoopSliceId(slug: string, sliceIndex: number): string {
  return `${pathSlug(slug)}-${sliceIndex}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function limitBlock(value: string | undefined, maxChars = 4000): string {
  const text = trim(value ?? "");
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function createWorkonLoopState(record: WorkonRecord): WorkonLoopState {
  const now = new Date().toISOString();
  return {
    version: 1,
    recordId: record.id,
    slug: record.slug,
    worktreePath: record.worktreePath,
    branch: record.branch,
    originalGoal: record.loop?.goal || record.task,
    status: "running",
    activeSliceId: makeLoopSliceId(record.slug, 1),
    sliceIndex: 1,
    maxSlices: record.loop?.maxSlices ?? DEFAULT_WORKON_LOOP_MAX_SLICES,
    createdAt: now,
    updatedAt: now,
    history: [],
  };
}

async function readWorkonLoopState(statePath: string): Promise<WorkonLoopState | undefined> {
  try {
    const parsed = JSON.parse(await readFile(statePath, "utf8")) as Partial<WorkonLoopState>;
    if (
      parsed.version !== 1
      || typeof parsed.recordId !== "string"
      || typeof parsed.slug !== "string"
      || typeof parsed.worktreePath !== "string"
      || typeof parsed.activeSliceId !== "string"
      || typeof parsed.sliceIndex !== "number"
      || !Array.isArray(parsed.history)
      || (parsed.status !== "running" && parsed.status !== "done")
    ) return undefined;
    return parsed as WorkonLoopState;
  } catch {
    return undefined;
  }
}

async function writeWorkonLoopState(statePath: string, state: WorkonLoopState): Promise<void> {
  await mkdir(path.dirname(statePath), { recursive: true });
  await writeFile(statePath, `${JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2)}\n`, "utf8");
}

async function withWorkonLoopStateLock<T>(statePath: string, fn: () => Promise<T>): Promise<T> {
  const lockDir = `${statePath}.lock`;
  const started = Date.now();
  for (;;) {
    try {
      await mkdir(lockDir);
      break;
    } catch {
      try {
        const info = await stat(lockDir);
        if (Date.now() - info.mtimeMs > 60_000) await rm(lockDir, { recursive: true, force: true });
      } catch {
        // lock disappeared or could not be inspected; retry.
      }
      if (Date.now() - started > 15_000) throw new Error(`workonloop state lock timed out: ${lockDir}`);
      await sleep(120);
    }
  }

  try {
    return await fn();
  } finally {
    await rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function formatWorkonLoopHistory(state: WorkonLoopState): string {
  if (state.history.length === 0) return "- noch nichts umgesetzt";
  return state.history.map((item) => {
    const summary = limitBlock(item.implementedSummary.replace(/\s+/g, " "), 700);
    const next = item.nextPrompt ? `\n  next prompt idea: ${limitBlock(item.nextPrompt.replace(/\s+/g, " "), 500)}` : "";
    const gate = item.finalGate ? `\n  final gate: passed=${item.finalGate.passed}` : "";
    return `- Slice ${item.sliceIndex} (${item.outcome}, ${item.completedAt}): ${summary}${next}${gate}`;
  }).join("\n");
}

function buildWorkonLoopFinalGateInstructions(record: WorkonRecord): string {
  const detected = detectValidationCommands(record.worktreePath);
  const validationCommands = detected.length > 0
    ? detected.map((command) => `- \`${command}\``).join("\n")
    : "- keine package.json-Validierung automatisch erkannt; repo-spezifische Full-Gate-Checks selbst erkennen und ausführen";
  const dockerEnabled = record.docker === true;
  const dockerGate = !dockerEnabled
    ? "- Docker/Compose-Gate ist via `--nodocker` deaktiviert. Docker nicht nutzen; falls Docker sonst anwendbar waere, Begruendung in finalGate.notes dokumentieren."
    : hasDockerValidationTarget(record.worktreePath)
      ? hasComposeFile(record.worktreePath)
        ? `- Docker/Compose-Gate ist Pflicht. Nutze nur isolierten Project Name \`${record.composeProject}\` und Env \`${record.envPath}\`. Mindestens Compose config/build/up/test oder repo-passenden Docker-Full-Gate laufen lassen und danach eigene Container wieder stoppen.`
        : "- Dockerfile/docker target erkannt. Docker-Gate ist Pflicht: repo-passenden `docker build`/`docker run`/Docker-Test ausführen und Ergebnis in finalGate.docker dokumentieren."
      : "- Kein Dockerfile, keine Compose-Datei und kein docker-Verzeichnis erkannt. Docker-Gate als nicht anwendbar in finalGate.notes begründen.";
  return `Full-Gate vor \`outcome: "done"\`:\n${validationCommands}\n${dockerGate}`;
}

function buildWorkonLoopPrompt(record: WorkonRecord, state: WorkonLoopState, slicePrompt: string): string {
  const cleanSlicePrompt = limitBlock(slicePrompt, 5000) || "Bestimme den naechsten sinnvoll zusammenhaengenden Slice aus Zielbild und bisheriger Umsetzung, passend fuer ein 270k-Token-Kontextfenster.";
  return `Read workon handoff ${record.markdownPath}. Treat its Workon Operating Contract and Workon Loop sections as task-specific instructions.

Zielbild:
${limitBlock(state.originalGoal, 6000)}

Loop-State:
- state file: ${record.loop?.statePath ?? "unknown"}
- slice: ${state.sliceIndex}/${state.maxSlices}
- sliceId: ${state.activeSliceId}
- branch: ${record.branch}
- worktree: ${record.worktreePath}

Bisher umgesetzt:
${formatWorkonLoopHistory(state)}

Aktueller Auftrag:
${cleanSlicePrompt}

${WORKON_LOOP_REVIEW_SENTENCE}

Arbeitsregeln für diesen Slice:
1. Arbeite nur in ${record.worktreePath}.
2. Implementiere einen sinnvoll zusammenhaengenden Slice, der das 270k-Token-Kontextfenster gut nutzt. Keine kuenstlichen Mini-Slices; trotzdem kein unkontrollierter Big-Bang.
3. Wenn der Slice unklar ist: kurz selbst Scope eingrenzen; bei echter Produkt-/Architekturentscheidung stoppen und fragen.
4. Nicht manuell pushen, kein manuelles \`/pr\`, kein \`/ship\`, kein \`/shipmerge\`, kein Merge nach main. Beim finalen \`outcome: "done"\` erstellt das Tool automatisch den PR.
5. Am Ende dieses Slices MUSST du das Tool \`workonloop_finish_slice\` aufrufen.
6. Wenn noch sinnvoller Slice übrig ist: \`outcome: "next"\`, kurze \`implementedSummary\`, und \`nextPrompt\` als Vorschlag für den nächsten Slice.
7. Wenn kein sinnvoller Slice mehr übrig ist: erst Full-Gate laufen lassen, dann \`outcome: "done"\` mit strukturierter \`finalGate\`. Danach bleibt dieses Terminal offen, Testserver startet, PR wird erstellt/aktualisiert.

${buildWorkonLoopFinalGateInstructions(record)}

Tool-Aufruf am Ende:
- \`sliceId\` muss exakt \`${state.activeSliceId}\` sein.
- \`implementedSummary\`: was geändert wurde, wichtige Dateien, Tests/Checks.
- \`nextPrompt\`: nur bei \`outcome: "next"\`, wird als Vorschlag behandelt.
- \`finalGate\`: nur bei \`outcome: "done"\`, mit commands/docker command + exitCode + passed=true.

Bleib in ${record.worktreePath}.`;
}

function normalizeCommandForMatch(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function commandMatchesExpected(ran: string, expected: string): boolean {
  const cleanRan = normalizeCommandForMatch(ran);
  const cleanExpected = normalizeCommandForMatch(expected);
  if (cleanRan === cleanExpected || cleanRan.includes(cleanExpected)) return true;
  if (cleanExpected === "npm test" && cleanRan.includes("npm run test")) return true;
  if (cleanExpected === "npx playwright test" && cleanRan.includes("npm run test:e2e")) return true;
  return false;
}

function validateWorkonLoopFinalGate(record: WorkonRecord, finalGate: WorkonLoopFinalGate | undefined): string[] {
  const problems: string[] = [];
  if (!finalGate) return ["finalGate missing for outcome=done"];
  if (finalGate.passed !== true) problems.push("finalGate.passed must be true");

  const commands = Array.isArray(finalGate.commands) ? finalGate.commands : [];
  if (commands.length === 0) problems.push("finalGate.commands must list full validation commands");
  for (const command of commands) {
    if (!command.command || typeof command.exitCode !== "number") problems.push("every finalGate.commands item needs command and exitCode");
    else if (command.exitCode !== 0) problems.push(`validation command failed (${command.exitCode}): ${command.command}`);
  }

  for (const expected of detectValidationCommands(record.worktreePath)) {
    if (!commands.some((command) => commandMatchesExpected(command.command, expected))) {
      problems.push(`missing detected full validation command: ${expected}`);
    }
  }

  const dockerCommands = Array.isArray(finalGate.docker) ? finalGate.docker : [];
  if (record.docker !== true) {
    if (dockerCommands.length > 0) problems.push("finalGate.docker must be empty because Docker/Compose is disabled by --nodocker");
  } else if (hasDockerValidationTarget(record.worktreePath)) {
    if (dockerCommands.length === 0) problems.push("finalGate.docker must list Docker validation because Docker/Compose target exists");
    const hasCompose = hasComposeFile(record.worktreePath);
    if (hasCompose && !dockerCommands.some((command) => /\bdocker\s+compose\b|\bdocker-compose\b/.test(command.command))) {
      problems.push("finalGate.docker must include a docker compose/docker-compose command for compose projects");
    }
    if (!hasCompose && !dockerCommands.some((command) => /\bdocker\s+(build|run)\b/.test(command.command))) {
      problems.push("finalGate.docker must include a docker build/docker run command for Dockerfile/docker targets");
    }
    for (const command of dockerCommands) {
      if (!command.command || typeof command.exitCode !== "number") problems.push("every finalGate.docker item needs command and exitCode");
      else if (command.exitCode !== 0) problems.push(`Docker command failed (${command.exitCode}): ${command.command}`);
    }
  }

  return problems;
}

function scheduleWorkonLoopShutdown(ctx: WorkonUiContext, windowAddress?: string): void {
  const timer = setTimeout(() => {
    try { ctx.shutdown?.(); } catch {}
  }, 300);
  if (typeof (timer as { unref?: () => void }).unref === "function") (timer as { unref: () => void }).unref();
  if (windowAddress && hasCommand("hyprctl")) {
    const closeWindow = `sleep 1; hyprctl dispatch closewindow ${shellQuote(`address:${windowAddress}`)} >/dev/null 2>&1 || true`;
    spawnDetached("sh", ["-lc", closeWindow], WORKON_DIR);
  }
}

async function bootstrapDependencies(
  pi: ExtensionAPI,
  root: string,
  onStatus?: (message: string) => void,
): Promise<WorkonDependencyBootstrap> {
  const command = detectDependencyInstallCommand(root);
  if (!command) return { status: "not-needed", summary: "no package.json detected" };

  if (existsSync(path.join(root, "node_modules"))) {
    return { status: "already-present", command, summary: "node_modules already exists; skipped automatic install" };
  }

  onStatus?.(`install deps: ${command}`);
  const result = await execShell(pi, root, command, 600_000);
  if (result.code === 0) {
    return { status: "installed", command, summary: `installed automatically with \`${command}\`` };
  }

  return {
    status: "failed",
    command,
    summary: `automatic install failed; first worker step: run \`${command}\` (or \`npm install\` if lockfile install is not usable)`,
    outputTail: outputTail(`${result.stdout}\n${result.stderr}`),
  };
}

async function ensureWorktree(pi: ExtensionAPI, root: string, target: string, branch: string, base: string): Promise<{ created: boolean; message: string }> {
  if (existsSync(target)) {
    return { created: false, message: `Worktree exists: ${target}` };
  }

  await mkdir(path.dirname(target), { recursive: true });
  const exists = await branchExists(pi, root, branch);
  const args = exists
    ? ["worktree", "add", target, branch]
    : ["worktree", "add", "-b", branch, target, base];
  const result = await git(pi, root, args, 120_000);
  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout || "git worktree add failed");
  }
  return { created: true, message: trim(result.stdout || result.stderr) || `Created ${target}` };
}

function buildHardPlanPaths(worktreePath: string, slug: string): WorkonHardPlanPaths {
  const planDir = path.join(worktreePath, "plans", `workon-${pathSlug(slug)}`);
  return {
    planDir,
    briefPath: path.join(planDir, "00-brief.md"),
    scoutPath: path.join(planDir, "10-scout.md"),
    plannerPath: path.join(planDir, "20-planner.md"),
    planPath: path.join(planDir, "30-plan.md"),
    planReviewPath: path.join(planDir, "40-plan-review.md"),
    implementationReviewPath: path.join(planDir, "90-implementation-review.md"),
    plannotatorConfigPath: path.join(worktreePath, ".pi", "plannotator.json"),
  };
}

function buildHardPlanPlannotatorConfig(hardPlan: WorkonHardPlanPaths): string {
  const config = {
    phases: {
      planning: {
        activeTools: ["grep", "find", "ls", "subagent", "plannotator_submit_plan"],
        systemPrompt: `[PLANNOTATOR - HARD PLANNING PHASE]
You are in hard plan mode. You MUST NOT implement or change production/source code in this session. During planning you may only write or edit markdown planning artifacts inside the working directory.

Available tools: read, bash, grep, find, ls, write (markdown only), edit (markdown only), subagent, plannotator_submit_plan

Bash is for read-only inspection only. Do not run destructive commands or state-changing operations in planning mode: no rm/mv/chmod, no git push/commit/reset/checkout, no npm install, no package installs, no service restarts, no Docker cleanup. Use bash for commands like git status, grep/rg/find, ls, test discovery, and bounded read-only inspection.

Hard-plan artifacts:
- scout findings: ${hardPlan.scoutPath}
- planner findings: ${hardPlan.plannerPath}
- reviewed plan: ${hardPlan.planPath}

Subagent rules:
- Use subagent only for read-only planning help.
- First run a scout subagent to map relevant files, risks, scripts, existing patterns, and open questions. Ask it not to modify project/source files; save or incorporate its result in the scout findings file.
- Before submitting the plan, run a planner subagent to critique or refine the plan. Ask it not to modify project/source files; save or incorporate its result in the planner findings file.
- Do not launch writer/worker subagents in planning mode.
- If the subagent tool or required agents are unavailable, stop and ask the user.

Planning workflow:
1. Read the workon handoff.
2. Run/use scout and write compressed findings to the scout artifact.
3. Run/use planner and write compressed findings to the planner artifact.
4. Write a concise German implementation plan to the reviewed plan path.
5. Call plannotator_submit_plan with the reviewed plan path.
6. Revise the same plan file until approved, then stop and tell the user to start fresh implementation with /workon-read.

Do not end your turn without asking a needed question or calling plannotator_submit_plan.`,
      },
    },
  };
  return `${JSON.stringify(config, null, 2)}\n`;
}

async function addWorktreeInfoExclude(pi: ExtensionAPI, cwd: string, pattern: string): Promise<void> {
  const gitDirResult = await execShell(pi, cwd, "git rev-parse --git-dir", 30_000);
  if (gitDirResult.code !== 0) throw new Error(gitDirResult.stderr || gitDirResult.stdout || "git rev-parse --git-dir failed");
  const rawGitDir = trim(gitDirResult.stdout);
  const gitDir = path.isAbsolute(rawGitDir) ? rawGitDir : path.join(cwd, rawGitDir);
  const excludePath = path.join(gitDir, "info", "exclude-workon");

  await mkdir(path.dirname(excludePath), { recursive: true });
  let current = "";
  try { current = await readFile(excludePath, "utf8"); } catch {}
  const lines = current.split(/\r?\n/);
  if (!lines.includes(pattern)) {
    const prefix = current && !current.endsWith("\n") ? "\n" : "";
    await writeFile(excludePath, `${current}${prefix}${pattern}\n`, "utf8");
  }

  let configured = "";
  const existing = await execShell(pi, cwd, "git config --worktree --get core.excludesFile", 30_000);
  if (existing.code === 0) configured = trim(existing.stdout);
  if (configured === excludePath) return;

  const enable = await execShell(pi, cwd, "git config extensions.worktreeConfig true", 30_000);
  if (enable.code !== 0) throw new Error(enable.stderr || enable.stdout || "git config extensions.worktreeConfig true failed");
  const set = await execShell(pi, cwd, `git config --worktree core.excludesFile ${shellQuote(excludePath)}`, 30_000);
  if (set.code !== 0) throw new Error(set.stderr || set.stdout || "git config --worktree core.excludesFile failed");
}

async function writeHardPlanPlannotatorConfig(pi: ExtensionAPI, hardPlan: WorkonHardPlanPaths): Promise<void> {
  await mkdir(path.dirname(hardPlan.plannotatorConfigPath), { recursive: true });
  await writeFile(hardPlan.plannotatorConfigPath, buildHardPlanPlannotatorConfig(hardPlan), "utf8");
  await addWorktreeInfoExclude(pi, path.dirname(path.dirname(hardPlan.plannotatorConfigPath)), ".pi/plannotator.json");
}

function buildWorkonEnv(record: WorkonRecord): string {
  return [
    `COMPOSE_PROJECT_NAME=${record.composeProject}`,
    `WORKON_SLUG=${record.slug}`,
    `WORKON_BRANCH=${record.branch.replace(/[^a-zA-Z0-9_.-]+/g, "-")}`,
    `WORKON_WEB_PORT=${record.devPorts.web}`,
    `WORKON_API_PORT=${record.devPorts.api}`,
    `WORKON_DB_PORT=${record.devPorts.db}`,
    `WORKON_EXTRA_PORT=${record.devPorts.extra}`,
    `PORT=${record.devPorts.web}`,
    `WEB_PORT=${record.devPorts.web}`,
    `APP_PORT=${record.devPorts.web}`,
    `CLIENT_PORT=${record.devPorts.web}`,
    `VITE_PORT=${record.devPorts.web}`,
    `API_PORT=${record.devPorts.api}`,
    `SERVER_PORT=${record.devPorts.api}`,
    `BACKEND_PORT=${record.devPorts.api}`,
    `DB_PORT=${record.devPorts.db}`,
    `DATABASE_PORT=${record.devPorts.db}`,
    `POSTGRES_PORT=${record.devPorts.db}`,
    "",
    "# Local worktree validation/runtime defaults. Dev-only placeholder values.",
    `DATABASE_URL=postgresql://workon:workon@127.0.0.1:${record.devPorts.db}/workon_dev?schema=public`,
    "DOCKER_DATABASE_URL=postgresql://workon:workon@db:5432/workon_dev?schema=public",
    "POSTGRES_DB=workon_dev",
    "POSTGRES_USER=workon",
    "POSTGRES_PASSWORD=workon",
    `NEXTAUTH_URL=http://127.0.0.1:${record.devPorts.web}`,
    `APP_PUBLIC_URL=http://127.0.0.1:${record.devPorts.web}`,
    "NEXTAUTH_SECRET=workon-dev-placeholder-secret",
    "AUTH_SECRET=workon-dev-placeholder-secret",
    "SEED_DEFAULT_PASSWORD=workon-dev-password",
    "E2E_TARGET=local",
    `PLAYWRIGHT_BASE_URL=http://127.0.0.1:${record.devPorts.web}`,
    "",
  ].join("\n");
}

async function writeRecord(record: WorkonRecord, markdown: string): Promise<void> {
  await mkdir(WORKON_DIR, { recursive: true });
  const json = `${JSON.stringify(record, null, 2)}\n`;
  await Promise.all([
    writeFile(record.handoffPath, json, "utf8"),
    writeFile(record.markdownPath, markdown, "utf8"),
    writeFile(record.envPath, buildWorkonEnv(record), "utf8"),
    writeFile(path.join(WORKON_DIR, "latest.json"), json, "utf8"),
    writeFile(path.join(WORKON_DIR, "latest.md"), markdown, "utf8"),
    writeFile(path.join(WORKON_DIR, "latest.env"), buildWorkonEnv(record), "utf8"),
  ]);
}

function buildDependencyBootstrapSection(dependencyBootstrap?: WorkonDependencyBootstrap): string {
  if (!dependencyBootstrap || dependencyBootstrap.status === "not-needed") return "";
  const lines = [
    "## Dependency bootstrap",
    "- why: Git worktrees do not copy ignored `node_modules`; each worktree needs its own install.",
    dependencyBootstrap.command ? `- command: \`${dependencyBootstrap.command}\`` : undefined,
    `- status: ${dependencyBootstrap.summary}`,
    "- worker rule: if `node_modules/.bin` is missing or imports fail, run the command above before tests/dev server.",
  ].filter((line): line is string => Boolean(line));

  if (dependencyBootstrap.outputTail) {
    return `${lines.join("\n")}\n\nLast install output:\n\n\`\`\`text\n${dependencyBootstrap.outputTail}\n\`\`\`\n`;
  }
  return `${lines.join("\n")}\n`;
}

function buildMarkdown(
  record: WorkonRecord,
  projectHints: string[],
  dirtyWarning: boolean,
  mode: WorkonMode = "workon",
  dependencyBootstrap?: WorkonDependencyBootstrap,
): string {
  const planningMode = mode === "workonplan" || mode === "workonhardplan";
  const hardPlanningMode = mode === "workonhardplan";
  const loopMode = mode === "workonloop";
  const recommendedPlanPath = hardPlanningMode && record.hardPlan ? record.hardPlan.planPath : `plans/workon-${record.slug}.md`;
  const refs = record.references.length > 0
    ? record.references.map((ref) => `- ${ref}`).join("\n")
    : "- none detected";
  const hints = projectHints.length > 0
    ? projectHints.map((hint) => `- ${hint}`).join("\n")
    : "- inspect project scripts/config first";
  const dirty = dirtyWarning
    ? "\n> Note: source repo had uncommitted changes. They are not automatically copied into this worktree. Inspect if needed.\n"
    : "";
  const dependencySection = buildDependencyBootstrapSection(dependencyBootstrap ?? record.dependencyBootstrap);
  const dockerEnabled = record.docker === true;
  const dockerStatusLine = dockerEnabled
    ? loopMode
      ? "- Docker/Compose: enabled by default for `/workonloop` final gate. Disable with `--nodocker`."
      : "- Docker/Compose: enabled by default. Disable with `--nodocker`."
    : "- Docker/Compose: disabled because `--nodocker` was passed.";
  const dockerValidationLine = dockerEnabled
    ? "- `runtime-config` / Docker / env / CI changes: run the relevant config/server validation and isolated Compose only if needed."
    : "- `runtime-config` / Docker / env / CI changes: validate without Docker/Compose. If runtime validation truly needs Compose, stop and ask the user to recreate/continue the handoff without `--nodocker`.";
  const dockerAllowanceLine = dockerEnabled
    ? loopMode
      ? "Docker/Compose may be used because `/workonloop` enables it by default for the final full gate. During intermediate slices, use Docker only when needed for focused runtime validation."
      : "Docker/Compose may be used by default for this handoff. Use it only when runtime/UI/API/config validation needs it."
    : "Docker/Compose may not be used for this handoff unless the user explicitly recreates/continues it without `--nodocker`.";
  const dockerRules = dockerEnabled
    ? `- Docker testservers are enabled for this handoff, but only use them when runtime/UI/API/config validation needs a server. Docker testservers must be isolated per worktree/branch. If another branch already has a Docker/Compose testserver running, do not stop, kill, restart, or reuse it. Start your own server with the compose project and env file above (for example \`docker compose -p ${record.composeProject} --env-file ${record.envPath} up ...\`) and only clean up that project.
- Use the assigned ports above for host port bindings. If the compose/dev config hardcodes host ports like \`3000:3000\` or \`3001:3001\`, make a branch-local fix/override so this worktree binds to its assigned ports instead of stealing another branch's ports.
- Playwright warning: hardcoded \`baseURL\`, \`webServer.port\`, or \`reuseExistingServer: true\` can silently reuse another branch's running server and make targeted tests look green while full \`npm test\` fails. Prefer env-driven ports from \`${record.envPath}\` and avoid reusing a server unless it is this worktree's assigned server.
- When a Docker/Compose testserver was started or runtime behavior was changed, include \`Testserver: http://localhost:${record.devPorts.web}\` or the actual published URL. Inspect published ports with \`docker compose -p ${record.composeProject} --env-file ${record.envPath} ps\` or \`docker compose -p ${record.composeProject} --env-file ${record.envPath} port\` instead of guessing.`
    : "- Docker/Compose testserver is disabled for this handoff. Do not start Docker/Compose and do not report a Docker-backed testserver URL. If runtime validation truly needs Compose, stop and ask the user to recreate/continue the handoff without `--nodocker`.";
  const subagentGateSection = hardPlanningMode
    ? `
### Mandatory Subagent Gate
For \`/workonhardplan\`, subagents are mandatory, not optional. This worktree gets a local \`.pi/plannotator.json\` so \`subagent\` remains available during Plannotator planning without changing global Plannotator defaults.

1. Before drafting or submitting the plan, run/use a read-only \`scout\` subagent to map relevant files, risks, scripts, existing patterns, and open questions.
2. Before calling \`plannotator_submit_plan\`, run/use a read-only \`planner\` subagent to turn scout context into an implementation plan or critique the drafted plan. Incorporate its findings into the plan file.
3. Do not launch writer/worker subagents in planning mode; the planning session may only write markdown planning artifacts.
4. After approved implementation and before final summary, \`/pr\`, or "done", run/use a fresh-context \`reviewer\` subagent on the current diff. Fix or explicitly answer its findings, then validate.
5. If the \`subagent\` tool or required agents are unavailable, stop and ask the user. Do not silently skip. Only skip this gate when the user explicitly overrides it.
`
    : "";
  const plannotatorSection = planningMode
    ? `
## Plannotator Plan Mode
This session was started for reviewed planning before implementation.

- You should already be in Plannotator plan mode via \`pi --plan\`.
- Before edits, write a reviewed plan to \`${recommendedPlanPath}\` or another clear markdown path inside the worktree.
- Write the plan in German by default: German section headings, German acceptance criteria, German verification notes. Keep code symbols, file paths, commands, API names, and exact errors unchanged.
- The plan must include: scope map, assumptions/questions, non-goals, implementation slices, done criteria, verification commands, screenshot/Playwright checks when relevant, and ask-before rules.
${subagentGateSection}
- Submit the plan with \`plannotator_submit_plan\` and revise the same file until the user approves it.
- Do not implement before approval unless the user explicitly says to skip the planning gate.
- After implementation, run \`/plannotator-review\` before \`/pr\` for larger/riskier diffs.
`
    : "";

  const loop = record.loop;
  const loopSection = loopMode && loop
    ? `
## Workon Loop Mode
This session is managed by \`/workonloop\`: build the feature as serial slices in the same feature worktree.

- Zielbild: ${loop.goal}
- Loop state: \`${loop.statePath}\`
- Max slices: \`${loop.maxSlices}\`
- End of each slice: call \`workonloop_finish_slice\` exactly once.
- Hook reminder: ${WORKON_LOOP_REVIEW_SENTENCE}
- The tool starts the next worker terminal when \`outcome: "next"\` is accepted.
- Final step must be \`outcome: "done"\` only after the full validation gate and Docker/Compose gate passed.
- Do not manually run \`/pr\` or \`git push\`; final \`outcome: "done"\` keeps this terminal open, starts the isolated testserver, and creates/updates the PR automatically. No \`/ship\`, no \`/shipmerge\`, no merge to main unless the user explicitly asks in the worker terminal.

${buildWorkonLoopFinalGateInstructions(record)}
`
    : "";

  const hardPlan = record.hardPlan;
  const hardPlanSection = hardPlanningMode && hardPlan
    ? `
## Workon Hard Plan Mode
This mode is for very hard tasks where planning can consume too much context. Keep this planning session lean and move bulky knowledge into files.

### Hard-plan artifact paths
- brief/context budget: \`${hardPlan.briefPath}\`
- scout findings: \`${hardPlan.scoutPath}\`
- planner findings: \`${hardPlan.plannerPath}\`
- submitted plan: \`${hardPlan.planPath}\`
- plan review notes: \`${hardPlan.planReviewPath}\`
- implementation review notes: \`${hardPlan.implementationReviewPath}\`
- local Plannotator config: \`${hardPlan.plannotatorConfigPath}\` (ignored via worktree-specific \`core.excludesFile\`; enables \`subagent\` only for this worktree's planning phase)

### Hard-plan workflow
1. Planning session only. Do not implement code in this session, even after Plannotator approval, unless the user explicitly overrides.
2. Write bulky exploration into the artifact files above. Keep chat summaries short and keep \`${hardPlan.planPath}\` concise enough for review.
3. Run/use read-only \`scout\` and save compressed findings to \`${hardPlan.scoutPath}\` before drafting the submitted plan.
4. Run/use read-only \`planner\` and save/incorporate findings before calling \`plannotator_submit_plan\`.
5. Submit \`${hardPlan.planPath}\`, revise until approved, then stop.
6. After approval, tell the user to start a fresh implementation context in this worktree with \`/workon-read ${record.slug}\`. The fresh implementation session reads the approved plan and artifacts as needed.
7. The fresh implementation session must run/use a fresh-context \`reviewer\` before final summary, \`/pr\`, or "done".
`
    : "";

  return `# Workon Handoff: ${record.slug}

${dirty}
## Task
${record.task || "Continue work for this branch."}

## Repo
- repo root: \`${record.repoRoot}\`
- worktree: \`${record.worktreePath}\`
- branch: \`${record.branch}\`
- base: \`${record.base}\`
- compose project: \`${record.composeProject}\`
- workon env file: \`${record.envPath}\`
${dockerStatusLine}
- assigned dev URLs/ports:
  - web: \`http://localhost:${record.devPorts.web}\`
  - api: \`http://localhost:${record.devPorts.api}\`
  - db host port: \`${record.devPorts.db}\`
  - extra host port: \`${record.devPorts.extra}\`

## References
${refs}

## Project hints
${hints}
${dependencySection}
## Workon Operating Contract
Treat this as the task-specific operating contract for the worker Pi session:

1. First map the scope: identify relevant routes/files/config, current branch/worktree, available scripts, and likely blast radius.
2. If the task is unclear, risky, or acceptance criteria are missing, ask the user before making assumptions.
3. Decide whether one 270k-token context is enough. If not, use real subagents when available:
   - \`scout\` for unfamiliar code/context discovery.
   - \`oracle\` for risky product/architecture decisions.
   - fresh-context \`reviewer\` after edits for correctness/tests/simplicity.
   - Keep one writer unless work is clearly isolated.
4. Make a short plan before edits. Include: implementation steps, done criteria, and verification steps.
5. Prefer durable regression coverage for non-trivial fixes. Add/adjust unit, integration, or Playwright e2e tests when behavior risk warrants it; do not add noisy tests for trivial cosmetic-only changes.
6. For UI work, use Playwright where practical:
   - Playwright tests/docs: https://playwright.dev/docs/intro
   - Playwright UI annotation skill: \`~/.pi/agent/skills/playwright-ui/SKILL.md\`
   - Skill purpose: open a real page, emulate desktop/mobile, overlay DOM labels, collect human annotations as JSON under \`.playwright-ui/\`.
7. If screenshot(s) are part of the task, final verification must include a fresh Playwright/browser screenshot of the fixed state. Compare it against the reported issue before claiming done.
8. Keep artifacts small and local. Do not commit \`.playwright-ui/\` annotations/screenshots unless explicitly asked.

## Validation Budget
Before running expensive validation, classify the change scope and choose the smallest sufficient gate:

- \`docs-prompt-only\` / \`docs-only\`: read the changed file, review the diff, and run \`git diff --check\` if useful. Do not run npm tests, build, Playwright, or Docker.
- \`docs-user-facing\` / runbook changes: review diff plus path/link sanity checks. No Docker unless runtime behavior is touched.
- \`code-server\` / \`code-shared\`: run typecheck and focused tests for touched logic. Full \`npm test\` only before PR/release or if risk warrants it.
- \`code-ui\`: run typecheck plus focused UI/e2e test; build when frontend/runtime output is affected.
${dockerValidationLine}
- \`PR\`, \`ship\`, release, or explicit user request for \"full gate\": run the repo's full required gate.

${dockerAllowanceLine} If generic rules conflict with the task's low-risk scope, prefer this smaller validation budget and mention the choice in the final summary. If unsure whether the user wants full validation, ask before running expensive tests. If unsure whether Docker is allowed, treat it as disabled.
${plannotatorSection}${loopSection}${hardPlanSection}
## Rules
- Work only in the worktree path above.
- Do not edit \`main\`/\`master\` directly.
- Use synthetic/dev data. Do not copy production secrets into git.
- If app needs auth, use dev/test auth only when explicitly enabled by local env.
- Run validation according to the Validation Budget above. Do not run expensive gates for docs-only/prompt-only changes unless explicitly requested.
${dockerRules}
- Do not report \"tests green\" after only targeted specs. For PR/release/full-gate work, run the same full gate as \`/pr\` will run: \`npm run typecheck\`, full \`npm test\`, and \`npm run build\` when present.
- When solved: commit changes when appropriate for the worktree. Run \`/pr\` only for PR-ready code/runtime changes or when the user asks; for docs-only/prompt-only changes, pushing the commit is usually enough.
- Do not merge automatically. Use \`/ship\` only after PR/checks are green and user approves.
`;
}

function hasCommand(name: string): boolean {
  const result = spawnSync("sh", ["-lc", `command -v ${shellQuote(name)} >/dev/null 2>&1`], { stdio: "ignore", timeout: 2_000 });
  return result.status === 0;
}

function activeWorkspaceId(): number | undefined {
  const result = spawnSync("hyprctl", ["activeworkspace", "-j"], { encoding: "utf8", timeout: 2_000 });
  if (result.status !== 0) return undefined;
  try {
    const parsed = JSON.parse(result.stdout) as { id?: number };
    return typeof parsed.id === "number" && parsed.id > 0 ? parsed.id : undefined;
  } catch {
    return undefined;
  }
}

type HyprClient = {
  address?: unknown;
  pid?: unknown;
  workspace?: { id?: unknown; name?: unknown };
};

function parentPid(pid: number): number | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const closeParen = stat.lastIndexOf(")");
    if (closeParen === -1) return undefined;
    const fields = stat.slice(closeParen + 2).trim().split(/\s+/);
    const parsed = Number(fields[1]);
    return Number.isFinite(parsed) && parsed > 1 ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function ancestorPids(pid: number): Set<number> {
  const pids = new Set<number>();
  let current: number | undefined = pid;
  for (let depth = 0; current && depth < 30; depth += 1) {
    pids.add(current);
    current = parentPid(current);
  }
  return pids;
}

function hyprClientForPid(pid: number): HyprClient | undefined {
  const result = spawnSync("hyprctl", ["clients", "-j"], { encoding: "utf8", timeout: 2_000 });
  if (result.status !== 0) return undefined;
  try {
    const clients = JSON.parse(result.stdout) as HyprClient[];
    const pids = ancestorPids(pid);
    return clients.find((candidate) => typeof candidate.pid === "number" && pids.has(candidate.pid));
  } catch {
    return undefined;
  }
}

function windowAddressForPid(pid: number): string | undefined {
  const client = hyprClientForPid(pid);
  return typeof client?.address === "string" && client.address ? client.address : undefined;
}

function workspaceIdForPid(pid: number): number | undefined {
  const id = hyprClientForPid(pid)?.workspace?.id;
  return typeof id === "number" && id > 0 ? id : undefined;
}

function ownTerminalWindowAddress(): string | undefined {
  return windowAddressForPid(process.pid);
}

function ownTerminalWorkspaceId(): number | undefined {
  return workspaceIdForPid(process.pid);
}

function terminalCommandLine(shellCommand: string): string {
  const command = `${shellCommand}; exec ${process.env.SHELL || "/bin/bash"}`;
  const quoted = shellQuote(command);

  if (hasCommand("xdg-terminal-exec")) return `xdg-terminal-exec -- sh -lc ${quoted}`;
  if (hasCommand("ghostty")) return `ghostty -e sh -lc ${quoted}`;
  if (hasCommand("alacritty")) return `alacritty -e sh -lc ${quoted}`;
  if (hasCommand("kitty")) return `kitty sh -lc ${quoted}`;
  if (hasCommand("foot")) return `foot sh -lc ${quoted}`;
  return `sh -lc ${quoted}`;
}

function writeLauncherScript(slug: string, cwd: string, prompt: string, options: { planMode?: boolean }): string {
  mkdirSyncWorkonDir();
  const scriptPath = path.join(WORKON_DIR, `${pathSlug(slug)}-launch.sh`);
  // Put prompt before --plan. Pi treats unknown flags with a following token as flag values,
  // so `pi --plan "prompt"` enables plan mode but swallows the initial prompt.
  const piArgs = options.planMode ? `${shellQuote(prompt)} --plan` : shellQuote(prompt);
  const terminalLine = terminalCommandLine(`cd ${shellQuote(cwd)} && pi ${piArgs}`);
  writeFileSync(
    scriptPath,
    `#!/bin/sh\ncd ${shellQuote(cwd)} || exit 1\nexec ${terminalLine}\n`,
    "utf8",
  );
  chmodSync(scriptPath, 0o700);
  return scriptPath;
}

function mkdirSyncWorkonDir(): void {
  try {
    mkdirSync(WORKON_DIR, { recursive: true });
  } catch {
    // async writeRecord will report real failures elsewhere; launcher path may still fail below.
  }
}

function spawnDetached(command: string, args: string[], cwd: string): void {
  const child = spawn(command, args, { cwd, detached: true, stdio: "ignore" });
  child.unref();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function openTerminalInWorkspace(cwd: string, prompt: string, options: { planMode?: boolean; slug?: string; workspaceId?: number } = {}): { ok: true; commandLine: string } | { ok: false; error: string } {
  try {
    const launcher = writeLauncherScript(options.slug ?? path.basename(cwd), cwd, prompt, options);
    const workspace = options.workspaceId ?? activeWorkspaceId();
    if (workspace && hasCommand("hyprctl")) {
      spawnDetached("hyprctl", ["dispatch", "exec", `[workspace ${workspace} silent] ${launcher}`], cwd);
    } else {
      spawnDetached(launcher, [], cwd);
    }
    return { ok: true, commandLine: launcher };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function scheduleWorkerTerminalCleanup(record: WorkonRecord, windowAddress: string, logPath: string): void {
  const closeWindow = `hyprctl dispatch closewindow ${shellQuote(`address:${windowAddress}`)} || true`;
  const latestJson = path.join(WORKON_DIR, "latest.json");
  const latestMd = path.join(WORKON_DIR, "latest.md");
  const latestEnv = path.join(WORKON_DIR, "latest.env");
  const launchScript = path.join(WORKON_DIR, `${pathSlug(record.slug)}-launch.sh`);
  const script = `
{
  set -u
  echo "$(date -Is) workon cleanup scheduled for ${record.slug}"
  sleep 2
  ${closeWindow}
  sleep 2
  if [ -d /proc ]; then
    for cwdlink in /proc/[0-9]*/cwd; do
      pid="$(basename "$(dirname "$cwdlink")")"
      [ "$pid" = "$$" ] && continue
      cwd="$(readlink "$cwdlink" 2>/dev/null || true)"
      case "$cwd" in
        ${shellQuote(record.worktreePath)}|${shellQuote(`${record.worktreePath}/`)}*) kill -TERM "$pid" 2>/dev/null || true ;;
      esac
    done
    sleep 2
    for cwdlink in /proc/[0-9]*/cwd; do
      pid="$(basename "$(dirname "$cwdlink")")"
      [ "$pid" = "$$" ] && continue
      cwd="$(readlink "$cwdlink" 2>/dev/null || true)"
      case "$cwd" in
        ${shellQuote(record.worktreePath)}|${shellQuote(`${record.worktreePath}/`)}*) kill -KILL "$pid" 2>/dev/null || true ;;
      esac
    done
    sleep 1
  fi
  if [ -d ${shellQuote(record.worktreePath)} ]; then
    status="$(git -C ${shellQuote(record.worktreePath)} status --porcelain --untracked-files=normal)"
    status_code=$?
    if [ "$status_code" -ne 0 ]; then
      echo "ABORT could not inspect worktree before removal (status $status_code):"
      printf '%s\n' "$status"
      exit 1
    fi
    if [ -n "$status" ]; then
      echo "ABORT dirty worktree before removal:"
      printf '%s\n' "$status"
      exit 1
    fi
  fi
  remove_ok=0
  if git -C ${shellQuote(record.repoRoot)} worktree remove ${shellQuote(record.worktreePath)}; then
    echo "OK git worktree remove"
    remove_ok=1
  else
    echo "WARN git worktree remove failed; forcing because worktree was clean before removal"
    if git -C ${shellQuote(record.repoRoot)} worktree remove --force ${shellQuote(record.worktreePath)}; then
      echo "OK git worktree remove --force"
      remove_ok=1
    fi
  fi
  if [ "$remove_ok" -ne 1 ]; then
    echo "ABORT worktree removal failed; diagnostics:"
    ls -ld ${shellQuote(record.worktreePath)} 2>&1 || true
    find ${shellQuote(record.worktreePath)} ! -user "$(id -un)" -printf '%M %u:%g %p\n' 2>/dev/null | head -40 || true
    find ${shellQuote(record.worktreePath)} ! -writable -printf '%M %u:%g %p\n' 2>/dev/null | head -40 || true
    if command -v lsattr >/dev/null 2>&1; then
      lsattr -d ${shellQuote(record.worktreePath)} 2>/dev/null || true
      lsattr ${shellQuote(record.worktreePath)} 2>/dev/null | grep -v '^--------------' | head -40 || true
    fi
    echo "If diagnostics show root/non-current-user ownership or immutable files, run: sudo chown -R \"$USER:$USER\" ${shellQuote(record.worktreePath)} && chmod -R u+rwX ${shellQuote(record.worktreePath)}"
    echo "ABORT worktree removal failed; keeping workon artifacts"
    exit 1
  fi
  rm -f ${shellQuote(record.handoffPath)} ${shellQuote(record.markdownPath)} ${shellQuote(record.envPath)} ${shellQuote(launchScript)}
  if [ -f ${shellQuote(latestJson)} ] && grep -Fq ${shellQuote(record.id)} ${shellQuote(latestJson)}; then
    rm -f ${shellQuote(latestJson)} ${shellQuote(latestMd)} ${shellQuote(latestEnv)}
  fi
  echo "$(date -Is) workon cleanup done for ${record.slug}"
} >> ${shellQuote(logPath)} 2>&1
`;
  spawnDetached("sh", ["-lc", script], record.repoRoot);
}

function pidsWithCwdUnder(root: string): number[] {
  if (process.platform !== "linux") return [];
  const resolvedRoot = path.resolve(root);
  let entries: string[] = [];
  try { entries = readdirSync("/proc"); } catch { return []; }
  const pids: number[] = [];
  for (const entry of entries) {
    if (!/^\d+$/u.test(entry)) continue;
    const pid = Number(entry);
    if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) continue;
    try {
      const cwd = readlinkSync(path.join("/proc", entry, "cwd"));
      const resolvedCwd = path.resolve(cwd);
      if (resolvedCwd === resolvedRoot || resolvedCwd.startsWith(`${resolvedRoot}${path.sep}`)) pids.push(pid);
    } catch {
      // Process exited or cwd is not readable.
    }
  }
  return [...new Set(pids)].sort((a, b) => a - b);
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function stopWorktreeProcesses(worktreePath: string): Promise<string[]> {
  if (process.platform !== "linux") return ["SKIP worktree process cleanup (non-Linux)"];
  const initial = pidsWithCwdUnder(worktreePath);
  if (initial.length === 0) return ["OK no worktree cwd processes found"];

  const lines = [`worktree cwd processes: ${initial.join(", ")}`];
  for (const pid of initial) {
    try { process.kill(pid, "SIGTERM"); } catch {}
  }
  await sleep(1_500);
  const aliveAfterTerm = initial.filter(isPidAlive);
  for (const pid of aliveAfterTerm) {
    try { process.kill(pid, "SIGKILL"); } catch {}
  }
  await sleep(300);
  const stillAlive = initial.filter(isPidAlive);
  if (stillAlive.length > 0) lines.push(`FAIL worktree processes still alive: ${stillAlive.join(", ")}`);
  else lines.push(`OK stopped worktree processes (${initial.length})`);
  return lines;
}

async function worktreeRemovalDiagnostics(pi: ExtensionAPI, cwd: string, worktreePath: string): Promise<string[]> {
  if (process.platform !== "linux") return [];
  const diagnose = await execShell(
    pi,
    cwd,
    `
set +e
echo "worktree path permissions:"
ls -ld ${shellQuote(worktreePath)} 2>&1 || true
echo "non-current-user owned entries (first 40):"
find ${shellQuote(worktreePath)} ! -user "$(id -un)" -printf '%M %u:%g %p\n' 2>/dev/null | head -40 || true
echo "not writable entries (first 40):"
find ${shellQuote(worktreePath)} ! -writable -printf '%M %u:%g %p\n' 2>/dev/null | head -40 || true
if command -v lsattr >/dev/null 2>&1; then
  echo "immutable/attrs (first 40 non-default):"
  { lsattr -d ${shellQuote(worktreePath)} 2>/dev/null; lsattr ${shellQuote(worktreePath)} 2>/dev/null | grep -v '^--------------' | head -40; } || true
fi
`,
    60_000,
  );
  const out = trim(diagnose.stdout || diagnose.stderr);
  return out ? [`Removal diagnostics:\n${out}`] : [];
}

async function readRecord(file: string): Promise<WorkonRecord | undefined> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as Partial<WorkonRecord>;
    if (parsed.version !== 1 || typeof parsed.slug !== "string" || typeof parsed.worktreePath !== "string") return undefined;
    return parsed as WorkonRecord;
  } catch {
    return undefined;
  }
}

async function listRecords(): Promise<WorkonRecord[]> {
  try {
    const names = await readdir(WORKON_DIR);
    const records: WorkonRecord[] = [];
    for (const name of names) {
      if (!name.endsWith(".json") || name === "latest.json") continue;
      const record = await readRecord(path.join(WORKON_DIR, name));
      if (record) records.push(record);
    }
    return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } catch {
    return [];
  }
}

async function findRecordForCwd(pi: ExtensionAPI, cwd: string, preferred?: string): Promise<WorkonRecord | undefined> {
  if (preferred) {
    const slug = pathSlug(preferred.replace(/^\//, ""));
    const record = await readRecord(path.join(WORKON_DIR, `${slug}.json`));
    if (record) return record;
  }

  const root = await gitRoot(pi, cwd);
  const records = await listRecords();
  return records.find((record) => root && (path.resolve(record.worktreePath) === path.resolve(root) || path.resolve(record.repoRoot) === path.resolve(root)))
    ?? await readRecord(path.join(WORKON_DIR, "latest.json"));
}

async function findCleanupRecord(pi: ExtensionAPI, cwd: string, preferred?: string): Promise<CleanupRecordLookup> {
  if (preferred?.trim()) return { record: await findRecordForCwd(pi, cwd, preferred.trim()) };

  const root = await gitRoot(pi, cwd);
  const records = await listRecords();
  if (!root) return { record: await readRecord(path.join(WORKON_DIR, "latest.json")) };

  const resolvedRoot = path.resolve(root);
  const workerRecord = records.find((record) => path.resolve(record.worktreePath) === resolvedRoot);
  if (workerRecord) return { record: workerRecord };

  const sameRepo = records.filter((record) => path.resolve(record.repoRoot) === resolvedRoot);
  const existing = sameRepo.filter((record) => existsSync(record.worktreePath));
  if (existing.length > 1) return { ambiguous: existing };
  return { record: existing[0] ?? sameRepo[0] };
}

async function cleanupWorkonLoopLaunchers(slug: string, keepPath?: string): Promise<string[]> {
  const prefix = `${pathSlug(slug)}-loop-`;
  const keep = keepPath ? path.resolve(keepPath) : undefined;
  let entries: string[] = [];
  try {
    entries = await readdir(WORKON_DIR);
  } catch {
    return [];
  }

  const lines: string[] = [];
  for (const entry of entries) {
    if (!entry.startsWith(prefix) || !entry.endsWith("-launch.sh")) continue;
    const target = path.join(WORKON_DIR, entry);
    if (keep && path.resolve(target) === keep) continue;
    try {
      await rm(target, { force: true });
    } catch (error) {
      lines.push(`WARN could not remove stale loop launcher ${target}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return lines;
}

async function removeWorkonRecordArtifacts(record: WorkonRecord): Promise<string[]> {
  const targets = [
    record.handoffPath,
    record.markdownPath,
    record.envPath,
    path.join(WORKON_DIR, `${pathSlug(record.slug)}-launch.sh`),
  ];
  const latest = await readRecord(path.join(WORKON_DIR, "latest.json"));
  if (latest?.id === record.id) {
    targets.push(path.join(WORKON_DIR, "latest.json"), path.join(WORKON_DIR, "latest.md"), path.join(WORKON_DIR, "latest.env"));
  }

  const lines: string[] = [];
  for (const target of [...new Set(targets)]) {
    try {
      await rm(target, { force: true });
    } catch (error) {
      lines.push(`WARN could not remove ${target}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (lines.length === 0) lines.push("OK removed workon handoff/env artifacts");
  return lines;
}

interface CleanupRunOptions {
  commandRoot?: string;
  cleanupRunsFromWorker?: boolean;
  cleanupWindowAddress?: string;
}

interface CleanupRunResult {
  ok: boolean;
  lines: string[];
  scheduled?: boolean;
}

async function cleanupWorkonRecord(pi: ExtensionAPI, record: WorkonRecord, options: CleanupRunOptions = {}): Promise<CleanupRunResult> {
  const cleanupRunsFromWorker = options.cleanupRunsFromWorker ?? false;
  const cleanupWindowAddress = options.cleanupWindowAddress;
  const lines: string[] = [];
  const worktreeExists = existsSync(record.worktreePath);

  if (cleanupRunsFromWorker && !cleanupWindowAddress) {
    return {
      ok: false,
      lines: [`FAIL cleanup from feature worktree cannot safely close this terminal/window. Run /cleanup ${record.slug} from the main repo instead.`],
    };
  }

  if (worktreeExists) {
    const status = await git(pi, record.worktreePath, ["status", "--porcelain", "--untracked-files=normal"], 60_000);
    if (status.code !== 0) {
      return { ok: false, lines: [`FAIL could not inspect worktree status.\n${status.stderr || status.stdout}`] };
    }
    if (trim(status.stdout)) {
      return { ok: false, lines: [`FAIL worktree has uncommitted/untracked non-ignored files. Commit/stash/remove them first.\n${status.stdout}`] };
    }
  }

  const composeFile = ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"].some((file) => existsSync(path.join(record.worktreePath, file)));
  const cleanupCwd = worktreeExists ? record.worktreePath : record.repoRoot;
  const composeEnvFlag = existsSync(record.envPath) ? ` --env-file ${shellQuote(record.envPath)}` : "";
  if (composeFile) {
    const down = await execShell(pi, record.worktreePath, `docker compose -p ${shellQuote(record.composeProject)}${composeEnvFlag} down -v --remove-orphans --rmi local`, 180_000);
    lines.push(`${down.code === 0 ? "OK" : "FAIL"} docker compose down (volumes + local images)`);
    if (down.code !== 0) lines.push((down.stderr || down.stdout).trim());
  } else {
    lines.push("SKIP docker compose down (compose file missing)");
  }

  if (hasCommand("docker")) {
    const labelFilter = shellQuote(`label=com.docker.compose.project=${record.composeProject}`);
    const containerCleanup = await execShell(pi, cleanupCwd, `container_ids=$(docker ps -aq --filter ${labelFilter} | sort -u)\nif [ -z "$container_ids" ]; then\n  echo "No compose-project containers found."\n  exit 0\nfi\ndocker rm -f $container_ids`, 180_000);
    lines.push(`${containerCleanup.code === 0 ? "OK" : "FAIL"} docker container cleanup by compose project label`);
    const containerOutput = (containerCleanup.stderr || containerCleanup.stdout).trim();
    if (containerOutput) lines.push(containerOutput);

    const volumeCleanup = await execShell(pi, cleanupCwd, `volume_ids=$(docker volume ls -q --filter ${labelFilter} | sort -u)\nif [ -z "$volume_ids" ]; then\n  echo "No compose-project volumes found."\n  exit 0\nfi\ndocker volume rm $volume_ids`, 180_000);
    lines.push(`${volumeCleanup.code === 0 ? "OK" : "FAIL"} docker volume cleanup by compose project label`);
    const volumeOutput = (volumeCleanup.stderr || volumeCleanup.stdout).trim();
    if (volumeOutput) lines.push(volumeOutput);

    const networkCleanup = await execShell(pi, cleanupCwd, `network_ids=$(docker network ls -q --filter ${labelFilter} | sort -u)\nif [ -z "$network_ids" ]; then\n  echo "No compose-project networks found."\n  exit 0\nfi\ndocker network rm $network_ids`, 180_000);
    lines.push(`${networkCleanup.code === 0 ? "OK" : "FAIL"} docker network cleanup by compose project label`);
    const networkOutput = (networkCleanup.stderr || networkCleanup.stdout).trim();
    if (networkOutput) lines.push(networkOutput);

    const imageCleanup = await execShell(pi, cleanupCwd, `image_ids=$(docker image ls -q --filter ${labelFilter} | sort -u)\nif [ -z "$image_ids" ]; then\n  echo "No compose-project images found."\n  exit 0\nfi\ndocker image rm $image_ids`, 180_000);
    lines.push(`${imageCleanup.code === 0 ? "OK" : "FAIL"} docker image cleanup by compose project label`);
    const imageOutput = (imageCleanup.stderr || imageCleanup.stdout).trim();
    if (imageOutput) lines.push(imageOutput);
  } else {
    lines.push("SKIP Docker label cleanup (docker unavailable)");
  }

  if (lines.some((line) => line.startsWith("FAIL"))) {
    lines.push("Not removing worktree because Docker cleanup failed.");
    return { ok: false, lines };
  }

  if (!cleanupRunsFromWorker && worktreeExists) {
    lines.push(...await stopWorktreeProcesses(record.worktreePath));
    if (lines.some((line) => line.startsWith("FAIL worktree processes"))) {
      lines.push("Not removing worktree because devserver/process cleanup failed.");
      return { ok: false, lines };
    }
  }

  if (cleanupRunsFromWorker && cleanupWindowAddress) {
    const logPath = path.join(WORKON_DIR, `${pathSlug(record.slug)}-cleanup.log`);
    scheduleWorkerTerminalCleanup(record, cleanupWindowAddress, logPath);
    lines.push("Scheduled captured terminal close + worktree/process/artifact removal.");
    lines.push(`cleanup log: ${logPath}`);
    lines.push("This worker terminal should close automatically in a few seconds.");
    return { ok: true, lines, scheduled: true };
  }

  if (worktreeExists) {
    let remove = await git(pi, record.repoRoot, ["worktree", "remove", record.worktreePath], 120_000);
    if (remove.code !== 0) {
      lines.push(`WARN git worktree remove failed, forcing because worktree was clean before removal: ${(remove.stderr || remove.stdout).trim()}`);
      remove = await git(pi, record.repoRoot, ["worktree", "remove", "--force", record.worktreePath], 120_000);
      if (remove.code !== 0) {
        lines.push(...await worktreeRemovalDiagnostics(pi, record.repoRoot, record.worktreePath));
        lines.push(
          `If diagnostics show root/non-${process.env.USER || "current-user"} ownership or immutable files, run: `
          + `sudo chown -R "$USER:$USER" ${record.worktreePath} && chmod -R u+rwX ${record.worktreePath}`,
        );
      }
    }
    lines.push(`${remove.code === 0 ? "OK" : "FAIL"} git worktree remove`);
    if (remove.code !== 0) lines.push((remove.stderr || remove.stdout).trim());
  } else {
    lines.push("SKIP git worktree remove (worktree path already missing)");
  }

  if (!lines.some((line) => line.startsWith("FAIL"))) {
    lines.push(...await removeWorkonRecordArtifacts(record));
  }

  return { ok: !lines.some((line) => line.startsWith("FAIL")), lines };
}

async function isRecordShipped(pi: ExtensionAPI, record: WorkonRecord): Promise<{ shipped: boolean; reason: string }> {
  if (!hasCommand("gh")) return { shipped: false, reason: "gh unavailable" };
  const pr = await execShell(
    pi,
    record.repoRoot,
    `gh pr view ${shellQuote(record.branch)} --json state,mergedAt,url,headRefOid --jq '.state + "\\n" + (.mergedAt // "") + "\\n" + (.headRefOid // "") + "\\n" + (.url // "")'`,
    60_000,
  );
  if (pr.code !== 0) return { shipped: false, reason: trim(pr.stderr || pr.stdout) || "no PR found" };
  const [state, mergedAt, headRefOid, url] = pr.stdout.trim().split(/\r?\n/u);
  if (state !== "MERGED" || !mergedAt) return { shipped: false, reason: `PR state=${state || "unknown"}` };

  if (existsSync(record.worktreePath) && headRefOid) {
    const head = await git(pi, record.worktreePath, ["rev-parse", "HEAD"], 60_000);
    if (head.code !== 0) return { shipped: false, reason: `could not read local HEAD: ${trim(head.stderr || head.stdout)}` };
    const localHead = trim(head.stdout);
    if (localHead && localHead !== headRefOid) {
      return { shipped: false, reason: `local HEAD ${localHead.slice(0, 12)} differs from shipped PR head ${headRefOid.slice(0, 12)}` };
    }
  }

  return { shipped: true, reason: `${url || "merged PR"} mergedAt=${mergedAt}` };
}

function safeNotify(ctx: WorkonUiContext, message: string, type: "info" | "warning" | "error" = "info"): void {
  try {
    if (ctx.hasUI && typeof ctx.ui?.notify === "function") ctx.ui.notify(message, type);
  } catch {
    // ignore stale/no-ui notification failures
  }
}

function setStatus(ctx: WorkonUiContext, value: string | undefined): void {
  try {
    if (ctx.hasUI && typeof ctx.ui?.setStatus === "function") ctx.ui.setStatus(STATUS_KEY, value);
  } catch {
    // ignore stale/no-ui status failures
  }
}

async function confirm(ctx: WorkonUiContext, title: string, message: string): Promise<boolean> {
  if (!ctx.hasUI || typeof ctx.ui?.confirm !== "function") return false;
  return ctx.ui.confirm(title, message);
}

function detectValidationCommands(root: string): string[] {
  const pkgPath = path.join(root, "package.json");
  if (!existsSync(pkgPath)) return [];
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { scripts?: Record<string, string> };
    const scripts = pkg.scripts ?? {};
    const commands: string[] = [];
    const add = (command: string) => {
      if (!commands.includes(command)) commands.push(command);
    };

    if (scripts.typecheck) add("npm run typecheck");

    const testScript = scripts.test ?? "";
    const testAlreadyRunsE2e = /\b(playwright|cypress|e2e|wdio|puppeteer)\b/i.test(testScript);
    if (scripts.test) add("npm test");

    if (!testAlreadyRunsE2e) {
      const e2eScript = [
        "test:e2e",
        "e2e",
        "e2e:test",
        "test:playwright",
        "playwright:test",
        "test:cypress",
        "cypress:run",
      ].find((name) => scripts[name]);
      if (e2eScript) add(`npm run ${e2eScript}`);
      else if (
        ["playwright.config.ts", "playwright.config.js", "playwright.config.mjs"].some((file) => existsSync(path.join(root, file)))
        && existsSync(path.join(root, "tests", "e2e"))
      ) add("npx playwright test");
    }

    if (scripts.build) add("npm run build");
    return commands;
  } catch {
    return [];
  }
}

async function execShell(pi: ExtensionAPI, cwd: string, command: string, timeout = 300_000): Promise<GitResult> {
  return (await pi.exec("sh", ["-lc", `cd ${shellQuote(cwd)} && ${command}`], { timeout })) as GitResult;
}

function e2eValidationEnvPrefix(command: string, record?: WorkonRecord): string {
  if (!record || !/\b(e2e|playwright|cypress|wdio|puppeteer)\b/i.test(command)) return "";
  const e2eWebPort = record.devPorts.api;
  const e2eDbPort = record.devPorts.extra;
  const values: Record<string, string> = {
    E2E_TARGET: "local",
    E2E_COMPOSE_PROJECT_NAME: `${record.composeProject}-e2e`,
    DATABASE_URL: `postgresql://workon:workon@127.0.0.1:${e2eDbPort}/workon_e2e?schema=public`,
    PORT: String(e2eWebPort),
    NEXTAUTH_URL: `http://127.0.0.1:${e2eWebPort}`,
    APP_PUBLIC_URL: `http://127.0.0.1:${e2eWebPort}`,
    PLAYWRIGHT_BASE_URL: `http://127.0.0.1:${e2eWebPort}`,
  };
  return `${Object.entries(values).map(([key, value]) => `${key}=${shellQuote(value)}`).join(" ")} `;
}

function withEnvFile(command: string, envPath?: string, record?: WorkonRecord): string {
  const envPrefix = e2eValidationEnvPrefix(command, record);
  if (!envPath || !existsSync(envPath)) return `${envPrefix}${command}`;
  return `set -a; . ${shellQuote(envPath)}; set +a; ${envPrefix}${command}`;
}

async function runValidation(
  pi: ExtensionAPI,
  cwd: string,
  commands: string[],
  onProgress?: (message: string) => void,
  envPath?: string,
  record?: WorkonRecord,
): Promise<{ ok: boolean; summary: string }> {
  if (commands.length === 0) return { ok: true, summary: "No validation commands detected." };
  const lines: string[] = [];
  for (const command of commands) {
    onProgress?.(`Validation running: ${command}\nThis can take a few minutes.${envPath && existsSync(envPath) ? `\nEnv: ${envPath}` : ""}`);
    const result = await execShell(pi, cwd, withEnvFile(command, envPath, record), 600_000);
    lines.push(`${result.code === 0 ? "OK" : "FAIL"} ${command}`);
    if (result.code !== 0) {
      const output = `${result.stdout}\n${result.stderr}`.trim().split(/\r?\n/).slice(-20).join("\n");
      return { ok: false, summary: `${lines.join("\n")}\n\n${output}`.trim() };
    }
    onProgress?.(`Validation OK: ${command}`);
  }
  return { ok: true, summary: lines.join("\n") };
}

function detectDevServerCommand(root: string): string | undefined {
  const pkgPath = path.join(root, "package.json");
  if (!existsSync(pkgPath)) return undefined;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { scripts?: Record<string, string> };
    const scripts = pkg.scripts ?? {};
    if (scripts.dev) return "npm run dev";
    if (scripts.start) return "npm start";
  } catch {
    return undefined;
  }
  return undefined;
}

function summarizeFinalGate(finalGate: WorkonLoopFinalGate): string {
  const lines = ["/workonloop final gate accepted."];
  for (const command of finalGate.commands ?? []) {
    lines.push(`${command.exitCode === 0 ? "OK" : "FAIL"} ${command.command}${command.summary ? ` — ${singleLine(command.summary)}` : ""}`);
  }
  for (const command of finalGate.docker ?? []) {
    lines.push(`${command.exitCode === 0 ? "OK" : "FAIL"} ${command.command}${command.summary ? ` — ${singleLine(command.summary)}` : ""}`);
  }
  if (finalGate.notes) lines.push(`notes: ${singleLine(finalGate.notes)}`);
  return lines.join("\n");
}

async function startWorkonLoopTestServer(record: WorkonRecord): Promise<{ ok: boolean; summary: string }> {
  const logPath = path.join(WORKON_DIR, `${pathSlug(record.slug)}-testserver.log`);
  const envPrefix = existsSync(record.envPath) ? `set -a; . ${shellQuote(record.envPath)}; set +a; ` : "";
  const url = `http://127.0.0.1:${record.devPorts.web}`;
  let command: string | undefined;

  if (record.docker === true && hasComposeFile(record.worktreePath) && hasCommand("docker")) {
    const composeEnvFlag = existsSync(record.envPath) ? ` --env-file ${shellQuote(record.envPath)}` : "";
    command = `${envPrefix}docker compose -p ${shellQuote(record.composeProject)}${composeEnvFlag} up -d --build`;
  } else {
    const devCommand = detectDevServerCommand(record.worktreePath);
    if (devCommand) command = `${envPrefix}${devCommand}`;
  }

  if (!command) return { ok: false, summary: `SKIP testserver: no compose file/docker or package dev/start script. Expected URL: ${url}` };

  const script = `
{
  echo "$(date -Is) starting workonloop testserver for ${record.slug}"
  cd ${shellQuote(record.worktreePath)} || exit 1
  ${command}
} >> ${shellQuote(logPath)} 2>&1
`;
  spawnDetached("sh", ["-lc", script], record.worktreePath);
  return { ok: true, summary: `Testserver starting: ${url}\nLog: ${logPath}\nCommand: ${command}` };
}

async function autoCreateWorkonLoopPr(
  pi: ExtensionAPI,
  record: WorkonRecord,
  validationSummary: string,
): Promise<{ ok: boolean; summary: string }> {
  const root = record.worktreePath;
  const branch = await currentBranch(pi, root);
  if (MAIN_BRANCHES.has(branch)) return { ok: false, summary: `SKIP PR: refusing branch ${branch}` };

  if (await hasDirtyFiles(pi, root)) {
    await git(pi, root, ["add", "-A"], 60_000);
    const commitMessage = await buildStructuredPrMessage({
      pi,
      root,
      branch,
      record,
      validationSummary,
    });
    const commit = await git(pi, root, ["commit", "-m", commitMessage.subject, "-m", commitMessage.body], 120_000);
    if (commit.code !== 0) return { ok: false, summary: `FAIL PR commit:\n${commit.stderr || commit.stdout}` };
  }

  const prMessage = await buildStructuredPrMessage({
    pi,
    root,
    branch,
    record,
    validationSummary,
  });

  const remote = await gitCurrentRemote(pi, root);
  if (!remote) return { ok: false, summary: "SKIP PR: no origin remote" };

  const push = await git(pi, root, ["push", "-u", "origin", branch], 300_000);
  if (push.code !== 0) return { ok: false, summary: `FAIL PR push:\n${push.stderr || push.stdout}` };

  const existing = await execShell(pi, root, "gh pr view --json url --jq .url", 60_000);
  if (existing.code === 0 && trim(existing.stdout)) {
    const existingBody = await existingPrField(pi, root, "body");
    const bodyPath = existingBody && isStructuredPrBody(existingBody)
      ? undefined
      : writeGhBodyFile(root, branch, mergeExistingPrBody(existingBody, prMessage.body));
    const bodyArg = bodyPath ? ` --body-file ${shellQuote(bodyPath)}` : "";
    const edit = await execShell(pi, root, `gh pr edit --title ${shellQuote(prMessage.subject)}${bodyArg}`, 120_000);
    if (edit.code !== 0) return { ok: false, summary: `FAIL PR update:\n${edit.stderr || edit.stdout}` };
    return { ok: true, summary: `PR updated: ${trim(existing.stdout)}\nTitle: ${prMessage.subject}` };
  }

  const base = defaultPrBase(record);
  const create = await execShell(pi, root, `gh pr create --title ${shellQuote(prMessage.subject)} --body-file ${shellQuote(prMessage.bodyPath)} --base ${shellQuote(base)} --head ${shellQuote(branch)}`, 120_000);
  if (create.code !== 0) return { ok: false, summary: `FAIL PR create:\n${create.stderr || create.stdout}` };
  return { ok: true, summary: `PR created: ${trim(create.stdout)}\nTitle: ${prMessage.subject}` };
}

async function gitCurrentRemote(pi: ExtensionAPI, root: string): Promise<string | undefined> {
  const result = await git(pi, root, ["remote", "get-url", "origin"], 10_000);
  return result.code === 0 ? trim(result.stdout) : undefined;
}

function defaultPrBase(record: WorkonRecord | undefined): string {
  if (!record) return "main";
  if (record.base.startsWith("origin/")) return record.base.slice("origin/".length);
  if (record.base === "master") return "master";
  return "main";
}

function defaultMergeBaseRef(record: WorkonRecord | undefined): string {
  return `origin/${defaultPrBase(record)}`;
}

function singleLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
}

function truncateText(value: string, maxLength: number): string {
  const clean = singleLine(value);
  if (clean.length <= maxLength) return clean;
  return `${clean.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function prSubject(record: WorkonRecord | undefined, branch: string): string {
  const type = branch.startsWith("fix/")
    ? "fix"
    : branch.startsWith("docs/")
      ? "docs"
      : branch.startsWith("chore/")
        ? "chore"
        : branch.startsWith("test/")
          ? "test"
          : branch.startsWith("refactor/")
            ? "refactor"
            : "feat";
  const source = record?.task || record?.slug || branch.replace(/^[^/]+\//, "");
  return truncateText(`${type}: ${source}`, 72) || `workon: ${branch}`;
}

function bulletList(items: string[], empty: string, limit = 20): string {
  const clean = [...new Set(items.map(singleLine).filter(Boolean))].slice(0, limit);
  if (clean.length === 0) return `- ${empty}`;
  return clean.map((item) => `- ${item}`).join("\n");
}

function indentBlock(value: string): string {
  const clean = value.trim();
  return clean ? clean.split(/\r?\n/).map((line) => `  ${line}`).join("\n") : "  - Keine Validierung ausgefuehrt.";
}

async function gitOutputLines(pi: ExtensionAPI, root: string, args: string[], timeout = 30_000): Promise<string[]> {
  const result = await git(pi, root, args, timeout);
  if (result.code !== 0) return [];
  return trim(result.stdout).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

async function changedFilesForMessage(pi: ExtensionAPI, root: string, baseRef: string): Promise<string[]> {
  const [committed, working, cached] = await Promise.all([
    gitOutputLines(pi, root, ["diff", "--name-only", `${baseRef}...HEAD`]),
    gitOutputLines(pi, root, ["diff", "--name-only"]),
    gitOutputLines(pi, root, ["diff", "--cached", "--name-only"]),
  ]);
  return [...new Set([...committed, ...working, ...cached])];
}

async function commitSubjectsForMessage(pi: ExtensionAPI, root: string, baseRef: string): Promise<string[]> {
  return gitOutputLines(pi, root, ["log", "--format=%s", `${baseRef}..HEAD`]);
}

function ghBodyPath(root: string, branch: string): string {
  mkdirSync(WORKON_DIR, { recursive: true });
  const repoName = path.basename(root) || "repo";
  const safeBranch = pathSlug(branch) || "workon";
  return path.join(WORKON_DIR, `${pathSlug(repoName)}-${safeBranch}-pr-body.md`);
}

function writeGhBodyFile(root: string, branch: string, body: string): string {
  const bodyPath = ghBodyPath(root, branch);
  writeFileSync(bodyPath, `${body.trim()}\n`, "utf8");
  return bodyPath;
}

function currentStructuredPrHeadings(): string[] {
  return [
    "## 1) Auftrag",
    "## 2) Wichtige Entscheidungen",
    "## 3) Umsetzung",
    "## 4) Validierung",
    "## 5) Wichtige Hinweise",
    "## 6) Sonstiges",
  ];
}

function legacyStructuredPrHeadings(): string[] {
  return [
    "## 1. Auftrag",
    "## 2. Wichtige Entscheidungen",
    "## 3. Umsetzung",
    "## 4. Wichtige Hinweise",
    "## 5. Sonstiges",
  ];
}

function hasAllHeadings(body: string, headings: string[]): boolean {
  return headings.every((heading) => body.includes(heading));
}

function isStructuredPrBody(body: string): boolean {
  return hasAllHeadings(body, currentStructuredPrHeadings());
}

function isLegacyStructuredPrBody(body: string): boolean {
  return hasAllHeadings(body, legacyStructuredPrHeadings());
}

function mergeExistingPrBody(existingBody: string | undefined, generatedBody: string): string {
  if (!existingBody || isStructuredPrBody(existingBody) || isLegacyStructuredPrBody(existingBody)) return generatedBody;
  return `## Bestehender PR-Text (vor Workon-Struktur)\n\n${existingBody.trim()}\n\n---\n\n${generatedBody.trim()}\n`;
}

async function existingPrField(pi: ExtensionAPI, root: string, field: "body" | "title"): Promise<string | undefined> {
  const result = await execShell(pi, root, `gh pr view --json ${field} --jq .${field}`, 60_000);
  if (result.code !== 0) return undefined;
  const value = trim(result.stdout);
  return value || undefined;
}

function recordMatchesRoot(record: WorkonRecord | undefined, root: string): boolean {
  if (!record) return false;
  return path.resolve(record.worktreePath) === path.resolve(root);
}

async function findRecordForCurrentRoot(pi: ExtensionAPI, root: string): Promise<WorkonRecord | undefined> {
  const record = await findRecordForCwd(pi, root);
  return recordMatchesRoot(record, root) ? record : undefined;
}

async function buildStructuredPrMessage(options: {
  pi: ExtensionAPI;
  root: string;
  branch: string;
  record?: WorkonRecord;
  validationSummary?: string;
  validationSkipped?: boolean;
}): Promise<{ subject: string; body: string; bodyPath: string }> {
  const baseRef = defaultMergeBaseRef(options.record);
  const [changedFiles, commitSubjects] = await Promise.all([
    changedFilesForMessage(options.pi, options.root, baseRef),
    commitSubjectsForMessage(options.pi, options.root, baseRef),
  ]);
  const subject = prSubject(options.record, options.branch);
  const task = options.record?.task || `Arbeit auf Branch \`${options.branch}\`.`;
  const references = options.record?.references && options.record.references.length > 0
    ? bulletList(options.record.references, "Keine Referenzen erfasst.", 10)
    : "- Keine Referenzen erfasst.";
  const validation = options.validationSkipped
    ? "- Validierung via `--no-test` uebersprungen. Vor Merge nachholen, wenn Risiko besteht."
    : options.validationSummary
      ? `- Validierung:\n${indentBlock(options.validationSummary)}`
      : "- Validierung noch nicht dokumentiert.";

  const body = `## 1) Auftrag
- ${task}

## 2) Wichtige Entscheidungen
- Keine dauerhaft relevanten Entscheidungen automatisch erfasst. Falls fachliche/architektonische Entscheidungen wichtig sind, hier vor dem Merge ergaenzen.

## 3) Umsetzung
### Commits
${bulletList(commitSubjects, "Keine Commits seit Base gefunden.", 20)}

### Geaenderte Dateien
${bulletList(changedFiles, "Keine geaenderten Dateien gefunden.", 30)}

## 4) Validierung
${validation}

## 5) Wichtige Hinweise
- Base: \`${baseRef}\`
- Branch: \`${options.branch}\`
${options.record?.envPath ? `- Workon-Env: \`${options.record.envPath}\`` : "- Workon-Env: nicht erfasst"}

## 6) Sonstiges
- Workon-Slug: \`${options.record?.slug ?? "nicht erfasst"}\`
- Referenzen:\n${references}
- Hinweis: Abschnitt \"Wichtige Entscheidungen\" bleibt bewusst konservativ, damit Automation nichts erfindet.
`;

  const bodyPath = writeGhBodyFile(options.root, options.branch, body);
  return { subject, body, bodyPath };
}

async function isMergeInProgress(pi: ExtensionAPI, root: string): Promise<boolean> {
  const result = await git(pi, root, ["rev-parse", "-q", "--verify", "MERGE_HEAD"], 10_000);
  return result.code === 0 && trim(result.stdout).length > 0;
}

async function unmergedFiles(pi: ExtensionAPI, root: string): Promise<string[]> {
  const result = await git(pi, root, ["diff", "--name-only", "--diff-filter=U"], 10_000);
  if (result.code !== 0) return [];
  return trim(result.stdout).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function buildShipMergePrompt(options: {
  branch: string;
  baseRef: string;
  conflictFiles: string[];
  record?: WorkonRecord;
  mergeOutput?: string;
  cleanMerge: boolean;
}): string {
  const files = options.conflictFiles.length > 0
    ? options.conflictFiles.map((file) => `- ${file}`).join("\n")
    : "- keine unmerged Dateien gemeldet";
  const output = trim(options.mergeOutput ?? "").split(/\r?\n/).slice(-40).join("\n");
  const envLine = options.record?.envPath && existsSync(options.record.envPath)
    ? `- workon env file: \`${options.record.envPath}\``
    : "- workon env file: none detected";
  const intro = options.cleanMerge
    ? `\`${options.baseRef}\` wurde sauber in \`${options.branch}\` gemerged. Bitte Ergebnis pruefen, validieren, pushen.`
    : `\`${options.baseRef}\` wurde in \`${options.branch}\` gemerged und hat Konflikte. Bitte Konflikte intelligent loesen.`;

  return `${intro}

Ziel: Feature-Code aus diesem Branch UND neue Main-Aenderungen erhalten. Nicht blind ganze Dateien mit \`--ours\` oder \`--theirs\` ersetzen.

Kontext:
- repo root: \`${options.record?.worktreePath ?? "aktuelles Git-Repo"}\`
- branch: \`${options.branch}\`
- merge base: \`${options.baseRef}\`
${envLine}

Konfliktdateien:
${files}

Merge-Ausgabe:
\`\`\`
${output || "(keine Ausgabe)"}
\`\`\`

Arbeitsregeln:
1. Erst \`git status --short --branch\`, \`git diff --name-only --diff-filter=U\` und bei Konflikten \`git diff --cc\` ansehen.
2. Pro Konflikt Datei-Versionen vergleichen: \`git show :1:<path>\`, \`git show :2:<path>\` (Feature), \`git show :3:<path>\` (Main). Bei vielen Dateien gezielt lesen.
3. Semantisch mergen: beide Features erhalten, Imports/Types/Routen/Tests konsistent machen.
4. Keine echten Secrets/private Rohdaten committen. Main nicht direkt editieren.
5. Bei \`client/dist/\` oder Hash-Dateien: zuerst Source-Konflikte loesen, dann \`npm run build\`; generierte Dist-Dateien aus Build uebernehmen.
6. Danach volle Validierung: \`npm run typecheck\`, \`npm test\`, \`npm run build\` wenn vorhanden; bei Env Bedarf vorher workon env sourcen.
7. Merge abschliessen: \`git add -A\`, \`git commit\` falls Merge noch offen ist oder Fix-Commit noetig ist, dann \`git push\`.
8. Wenn fachlicher Konflikt unklar ist: stoppen und Rueckfrage stellen, nicht raten.
9. Am Ende kurz melden: geloeste Konflikte, Tests, Push-Status, danach kann User \`/ship\` erneut ausfuehren.`;
}

async function startWorkon(pi: ExtensionAPI, args: string, ctx: ExtensionCommandContext, options: { mode?: WorkonMode; planningMode?: boolean; requireTask?: boolean } = {}): Promise<void> {
  const mode: WorkonMode = options.mode ?? (options.planningMode ? "workonplan" : "workon");
  const planningMode = mode === "workonplan" || mode === "workonhardplan";
  const hardPlanningMode = mode === "workonhardplan";
  const loopMode = mode === "workonloop";
  const commandName = mode;
  const parsed = parseArgs(args);
  const { slug, task } = parsed;
  const docker = !parsed.noDocker;
  if (!slug || (options.requireTask && !task)) {
    safeNotify(ctx, `Usage: /${commandName} slug ${loopMode ? "zielbild..." : "task/files..."} [--nodocker]`, "warning");
    return;
  }

  const sourceRoot = await gitRoot(pi, ctx.cwd);
  if (!sourceRoot) {
    safeNotify(ctx, `No git repo at ${ctx.cwd}`, "error");
    return;
  }

  const repoName = path.basename(sourceRoot);
  const branch = branchForSlug(slug, task);
  const target = path.join(WORKTREE_ROOT, repoName, pathSlug(branch));
  const current = await currentBranch(pi, sourceRoot);
  const base = await defaultBase(pi, sourceRoot, current);
  const dirty = await hasDirtyFiles(pi, sourceRoot);
  const references = collectReferences(task, ctx.cwd);
  const id = `${pathSlug(slug)}-${Date.now().toString(36)}`;
  const recordSlug = pathSlug(slug);
  const handoffPath = path.join(WORKON_DIR, `${recordSlug}.json`);
  const markdownPath = path.join(WORKON_DIR, `${recordSlug}.md`);
  const envPath = path.join(WORKON_DIR, `${recordSlug}.env`);
  const composeProject = pathSlug(`${repoName}-${slug}`).slice(0, 63);
  const devPorts = await allocateDevPorts(repoName, slug);
  const hardPlan = hardPlanningMode ? buildHardPlanPaths(target, recordSlug) : undefined;
  const loop = loopMode ? { statePath: workonLoopStatePath(id), goal: task, maxSlices: DEFAULT_WORKON_LOOP_MAX_SLICES } : undefined;

  setStatus(ctx, `${commandName} ${slug}`);
  try {
    const result = await ensureWorktree(pi, sourceRoot, target, branch, base);
    if (hardPlan) await writeHardPlanPlannotatorConfig(pi, hardPlan);
    const dependencyBootstrap = await bootstrapDependencies(pi, target, (message) => setStatus(ctx, `${commandName} ${slug}: ${message}`));
    const record: WorkonRecord = {
      version: 1,
      id,
      slug,
      task,
      docker,
      createdAt: new Date().toISOString(),
      repoRoot: sourceRoot,
      repoName,
      worktreePath: target,
      branch,
      base,
      references,
      handoffPath,
      markdownPath,
      envPath,
      composeProject,
      devPorts,
      dependencyBootstrap,
      mode,
      ...(hardPlan ? { hardPlan } : {}),
      ...(loop ? { loop } : {}),
    };
    if (hardPlan) await mkdir(hardPlan.planDir, { recursive: true });
    const loopState = loop ? createWorkonLoopState(record) : undefined;
    if (loop && loopState) await writeWorkonLoopState(loop.statePath, loopState);
    const markdown = buildMarkdown(record, detectProjectHints(target), dirty, mode, dependencyBootstrap);
    await writeRecord(record, markdown);

    const dockerPrompt = docker
      ? loopMode
        ? "Docker/Compose is enabled by default for `/workonloop` final gate. Use assigned dev ports/env file only; report Docker/Compose commands in finalGate when applicable."
        : "Docker/Compose is enabled by default; use the assigned dev ports/env file only when runtime validation needs a server, and report the testserver URL if one was started."
      : "Docker/Compose is disabled because `--nodocker` was passed. Do not start Docker/Compose and do not report a Docker-backed testserver URL.";
    const prompt = loopMode && loopState
      ? buildWorkonLoopPrompt(record, loopState, "Bestimme den ersten sinnvoll zusammenhaengenden Slice aus dem Zielbild, passend fuer ein 270k-Token-Kontextfenster, und implementiere diesen Slice. Vermeide kuenstliche Mini-Slices. Danach rufe `workonloop_finish_slice` auf.")
      : hardPlanningMode && hardPlan
        ? `Read workon handoff ${markdownPath}. Treat its Workon Operating Contract, Plannotator Plan Mode, and Workon Hard Plan Mode sections as task-specific instructions. You are in hard Plannotator planning mode with local config ${hardPlan.plannotatorConfigPath}: planning only, no implementation in this session. Keep bulky context in artifact files under ${hardPlan.planDir}. Use the subagent tool for read-only planning help: run scout first and save findings to ${hardPlan.scoutPath}; run planner before submission and save findings to ${hardPlan.plannerPath}. Do not launch worker/writer subagents in plan mode. Write the reviewed German plan to ${hardPlan.planPath}; submit it with plannotator_submit_plan and revise until approved. After approval, stop and tell the user to start fresh implementation in this worktree with /workon-read ${recordSlug}. If subagents are unavailable, stop and ask. ${dockerPrompt} Stay in ${target}.`
        : planningMode
          ? `Read workon handoff ${markdownPath}. Treat its Workon Operating Contract and Plannotator Plan Mode sections as task-specific instructions. You are in Plannotator planning mode: ask if unclear, write a reviewed German plan to plans/workon-${recordSlug}.md, submit it with plannotator_submit_plan, revise until approved, and implement only after approval. ${dockerPrompt} Stay in ${target}.`
          : `Read workon handoff ${markdownPath}. Treat its Workon Operating Contract as task-specific system instructions. Then start implementing. ${dockerPrompt} Stay in ${target}.`;
    const terminal = openTerminalInWorkspace(target, prompt, { planMode: planningMode, slug });
    const terminalLine = terminal.ok ? `Terminal started: ${terminal.commandLine}` : `Terminal failed: ${terminal.error}`;
    safeNotify(
      ctx,
      [
        result.message,
        `mode: ${loopMode ? "workon loop" : hardPlanningMode ? "hard plannotator plan" : planningMode ? "plannotator plan" : "workon"}`,
        `branch: ${branch}`,
        `handoff: ${markdownPath}`,
        `env: ${envPath}`,
        hardPlan ? `plannotator config: ${hardPlan.plannotatorConfigPath}` : "",
        loop ? `loop state: ${loop.statePath}` : "",
        `dev ports: web ${devPorts.web}, api ${devPorts.api}, db ${devPorts.db}`,
        dependencyBootstrap.status !== "not-needed" ? `deps: ${dependencyBootstrap.summary}` : "",
        terminalLine,
        dirty ? "Source repo has dirty files; worktree does not include them automatically." : "",
      ].filter(Boolean).join("\n"),
      terminal.ok ? "info" : "warning",
    );
  } catch (error) {
    safeNotify(ctx, `/${commandName} failed: ${error instanceof Error ? error.message : String(error)}`, "error");
  } finally {
    setStatus(ctx, undefined);
  }
}

const WorkonLoopFinishSliceParameters = {
  type: "object",
  additionalProperties: false,
  properties: {
    sliceId: { type: "string", description: "Exact active sliceId from the current workonloop prompt." },
    outcome: { type: "string", enum: ["next", "done"], description: "next starts another slice terminal; done keeps this terminal open, starts testserver, and creates/updates PR after final gate." },
    implementedSummary: { type: "string", description: "What this slice implemented, key files, and checks run." },
    nextPrompt: { type: "string", description: "Suggested next slice prompt. Required for outcome=next." },
    finalGate: {
      type: "object",
      additionalProperties: false,
      description: "Required for outcome=done. Full validation plus Docker/Compose evidence when applicable and not disabled by --nodocker.",
      properties: {
        passed: { type: "boolean" },
        commands: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              command: { type: "string" },
              exitCode: { type: "number" },
              summary: { type: "string" },
            },
            required: ["command", "exitCode"],
          },
        },
        docker: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              command: { type: "string" },
              exitCode: { type: "number" },
              summary: { type: "string" },
            },
            required: ["command", "exitCode"],
          },
        },
        notes: { type: "string" },
      },
      required: ["passed", "commands"],
    },
  },
  required: ["sliceId", "outcome", "implementedSummary"],
} as const;

async function handleWorkonLoopFinishSlice(pi: ExtensionAPI, params: WorkonLoopFinishSliceParams, ctx: ExtensionContext): Promise<string> {
  const root = await gitRoot(pi, ctx.cwd);
  if (!root) throw new Error(`workonloop_finish_slice must run inside a git worktree, cwd=${ctx.cwd}`);
  const record = await findRecordForCurrentRoot(pi, root);
  if (!record || record.mode !== "workonloop" || !record.loop) {
    throw new Error("No matching /workonloop record for this worktree.");
  }
  if (path.resolve(record.worktreePath) !== path.resolve(root)) {
    throw new Error(`workonloop_finish_slice must run in loop worktree ${record.worktreePath}, got ${root}`);
  }
  if (params.outcome !== "next" && params.outcome !== "done") throw new Error("outcome must be next or done");
  if (!trim(params.implementedSummary)) throw new Error("implementedSummary is required");

  return withWorkonLoopStateLock(record.loop.statePath, async () => {
    const state = await readWorkonLoopState(record.loop!.statePath);
    if (!state) throw new Error(`Could not read workonloop state: ${record.loop!.statePath}`);
    if (state.recordId !== record.id) throw new Error(`Loop state record mismatch: ${state.recordId} !== ${record.id}`);
    if (state.status !== "running") throw new Error(`Loop is not running (status=${state.status}).`);
    if (state.activeSliceId !== params.sliceId) {
      throw new Error(`Stale or wrong sliceId. Expected ${state.activeSliceId}, got ${params.sliceId}.`);
    }

    const historyItem: WorkonLoopSliceHistory = {
      sliceIndex: state.sliceIndex,
      sliceId: params.sliceId,
      outcome: params.outcome,
      implementedSummary: limitBlock(params.implementedSummary, 6000),
      ...(params.nextPrompt ? { nextPrompt: limitBlock(params.nextPrompt, 6000) } : {}),
      ...(params.finalGate ? { finalGate: params.finalGate } : {}),
      completedAt: new Date().toISOString(),
    };

    if (params.outcome === "done") {
      const problems = validateWorkonLoopFinalGate(record, params.finalGate);
      if (problems.length > 0) {
        throw new Error(`Final gate rejected:\n${problems.map((problem) => `- ${problem}`).join("\n")}`);
      }
      const finalGateSummary = summarizeFinalGate(params.finalGate!);
      // Mirrors /pr automation, but trusts the already accepted /workonloop final gate
      // instead of running validation again.
      const prResult = await autoCreateWorkonLoopPr(pi, record, finalGateSummary);
      if (!prResult.ok) throw new Error(prResult.summary);
      const testServerResult = await startWorkonLoopTestServer(record);
      const doneState: WorkonLoopState = {
        ...state,
        status: "done",
        history: [...state.history, historyItem],
        updatedAt: new Date().toISOString(),
      };
      await writeWorkonLoopState(record.loop!.statePath, doneState);
      const cleanupLines = await cleanupWorkonLoopLaunchers(record.slug);
      const cleanupNote = cleanupLines.length > 0 ? `\n${cleanupLines.join("\n")}` : "";
      return `workonloop done. Final gate accepted. State: ${record.loop!.statePath}\nTerminal stays open.\n${testServerResult.summary}\n${prResult.summary}${cleanupNote}`;
    }

    if (!trim(params.nextPrompt ?? "")) throw new Error("nextPrompt is required for outcome=next");
    if (state.sliceIndex >= state.maxSlices) {
      throw new Error(`Max slices reached (${state.maxSlices}). Run the final full gate and call outcome=done.`);
    }

    const nextIndex = state.sliceIndex + 1;
    const nextState: WorkonLoopState = {
      ...state,
      sliceIndex: nextIndex,
      activeSliceId: makeLoopSliceId(record.slug, nextIndex),
      history: [...state.history, historyItem],
      updatedAt: new Date().toISOString(),
    };
    const prompt = buildWorkonLoopPrompt(record, nextState, params.nextPrompt ?? "");
    const currentWindowAddress = ownTerminalWindowAddress();
    const loopWorkspaceId = ownTerminalWorkspaceId();
    const terminal = openTerminalInWorkspace(record.worktreePath, prompt, { slug: `${record.slug}-loop-${nextIndex}`, workspaceId: loopWorkspaceId });
    if (!terminal.ok) throw new Error(`Next slice terminal failed: ${terminal.error}`);
    await writeWorkonLoopState(record.loop!.statePath, nextState);
    const cleanupLines = await cleanupWorkonLoopLaunchers(record.slug, terminal.commandLine);
    scheduleWorkonLoopShutdown(ctx, currentWindowAddress);
    const cleanupNote = cleanupLines.length > 0 ? `\n${cleanupLines.join("\n")}` : "";
    return `workonloop slice ${state.sliceIndex} recorded. Started slice ${nextIndex}/${state.maxSlices}: ${terminal.commandLine}\nThis terminal will close automatically.${cleanupNote}`;
  });
}

export default function workonExtension(pi: ExtensionAPI): void {
  pi.registerTool?.({
    name: "workonloop_finish_slice",
    label: "Workon Loop Finish Slice",
    description: "Finish current /workonloop slice. Starts next slice terminal or finalizes with testserver + PR after full validation and applicable Docker gate.",
    promptSnippet: "Finish a /workonloop slice and either start the next slice terminal or finalize with testserver + PR after final gate.",
    promptGuidelines: ["Use workonloop_finish_slice only inside /workonloop worker terminals, exactly once at the end of each slice."],
    parameters: WorkonLoopFinishSliceParameters,
    async execute(_toolCallId: string, params: WorkonLoopFinishSliceParams, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
      const text = await handleWorkonLoopFinishSlice(pi, params, ctx);
      return { content: [{ type: "text", text }], details: { outcome: params.outcome, sliceId: params.sliceId } };
    },
  });

  pi.registerCommand("workon", {
    description: "Create feature worktree, write handoff, and open a new Pi terminal. Usage: /workon slug task/files... [--nodocker]",
    handler: async (args, ctx) => startWorkon(pi, args, ctx),
  });

  pi.registerCommand("workonplan", {
    description: "Create feature worktree and open a new Pi terminal in Plannotator plan mode. Usage: /workonplan slug task/files... [--nodocker]",
    handler: async (args, ctx) => startWorkon(pi, args, ctx, { mode: "workonplan" }),
  });

  pi.registerCommand("workonhardplan", {
    description: "Create feature worktree and open a hard Plannotator planning session that splits planning from fresh implementation. Usage: /workonhardplan slug task/files... [--nodocker]",
    handler: async (args, ctx) => startWorkon(pi, args, ctx, { mode: "workonhardplan" }),
  });

  pi.registerCommand("workonloop", {
    description: "Create feature worktree and auto-loop slice terminals until final full test plus applicable Docker gate. Usage: /workonloop slug zielbild... [--nodocker]",
    handler: async (args, ctx) => startWorkon(pi, args, ctx, { mode: "workonloop", requireTask: true }),
  });

  pi.registerCommand("workon-read", {
    description: "Send latest/specified workon handoff to current Pi session. Usage: /workon-read [slug]",
    handler: async (args, ctx) => {
      const record = await findRecordForCwd(pi, ctx.cwd, args.trim() || undefined);
      if (!record) {
        safeNotify(ctx, "No workon handoff found.", "warning");
        return;
      }
      if (record.mode === "workonhardplan") {
        const planPath = record.hardPlan?.planPath ?? path.join(record.worktreePath, "plans", `workon-${pathSlug(record.slug)}`, "30-plan.md");
        const scoutPath = record.hardPlan?.scoutPath;
        const plannerPath = record.hardPlan?.plannerPath;
        const dockerReadPrompt = record.docker
          ? "Docker/Compose is enabled by default; use the assigned dev ports/env file only when runtime validation needs a server, and report the testserver URL if one was started."
          : "Docker/Compose is disabled because `--nodocker` was passed. Do not start Docker/Compose and do not report a Docker-backed testserver URL.";
        pi.sendUserMessage(`Read workon handoff ${record.markdownPath}. Treat its Workon Operating Contract and Workon Hard Plan Mode sections as task-specific system instructions. This is the fresh implementation session: read the approved plan at ${planPath}${scoutPath ? `, and use scout notes at ${scoutPath}` : ""}${plannerPath ? ` plus planner notes at ${plannerPath}` : ""} only as needed. Do not re-enter plan mode or resubmit the plan unless the user asks. If the approved plan is missing or clearly not approved, stop and ask the user. Implement in ${record.worktreePath}. Before final summary, /pr, or done, run/use a fresh-context reviewer subagent on the current diff and fix or explicitly answer findings. ${dockerReadPrompt}`);
        return;
      }
      if (record.mode === "workonloop" && record.loop) {
        const state = await readWorkonLoopState(record.loop.statePath);
        if (!state) {
          safeNotify(ctx, `No readable workonloop state at ${record.loop.statePath}`, "warning");
          return;
        }
        if (state.status === "done") {
          safeNotify(ctx, `workonloop already done for ${record.slug}. State: ${record.loop.statePath}`, "info");
          return;
        }
        pi.sendUserMessage(buildWorkonLoopPrompt(record, state, "Setze den aktuell offenen Slice fort. Wenn der Slice fertig ist, rufe `workonloop_finish_slice` auf."));
        return;
      }
      const instructionSections = record.mode === "workonplan"
        ? "Workon Operating Contract and Plannotator Plan Mode sections"
        : "Workon Operating Contract";
      pi.sendUserMessage(`Read workon handoff ${record.markdownPath}. Treat its ${instructionSections} as task-specific system instructions. Then continue. Stay in ${record.worktreePath}.`);
    },
  });

  pi.registerCommand("workon-status", {
    description: "Show recent workon sessions.",
    handler: async (_args, ctx) => {
      const records = (await listRecords()).slice(0, 8);
      if (records.length === 0) {
        safeNotify(ctx, "No workon records yet.", "info");
        return;
      }
      safeNotify(
        ctx,
        records.map((record) => `${record.slug}: ${record.branch}\n  ${record.worktreePath}\n  ${record.markdownPath}`).join("\n"),
        "info",
      );
    },
  });

  pi.registerCommand("pr", {
    description: "Validate, commit dirty changes, push branch, create/view GitHub PR.",
    handler: async (args, ctx) => {
      const noTest = /(^|\s)--no-test(\s|$)/.test(args);
      const root = await gitRoot(pi, ctx.cwd);
      if (!root) {
        safeNotify(ctx, `No git repo at ${ctx.cwd}`, "error");
        return;
      }
      const branch = await currentBranch(pi, root);
      if (MAIN_BRANCHES.has(branch)) {
        safeNotify(ctx, `Refuse PR from ${branch}. Run /workon first.`, "warning");
        return;
      }

      const record = await findRecordForCurrentRoot(pi, root);
      const validationCommands = detectValidationCommands(root);
      const validationEnvPath = record?.envPath && existsSync(record.envPath) ? record.envPath : undefined;
      safeNotify(
        ctx,
        noTest
          ? `PR for ${branch}: validation skipped via --no-test.`
          : `PR for ${branch}: validation started.\n${validationCommands.length ? validationCommands.join("\n") : "No validation commands detected."}${validationEnvPath ? `\nEnv: ${validationEnvPath}` : ""}`,
        noTest ? "warning" : "info",
      );
      setStatus(ctx, noTest ? "PR no-test" : "PR validating");
      const validation = noTest
        ? { ok: true, summary: "Skipped validation via --no-test." }
        : await runValidation(pi, root, validationCommands, (message) => safeNotify(ctx, message, "info"), validationEnvPath, record);
      setStatus(ctx, undefined);
      if (!validation.ok) {
        safeNotify(ctx, `Validation failed. PR aborted.\n${validation.summary}`, "error");
        return;
      }

      if (await hasDirtyFiles(pi, root)) {
        const ok = await confirm(ctx, "Commit changes?", `Commit all changes on ${branch} before PR?`);
        if (!ok) {
          safeNotify(ctx, "PR aborted: uncommitted changes remain.", "warning");
          return;
        }
        await git(pi, root, ["add", "-A"], 60_000);
        const commitMessage = await buildStructuredPrMessage({
          pi,
          root,
          branch,
          record,
          validationSummary: validation.summary,
          validationSkipped: noTest,
        });
        const commit = await git(pi, root, ["commit", "-m", commitMessage.subject, "-m", commitMessage.body], 120_000);
        if (commit.code !== 0) {
          safeNotify(ctx, `Commit failed:\n${commit.stderr || commit.stdout}`, "error");
          return;
        }
      }

      const prMessage = await buildStructuredPrMessage({
        pi,
        root,
        branch,
        record,
        validationSummary: validation.summary,
        validationSkipped: noTest,
      });

      const remote = await gitCurrentRemote(pi, root);
      if (!remote) {
        safeNotify(ctx, "No origin remote; cannot push/create PR.", "warning");
        return;
      }

      safeNotify(ctx, `PR for ${branch}: pushing branch to origin...`, "info");
      setStatus(ctx, "PR pushing");
      const push = await git(pi, root, ["push", "-u", "origin", branch], 300_000);
      setStatus(ctx, undefined);
      if (push.code !== 0) {
        safeNotify(ctx, `Push failed:\n${push.stderr || push.stdout}`, "error");
        return;
      }

      safeNotify(ctx, `PR for ${branch}: checking GitHub PR...`, "info");
      const existing = await execShell(pi, root, "gh pr view --json url --jq .url", 60_000);
      if (existing.code === 0 && trim(existing.stdout)) {
        const existingBody = await existingPrField(pi, root, "body");
        const bodyPath = existingBody && isStructuredPrBody(existingBody)
          ? undefined
          : writeGhBodyFile(root, branch, mergeExistingPrBody(existingBody, prMessage.body));
        const bodyArg = bodyPath ? ` --body-file ${shellQuote(bodyPath)}` : "";
        const edit = await execShell(pi, root, `gh pr edit --title ${shellQuote(prMessage.subject)}${bodyArg}`, 120_000);
        if (edit.code !== 0) {
          safeNotify(ctx, `PR exists, but update failed:\n${edit.stderr || edit.stdout}`, "warning");
          return;
        }
        safeNotify(ctx, `PR updated:\n${trim(existing.stdout)}\n\nTitle: ${prMessage.subject}\nBody: ${bodyPath ?? "existing structured body preserved"}\n\nValidation:\n${validation.summary}`, "info");
        return;
      }

      const base = defaultPrBase(record);
      safeNotify(ctx, `PR for ${branch}: creating GitHub PR against ${base}...`, "info");
      const create = await execShell(pi, root, `gh pr create --title ${shellQuote(prMessage.subject)} --body-file ${shellQuote(prMessage.bodyPath)} --base ${shellQuote(base)} --head ${shellQuote(branch)}`, 120_000);
      if (create.code !== 0) {
        safeNotify(ctx, `PR create failed:\n${create.stderr || create.stdout}`, "error");
        return;
      }
      safeNotify(ctx, `PR created:\n${trim(create.stdout)}\n\nTitle: ${prMessage.subject}\nBody: ${prMessage.bodyPath}\n\nValidation:\n${validation.summary}`, "info");
    },
  });

  pi.registerCommand("ship", {
    description: "Merge current GitHub PR after confirmation. Does not run cleanup.",
    handler: async (_args, ctx) => {
      const root = await gitRoot(pi, ctx.cwd);
      if (!root) {
        safeNotify(ctx, `No git repo at ${ctx.cwd}`, "error");
        return;
      }
      const branch = await currentBranch(pi, root);
      if (MAIN_BRANCHES.has(branch)) {
        safeNotify(ctx, `Refuse ship from ${branch}. Run /ship from the feature worktree.`, "warning");
        return;
      }

      const record = await findRecordForCurrentRoot(pi, root);
      const prMessage = await buildStructuredPrMessage({ pi, root, branch, record });
      const existingTitle = await existingPrField(pi, root, "title");
      const existingBody = await existingPrField(pi, root, "body");
      const shipSubject = existingTitle ? truncateText(existingTitle, 72) : prMessage.subject;
      const shipBodyPath = existingBody
        ? writeGhBodyFile(root, branch, isStructuredPrBody(existingBody) ? existingBody : mergeExistingPrBody(existingBody, prMessage.body))
        : prMessage.bodyPath;

      safeNotify(ctx, "Ship: checking current GitHub PR...", "info");
      const view = await execShell(pi, root, "gh pr view --json url,mergeStateStatus,reviewDecision --jq '.url + \"\\nmergeStateStatus=\" + (.mergeStateStatus // \"unknown\") + \"\\nreviewDecision=\" + (.reviewDecision // \"unknown\")'", 60_000);
      if (view.code !== 0) {
        safeNotify(ctx, `No PR found or gh failed:\n${view.stderr || view.stdout}`, "warning");
        return;
      }
      const ok = await confirm(ctx, "Merge PR?", `${trim(view.stdout)}\n\nSquash title: ${shipSubject}\nSquash body: ${shipBodyPath}${existingBody && isStructuredPrBody(existingBody) ? " (existing PR body)" : ""}\n\nMerge with squash and delete remote branch?`);
      if (!ok) {
        safeNotify(ctx, "Ship cancelled.", "info");
        return;
      }
      safeNotify(ctx, "Ship: merging PR with squash...", "info");
      const merge = await execShell(pi, root, `gh pr merge --squash --subject ${shellQuote(shipSubject)} --body-file ${shellQuote(shipBodyPath)}`, 120_000);
      if (merge.code !== 0) {
        safeNotify(ctx, `Merge failed:\n${merge.stderr || merge.stdout}\n\nIf GitHub reports merge conflicts, run /shipmerge from this feature worktree.`, "error");
        return;
      }

      safeNotify(ctx, `Ship: deleting remote branch origin/${branch}...`, "info");
      const remoteDelete = await git(pi, root, ["push", "origin", "--delete", branch], 120_000);
      const remoteDeleteMessage = remoteDelete.code === 0
        ? `Remote branch deleted: origin/${branch}`
        : `Remote branch delete failed; merge already completed. Delete manually if needed:\n${remoteDelete.stderr || remoteDelete.stdout}`;
      safeNotify(
        ctx,
        `Merged. Local branch stays checked out for this worktree; run /cleanup from main Pi when ready.\n${remoteDeleteMessage}\n${trim(merge.stdout || merge.stderr)}`,
        remoteDelete.code === 0 ? "info" : "warning",
      );
    },
  });

  pi.registerCommand("shipmerge", {
    description: "Merge PR base into the feature branch and hand conflicts to the agent. Use after /ship reports conflicts.",
    handler: async (_args, ctx) => {
      const root = await gitRoot(pi, ctx.cwd);
      if (!root) {
        safeNotify(ctx, `No git repo at ${ctx.cwd}`, "error");
        return;
      }
      const branch = await currentBranch(pi, root);
      if (MAIN_BRANCHES.has(branch)) {
        safeNotify(ctx, `Refuse shipmerge from ${branch}. Run /shipmerge from the feature worktree.`, "warning");
        return;
      }

      const record = await findRecordForCwd(pi, root);
      const baseRef = defaultMergeBaseRef(record);
      const mergeOpen = await isMergeInProgress(pi, root);
      const existingConflicts = await unmergedFiles(pi, root);
      if (!mergeOpen && existingConflicts.length === 0 && await hasDirtyFiles(pi, root)) {
        safeNotify(ctx, "Shipmerge aborted: worktree has uncommitted changes. Commit/stash them first, or resolve the existing state manually.", "warning");
        return;
      }

      const ok = await confirm(ctx, "Shipmerge?", mergeOpen || existingConflicts.length > 0
        ? `Existing merge/conflicts detected on ${branch}. Send conflict-resolution prompt to the agent?`
        : `Fetch origin and merge ${baseRef} into ${branch}? Conflicts will be handed to the agent for semantic resolution.`);
      if (!ok) {
        safeNotify(ctx, "Shipmerge cancelled.", "info");
        return;
      }

      setStatus(ctx, "shipmerge");
      let mergeOutput = "";
      try {
        if (!mergeOpen && existingConflicts.length === 0) {
          safeNotify(ctx, `Shipmerge: fetching origin before merging ${baseRef}...`, "info");
          const fetch = await git(pi, root, ["fetch", "origin", "--prune"], 120_000);
          if (fetch.code !== 0) {
            safeNotify(ctx, `Fetch failed:\n${fetch.stderr || fetch.stdout}`, "error");
            return;
          }

          safeNotify(ctx, `Shipmerge: merging ${baseRef} into ${branch}...`, "info");
          const merge = await git(pi, root, ["merge", "--no-edit", baseRef], 300_000);
          mergeOutput = merge.stderr || merge.stdout;
          if (merge.code === 0) {
            safeNotify(ctx, `Shipmerge: ${baseRef} merged cleanly. Sending validation/push prompt to agent...`, "info");
            pi.sendUserMessage(buildShipMergePrompt({ branch, baseRef, conflictFiles: [], record, mergeOutput, cleanMerge: true }));
            return;
          }
        }

        const conflicts = await unmergedFiles(pi, root);
        if (conflicts.length === 0) {
          safeNotify(ctx, `Shipmerge failed but no unmerged files were found:\n${mergeOutput}`, "error");
          return;
        }
        safeNotify(ctx, `Shipmerge: ${conflicts.length} conflict file(s). Sending conflict-resolution prompt to agent...`, "warning");
        pi.sendUserMessage(buildShipMergePrompt({ branch, baseRef, conflictFiles: conflicts, record, mergeOutput, cleanMerge: false }));
      } finally {
        setStatus(ctx, undefined);
      }
    },
  });

  pi.registerCommand("cleanup", {
    description: "Stop workon Docker/devserver processes and remove worktree. Can run from main repo or feature worktree. Usage: /cleanup [slug]",
    handler: async (args, ctx) => {
      const lookup = await findCleanupRecord(pi, ctx.cwd, args.trim() || undefined);
      if (lookup.ambiguous?.length) {
        const candidates = lookup.ambiguous.map((record) => `- ${record.slug}: ${record.branch} -> ${record.worktreePath}`).join("\n");
        safeNotify(ctx, `Multiple workon records for this repo. Run /cleanup <slug>.\n${candidates}`, "warning");
        return;
      }
      const record = lookup.record;
      if (!record) {
        safeNotify(ctx, "No workon record found for this git repo/worktree. Pass an explicit slug, or run /cleanup from the matching main repo/worktree.", "warning");
        return;
      }
      const commandRoot = await gitRoot(pi, ctx.cwd);
      const cleanupRunsFromWorker = Boolean(commandRoot && path.resolve(commandRoot) === path.resolve(record.worktreePath));
      const cleanupWindowAddress = cleanupRunsFromWorker ? ownTerminalWindowAddress() : undefined;
      if (cleanupRunsFromWorker && !cleanupWindowAddress) {
        safeNotify(ctx, `Cleanup from feature worktree cannot safely close this terminal/window. Run /cleanup ${record.slug} from the main repo instead.`, "warning");
        return;
      }

      const ok = await confirm(ctx, "Cleanup workon?", [
        `Stop Docker/Compose project ${record.composeProject}, stop devserver processes inside the worktree, remove local images/volumes/networks, and remove worktree?`,
        `worktree: ${record.worktreePath}`,
        `repo root: ${record.repoRoot}`,
        cleanupRunsFromWorker ? "Running from feature worktree: cleanup will schedule terminal close before worktree removal." : "Running outside feature worktree: cleanup can remove the worktree directly.",
      ].join("\n"));
      if (!ok) {
        safeNotify(ctx, "Cleanup cancelled.", "info");
        return;
      }

      const result = await cleanupWorkonRecord(pi, record, { commandRoot, cleanupRunsFromWorker, cleanupWindowAddress });
      safeNotify(ctx, result.lines.join("\n"), result.ok ? "info" : "warning");
    },
  });

  pi.registerCommand("cleanupeasy", {
    description: "Clean all shipped workon worktrees for the current main repo. Usage: /cleanupeasy",
    handler: async (_args, ctx) => {
      const root = await gitRoot(pi, ctx.cwd);
      if (!root) {
        safeNotify(ctx, `No git repo at ${ctx.cwd}`, "error");
        return;
      }
      const current = await currentBranch(pi, root);
      if (!MAIN_BRANCHES.has(current)) {
        safeNotify(ctx, `Run /cleanupeasy from the main repo, not feature branch ${current}.`, "warning");
        return;
      }

      const candidates = (await listRecords()).filter((record) => path.resolve(record.repoRoot) === path.resolve(root) && existsSync(record.worktreePath));
      if (candidates.length === 0) {
        safeNotify(ctx, "No workon worktrees found for this repo.", "info");
        return;
      }

      const shipped: Array<{ record: WorkonRecord; reason: string }> = [];
      const skipped: string[] = [];
      for (const record of candidates) {
        const state = await isRecordShipped(pi, record);
        if (state.shipped) shipped.push({ record, reason: state.reason });
        else skipped.push(`- ${record.slug}: ${record.branch} (${state.reason})`);
      }

      if (shipped.length === 0) {
        safeNotify(ctx, `No shipped workon worktrees found.\nSkipped:\n${skipped.join("\n") || "- none"}`, "info");
        return;
      }

      const shippedList = shipped.map(({ record, reason }) => `- ${record.slug}: ${record.branch}\n  ${record.worktreePath}\n  ${reason}`).join("\n");
      const skippedText = skipped.length > 0 ? `\n\nNot shipped / skipped:\n${skipped.join("\n")}` : "";
      const ok = await confirm(ctx, "Cleanup shipped worktrees?", `Clean ${shipped.length} shipped workon worktree(s):\n${shippedList}${skippedText}`);
      if (!ok) {
        safeNotify(ctx, "Cleanupeasy cancelled.", "info");
        return;
      }

      const summary: string[] = [];
      for (const { record } of shipped) {
        summary.push(`## ${record.slug} (${record.branch})`);
        const result = await cleanupWorkonRecord(pi, record, { commandRoot: root, cleanupRunsFromWorker: false });
        summary.push(...result.lines.map((line) => `  ${line}`));
      }

      const hasFailure = summary.some((line) => line.trimStart().startsWith("FAIL"));
      safeNotify(ctx, summary.join("\n"), hasFailure ? "warning" : "info");
    },
  });
}
