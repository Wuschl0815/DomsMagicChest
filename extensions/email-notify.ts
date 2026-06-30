import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
const CONFIG_PATH = path.join(AGENT_DIR, "email-notify.config.json");
const STATE_PATH = path.join(AGENT_DIR, "email-notify.state.json");
const GLOBAL_STATE_PATH = path.join(AGENT_DIR, "email-notify.global-state.json");
const GLOBAL_STATE_POLL_MS = 2_000;

const DEFAULT_CONFIG = {
	enabled: false,
	startEnabled: false,
	host: process.env.PI_EMAIL_NOTIFY_SMTP_HOST || "smtp.example.com",
	port: Number(process.env.PI_EMAIL_NOTIFY_SMTP_PORT || 587),
	secure: process.env.PI_EMAIL_NOTIFY_SMTP_SECURE === "1",
	requireTls: true,
	imapHost: process.env.PI_EMAIL_NOTIFY_IMAP_HOST || "imap.example.com",
	imapPort: Number(process.env.PI_EMAIL_NOTIFY_IMAP_PORT || 993),
	imapSecure: process.env.PI_EMAIL_NOTIFY_IMAP_SECURE !== "0",
	pollReplies: true,
	pollIntervalSeconds: 45,
	allowedFrom: (process.env.PI_EMAIL_NOTIFY_ALLOWED_FROM || "").split(",").map((value) => value.trim()).filter(Boolean),
	from: process.env.PI_EMAIL_NOTIFY_FROM || "",
	to: process.env.PI_EMAIL_NOTIFY_TO || "",
	user: process.env.PI_EMAIL_NOTIFY_USER || "",
	passwordEnv: "PI_EMAIL_NOTIFY_PASSWORD",
	credentialFile: process.env.PI_EMAIL_NOTIFY_CREDENTIAL_FILE || "",
	includeBody: true,
	maxBodyChars: 8000,
	subjectPrefix: "Pi",
	requireReplyToken: true,
	maxTrackedTokens: 80,
	approvalTimeoutMinutes: 120,
};

type EmailNotifyConfig = typeof DEFAULT_CONFIG & {
	passwordFile?: string;
};

type EmailToken = {
	token: string;
	createdAt: string;
	kind: "summary" | "test" | "approval";
	subject: string;
	cwd: string;
};

type EmailNotifyState = {
	lastSeenImapUid?: number;
	outgoingTokens: EmailToken[];
	processedReplyUids: number[];
};

type EmailNotifyGlobalState = {
	active: boolean;
	source?: string;
	reason?: string;
	changedAt?: string;
	token?: string;
	pid?: number;
	host?: string;
};

type SmtpResponse = {
	code: number;
	lines: string[];
};

type ParsedEmail = {
	subject: string;
	from: string;
	text: string;
};

type ApprovalRequest = {
	title: string;
	body: string;
	cwd?: string;
	timeoutMs?: number;
	ack?: () => void;
	resolve?: (approved: boolean) => void;
};

type PendingApproval = {
	resolve: (approved: boolean) => void;
	timer: ReturnType<typeof setTimeout>;
	title: string;
	body: string;
};

let missingSecretWarned = false;
let activeSend: Promise<void> = Promise.resolve();
let currentCtx: ExtensionContext | undefined;
let sessionEmailActive = false;
let localSessionEmailActive = false;
let globalEmailActive = false;
let lastGlobalStateSignature = "";
let pollTimer: ReturnType<typeof setInterval> | undefined;
let globalModeTimer: ReturnType<typeof setInterval> | undefined;
let pollInFlight = false;
const pendingApprovals = new Map<string, PendingApproval>();

function safeNotify(message: string, type: "info" | "warning" | "error" = "info"): void {
	try {
		currentCtx?.ui.notify(message, type);
	} catch {
		// Ignore stale extension contexts after reload/shutdown.
	}
}

function safeIsIdle(): boolean {
	try {
		return currentCtx?.isIdle() ?? true;
	} catch {
		return true;
	}
}

function resolveAgentPath(value: string): string {
	return path.isAbsolute(value) ? value : path.join(AGENT_DIR, value);
}

async function pathExists(file: string): Promise<boolean> {
	try {
		await fs.access(file);
		return true;
	} catch {
		return false;
	}
}

async function loadConfig(): Promise<EmailNotifyConfig> {
	try {
		const raw = await fs.readFile(CONFIG_PATH, "utf8");
		const loaded = JSON.parse(raw) as Partial<EmailNotifyConfig>;
		return { ...DEFAULT_CONFIG, ...loaded };
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "ENOENT") throw error;
		return DEFAULT_CONFIG;
	}
}

async function loadState(): Promise<EmailNotifyState> {
	try {
		const raw = await fs.readFile(STATE_PATH, "utf8");
		const loaded = JSON.parse(raw) as Partial<EmailNotifyState>;
		return {
			lastSeenImapUid: loaded.lastSeenImapUid,
			outgoingTokens: Array.isArray(loaded.outgoingTokens) ? loaded.outgoingTokens : [],
			processedReplyUids: Array.isArray(loaded.processedReplyUids) ? loaded.processedReplyUids : [],
		};
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "ENOENT") throw error;
		return { outgoingTokens: [], processedReplyUids: [] };
	}
}

