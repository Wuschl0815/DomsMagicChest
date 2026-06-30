# DomsMagicChest

Public Pi package with my `workon` workflow extension and a sanitized snapshot of my current Pi setup.

## What is inside

- `extensions/workon.ts` — Pi extension for feature worktrees and shipping flow.
- `docs/install.md` — install and usage notes.
- `snapshots/pi-setup-snapshot.json` — sanitized setup snapshot from current machine.
- `docs/security-notes.md` — what was excluded before publishing.

## Install in Pi

```bash
pi install git:github.com/Wuschl0815/DomsMagicChest
```

Then restart Pi or run:

```text
/reload
```

## Commands added by `workon.ts`

```text
/workon
/workonplan
/workonhardplan
/workonloop
/workon-read
/workon-status
/pr
/ship
/shipmerge
/cleanup
/cleanupeasy
```

Tool added:

```text
workonloop_finish_slice
```

## Config

`workon.ts` uses:

- `PI_DEV_ROOT` — base directory for worktrees. Default: `~/Dev`.
- `PI_WORKON_LOOP_MAX_SLICES` — max `/workonloop` slices. Default: `70`.

Worktree root becomes:

```text
$PI_DEV_ROOT/_worktrees
```

## Safety note

This repo intentionally does **not** include raw Pi auth/session state, `mcp.json`, `.env`, package caches, node_modules, private project paths, or secrets.
