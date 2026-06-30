# DomsMagicChest

Public Pi package with sanitized copies of my active Pi extensions and a public-safe snapshot of my current Pi setup.

## What is inside

- `extensions/` — sanitized public copies of active local Pi extensions.
- `docs/extensions-overview.md` — GitHub-friendly overview of each extension and why it exists.
- `docs/pi-agents-sanitized.md` — public-safe AGENTS-style operating rules snapshot.
- `docs/install.md` — install and usage notes.
- `docs/security-notes.md` — what was excluded and how this repo is scanned.
- `snapshots/pi-setup-snapshot.json` — sanitized setup snapshot from current machine.

## Install in Pi

```bash
pi install git:github.com/Wuschl0815/DomsMagicChest
```

Then restart Pi or run:

```text
/reload
```

## Main command groups

Worktree workflow:

```text
/workon /workonplan /workonhardplan /workonloop /workon-read /workon-status
/pr /ship /shipmerge /cleanup /cleanupeasy
```

Status/recovery helpers:

```text
/alive /codexquota /title /autoretry /hangrecovery
/feature-status /feature-start /feature-use /waybar-pi-status
/session-v2-agents
/email-start /email-stop /email-global-start /email-global-stop /email-status /email-test /email-poll
```

Tool added by `workon.ts`:

```text
workonloop_finish_slice
```

Tool added by `session-v2-subagents.ts`:

```text
session_v2_agents
```

Full list: [`docs/extensions-overview.md`](docs/extensions-overview.md)

## Config highlights

- `PI_DEV_ROOT` — base directory for worktrees. Default: `~/Dev`.
- `PI_WORKON_LOOP_MAX_SLICES` — max `/workonloop` slices. Default: `70`.
- `PI_EMAIL_NOTIFY_*` — optional mail notification settings. Defaults are disabled/placeholders.

Worktree root becomes:

```text
$PI_DEV_ROOT/_worktrees
```

## Safety note

This repo intentionally does **not** include raw Pi auth/session state, `mcp.json`, `.env`, package caches, node_modules, private project paths, or secrets.
