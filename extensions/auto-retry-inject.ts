import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const COMMAND = "autoretry";
const STATUS_KEY = "auto-retry-inject";
const STATE_TYPE = "auto-retry-inject-state";
const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_MAX_ATTEMPTS = 12;
const MIN_INTERVAL_MS = 5_000;

const ENABLE_VALUES = new Set(["1", "an", "ein", "ja", "on", "true", "yes"]);
const DISABLE_VALUES = new Set(["0", "aus", "nein", "off", "false", "no"]);
const STATUS_VALUES = new Set(["", "status", "show", "info", "?"]);
const RETRY_VALUES = new Set(["retry", "jetzt", "now", "sofort"]);

const RETRYABLE_PATTERNS = [
	/fetch failed/i,
	/overload(?:ed)?/i,
	/rate.?limit/i,
	/too many requests/i,
	/\b429\b/,
	/\b5(?:00|02|03|04)\b/,
	/service unavailable/i,
	/temporarily unavailable/i,
	/gateway/i,
	/network/i,
	/econnreset/i,
	/etimedout/i,
	/timed?\s*out/i,
	/socket hang up/i,
];

const NON_RETRYABLE_PATTERNS = [
	/aborted/i,
	/cancelled/i,
	/context (?:length|window|overflow)/i,
	/prompt is too long/i,
	/maximum context/i,
	/invalid api key/i,
	/unauthorized/i,
	/forbidden/i,
	/insufficient quota/i,
];

interface StoredState {
	enabled: boolean;
	updatedAt: string;
	attempts: number;
	lastError?: string;
}

interface RetryState {
	enabled: boolean;
	attempts: number;
	waitingSince?: number;
	lastError?: string;
	timer?: ReturnType<typeof setTimeout>;
	statusTimer?: ReturnType<typeof setInterval>;
	ctx?: ExtensionContext;
}

const state: RetryState = {
	enabled: parseBooleanEnv(process.env.PI_AUTO_RETRY_INJECT) ?? true,
	attempts: 0,
};

function parseBooleanEnv(value: string | undefined): boolean | undefined {
	const normalized = (value || "").trim().toLowerCase();
	if (ENABLE_VALUES.has(normalized)) return true;
	if (DISABLE_VALUES.has(normalized)) return false;
	return undefined;
}

function intervalMs(): number {
	const raw = Number(process.env.PI_AUTO_RETRY_INJECT_INTERVAL_MS || "");
	if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_INTERVAL_MS;
	return Math.max(MIN_INTERVAL_MS, Math.floor(raw));
}

function maxAttempts(): number {
	const rawValue = process.env.PI_AUTO_RETRY_INJECT_MAX_ATTEMPTS;
	if (rawValue === undefined || rawValue.trim() === "") return DEFAULT_MAX_ATTEMPTS;
	const raw = Number(rawValue);
	if (!Number.isFinite(raw) || raw < 0) return DEFAULT_MAX_ATTEMPTS;
	return Math.floor(raw);
}

function retryMessage(): string {
	return process.env.PI_AUTO_RETRY_INJECT_MESSAGE?.trim() || "retry";
}

function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.ceil(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const rest = seconds % 60;
	return rest ? `${minutes}m${rest}s` : `${minutes}m`;
}

function clearTimer(): void {
	if (state.timer) {
		clearTimeout(state.timer);
		state.timer = undefined;
	}
	state.waitingSince = undefined;
}

function clearStatusTimer(): void {
	if (state.statusTimer) {
		clearInterval(state.statusTimer);
		state.statusTimer = undefined;
	}
}

function setStatus(ctx?: ExtensionContext): void {
	const activeCtx = ctx ?? state.ctx;
	if (!activeCtx?.hasUI) return;

	if (!state.enabled) {
		activeCtx.ui.setStatus(STATUS_KEY, undefined);
		return;
	}

	if (!state.timer || state.waitingSince === undefined) {
		activeCtx.ui.setStatus(STATUS_KEY, undefined);
		return;
	}

	const max = maxAttempts();
	const maxText = max > 0 ? String(max) : "∞";
	const remaining = Math.max(0, state.waitingSince + intervalMs() - Date.now());
	activeCtx.ui.setStatus(STATUS_KEY, `AR ${state.attempts + 1}/${maxText} in ${formatDuration(remaining)}`);
}

