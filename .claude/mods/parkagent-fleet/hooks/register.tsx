import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { CiRun, FleetRow } from '../types'

const PANE = 'parkagent-fleet'
const STORE_PREFIX = 'fleet:'
const STALE_MS = 6 * 60 * 60 * 1000 // a session not heard from in 6 h drops off the pane
const REFRESH_MS = 60_000
const WARN_PERCENT = 75
const CI_LIMIT = 6

const me = atom({ plugin: 'parkagent-fleet', key: 'me' } as const, null)
const tick = atom({ plugin: 'parkagent-fleet', key: 'tick' } as const, 0)
const ci = atom({ plugin: 'parkagent-fleet', key: 'ci' } as const, null)
const isHidden = atom({ plugin: 'parkagent-fleet', key: 'isHidden' } as const, false)

type Engine = Parameters<Parameters<Register>[0]>[2] extends (
  $: infer E,
  ...rest: never[]
) => unknown
  ? E
  : never

const pct = (n: number | null | undefined) => (n == null ? '—' : `${Math.round(n)}%`)
const usd = (n: number | null | undefined) => (n == null ? '—' : `$${n.toFixed(2)}`)

/** Read this session's figures and publish them for the other sessions. */
async function publish($: Engine, lastPrompt: string | undefined): Promise<FleetRow> {
  const [id, cwd, model, turns, usage, now] = await Promise.all([
    $.session.id(),
    $.session.cwd(),
    $.session.model(),
    $.session.turns(),
    $.session.usage(),
    $.clock.now(),
  ])
  const limit = (kind: string) =>
    usage.rateLimits.find(l => l.kind === kind)?.percentUsed ?? null

  let branch = '?'
  try {
    const ran = await $.process.run(['git', '-C', cwd, 'branch', '--show-current'], {
      timeoutMs: 3_000,
    })
    if (ran.exitCode === 0) branch = ran.stdout.trim() || 'detached'
  } catch {
    // no git here; '?' is fine
  }

  const prior = await read($, me)
  const row: FleetRow = {
    sessionId: id,
    cwd,
    branch,
    model,
    contextPercent: usage.context.percent ?? null,
    fiveHourPercent: limit('five_hour'),
    sevenDayPercent: limit('seven_day'),
    costUsd: usage.cost?.usd ?? null,
    turns,
    lastPrompt: (lastPrompt ?? prior?.lastPrompt ?? '').slice(0, 80),
    updatedAt: now,
  }
  await update($, me, () => row)
  await $.store.set(`${STORE_PREFIX}${id}`, row)

  return row
}

/** Every session's last reading, this one first, stale ones dropped. */
async function fleet($: Engine): Promise<FleetRow[]> {
  const [keys, now, mine] = await Promise.all([$.store.keys(), $.clock.now(), read($, me)])
  const rows: FleetRow[] = []
  for (const key of keys) {
    if (!key.startsWith(STORE_PREFIX)) continue
    const row = (await $.store.get(key)) as FleetRow | undefined
    if (!row || typeof row.updatedAt !== 'number') continue
    if (now - row.updatedAt > STALE_MS) {
      await $.store.delete(key)
      continue
    }
    rows.push(row)
  }
  rows.sort((a, b) =>
    a.sessionId === mine?.sessionId ? -1 : b.sessionId === mine?.sessionId ? 1 : b.updatedAt - a.updatedAt,
  )

  return rows
}

