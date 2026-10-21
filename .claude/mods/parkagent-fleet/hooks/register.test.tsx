import type { On, SessionUsage } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'

const BAND = {
  plugin: 'parkagent-fleet',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 3,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 3 },
    view: {},
  },
} as const

const PANE = {
  plugin: 'parkagent-fleet',
  component: 'Pane',
  requestId: 'parkagent-fleet',
  props: {
    title: 'ParkAgent fleet',
    isFocused: false,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const START = { cwd: '/repo', surface: 'terminal', isInteractive: true } as const
const TURN = {
  answer: 'done',
  durationMs: 1_000,
  isAborted: false,
  turnId: 't1',
  text: 'done',
  reason: 'answer',
} as const
const FLEET = {
  command: 'fleet',
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: true, columns: 160 },
} as const
const RUNS = [
  { status: 'completed', conclusion: 'failure', name: 'supply-chain', headBranch: 'main', createdAt: '1970-01-01T00:00:00Z' },
  { status: 'completed', conclusion: 'success', name: 'CI', headBranch: 'fix/assistant-errors', createdAt: '1970-01-01T00:00:00Z' },
]

const prompt = (text: string) => ({ text, wait: false, origin: { kind: 'composer' } }) as const
const limits = [
  { kind: 'five_hour', percentUsed: 42 },
  { kind: 'seven_day', percentUsed: 12 },
]
const measure = ($: Engine, percent: number) =>
  $.session.measure({
    context: { window: 200_000, tokens: percent * 2_000, percent },
    rateLimits: limits,
    cost: { usd: 3.5 },
    changed: ['context'],
  })

type World = {
  clock: MockClock
  /** What the session answers; a test changes it to stand for another session. */
  session: { id: string; branch: string; contextPercent: number }
  /** The panes `$.ui.panes()` lists; clearing it is the person closing the pane. */
  panes: Set<string>
  toasts: string[]
  calls: { gh: number; git: number }
  /** The machine's plugin store, shared by every session that loads the mod. */
  store: Map<string, unknown>
}

/** The engine beneath the mod: session figures, a held clock, a store, gh and git. */
function world(on: On, runs: readonly object[] = []): World {
  const w: World = {
    clock: mock.clock(on, { now: 1_000_000 }), // the refresh loop sleeps on it and never wakes unless advanced
    session: { id: 'sess-1', branch: 'feat/audit', contextPercent: 80 },
    panes: new Set(),
    toasts: [],
    calls: { gh: 0, git: 0 },
    store: new Map(),
  }
  const usage = (): SessionUsage => ({
    startedAt: 0,
    context: {
      window: 200_000,
      tokens: w.session.contextPercent * 2_000,
      percent: w.session.contextPercent,
    },
    rateLimits: limits,
    cost: { usd: 3.5 },
  })
  on('store.get', (_, e) => ({ value: w.store.get(e.key) }))
  on('store.set', (_, e) => (w.store.set(e.key, e.value), { value: undefined }))
  on('store.delete', (_, e) => (w.store.delete(e.key), { value: undefined }))
  on('store.keys', () => ({ value: [...w.store.keys()] }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', (_, e) => {
    w.panes.add(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.panes', () => ({
    value: [...w.panes].map(id => ({ id, title: id, isShown: true, isFocused: false, isPlaced: true })),
  }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.toast', (_, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('session.id', () => ({ value: w.session.id }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.turns', () => ({ value: 3 }))
  on('session.usage', () => ({ value: usage() }))
  on('process.run', (_, e) => {
    const isGit = e.argv[0] === 'git'
    if (isGit) w.calls.git += 1
    else w.calls.gh += 1
    return {
      value: {
        exitCode: 0,
        stdout: isGit ? `${w.session.branch}\n` : JSON.stringify(runs),
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('turn.complete', () => ({ text: 'done' }))

  return w
}

/** A prompt and its turn, and the publish the turn leaves running. */
async function turn($: Engine, w: World, text: string) {
  await $.prompt.submit(prompt(text))
  await $.turn.complete(TURN)
  await w.clock.settle()
}

test('after a turn the band shows branch, context, limits and cost, and warns when hot', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await turn($, w, 'audit the executor')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    const row = await ui.find({ type: 'Text', text: /ctx/ })
    expect(row?.text).toContain('feat/audit')
    expect(row?.text).toContain('ctx 80%')
    expect(row?.text).toContain('5h 42%')
    expect(row?.text).toContain('$3.50')
    expect(row?.text).toContain('/compact')
    await ui.unmount()
  }
})

test('under 75% the band does not warn and no toast fires', async ($, on) => {
  const w = world(on)
  w.session.contextPercent = 60
  await $.session.start(START)
  await turn($, w, 'audit the executor')
  await measure($, 74)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    const row = await ui.find({ type: 'Text', text: /ctx/ })
    expect(row?.text).toContain('ctx 74%')
    expect(row?.text).not.toContain('/compact')
    await ui.unmount()
  }
  expect(w.toasts).toEqual([])
})

test('the context toast fires on the crossing only, and again after a drop', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await turn($, w, 'audit the executor') // 80%: crossed
  expect(w.toasts).toHaveLength(1)
  expect(w.toasts[0]).toContain('Context at 80%')

  await measure($, 82)
  await turn($, w, 'keep going')
  expect(w.toasts).toHaveLength(1) // still over: no repeat every turn

  await measure($, 40) // after /compact
  expect(w.toasts).toHaveLength(1)
  await measure($, 78) // over again
  expect(w.toasts).toHaveLength(2)
  expect(w.toasts[1]).toContain('Context at 78%')
})

test('the pane lists this session with its last prompt', async ($, on) => {
  const w = world(on)
  await $.session.start({ ...START, surface: 'desktop' })
  await turn($, w, 'audit the executor')

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /Sessions on this machine/ }))?.text).toContain('(1)')
  expect((await ui.find({ type: 'Text', text: /feat\/audit/ }))?.text).toContain('$3.50')
  expect(await ui.find({ type: 'Text', text: /audit the executor/ })).toBeDefined()
  await ui.unmount()
})