async function saveState(state: EmailNotifyState): Promise<void> {
	state.outgoingTokens = state.outgoingTokens.slice(-DEFAULT_CONFIG.maxTrackedTokens);
	state.processedReplyUids = state.processedReplyUids.slice(-200);
	await fs.writeFile(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function loadGlobalState(): Promise<EmailNotifyGlobalState> {
	try {
		const raw = await fs.readFile(GLOBAL_STATE_PATH, "utf8");
		const loaded = JSON.parse(raw) as Partial<EmailNotifyGlobalState>;
		return {
			active: Boolean(loaded.active),
			source: typeof loaded.source === "string" ? loaded.source : undefined,
			reason: typeof loaded.reason === "string" ? loaded.reason : undefined,
			changedAt: typeof loaded.changedAt === "string" ? loaded.changedAt : undefined,
			token: typeof loaded.token === "string" ? loaded.token : undefined,
			pid: typeof loaded.pid === "number" ? loaded.pid : undefined,
			host: typeof loaded.host === "string" ? loaded.host : undefined,
		};
	} catch {
		return { active: false };
	}
}

async function saveGlobalState(active: boolean, reason: string, source = "email-notify"): Promise<void> {
	const state: EmailNotifyGlobalState = {
		active,
		source,
		reason,
		changedAt: new Date().toISOString(),
		pid: process.pid,
		host: os.hostname(),
	};
	await fs.mkdir(AGENT_DIR, { recursive: true });
	await fs.writeFile(GLOBAL_STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function globalStateSignature(state: EmailNotifyGlobalState): string {
	return [state.active ? "1" : "0", state.source ?? "", state.reason ?? "", state.changedAt ?? "", state.token ?? ""].join("|");
}

async function recordOutgoingToken(config: EmailNotifyConfig, tokenInfo: EmailToken): Promise<void> {
	const state = await loadState();
	const cutoff = Date.now() - 21 * 24 * 60 * 60 * 1000;
	state.outgoingTokens = state.outgoingTokens
		.filter((entry) => Date.parse(entry.createdAt) >= cutoff)
		.filter((entry) => entry.token !== tokenInfo.token);
	state.outgoingTokens.push(tokenInfo);
	state.outgoingTokens = state.outgoingTokens.slice(-config.maxTrackedTokens);
	await saveState(state);
}

function powershellExe(): string {
	const systemRoot = process.env.SystemRoot || "C:\\Windows";
	return path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function psSingleQuote(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

function execFileText(file: string, args: string[], timeoutMs: number): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(file, args, { windowsHide: true, timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
			if (error) {
				reject(new Error(`${error.message}${stderr ? `\n${stderr}` : ""}`));
				return;
			}
			resolve(String(stdout));
		});
	});
}

async function readDpapiCredentialPassword(file: string): Promise<string | undefined> {
	if (process.platform !== "win32") return undefined;
	if (!(await pathExists(file))) return undefined;

	const script = [
		"$ErrorActionPreference = 'Stop'",
		`$cred = Import-Clixml -LiteralPath ${psSingleQuote(file)}`,
		"[Console]::Out.Write($cred.GetNetworkCredential().Password)",
	].join("; ");

	const password = await execFileText(
		powershellExe(),
		["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
		10_000,
	);
	return password || undefined;
}

async function getPassword(config: EmailNotifyConfig): Promise<string | undefined> {
	const envName = config.passwordEnv || DEFAULT_CONFIG.passwordEnv;
	const envPassword = process.env[envName];
	if (envPassword) return envPassword;

	if (config.credentialFile) {
		const credentialPassword = await readDpapiCredentialPassword(resolveAgentPath(config.credentialFile));
		if (credentialPassword) return credentialPassword;
	}

	if (config.passwordFile) {
		const passwordPath = resolveAgentPath(config.passwordFile);
		if (await pathExists(passwordPath)) return (await fs.readFile(passwordPath, "utf8")).trim();
	}

	return undefined;
}

function createSmtpReader(socket: net.Socket | tls.TLSSocket) {
	let buffer = "";
	const lines: string[] = [];
	const pending: Array<{ resolve: (line: string) => void; reject: (error: Error) => void }> = [];

	const flush = () => {
		while (pending.length > 0 && lines.length > 0) {
			const waiter = pending.shift();
			const line = lines.shift();
			if (waiter && line !== undefined) waiter.resolve(line);
		}
	};

	const fail = (error: Error) => {
		while (pending.length > 0) {
			const waiter = pending.shift();
			if (waiter) waiter.reject(error);
		}
	};

	const onData = (chunk: Buffer | string) => {
		buffer += chunk.toString();
		for (;;) {
			const next = buffer.indexOf("\n");
			if (next === -1) break;
			let line = buffer.slice(0, next);
			buffer = buffer.slice(next + 1);
			if (line.endsWith("\r")) line = line.slice(0, -1);
			lines.push(line);
		}
		flush();
	};

	const onError = (error: Error) => fail(error);
	const onClose = () => fail(new Error("SMTP connection closed"));
	const onTimeout = () => fail(new Error("SMTP connection timed out"));

	socket.on("data", onData);
	socket.on("error", onError);
	socket.on("close", onClose);
	socket.on("timeout", onTimeout);

	const readLine = () => {
		if (lines.length > 0) return Promise.resolve(lines.shift() as string);
		return new Promise<string>((resolve, reject) => pending.push({ resolve, reject }));
	};

	const readResponse = async (): Promise<SmtpResponse> => {
		const responseLines: string[] = [];
		let code = 0;

		for (;;) {
			const line = await readLine();
			responseLines.push(line);
			const match = /^(\d{3})([ -])/.exec(line);
			if (!match) continue;
			code = Number(match[1]);
			if (match[2] === " ") return { code, lines: responseLines };
		}
	};

	const dispose = () => {
		socket.off("data", onData);
		socket.off("error", onError);
		socket.off("close", onClose);
		socket.off("timeout", onTimeout);
	};

	return { readResponse, dispose };
}

function expectCode(response: SmtpResponse, expected: number | number[], action: string) {
	const allowed = Array.isArray(expected) ? expected : [expected];
	if (!allowed.includes(response.code)) {
		throw new Error(`${action} failed: ${response.lines.join(" | ")}`);
	}
}

function writeLine(socket: net.Socket | tls.TLSSocket, line: string): Promise<void> {
	return new Promise((resolve, reject) => {
		socket.write(`${line}\r\n`, (error) => (error ? reject(error) : resolve()));
	});
}

async function command(
	socket: net.Socket | tls.TLSSocket,
	reader: ReturnType<typeof createSmtpReader>,
	line: string,
	expected: number | number[],
	action = line,
): Promise<SmtpResponse> {
	await writeLine(socket, line);
	const response = await reader.readResponse();
	expectCode(response, expected, action);
	return response;
}

function connectPlain(host: string, port: number, timeoutMs: number): Promise<net.Socket> {
	return new Promise((resolve, reject) => {
		const socket = net.connect({ host, port });
		socket.setTimeout(timeoutMs);
		socket.once("connect", () => resolve(socket));
		socket.once("error", reject);
	});
}

function connectTls(host: string, port: number, timeoutMs: number): Promise<tls.TLSSocket> {
	return new Promise((resolve, reject) => {
		const socket = tls.connect({ host, port, servername: host, rejectUnauthorized: true });
		socket.setTimeout(timeoutMs);
		socket.once("secureConnect", () => resolve(socket));
		socket.once("error", reject);
	});
}

function startTls(socket: net.Socket, host: string, timeoutMs: number): Promise<tls.TLSSocket> {
	return new Promise((resolve, reject) => {
		const tlsSocket = tls.connect({ socket, servername: host, rejectUnauthorized: true });
		tlsSocket.setTimeout(timeoutMs);
		tlsSocket.once("secureConnect", () => resolve(tlsSocket));
		tlsSocket.once("error", reject);
	});
}

function dotStuff(text: string): string {
	return text.replace(/\r?\n/g, "\r\n").replace(/^\./gm, "..");
}

function wrapBase64(text: string): string {
	return text.match(/.{1,76}/g)?.join("\r\n") || "";
}

function headerValue(value: string): string {
	const clean = value.replace(/[\r\n]+/g, " ");
	if (/^[\x20-\x7e]*$/.test(clean)) return clean;
	return `=?UTF-8?B?${Buffer.from(clean, "utf8").toString("base64")}?=`;
}

function formatAddress(address: string): string {
	return `<${address.replace(/[<>\r\n]/g, "")}>`;
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

function parseLabelValue(line: string): { label: string; value: string } | undefined {
	const match = /^([^:]+):\s*(.*)$/.exec(line);
	if (!match) return undefined;
	return { label: match[1].trim(), value: match[2].trim() };
}

function renderHtmlList(lines: string[]): string {
	const items = lines
		.map((line) => line.replace(/^[-*]\s*/, "").trim())
		.filter(Boolean)
		.map((line) => `<li style="margin:4px 0;">${escapeHtml(line)}</li>`)
		.join("");
	return `<ul style="margin:8px 0 0 20px; padding:0;">${items}</ul>`;
}

function emailBodyToHtml(body: string, subject: string): string {
	const marker = "\n--- Aktueller Stand ---\n";
	const normalized = body.replace(/\r\n/g, "\n");
	const markerIndex = normalized.indexOf(marker);
	const head = markerIndex === -1 ? normalized : normalized.slice(0, markerIndex);
	const output = markerIndex === -1 ? "" : normalized.slice(markerIndex + marker.length).trim();
	const blocks = head.split(/\n\s*\n/).map((block) => block.trim()).filter(Boolean);
	const metaLines = blocks.shift()?.split("\n") ?? [];
	const contextBlock = blocks.find((block) => /^Kontext:/i.test(block));
	const rulesBlock = blocks.find((block) => /^Antwort-Regeln:/i.test(block));
	const meta = metaLines.map(parseLabelValue).filter((entry): entry is { label: string; value: string } => Boolean(entry));
	const status = meta.find((entry) => entry.label.toLowerCase() === "status")?.value ?? "Pi";
	const badgeColor = /freigabe|hilfe/i.test(status) ? "#b45309" : "#047857";
	const contextLines = contextBlock?.split("\n").slice(1) ?? [];
	const ruleLines = rulesBlock?.split("\n").slice(1) ?? [];

	const metaRows = meta
		.map((entry) => {
			return `<tr>
				<td style="padding:4px 14px 4px 0; color:#6b7280; font-weight:600; vertical-align:top; white-space:nowrap;">${escapeHtml(entry.label)}</td>
				<td style="padding:4px 0; color:#111827; vertical-align:top;">${escapeHtml(entry.value)}</td>
			</tr>`;
		})
		.join("");

	const section = (title: string, content: string) => `<div style="background:#ffffff; border:1px solid #e5e7eb; border-radius:10px; padding:16px; margin-top:14px;">
		<h2 style="font-size:16px; line-height:22px; margin:0 0 10px 0; color:#111827;">${escapeHtml(title)}</h2>
		${content}
	</div>`;

	return `<!doctype html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0; padding:0; background:#f3f4f6; font-family:Segoe UI, Arial, sans-serif; color:#111827;">
	<div style="max-width:760px; margin:0 auto; padding:24px;">
		<div style="background:#111827; color:#ffffff; border-radius:12px 12px 0 0; padding:18px 20px;">
			<div style="font-size:13px; letter-spacing:.08em; text-transform:uppercase; color:#d1d5db;">Pi Coding Agent</div>
			<h1 style="font-size:22px; line-height:28px; margin:6px 0 0 0;">${escapeHtml(subject)}</h1>
		</div>
		<div style="background:#ffffff; border:1px solid #e5e7eb; border-top:0; border-radius:0 0 12px 12px; padding:18px 20px;">
			<div style="display:inline-block; background:${badgeColor}; color:#ffffff; border-radius:999px; padding:4px 12px; font-size:13px; font-weight:700; margin-bottom:12px;">${escapeHtml(status)}</div>
			<table role="presentation" cellspacing="0" cellpadding="0" style="border-collapse:collapse; width:100%; font-size:14px; line-height:20px;">${metaRows}</table>
		</div>
		${contextLines.length > 0 ? section("Kontext", renderHtmlList(contextLines)) : ""}
		${ruleLines.length > 0 ? section("Antwort-Regeln", renderHtmlList(ruleLines)) : ""}
		${section("Aktueller Stand", `<div style="white-space:pre-wrap; font-size:15px; line-height:22px; color:#111827;">${escapeHtml(output || "Keine Ausgabe.")}</div>`)}
		<div style="font-size:12px; line-height:18px; color:#6b7280; margin-top:14px;">Bitte Betreff unverändert lassen. Token muss in Antwort bleiben.</div>
	</div>
</body>
</html>`;
}

function formatEmail(from: string, to: string, subject: string, body: string): string {
	const boundary = `----pi-${randomBytes(12).toString("hex")}`;
	const encodedText = wrapBase64(Buffer.from(body, "utf8").toString("base64"));
	const encodedHtml = wrapBase64(Buffer.from(emailBodyToHtml(body, subject), "utf8").toString("base64"));
	return [
		`From: ${formatAddress(from)}`,
		`To: ${formatAddress(to)}`,
		`Reply-To: ${formatAddress(from)}`,
		`Subject: ${headerValue(subject)}`,
		`Date: ${new Date().toUTCString()}`,
		`Message-ID: <${Date.now()}.${randomBytes(8).toString("hex")}@pi.local>`,
		"MIME-Version: 1.0",
		`Content-Type: multipart/alternative; boundary="${boundary}"`,
		"",
		`--${boundary}`,
		"Content-Type: text/plain; charset=UTF-8",
		"Content-Transfer-Encoding: base64",
		"",
		encodedText,
		`--${boundary}`,
		"Content-Type: text/html; charset=UTF-8",
		"Content-Transfer-Encoding: base64",
		"",
		encodedHtml,
		`--${boundary}--`,
	].join("\r\n");
}

async function sendSmtp(config: EmailNotifyConfig, subject: string, body: string): Promise<void> {
	const password = await getPassword(config);
	if (!password) {
		throw new Error(
			`SMTP password missing. Set ${config.passwordEnv} or create ${resolveAgentPath(config.credentialFile)}.`,
		);
	}

	const timeoutMs = 30_000;
	let socket: net.Socket | tls.TLSSocket = config.secure
		? await connectTls(config.host, config.port, timeoutMs)
		: await connectPlain(config.host, config.port, timeoutMs);
	let reader = createSmtpReader(socket);

	try {
		expectCode(await reader.readResponse(), 220, "greeting");
		let ehlo = await command(socket, reader, `EHLO ${os.hostname() || "localhost"}`, 250, "EHLO");

		if (!config.secure) {
			const supportsStartTls = ehlo.lines.some((line) => /STARTTLS/i.test(line));
			if (!supportsStartTls && config.requireTls) throw new Error("SMTP server did not offer STARTTLS");
			if (supportsStartTls) {
				await command(socket, reader, "STARTTLS", 220, "STARTTLS");
				reader.dispose();
				socket = await startTls(socket as net.Socket, config.host, timeoutMs);
				reader = createSmtpReader(socket);
				ehlo = await command(socket, reader, `EHLO ${os.hostname() || "localhost"}`, 250, "EHLO after STARTTLS");
			}
		}

		await command(socket, reader, "AUTH LOGIN", 334, "AUTH LOGIN");
		await command(socket, reader, Buffer.from(config.user, "utf8").toString("base64"), 334, "AUTH username");
		await command(socket, reader, Buffer.from(password, "utf8").toString("base64"), 235, "AUTH password");
		await command(socket, reader, `MAIL FROM:<${config.from}>`, 250, "MAIL FROM");
		await command(socket, reader, `RCPT TO:<${config.to}>`, [250, 251], "RCPT TO");
		await command(socket, reader, "DATA", 354, "DATA");

		const message = dotStuff(formatEmail(config.from, config.to, subject, body));
		await writeLine(socket, `${message}\r\n.`);
		expectCode(await reader.readResponse(), 250, "message send");
		await command(socket, reader, "QUIT", 221, "QUIT").catch(() => undefined);
	} finally {
		reader.dispose();
		socket.destroy();
	}
}

class ImapClient {
	private socket?: tls.TLSSocket;
	private buffer = "";
	private nextTag = 1;

	constructor(
		private readonly host: string,
		private readonly port: number,
		private readonly timeoutMs: number,
	) {}

	async connect(): Promise<void> {
		this.socket = await connectTls(this.host, this.port, this.timeoutMs);
		this.socket.on("data", (chunk) => {
			this.buffer += chunk.toString("latin1");
		});
		await this.waitForLine(/^\* OK/i, "IMAP greeting");
	}

	async login(user: string, password: string): Promise<void> {
		await this.command(`LOGIN ${imapQuote(user)} ${imapQuote(password)}`);
	}

	async selectInbox(): Promise<number | undefined> {
		const response = await this.command("SELECT INBOX");
		const match = /\[UIDNEXT\s+(\d+)\]/i.exec(response);
		return match ? Number(match[1]) : undefined;
	}

	async searchNewUids(afterUid: number): Promise<number[]> {
		const response = await this.command(`UID SEARCH UID ${afterUid + 1}:*`);
		const line = response.split(/\r?\n/).find((value) => /^\* SEARCH\b/i.test(value));
		if (!line) return [];
		return line
			.replace(/^\* SEARCH\s*/i, "")
			.trim()
			.split(/\s+/)
			.map((value) => Number(value))
			.filter((value) => Number.isFinite(value));
	}

	async fetchMessage(uid: number): Promise<string> {
		const response = await this.command(`UID FETCH ${uid} (BODY.PEEK[]<0.131072>)`);
		const match = /\{(\d+)\}\r?\n/.exec(response);
		if (!match || match.index === undefined) return "";
		const start = match.index + match[0].length;
		const length = Number(match[1]);
		return response.slice(start, start + length);
	}

	async logout(): Promise<void> {
		await this.command("LOGOUT").catch(() => undefined);
		this.socket?.destroy();
	}

	private async command(commandText: string): Promise<string> {
		if (!this.socket) throw new Error("IMAP not connected");
		const tag = `A${String(this.nextTag++).padStart(4, "0")}`;
		await new Promise<void>((resolve, reject) => {
			this.socket?.write(`${tag} ${commandText}\r\n`, (error) => (error ? reject(error) : resolve()));
		});
		const response = await this.waitForTaggedResponse(tag);
		const taggedLine = response.split(/\r?\n/).find((line) => line.startsWith(`${tag} `)) || "";
		if (/\b(NO|BAD)\b/i.test(taggedLine)) throw new Error(`IMAP ${commandText} failed: ${taggedLine}`);
		return response;
	}

	private waitForLine(pattern: RegExp, action: string): Promise<string> {
		return this.waitUntil((buffer) => {
			const lines = buffer.split(/\r?\n/);
			let consumed = 0;
			for (const line of lines) {
				const lineEnd = buffer.indexOf("\n", consumed);
				if (lineEnd === -1) break;
				if (pattern.test(line)) {
					const end = lineEnd + 1;
					return { result: buffer.slice(0, end), rest: buffer.slice(end) };
				}
				consumed = lineEnd + 1;
			}
			return undefined;
		}, action);
	}

	private waitForTaggedResponse(tag: string): Promise<string> {
		return this.waitUntil((buffer) => {
			const pattern = new RegExp(`(?:^|\\r?\\n)${tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} `);
			const match = pattern.exec(buffer);
			if (!match || match.index === undefined) return undefined;
			const lineStart = match[0].startsWith("\n") || match[0].startsWith("\r") ? match.index + match[0].search(/[A-Z]/) : match.index;
			const lineEnd = buffer.indexOf("\n", lineStart);
			if (lineEnd === -1) return undefined;
			const end = lineEnd + 1;
			return { result: buffer.slice(0, end), rest: buffer.slice(end) };
		}, `IMAP ${tag}`);
	}

	private waitUntil(
		find: (buffer: string) => { result: string; rest: string } | undefined,
		action: string,
	): Promise<string> {
		return new Promise((resolve, reject) => {
			const socket = this.socket;
			if (!socket) {
				reject(new Error("IMAP not connected"));
				return;
			}

			let done = false;
			const cleanup = () => {
				socket.off("data", onData);
				socket.off("error", onError);
				socket.off("close", onClose);
				clearTimeout(timer);
			};
			const finish = (value: string) => {
				if (done) return;
				done = true;
				cleanup();
				resolve(value);
			};
			const fail = (error: Error) => {
				if (done) return;
				done = true;
				cleanup();
				reject(error);
			};
			const check = () => {
				const found = find(this.buffer);
				if (!found) return;
				this.buffer = found.rest;
				finish(found.result);
			};
			const onData = () => check();
			const onError = (error: Error) => fail(error);
			const onClose = () => fail(new Error("IMAP connection closed"));
			const timer = setTimeout(() => fail(new Error(`${action} timed out`)), this.timeoutMs);

			socket.on("data", onData);
			socket.on("error", onError);
			socket.on("close", onClose);
			check();
		});
	}
}

function imapQuote(value: string): string {
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function parseHeaderBlock(raw: string): { headers: Record<string, string>; body: string } {
	const normalized = raw.replace(/\r\n/g, "\n");
	const separator = normalized.search(/\n\s*\n/);
	const headerText = separator === -1 ? normalized : normalized.slice(0, separator);
	const body = separator === -1 ? "" : normalized.slice(separator).replace(/^\n+/, "");
	const headers: Record<string, string> = {};
	let current = "";

	for (const line of headerText.split("\n")) {
		if (/^[ \t]/.test(line)) {
			current += ` ${line.trim()}`;
			continue;
		}
		if (current) addHeader(headers, current);
		current = line;
	}
	if (current) addHeader(headers, current);
	return { headers, body };
}

function addHeader(headers: Record<string, string>, line: string): void {
	const index = line.indexOf(":");
	if (index === -1) return;
	const key = line.slice(0, index).trim().toLowerCase();
	const value = line.slice(index + 1).trim();
	headers[key] = headers[key] ? `${headers[key]} ${value}` : value;
}

function decodeHeaderValue(value: string | undefined): string {
	if (!value) return "";
	return value.replace(/=\?([^?]+)\?([bqBQ])\?([^?]+)\?=/g, (_match, charset: string, mode: string, encoded: string) => {
		try {
			const buffer = mode.toUpperCase() === "B"
				? Buffer.from(encoded.replace(/\s+/g, ""), "base64")
				: decodeQuotedPrintableToBuffer(encoded.replace(/_/g, " "));
			return decodeBuffer(buffer, charset);
		} catch {
			return _match;
		}
	});
}

function getHeaderParam(header: string | undefined, name: string): string | undefined {
	if (!header) return undefined;
	const pattern = new RegExp(`${name}=(("[^"]+")|([^;]+))`, "i");
	const match = pattern.exec(header);
	if (!match) return undefined;
	return (match[3] || match[4] || "").replace(/^"|"$/g, "").trim();
}

function decodeQuotedPrintableToBuffer(value: string): Buffer {
	const input = value.replace(/=\r?\n/g, "");
	const bytes: number[] = [];
	for (let index = 0; index < input.length; index++) {
		const char = input[index];
		if (char === "=" && /^[0-9a-fA-F]{2}$/.test(input.slice(index + 1, index + 3))) {
			bytes.push(Number.parseInt(input.slice(index + 1, index + 3), 16));
			index += 2;
		} else {
			bytes.push(input.charCodeAt(index) & 0xff);
		}
	}
	return Buffer.from(bytes);
}

function decodeBuffer(buffer: Buffer, charset = "utf-8"): string {
	const normalized = charset.toLowerCase().replace(/["']/g, "");
	if (normalized.includes("iso-8859-1") || normalized.includes("latin1") || normalized.includes("windows-1252")) {
		return buffer.toString("latin1");
	}
	return buffer.toString("utf8");
}

function decodeMimeBody(body: string, encoding: string | undefined, charset: string | undefined): string {
	const normalized = (encoding || "7bit").toLowerCase();
	if (normalized === "base64") return decodeBuffer(Buffer.from(body.replace(/\s+/g, ""), "base64"), charset);
	if (normalized === "quoted-printable") return decodeBuffer(decodeQuotedPrintableToBuffer(body), charset);
	return decodeBuffer(Buffer.from(body, "latin1"), charset);
}

function splitMultipart(body: string, boundary: string): string[] {
	const marker = `--${boundary}`;
	return body
		.split(marker)
		.slice(1)
		.map((part) => part.replace(/^\r?\n/, ""))
		.filter((part) => !part.startsWith("--"))
		.map((part) => part.replace(/\r?\n--\s*$/, ""));
}

function stripHtml(html: string): string {
	return html
		.replace(/<style[\s\S]*?<\/style>/gi, "")
		.replace(/<script[\s\S]*?<\/script>/gi, "")
		.replace(/<br\s*\/?\s*>/gi, "\n")
		.replace(/<\/p>/gi, "\n")
		.replace(/<[^>]+>/g, "")
		.replace(/&nbsp;/g, " ")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&");
}

function extractTextPart(raw: string): string {
	const { headers, body } = parseHeaderBlock(raw);
	const contentType = headers["content-type"] || "text/plain";
	const transferEncoding = headers["content-transfer-encoding"];
	const charset = getHeaderParam(contentType, "charset") || "utf-8";

	if (/multipart\//i.test(contentType)) {
		const boundary = getHeaderParam(contentType, "boundary");
		if (!boundary) return "";
		const parts = splitMultipart(body, boundary);
		const parsed = parts.map((part) => ({ raw: part, headers: parseHeaderBlock(part).headers }));
		const plain = parsed.find((part) => /^text\/plain\b/i.test(part.headers["content-type"] || ""));
		if (plain) return extractTextPart(plain.raw);
		const html = parsed.find((part) => /^text\/html\b/i.test(part.headers["content-type"] || ""));
		if (html) return stripHtml(extractTextPart(html.raw));
		for (const part of parts) {
			const text = extractTextPart(part).trim();
			if (text) return text;
		}
		return "";
	}

	const decoded = decodeMimeBody(body, transferEncoding, charset);
	if (/text\/html\b/i.test(contentType)) return stripHtml(decoded);
	return decoded;
}

function parseEmail(rawLatin1: string): ParsedEmail {
	const { headers } = parseHeaderBlock(rawLatin1);
	return {
		subject: decodeHeaderValue(headers.subject),
		from: decodeHeaderValue(headers.from),
		text: extractTextPart(rawLatin1),
	};
}

function extractEmails(value: string): string[] {
	const results = new Set<string>();
	for (const match of value.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)) {
		results.add(match[0].toLowerCase());
	}
	return [...results];
}

function fromAllowed(config: EmailNotifyConfig, from: string): boolean {
	const allowed = new Set((config.allowedFrom || []).map((value) => value.toLowerCase()));
	if (allowed.size === 0) return true;
	return extractEmails(from).some((email) => allowed.has(email));
}

function createToken(): string {
	return randomBytes(6).toString("hex");
}

function extractReplyToken(subject: string, body: string): string | undefined {
	const text = `${subject}\n${body}`;
	const match = /\bpi:([a-f0-9]{12})\b/i.exec(text);
	return match?.[1]?.toLowerCase();
}

function cleanReplyText(text: string, token?: string): string {
	const tokenPattern = token ? new RegExp(`\\bpi:${token}\\b`, "i") : undefined;
	const lines = text.replace(/\r\n/g, "\n").split("\n");
	const kept: string[] = [];

	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) {
			if (kept.length > 0 && kept[kept.length - 1] !== "") kept.push("");
			continue;
		}
		if (tokenPattern?.test(trimmed)) continue;
		if (trimmed.startsWith(">")) continue;
		if (/^_{5,}$/.test(trimmed)) break;
		if (/^(from|von|sent|gesendet|to|an|subject|betreff):/i.test(trimmed)) break;
		if (/^(on .+ wrote:|am .+ schrieb .+:)$/i.test(trimmed)) break;
		if (/^--\s*$/.test(trimmed)) break;
		if (/^antworten?:/i.test(trimmed)) continue;
		if (/^token:/i.test(trimmed)) continue;
		kept.push(line.replace(/\s+$/g, ""));
	}

	return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function isApprovalText(text: string): boolean {
	const normalized = text.trim().toLowerCase().replace(/[.!?]+$/g, "");
	return /^(ja|j|ok|okay|approve|approved|freigabe|freigegeben|erlauben|erlaubt|go|weiter|mach|mach weiter|ja bitte|passt)$/i.test(
		normalized,
	);
}

function isDenialText(text: string): boolean {
	const normalized = text.trim().toLowerCase().replace(/[.!?]+$/g, "");
	return /^(nein|n|no|stop|abbrechen|block|blocked|nicht erlauben|ablehnen)$/i.test(normalized);
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: string; text: string } => {
			return Boolean(part && typeof part === "object" && (part as { type?: unknown }).type === "text");
		})
		.map((part) => part.text)
		.join("\n");
}

function looksLikeNeedsUser(text: string): boolean {
	return /\?|\b(bitte|gib|schick|sende|brauch|bestätig|bestaetig|erlaub|wähle|waehle|welche|welchen|welches|soll ich|kannst du|password|passwort|confirm|choose|provide|need you)\b/i.test(
		text,
	);
}

function lastAssistantText(messages: unknown[]): string {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index] as { role?: string; content?: unknown };
		if (message?.role === "assistant") {
			return textFromContent(message.content).trim();
		}
	}
	return "";
}

function truncate(value: string, maxChars: number): string {
	if (value.length <= maxChars) return value;
	return `${value.slice(0, maxChars)}\n\n[gekürzt: ${value.length - maxChars} Zeichen mehr]`;
}

function formatCount(value: number): string {
	return Math.round(value).toLocaleString("de-AT");
}

function formatContextUsage(ctx?: ExtensionContext): string[] {
	try {
		const usage = ctx?.getContextUsage();
		const model = ctx?.model as { id?: string; name?: string; provider?: string } | undefined;
		const lines = ["Kontext:"];
		const modelName = model?.name || model?.id;
		if (modelName) lines.push(`- Modell: ${modelName}`);
		if (!usage) {
			lines.push("- Context Window: unbekannt");
			return lines;
		}

		if (usage.tokens === null || usage.percent === null) {
			lines.push(`- Belegt: unbekannt / ${formatCount(usage.contextWindow)} Tokens`);
			return lines;
		}

		lines.push(`- Belegt: ${formatCount(usage.tokens)} / ${formatCount(usage.contextWindow)} Tokens (${usage.percent.toFixed(1)}%)`);
		lines.push(`- Frei: ${formatCount(Math.max(0, usage.contextWindow - usage.tokens))} Tokens`);
		return lines;
	} catch {
		return ["Kontext:", "- Context Window: unbekannt"];
	}
}

function clipText(value: string, maxChars: number): string {
	const cleaned = value.trim();
	if (cleaned.length <= maxChars) return cleaned;
	return `${cleaned.slice(0, Math.max(0, maxChars - 1)).trim()}…`;
}

function cleanSubjectSnippet(value: string): string {
	return value
		.replace(/```[\s\S]*?```/g, "Codeblock")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/\*\*([^*]+)\*\*/g, "$1")
		.replace(/\[([^\]]+)]\([^)]+\)/g, "$1")
		.replace(/^[-*•]\s*/, "")
		.replace(/^freigabe\s+(für|fuer)\s+/i, "")
		.replace(/^freigabe\s+nötig\s*:?\s*/i, "")
		.replace(/^erfolg\s*:?\s*/i, "")
		.replace(/^fertig\s*:?\s*/i, "")
		.replace(/^hilfe\s*:?\s*/i, "")
		.replace(/\s+/g, " ")
		.trim();
}

