import type { Register, EngineInterface, FsEntry } from 'claude-code'

// agent-zoo — a zoo of subagents (and of anything else that runs for a while).
//
// Every `agent.spawn` births a critter with an avatar picked by type and a frame in its own color; while it works,
// a spinner, the tool count and the last tool call show live; when `turn.complete` (with an agentId) arrives it falls
// asleep 💤 and its token usage is written into the frame; after sleepSeconds it vanishes with a "poof".
// The "▾ details" button in the frame opens the task, the last tool calls and the token breakdown.
// Clicking a command chip in the bottom row shows its help text and a "▶ run" button.
//
// External runs: a process that is not a Claude subagent (an `agy` run, a build, a script) can show up as a critter too.
// It publishes a small JSON file, `<claude dir>/agent-zoo/external/<id>.json` (bin/zoo-run writes it for you); the mod
// polls that folder and walks the record through the same working → sleeping → poof life cycle. See the README.
//
// Lost critters: a working critter that has not had a single event for staleMinutes (default 2 h) is dropped — its
// `turn.complete` never came (a subagent that was killed with its session) or its publisher died without a final write.
//
// Is the pane open: not a flag but `$.ui.panes()` (the flag went stale when the person closed it with X). If the person
// closed it, it is not reopened while that party is still working; the next party (a birth while nobody works) reopens it (autoOpen).
// /zoo opens/refreshes, /zoo close closes, /zoo text gives plain text. The only file access is listing and reading the
// external folder.

type Opts = { autoOpen?: boolean; sleepSeconds?: number; staleMinutes?: number; externalDir?: string }
type Phase = 'working' | 'sleeping' | 'vanishing'
type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number; model: string }
type ExtState = 'running' | 'done' | 'failed'
/** One record of the external folder, validated and clamped (see parseExternal). */
type ExtRecord = {
  id: string
  name: string
  kind: string
  model: string
  task: string
  startedAt: number
  updatedAt: number
  state: ExtState
  endedAt?: number
  exitCode?: number
  last: string
  tools?: number
  avatar?: string
  log?: string
}
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
  /** when anything last happened to it (spawn, tool call, permission request / the publisher's updatedAt) */
  lastEventAt: number
  /** present for a run published through the external folder */
  ext?: { key: string; log: string; hasTools: boolean; failed: boolean; exitCode?: number }
}

const PANE = 'agent-zoo'
const COMMAND = 'zoo'
const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const VANISH = ['💤', '✨', '·', ' ']
const VANISH_MS = 1600
const TICK_MS = 350
const POLL_MS = 3000
const IDLE_POLL_EVERY = 4 // with nobody in the zoo and the pane closed, look at the folder only every 4th poll (~12 s)
const QUIET_MS = 60_000 // an external run that has not refreshed its record for this long is shown as "quiet"
const HISTORY = 8
const DEFAULT_STALE_MINUTES = 120
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
  agy: '🛸',
}
const WILD = ['🦊', '🐙', '🦉', '🐢', '🐝', '🦀', '🐧', '🦋', '🐸', '🦔']
// Each agent takes the next color in turn (theme keys + named colors; all of them render on every surface).
const PALETTE = ['cyan', 'magenta', 'success', 'warning', 'claude', 'merged', 'suggestion', 'permission']
const CHIPS: Array<{ key: string; label: string; help: string; run?: { command: string; args: string } }> = [
  { key: 'chip-close', label: '/zoo close', help: 'Closes the pane. Once nobody is working and a new agent is born it reopens by itself (if autoOpen is on).', run: { command: COMMAND, args: 'close' } },
  { key: 'chip-text', label: '/zoo text', help: 'Writes the same info into the chat as plain text; for the CLI and surfaces where the pane cannot be placed.', run: { command: COMMAND, args: 'text' } },
  { key: 'chip-ext', label: '🛸 external', help: 'Runs outside Claude (agy, scripts, builds) show up here when they are started through bin/zoo-run, which keeps a record in <claude dir>/agent-zoo/external/<id>.json. See the README.' },
  { key: 'chip-cfg', label: '⚙ settings', help: '/plugin → agent-zoo → configure: autoOpen (open on first birth), sleepSeconds (sleep duration, default 20), staleMinutes (drop a working critter with no event for this long, default 120), externalDir (override the external folder).' },
]

