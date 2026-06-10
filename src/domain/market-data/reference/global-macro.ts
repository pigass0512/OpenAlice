/**
 * Global macro board — cross-country comparison from OECD (keyless).
 *
 * Columns: CPI YoY, short-term interest rate, composite leading indicator.
 * (Real GDP is deliberately absent: the OECD GDP dataset paths 404 since
 * the upstream SDMX reshuffle — tracked in Linear, not silently empty.)
 *
 * Unit normalization happens HERE, not in the UI: OECD returns CPI YoY in
 * percent (3.81) but interest rates as fractions (0.0372) — cells always
 * carry display percent.
 */

import type { EconomyClientLike } from '../client/types.js'
import type { ReferenceMeta } from './types.js'

export interface GlobalMacroCell {
  value: number | null
  date: string | null
  error?: string
}

export interface GlobalMacroRow {
  /** opentypebb country slug, e.g. 'united_states'. */
  country: string
  label: string
  cpiYoy: GlobalMacroCell
  shortRate: GlobalMacroCell
  cli: GlobalMacroCell
}

export interface GlobalMacroBoard {
  rows: GlobalMacroRow[]
  meta: ReferenceMeta
}

const COUNTRIES: Array<{ slug: string; label: string }> = [
  { slug: 'united_states', label: 'United States' },
  { slug: 'china', label: 'China' },
  { slug: 'japan', label: 'Japan' },
  { slug: 'germany', label: 'Germany' },
  { slug: 'united_kingdom', label: 'United Kingdom' },
  { slug: 'india', label: 'India' },
  { slug: 'brazil', label: 'Brazil' },
]

export async function fetchGlobalMacro(economyClient: EconomyClientLike): Promise<GlobalMacroBoard> {
  const start = new Date()
  start.setMonth(start.getMonth() - 14)
  const startDate = start.toISOString().slice(0, 10)

  const latestCell = (
    rows: Array<{ date: string; value?: number | null }>,
    scale = 1,
  ): GlobalMacroCell => {
    const last = [...rows]
      .filter((r) => typeof r.value === 'number')
      .sort((a, b) => a.date.localeCompare(b.date))
      .pop()
    return last ? { value: (last.value as number) * scale, date: last.date } : { value: null, date: null }
  }
  const errCell = (err: unknown): GlobalMacroCell => ({
    value: null,
    date: null,
    error: err instanceof Error ? err.message : String(err),
  })

  const rows = await Promise.all(
    COUNTRIES.map(async ({ slug, label }): Promise<GlobalMacroRow> => {
      const [cpi, rate, cli] = await Promise.allSettled([
        economyClient.getCPI({ provider: 'oecd', country: slug, transform: 'yoy', frequency: 'monthly', start_date: startDate }),
        economyClient.getInterestRates({ provider: 'oecd', country: slug, duration: 'short', start_date: startDate }),
        economyClient.getCompositeLeadingIndicator({ provider: 'oecd', country: slug, start_date: startDate }),
      ])
      return {
        country: slug,
        label,
        // OECD CPI yoy is already percent; rates are fractions → ×100.
        cpiYoy: cpi.status === 'fulfilled' ? latestCell(cpi.value as never) : errCell(cpi.reason),
        shortRate: rate.status === 'fulfilled' ? latestCell(rate.value as never, 100) : errCell(rate.reason),
        cli: cli.status === 'fulfilled' ? latestCell(cli.value as never) : errCell(cli.reason),
      }
    }),
  )

  // Every cell down = OECD itself is unreachable — fail loud.
  const allDead = rows.every((r) => r.cpiYoy.value == null && r.shortRate.value == null && r.cli.value == null)
  if (allDead) {
    const firstErr = rows.flatMap((r) => [r.cpiYoy.error, r.shortRate.error, r.cli.error]).find(Boolean)
    throw new Error(firstErr ?? 'OECD returned no data for any country.')
  }

  return { rows, meta: { provider: 'oecd', asOf: new Date().toISOString() } }
}
