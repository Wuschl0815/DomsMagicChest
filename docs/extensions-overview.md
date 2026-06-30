# Pi extensions overview

Public-safe snapshot of active local Pi extensions in this package.

This page covers only extensions shipped by DomsMagicChest. Public companion packages such as `context-mode` (`ctx_execute`, `ctx_search`, ...), `pi-subagents`, `pi-web-access`, MCP, LSP, Chrome DevTools, and debug tooling are listed in [`rebuild-public-pi-setup.md`](rebuild-public-pi-setup.md).

| Extension | Commands/tools | Purpose |
|---|---|---|
| `workon.ts` | `/workon`, `/workonplan`, `/workonhardplan`, `/workonloop`, `/workon-read`, `/workon-status`, `/pr`, `/ship`, `/shipmerge`, `/cleanup`, `/cleanupeasy`; tool `workonloop_finish_slice` | Feature-worktree workflow: create isolated worktrees, write handoff docs/env files, run plan/implementation loops, open/update PRs, ship/merge, and cleanup local runtime resources. |
| `session-v2-subagents.ts` | `/session-v2-agents`; tool `session_v2_agents` | Supervisor for Session V2 queue jobs. Starts/runs/stops/collects manifest-owned child Pi jobs with optional terminal log viewers. |
| `auto-retry-inject.ts` | `/autoretry` | Watches retryable provider/network failures and injects a follow-up retry message after a delay. |
| `hang-recovery.ts` | `/hangrecovery` | Detects long-stalled active Pi sessions and starts recovery retry sessions in a new terminal. |
| `alive-status.ts` | `/alive` | Footer/status heartbeat and quiet-mode warnings so long-running Pi sessions show liveness. |
| `auto-terminal-title.ts` | `/title` | Sets terminal title/status icon from session state and initial user prompt. Sanitizes titles to avoid paths, URLs, secrets, and personal data. |
| `codex-quota.ts` | `/codexquota` | Shows OpenAI Codex/ChatGPT usage windows in footer/status by reading authenticated provider token through Pi. Does not store token. |
| `featuretree-status.ts` | `/feature-status`, `/feature-start`, `/feature-use` | Tracks active feature/worktree state in footer/powerline. |
| `waybar-pi-workspace-status.ts` | `/waybar-pi-status` | Writes Pi busy/idle/workspace status for desktop Waybar integration. |
| `omarchy-system-theme.ts` | none | Syncs Pi theme with desktop/system theme file when present. |
| `email-notify.ts` | `/email-start`, `/email-stop`, `/email-global-start`, `/email-global-stop`, `/email-status`, `/email-test`, `/email-poll` | Optional email notification and reply-approval flow. Public copy is disabled by default and requires `PI_EMAIL_NOTIFY_*` env/config values. |
| `subagent/config.json` | config only | Local subagent extension config snapshot: `asyncByDefault: true`. Included as reference; package loading does not replace your user-level subagent config automatically. |

## Install

```bash
pi install git:github.com/Wuschl0815/DomsMagicChest
```

Then run `/reload` or restart Pi.

## Optional environment variables

### `workon.ts`

```bash
export PI_DEV_ROOT="$HOME/Dev"
export PI_WORKON_LOOP_MAX_SLICES=70
```

### `email-notify.ts`

Defaults are safe placeholders and `enabled: false`. Configure via `~/.pi/agent/email-notify.config.json` or env vars:

```bash
export PI_EMAIL_NOTIFY_SMTP_HOST="smtp.example.com"
export PI_EMAIL_NOTIFY_SMTP_PORT="587"
export PI_EMAIL_NOTIFY_IMAP_HOST="imap.example.com"
export PI_EMAIL_NOTIFY_IMAP_PORT="993"
export PI_EMAIL_NOTIFY_FROM="you@example.com"
export PI_EMAIL_NOTIFY_TO="you@example.com"
export PI_EMAIL_NOTIFY_USER="you@example.com"
export PI_EMAIL_NOTIFY_PASSWORD="set-me-from-password-manager"
export PI_EMAIL_NOTIFY_ALLOWED_FROM="you@example.com"
```

Do not commit real mail credentials.
