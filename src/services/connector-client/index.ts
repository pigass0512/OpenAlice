import {
  ConnectorClient,
  connectorServiceHealthSchema,
  type ConnectorServiceHealth,
  type InboxNotification,
} from '@traderalice/connector-protocol'
import type { InboxEntry, IInboxStore } from '../../core/inbox-store.js'
import { readConnectorServiceEnabled } from '../../core/connector-config.js'
import { probeOptionalCarrier } from '../optional-carrier/health.js'

export interface ConnectorBridgeHealth {
  enabled: boolean
  status: 'disabled' | 'healthy' | 'degraded'
  checkedAt?: string
  latencyMs?: number
  reason?: 'not_configured' | 'http_error' | 'invalid_response' | 'timeout' | 'unreachable'
  lastAttemptAt?: string
  lastSuccessAt?: string
  lastError?: string
  service?: ConnectorServiceHealth
}

const state: ConnectorBridgeHealth = { enabled: false, status: 'disabled' }

export function decodeConnectorServiceHealth(value: unknown): ConnectorServiceHealth {
  return connectorServiceHealthSchema.parse(value)
}

export interface InboxConnectorBridgeDeps {
  isEnabled(): Promise<boolean>
  push(notification: InboxNotification): Promise<void>
  warn(message: string): void
}

export function resolveConnectorUrl(): string {
  return process.env['OPENALICE_CONNECTOR_URL']?.trim()
    || `http://127.0.0.1:${process.env['OPENALICE_CONNECTOR_PORT'] ?? '47334'}`
}

export function startInboxConnectorBridge(inboxStore: IInboxStore): () => void {
  const client = new ConnectorClient(resolveConnectorUrl())
  return attachInboxConnectorBridge(inboxStore, {
    isEnabled: readConnectorServiceEnabled,
    push: async (notification) => {
      await client.pushInbox(notification, AbortSignal.timeout(5_000))
    },
    warn: (message) => console.warn('[connector] Inbox notification delivery unavailable:', message),
  })
}

export function attachInboxConnectorBridge(
  inboxStore: IInboxStore,
  deps: InboxConnectorBridgeDeps,
): () => void {
  return inboxStore.onAppended((entry) => {
    // EventEmitter listeners are synchronous. Never return/throw the network
    // promise into InboxStore.append; durable local write is the hard boundary.
    queueMicrotask(() => { void deliverEntry(entry, deps) })
  })
}

export async function connectorBridgeHealth(): Promise<ConnectorBridgeHealth> {
  const enabled = await readConnectorServiceEnabled()
  state.enabled = enabled
  if (!enabled) {
    state.status = 'disabled'
    delete state.service
    delete state.reason
    delete state.lastError
    return { ...state }
  }
  const probe = await probeOptionalCarrier({
    id: 'connector',
    enabled,
    baseUrl: resolveConnectorUrl(),
    healthPath: '/__connector/health',
    timeoutMs: 2_000,
    decode: decodeConnectorServiceHealth,
  })
  state.checkedAt = probe.checkedAt
  state.latencyMs = probe.latencyMs
  if (probe.phase === 'healthy') {
    state.service = probe.body
    state.status = probe.body?.status === 'healthy' ? 'healthy' : 'degraded'
    delete state.reason
    if (state.status === 'healthy') {
      delete state.lastError
    } else {
      state.lastError = probe.body?.adapters
        .filter((adapter) => adapter.status === 'degraded')
        .map((adapter) => `${adapter.id}: ${adapter.lastError ?? adapter.detail ?? 'degraded'}`)
        .join('; ') || 'One or more connectors are degraded.'
    }
  } else {
    state.status = 'degraded'
    state.reason = probe.reason
    state.lastError = probe.detail ?? probe.reason ?? 'Connector Service health probe failed.'
    delete state.service
  }
  return { ...state }
}

async function deliverEntry(entry: InboxEntry, deps: InboxConnectorBridgeDeps): Promise<void> {
  if (!await deps.isEnabled()) return
  state.enabled = true
  state.lastAttemptAt = new Date().toISOString()
  const notification = toNotification(entry)
  try {
    await deps.push(notification)
    state.status = 'healthy'
    state.lastSuccessAt = new Date().toISOString()
    delete state.lastError
  } catch (error) {
    state.status = 'degraded'
    state.lastError = message(error)
    deps.warn(state.lastError)
  }
}

export function toNotification(entry: InboxEntry): InboxNotification {
  const docs = entry.docs?.map((doc) => doc.path) ?? []
  const body = [
    entry.comments?.trim(),
    docs.length > 0 ? `Reports:\n${docs.map((path) => `- ${path}`).join('\n')}` : undefined,
  ].filter(Boolean).join('\n\n')
  const baseUrl = process.env['OPENALICE_PUBLIC_URL']?.replace(/\/+$/, '')
  return {
    id: entry.id,
    createdAt: new Date(entry.ts).toISOString(),
    workspaceId: entry.workspaceId,
    ...(entry.workspaceLabel ? { workspaceLabel: entry.workspaceLabel } : {}),
    title: `Inbox update from ${entry.workspaceLabel ?? entry.workspaceId}`,
    body,
    ...(baseUrl ? { href: `${baseUrl}/inbox` } : {}),
    ...(entry.origin?.resumeId || entry.origin?.agent ? {
      provenance: {
        ...(entry.origin.resumeId ? { resumeId: entry.origin.resumeId } : {}),
        ...(entry.origin.agent ? { actorLabel: entry.origin.agent } : {}),
      },
    } : {}),
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