function subjectSnippet(text: string): string {
	const lines = text.replace(/\r\n/g, "\n").split("\n");
	const candidates: string[] = [];
	for (const rawLine of lines) {
		const line = cleanSubjectSnippet(rawLine);
		if (!line) continue;
		if (/^[-_=]{3,}$/.test(line)) continue;
		if (/^(pi coding agent|status|zeit|projekt|token|kontext|antwort-regeln|aktueller stand|reply-hinweis)$/i.test(line)) continue;
		if (/^(betreff bitte|token muss|neuer auftrag|freigeben|ablehnen)\b/i.test(line)) continue;
		candidates.push(line);
		if (candidates.length >= 2) break;
	}

	if (candidates.length === 0) return "";
	const combined = candidates[0].length < 42 && candidates[1] ? `${candidates[0]} ${candidates[1]}` : candidates[0];
	return clipText(combined, 82);
}

function subjectLabel(kind: EmailToken["kind"], needsUser: boolean): string {
	if (kind === "approval") return "Freigabe";
	if (kind === "test") return "Test";
	return needsUser ? "Hilfe" : "Erfolg";
}

function buildEmailSubject(config: EmailNotifyConfig, kind: EmailToken["kind"], needsUser: boolean, answer: string, project: string, token: string): string {
	const label = subjectLabel(kind, needsUser);
	const snippet = subjectSnippet(answer) || (kind === "approval" ? "Aktion bestätigen" : needsUser ? "Antwort nötig" : "Aufgabe erledigt");
	return `${config.subjectPrefix}: ${label} – ${snippet} (${clipText(project, 28)}) [pi:${token}]`;
}

