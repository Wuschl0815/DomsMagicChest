import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const COMMAND = "hangrecovery";
const STATUS_KEY = "hang-recovery";
const STATE_TYPE = "hang-recovery-state";
const DEFAULT_AFTER_MS = 25 * 60_000;
const CHECK_EVERY_MS = 30_000;
const MIN_AFTER_MS = 60_000;
const RECOVERY_DIR = path.join(process.env.HOME || process.cwd(), ".pi", "agent", "hang-recovery");

const ENABLE_VALUES = new Set(["1", "an", "ein", "ja", "on", "true", "yes"]);
const DISABLE_VALUES = new Set(["0", "aus", "nein", "off", "false", "no"]);
const STATUS_VALUES = new Set(["", "status", "show", "info", "?"]);
const TEST_VALUES = new Set(["test", "dry-run", "dryrun"]);
const FORCE_VALUES = new Set(["force", "recover", "jetzt", "now"]);

interface StoredState {
	enabled: boolean;
	updatedAt: string;
	lastRecoveryAt?: string;
	lastReason?: string;
}

type Phase = "idle" | "working" | "request" | "response" | "stream" | "tool" | "recovering";

interface HangState {
	enabled: boolean;
	phase: Phase;
	detail: string;
	lastEventAt: number;
	recovering: boolean;
	lastRecoveryAt?: string;
	lastReason?: string;
	timer?: ReturnType<typeof setInterval>;
	ctx?: ExtensionContext;
}

interface HyprClient {
	address?: string;
	pid?: number;
	workspace?: { id?: number };
}

const state: HangState = {
	enabled: parseBooleanEnv(process.env.PI_HANG_RECOVERY) ?? true,
	phase: "idle",
	detail: "",
	lastEventAt: Date.now(),
	recovering: false,
};

function parseBooleanEnv(value: string | undefined): boolean | undefined {
	const normalized = (value || "").trim().toLowerCase();
	if (ENABLE_VALUES.has(normalized)) return true;
	if (DISABLE_VALUES.has(normalized)) return false;
	return undefined;
}

function afterMs(): number {
	const raw = Number(process.env.PI_HANG_RECOVERY_AFTER_MS || "");
	if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_AFTER_MS;
	return Math.max(MIN_AFTER_MS, Math.floor(raw));
}

function retryMessage(): string {
	return process.env.PI_HANG_RECOVERY_MESSAGE?.trim() || "retry";
}

function piCommand(): string {
	return process.env.PI_HANG_RECOVERY_PI_COMMAND?.trim() || "pi";
}

