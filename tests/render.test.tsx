import { expect, test, mock } from 'claude-code/testing'
import type { On, SessionStartInput } from 'claude-code'

// Verifies the pane really renders: the tree is validated against each surface's element table
// (an invalid prop rejects here; live, the pane would silently stay blank).

const session: SessionStartInput = { surface: null, isInteractive: false, cwd: '/w' }
const PANE = { component: 'Pane' as const, requestId: 'agent-zoo', props: { title: 'Agent Zoo', isFocused: false, bodyColumns: 90, placement: 'dock' as const } }

function world(on: On) {
  mock.store(on, {})
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.close', () => ({ value: undefined }))
  // The engine's invalidate raises ui.render for unmounted sites too: give an empty Box as the baseline.
  on('ui.render', ($, e) => { const { Box } = $.ui.resolve(e); return Box({}) })
  mock.clock(on)
  on('command.run', () => ({ text: '' }))
  let n = 0
  on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: `a${++n}` }))
  on('tool.call', () => ({ result: 'ok', text: 'ok' }))
  on('turn.complete', ($, e) => ({ text: e.reason === 'answer' ? e.answer : '' }))
}

test('an empty zoo renders on every surface', async ($, on) => {
  world(on)
  await $.session.start(session)
  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ plugin: 'agent-zoo', surface, ...PANE })
    expect(await ui.find({ type: 'Text', text: /All quiet here/ })).toBeDefined()
    expect(await ui.find({ key: 'chip-close' })).toBeDefined()
    await ui.unmount()
  }
})

test('zoo with an agent: frame, details button, chip help and token line render', async ($, on) => {
  world(on)
  await $.session.start(session)
  const s = await $.agent.spawn({ tool_use_id: 'tu1', prompt: 'Scan the repo and write a report', description: 'scan the code', subagentType: 'Explore', provider: { plugin: 'engine', tier: 'core' } })
  await $.tool.call({ tool: 'Read', file_path: '/w/src/app.ts', agentId: s.agentId })
  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ plugin: 'agent-zoo', surface, ...PANE })
    expect(await ui.find({ type: 'Text', text: /scan the code/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Read app\.ts/ })).toBeDefined()
    // open details: the task text is visible
    await ui.press({ key: `exp-${s.agentId}` })
    expect(await ui.find({ type: 'Text', text: /Scan the repo and write a report/ })).toBeDefined()
    // open a chip: help text and run button
    await ui.press({ key: 'chip-text' })
    expect(await ui.find({ type: 'Text', text: /plain text/ })).toBeDefined()
    expect(await ui.find({ key: 'run-chip-text' })).toBeDefined()
    // undo the toggles: module state carries over to the next surface
    await ui.press({ key: 'chip-text' })
    await ui.press({ key: `exp-${s.agentId}` })
    expect(await ui.find({ key: 'run-chip-text' })).toBeUndefined()
    await ui.unmount()
  }
  await $.turn.complete({ answer: 'done', durationMs: 5, isAborted: false, turnId: 't1', reason: 'answer', agentId: s.agentId, usage: { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 15000, cache_creation_input_tokens: 0, model: 'claude-haiku-5-5' } })
  const ui = await $.ui.mount({ plugin: 'agent-zoo', surface: 'desktop', ...PANE })
  expect(await ui.find({ type: 'Text', text: /tokens ↑1\.2k ↓300 ⟳15k/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /sleeping/ })).toBeDefined()
  await ui.unmount()
})