function buildEmail(
	config: EmailNotifyConfig,
	cwd: string,
	messages: unknown[],
	manualText?: string,
	kind: EmailToken["kind"] = "summary",
	contextLines: string[] = [],
): { subject: string; body: string; token: string } {
	const answer = (manualText || lastAssistantText(messages) || "Pi ist fertig und wartet auf Eingabe.").trim();
	const needsUser = kind === "approval" || looksLikeNeedsUser(answer);
	const project = path.basename(cwd) || cwd;
	const status = kind === "approval" ? "Freigabe nötig" : needsUser ? "braucht Hilfe" : "fertig";
	const token = createToken();
	const subject = buildEmailSubject(config, kind, needsUser, answer, project, token);
	const instructions = kind === "approval"
		? [
				"Antwort-Regeln:",
				"- Freigeben: ja / freigeben / approve",
				"- Ablehnen: nein / stop / ablehnen",
				"- Betreff bitte nicht ändern, Token drin lassen.",
			]
		: [
				"Antwort-Regeln:",
				"- Neuer Auftrag: einfach Text schreiben und senden.",
				"- Freigabe: ja / freigeben / approve schreiben.",
				"- Betreff bitte nicht ändern, Token drin lassen.",
			];
	const metaLines = [
		"Pi Coding Agent",
		"================",
		"",
		"Status:",
		`  Status : ${status}`,
		`  Zeit   : ${new Date().toLocaleString()}`,
		`  Projekt: ${cwd}`,
		`  Token  : pi:${token}`,
	];
	const prettyContextLines = contextLines.length > 0
		? ["", "Kontext:", ...contextLines.map((line) => `  ${line.replace(/^[-*]\s*/, "• ")}`)]
		: [];
	const prettyInstructions = [
		"",
		"Antwort-Regeln:",
		...instructions.slice(1).map((line) => `  ${line.replace(/^[-*]\s*/, "• ")}`),
	];
	const bodyParts = [
		...metaLines,
		...prettyContextLines,
		...prettyInstructions,
		"",
		"--- Aktueller Stand ---",
		"",
		config.includeBody ? truncate(answer, config.maxBodyChars) : "Body disabled in email-notify.config.json.",
		"",
		"----------------------------------------",
		"Reply-Hinweis: Betreff unverändert lassen. Token muss drin bleiben.",
	];
	return { subject, body: bodyParts.join("\n"), token };
}