/** The repo's latest CI runs through gh; null when gh is absent or signed out. */
async function ciRuns($: Engine): Promise<CiRun[] | null> {
  try {
    const cwd = await $.session.cwd()
    const ran = await $.process.run(
      [
        'gh', 'run', 'list', '--limit', String(CI_LIMIT),
        '--json', 'status,conclusion,name,headBranch,createdAt',
      ],
      { cwd, timeoutMs: 15_000 },
    )
    if (ran.exitCode !== 0) return null
    const now = await $.clock.now()
    const parsed = JSON.parse(ran.stdout) as Array<{
      status: string
      conclusion: string
      name: string
      headBranch: string
      createdAt: string
    }>

    return parsed.map(r => {
      const mins = Math.max(0, Math.round((now - Date.parse(r.createdAt)) / 60_000))
      const age = mins < 60 ? `${mins}m` : mins < 60 * 48 ? `${Math.round(mins / 60)}h` : `${Math.round(mins / 1440)}d`

      return {
        status: r.status,
        conclusion: r.conclusion || r.status,
        name: r.name,
        branch: r.headBranch,
        age,
      }
    })
  } catch {
    return null
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'fleet',
      description: 'Open the ParkAgent fleet pane: every session on this machine, context, spend, CI',
    })
    await $.command.register({
      name: 'fleet-band',
      description: 'Show or hide the context/limits/cost band above the prompt',
    })
    void publish($, undefined)

    // Refresh loop: republish my figures, refetch CI, bump the tick so the pane redraws.
    void (async () => {
      for (;;) {
        try {
          await $.clock.sleep(REFRESH_MS)
        } catch {
          return // the mod was unloaded or reloaded; the new instance starts its own loop
        }
        try {
          await publish($, undefined)
          const runs = await ciRuns($)
          await update($, ci, () => runs)
          await update($, tick, n => n + 1)
        } catch {
          // keep looping; a failed refresh is not worth a toast every minute
        }
      }
    })()

    return next(e)
  })

  on('command.run', { command: 'fleet' }, async $ => {
    const { isPlaced } = await $.ui.open({ id: PANE, title: 'ParkAgent fleet' })
    await update($, ci, () => null)
    await update($, ci, async () => await ciRuns($))

    return {
      text: isPlaced
        ? 'Fleet pane opened.'
        : 'This surface has no room for a pane; the band above the prompt still shows this session.',
    }
  })

  on('command.run', { command: 'fleet-band' }, async $ => {
    const hidden = await read($, isHidden)
    await update($, isHidden, () => !hidden)

    return { text: hidden ? 'Band shown.' : 'Band hidden. /fleet-band shows it again.' }
  })

  on('prompt.submit', async ($, e, next) => {
    void publish($, e.text)

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const row = await publish($, undefined)
    if ((row.contextPercent ?? 0) >= WARN_PERCENT) {
      $.ui.toast(`Context at ${pct(row.contextPercent)} — /compact soon, or hand off to a fresh session.`)
    }
    $.ui.status(`ctx ${pct(row.contextPercent)} · 5h ${pct(row.fiveHourPercent)} · ${usd(row.costUsd)}`)

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const row = await read($, me)
    if (e.props.hasSurvey || row === null || (await read($, isHidden))) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const hot = (row.contextPercent ?? 0) >= WARN_PERCENT

    return (
      <Box>
        <Text color={hot ? 'yellow' : undefined} dimColor={!hot}>
          {row.branch} · ctx {pct(row.contextPercent)} · 5h {pct(row.fiveHourPercent)} · 7d{' '}
          {pct(row.sevenDayPercent)} · {usd(row.costUsd)} · {row.turns} turns
          {hot ? ' · /compact or hand off' : ''}
        </Text>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    await read($, tick) // subscribe to the refresh loop
    const [rows, runs, mine] = await Promise.all([fleet($), read($, ci), read($, me)])

    return (
      <Box flexDirection="column">
        <Text bold>Sessions on this machine ({rows.length})</Text>
        {rows.length === 0 && <Text dimColor>None yet. Each session publishes after its first turn.</Text>}
        {rows.map(r => {
          const isMe = r.sessionId === mine?.sessionId
          const hot = (r.contextPercent ?? 0) >= WARN_PERCENT

          return (
            <Box flexDirection="column">
              <Text bold={isMe} color={hot ? 'yellow' : undefined}>
                {isMe ? '▶ ' : '  '}{r.branch} · ctx {pct(r.contextPercent)} · {usd(r.costUsd)} · {r.turns} turns ·{' '}
                {r.model.replace(/^claude-/, '')}
              </Text>
              {r.lastPrompt !== '' && <Text dimColor>{'    '}{r.lastPrompt}</Text>}
            </Box>
          )
        })}
        <Text> </Text>
        <Text bold>CI (gh run list)</Text>
        {runs === null && <Text dimColor>gh unavailable or still fetching.</Text>}
        {runs?.length === 0 && <Text dimColor>No runs.</Text>}
        {runs?.map(r => (
          <Text
            color={r.conclusion === 'failure' ? 'red' : r.conclusion === 'success' ? 'green' : undefined}
            dimColor={r.conclusion !== 'failure' && r.conclusion !== 'success'}
          >
            {r.conclusion.padEnd(9)} {r.name.padEnd(14).slice(0, 14)} {r.branch.slice(0, 28)} · {r.age}
          </Text>
        ))}
      </Box>
    )
  })
}
