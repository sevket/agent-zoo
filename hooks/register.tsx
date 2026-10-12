import type { Register, EngineInterface } from 'claude-code'

// agent-zoo — a zoo of subagents.
//
// Every `agent.spawn` births a critter with an avatar picked by type and a frame in its own color; while it works,
// a spinner, the tool count and the last tool call show live; when `turn.complete` (with an agentId) arrives it falls
// asleep 💤 and its token usage is written into the frame; after sleepSeconds it vanishes with a "poof".
// The "▾ details" button in the frame opens the task, the last tool calls and the token breakdown.
// Clicking a command chip in the bottom row shows its help text and a "▶ run" button.
//
// Is the pane open: not a flag but `$.ui.panes()` (the flag went stale when the person closed it with X). If the person
// closed it, it is not reopened until this party ends (the zoo empties); a new party reopens it (autoOpen).
// /zoo opens/refreshes, /zoo close closes, /zoo text gives plain text. No external access at all.

type Opts = { autoOpen?: boolean; sleepSeconds?: number }
type Phase = 'working' | 'sleeping' | 'vanishing'
type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number; model: string }
type Critter = {
  id: string
  type: string
  description: string
  prompt: string
  avatar: string
  color: string
  phase: Phase
  bornAt: number
  sleptAt?: number
  durationMs?: number
  tools: number
  last: string
  history: string[]
  usage?: Usage
  model: string
  isExpanded: boolean
  /** the tool call waiting for the person to grant permission (label), cleared when the call ends */
  waiting?: string
}

const PANE = 'agent-zoo'
const COMMAND = 'zoo'
const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const VANISH = ['💤', '✨', '·', ' ']
const VANISH_MS = 1600
const TICK_MS = 350
const HISTORY = 8
const AVATARS: Record<string, string> = {
  Explore: '🔍',
  Plan: '🗺️',
  'general-purpose': '🤖',
  claude: '🤖',
  'claude-code-guide': '📚',
  'web-fetch': '🌐',
  fork: '🪞',
  teammate: '🧑‍🚀',
  'statusline-setup': '🎨',
}
const WILD = ['🦊', '🐙', '🦉', '🐢', '🐝', '🦀', '🐧', '🦋', '🐸', '🦔']
// Each agent takes the next color in turn (theme keys + named colors; all of them render on every surface).
const PALETTE = ['cyan', 'magenta', 'success', 'warning', 'claude', 'merged', 'suggestion', 'permission']
const CHIPS: Array<{ key: string; label: string; help: string; run?: { command: string; args: string } }> = [
  { key: 'chip-close', label: '/zoo close', help: 'Closes the pane. Once this party is over and a new agent is born it reopens by itself (if autoOpen is on).', run: { command: COMMAND, args: 'close' } },
  { key: 'chip-text', label: '/zoo text', help: 'Writes the same info into the chat as plain text; for the CLI and surfaces where the pane cannot be placed.', run: { command: COMMAND, args: 'text' } },
  { key: 'chip-cfg', label: '⚙ settings', help: '/plugin → agent-zoo → configure: autoOpen (open on first birth), sleepSeconds (sleep duration, default 20).' },
]

let opts: Opts = {}
const zoo: Critter[] = []
let born = 0
let paletteAt = 0
let isPaneOpen = false
let closedByPerson = false
let helpKey: string | null = null
let frame = 0
let ticker: { cancel: () => void } | null = null

