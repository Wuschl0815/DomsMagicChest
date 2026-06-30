import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { complete, type Message } from "@earendil-works/pi-ai";
import path from "node:path";

const TITLE_PREFIX = "pi";
const MAX_SESSION_NAME = 48;
const MAX_TERMINAL_TITLE = 80;
const MAX_TITLE_PROMPT_CHARS = 1_800;
const TITLE_TIMEOUT_MS = 10_000;
const TITLE_STATUS_KEY = "auto-terminal-title";

type TitlePhase = "idle" | "working" | "request" | "stream" | "tool" | "error";

const TITLE_PHASE_ICONS: Record<TitlePhase, string> = {
  idle: "○",
  working: "⚡",
  request: "🌐",
  stream: "✍",
  tool: "🔧",
  error: "❌",
};

const TITLE_SYSTEM_PROMPT = [
  "Du erzeugst einen kurzen deutschen Titel fuer eine Pi-Terminal-Session.",
  "Nutze nur den initialen User-Prompt als Grundlage.",
  "Antworte nur mit dem Titel, ohne Erklaerung, ohne Markdown, ohne Anfuehrungszeichen.",
  "2 bis 5 Woerter, maximal 48 Zeichen.",
  "Keine URLs, keine Dateipfade, keine Secrets, keine Token, keine personenbezogenen Details.",
  "Technische Akronyme wie API, UI, E2E, TSX beibehalten.",
].join("\n");

const PROJECT_LABELS: Array<[RegExp, string]> = [
  [/^businesshub$/i, "Hub"],
  [/^website$/i, "Website"],
  [/^strategy$/i, "Strategy"],
  [/^photo-creator$/i, "Photo"],
  [/^skills-hub$/i, "Skills"],
];

const STOP_WORDS = new Set([
  "aber",
  "als",
  "am",
  "an",
  "auf",
  "aus",
  "bei",
  "bin",
  "bis",
  "bitte",
  "da",
  "dann",
  "das",
  "dass",
  "dein",
  "deine",
  "dem",
  "den",
  "der",
  "des",
  "die",
  "dir",
  "du",
  "ein",
  "eine",
  "einem",
  "einen",
  "einer",
  "es",
  "für",
  "gern",
  "gerne",
  "hab",
  "habe",
  "hätte",
  "ich",
  "im",
  "in",
  "ist",
  "ja",
  "kann",
  "mal",
  "man",
  "mein",
  "meine",
  "mich",
  "mir",
  "mit",
  "noch",
  "oder",
  "sich",
  "sind",
  "so",
  "und",
  "vom",
  "von",
  "warum",
  "was",
  "wenn",
  "wie",
  "wir",
  "wo",
  "zu",
  "zum",
  "zur",
  "the",
  "and",
  "for",
  "with",
  "from",
  "this",
  "that",
  "you",
  "please",
]);

const CANONICAL_WORDS = new Map<string, string>([
  ["api", "API"],
  ["db", "DB"],
  ["e2e", "E2E"],
  ["json", "JSON"],
  ["md", "MD"],
  ["pi", "Pi"],
  ["rbh", "RBH"],
  ["seo", "SEO"],
  ["sql", "SQL"],
  ["ts", "TS"],
  ["tsx", "TSX"],
  ["ui", "UI"],
  ["url", "URL"],
]);

const SECRET_PATTERNS = [
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\b[A-Za-z0-9+/]{48,}={0,2}\b/g,
  /\b[A-Za-z0-9_-]{40,}\b/g,
];

function projectLabel(cwd: string): string {
  const parts = cwd.split(/[\\/]+/).filter(Boolean).reverse();

  for (const part of parts) {
    const match = PROJECT_LABELS.find(([pattern]) => pattern.test(part));
    if (match) return match[1];
  }

  const folder = path.basename(cwd) || "session";
  return folder.length > 18 ? `${folder.slice(0, 17)}…` : folder;
}

function trimTitle(value: string, max: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > max ? `${normalized.slice(0, max - 1).trim()}…` : normalized;
}

