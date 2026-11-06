import { expect, test, mock } from 'claude-code/testing'
import type { CommandRunInput, On, SessionStartInput } from 'claude-code'

// External runs (bin/zoo-run records in <claude dir>/agent-zoo/external) and the lost-critter rule.

const session: SessionStartInput = { surface: null, isInteractive: false, cwd: '/w' }
const run = (args: string): CommandRunInput => ({ command: 'zoo', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
const DIR = '/h/.claude/agent-zoo/external'
const H = 3600_000

type File = { text: string; mtimeMs: number }

function world(on: On, o: { placed?: boolean } = {}) {
  mock.store(on, {})
  mock.env(on, { HOME: '/h' })
  const opened: string[] = []
  const files = new Map<string, File>()
  let stamp = 1000
  const put = (name: string, body: unknown) => files.set(`${DIR}/${name}`, { text: typeof body === 'string' ? body : JSON.stringify(body), mtimeMs: ++stamp })
  // The engine hands fs hooks native paths (C:\h\...): compare on the posix spelling.
  const norm = (p: string) => p.replace(/^[A-Za-z]:/, '').replace(/\\/g, '/')
  on('fs.exists', (_$, e) => ({ value: [...files.keys()].some(p => p.startsWith(norm(e.path) + '/')) }))
  on('fs.list', (_$, e) => ({ value: [...files].filter(([p]) => p.startsWith(norm(e.path) + '/')).map(([p, f]) => ({ name: p.slice(norm(e.path).length + 1), kind: 'file' as const, size: f.text.length, mtimeMs: f.mtimeMs, isLink: false })) }))
  on('fs.read', (_$, e) => { const f = files.get(norm(e.path)); if (!f) throw new Error('ENOENT'); return { value: f.text } })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  const up = new Set<string>()
  on('ui.open', (_$, e) => { opened.push(e.id); if (o.placed ?? true) up.add(e.id); return { value: { isPlaced: o.placed ?? true } } })
  on('ui.panes', () => ({ value: [...up].map(id => ({ id, title: id, isShown: true, isFocused: false, isPlaced: true })) }))
  on('command.run', () => ({ text: '' }))
  on('ui.close', (_$, e) => { up.delete(e.id); return { value: undefined } })
  on('ui.invalidate', () => ({ value: undefined }))
  const clock = mock.clock(on)
  let n = 0
  on('agent.spawn', () => ({ model: 'haiku', agentId: `a${++n}` }))
  on('tool.call', () => ({ result: 'ok', text: 'ok' }))
  on('turn.complete', (_$, e) => ({ text: e.reason === 'answer' ? e.answer : '' }))
  return { opened, files, put, clock, up }
}

const rec = (o: Record<string, unknown> = {}) => ({
  id: 'surface-ai', name: 'surface-ai', kind: 'agy', model: 'gemini-4-argon-high', task: 'Wire the surface AI page',
  startedAt: Date.now() - 5000, updatedAt: Date.now(), state: 'running', last: 'pnpm lint running', tools: 7, ...o,
})

const wait = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

test('a running external record is born as a critter: avatar by kind, last line, tools, pane opens', async ($, on) => {
  const w = world(on)
  w.put('surface-ai.json', rec())
  await $.session.start(session)
  await $.command.run(run('text')) // a scan happens on every /zoo
  const r = await $.command.run(run('text'))
  expect(r.text).toContain('🛸 surface-ai [agy] — working')
  expect(r.text).toContain('7 tools')
  expect(r.text).toContain('last: pnpm lint running')
  expect(r.text).toContain('1 working · 0 sleeping · 1 born so far')
  expect(w.opened).toContain('agent-zoo') // autoOpen applies to external births too
})

test('the record is picked up by the poller without any command (pane closed: every 4th poll)', async ($, on) => {
  const w = world(on)
  await $.session.start(session)
  await w.clock.settle()
  w.put('late.json', rec({ id: 'late', name: 'late bloomer' }))
  expect(w.opened.length).toBe(0)
  await w.clock.advance(3000 * 4)
  expect(w.opened).toContain('agent-zoo')
  const r = await $.command.run(run('text'))
  expect(r.text).toContain('late bloomer')
})

test('updates flow into the critter; a finished record puts it to sleep, a failed one shows the exit code', async ($, on) => {
  const w = world(on)
  w.put('a.json', rec({ id: 'a', name: 'job-a' }))
  w.put('b.json', rec({ id: 'b', name: 'job-b', kind: 'build' }))
  await $.session.start(session)
  let r = await $.command.run(run('text'))
  expect(r.text).toContain('2 working')
  w.put('a.json', rec({ id: 'a', name: 'job-a', last: 'tests green', tools: 12, state: 'done', endedAt: Date.now(), startedAt: JSON.parse(w.files.get(`${DIR}/a.json`)!.text).startedAt }))
  w.put('b.json', rec({ id: 'b', name: 'job-b', kind: 'build', state: 'failed', exitCode: 3, endedAt: Date.now(), startedAt: JSON.parse(w.files.get(`${DIR}/b.json`)!.text).startedAt }))
  r = await $.command.run(run('text'))
  expect(r.text).toContain('job-a [agy] — done ✓')
  expect(r.text).toContain('12 tools, last: tests green')
  expect(r.text).toContain('job-b [build] — failed ✗ (exit 3)')
  expect(r.text).toContain('0 working · 2 sleeping · 2 born so far')
})

test('a finished run sleeps, vanishes, and is not born again while its file stays', { options: { sleepSeconds: 0.1 } }, async ($, on) => {
  const w = world(on)
  w.put('a.json', rec({ id: 'a', name: 'job-a' }))
  await $.session.start(session)
  await $.command.run(run('text'))
  const startedAt = JSON.parse(w.files.get(`${DIR}/a.json`)!.text).startedAt
  w.put('a.json', rec({ id: 'a', name: 'job-a', startedAt, state: 'done', endedAt: Date.now() }))
  let r = await $.command.run(run('text'))
  expect(r.text).toContain('1 sleeping')
  await wait(1800) // past sleepSeconds and the poof animation
  await w.clock.advance(350) // sleeping -> vanishing
  await w.clock.advance(350) // vanishing -> gone
  r = await $.command.run(run('text'))
  expect(r.text).toContain('nobody here')
  expect(r.text).toContain('1 born so far')
})

test('a run with the same id but a new startedAt is a new critter', async ($, on) => {
  const w = world(on)
  w.put('a.json', rec({ id: 'a', name: 'job-a', state: 'done', endedAt: Date.now() }))
  await $.session.start(session)
  await $.command.run(run('text'))
  w.put('a.json', rec({ id: 'a', name: 'job-a again', startedAt: Date.now() - 1000 }))
  const r = await $.command.run(run('text'))
  expect(r.text).toContain('job-a again [agy] — working')
  expect(r.text).toContain('2 born so far')
})

test('a deleted record takes its critter with it', async ($, on) => {
  const w = world(on)
  w.put('a.json', rec({ id: 'a', name: 'job-a' }))
  await $.session.start(session)
  let r = await $.command.run(run('text'))
  expect(r.text).toContain('job-a')
  w.files.clear()
  r = await $.command.run(run('text'))
  expect(r.text).toContain('nobody here')
})

test('junk in the folder is ignored; fields are clamped; seconds timestamps are understood', async ($, on) => {
  const w = world(on)
  w.put('broken.json', '{ not json')
  w.put('array.json', '[1,2]')
  w.put('noid.json', { name: 'no id' })
  w.put('notes.txt', 'hello')
  w.put('long.json', rec({ id: 'long', name: 'x'.repeat(500), task: 'y'.repeat(5000), last: 'z'.repeat(5000), tools: -4, state: 'weird', avatar: '🦄🦄🦄' }))
  w.put('secs.json', rec({ id: 'secs', name: 'in seconds', startedAt: Math.floor(Date.now() / 1000) - 5, updatedAt: Math.floor(Date.now() / 1000) }))
  await $.session.start(session)
  const r = await $.command.run(run('text'))
  expect(r.text).toContain('2 working · 0 sleeping · 2 born so far')
  expect(r.text).toContain('🦄🦄 ') // avatar cut to two symbols
  expect(r.text).toContain('0 tools')
  expect(r.text).toContain('in seconds [agy] — working')
  expect(r.text).not.toContain('no id')
  expect(r.text.length).toBeLessThan(1500)
})

test('a record whose updatedAt is older than staleMinutes is never shown and counts as lost', async ($, on) => {
  const w = world(on)
  w.put('dead.json', rec({ id: 'dead', name: 'dead publisher', startedAt: Date.now() - 5 * H, updatedAt: Date.now() - 3 * H }))
  w.put('alive.json', rec({ id: 'alive', name: 'alive' }))
  await $.session.start(session)
  const r = await $.command.run(run('text'))
  expect(r.text).not.toContain('dead publisher')
  expect(r.text).toContain('alive')
  expect(r.text).toContain('1 lost')
})

test('an external run that stops refreshing its record is dropped after staleMinutes', { options: { staleMinutes: 0.01 } }, async ($, on) => {
  const w = world(on)
  await $.session.start(session)
  w.put('a.json', rec({ id: 'a', name: 'fading' }))
  let r = await $.command.run(run('text'))
  expect(r.text).toContain('fading [agy] — working')
  await wait(800) // window is 600 ms
  await w.clock.advance(350)
  r = await $.command.run(run('text'))
  expect(r.text).toContain('nobody here')
  expect(r.text).toContain('1 lost')
})

test('the quiet flag shows at the default window', async ($, on) => {
  const w = world(on)
  w.put('q.json', rec({ id: 'q', name: 'quiet one', updatedAt: Date.now() - 90_000 }))
  await $.session.start(session)
  const r = await $.command.run(run('text'))
  expect(r.text).toContain('quiet one [agy] — working')
  expect(r.text).toContain('quiet 1m')
  expect(r.text).not.toContain('lost')
})

test('a subagent that never reported its end is dropped as lost after staleMinutes', { options: { staleMinutes: 0.005 } }, async ($, on) => {
  const w = world(on)
  await $.session.start(session)
  await $.agent.spawn({ tool_use_id: 'tu1', prompt: 'p', description: 'forgotten', subagentType: 'Explore', provider: { plugin: 'engine', tier: 'core' } })
  await wait(450) // window is 300 ms
  await w.clock.advance(350)
  const r = await $.command.run(run('text'))
  expect(r.text).toContain('nobody here')
  expect(r.text).toContain('0 working · 0 sleeping · 1 born so far · 1 lost')
})

test('a subagent that keeps making tool calls is not lost', { options: { staleMinutes: 0.02 } }, async ($, on) => {
  const w = world(on)
  await $.session.start(session)
  const s = await $.agent.spawn({ tool_use_id: 'tu1', prompt: 'p', description: 'still busy', subagentType: 'Plan', provider: { plugin: 'engine', tier: 'core' } })
  await wait(700) // window is 1.2 s
  await $.tool.call({ tool: 'Read', file_path: '/w/a.ts', agentId: s.agentId })
  await wait(700) // 1.4 s since the spawn, 0.7 s since the last event
  await w.clock.advance(350)
  const r = await $.command.run(run('text'))
  expect(r.text).toContain('still busy')
  expect(r.text).not.toContain('lost')
})

test('staleMinutes 0 switches the rule off', { options: { staleMinutes: 0 } }, async ($, on) => {
  const w = world(on)
  w.put('old.json', rec({ id: 'old', name: 'ancient run', startedAt: Date.now() - 9 * H, updatedAt: Date.now() - 8 * H }))
  await $.session.start(session)
  const r = await $.command.run(run('text'))
  expect(r.text).toContain('ancient run')
  expect(r.text).not.toContain('lost')
})
