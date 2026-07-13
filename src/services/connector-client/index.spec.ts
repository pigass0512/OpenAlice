import { describe, expect, it, vi } from 'vitest'
import { createMemoryInboxStore } from '../../core/inbox-store.js'
import { attachInboxConnectorBridge, toNotification } from './index.js'

describe('Inbox Connector bridge', () => {
  it('does not make a durable Inbox append wait for external delivery', async () => {
    let rejectDelivery!: (error: Error) => void
    const delivery = new Promise<void>((_resolve, reject) => { rejectDelivery = reject })
    const push = vi.fn(() => delivery)
    const warn = vi.fn()
    const store = createMemoryInboxStore()
    attachInboxConnectorBridge(store, {
      isEnabled: async () => true,
      push,
      warn,
    })

    const entry = await store.append({ workspaceId: 'ws-1', comments: 'done' })
    expect(entry.comments).toBe('done')
    await vi.waitFor(() => expect(push).toHaveBeenCalledOnce())

    rejectDelivery(new Error('external IM offline'))
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith('external IM offline'))
  })

  it('projects bounded Inbox provenance without tool logs', () => {
    const notification = toNotification({
      id: 'entry-1',
      ts: 1_700_000_000_000,
      workspaceId: 'ws-1',
      workspaceLabel: 'Research',
      comments: 'Read the report.',
      docs: [{ path: 'research/close.md' }],
      origin: { kind: 'headless', resumeId: 'resume-calm-river-12ab', agent: 'pi' },
    })
    expect(notification).toMatchObject({
      title: 'Inbox update from Research',
      body: 'Read the report.\n\nReports:\n- research/close.md',
      provenance: { resumeId: 'resume-calm-river-12ab', actorLabel: 'pi' },
    })
  })
})
