import { useCallback, useEffect, useMemo, useState } from 'react'
import { CircleAlert, Send, ShieldCheck } from 'lucide-react'
import { api, type ConnectorDefinition, type ConnectorHealth, type PublicConnectorConfig } from '../api'
import { PageHeader } from '../components/PageHeader'
import { SaveIndicator } from '../components/SaveIndicator'
import { ConfigSection, Field, inputClass } from '../components/form'
import { useAutoSave } from '../hooks/useAutoSave'

export function ConnectorsPage() {
  const [definitions, setDefinitions] = useState<ConnectorDefinition[]>([])
  const [config, setConfig] = useState<PublicConnectorConfig | null>(null)
  const [health, setHealth] = useState<ConnectorHealth | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [testing, setTesting] = useState<string | null>(null)
  const [testError, setTestError] = useState<string | null>(null)
  const [lastProbe, setLastProbe] = useState<{ connectorId: string; probeId: string } | null>(null)

  const load = useCallback(async () => {
    try {
      const snapshot = await api.connectors.load()
      setDefinitions(snapshot.definitions)
      setConfig((current) => JSON.stringify(current) === JSON.stringify(snapshot.config) ? current : snapshot.config)
      setHealth(snapshot.health)
      setLoadError(false)
    } catch {
      setLoadError(true)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const save = useCallback(async (next: PublicConnectorConfig) => {
    const response = await api.connectors.save(next)
    setConfig((current) => JSON.stringify(current) === JSON.stringify(response.config) ? current : response.config)
    window.setTimeout(() => { void load() }, 900)
  }, [load])

  const { status, retry } = useAutoSave({
    data: config!,
    save,
    enabled: config !== null,
    delay: 700,
  })

  const adapterHealth = useMemo(
    () => new Map(health?.service?.adapters.map((item) => [item.id, item]) ?? []),
    [health],
  )

  const updateAdapter = useCallback((id: string, patch: Partial<PublicConnectorConfig['adapters'][string]>) => {
    setConfig((current) => {
      if (!current) return current
      const existing = current.adapters[id] ?? { enabled: false, settings: {}, configuredSecrets: [] }
      return {
        ...current,
        adapters: { ...current.adapters, [id]: { ...existing, ...patch } },
      }
    })
  }, [])

  const updateSetting = useCallback((id: string, key: string, value: string | number | boolean) => {
    setConfig((current) => {
      if (!current) return current
      const existing = current.adapters[id] ?? { enabled: false, settings: {}, configuredSecrets: [] }
      return {
        ...current,
        adapters: {
          ...current.adapters,
          [id]: { ...existing, settings: { ...existing.settings, [key]: value } },
        },
      }
    })
  }, [])

  const test = useCallback(async (id: string) => {
    setTesting(id)
    setTestError(null)
    try {
      const result = await api.connectors.test(id)
      setLastProbe({ connectorId: id, probeId: result.probeId })
      await load()
    } catch (error) {
      setTestError(error instanceof Error ? error.message : String(error))
    } finally {
      setTesting(null)
    }
  }, [load])

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <PageHeader
        title="Connectors"
        description="Forward durable Inbox notifications to private external chats. Delivery is optional and never blocks OpenAlice work."
        right={<SaveIndicator status={status} onRetry={retry} />}
      />

      <div className="flex-1 overflow-y-auto px-4 md:px-8 py-5">
        <div className="max-w-[920px] mx-auto">
          {config && (
            <>
              <ConfigSection
                title="Connector Service"
                description="Runs as an independent, Guardian-managed process. Turning it off leaves Inbox and every other OpenAlice service untouched."
              >
                <label className="flex items-start gap-3 rounded-xl border border-border/70 bg-bg-secondary/35 px-4 py-3">
                  <input
                    className="mt-1"
                    type="checkbox"
                    checked={config.serviceEnabled}
                    onChange={(event) => setConfig({ ...config, serviceEnabled: event.target.checked })}
                  />
                  <span>
                    <span className="block text-[13px] font-medium text-text">Enable external notification connectors</span>
                    <span className="block mt-0.5 text-[12px] text-text-muted/70">Local Inbox remains the source of truth. External delivery never marks an item read.</span>
                  </span>
                </label>
                <HealthLine health={health} />
              </ConfigSection>

              {definitions.map((definition) => {
                const adapter = config.adapters[definition.id] ?? { enabled: false, settings: {}, configuredSecrets: [] }
                const runtime = adapterHealth.get(definition.id)
                return (
                  <ConfigSection key={definition.id} title={definition.label} description={definition.description}>
                    <div className="space-y-4">
                      <label className="inline-flex items-center gap-2 text-[13px] text-text">
                        <input
                          type="checkbox"
                          checked={adapter.enabled}
                          disabled={!config.serviceEnabled}
                          onChange={(event) => updateAdapter(definition.id, { enabled: event.target.checked })}
                        />
                        Enable {definition.label}
                      </label>

                      {definition.fields.map((field) => {
                        const configured = adapter.configuredSecrets.includes(field.key)
                        const value = adapter.settings[field.key]
                        return (
                          <Field key={field.key} label={field.label} description={field.description}>
                            {field.kind === 'boolean' ? (
                              <input
                                type="checkbox"
                                checked={value === true}
                                onChange={(event) => updateSetting(definition.id, field.key, event.target.checked)}
                              />
                            ) : (
                              <div className="flex gap-2">
                                <input
                                  className={inputClass}
                                  type={field.kind === 'secret' ? 'password' : field.kind}
                                  value={field.kind === 'secret' ? '' : String(value ?? '')}
                                  placeholder={configured ? 'Configured — enter a new value to replace' : field.placeholder}
                                  autoComplete="off"
                                  onChange={(event) => updateSetting(
                                    definition.id,
                                    field.key,
                                    field.kind === 'number' ? Number(event.target.value) : event.target.value,
                                  )}
                                />
                                {field.kind === 'secret' && configured && (
                                  <button
                                    type="button"
                                    className="shrink-0 rounded-lg border border-border px-3 text-[12px] text-text-muted hover:text-red"
                                    onClick={() => setConfig((current) => {
                                      if (!current) return current
                                      const currentAdapter = current.adapters[definition.id]!
                                      return {
                                        ...current,
                                        adapters: {
                                          ...current.adapters,
                                          [definition.id]: {
                                            ...currentAdapter,
                                            settings: { ...currentAdapter.settings, [field.key]: '' },
                                            configuredSecrets: currentAdapter.configuredSecrets.filter((key) => key !== field.key),
                                          },
                                        },
                                      }
                                    })}
                                  >
                                    Clear
                                  </button>
                                )}
                              </div>
                            )}
                          </Field>
                        )
                      })}

                      <div className="flex flex-wrap items-center gap-3 pt-1">
                        <button
                          type="button"
                          className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-[13px] text-text hover:border-accent/50 disabled:opacity-50"
                          disabled={!config.serviceEnabled || !adapter.enabled || testing !== null}
                          onClick={() => void test(definition.id)}
                        >
                          <Send size={14} />
                          {testing === definition.id ? 'Sending…' : 'Send test'}
                        </button>
                        {runtime && (
                          <span className={`text-[12px] ${runtime.status === 'healthy' ? 'text-green' : runtime.status === 'degraded' ? 'text-red' : 'text-text-muted'}`}>
                            {runtime.status}{runtime.owner ? ` · owner ${runtime.owner}` : ''}
                          </span>
                        )}
                      </div>
                      {runtime?.lastError && <p className="text-[12px] text-red">{runtime.lastError}</p>}
                      {lastProbe?.connectorId === definition.id && (
                        <p className="text-[12px] text-green">Sent probe <code>{lastProbe.probeId}</code>. Confirm this ID in the private chat.</p>
                      )}
                    </div>
                  </ConfigSection>
                )
              })}
            </>
          )}
          {testError && <p className="mt-4 text-[13px] text-red">{testError}</p>}
          {loadError && <p className="text-[13px] text-red">Failed to load connector settings.</p>}
        </div>
      </div>
    </div>
  )
}

function HealthLine({ health }: { health: ConnectorHealth | null }) {
  if (!health || health.status === 'disabled') {
    return <p className="mt-3 flex items-center gap-2 text-[12px] text-text-muted"><ShieldCheck size={14} /> Disabled</p>
  }
  if (health.status === 'healthy') {
    return <p className="mt-3 flex items-center gap-2 text-[12px] text-green"><ShieldCheck size={14} /> Service healthy</p>
  }
  return (
    <div className="mt-3 text-[12px] text-red">
      <p className="flex items-center gap-2">
        <CircleAlert size={14} /> Connector Service unavailable. Alice and Inbox remain online.
      </p>
      {health.lastError && <p className="ml-[22px] mt-1 text-text-muted/70">{health.lastError}</p>}
    </div>
  )
}