function formatWord(word: string): string {
  const lower = word.toLocaleLowerCase("de-DE");
  const canonical = CANONICAL_WORDS.get(lower);
  if (canonical) return canonical;
  if (/^[A-Z0-9+#.-]{2,}$/.test(word)) return word;
  return `${word.charAt(0).toLocaleUpperCase("de-DE")}${word.slice(1)}`;
}

function cleanInput(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/[A-Za-z]:\\\S+/g, " ")
    .replace(/(?:^|\s)(?:\.{0,2}[\\/])?\S+\.(?:png|jpe?g|gif|webp|mp4|mov|md|tsx?|jsx?|json|log|txt|csv|sqlite|db)\b/gi, " ")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/pi-clipboard-[0-9a-f-]+/gi, " ")
    .replace(/[^\p{L}\p{N}+#.-]+/gu, " ");
}

function nameFromInput(text: string, imageCount = 0): string {
  const words = cleanInput(text)
    .split(/\s+/)
    .map((word) => word.replace(/^[^\p{L}\p{N}+#]+|[^\p{L}\p{N}+#]+$/gu, ""))
    .filter((word) => word.length >= 2)
    .filter((word) => word.length <= 28)
    .filter((word) => !STOP_WORDS.has(word.toLocaleLowerCase("de-DE")))
    .slice(0, 5)
    .map(formatWord);

  if (words.length > 0) return trimTitle(words.join(" "), MAX_SESSION_NAME);
  if (imageCount > 0) return "Bild-Aufgabe";
  return "Neue Aufgabe";
}

function terminalTitle(ctx: ExtensionContext, sessionName: string | undefined, phase: TitlePhase): string {
  const project = projectLabel(ctx.cwd);
  const name = sessionName?.trim() || "neu";
  const icon = TITLE_PHASE_ICONS[phase];
  return trimTitle(`${icon} ${TITLE_PREFIX} · ${project} · ${name}`, MAX_TERMINAL_TITLE);
}

function isControlInput(text: string): boolean {
  return /^\s*(?:\/[\w:-]+|!)/.test(text);
}

function redactSecrets(text: string): string {
  let redacted = text;
  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, "[Secret]");
  }
  return redacted;
}

function redactTitlePrompt(text: string): string {
  const redacted = redactSecrets(text)
    .replace(/```[\s\S]*?```/g, " [Code] ")
    .replace(/`[^`]*`/g, " [Code] ")
    .replace(/https?:\/\/\S+/gi, " [URL] ")
    .replace(/[A-Za-z]:\\[^\s"'`<>]+/g, " [Pfad] ")
    .replace(/(?:^|\s)(?:\.{1,2}[\\/]|\/)[^\s"'`<>]+/g, " [Pfad] ")
    .replace(/pi-clipboard-[0-9a-f-]+/gi, " [Bild] ");

  return trimTitle(redacted, MAX_TITLE_PROMPT_CHARS);
}

function extractModelTitle(text: string): string {
  const trimmed = text.trim();
  const jsonTitlePrefix = trimmed.match(/["']title["']\s*:\s*["']/i);
  if (jsonTitlePrefix?.index !== undefined) {
    const quote = jsonTitlePrefix[0].slice(-1);
    const start = jsonTitlePrefix.index + jsonTitlePrefix[0].length;
    const end = trimmed.indexOf(quote, start);
    if (end > start) return trimmed.slice(start, end);
  }

  return trimmed
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find(Boolean) ?? "";
}

function normalizeKnownAcronyms(title: string): string {
  return title
    .split(/\s+/)
    .map((word) => {
      const edgePrefix = word.match(/^[^\p{L}\p{N}+#.-]+/u)?.[0] ?? "";
      const edgeSuffix = word.match(/[^\p{L}\p{N}+#.-]+$/u)?.[0] ?? "";
      const core = word.slice(edgePrefix.length, word.length - edgeSuffix.length);
      const canonical = CANONICAL_WORDS.get(core.toLocaleLowerCase("de-DE"));
      return canonical ? `${edgePrefix}${canonical}${edgeSuffix}` : word;
    })
    .join(" ");
}

function sanitizeModelTitle(text: string, fallback: string): string {
  let title = extractModelTitle(text)
    .replace(/^\s*(?:[-*•]|\d+[.)])\s+/u, "")
    .replace(/^(?:kurz-?titel|titel|session-?titel)\s*[:\-–—]\s*/iu, "")
    .replace(/[“”„"'`]/g, "")
    .replace(/[\\/:*?<>|]+/g, " ")
    .replace(/[.!?:;,]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();

  title = redactSecrets(title);
  if (/\[(?:Secret|Pfad|URL|Code)\]/i.test(title)) return fallback;

  const words = title.split(/\s+/).filter(Boolean);
  if (words.length > 6) title = words.slice(0, 6).join(" ");

  title = normalizeKnownAcronyms(title);
  title = trimTitle(title, MAX_SESSION_NAME);

  return title.length >= 2 ? title : fallback;
}

function hasPriorUserMessage(ctx: ExtensionContext): boolean {
  try {
    return ctx.sessionManager.getBranch().some((entry) => {
      if (entry.type !== "message") return false;
      return entry.message.role === "user";
    });
  } catch {
    return false;
  }
}

async function nameFromInitialPrompt(ctx: ExtensionContext, text: string, imageCount: number): Promise<string> {
  const fallback = nameFromInput(text, imageCount);
  const model = ctx.model;
  if (!model) return fallback;

  const prompt = redactTitlePrompt(text);
  const userMessage = [
    `Projekt: ${projectLabel(ctx.cwd)}`,
    `Angehaengte Bilder: ${imageCount}`,
    "Initialer Prompt:",
    prompt || "(kein Text)",
  ].join("\n");

  const messages: Message[] = [
    {
      role: "user",
      content: userMessage,
      timestamp: Date.now(),
    },
  ];

  try {
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) return fallback;

    const response = await complete(
      model,
      {
        systemPrompt: TITLE_SYSTEM_PROMPT,
        messages,
      },
      {
        apiKey: auth.apiKey,
        headers: auth.headers,
        maxTokens: 32,
        temperature: 0,
        timeoutMs: TITLE_TIMEOUT_MS,
        maxRetries: 0,
      },
    );

    if (response.stopReason === "aborted" || response.stopReason === "error") return fallback;

    const rawTitle = response.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join(" ");

    return sanitizeModelTitle(rawTitle, fallback);
  } catch {
    return fallback;
  }
}

export default function (pi: ExtensionAPI) {
  let titleLocked = false;
  let titleInFlight = false;
  let titlePhase: TitlePhase = "idle";
  let lastRenderedTitle: string | undefined;
  const activeToolIds = new Set<string>();

  function renderTerminalTitle(ctx: ExtensionContext, sessionName = pi.getSessionName() ?? undefined): void {
    const title = terminalTitle(ctx, sessionName, titlePhase);
    if (title === lastRenderedTitle) return;

    lastRenderedTitle = title;
    ctx.ui.setTitle(title);
  }

  function setTitlePhase(ctx: ExtensionContext, phase: TitlePhase): void {
    titlePhase = phase;
    renderTerminalTitle(ctx);
  }

  pi.on("session_start", async (_event, ctx) => {
    titleInFlight = false;
    titlePhase = "idle";
    lastRenderedTitle = undefined;
    activeToolIds.clear();
    titleLocked = Boolean(pi.getSessionName()) || hasPriorUserMessage(ctx);
    renderTerminalTitle(ctx, pi.getSessionName());
  });

  pi.on("input", async (event, ctx) => {
    const nameCommand = event.text.match(/^\s*\/name(?:\s+(.+))?$/i);
    if (nameCommand) {
      const name = trimTitle(nameCommand[1]?.trim() ?? "", MAX_SESSION_NAME);
      if (name) {
        pi.setSessionName(name);
        renderTerminalTitle(ctx, name);
        titleLocked = true;
        ctx.ui.notify(`Session named: ${name}`, "info");
      } else {
        const current = pi.getSessionName();
        ctx.ui.notify(current ? `Session: ${current}` : "No session name set", "info");
      }
      return { action: "handled" as const };
    }

    if (event.source === "extension" || isControlInput(event.text)) {
      return { action: "continue" as const };
    }

    activeToolIds.clear();
    setTitlePhase(ctx, "working");

    if (pi.getSessionName()) {
      titleLocked = true;
      return { action: "continue" as const };
    }

    if (titleLocked || titleInFlight) {
      return { action: "continue" as const };
    }

    if (hasPriorUserMessage(ctx)) {
      titleLocked = true;
      return { action: "continue" as const };
    }

    titleInFlight = true;
    ctx.ui.setStatus(TITLE_STATUS_KEY, "Titel…");
    try {
      const name = await nameFromInitialPrompt(ctx, event.text, event.images?.length ?? 0);
      pi.setSessionName(name);
      renderTerminalTitle(ctx, name);
      titleLocked = true;
    } finally {
      titleInFlight = false;
      ctx.ui.setStatus(TITLE_STATUS_KEY, undefined);
    }

    return { action: "continue" as const };
  });

  pi.on("agent_start", async (_event, ctx) => {
    activeToolIds.clear();
    setTitlePhase(ctx, "working");
  });

  pi.on("turn_start", async (_event, ctx) => {
    setTitlePhase(ctx, "working");
  });

  pi.on("before_provider_request", async (_event, ctx) => {
    setTitlePhase(ctx, "request");
  });

  pi.on("after_provider_response", async (_event, ctx) => {
    setTitlePhase(ctx, "working");
  });

  pi.on("message_update", async (_event, ctx) => {
    setTitlePhase(ctx, "stream");
  });

  pi.on("tool_execution_start", async (event, ctx) => {
    activeToolIds.add(event.toolCallId);
    setTitlePhase(ctx, "tool");
  });

  pi.on("tool_execution_update", async (event, ctx) => {
    activeToolIds.add(event.toolCallId);
    setTitlePhase(ctx, "tool");
  });

  pi.on("tool_execution_end", async (event, ctx) => {
    activeToolIds.delete(event.toolCallId);
    if (activeToolIds.size > 0) {
      setTitlePhase(ctx, "tool");
    } else {
      setTitlePhase(ctx, event.isError ? "error" : "working");
    }
  });

  pi.on("agent_end", async (_event, ctx) => {
    activeToolIds.clear();
    setTitlePhase(ctx, "idle");
  });

  pi.registerCommand("title", {
    description: "Terminal- und Session-Titel setzen (usage: /title Neuer Titel)",
    handler: async (args, ctx) => {
      const name = trimTitle(args.trim(), MAX_SESSION_NAME);

      if (!name) {
        const current = pi.getSessionName();
        ctx.ui.notify(current ? `Titel: ${current}` : "Noch kein Session-Titel", "info");
        return;
      }

      pi.setSessionName(name);
      renderTerminalTitle(ctx, name);
      titleLocked = true;
      ctx.ui.notify(`Titel gesetzt: ${name}`, "info");
    },
  });
}