let opts: Opts = {}
const zoo: Critter[] = []
/** Critters that already went poof, by agent id: a subagent that resumes after that comes back as itself, not reborn. */
const retired = new Map<string, Critter>()
let born = 0
let lost = 0
let paletteAt = 0
let isPaneOpen = false
let closedByPerson = false
let helpKey: string | null = null
let frame = 0
let ticker: { cancel: () => void } | null = null
let poller: { cancel: () => void } | null = null
let pollN = 0
let scanning = 0 // scans queued or running
let scanChain: Promise<void> = Promise.resolve()
let externalPath: string | null | undefined
/** per file name: what was parsed at which mtime/size, so an unchanged file is not read again */
const extCache = new Map<string, { mtimeMs: number; size: number; rec: ExtRecord | null }>()
/** keys (`<id>@<startedAt>`) of external runs that were shown and are gone, or never worth showing: they are not born again */
const extRetired = new Set<string>()

function avatarOf(type: string) {
  if (AVATARS[type]) return AVATARS[type]
  let h = 0
  for (const ch of type) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return WILD[h % WILD.length]
}
function cut(s: string, n: number) { return s.length > n ? s.slice(0, Math.max(0, n - 1)) + '…' : s }
function base(p: string) { return p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p }
function secs(ms: number) { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m${s % 60}s` : `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m` }
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

function sleepMs() { return Math.max(0.01, opts.sleepSeconds ?? 20) * 1000 }
/** 0 (or less) switches the lost-critter rule off */
function staleMs() { return (opts.staleMinutes ?? DEFAULT_STALE_MINUTES) * 60_000 }

// ---- external runs -------------------------------------------------------------------------------------------------

function num(v: unknown): number | undefined { return typeof v === 'number' && Number.isFinite(v) ? v : undefined }
function str(v: unknown, n: number): string { return typeof v === 'string' ? cut(v.replace(/\s+/g, ' ').trim(), n) : '' }
/** a writer that stamps seconds instead of milliseconds is still understood */
function toMs(v: number | undefined): number | undefined { return v === undefined ? undefined : v < 1e11 ? v * 1000 : v }

// A record is untrusted input (any process may write one): every field is type-checked and clamped, nothing is executed.
function parseExternal(text: string, mtimeMs: number): ExtRecord | null {
  let j: unknown
  try { j = JSON.parse(text) } catch { return null }
  if (typeof j !== 'object' || j === null || Array.isArray(j)) return null
  const o = j as Record<string, unknown>
  const id = str(o.id, 80)
  if (!id) return null
  const updatedAt = toMs(num(o.updatedAt)) ?? mtimeMs
  const startedAt = toMs(num(o.startedAt)) ?? updatedAt
  const state: ExtState = o.state === 'done' || o.state === 'failed' ? o.state : 'running'
  const avatar = typeof o.avatar === 'string' ? Array.from(o.avatar.trim()).slice(0, 2).join('') : ''
  const tools = num(o.tools)
  return {
    id,
    name: str(o.name, 80) || id,
    kind: str(o.kind, 24) || 'external',
    model: str(o.model, 60),
    task: str(o.task, 600),
    startedAt,
    updatedAt,
    state,
    endedAt: toMs(num(o.endedAt)),
    exitCode: num(o.exitCode),
    last: str(o.last, 200),
    tools: tools === undefined ? undefined : Math.max(0, Math.floor(tools)),
    avatar: avatar || undefined,
    log: str(o.log, 300) || undefined,
  }
}

async function externalDir($: EngineInterface): Promise<string | null> {
  if (opts.externalDir && opts.externalDir.trim()) return opts.externalDir.trim().replace(/[\\/]+$/, '')
  const cfg = await $.env.get('CLAUDE_CONFIG_DIR')
  if (cfg) return `${cfg.replace(/[\\/]+$/, '')}/agent-zoo/external`
  const home = (await $.env.get('USERPROFILE')) || (await $.env.get('HOME'))
  return home ? `${home.replace(/[\\/]+$/, '')}/.claude/agent-zoo/external` : null
}

function extCritter(r: ExtRecord, now: number): Critter {
  const isDone = r.state !== 'running'
  const key = `${r.id}@${r.startedAt}`
  const end = Math.min(now, r.endedAt ?? r.updatedAt)
  return {
    id: `ext:${key}`,
    type: r.kind,
    description: cut(r.name, 60),
    prompt: r.task,
    avatar: r.avatar ?? avatarOf(r.kind),
    color: PALETTE[paletteAt++ % PALETTE.length],
    phase: isDone ? 'sleeping' : 'working',
    bornAt: Math.min(r.startedAt, now),
    sleptAt: isDone ? end : undefined,
    durationMs: isDone ? Math.max(0, end - r.startedAt) : undefined,
    tools: r.tools ?? 0,
    last: r.last,
    history: r.last ? [r.last] : [],
    model: r.model,
    isExpanded: false,
    lastEventAt: Math.min(r.updatedAt, now),
    ext: { key, log: r.log ?? '', hasTools: r.tools !== undefined, failed: r.state === 'failed', exitCode: r.exitCode },
  }
}

/** Fold the folder's records into the zoo. Returns true when a run was born that is working (the pane may want to open). */
function applyExternal(recs: ExtRecord[]): boolean {
  const now = Date.now()
  const stale = staleMs()
  const live = new Set<string>()
  let newWorking = false
  for (const r of recs) {
    const key = `${r.id}@${r.startedAt}`
    live.add(key)
    if (extRetired.has(key)) continue
    const c = zoo.find(x => x.id === `ext:${key}`)
    const lastEventAt = Math.min(r.updatedAt, now)
    if (!c) {
      if (r.state === 'running') {
        if (stale > 0 && now - lastEventAt >= stale) { extRetired.add(key); lost++; continue } // left behind by a dead publisher
        if (!zoo.some(x => x.phase === 'working')) closedByPerson = false // a new party
        newWorking = true
      } else if (now - Math.min(now, r.endedAt ?? r.updatedAt) >= sleepMs() + VANISH_MS) {
        extRetired.add(key) // long finished before we ever saw it
        continue
      }
      zoo.push(extCritter(r, now))
      born++
      continue
    }
    if (c.phase === 'vanishing' || !c.ext) continue
    c.model = r.model || c.model
    c.description = cut(r.name, 60)
    c.prompt = r.task || c.prompt
    c.tools = r.tools ?? c.tools
    c.ext.hasTools = r.tools !== undefined || c.ext.hasTools
    c.ext.log = r.log ?? c.ext.log
    if (r.last && r.last !== c.last) { c.last = r.last; c.history = [...c.history, r.last].slice(-HISTORY) }
    c.lastEventAt = Math.max(c.lastEventAt, lastEventAt)
    if (c.phase === 'working' && r.state !== 'running') {
      const end = Math.min(now, r.endedAt ?? now)
      c.phase = 'sleeping'
      c.sleptAt = end
      c.durationMs = Math.max(0, end - c.bornAt)
      c.ext.failed = r.state === 'failed'
      c.ext.exitCode = r.exitCode
    }
  }
  // A record that was deleted takes its critter with it; a retired key whose file is gone may be forgotten.
  for (let i = zoo.length - 1; i >= 0; i--) {
    const c = zoo[i]
    if (c.ext && !live.has(c.ext.key)) zoo.splice(i, 1)
  }
  for (const key of extRetired) if (!live.has(key)) extRetired.delete(key)
  return newWorking
}

// Scans run one after another: a /zoo that comes while the start-up scan is under way waits for it and then looks again.
function scanExternal($: EngineInterface): Promise<void> {
  scanning++
  const p = scanChain.then(() => scanOnce($)).finally(() => { scanning-- })
  scanChain = p.catch(() => undefined)
  return p
}
async function scanOnce($: EngineInterface): Promise<void> {
  try {
    if (externalPath === undefined) externalPath = await externalDir($)
    const dir = externalPath
    if (!dir) return
    let entries: FsEntry[] = []
    if (await $.fs.exists(dir)) {
      try { entries = await $.fs.list(dir) } catch { return } // unreadable right now: change nothing
    }
    const names = new Set<string>()
    const recs: ExtRecord[] = []
    for (const en of entries) {
      if (en.kind !== 'file' || !en.name.endsWith('.json')) continue
      names.add(en.name)
      let cached = extCache.get(en.name)
      if (!cached || cached.mtimeMs !== en.mtimeMs || cached.size !== en.size) {
        let rec: ExtRecord | null = null
        try {
          const text = await $.fs.read(`${dir}/${en.name}`)
          if (typeof text === 'string') rec = parseExternal(text, en.mtimeMs)
        } catch { /* half-written or gone: try again at the next poll */ }
        cached = { mtimeMs: en.mtimeMs, size: en.size, rec }
        extCache.set(en.name, cached)
      }
      if (cached.rec) recs.push(cached.rec)
    }
    for (const name of [...extCache.keys()]) if (!names.has(name)) extCache.delete(name)
    const before = zoo.length
    const newWorking = applyExternal(recs)
    if (newWorking && opts.autoOpen !== false && !closedByPerson && !(await isUp($))) await openPane($)
    if (zoo.length || before) { startTicker($); $.ui.invalidate('ui.render') }
  } catch { /* never let a bad folder break the zoo */ }
}

function startPoller($: EngineInterface) {
  if (poller) return
  try {
    poller = $.clock.every(POLL_MS, () => {
      pollN++
      if (!scanning && (zoo.length || isPaneOpen || pollN % IDLE_POLL_EVERY === 0)) void scanExternal($).catch(() => undefined)
    })
  } catch { poller = null }
}

// ---- pane ----------------------------------------------------------------------------------------------------------

async function isUp($: EngineInterface): Promise<boolean> {
  // A pane the engine still lists but no longer shows (closed on the surface) counts as down.
  try { return (await $.ui.panes()).some(p => p.id === PANE && p.isShown !== false) } catch { return isPaneOpen }
}
async function openPane($: EngineInterface): Promise<boolean> {
  const opened = await $.ui.open({ id: PANE, title: 'Agent Zoo' }).catch(() => null)
  isPaneOpen = Boolean(opened?.isPlaced)
  return isPaneOpen
}

// A subagent that stops to wait for its own background work and resumes later reports again under the same
// agentId (another agent.spawn, or tool calls after its turn.complete). That is the same critter waking up, not a
// birth: it goes back to working (out of `retired` if it already went poof), nothing is pushed and `born` does not move.
function wake($: EngineInterface, id: string): Critter | undefined {
  let c = zoo.find(x => x.id === id)
  if (!c) {
    const r = retired.get(id)
    if (!r) return undefined
    retired.delete(id)
    c = r
    zoo.push(c)
  }
  if (c.phase !== 'working') {
    c.phase = 'working'
    delete c.sleptAt
    delete c.durationMs
  }
  c.lastEventAt = Date.now()
  startTicker($)
  $.ui.invalidate('ui.render')
  return c
}

// Animation and timer: every 350 ms while the zoo is populated (even with the pane closed, so sleep→vanish keeps flowing).
function tick($: EngineInterface) {
  frame = (frame + 1) % 1_000_000
  const now = Date.now()
  const stale = staleMs()
  for (let i = zoo.length - 1; i >= 0; i--) {
    const c = zoo[i]
    if (c.phase === 'sleeping' && c.sleptAt !== undefined && now - c.sleptAt >= sleepMs()) c.phase = 'vanishing'
    else if (c.phase === 'vanishing' && c.sleptAt !== undefined && now - c.sleptAt >= sleepMs() + VANISH_MS) {
      zoo.splice(i, 1)
      if (c.ext) extRetired.add(c.ext.key) // its record stays in the folder: do not bring it back
      else retired.set(c.id, c)
    } else if (c.phase === 'working' && stale > 0 && now - c.lastEventAt >= stale) {
      // No event for hours: its end was never reported. Drop it instead of showing it as working forever.
      zoo.splice(i, 1)
      lost++
      if (c.ext) extRetired.add(c.ext.key)
      else retired.set(c.id, c)
    }
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
  return `${working} working${waiting ? ` (${waiting} waiting)` : ''} · ${sleeping} sleeping · ${born} born so far${lost ? ` · ${lost} lost` : ''}`
}

// One line about where a critter stands, shared by the pane and the plain text.
function stateOf(c: Critter, now: number): string {
  if (c.phase === 'vanishing') return 'poof ✨'
  if (c.phase === 'working') {
    if (c.waiting !== undefined) return `⏳ waiting for permission · ${cut(c.waiting, 30)}`
    const quiet = c.ext && now - c.lastEventAt >= QUIET_MS ? ` · quiet ${secs(now - c.lastEventAt)}` : ''
    return `working ${secs(now - c.bornAt)}${quiet}`
  }
  const ago = secs(now - (c.sleptAt ?? now))
  if (c.ext?.failed) return `failed ✗${c.ext.exitCode !== undefined ? ` (exit ${c.ext.exitCode})` : ''} ${ago} ago · ran ${secs(c.durationMs ?? 0)}`
  if (c.ext) return `done ✓ ${ago} ago · ran ${secs(c.durationMs ?? 0)}`
  return `sleeping ${ago} · worked ${secs(c.durationMs ?? 0)}`
}

function zooText(): string {
  if (!zoo.length) return `agent-zoo: nobody here. A subagent (or an external run published through zoo-run) shows up here when it is born. (${statusLine()})`
  const now = Date.now()
  const rows = zoo.map(c => {
    const state = c.phase === 'working' ? (c.waiting !== undefined ? `waiting ⏳ for permission (${c.waiting})` : stateOf(c, now)) : c.phase === 'sleeping' ? (c.ext ? stateOf(c, now) : 'sleeping 💤') : 'poof ✨'
    const tok = c.usage ? `, tokens ${tokensText(c.usage)}` : ''
    const tools = c.ext && !c.ext.hasTools ? '' : `, ${c.tools} tools`
    return `- ${c.avatar} ${c.description || c.type} [${c.type}] — ${state}${tools}${c.last ? `, last: ${c.last}` : ''}${tok}`
  })
  return [`agent-zoo: ${statusLine()}`, ...rows].join('\n')
}

// Body of the /zoo command: both the command.run hook and the pane chips go through here (chips do not use $.command.run).
async function runZooCommand($: EngineInterface, arg: string): Promise<{ text: string }> {
  if (arg === 'close') {
    await $.ui.close({ id: PANE }).catch(() => undefined)
    isPaneOpen = false
    closedByPerson = true
    return { text: 'agent-zoo pane closed.' }
  }
  await scanExternal($)
  if (arg === 'text') return { text: zooText() }
  closedByPerson = false
  if (!(await openPane($))) return { text: zooText() }
  startTicker($)
  return { text: `agent-zoo pane is open. ${statusLine()}. /zoo close closes it, /zoo text prints it as text.` }
}

export const register: Register = (on, options) => {
  opts = (options ?? {}) as Opts
  externalPath = undefined

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: COMMAND, description: 'Subagent zoo: who was born, what they are doing, who is sleeping (pane)', argumentHint: '[close|text]' })
    startPoller($)
    void scanExternal($).catch(() => undefined)
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    if (r.deny === undefined && r.agentId) {
      if (wake($, r.agentId)) return r
      // A new party starts when nobody is working any more (sleeping critters do not count): a person who closed
      // the pane during the last party gets it back for the next one.
      if (!zoo.some(c => c.phase === 'working')) closedByPerson = false
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
        lastEventAt: Date.now(),
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
      const c = wake($, id) // a tool call from a sleeping or vanished critter means it resumed
      if (c) {
        c.tools++
        c.last = labelOf(e as unknown as Record<string, unknown>)
        c.history = [...c.history, c.last].slice(-HISTORY)
        c.lastEventAt = Date.now()
        $.ui.invalidate('ui.render')
      }
    }
    const r = await next(e)
    // The call ended (granted, denied or finished): it is no longer waiting for permission.
    if (id) {
      const c = zoo.find(x => x.id === id)
      if (c) {
        c.lastEventAt = Date.now()
        if (c.waiting !== undefined) { c.waiting = undefined; $.ui.invalidate('ui.render') }
      }
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
        c.lastEventAt = Date.now()
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
          <Text dimColor>{`${born} born${lost ? ` · ${lost} lost` : ''}`}</Text>
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
          const mark = working ? (c.waiting !== undefined ? '⏳' : spin) : c.phase === 'sleeping' ? (c.ext?.failed ? '❌' : '💤') : VANISH[vanishFrame]
          const state = stateOf(c, now)
          return (
            <Box key={`box-${c.id}`} flexDirection="column" marginTop={1} paddingX={1} borderStyle={working ? 'round' : 'single'} borderColor={c.color} borderDimColor={!working} hover={{ borderStyle: 'bold' }}>
              <Text wrap="truncate-end">
                <Text color={c.color} bold>{`${c.avatar} ${mark} `}</Text>
                <Text bold={working} dimColor={!working}>{cut(c.description || c.type, w - 6)}</Text>
              </Text>
              <Text wrap="truncate-end" dimColor={c.waiting === undefined} color={c.waiting !== undefined ? 'warning' : undefined}>{`${c.type}${c.model ? ` · ${modelShort(c.model)}` : ''} · ${state}`}</Text>
              <Text wrap="truncate-end">
                {c.ext && !c.ext.hasTools ? <Text dimColor>{'external run'}</Text> : <Text color="success">{`${c.tools} tools`}</Text>}
                {c.usage ? '  ' : ''}
                {c.usage && <Text color="warning">{`tokens ${tokensText(c.usage)}`}</Text>}
                {!c.usage && !c.ext && working && <Text dimColor>{'  tokens: when done'}</Text>}
              </Text>
              <Text wrap="truncate-end" color={working ? c.color : undefined} dimColor={!working}>{c.last ? `▸ ${cut(c.last, w - 4)}` : working ? (c.ext ? '▸ starting…' : '▸ thinking…') : ''}</Text>
              <Button key={`exp-${c.id}`} plain onPress={() => { c.isExpanded = !c.isExpanded; $.ui.invalidate('ui.render') }}>
                <Text color={c.color}>{c.isExpanded ? '▴ less' : '▾ details'}</Text>
              </Button>
              {c.isExpanded && (
                <Box flexDirection="column" marginTop={1}>
                  <Text color={c.color} bold>task</Text>
                  <Text wrap="wrap">{c.prompt || '(no prompt)'}</Text>
                  <Text color={c.color} bold>{c.ext ? 'recent activity' : `last tool calls (${c.tools})`}</Text>
                  {c.history.length === 0 && <Text dimColor>  (none yet)</Text>}
                  {c.history.map(line => <Text wrap="truncate-end" dimColor>{`  ${line}`}</Text>)}
                  {c.ext ? (
                    <Box flexDirection="column">
                      <Text color={c.color} bold>run</Text>
                      <Text wrap="truncate-end">{`  ${c.type}${c.model ? ` · ${c.model}` : ''} · started ${secs(now - c.bornAt)} ago`}</Text>
                      {c.ext.log ? <Text wrap="truncate-end" dimColor>{`  log ${c.ext.log}`}</Text> : null}
                    </Box>
                  ) : (
                    <Box flexDirection="column">
                      <Text color={c.color} bold>tokens</Text>
                      {c.usage
                        ? <Text wrap="truncate-end">{`  input ${k(c.usage.input)} · output ${k(c.usage.output)} · cache read ${k(c.usage.cacheRead)} · cache write ${k(c.usage.cacheWrite)} · ${modelShort(c.usage.model)}`}</Text>
                        : <Text dimColor>  written when the turn ends</Text>}
                    </Box>
                  )}
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
