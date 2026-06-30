import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const STATUS_DIR = path.join(os.homedir(), ".cache", "pi", "waybar-workspace");
const STATUS_FILE = path.join(STATUS_DIR, `${process.pid}.json`);
const CSS_FILE = path.join(os.homedir(), ".config", "waybar", "pi-workspace-status.css");
const WAYBAR_CONFIG_DIR = path.dirname(CSS_FILE);
const BUSY_COLOR = "#ff5555";
const IDLE_COLOR = "#50fa7b";
const STALE_AFTER_MS = 12 * 60 * 60 * 1000;

type PiWaybarState = "busy" | "idle";

type StatusRecord = {
  pid: number;
  state: PiWaybarState;
  updatedAt: number;
  workspace?: number;
  cwd?: string;
  sessionFile?: string;
};

type HyprClient = {
  pid?: number;
  workspace?: {
    id?: number;
  };
};

let lastCss = "";
let lastWaybarSignalAt = 0;

function disabledReason(): string | undefined {
  if (process.env.PI_WAYBAR_PI_STATUS === "0") return "PI_WAYBAR_PI_STATUS=0";
  if (process.platform !== "linux") return `unsupported platform: ${process.platform}`;
  return undefined;
}

function isEnabled(): boolean {
  return disabledReason() === undefined;
}

function ensureDir(): void {
  mkdirSync(STATUS_DIR, { recursive: true });
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readRecord(file: string): StatusRecord | undefined {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<StatusRecord>;
    if (parsed.state !== "busy" && parsed.state !== "idle") return undefined;
    if (!Number.isInteger(parsed.pid)) return undefined;
    return {
      pid: parsed.pid,
      state: parsed.state,
      updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : 0,
      workspace: typeof parsed.workspace === "number" ? parsed.workspace : undefined,
      cwd: typeof parsed.cwd === "string" ? parsed.cwd : undefined,
      sessionFile: typeof parsed.sessionFile === "string" ? parsed.sessionFile : undefined,
    };
  } catch {
    return undefined;
  }
}

function removeQuietly(file: string): void {
  try {
    rmSync(file, { force: true });
  } catch {
    // ignore cleanup failures
  }
}

function activeRecords(): StatusRecord[] {
  if (!isEnabled()) return [];
  ensureDir();
  const now = Date.now();
  const records: StatusRecord[] = [];

  for (const name of readdirSync(STATUS_DIR)) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(STATUS_DIR, name);
    const record = readRecord(file);
    if (!record || !isPidAlive(record.pid) || now - record.updatedAt > STALE_AFTER_MS) {
      removeQuietly(file);
      continue;
    }

    record.workspace = detectWorkspaceForPid(record.pid);
    records.push(record);
  }

  return records;
}

function parentPid(pid: number): number | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const tail = stat.slice(stat.lastIndexOf(") ") + 2).trim().split(/\s+/);
    const ppid = Number.parseInt(tail[1] ?? "", 10);
    return Number.isInteger(ppid) && ppid > 0 ? ppid : undefined;
  } catch {
    return undefined;
  }
}

function ancestorPids(pid: number): Set<number> {
  const pids = new Set<number>();
  let current: number | undefined = pid;
  for (let i = 0; current && i < 40; i += 1) {
    pids.add(current);
    current = parentPid(current);
  }
  return pids;
}

function activeWorkspace(): number | undefined {
  const result = spawnSync("hyprctl", ["activeworkspace", "-j"], { encoding: "utf8", timeout: 1_000 });
  if (result.status !== 0) return undefined;
  try {
    const parsed = JSON.parse(result.stdout) as { id?: number };
    return typeof parsed.id === "number" && parsed.id > 0 ? parsed.id : undefined;
  } catch {
    return undefined;
  }
}

function detectWorkspaceForPid(pid: number, options: { fallbackToActiveWorkspace?: boolean } = {}): number | undefined {
  const pids = ancestorPids(pid);
  const result = spawnSync("hyprctl", ["clients", "-j"], { encoding: "utf8", timeout: 1_000 });
  if (result.status === 0) {
    try {
      const clients = JSON.parse(result.stdout) as HyprClient[];
      const client = clients.find((candidate) => typeof candidate.pid === "number" && pids.has(candidate.pid));
      const workspace = client?.workspace?.id;
      if (typeof workspace === "number" && workspace > 0) return workspace;
    } catch {
      // fall back below
    }
  }

  return options.fallbackToActiveWorkspace ? activeWorkspace() : undefined;
}

