# Security notes

Public snapshot rules used for this repo.

## Included

- Sanitized active local Pi extension sources from `~/.pi/agent/extensions/`.
- Sanitized Pi package list.
- Sanitized active extension/skill/prompt filenames.
- Sanitized model/subagent override shape.
- Public-safe AGENTS-style rules: `docs/pi-agents-sanitized.md`.
- GitHub overview docs: `docs/extensions-overview.md`.

## Excluded

- Raw `~/.pi/agent/AGENTS.md`.
- `~/.pi/agent/auth*`.
- `~/.pi/agent/sessions/`.
- `~/.pi/agent/mcp.json`.
- `.env` and `.env.*`.
- OAuth tokens, API keys, cookies, SMTP/IMAP credentials.
- npm/git package caches and `node_modules`.
- Private project paths, infrastructure names, and personal email addresses.

## Sanitization applied

- `workon.ts`: default dev root changed from local machine path to `~/Dev`; project-specific database/user/password placeholders replaced with generic `workon` dev-only placeholders.
- `email-notify.ts`: personal mail addresses removed; defaults disabled and changed to placeholder/example values; real mail setup must come from env/config values.
- `auto-terminal-title.ts`: private project label mappings replaced with generic examples.
- `auto-retry-inject.ts` and `hang-recovery.ts`: package imports normalized to current public Pi package name.
- Raw AGENTS content replaced by a distilled public-safe doc.

## Pre-publish checks

Run before pushing changes:

```bash
scripts/scan-secrets.sh
```

This runs local regex checks and `gitleaks` when available.

Extra manual check used for this repo searches for private home paths, private dev-root paths, personal names, personal mail domains, infrastructure hostnames, and token prefixes.

Expected false positives can include regex patterns that detect secrets, not actual secrets.
