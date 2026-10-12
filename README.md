# 🎪 agent-zoo

A live pane for your Claude Code subagents. Every subagent that is born shows up as a critter with its own avatar and colored card: which type it is, which model it runs on, how many tools it has called, its last tool calls, whether it is **waiting for your permission**, and how many tokens it used once it is done. Finished agents fall asleep 💤, then go *poof* ✨.

No configuration, no prompt changes: the pane opens by itself the first time a subagent is spawned.

## Install

Type this at the prompt of a terminal `claude` session (Claude Code ≥ 2.1.287):

```
/plugin install agent-zoo --marketplace sevket/agent-zoo
```

Answer `y` to add the marketplace, pick the **user** scope, keep or change the two options. The pane also draws in the Claude Desktop app (Code tab) once the plugin is installed at the user scope.

## What you see

- **Header**: `N working`, `N waiting` (only when someone waits for permission), `N sleeping`, `N born`.
- **One card per subagent**, bordered in its own color, with an avatar by type (🔍 Explore, 📘 Plan, 🤖 general-purpose, 📚 claude-code-guide, 🌐 web-fetch, …):
  - type · model · state (`working 21s`, `⏳ waiting for permission · Bash git status`, `sleeping 7s · worked 21s`, `poof ✨`)
  - tool count, token usage (`tokens ↑1.2k ↓300 ⟳15k`, written when the turn ends)
  - the last tool call, and under **details** the task description, the prompt and the last tool calls
- **Chips** at the bottom: `/zoo close`, `/zoo text`, `⚙ settings`. Click a chip to read what it does, then run it.

## Commands

| command | effect |
|---|---|
| `/zoo` | opens the pane (not a toggle) |
| `/zoo close` | closes it; it reopens by itself when the next subagent is born after the current batch |
| `/zoo text` | prints the same information as plain text (for the CLI, or when a pane cannot be placed) |

## Options

Set at install time or later via `/plugin` → agent-zoo → configure.

| option | default | meaning |
|---|---|---|
| `autoOpen` | `true` | open the pane when the first subagent is born |
| `sleepSeconds` | `20` | how long a finished agent sleeps before it vanishes |

## How it works

A single hooks module (`hooks/register.tsx`), no network, no processes, no file access:

- `agent.spawn` creates the critter, `tool.call` counts its tools and keeps the last ones, `turn.complete` of the subagent puts it to sleep and records its token usage.
- `classic.PermissionRequest` marks the critter as waiting when the engine asks you for permission on one of its tool calls; the mark clears when the call ends.
- A clock ticks the spinner and the sleep/poof timers while anyone is in the zoo, and stops when the zoo is empty.
- The pane is drawn with `$.ui.open` / `ui.render`; it knows whether it is open through `$.ui.panes()`, so closing it with ✕ is respected.

## Development

```
claude plugin validate .
claude plugin test .
```

Run it from this folder without installing: `claude --plugin-dir .`

## License

MIT
