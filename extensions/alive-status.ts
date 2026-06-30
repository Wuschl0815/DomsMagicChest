import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { statSync } from "node:fs";

const STATUS_KEY = "alive-status";
const CHECK_EVERY_MS = 5_000;
const QUIET_AFTER_MS = 90_000;
const NOTIFY_AFTER_MS = 5 * 60_000;
const NOTIFY_EVERY_MS = 10 * 60_000;

type Phase = "idle" | "working" | "request" | "response" | "stream" | "tool";

const state: {
  phase: Phase;
  detail: string;
  activeSince?: number;
  lastEventAt: number;
  lastNotifyAt: number;
  sessionFile?: string;
  sessionFileMtime?: number;
  timer?: ReturnType<typeof setInterval>;
} = {
  phase: "idle",
  detail: "",
  lastEventAt: Date.now(),
  lastNotifyAt: 0,
};

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    const rest = seconds % 60;
    return rest ? `${minutes}m${rest}s` : `${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h${rest}m` : `${hours}h`;
}

function mark(phase: Phase, detail = "", active = true): void {
  const now = Date.now();
  state.phase = phase;
  state.detail = detail;
  state.lastEventAt = now;

  if (active) {
    state.activeSince ??= now;
  } else {
    state.activeSince = undefined;
    state.lastNotifyAt = 0;
  }
}

function readSessionFileMtime(ctx: ExtensionContext): void {
  const file = ctx.sessionManager.getSessionFile();
  state.sessionFile = file;
  if (!file) {
    state.sessionFileMtime = undefined;
    return;
  }

  try {
    state.sessionFileMtime = statSync(file).mtimeMs;
  } catch {
    state.sessionFileMtime = undefined;
  }
}

function statusText(ctx: ExtensionContext): string | undefined {
  const now = Date.now();
  const idle = ctx.isIdle();

  if (idle && state.activeSince !== undefined) {
    state.phase = "idle";
    state.detail = "";
    state.activeSince = undefined;
    state.lastNotifyAt = 0;
  } else if (!idle && state.activeSince === undefined) {
    state.phase = "working";
    state.detail = "";
    state.activeSince = now;
    state.lastEventAt = now;
  }

  readSessionFileMtime(ctx);

  if (ctx.isIdle()) return undefined;

  const quietFor = now - state.lastEventAt;
  const label = state.detail ? `${state.phase} ${state.detail}` : state.phase;

  if (quietFor >= QUIET_AFTER_MS) {
    const fileQuiet = state.sessionFileMtime ? ` file ${formatDuration(now - state.sessionFileMtime)}` : "";
    return ctx.ui.theme.fg("warning", `Alive? ${formatDuration(quietFor)} ${label}${fileQuiet}`);
  }

  return undefined;
}

function maybeNotifyQuiet(ctx: ExtensionContext): void {
  if (ctx.isIdle()) return;

  const now = Date.now();
  const quietFor = now - state.lastEventAt;
  if (quietFor < NOTIFY_AFTER_MS) return;
  if (now - state.lastNotifyAt < NOTIFY_EVERY_MS) return;

  state.lastNotifyAt = now;
  const label = state.detail ? `${state.phase} ${state.detail}` : state.phase;
  ctx.ui.notify(`Alive check: no Pi events for ${formatDuration(quietFor)} (${label}). Could be long API/tool wait or hang.`, "warning");
}

function publish(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;
  ctx.ui.setStatus(STATUS_KEY, statusText(ctx));
  maybeNotifyQuiet(ctx);
}

function stop(ctx?: ExtensionContext): void {
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = undefined;
  }
  if (ctx?.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
}

function start(ctx: ExtensionContext): void {
  stop(ctx);
  if (!ctx.hasUI) return;

  mark("idle", "", false);
  readSessionFileMtime(ctx);
  publish(ctx);

  state.timer = setInterval(() => publish(ctx), CHECK_EVERY_MS);
  (state.timer as unknown as { unref?: () => void }).unref?.();
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    start(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    stop(ctx);
  });

  pi.on("input", async () => {
    mark("working", "input", false);
  });

  pi.on("agent_start", async () => {
    mark("working", "agent");
  });

  pi.on("before_provider_request", async () => {
    mark("request", "model");
  });

  pi.on("after_provider_response", async (event) => {
    mark("response", String(event.status));
  });

  pi.on("message_update", async () => {
    mark("stream", "model");
  });

  pi.on("turn_start", async (event) => {
    mark("working", `turn ${event.turnIndex + 1}`);
  });

  pi.on("turn_end", async () => {
    mark("working", "turn done");
  });

  pi.on("tool_execution_start", async (event) => {
    mark("tool", event.toolName);
  });

  pi.on("tool_execution_update", async (event) => {
    mark("tool", event.toolName);
  });

  pi.on("tool_execution_end", async (event) => {
    mark("tool", `${event.toolName} done`);
  });

  pi.on("agent_end", async () => {
    mark("idle", "", false);
  });

  pi.registerCommand("alive", {
    description: "Show Pi alive-status details.",
    handler: async (_args, ctx) => {
      readSessionFileMtime(ctx);
      const now = Date.now();
      const label = state.detail ? `${state.phase} ${state.detail}` : state.phase;
      const fileAge = state.sessionFileMtime === undefined ? "n/a" : formatDuration(now - state.sessionFileMtime);
      const activeFor = state.activeSince === undefined ? "n/a" : formatDuration(now - state.activeSince);

      publish(ctx);
      ctx.ui.notify(
        [
          `phase: ${label}`,
          `idle: ${ctx.isIdle() ? "yes" : "no"}`,
          `active: ${activeFor}`,
          `last event: ${formatDuration(now - state.lastEventAt)} ago`,
          `session file write: ${fileAge} ago`,
          `session file: ${state.sessionFile ?? "none"}`,
        ].join("\n"),
        "info",
      );
    },
  });
}