function cssFor(records: StatusRecord[]): string {
  const byWorkspace = new Map<number, PiWaybarState>();
  for (const record of records) {
    if (!Number.isInteger(record.workspace) || record.workspace < 1 || record.workspace > 10) continue;
    const current = byWorkspace.get(record.workspace);
    if (record.state === "busy" || !current) byWorkspace.set(record.workspace, record.state);
  }

  const lines = [
    "/* Auto-generated by Pi extension: waybar-pi-workspace-status.ts */",
    "/* only workspaces containing Pi sessions are colored */",
  ];

  for (const [workspace, state] of [...byWorkspace.entries()].sort(([a], [b]) => a - b)) {
    const color = state === "busy" ? BUSY_COLOR : IDLE_COLOR;
    lines.push(
      `/* workspace ${workspace}: ${state} */`,
      `#workspaces button:nth-child(${workspace}),`,
      `#workspaces button:nth-child(${workspace}) label {`,
      `  color: ${color};`,
      "}",
    );
  }

  lines.push("");
  return lines.join("\n");
}

function signalWaybar(): void {
  if (!isEnabled()) return;
  const now = Date.now();
  if (now - lastWaybarSignalAt < 250) return;
  lastWaybarSignalAt = now;

  try {
    const child = spawn("pkill", ["-SIGUSR2", "waybar"], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  } catch {
    // reload_style_on_change normally handles this; signal is best effort
  }
}

function publishCss(): void {
  if (!isEnabled()) return;
  mkdirSync(WAYBAR_CONFIG_DIR, { recursive: true });
  const css = cssFor(activeRecords());
  if (!lastCss && existsSync(CSS_FILE)) {
    try {
      lastCss = readFileSync(CSS_FILE, "utf8");
    } catch {
      lastCss = "";
    }
  }
  if (css === lastCss) return;

  writeFileSync(CSS_FILE, css, "utf8");
  lastCss = css;
  signalWaybar();
}

function isStaleCtxError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("This extension ctx is stale");
}

function readCtxInfo(ctx?: ExtensionContext): Pick<StatusRecord, "cwd" | "sessionFile"> {
  if (!ctx) return {};
  try {
    return {
      cwd: ctx.cwd,
      sessionFile: ctx.sessionManager.getSessionFile(),
    };
  } catch (error) {
    if (isStaleCtxError(error)) return {};
    throw error;
  }
}

function writeOwnState(state: PiWaybarState, ctx?: ExtensionContext): void {
  if (!isEnabled()) return;
  ensureDir();
  const ctxInfo = readCtxInfo(ctx);
  const record: StatusRecord = {
    pid: process.pid,
    state,
    updatedAt: Date.now(),
    workspace: detectWorkspaceForPid(process.pid, { fallbackToActiveWorkspace: true }),
    ...ctxInfo,
  };
  writeFileSync(STATUS_FILE, `${JSON.stringify(record)}\n`, "utf8");
  publishCss();
}

function removeOwnState(): void {
  if (!isEnabled()) return;
  removeQuietly(STATUS_FILE);
  publishCss();
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    writeOwnState("idle", ctx);
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    writeOwnState("busy", ctx);
  });

  pi.on("agent_start", async (_event, ctx) => {
    writeOwnState("busy", ctx);
  });

  pi.on("agent_end", async (_event, ctx) => {
    writeOwnState("idle", ctx);
  });

  pi.on("session_shutdown", async () => {
    removeOwnState();
  });

  pi.registerCommand("waybar-pi-status", {
    description: "Show/update Waybar Pi workspace status color.",
    handler: async (_args, ctx) => {
      const reason = disabledReason();
      if (reason) {
        ctx.ui.notify(`Waybar Pi workspace status disabled (${reason}).`, "info");
        return;
      }
      const records = activeRecords();
      publishCss();
      ctx.ui.notify(
        [
          `own pid: ${process.pid}`,
          `active pi sessions: ${records.length}`,
          `busy sessions: ${records.filter((record) => record.state === "busy").length}`,
          `workspaces: ${records.map((record) => `${record.workspace ?? "?"}:${record.state}`).join(", ") || "none"}`,
          `css: ${CSS_FILE}`,
        ].join("\n"),
        "info",
      );
    },
  });
}
