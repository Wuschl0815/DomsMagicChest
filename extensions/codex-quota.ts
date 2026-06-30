import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Buffer } from "node:buffer";

type UsageWindow = {
  label: string;
  windowSeconds?: number;
  usedPercent: number;
  resetAt?: number;
};

type UsageSnapshot = {
  planType?: string;
  primary?: UsageWindow;
  secondary?: UsageWindow;
  credits?: {
    hasCredits?: boolean;
    unlimited?: boolean;
    balance?: number | string | null;
  };
  source: string;
  fetchedAt: Date;
};

type JsonRecord = Record<string, unknown>;

const LEGACY_STATUS_KEY = "codex-quota";
const WINDOW_STATUS_KEYS = {
  primary: {
    red: "codex-quota-5h-red",
    orange: "codex-quota-5h-orange",
    yellow: "codex-quota-5h-yellow",
    green: "codex-quota-5h-green",
  },
  secondary: {
    red: "codex-quota-week-red",
    orange: "codex-quota-week-orange",
    yellow: "codex-quota-week-yellow",
    green: "codex-quota-week-green",
  },
} as const;
const ALL_STATUS_KEYS = [
  LEGACY_STATUS_KEY,
  ...Object.values(WINDOW_STATUS_KEYS.primary),
  ...Object.values(WINDOW_STATUS_KEYS.secondary),
];
const USAGE_ENDPOINTS = [
  "https://chatgpt.com/backend-api/wham/usage",
  "https://chatgpt.com/backend-api/codex/usage",
  "https://chatgpt.com/api/codex/usage",
];

let latestSnapshot: UsageSnapshot | undefined;
let latestSummary: string | undefined;
let latestDetails: string | undefined;
let refreshTimer: ReturnType<typeof setInterval> | undefined;
let refreshInFlight: Promise<void> | undefined;

function asRecord(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function decodeJwtPayload(token: string): JsonRecord | undefined {
  const [, payload] = token.split(".");
  if (!payload) return undefined;

  try {
    const padded = payload.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(payload.length / 4) * 4, "=");
    const decoded = Buffer.from(padded, "base64").toString("utf8");
    return asRecord(JSON.parse(decoded));
  } catch {
    return undefined;
  }
}

function accountIdFromToken(accessToken: string): string | undefined {
  const payload = decodeJwtPayload(accessToken);
  const auth = asRecord(payload?.["https://api.openai.com/auth"]);
  return asString(auth?.chatgpt_account_id);
}

function accountIdFromStorage(ctx: ExtensionContext): string | undefined {
  const registry = ctx.modelRegistry as unknown as {
    authStorage?: { get?: (provider: string) => unknown };
  };
  const cred = asRecord(registry.authStorage?.get?.("openai-codex"));
  return asString(cred?.accountId);
}

