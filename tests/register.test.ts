import { expect, test, mock } from 'claude-code/testing'
import type { CommandRunInput, On, SessionStartInput, TurnCompleteInput } from 'claude-code'

const session: SessionStartInput = { surface: null, isInteractive: false, cwd: '/w' }
const run = (args: string): CommandRunInput => ({ command: 'zoo', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
const done = (agentId: string): TurnCompleteInput => ({ answer: 'done', durationMs: 5, isAborted: false, turnId: 't-' + agentId, reason: 'answer', agentId, usage: { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 15000, cache_creation_input_tokens: 0, model: 'claude-haiku-5-5' } })

function world(on: On, o: { placed?: boolean } = {}) {
  mock.store(on, {})
  const opened: string[] = []
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  const up = new Set<string>()
  on('ui.open', ($, e) => { opened.push(e.id); if (o.placed ?? true) up.add(e.id); return { value: { isPlaced: o.placed ?? true } } })
  on('ui.panes', () => ({ value: [...up].map(id => ({ id, title: id, isShown: true, isFocused: false, isPlaced: true })) }))
  on('command.run', () => ({ text: '' }))
  on('ui.close', ($, e) => { up.delete(e.id); return { value: undefined } })
  on('ui.invalidate', () => ({ value: undefined }))
  mock.clock(on)
  let n = 0
  on('agent.spawn', ($, e) => ({ model: 'haiku', agentId: `a${++n}` }))
  on('tool.call', ($, e) => ({ result: 'ok', text: 'ok' }))
  on('turn.complete', ($, e) => ({ text: e.reason === 'answer' ? e.answer : '' }))
  return { opened }
}

const spawn = ($: any, type: string, description: string) =>
  $.agent.spawn({ tool_use_id: 'tu-' + description, prompt: 'do it', description, subagentType: type, provider: { plugin: 'engine', tier: 'core' } })

test('a subagent birth opens the pane and shows up in the list', async ($, on) => {
  const w = world(on)
  await $.session.start(session)
  await spawn($, 'Explore', 'scan the code')
  expect(w.opened).toContain('agent-zoo')
  const r = await $.command.run(run('text'))
  expect(r.text).toContain('🔍 scan the code [Explore] — working')
  expect(r.text).toContain('1 working · 0 sleeping')
})

test('a tool call is recorded on the agent, it sleeps when the turn ends', async ($, on) => {
  world(on)
  await $.session.start(session)
  const s = await $.agent.spawn({ tool_use_id: 'tu1', prompt: 'do it', description: 'read a file', subagentType: 'general-purpose', provider: { plugin: 'engine', tier: 'core' } })
  await $.tool.call({ tool: 'Read', file_path: '/w/src/app.ts', agentId: s.agentId })
  let r = await $.command.run(run('text'))
  expect(r.text).toContain('1 tools, last: Read app.ts')
  await $.turn.complete(done(s.agentId!))
  r = await $.command.run(run('text'))
  expect(r.text).toContain('sleeping 💤')
  expect(r.text).toContain('0 working · 1 sleeping · 1 born so far')
})

test('an unknown type still gets an avatar; the main loop turn.complete puts nobody to sleep', async ($, on) => {
  world(on)
  await $.session.start(session)
  await spawn($, 'my-custom-agent', 'custom job')
  await $.turn.complete({ answer: 'main', durationMs: 1, isAborted: false, turnId: 'main', reason: 'answer' })
  const r = await $.command.run(run('text'))
  expect(r.text).toContain('custom job [my-custom-agent] — working')
  expect(r.text).not.toContain('sleeping 💤')
})

test('/zoo close closes the pane, /zoo reopens it (not a toggle)', async ($, on) => {
  const w = world(on)
  await $.session.start(session)
  let r = await $.command.run(run(''))
  expect(r.text).toContain('pane is open')
  r = await $.command.run(run(''))
  expect(r.text).toContain('pane is open')
  r = await $.command.run(run('close'))
  expect(r.text).toContain('closed')
  expect(w.opened.length).toBe(2)
})

test('a birth while the pane is open does not reopen it; a birth after /zoo close does not open it (person closed it)', async ($, on) => {
  const w = world(on)
  await $.session.start(session)
  await spawn($, 'Explore', 'one')
  await spawn($, 'Plan', 'two')
  expect(w.opened.filter(id => id === 'agent-zoo').length).toBe(1)
  await $.command.run(run('close'))
  await spawn($, 'Explore', 'three')
  expect(w.opened.filter(id => id === 'agent-zoo').length).toBe(1)
  await $.command.run(run(''))
  expect(w.opened.filter(id => id === 'agent-zoo').length).toBe(2)
})

test('token usage is written when the turn ends', async ($, on) => {
  world(on)
  await $.session.start(session)
  const s = await $.agent.spawn({ tool_use_id: 'tu9', prompt: 'do it', description: 'token job', subagentType: 'Explore', provider: { plugin: 'engine', tier: 'core' } })
  await $.turn.complete(done(s.agentId!))
  const r = await $.command.run(run('text'))
  expect(r.text).toContain('tokens ↑1.2k ↓300 ⟳15k')
})

test('/zoo falls back to text when the pane cannot be placed', async ($, on) => {
  world(on, { placed: false })
  await $.session.start(session)
  const r = await $.command.run(run(''))
  expect(r.text).toContain('nobody here')
})

test('a permission request for a subagent tool call shows it as waiting; the state clears when the call ends', async ($, on) => {
  world(on)
  on('classic.PermissionRequest', () => ({}))
  await $.session.start(session)
  const s = await $.agent.spawn({ tool_use_id: 'tu-w', prompt: 'do it', description: 'inspect clones', subagentType: 'general-purpose', provider: { plugin: 'engine', tier: 'core' } })
  await $.classic.PermissionRequest({ hook_event_name: 'PermissionRequest', session_id: 's', transcript_path: '/t', cwd: '/w', agent_id: s.agentId, tool_name: 'Bash', tool_input: { command: 'git status' } })
  let r = await $.command.run(run('text'))
  expect(r.text).toContain('waiting ⏳ for permission (Bash git status)')
  expect(r.text).toContain('1 working (1 waiting)')
  await $.tool.call({ tool: 'Bash', command: 'git status', agentId: s.agentId })
  r = await $.command.run(run('text'))
  expect(r.text).not.toContain('waiting')
  expect(r.text).toContain('1 working · 0 sleeping')
})