function startStatusTimer(ctx: ExtensionContext): void {
	clearStatusTimer();
	setStatus(ctx);
	state.statusTimer = setInterval(() => setStatus(ctx), 1_000);
	(state.statusTimer as unknown as { unref?: () => void }).unref?.();
}

function stopAll(ctx?: ExtensionContext): void {
	clearTimer();
	clearStatusTimer();
	ctx?.ui.setStatus(STATUS_KEY, undefined);
}

function restoreState(ctx: ExtensionContext, fallbackEnabled: boolean): void {
	const latest = ctx.sessionManager
		.getBranch()
		.filter((entry: { type: string; customType?: string }) => entry.type === "custom" && entry.customType === STATE_TYPE)
		.pop() as { data?: Partial<StoredState> } | undefined;

	state.enabled = fallbackEnabled;
	state.attempts = typeof latest?.data?.attempts === "number" ? Math.max(0, latest.data.attempts) : 0;
	state.lastError = typeof latest?.data?.lastError === "string" ? latest.data.lastError : undefined;
	process.env.PI_AUTO_RETRY_INJECT = state.enabled ? "1" : "0";
}

function persistState(pi: ExtensionAPI): void {
	pi.appendEntry(STATE_TYPE, {
		enabled: state.enabled,
		updatedAt: new Date().toISOString(),
		attempts: state.attempts,
		lastError: state.lastError,
	} satisfies StoredState);
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (!part || typeof part !== "object") return "";
			const typed = part as { type?: string; text?: unknown };
			return typed.type === "text" && typeof typed.text === "string" ? typed.text : "";
		})
		.join("\n");
}

function messageErrorText(message: unknown): string {
	if (!message || typeof message !== "object") return "";
	const typed = message as {
		role?: string;
		stopReason?: string;
		errorMessage?: unknown;
		content?: unknown;
	};
	if (typed.role !== "assistant") return "";
	const parts = [typed.stopReason, typed.errorMessage, contentText(typed.content)].filter(Boolean);
	return parts.join("\n");
}

function findLastAssistant(messages: unknown[]): unknown | undefined {
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const msg = messages[i] as { role?: string } | undefined;
		if (msg?.role === "assistant") return messages[i];
	}
	return undefined;
}

function isRetryableError(message: unknown): { retryable: boolean; text: string } {
	const text = messageErrorText(message).trim();
	if (!text) return { retryable: false, text: "" };
	if (!/\berror\b/i.test(text) && !(message as { stopReason?: string } | undefined)?.stopReason?.includes("error")) {
		return { retryable: false, text };
	}
	if (NON_RETRYABLE_PATTERNS.some((pattern) => pattern.test(text))) return { retryable: false, text };
	return { retryable: RETRYABLE_PATTERNS.some((pattern) => pattern.test(text)), text };
}

function shortError(text: string): string {
	return text.replace(/\s+/g, " ").trim().slice(0, 240);
}

function sendRetry(pi: ExtensionAPI, ctx: ExtensionContext): void {
	if (!state.enabled) return;

	const max = maxAttempts();
	if (max > 0 && state.attempts >= max) {
		ctx.ui.notify(`Auto-retry stopped after ${state.attempts}/${max} attempts.`, "warning");
		stopAll(ctx);
		return;
	}

	state.attempts += 1;
	persistState(pi);
	setStatus(ctx);

	const text = retryMessage();
	try {
		if (ctx.isIdle()) {
			pi.sendUserMessage(text);
		} else {
			pi.sendUserMessage(text, { deliverAs: "followUp" });
		}
		ctx.ui.notify(`Auto-retry injected: ${text}`, "warning");
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		ctx.ui.notify(`Auto-retry inject failed: ${msg}`, "error");
	}
}