async function queueEmail(config: EmailNotifyConfig, subject: string, body: string): Promise<void> {
	activeSend = activeSend.catch(() => undefined).then(() => sendSmtp(config, subject, body));
	return activeSend;
}

async function sendTrackedEmail(
	config: EmailNotifyConfig,
	cwd: string,
	messages: unknown[],
	manualText: string | undefined,
	kind: EmailToken["kind"],
	contextLines: string[] = [],
): Promise<{ subject: string; token: string }> {
	const { subject, body, token } = buildEmail(config, cwd, messages, manualText, kind, contextLines);
	await queueEmail(config, subject, body);
	await recordOutgoingToken(config, { token, createdAt: new Date().toISOString(), kind, subject, cwd });
	return { subject, token };
}

async function initializeImapCursor(config: EmailNotifyConfig, state: EmailNotifyState, password: string): Promise<boolean> {
	if (state.lastSeenImapUid !== undefined) return false;
	const imap = new ImapClient(config.imapHost, config.imapPort, 30_000);
	try {
		await imap.connect();
		await imap.login(config.user, password);
		const uidNext = await imap.selectInbox();
		state.lastSeenImapUid = Math.max(0, (uidNext || 1) - 1);
		await saveState(state);
		return true;
	} finally {
		await imap.logout().catch(() => undefined);
	}
}

