import { describe, it, expect } from 'vitest'
import { fetchGlobalMacro } from './global-macro.js'
import type { EconomyClientLike } from '../client/types.js'

function mkClient(overrides: Partial<Record<'getCPI' | 'getInterestRates' | 'getCompositeLeadingIndicator', (p: Record<string, unknown>) => Promise<unknown[]>>>): EconomyClientLike {
  return {
    getCPI: async () => [{ date: '2026-04-01', country: 'X', value: 3.2 }],
    getInterestRates: async () => [{ date: '2026-04-01', country: 'X', value: 0.0372 }],
    getCompositeLeadingIndicator: async () => [{ date: '2026-05-01', country: 'X', value: 100.9 }],
    ...overrides,
  } as unknown as EconomyClientLike
}

describe('global macro board', () => {
  it('normalizes units in-domain: CPI stays percent, rates ×100', async () => {
    const board = await fetchGlobalMacro(mkClient({}))
    const us = board.rows.find((r) => r.country === 'united_states')!
    expect(us.cpiYoy.value).toBeCloseTo(3.2, 5)
    expect(us.shortRate.value).toBeCloseTo(3.72, 5)
    expect(us.cli.value).toBeCloseTo(100.9, 5)
    expect(board.meta.provider).toBe('oecd')
  })

  it('annotates a cell-level failure without killing the row', async () => {
    const board = await fetchGlobalMacro(mkClient({
      getInterestRates: async (p) => {
        if (p.country === 'china') throw new Error('OECD API returned 404')
        return [{ date: '2026-04-01', country: 'X', value: 0.016 }]
      },
    }))
    const cn = board.rows.find((r) => r.country === 'china')!
    expect(cn.shortRate.value).toBeNull()
    expect(cn.shortRate.error).toMatch(/404/)
    expect(cn.cpiYoy.value).not.toBeNull()
  })

  it('throws loud when every cell fails (OECD unreachable)', async () => {
    const dead = async () => { throw new Error('OECD down') }
    await expect(fetchGlobalMacro(mkClient({
      getCPI: dead, getInterestRates: dead, getCompositeLeadingIndicator: dead,
    }))).rejects.toThrow(/OECD down/)
  })

  it('picks the LATEST observation per cell', async () => {
    const board = await fetchGlobalMacro(mkClient({
      getCPI: async () => [
        { date: '2026-04-01', country: 'X', value: 4 },
        { date: '2026-02-01', country: 'X', value: 2 },
      ],
    }))
    expect(board.rows[0].cpiYoy.value).toBe(4)
    expect(board.rows[0].cpiYoy.date).toBe('2026-04-01')
  })
})