function secondsToLabel(seconds: number | undefined, fallback: string): string {
  if (!seconds || seconds <= 0) return fallback;
  if (seconds === 18_000) return "5h";
  if (seconds === 604_800) return "week";
  if (seconds % 86_400 === 0) return `${seconds / 86_400}d`;
  if (seconds % 3_600 === 0) return `${seconds / 3_600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

function parseUsageWindow(value: unknown, fallbackLabel: string): UsageWindow | undefined {
  const raw = asRecord(value);
  if (!raw) return undefined;

  const usedPercent = asNumber(raw.used_percent ?? raw.usedPercent);
  if (usedPercent === undefined) return undefined;

  const directSeconds = asNumber(raw.limit_window_seconds ?? raw.limitWindowSeconds ?? raw.window_seconds ?? raw.windowSeconds);
  const windowMinutes = asNumber(raw.window_minutes ?? raw.windowMinutes);
  const seconds = directSeconds ?? (windowMinutes !== undefined ? windowMinutes * 60 : undefined);

  return {
    label: secondsToLabel(seconds, fallbackLabel),
    windowSeconds: seconds,
    usedPercent,
    resetAt: asNumber(raw.reset_at ?? raw.resetAt ?? raw.resets_at ?? raw.resetsAt),
  };
}

function parseUsageJson(json: unknown, source: string): UsageSnapshot | undefined {
  const root = asRecord(json);
  if (!root) return undefined;

  const rateLimit = asRecord(root.rate_limit ?? root.rateLimit ?? root.rate_limits ?? root.rateLimits);
  if (!rateLimit) return undefined;

  const primary = parseUsageWindow(rateLimit.primary_window ?? rateLimit.primaryWindow ?? rateLimit.primary, "5h");
  const secondary = parseUsageWindow(rateLimit.secondary_window ?? rateLimit.secondaryWindow ?? rateLimit.secondary, "week");
  if (!primary && !secondary) return undefined;

  const creditsRaw = asRecord(root.credits);

  return {
    planType: asString(root.plan_type ?? root.planType),
    primary,
    secondary,
    credits: creditsRaw
      ? {
          hasCredits: Boolean(creditsRaw.has_credits ?? creditsRaw.hasCredits),
          unlimited: Boolean(creditsRaw.unlimited),
          balance: asNumber(creditsRaw.balance) ?? asString(creditsRaw.balance) ?? null,
        }
      : undefined,
    source,
    fetchedAt: new Date(),
  };
}

function percentLeft(usedPercent: number): number {
  return Math.max(0, Math.min(100, 100 - usedPercent));
}

function formatReset(resetAt: number | undefined, long = false): string {
  if (!resetAt) return "";
  const date = new Date(resetAt * 1000);
  if (Number.isNaN(date.getTime())) return "";

  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (long) {
    return sameDay ? `reset ${time}` : `reset ${date.toLocaleDateString([], { weekday: "short" })} ${time}`;
  }
  return sameDay ? `@${time}` : `@${date.toLocaleDateString([], { weekday: "short" })} ${time}`;
}

function formatWindow(window: UsageWindow | undefined, long = false): string | undefined {
  if (!window) return undefined;
  const left = percentLeft(window.usedPercent).toFixed(0);
  const reset = formatReset(window.resetAt, long);
  return long ? `${window.label}: ${left}% left${reset ? ` (${reset})` : ""}` : `${window.label} ${left}%${reset}`;
}

type UsageWindowKind = "primary" | "secondary";
type QuotaColor = "red" | "orange" | "yellow" | "green";

const WEEK_SLOT_SECONDS = 12 * 60 * 60;
const WEEK_ORANGE_BUFFER_PERCENT = 100 / 7;

const ANSI_QUOTA_COLORS: Record<Exclude<QuotaColor, "red">, string> = {
  orange: "\x1b[38;2;170;75;0m",
  yellow: "\x1b[38;2;255;211;67m",
  green: "\x1b[38;2;82;171;74m",
};

function ansiQuotaColor(color: keyof typeof ANSI_QUOTA_COLORS, text: string): string {
  return `${ANSI_QUOTA_COLORS[color]}${text}\x1b[0m`;
}

function primaryQuotaColor(window: UsageWindow): QuotaColor {
  const left = percentLeft(window.usedPercent);
  if (left < 20) return "red";
  if (left < 40) return "yellow";
  return "green";
}

function weeklyWindowSeconds(window: UsageWindow): number | undefined {
  if (window.windowSeconds && window.windowSeconds > 0) return window.windowSeconds;
  if (window.label === "week") return 7 * 24 * 60 * 60;
  return undefined;
}

function scheduledWeeklyLeftPercent(window: UsageWindow): number | undefined {
  if (!window.resetAt) return undefined;

  const totalSeconds = weeklyWindowSeconds(window);
  if (!totalSeconds) return undefined;

  const remainingSeconds = Math.max(0, Math.min(totalSeconds, window.resetAt - Date.now() / 1000));
  const totalSlots = Math.max(1, Math.ceil(totalSeconds / WEEK_SLOT_SECONDS));
  const remainingSlots = Math.max(0, Math.min(totalSlots, Math.ceil(remainingSeconds / WEEK_SLOT_SECONDS)));
  return (remainingSlots / totalSlots) * 100;
}

function secondaryQuotaColor(window: UsageWindow): QuotaColor {
  const left = percentLeft(window.usedPercent);
  const scheduledLeft = scheduledWeeklyLeftPercent(window);
  if (scheduledLeft === undefined) {
    if (left < 20) return "red";
    if (left < 40) return "orange";
    return "green";
  }

  if (left >= scheduledLeft) return "green";
  if (left >= Math.max(0, scheduledLeft - WEEK_ORANGE_BUFFER_PERCENT)) return "orange";
  return "red";
}

function quotaColor(window: UsageWindow, kind: UsageWindowKind): QuotaColor {
  return kind === "primary" ? primaryQuotaColor(window) : secondaryQuotaColor(window);
}

function colorWindow(ctx: ExtensionContext, color: QuotaColor, text: string): string {
  switch (color) {
    case "red":
      return ctx.ui.theme.fg("error", text);
    case "orange":
      return ansiQuotaColor("orange", text);
    case "yellow":
      return ansiQuotaColor("yellow", text);
    case "green":
      return ansiQuotaColor("green", text);
  }
}

function clearQuotaStatuses(ctx: ExtensionContext): void {
  for (const key of ALL_STATUS_KEYS) {
    ctx.ui.setStatus(key, undefined);
  }
}

function publishSnapshot(ctx: ExtensionContext, snapshot: UsageSnapshot): void {
  clearQuotaStatuses(ctx);

  if (snapshot.primary) {
    const color = quotaColor(snapshot.primary, "primary");
    const key = WINDOW_STATUS_KEYS.primary[color];
    const text = `Codex ${formatWindow(snapshot.primary) ?? ""}`.trimEnd();
    ctx.ui.setStatus(key, colorWindow(ctx, color, text));
  }

  if (snapshot.secondary) {
    const color = quotaColor(snapshot.secondary, "secondary");
    const key = WINDOW_STATUS_KEYS.secondary[color];
    const text = formatWindow(snapshot.secondary) ?? "";
    ctx.ui.setStatus(key, colorWindow(ctx, color, text));
  }
}

function publishLoading(ctx: ExtensionContext): void {
  clearQuotaStatuses(ctx);
  ctx.ui.setStatus(WINDOW_STATUS_KEYS.primary.green, ctx.ui.theme.fg("success", "Codex quota …"));
}

function publishError(ctx: ExtensionContext): void {
  clearQuotaStatuses(ctx);
  ctx.ui.setStatus(WINDOW_STATUS_KEYS.primary.red, ctx.ui.theme.fg("error", "Codex quota ?"));
}

function formatCredits(snapshot: UsageSnapshot): string | undefined {
  const credits = snapshot.credits;
  if (!credits?.hasCredits) return undefined;
  if (credits.unlimited) return "credits: unlimited";
  if (credits.balance === undefined || credits.balance === null || credits.balance === "") return undefined;
  const numeric = asNumber(credits.balance);
  return `credits: ${numeric === undefined ? credits.balance : Math.round(numeric)}`;
}

function updateFormatted(snapshot: UsageSnapshot): void {
  const shortParts = [formatWindow(snapshot.primary), formatWindow(snapshot.secondary)].filter(Boolean);
  const longParts = [formatWindow(snapshot.primary, true), formatWindow(snapshot.secondary, true), formatCredits(snapshot)].filter(Boolean);
  const plan = snapshot.planType ? ` (${snapshot.planType})` : "";

  latestSnapshot = snapshot;
  latestSummary = `Codex ${shortParts.join(" · ")}`;
  latestDetails = `Codex quota${plan}: ${longParts.join(" · ")}\nsource: ${snapshot.source}, fetched: ${snapshot.fetchedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

async function fetchUsage(ctx: ExtensionContext): Promise<UsageSnapshot> {
  const accessToken = await ctx.modelRegistry.getApiKeyForProvider("openai-codex");
  if (!accessToken) {
    throw new Error("No openai-codex OAuth token. Run /login and choose ChatGPT Plus/Pro (Codex Subscription).");
  }

  const accountId = accountIdFromStorage(ctx) ?? accountIdFromToken(accessToken);
  let lastError = "";

  for (const endpoint of USAGE_ENDPOINTS) {
    try {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        "User-Agent": "codex-cli",
      };
      if (accountId) headers["ChatGPT-Account-Id"] = accountId;

      const response = await fetch(endpoint, { headers });
      const text = await response.text();
      if (!response.ok) {
        lastError = `${endpoint}: HTTP ${response.status} ${text.slice(0, 120)}`;
        continue;
      }

      const parsed = parseUsageJson(JSON.parse(text), endpoint);
      if (!parsed) {
        lastError = `${endpoint}: response had no rate_limit windows`;
        continue;
      }

      return parsed;
    } catch (error) {
      lastError = `${endpoint}: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  throw new Error(lastError || "No Codex usage endpoint worked.");
}

async function refreshQuota(ctx: ExtensionContext, notify: boolean): Promise<void> {
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    try {
      const snapshot = await fetchUsage(ctx);
      updateFormatted(snapshot);
      publishSnapshot(ctx, snapshot);
      if (notify) ctx.ui.notify(latestDetails ?? latestSummary ?? "Codex quota updated.", "info");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      publishError(ctx);
      if (notify) ctx.ui.notify(`Codex quota failed: ${message}`, "error");
    } finally {
      refreshInFlight = undefined;
    }
  })();

  return refreshInFlight;
}

function startAutoRefresh(ctx: ExtensionContext): void {
  if (refreshTimer) clearInterval(refreshTimer);
  if (latestSnapshot) publishSnapshot(ctx, latestSnapshot);
  else publishLoading(ctx);
  void refreshQuota(ctx, false);
  refreshTimer = setInterval(() => void refreshQuota(ctx, false), 60_000);
}

function stopAutoRefresh(ctx: ExtensionContext): void {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = undefined;
  clearQuotaStatuses(ctx);
}

async function handleCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
  const command = args.trim().toLowerCase();

  if (command === "clear" || command === "off") {
    latestSnapshot = undefined;
    latestSummary = undefined;
    latestDetails = undefined;
    stopAutoRefresh(ctx);
    ctx.ui.notify("Codex quota footer cleared.", "info");
    return;
  }

  if (command === "last") {
    if (!latestSummary) {
      ctx.ui.notify("Noch kein Codex quota snapshot.", "warning");
      return;
    }
    if (latestSnapshot) publishSnapshot(ctx, latestSnapshot);
    ctx.ui.notify(latestDetails ?? latestSummary, "info");
    return;
  }

  await refreshQuota(ctx, true);
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    startAutoRefresh(ctx);
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    void refreshQuota(ctx, false);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    stopAutoRefresh(ctx);
  });

  pi.registerCommand("codexquota", {
    description: "Refresh/show Codex 5h/week quota in footer. Args: last, clear/off.",
    handler: handleCommand,
  });
}