async function pollReplies(pi: ExtensionAPI, showNotifications = false): Promise<number> {
	if (!sessionEmailActive) {
		if (showNotifications) safeNotify("Email notify inactive. Use /email-start for this session.", "warning");
		return 0;
	}
	if (pollInFlight) return 0;
	pollInFlight = true;
	try {
		const config = await loadConfig();
		if (!config.enabled || !config.pollReplies) return 0;
		const password = await getPassword(config);
		if (!password) {
			if (!missingSecretWarned) {
				safeNotify(`Email replies disabled: password missing (${config.passwordEnv})`, "warning");
				missingSecretWarned = true;
			}
			return 0;
		}

		const state = await loadState();
		const initialized = await initializeImapCursor(config, state, password);
		if (initialized) {
			if (showNotifications) safeNotify("Email reply cursor initialized", "info");
			return 0;
		}

		const imap = new ImapClient(config.imapHost, config.imapPort, 30_000);
		let handled = 0;
		try {
			await imap.connect();
			await imap.login(config.user, password);
			await imap.selectInbox();
			const afterUid = state.lastSeenImapUid || 0;
			const uids = await imap.searchNewUids(afterUid);
			for (const uid of uids.sort((a, b) => a - b)) {
				state.lastSeenImapUid = Math.max(state.lastSeenImapUid || 0, uid);
				if (state.processedReplyUids.includes(uid)) continue;
				const raw = await imap.fetchMessage(uid);
				if (!raw) continue;
				const email = parseEmail(raw);
				if (!fromAllowed(config, email.from)) continue;
				const token = extractReplyToken(email.subject, email.text);
				if (!token && config.requireReplyToken) continue;
				const knownToken = token ? state.outgoingTokens.find((entry) => entry.token === token) : undefined;
				if (config.requireReplyToken && !knownToken) continue;
				const replyText = cleanReplyText(email.text, token);
				if (!replyText) continue;

				await handleIncomingReply(pi, email, replyText, token, knownToken);
				state.processedReplyUids.push(uid);
				handled++;
			}
			await saveState(state);
		} finally {
			await imap.logout().catch(() => undefined);
		}

		if (showNotifications) safeNotify(`Email replies processed: ${handled}`, "info");
		return handled;
	} catch (error) {
		if (showNotifications) safeNotify(`Email poll failed: ${(error as Error).message}`, "error");
		return 0;
	} finally {
		pollInFlight = false;
	}
}