function scheduleRetry(pi: ExtensionAPI, ctx: ExtensionContext, errorText: string): void {
	if (!state.enabled) return;
	clearTimer();
	state.ctx = ctx;
	state.lastError = shortError(errorText);
	state.waitingSince = Date.now();
	persistState(pi);

	const delay = intervalMs();
	state.timer = setTimeout(() => {
		clearTimer();
		clearStatusTimer();
		sendRetry(pi, ctx);
	}, delay);
	(state.timer as unknown as { unref?: () => void }).unref?.();
	startStatusTimer(ctx);
	ctx.ui.notify(`Retryable provider error detected. Auto-retry in ${formatDuration(delay)}.`, "warning");
}

function cancelWaiting(ctx?: ExtensionContext): void {
	clearTimer();
	clearStatusTimer();
	setStatus(ctx);
}

function setEnabled(pi: ExtensionAPI, enabled: boolean, ctx: ExtensionContext): void {
	state.enabled = enabled;
	process.env.PI_AUTO_RETRY_INJECT = enabled ? "1" : "0";
	if (!enabled) cancelWaiting(ctx);
	persistState(pi);
	ctx.ui.notify(`Auto-retry ${enabled ? "an" : "aus"}.`, enabled ? "info" : "warning");
}

function statusLines(ctx: ExtensionContext): string {
	const max = maxAttempts();
	return [
		`enabled: ${state.enabled ? "yes" : "no"}`,
		`idle: ${ctx.isIdle() ? "yes" : "no"}`,
		`interval: ${formatDuration(intervalMs())}`,
		`attempts: ${state.attempts}${max > 0 ? `/${max}` : ""}`,
		`message: ${retryMessage()}`,
		`waiting: ${state.timer ? "yes" : "no"}`,
		state.lastError ? `last error: ${state.lastError}` : undefined,
	]
		.filter(Boolean)
		.join("\n");
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		state.ctx = ctx;
		restoreState(ctx, parseBooleanEnv(process.env.PI_AUTO_RETRY_INJECT) ?? true);
		setStatus(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		stopAll(ctx);
		state.ctx = undefined;
	});

	pi.on("input", async (event, ctx) => {
		state.ctx = ctx;
		if (event.source === "extension") return;
		if (event.text.trim().toLowerCase() === retryMessage().toLowerCase()) {
			cancelWaiting(ctx);
		}
	});

	pi.on("agent_start", async (_event, ctx) => {
		state.ctx = ctx;
		cancelWaiting(ctx);
	});

	pi.on("agent_end", async (event, ctx) => {
		state.ctx = ctx;
		const assistant = findLastAssistant(event.messages as unknown[]);
		const result = isRetryableError(assistant);

		if (!result.retryable) {
			state.attempts = 0;
			state.lastError = undefined;
			persistState(pi);
			setStatus(ctx);
			return;
		}

		scheduleRetry(pi, ctx, result.text);
	});

	pi.registerCommand(COMMAND, {
		description: "Auto-inject 'retry' after retryable OpenAI/provider errors every 30s, up to 12 retries by default.",
		handler: async (args, ctx) => {
			state.ctx = ctx;
			const action = args.trim().toLowerCase();
			if (ENABLE_VALUES.has(action)) {
				setEnabled(pi, true, ctx);
				return;
			}
			if (DISABLE_VALUES.has(action)) {
				setEnabled(pi, false, ctx);
				return;
			}
			if (RETRY_VALUES.has(action)) {
				cancelWaiting(ctx);
				sendRetry(pi, ctx);
				return;
			}
			if (STATUS_VALUES.has(action)) {
				setStatus(ctx);
				ctx.ui.notify(statusLines(ctx), "info");
				return;
			}

			ctx.ui.notify("Usage: /autoretry [status|an|aus|retry]", "warning");
		},
	});
}
