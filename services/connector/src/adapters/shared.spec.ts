import { describe, expect, it } from 'vitest'
import type { InboxNotification } from '@traderalice/connector-protocol'
import { formatInboxNotification, formatPlainInboxNotification } from './shared.js'

const notification: InboxNotification = {
  id: 'fixture-1',
  createdAt: '2026-07-13T00:00:00.000Z',
  workspaceId: 'ws-1',
  workspaceLabel: 'Research *desk*',
  title: 'Close [scan]',
  body: 'Three findings.',
  provenance: { resumeId: 'resume-calm-river-12ab' },
  href: 'https://openalice.example/inbox',
}

describe('recorded Inbox payload formatting', () => {
  it('replays deterministically into Discord markdown', () => {
    expect(formatInboxNotification(notification)).toBe([
      '**Close \\[scan\\]**',
      'Workspace: Research \\*desk\\*',
      'From: resume\\-calm\\-river\\-12ab',
      '',
      'Three findings.',
      '',
      'https://openalice.example/inbox',
    ].join('\n'))
  })

  it('replays deterministically into Telegram plain text', () => {
    expect(formatPlainInboxNotification(notification)).toBe([
      'Close [scan]',
      'Workspace: Research *desk*',
      'From: resume-calm-river-12ab',
      '',
      'Three findings.',
      '',
      'https://openalice.example/inbox',
    ].join('\n'))
  })
})