async function handleIncomingReply(
	pi: ExtensionAPI,
	email: ParsedEmail,
	replyText: string,
	token?: string,
	knownToken?: EmailToken,
): Promise<void> {
	if (token) {
		const pending = pendingApprovals.get(token);
		if (pending) {
			if (isDenialText(replyText)) {
				pending.resolve(false);
				clearTimeout(pending.timer);
				pendingApprovals.delete(token);
				safeNotify("Email approval denied", "warning");
				return;
			}
			if (isApprovalText(replyText)) {
				pending.resolve(true);
				clearTimeout(pending.timer);
				pendingApprovals.delete(token);
				safeNotify("Email approval received", "info");
				return;
			}
		}
	}

	const sender = extractEmails(email.from)[0] || email.from;
	const approval = isApprovalText(replyText);
	const tokenLine = token ? `Token: pi:${token}` : "Token: none";
	const contextLine = knownToken ? `Bezug: ${knownToken.subject}` : "Bezug: unbekannt";
	const userMessage = approval
		? `Freigabe per Email erhalten von ${sender}.\n${tokenLine}\n${contextLine}\n\nAntwort:\n${replyText}\n\nBitte mit geplanter Aktion fortfahren.`
		: `Neue Email-Antwort von ${sender}.\n${tokenLine}\n${contextLine}\n\nAuftrag/Antwort:\n${replyText}`;

	if (safeIsIdle()) {
		pi.sendUserMessage(userMessage);
	} else {
		pi.sendUserMessage(userMessage, { deliverAs: "followUp" });
	}
	safeNotify(`Email reply queued from ${sender}`, "info");
}

async function handleApprovalRequest(request: ApprovalRequest): Promise<void> {
	const ctx = currentCtx;
	if (!ctx) return;
	const cwd = request.cwd || ctx.cwd;
	const config = await loadConfig();
	if (!config.enabled || !sessionEmailActive) return;

	request.ack?.();
	try {
		const timeoutMs = request.timeoutMs || config.approvalTimeoutMinutes * 60 * 1000;
		const { subject, body, token } = buildEmail(config, cwd, [], request.body, "approval", formatContextUsage(ctx));
		const timer = setTimeout(() => {
			pendingApprovals.delete(token);
			request.resolve?.(false);
			safeNotify(`Email approval timed out: ${request.title}`, "warning");
		}, timeoutMs);

		pendingApprovals.set(token, {
			resolve: (approved) => request.resolve?.(approved),
			timer,
			title: request.title,
			body: request.body,
		});

		await queueEmail(config, subject, body);
		await recordOutgoingToken(config, {
			token,
			createdAt: new Date().toISOString(),
			kind: "approval",
			subject,
			cwd,
		});
		safeNotify(`Email approval requested: ${request.title}`, "info");
	} catch (error) {
		request.resolve?.(false);
		safeNotify(`Email approval request failed: ${(error as Error).message}`, "error");
	}
}