function avatarOf(type: string) {
  if (AVATARS[type]) return AVATARS[type]
  let h = 0
  for (const ch of type) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return WILD[h % WILD.length]
}
function cut(s: string, n: number) { return s.length > n ? s.slice(0, Math.max(0, n - 1)) + '…' : s }
function base(p: string) { return p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p }
function secs(ms: number) { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${s % 60}s` }
function k(n: number) { return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n) }
function modelShort(m: string) { return m.replace(/^claude-/, '').replace(/-\d{8}$/, '') }
function tokensText(u: Usage) { return `↑${k(u.input)} ↓${k(u.output)} ⟳${k(u.cacheRead)}` }

// Squash a tool call into one line: "Read foo.ts", "Bash git status…", "Grep pattern".
function labelOf(e: Record<string, unknown>): string {
  const tool = String(e.tool ?? '?')
  const pick = (key: string) => (typeof e[key] === 'string' ? (e[key] as string) : '')
  if (pick('file_path')) return `${tool} ${base(pick('file_path'))}`
  if (pick('command')) return `${tool} ${cut(pick('command').replace(/\s+/g, ' '), 40)}`
  if (pick('pattern')) return `${tool} ${cut(pick('pattern'), 30)}`
  if (pick('query')) return `${tool} ${cut(pick('query'), 30)}`
  if (pick('url')) return `${tool} ${cut(pick('url'), 40)}`
  if (pick('description')) return `${tool} ${cut(pick('description'), 30)}`
  return tool
}

function sleepMs() { return Math.max(1, opts.sleepSeconds ?? 20) * 1000 }

async function isUp($: EngineInterface): Promise<boolean> {
  try { return (await $.ui.panes()).some(p => p.id === PANE) } catch { return isPaneOpen }
}
async function openPane($: EngineInterface): Promise<boolean> {
  const opened = await $.ui.open({ id: PANE, title: 'Agent Zoo' }).catch(() => null)
  isPaneOpen = Boolean(opened?.isPlaced)
  return isPaneOpen
}

// Animation and timer: every 350 ms while the zoo is populated (even with the pane closed, so sleep→vanish keeps flowing).
function tick($: EngineInterface) {
  frame = (frame + 1) % 1_000_000
  const now = Date.now()
  for (let i = zoo.length - 1; i >= 0; i--) {
    const c = zoo[i]
    if (c.phase === 'sleeping' && c.sleptAt !== undefined && now - c.sleptAt >= sleepMs()) c.phase = 'vanishing'
    else if (c.phase === 'vanishing' && c.sleptAt !== undefined && now - c.sleptAt >= sleepMs() + VANISH_MS) zoo.splice(i, 1)
  }
  if (!zoo.length) { closedByPerson = false; stopTicker() }
  $.ui.invalidate('ui.render')
}
function startTicker($: EngineInterface) {
  if (ticker || !zoo.length) return
  try { ticker = $.clock.every(TICK_MS, () => tick($)) } catch { ticker = null }
}
function stopTicker() { ticker?.cancel(); ticker = null }

function counts() {
  const working = zoo.filter(c => c.phase === 'working').length
  const waiting = zoo.filter(c => c.phase === 'working' && c.waiting !== undefined).length
  return { working, sleeping: zoo.length - working, waiting }
}
function statusLine(): string {
  const { working, sleeping, waiting } = counts()
  return `${working} working${waiting ? ` (${waiting} waiting)` : ''} · ${sleeping} sleeping · ${born} born so far`
}

function zooText(): string {
  if (!zoo.length) return `agent-zoo: nobody here. A subagent shows up here when it is born. (${statusLine()})`
  const now = Date.now()
  const rows = zoo.map(c => {
    const state = c.phase === 'working' ? (c.waiting !== undefined ? `waiting ⏳ for permission (${c.waiting})` : `working ${secs(now - c.bornAt)}`) : c.phase === 'sleeping' ? 'sleeping 💤' : 'poof ✨'
    const tok = c.usage ? `, tokens ${tokensText(c.usage)}` : ''
    return `- ${c.avatar} ${c.description || c.type} [${c.type}] — ${state}, ${c.tools} tools${c.last ? `, last: ${c.last}` : ''}${tok}`
  })
  return [`agent-zoo: ${statusLine()}`, ...rows].join('\n')
}

// Body of the /zoo command: both the command.run hook and the pane chips go through here (chips do not use $.command.run).
async function runZooCommand($: EngineInterface, arg: string): Promise<{ text: string }> {
  if (arg === 'text') return { text: zooText() }
  if (arg === 'close') {
    await $.ui.close({ id: PANE }).catch(() => undefined)
    isPaneOpen = false
    closedByPerson = true
    return { text: 'agent-zoo pane closed.' }
  }
  closedByPerson = false
  if (!(await openPane($))) return { text: zooText() }
  startTicker($)
  return { text: `agent-zoo pane is open. ${statusLine()}. /zoo close closes it, /zoo text prints it as text.` }
}

export const register: Register = (on, options) => {
  opts = (options ?? {}) as Opts

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: COMMAND, description: 'Subagent zoo: who was born, what they are doing, who is sleeping (pane)', argumentHint: '[close|text]' })
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    if (r.deny === undefined && r.agentId) {
      zoo.push({
        id: r.agentId,
        type: e.subagentType,
        description: cut(e.description || '', 60),
        prompt: (e.prompt || '').replace(/\s+/g, ' ').slice(0, 600),
        avatar: avatarOf(e.subagentType),
        color: PALETTE[paletteAt++ % PALETTE.length],
        phase: 'working',
        bornAt: Date.now(),
        tools: 0,
        last: '',
        history: [],
        model: r.model ?? '',
        isExpanded: false,
      })
      born++
      if (opts.autoOpen !== false && !closedByPerson && !(await isUp($))) await openPane($)
      startTicker($)
      $.ui.invalidate('ui.render')
    }
    return r
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    const id = (e as { agentId?: string }).agentId
    if (id) {
      const c = zoo.find(x => x.id === id)
      if (c) {
        c.tools++
        c.last = labelOf(e as unknown as Record<string, unknown>)
        c.history = [...c.history, c.last].slice(-HISTORY)
        $.ui.invalidate('ui.render')
      }
    }
    const r = await next(e)
    // The call ended (granted, denied or finished): it is no longer waiting for permission.
    if (id) {
      const c = zoo.find(x => x.id === id)
      if (c && c.waiting !== undefined) { c.waiting = undefined; $.ui.invalidate('ui.render') }
    }
    return r
  }).catch(($, e, next) => next(e))

  // The engine asks the person for permission for a subagent tool call: mark the critter as waiting ⏳.
  on('classic.PermissionRequest', async ($, e, next) => {
    const id = e.agent_id
    if (id) {
      const c = zoo.find(x => x.id === id)
      if (c) {
        const input = (typeof e.tool_input === 'object' && e.tool_input !== null ? e.tool_input : {}) as Record<string, unknown>
        c.waiting = labelOf({ ...input, tool: e.tool_name })
        $.ui.invalidate('ui.render')
      }
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    const id = (e as { agentId?: string }).agentId
    if (id) {
      const c = zoo.find(x => x.id === id)
      if (c && c.phase === 'working') {
        c.phase = 'sleeping'
        c.sleptAt = Date.now()
        c.durationMs = e.durationMs
        const u = (e as { usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number; model?: string } }).usage
        if (u) c.usage = { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0, model: u.model ?? c.model }
        startTicker($)
        $.ui.invalidate('ui.render')
      }
    }
    return r
  })

  on('command.run', { command: COMMAND }, async ($, e) => runZooCommand($, e.args.trim()))
    .catch(($, e, next) => (next.called ? next(e) : { text: zooText() }))

  // No matcher: a close by the person via X may arrive with id or with requestId (replay-theater checks both too).
  on('ui.close', async ($, e, next) => {
    const r = await next(e)
    const target = (e as { id?: string; requestId?: string })
    if ((target.id === PANE || target.requestId === PANE) && r.deny === undefined) {
      isPaneOpen = false
      if ((e as { origin?: { kind?: string } }).origin?.kind === 'person') closedByPerson = true
    }
    return r
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    isPaneOpen = true
    const { Box, Text, Button } = $.ui.resolve(e)
    const w = Math.max(30, (e.props.bodyColumns ?? 80) - 4)
    const now = Date.now()
    const spin = SPIN[frame % SPIN.length]
    const { working, sleeping, waiting } = counts()
    const toggleHelp = (key: string) => { helpKey = helpKey === key ? null : key; $.ui.invalidate('ui.render') }
    // A chip does NOT call its own command via $.command.run: the engine skips a mod's own hooks on that mod's own call
    // ("no command.run hook answered"). Call the inner function directly and toast the result.
    const runChip = (run: { command: string; args: string }) => { void runZooCommand($, run.args).then(r => $.ui.toast(r.text)).catch(() => undefined) }

    return (
      <Box flexDirection="column" paddingX={1}>
        <Box flexDirection="row" gap={1}>
          <Text bold color="claude">{'🎪 Agent Zoo'}</Text>
          <Text color="success" inverse>{` ${working} working `}</Text>
          {waiting > 0 ? <Text color="warning" inverse>{` ${waiting} waiting `}</Text> : null}
          <Text color="merged" inverse>{` ${sleeping} sleeping `}</Text>
          <Text dimColor>{`${born} born`}</Text>
        </Box>

        {zoo.length === 0 && (
          <Box marginTop={1} flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
            <Text dimColor>🌙 All quiet here. The lights come on when a subagent is born;</Text>
            <Text dimColor>when its work is done it sleeps, then goes poof.</Text>
          </Box>
        )}

        {zoo.map(c => {
          const working = c.phase === 'working'
          const vanishFrame = c.sleptAt !== undefined ? Math.min(VANISH.length - 1, Math.floor(Math.max(0, now - c.sleptAt - sleepMs()) / (VANISH_MS / VANISH.length))) : 0
          const mark = working ? (c.waiting !== undefined ? '⏳' : spin) : c.phase === 'sleeping' ? '💤' : VANISH[vanishFrame]
          const state = working ? (c.waiting !== undefined ? `⏳ waiting for permission · ${cut(c.waiting, 30)}` : `working ${secs(now - c.bornAt)}`) : c.phase === 'sleeping' ? `sleeping ${secs(now - (c.sleptAt ?? now))} · worked ${secs(c.durationMs ?? 0)}` : 'poof ✨'
          return (
            <Box key={`box-${c.id}`} flexDirection="column" marginTop={1} paddingX={1} borderStyle={working ? 'round' : 'single'} borderColor={c.color} borderDimColor={!working} hover={{ borderStyle: 'bold' }}>
              <Text wrap="truncate-end">
                <Text color={c.color} bold>{`${c.avatar} ${mark} `}</Text>
                <Text bold={working} dimColor={!working}>{cut(c.description || c.type, w - 6)}</Text>
              </Text>
              <Text wrap="truncate-end" dimColor={c.waiting === undefined} color={c.waiting !== undefined ? 'warning' : undefined}>{`${c.type}${c.model ? ` · ${modelShort(c.model)}` : ''} · ${state}`}</Text>
              <Text wrap="truncate-end">
                <Text color="success">{`${c.tools} tools`}</Text>
                {c.usage ? '  ' : ''}
                {c.usage && <Text color="warning">{`tokens ${tokensText(c.usage)}`}</Text>}
                {!c.usage && working && <Text dimColor>{'  tokens: when done'}</Text>}
              </Text>
              <Text wrap="truncate-end" color={working ? c.color : undefined} dimColor={!working}>{c.last ? `▸ ${cut(c.last, w - 4)}` : working ? '▸ thinking…' : ''}</Text>
              <Button key={`exp-${c.id}`} plain onPress={() => { c.isExpanded = !c.isExpanded; $.ui.invalidate('ui.render') }}>
                <Text color={c.color}>{c.isExpanded ? '▴ less' : '▾ details'}</Text>
              </Button>
              {c.isExpanded && (
                <Box flexDirection="column" marginTop={1}>
                  <Text color={c.color} bold>task</Text>
                  <Text wrap="wrap">{c.prompt || '(no prompt)'}</Text>
                  <Text color={c.color} bold>{`last tool calls (${c.tools})`}</Text>
                  {c.history.length === 0 && <Text dimColor>  (none yet)</Text>}
                  {c.history.map(line => <Text wrap="truncate-end" dimColor>{`  ${line}`}</Text>)}
                  <Text color={c.color} bold>tokens</Text>
                  {c.usage
                    ? <Text wrap="truncate-end">{`  input ${k(c.usage.input)} · output ${k(c.usage.output)} · cache read ${k(c.usage.cacheRead)} · cache write ${k(c.usage.cacheWrite)} · ${modelShort(c.usage.model)}`}</Text>
                    : <Text dimColor>  written when the turn ends</Text>}
                </Box>
              )}
            </Box>
          )
        })}

        <Box marginTop={1} flexDirection="row" gap={1} flexWrap="wrap">
          {CHIPS.map(chip => (
            <Button key={chip.key} plain onPress={() => toggleHelp(chip.key)}>
              <Text color={helpKey === chip.key ? 'claude' : 'ide'} inverse>{` ${chip.label} `}</Text>
            </Button>
          ))}
        </Box>
        {CHIPS.filter(chip => chip.key === helpKey).map(chip => (
          <Box flexDirection="column" borderStyle="round" borderColor="claude" paddingX={1}>
            <Text wrap="wrap">{chip.help}</Text>
            {chip.run && (
              <Button key={`run-${chip.key}`} plain onPress={() => runChip(chip.run!)}>
                <Text color="success">{`▶ run: ${chip.label}`}</Text>
              </Button>
            )}
          </Box>
        ))}
      </Box>
    )
  })
}
