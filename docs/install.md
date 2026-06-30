# Install

## Install from GitHub

```bash
pi install git:github.com/Wuschl0815/DomsMagicChest
```

Reload Pi:

```text
/reload
```

Or restart Pi.

## What loads

`package.json` exposes all files under `extensions/` as Pi extensions:

```json
{
  "pi": {
    "extensions": ["./extensions"]
  }
}
```

Overview: [`extensions-overview.md`](extensions-overview.md)

## Optional local config

Set custom dev root if your projects are not under `~/Dev`:

```bash
export PI_DEV_ROOT="$HOME/Dev"
```

For permanent config, put it in your shell profile.

Optional loop slice cap:

```bash
export PI_WORKON_LOOP_MAX_SLICES=70
```

## Email notifications

`email-notify.ts` is disabled by default in this public copy. Configure env/config first, then use `/email-start`.

```bash
export PI_EMAIL_NOTIFY_SMTP_HOST="smtp.example.com"
export PI_EMAIL_NOTIFY_IMAP_HOST="imap.example.com"
export PI_EMAIL_NOTIFY_FROM="you@example.com"
export PI_EMAIL_NOTIFY_TO="you@example.com"
export PI_EMAIL_NOTIFY_USER="you@example.com"
export PI_EMAIL_NOTIFY_PASSWORD="set-me-from-password-manager"
```

Do not commit real values.

## Notes

- Extensions run with normal Pi extension privileges.
- `/ship` and `/shipmerge` can push/merge GitHub PRs. Read prompts before using.
- `/cleanup` removes worktrees and related runtime resources for a `workon` task.
- Docker support is optional and controlled by command flags inside the extension.
