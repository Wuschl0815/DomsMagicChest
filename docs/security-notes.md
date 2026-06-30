# Security notes

Public snapshot rules used for this repo:

## Included

- `workon.ts` extension source.
- Sanitized Pi package list.
- Sanitized active extension/skill/prompt filenames.
- Sanitized model/subagent override shape.

## Excluded

- `~/.pi/agent/auth*`
- `~/.pi/agent/sessions/`
- `~/.pi/agent/mcp.json`
- `.env` and `.env.*`
- OAuth tokens, API keys, cookies, SMTP/IMAP credentials.
- npm/git package caches and `node_modules`.
- Private project paths, replaced with generic placeholders where needed.

## Sanitization applied to `workon.ts`

- Default dev root changed from local machine path to `~/Dev`.
- Project-specific database names/users/password placeholders replaced with generic `workon` dev-only placeholders.

## Pre-publish checks

Run before pushing changes:

```bash
scripts/scan-secrets.sh
```

Optional if installed:

```bash
gitleaks detect --no-git --source .
```
