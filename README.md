# claude-wait-spinner

Claude Code mods that animate the band above the prompt while Claude is working on a turn.
The animation disappears as soon as the turn ends. Terminal only; desktop, VS Code and mobile are left as they are.

| Spinner | What it shows |
| --- | --- |
| [`matrix-rain`](plugins/matrix-rain) | Matrix-style katakana rain in Claude orange, up to 7 rows high, as wide as the prompt |

No settings, no network, no files: each spinner is one hooks module.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install matrix-rain --marketplace gerzha/claude-wait-spinner
```

Answer `y` to add the marketplace, then pick a scope (user scope keeps it in every session).

From a shell:

```sh
claude plugin install matrix-rain --marketplace gerzha/claude-wait-spinner
```

## Develop

Run a spinner from a checkout without installing:

```sh
claude --plugin-dir /path/to/claude-wait-spinner/plugins/matrix-rain
```

or set `CLAUDE_CODE_PLUGIN_DIRS` to that folder in the `env` block of `~/.claude/settings.json`.
Saving `hooks/register.ts` hot-reloads the mod in a running session.