test('/fleet opens the pane with the CI runs gh reported', async ($, on) => {
  const w = world(on, RUNS)
  await $.session.start(START)
  expect((await $.command.run(FLEET)).text).toBe('Fleet pane opened.')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /gh unavailable/ })).toBeUndefined()
    expect((await ui.find({ type: 'Text', text: /supply-chain/ }))?.text).toMatch(/^failure .*main · 17m$/)
    expect((await ui.find({ type: 'Text', text: /fix\/assistant-errors/ }))?.text).toMatch(/^success +CI /)
    await ui.unmount()
  }
  expect(w.calls.gh).toBe(1)
})

test('two sessions publishing to one store both show in the pane, this one first', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  // The store is the machine's: another session's copy of the mod publishes
  // its row there the same way. Here the engine answers as that session first.
  w.session.id = 'sess-2'
  w.session.branch = 'fix/zone-import'
  await turn($, w, 'fix the zone importer')
  w.session.id = 'sess-1'
  w.session.branch = 'feat/audit'
  await turn($, w, 'audit the executor')
  await $.command.run(FLEET)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /Sessions on this machine/ }))?.text).toContain('(2)')
    expect([...w.store.keys()].sort()).toEqual(['fleet:sess-1', 'fleet:sess-2'])
    const rows = await ui.findAll({ type: 'Text', text: / turns · / })
    expect(rows.map(r => r.text.trim().split(' ')[0])).toEqual(['▶', 'fix/zone-import'])
    expect(rows[0]?.text).toContain('feat/audit')
    expect(await ui.find({ type: 'Text', text: /fix the zone importer/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /audit the executor/ })).toBeDefined()
    await ui.unmount()
  }
})

test('gh runs only while the pane is open; otherwise the loop wakes every 5 minutes', async ($, on) => {
  const w = world(on, RUNS)
  await $.session.start(START)
  await w.clock.settle()
  await w.clock.advance(10 * 60_000)
  expect(w.calls.gh).toBe(0)
  expect(w.calls.git).toBe(3) // the start, then two 5-minute heartbeats

  await $.command.run(FLEET)
  expect(w.calls.gh).toBe(1)
  await w.clock.advance(60_000) // the open pane's pace, at once
  expect(w.calls.gh).toBe(2)

  w.panes.clear() // the person closes it
  await w.clock.advance(60_000)
  await w.clock.advance(4 * 60_000)
  expect(w.calls.gh).toBe(2)
})

test('a session that ends takes its row out of the store', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await turn($, w, 'audit the executor')
  expect(w.store.has('fleet:sess-1')).toBe(true)

  await $.session.end({ reason: 'other', sessionId: 'sess-1', resume: { id: 'sess-1' } })
  expect(w.store.has('fleet:sess-1')).toBe(false)
  await turn($, w, 'one more') // a publish after the end doesn't bring it back
  expect(w.store.has('fleet:sess-1')).toBe(false)
})