function shouldCloseWindow(): boolean {
	return parseBooleanEnv(process.env.PI_HANG_RECOVERY_CLOSE_WINDOW) ?? true;
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function hasCommand(command: string): boolean {
	const result = spawnSync("sh", ["-lc", `command -v ${shellQuote(command)} >/dev/null 2>&1`], {
		stdio: "ignore",
		timeout: 1_000,
	});
	return result.status === 0;
}

function parentPid(pid: number): number | undefined {
	const result = spawnSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8", timeout: 1_000 });
	if (result.status !== 0) return undefined;
	const parsed = Number.parseInt(result.stdout.trim(), 10);
	return Number.isFinite(parsed) && parsed > 1 ? parsed : undefined;
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

function ownTerminalWindowAddress(): string | undefined {
	const address = hyprClientForPid(process.pid)?.address;
	return typeof address === "string" && address ? address : undefined;
}

function ownTerminalWorkspaceId(): number | undefined {
	const id = hyprClientForPid(process.pid)?.workspace?.id;
	return typeof id === "number" && id > 0 ? id : undefined;
}

function activeWorkspaceId(): number | undefined {
	const result = spawnSync("hyprctl", ["activeworkspace", "-j"], { encoding: "utf8", timeout: 1_000 });
	if (result.status !== 0) return undefined;
	try {
		const workspace = JSON.parse(result.stdout) as { id?: number };
		return typeof workspace.id === "number" && workspace.id > 0 ? workspace.id : undefined;
	} catch {
		return undefined;
	}
}

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

function mark(phase: Phase, detail = "", resetRecovery = false): void {
	state.phase = phase;
	state.detail = detail;
	state.lastEventAt = Date.now();
	if (resetRecovery) state.recovering = false;
}

function restoreState(ctx: ExtensionContext, fallbackEnabled: boolean): void {
	const latest = ctx.sessionManager
		.getBranch()
		.filter((entry: { type: string; customType?: string }) => entry.type === "custom" && entry.customType === STATE_TYPE)
		.pop() as { data?: Partial<StoredState> } | undefined;

	state.enabled = fallbackEnabled;
	state.lastRecoveryAt = typeof latest?.data?.lastRecoveryAt === "string" ? latest.data.lastRecoveryAt : undefined;
	state.lastReason = typeof latest?.data?.lastReason === "string" ? latest.data.lastReason : undefined;
	process.env.PI_HANG_RECOVERY = state.enabled ? "1" : "0";
}

function persistState(pi: ExtensionAPI): void {
	pi.appendEntry(STATE_TYPE, {
		enabled: state.enabled,
		updatedAt: new Date().toISOString(),
		lastRecoveryAt: state.lastRecoveryAt,
		lastReason: state.lastReason,
	} satisfies StoredState);
}

function setStatus(ctx?: ExtensionContext): void {
	const activeCtx = ctx ?? state.ctx;
	if (!activeCtx?.hasUI) return;
	if (!state.enabled || activeCtx.isIdle()) {
		activeCtx.ui.setStatus(STATUS_KEY, undefined);
		return;
	}
	const quietFor = Date.now() - state.lastEventAt;
	const threshold = afterMs();
	if (state.recovering) {
		activeCtx.ui.setStatus(STATUS_KEY, activeCtx.ui.theme.fg("warning", "HR recovering"));
		return;
	}
	if (quietFor >= Math.max(0, threshold - 2 * 60_000)) {
		activeCtx.ui.setStatus(STATUS_KEY, activeCtx.ui.theme.fg("warning", `HR ${formatDuration(quietFor)}/${formatDuration(threshold)}`));
		return;
	}
	activeCtx.ui.setStatus(STATUS_KEY, undefined);
}

function terminalCommandLine(shellCommand: string, cwd: string, sessionFile: string): string {
	const custom = process.env.PI_HANG_RECOVERY_TERMINAL_COMMAND?.trim();
	if (custom) {
		return custom
			.replaceAll("{command}", shellCommand)
			.replaceAll("{command:q}", shellQuote(shellCommand))
			.replaceAll("{cwd}", cwd)
			.replaceAll("{cwd:q}", shellQuote(cwd))
			.replaceAll("{session}", sessionFile)
			.replaceAll("{session:q}", shellQuote(sessionFile));
	}

	const command = `${shellCommand}; exec ${process.env.SHELL || "/bin/bash"}`;
	const quoted = shellQuote(command);
	if (hasCommand("xdg-terminal-exec")) return `xdg-terminal-exec -- sh -lc ${quoted}`;
	if (hasCommand("ghostty")) return `ghostty -e sh -lc ${quoted}`;
	if (hasCommand("alacritty")) return `alacritty -e sh -lc ${quoted}`;
	if (hasCommand("kitty")) return `kitty sh -lc ${quoted}`;
	if (hasCommand("foot")) return `foot sh -lc ${quoted}`;
	if (hasCommand("gnome-terminal")) return `gnome-terminal -- sh -lc ${quoted}`;
	if (hasCommand("konsole")) return `konsole -e sh -lc ${quoted}`;
	return `sh -lc ${quoted}`;
}

function spawnDetached(command: string, args: string[], cwd: string): void {
	const child = spawn(command, args, { cwd, detached: true, stdio: "ignore" });
	child.unref();
}

function writeLauncherScript(ctx: ExtensionContext, reason: string): { launcher: string; sessionFile: string; commandLine: string } {
	const sessionFile = ctx.sessionManager.getSessionFile();
	if (!sessionFile) throw new Error("no session file; cannot resume exact session");

	mkdirSync(RECOVERY_DIR, { recursive: true });
	const scriptPath = path.join(RECOVERY_DIR, `recover-${Date.now()}.sh`);
	const prompt = retryMessage();
	const piLine = `${piCommand()} --session ${shellQuote(sessionFile)} ${shellQuote(prompt)}`;
	const shellCommand = `cd ${shellQuote(ctx.cwd)} && ${piLine}`;
	const terminalLine = terminalCommandLine(shellCommand, ctx.cwd, sessionFile);
	const body = [
		"#!/bin/sh",
		"set -eu",
		`echo ${shellQuote(`Pi hang recovery: ${reason}`)}`,
		`cd ${shellQuote(ctx.cwd)}`,
		`exec ${terminalLine}`,
		"",
	].join("\n");
	writeFileSync(scriptPath, body, "utf8");
	chmodSync(scriptPath, 0o700);
	return { launcher: scriptPath, sessionFile, commandLine: shellCommand };
}

function scheduleCloseOldWindow(address: string | undefined): void {
	if (!shouldCloseWindow()) return;
	if (!address || !hasCommand("hyprctl")) return;
	const script = `sleep 5; hyprctl dispatch closewindow ${shellQuote(`address:${address}`)} >/dev/null 2>&1 || true`;
	spawnDetached("sh", ["-lc", script], process.cwd());
}

function openRecoveryTerminal(ctx: ExtensionContext, reason: string): { launcher: string; sessionFile: string; commandLine: string } {
	const launcher = writeLauncherScript(ctx, reason);
	const workspace = ownTerminalWorkspaceId() ?? activeWorkspaceId();
	if (workspace && hasCommand("hyprctl")) {
		spawnDetached("hyprctl", ["dispatch", "exec", `[workspace ${workspace} silent] ${launcher.launcher}`], ctx.cwd);
	} else {
		spawnDetached(launcher.launcher, [], ctx.cwd);
	}
	return launcher;
}

function recover(pi: ExtensionAPI, ctx: ExtensionContext, reason: string, dryRun = false): void {
	if (!state.enabled && !dryRun) return;
	if (state.recovering && !dryRun) return;
	if (ctx.mode !== "tui" && !process.env.PI_HANG_RECOVERY_TERMINAL_COMMAND) return;

	const oldWindow = ownTerminalWindowAddress();
	const launcher = writeLauncherScript(ctx, reason);
	const workspace = ownTerminalWorkspaceId() ?? activeWorkspaceId();
	const commandText = workspace && hasCommand("hyprctl")
		? `hyprctl dispatch exec [workspace ${workspace} silent] ${launcher.launcher}`
		: launcher.launcher;

	if (dryRun) {
		ctx.ui.notify(
			[
				"Hang recovery dry-run:",
				`session: ${launcher.sessionFile}`,
				`cwd: ${ctx.cwd}`,
				`launcher: ${launcher.launcher}`,
				`run: ${commandText}`,
				`message: ${retryMessage()}`,
			].join("\n"),
			"info",
		);
		return;
	}

	state.recovering = true;
	state.phase = "recovering";
	state.lastRecoveryAt = new Date().toISOString();
	state.lastReason = reason;
	persistState(pi);
	setStatus(ctx);

	try {
		// Reuse already-written launcher, then open it in same Hyprland workspace where possible.
		if (workspace && hasCommand("hyprctl")) {
			spawnDetached("hyprctl", ["dispatch", "exec", `[workspace ${workspace} silent] ${launcher.launcher}`], ctx.cwd);
		} else {
			spawnDetached(launcher.launcher, [], ctx.cwd);
		}
		scheduleCloseOldWindow(oldWindow);
		ctx.ui.notify(`Hang recovery started replacement Pi with '${retryMessage()}'. Old Pi shutting down.`, "warning");
		ctx.shutdown();
	} catch (error) {
		state.recovering = false;
		const msg = error instanceof Error ? error.message : String(error);
		ctx.ui.notify(`Hang recovery failed: ${msg}`, "error");
	}
}

function check(pi: ExtensionAPI, ctx: ExtensionContext): void {
	state.ctx = ctx;
	if (!state.enabled || state.recovering || ctx.isIdle()) {
		setStatus(ctx);
		return;
	}
	const quietFor = Date.now() - state.lastEventAt;
	const threshold = afterMs();
	setStatus(ctx);
	if (quietFor < threshold) return;
	const label = state.detail ? `${state.phase} ${state.detail}` : state.phase;
	recover(pi, ctx, `no Pi events for ${formatDuration(quietFor)} (${label})`);
}

function start(pi: ExtensionAPI, ctx: ExtensionContext): void {
	stop(ctx);
	state.ctx = ctx;
	mark("idle", "", true);
	state.timer = setInterval(() => check(pi, ctx), CHECK_EVERY_MS);
	(state.timer as unknown as { unref?: () => void }).unref?.();
	setStatus(ctx);
}

function stop(ctx?: ExtensionContext): void {
	if (state.timer) {
		clearInterval(state.timer);
		state.timer = undefined;
	}
	ctx?.ui.setStatus(STATUS_KEY, undefined);
}

function setEnabled(pi: ExtensionAPI, enabled: boolean, ctx: ExtensionContext): void {
	state.enabled = enabled;
	process.env.PI_HANG_RECOVERY = enabled ? "1" : "0";
	persistState(pi);
	setStatus(ctx);
	ctx.ui.notify(`Hang recovery ${enabled ? "an" : "aus"}.`, enabled ? "info" : "warning");
}

function statusLines(ctx: ExtensionContext): string {
	const quietFor = Date.now() - state.lastEventAt;
	const label = state.detail ? `${state.phase} ${state.detail}` : state.phase;
	return [
		`enabled: ${state.enabled ? "yes" : "no"}`,
		`idle: ${ctx.isIdle() ? "yes" : "no"}`,
		`phase: ${label}`,
		`quiet: ${formatDuration(quietFor)} / ${formatDuration(afterMs())}`,
		`recovering: ${state.recovering ? "yes" : "no"}`,
		`message: ${retryMessage()}`,
		`close window: ${shouldCloseWindow() ? "yes" : "no"}`,
		`session: ${ctx.sessionManager.getSessionFile() ?? "none"}`,
		state.lastRecoveryAt ? `last recovery: ${state.lastRecoveryAt}` : undefined,
		state.lastReason ? `last reason: ${state.lastReason}` : undefined,
	]
		.filter(Boolean)
		.join("\n");
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		restoreState(ctx, parseBooleanEnv(process.env.PI_HANG_RECOVERY) ?? true);
		start(pi, ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		stop(ctx);
		state.ctx = undefined;
	});

	pi.on("input", async (_event, ctx) => {
		state.ctx = ctx;
		mark("working", "input", true);
	});

	pi.on("agent_start", async (_event, ctx) => {
		state.ctx = ctx;
		mark("working", "agent", true);
	});

	pi.on("before_provider_request", async () => mark("request", "model"));
	pi.on("after_provider_response", async (event) => mark("response", String(event.status)));
	pi.on("message_update", async () => mark("stream", "model"));
	pi.on("turn_start", async (event) => mark("working", `turn ${event.turnIndex + 1}`));
	pi.on("turn_end", async () => mark("working", "turn done"));
	pi.on("tool_execution_start", async (event) => mark("tool", event.toolName));
	pi.on("tool_execution_update", async (event) => mark("tool", event.toolName));
	pi.on("tool_execution_end", async (event) => mark("tool", `${event.toolName} done`));
	pi.on("agent_end", async () => mark("idle", "", true));

	pi.registerCommand(COMMAND, {
		description: "Restart hung Pi terminal after 15m without events and resume same session with retry.",
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
			if (TEST_VALUES.has(action)) {
				recover(pi, ctx, "manual dry-run", true);
				return;
			}
			if (FORCE_VALUES.has(action)) {
				recover(pi, ctx, "manual force");
				return;
			}
			if (STATUS_VALUES.has(action)) {
				setStatus(ctx);
				ctx.ui.notify(statusLines(ctx), "info");
				return;
			}
			ctx.ui.notify("Usage: /hangrecovery [status|an|aus|test|force]", "warning");
		},
	});
}
