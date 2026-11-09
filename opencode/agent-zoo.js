// agent-zoo publisher for OpenCode (https://opencode.ai): every busy stretch of an OpenCode session, from a prompt until the
// session goes idle, shows up as a critter in the agent-zoo pane of Claude Code.
//
// Install: copy this file into an OpenCode plugin folder, e.g. ~/.config/opencode/plugins/ (or <project>/.opencode/plugins/).
// It writes the same record bin/zoo-run writes, <claude dir>/agent-zoo/external/opencode-<session>.json: running with a
// heartbeat every 10 s while the session works, the tool count and the last tool call or text line, then done when the
// session goes idle or failed on a session error. ZOO_DIR overrides the folder. No network, nothing is executed; a write
// that fails is skipped and never disturbs OpenCode.
import { mkdirSync, writeFileSync, renameSync, unlinkSync, readdirSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'
import { homedir } from 'node:os'

const HEARTBEAT_MS = 10_000
const WEEK_MS = 7 * 24 * 3600 * 1000

/** The folder the agent-zoo mod polls. */
function zooDir() {
  if (process.env.ZOO_DIR) return process.env.ZOO_DIR
  const claude = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
  return join(claude, 'agent-zoo', 'external')
}

/** One line, at most n characters. */
function cut(s, n) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n - 1) + '…' : t
}

/** A tool call squashed into one line: "bash git status", "read foo.ts", "grep pattern". */
function toolLabel(tool, args) {
  const a = args && typeof args === 'object' ? args : {}
  const pick = k => (typeof a[k] === 'string' ? a[k] : '')
  if (pick('filePath')) return `${tool} ${basename(pick('filePath'))}`
  if (pick('command')) return `${tool} ${cut(pick('command'), 60)}`
  if (pick('pattern')) return `${tool} ${cut(pick('pattern'), 40)}`
  if (pick('url')) return `${tool} ${cut(pick('url'), 60)}`
  if (pick('description')) return `${tool} ${cut(pick('description'), 50)}`
  return tool
}

/** OpenCode plugin entry: keeps one run per session and publishes it on every change and on a heartbeat. */
export const AgentZoo = async ({ directory }) => {
  const dir = zooDir()
  const project = basename(directory || process.cwd())
  /** sessionID → run state */
  const runs = new Map()
  /** sessionID → title, which OpenCode generates after the first prompt */
  const titles = new Map()
  try {
    mkdirSync(dir, { recursive: true })
    for (const f of readdirSync(dir)) {
      if (!f.startsWith('opencode-') || !f.endsWith('.json')) continue
      const p = join(dir, f)
      if (Date.now() - statSync(p).mtimeMs > WEEK_MS) unlinkSync(p)
    }
  } catch {}

  /** Atomically replace the session's record; failures are dropped. */
  function write(sessionID, run) {
    const id = `opencode-${String(sessionID).replace(/[^A-Za-z0-9._-]/g, '-').slice(-24)}`
    const now = Date.now()
    const rec = {
      id,
      name: cut(titles.get(sessionID) || `opencode · ${project}`, 80),
      kind: 'opencode',
      model: run.model,
      task: cut(run.task, 300),
      log: '',
      startedAt: run.startedAt,
      updatedAt: now,
      state: run.state,
      last: cut(run.last, 200),
      tools: run.tools,
      pid: process.pid,
    }
    if (run.state !== 'running') rec.endedAt = run.endedAt ?? now
    if (run.exitCode !== undefined) rec.exitCode = run.exitCode
    const file = join(dir, `${id}.json`)
    const tmp = join(dir, `.${id}.${process.pid}.tmp`)
    try {
      writeFileSync(tmp, JSON.stringify(rec) + '\n')
      try { renameSync(tmp, file) } catch { renameSync(tmp, file) }
    } catch {
      try { unlinkSync(tmp) } catch {}
    }
  }

  /** Start a new run (a new critter) for the session. */
  function begin(sessionID, task, model) {
    const old = runs.get(sessionID)
    if (old?.timer) clearInterval(old.timer)
    const run = { startedAt: Date.now(), state: 'running', tools: 0, last: '', task: task || old?.task || '', model: model || old?.model || '' }
    run.timer = setInterval(() => write(sessionID, run), HEARTBEAT_MS)
    run.timer.unref?.()
    runs.set(sessionID, run)
    write(sessionID, run)
    return run
  }

  /** Close the session's run as done or failed. */
  function end(sessionID, state, last, exitCode) {
    const run = runs.get(sessionID)
    if (!run || run.state !== 'running') return
    clearInterval(run.timer)
    run.state = state
    run.endedAt = Date.now()
    if (last) run.last = last
    if (exitCode !== undefined) run.exitCode = exitCode
    write(sessionID, run)
  }

  /** On exit, a run that is still working is closed as failed so its critter does not wait to be dropped as lost. */
  function closeAll() {
    for (const [sid, run] of runs) if (run.state === 'running') end(sid, 'failed', 'opencode exited during the turn', 130)
  }
  process.once('exit', closeAll)

  return {
    'chat.message': async (input, output) => {
      const text = (output?.parts ?? []).filter(p => p?.type === 'text' && !p.synthetic).map(p => p.text).join(' ')
      const model = input?.model?.modelID || ''
      begin(input.sessionID, text, model)
    },
    'chat.params': async (input) => {
      const run = runs.get(input?.sessionID)
      const model = input?.model?.id || input?.model?.modelID
      if (run && model && run.model !== model) { run.model = model; write(input.sessionID, run) }
    },
    'tool.execute.before': async (input, output) => {
      const run = runs.get(input.sessionID) ?? begin(input.sessionID, '', '')
      if (run.state !== 'running') return
      run.tools++
      run.last = toolLabel(input.tool, output?.args)
      write(input.sessionID, run)
    },
    event: async ({ event }) => {
      const p = event?.properties ?? {}
      switch (event?.type) {
        case 'session.updated':
        case 'session.created':
          if (p.info?.id && p.info.title) titles.set(p.info.id, p.info.title)
          break
        case 'message.part.updated': {
          const part = p.part
          if (part?.type !== 'text' || !part.sessionID) break
          const run = runs.get(part.sessionID)
          const line = String(part.text ?? '').split('\n').map(s => s.trim()).filter(Boolean).pop()
          if (run && run.state === 'running' && line) run.last = line
          break
        }
        case 'session.idle':
          end(p.sessionID, 'done')
          break
        case 'session.error': {
          const msg = p.error?.data?.message || p.error?.name || 'session error'
          if (p.sessionID) end(p.sessionID, 'failed', msg, 1)
          break
        }
      }
    },
    dispose: async () => closeAll(),
  }
}