function startPoller(pi: ExtensionAPI, intervalSeconds = DEFAULT_CONFIG.pollIntervalSeconds): void {
	if (pollTimer) return;
	void pollReplies(pi, false);
	pollTimer = setInterval(() => void pollReplies(pi, false), Math.max(15, intervalSeconds) * 1000);
	(pollTimer as unknown as { unref?: () => void }).unref?.();
}

function stopPoller(): void {
	if (pollTimer) clearInterval(pollTimer);
	pollTimer = undefined;
	for (const [token, pending] of pendingApprovals) {
		clearTimeout(pending.timer);
		pending.resolve(false);
		pendingApprovals.delete(token);
	}
}

async function refreshEmailMode(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	currentCtx = ctx;
	const config = await loadConfig();
	const globalState = await loadGlobalState();
	lastGlobalStateSignature = globalStateSignature(globalState);
	globalEmailActive = Boolean(globalState.active);

	const nextActive = Boolean(config.enabled && (localSessionEmailActive || globalEmailActive));
	if (sessionEmailActive === nextActive) return;

	sessionEmailActive = nextActive;
	if (sessionEmailActive && ctx.hasUI) startPoller(pi, config.pollIntervalSeconds);
	else if (!sessionEmailActive) stopPoller();
}

function emailModeSummary(config: EmailNotifyConfig): string {
	return [
		`Email notify: ${sessionEmailActive ? "active" : "inactive"}`,
		`local: ${localSessionEmailActive ? "on" : "off"}`,
		`global: ${globalEmailActive ? "on" : "off"}`,
		`polling: ${pollTimer ? "on" : "off"}`,
		`to: ${config.to}`,
	].join("; ");
}

function startGlobalModeWatcher(pi: ExtensionAPI, ctx: ExtensionContext): void {
	stopGlobalModeWatcher();
	void refreshEmailMode(pi, ctx);
	globalModeTimer = setInterval(() => void refreshEmailMode(pi, ctx), GLOBAL_STATE_POLL_MS);
	(globalModeTimer as unknown as { unref?: () => void }).unref?.();
}

function stopGlobalModeWatcher(): void {
	if (globalModeTimer) clearInterval(globalModeTimer);
	globalModeTimer = undefined;
}

export default function emailNotifyExtension(pi: ExtensionAPI) {
	pi.events.on("email-notify:approval-request", (data) => {
		void handleApprovalRequest(data as ApprovalRequest);
	});

	pi.registerCommand("email-start", {
		description: "Enable email notify for this Pi session",
		handler: async (_args, ctx) => {
			const config = await loadConfig();
			if (!config.enabled) {
				ctx.ui.notify("Email notify disabled in config", "warning");
				return;
			}
			localSessionEmailActive = true;
			await refreshEmailMode(pi, ctx);
			ctx.ui.notify(emailModeSummary(config), "info");
		},
	});

	pi.registerCommand("email-stop", {
		description: "Disable email notify for this Pi session. Global screenoff mode may keep it active.",
		handler: async (_args, ctx) => {
			localSessionEmailActive = false;
			await refreshEmailMode(pi, ctx);
			const config = await loadConfig();
			ctx.ui.notify(emailModeSummary(config), sessionEmailActive ? "warning" : "info");
		},
	});

	pi.registerCommand("email-global-start", {
		description: "Enable email notify globally for all active Pi sessions.",
		handler: async (_args, ctx) => {
			await saveGlobalState(true, "manual-global-start");
			await refreshEmailMode(pi, ctx);
			const config = await loadConfig();
			ctx.ui.notify(emailModeSummary(config), "info");
		},
	});

	pi.registerCommand("email-global-stop", {
		description: "Disable global email notify for all active Pi sessions.",
		handler: async (_args, ctx) => {
			await saveGlobalState(false, "manual-global-stop");
			await refreshEmailMode(pi, ctx);
			const config = await loadConfig();
			ctx.ui.notify(emailModeSummary(config), "info");
		},
	});

	pi.registerCommand("email-status", {
		description: "Show email notify status for this Pi session",
		handler: async (_args, ctx) => {
			await refreshEmailMode(pi, ctx);
			const config = await loadConfig();
			ctx.ui.notify(emailModeSummary(config), config.enabled ? "info" : "warning");
		},
	});

	pi.registerCommand("email-test", {
		description: "Send test email via GMX SMTP notifier",
		handler: async (_args, ctx) => {
			try {
				const config = await loadConfig();
				if (!config.enabled) {
					ctx.ui.notify("Email notify disabled", "warning");
					return;
				}
				const result = await sendTrackedEmail(config, ctx.cwd, [], "Testmail von Pi. SMTP funktioniert. Antworten auf diese Mail wird von Pi gelesen.", "test", formatContextUsage(ctx));
				ctx.ui.notify(`Test email sent to ${config.to} (${result.token})`, "info");
			} catch (error) {
				ctx.ui.notify(`Email test failed: ${(error as Error).message}`, "error");
			}
		},
	});

	pi.registerCommand("email-poll", {
		description: "Poll GMX inbox for Pi reply emails now",
		handler: async (_args, ctx) => {
			currentCtx = ctx;
			await pollReplies(pi, true);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		currentCtx = ctx;
		const config = await loadConfig();
		localSessionEmailActive = Boolean(config.enabled && config.startEnabled);
		await refreshEmailMode(pi, ctx);
		startGlobalModeWatcher(pi, ctx);
	});

	pi.on("session_shutdown", async () => {
		stopGlobalModeWatcher();
		stopPoller();
	});

	pi.on("agent_end", async (event, ctx) => {
		currentCtx = ctx;
		try {
			const config = await loadConfig();
			if (!config.enabled || !sessionEmailActive) return;
			await sendTrackedEmail(config, ctx.cwd, event.messages as unknown[], undefined, "summary", formatContextUsage(ctx));
			missingSecretWarned = false;
		} catch (error) {
			const message = (error as Error).message;
			if (message.includes("SMTP password missing")) {
				if (!missingSecretWarned) {
					ctx.ui.notify(message, "warning");
					missingSecretWarned = true;
				}
				return;
			}
			ctx.ui.notify(`Email notify failed: ${message}`, "error");
		}
	});
}
