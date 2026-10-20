import { expect, mock, test } from 'claude-code/testing'

const BAND = {
  plugin: 'parkagent-fleet',
  component: 'AbovePrompt',
  props: { hasSurvey: false },
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

const usage = {
  startedAt: 0,
  context: { window: 200_000, tokens: 160_000, percent: 80 },
  rateLimits: [
    { kind: 'five_hour', percentUsed: 42, source: 'api' },
    { kind: 'seven_day', percentUsed: 12, source: 'api' },
  ],
  cost: { usd: 3.5 },
}

function engine(on: Parameters<Parameters<typeof test>[1]>[1]) {
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.turns', () => ({ value: 3 }))
  on('session.usage', () => ({ value: usage }))
  mock.clock(on, { now: 1_000_000 }) // the refresh loop sleeps on it and never wakes unless advanced
  mock.store(on)
  on('process.run', (_, e) => ({
    value: {
      exitCode: 0,
      stdout: e.argv[0] === 'git' ? 'feat/audit\n' : '[]',
      stderr: '',
      isStdoutTruncated: false,
    },
  }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('turn.complete', () => ({ text: 'done' }))
}

test('after a turn the band shows branch, context, limits and cost, and warns when hot', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ text: 'audit the executor' })
  await $.turn.complete({ text: 'done' })

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

test('the pane lists this session with its last prompt', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'audit the executor' })
  await $.turn.complete({ text: 'done' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /Sessions on this machine/ }))?.text).toContain('(1)')
  expect((await ui.find({ type: 'Text', text: /feat\/audit/ }))?.text).toContain('$3.50')
  expect(await ui.find({ type: 'Text', text: /audit the executor/ })).toBeDefined()
  await ui.unmount()
})
