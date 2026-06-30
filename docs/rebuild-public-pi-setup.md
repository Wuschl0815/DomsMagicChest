# Rebuild public Pi setup

Goal: reproduce the generic shape of this Pi setup without personal paths, auth state, sessions, MCP secrets, or private project data.

## 1. Install Pi

Use the current Pi install docs from <https://pi.dev>, or install via npm:

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

Start Pi and log in to your preferred provider:

```text
/login
```

## 2. Install public package stack

These are the public Pi packages used by this setup snapshot.

```bash
pi install npm:context-mode
pi install npm:pi-subagents
pi install npm:pi-web-access
pi install npm:pi-btw
pi install npm:pi-powerline-footer
pi install npm:@plannotator/pi-extension
pi install npm:@juicesharp/rpiv-todo
pi install npm:@juicesharp/rpiv-ask-user-question
pi install npm:@juicesharp/rpiv-i18n
pi install npm:@juicesharp/rpiv-advisor
pi install npm:@juicesharp/rpiv-voice
pi install npm:pi-mcp-adapter
pi install npm:@ff-labs/pi-fff
pi install npm:pi-langsrv
pi install npm:@narumitw/pi-chrome-devtools
pi install npm:pi-debug
```

Optional shell loop:

```bash
for pkg in \
  npm:context-mode \
  npm:pi-subagents \
  npm:pi-web-access \
  npm:pi-btw \
  npm:pi-powerline-footer \
  npm:@plannotator/pi-extension \
  npm:@juicesharp/rpiv-todo \
  npm:@juicesharp/rpiv-ask-user-question \
  npm:@juicesharp/rpiv-i18n \
  npm:@juicesharp/rpiv-advisor \
  npm:@juicesharp/rpiv-voice \
  npm:pi-mcp-adapter \
  npm:@ff-labs/pi-fff \
  npm:pi-langsrv \
  npm:@narumitw/pi-chrome-devtools \
  npm:pi-debug
 do
  pi install "$pkg"
done
```

## 3. Install DomsMagicChest extension collection

```bash
pi install git:github.com/Wuschl0815/DomsMagicChest
```

Reload or restart Pi:

```text
/reload
```

## 4. Public package purpose map

| Package | Main visible tools/commands | Purpose in this setup |
|---|---|---|
| `context-mode` | `ctx_execute`, `ctx_execute_file`, `ctx_index`, `ctx_search`, `ctx_fetch_and_index`, `ctx_batch_execute`, `ctx_stats`, `ctx_doctor`, `ctx_upgrade`, `ctx_purge`, `ctx_insight` | Large-output processing, searchable knowledge base, docs indexing, log/test/diff summarization. |
| `pi-subagents` | `subagent`, builtin agents `scout`, `planner`, `worker`, `reviewer`, `context-builder`, `researcher`, `oracle` | Delegation, review fanout, planning chains, async subagent workflows. |
| `pi-web-access` | `web_search`, `fetch_content`, `get_search_content` | Web research, readable URL/GitHub/YouTube/PDF extraction. |
| `pi-btw` | side-conversation package | Parallel side conversations / background thinking support. |
| `pi-powerline-footer` | footer/status UI | Powerline-style footer used by local status extensions. |
| `@plannotator/pi-extension` | Plannotator commands/tools, e.g. plan annotation/review flows | Visual plan/code review and approval workflows. |
| `@juicesharp/rpiv-todo` | `todo` | Structured task list in Pi sessions. |
| `@juicesharp/rpiv-ask-user-question` | `ask_user_question` | Structured user questions/choice UI. |
| `@juicesharp/rpiv-i18n` | i18n support | Localization support for companion UI packages. |
| `@juicesharp/rpiv-advisor` | `advisor` | Stronger-model review/escalation checkpoint. |
| `@juicesharp/rpiv-voice` | voice support | Voice-related Pi UI integration when configured. |
| `pi-mcp-adapter` | `mcp` | MCP gateway: list/search/describe/call MCP server tools. |
| `@ff-labs/pi-fff` | `fffind`, `ffgrep` | Fast file/path/content search. |
| `pi-langsrv` | `lsp_hover`, `lsp_goto_def`, `lsp_find_refs`, `lsp_rename`, `lsp_diagnostics`, `lsp_symbols`, `lsp_code_actions`, `lsp_format` | Language-server code intelligence. |
| `@narumitw/pi-chrome-devtools` | `chrome_devtools_list_pages`, `chrome_devtools_select_page`, `chrome_devtools_navigate`, `chrome_devtools_evaluate`, `chrome_devtools_screenshot` | Browser/DOM/CDP inspection of local Chrome tabs. |
| `pi-debug` | `debug_start`, `debug_breakpoint`, `debug_continue`, `debug_stack`, `debug_variables`, `debug_evaluate`, `debug_stop` | DAP-style runtime debugging from Pi. |
| `DomsMagicChest` | see [`extensions-overview.md`](extensions-overview.md) | Sanitized local extension collection: worktrees, retry/recovery, status, email notifications, Session V2 queue helper. |

## 5. Local config template

Use [`snapshots/pi-settings.public-template.json`](../snapshots/pi-settings.public-template.json) as a reference, not as a blind drop-in. It intentionally omits auth, sessions, MCP secrets, and personal paths.

Minimum ideas to copy:

- package list from this doc,
- preferred default provider/model,
- subagent override shape,
- `DomsMagicChest` git package source.

## 6. Not included / intentionally personal

This public rebuild does not include:

- raw auth/session state,
- raw MCP server config,
- private shell environment,
- private project paths,
- local package caches,
- private/personal package source snapshots.

The original setup also had local path packages. For a generic rebuild, skip those and use this repo plus the public packages above. If you own equivalent personal packages, install them separately after reviewing their contents.

## 7. Useful optional system tools

These are not Pi packages, but some workflows expect them:

```bash
# choose your distro package manager names
rg       # ripgrep, used by scan scripts and many repo tasks
git
gh       # GitHub CLI, used by /pr and /ship flows
gitleaks # optional secret scanner
node
npm
```

For browser tools, start Chrome with a DevTools endpoint if needed:

```bash
chrome --remote-debugging-port=9222
```
