# Sanitized Pi AGENTS snapshot

Public-safe AGENTS-style rules distilled from current Pi setup. Private vault paths, infrastructure names, personal email addresses, auth files, and project-specific details are intentionally omitted.

## Repository context first

Before working in any repository:

1. Identify target repo root with `git rev-parse --show-toplevel` when inside Git.
2. Read repo context files before planning/editing/running project commands:
   - `AGENTS.md`
   - `AGENTS.MD`
   - `CLAUDE.md`
   - `CLAUDE.MD`
3. Read root README when present.
4. If user switches repo/path, re-check context files and README.
5. Follow repo context unless higher-priority user/system instructions conflict.

## Safety

- Never publish secrets: API keys, OAuth tokens, cookies, passwords, private keys, recovery codes, TOTP seeds, `.env` files.
- Store secrets in a password manager; docs may only say where secret lives, not its value.
- Do not commit Pi auth/session state, MCP config with credentials, package caches, or `node_modules`.
- Prefer sanitized snapshots over raw config dumps for public repos.

## Pi tool routing

- Use MCP gateway for MCP server workflows instead of adding many direct tools.
- Use fast file find/grep tools for repo search before broad shell scans.
- Use LSP tools for semantic code questions when available.
- Use Chrome DevTools for real browser/DOM/session inspection.
- Use Playwright UI tooling for visual review and annotations.

## Planning and subagents

For non-trivial repo work:

1. Gather local context first.
2. Use small task lists for multi-step work.
3. Prefer one writer at a time; parallelize read-only research/review/validation.
4. Use subagents for independent critique, context gathering, implementation review, or alternative-plan checks.
5. Make validation contract explicit before broad implementation.
6. Ask user for decisions when requirements are ambiguous or scope changes.

## Output and command hygiene

- Keep responses concise.
- Bound command output.
- Use context/output processing tools for large logs, tests, diffs, dependency trees, and JSON.
- Use direct shell for small bounded commands and mutating Git/file operations.
- Use precise edits for file changes.
- Avoid giant single-shot generated scripts; split large code into smaller modules/chunks.

## Git workflow preference

- One task = one feature branch/worktree when practical.
- Check branch, dirty state, upstream, and test command before edits.
- Implement, validate, commit, push.
- Merge to main only after verification.

## Public package note

This repo contains public-safe copies of selected Pi extensions and docs. It is not a full `~/.pi/agent` dump.
