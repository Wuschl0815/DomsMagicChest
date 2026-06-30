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

## Notes

- Extension runs with normal Pi extension privileges.
- `/ship` and `/shipmerge` can push/merge GitHub PRs. Read prompts before using.
- `/cleanup` removes worktrees and related runtime resources for a `workon` task.
- Docker support is optional and controlled by command flags inside the extension.
