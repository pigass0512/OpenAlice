/**
 * AI Provider — Alice's credential vault.
 *
 * Post-Workspace-pivot the in-process model loop is gone; the only thing this
 * page manages is the central set of api-key credentials that get injected into
 * workspaces (and pulled/pushed from the per-workspace AI config modal). It is
 * NOT a profile editor anymore — no backend/loginMethod, no active profile, no
 * SDK adapters, and Test runs the lightweight HTTP probe, not the old provider
 * router.
 *
 * Subscription logins (Claude Pro/Max via `claude login`, ChatGPT via
 * `codex login`) are deliberately absent — those live in the CLI's own auth,
 * not in Alice. The preset catalog is reused here purely as an "add credential"
 * helper: it carries each vendor's endpoint + model suggestions + request shape.
 */

import { useState, useEffect, useMemo } from 'react'
import { api, type Preset } from '../api'
import type { CredentialSummary } from '../api/config'
import { PageHeader } from '../components/PageHeader'
import { PageLoading } from '../components/StateViews'
import { Field, inputClass } from '../components/form'

// ==================== Preset helpers ====================

/** Vendor tag stored on the credential, by preset id. */
const VENDOR_BY_PRESET: Record<string, string> = {
  'claude-api': 'anthropic',
  'codex-api': 'openai',
  gemini: 'google',
  minimax: 'minimax',
  glm: 'glm',
  kimi: 'kimi',
  deepseek: 'deepseek',
  custom: 'custom',
}

function schemaProps(schema: Preset['schema']): Record<string, Record<string, unknown>> {
  return (schema?.properties as Record<string, Record<string, unknown>>) ?? {}
}

/** Only api-key presets belong in the vault — oauth/subscription presets log in via the CLI. */
function isApiKeyPreset(p: Preset): boolean {
  return 'apiKey' in schemaProps(p.schema)
}

/** Request shape for the probe: agent-sdk backend → anthropic, everything else → openai. */
function presetShape(p: Preset): 'anthropic' | 'openai' {
  const backend = (schemaProps(p.schema)['backend'] as { const?: string } | undefined)?.const
  return backend === 'agent-sdk' ? 'anthropic' : 'openai'
}

/** Codex speaks the Responses API; openai-compatible gateways speak Chat Completions. */
function presetWireApi(p: Preset): 'chat' | 'responses' {
  return p.id.startsWith('codex') ? 'responses' : 'chat'
}

function presetModels(p: Preset): Array<{ id: string; label: string }> {
  const oneOf = (schemaProps(p.schema)['model'] as { oneOf?: Array<{ const: string; title: string }> } | undefined)?.oneOf
  return oneOf ? oneOf.map((o) => ({ id: o.const, label: o.title })) : []
}

/** Suggested base URL from the preset (default, or first declared endpoint). */
function presetBaseUrl(p: Preset): string {
  const field = schemaProps(p.schema)['baseUrl'] as
    | { default?: string; oneOf?: Array<{ const: string }> }
    | undefined
  if (typeof field?.default === 'string') return field.default
  if (field?.oneOf?.[0]?.const) return field.oneOf[0].const
  return ''
}

function vendorPreset(vendor: string, presets: Preset[]): Preset | undefined {
  const presetId = Object.entries(VENDOR_BY_PRESET).find(([, v]) => v === vendor)?.[0]
  return presets.find((p) => p.id === presetId) ?? presets.find((p) => p.id === 'custom')
}

// ==================== Page ====================

export function AIProviderPage() {
  const [credentials, setCredentials] = useState<CredentialSummary[] | null>(null)
  const [presets, setPresets] = useState<Preset[]>([])
  const [modal, setModal] = useState<{ mode: 'add' } | { mode: 'edit'; cred: CredentialSummary } | null>(null)

  const reload = () => api.config.getCredentials().then(({ credentials: c }) => setCredentials(c)).catch(() => setCredentials([]))

  useEffect(() => {
    void reload()
    api.config.getPresets().then(({ presets: p }) => setPresets(p)).catch(() => {})
  }, [])

  const apiKeyPresets = useMemo(() => presets.filter(isApiKeyPreset), [presets])

  const handleDelete = async (slug: string) => {
    try {
      await api.config.deleteCredential(slug)
      await reload()
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Delete failed')
    }
  }

  if (!credentials) {
    return (
      <div className="flex flex-col flex-1 min-h-0">
        <PageHeader title="AI Provider" description="Credentials Alice holds and injects into workspaces." />
        <PageLoading />
      </div>
    )
  }

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <PageHeader title="AI Provider" description="Credentials Alice holds and injects into workspaces." />
      <div className="flex-1 overflow-y-auto px-4 md:px-8 py-6">
        <div className="max-w-[760px] mx-auto">
          <div className="rounded-lg border border-border/50 bg-bg-secondary/50 px-4 py-3 mb-4">
            <p className="text-[13px] text-text-muted leading-relaxed">
              These are the API keys Alice keeps centrally. Templates inject them into new
              workspaces, and a workspace's AI config can load any of them. Subscription
              logins (Claude Pro/Max, ChatGPT) aren't stored here — they live in the agent
              CLI's own login (<code className="font-mono text-[11.5px]">claude login</code> /{' '}
              <code className="font-mono text-[11.5px]">codex login</code>).
            </p>
          </div>

          <div className="flex items-center justify-between mb-3">
            <h2 className="text-[13px] font-semibold text-text uppercase tracking-wide">Credentials</h2>
            <button
              onClick={() => setModal({ mode: 'add' })}
              className="text-[11px] px-2 py-1 rounded-md border border-border text-text-muted hover:text-accent hover:border-accent transition-colors"
            >
              + Add
            </button>
          </div>

          <div className="space-y-2.5">
            {credentials.map((cred) => (
              <div key={cred.slug} className="flex items-center gap-3 rounded-lg border border-border bg-bg px-4 py-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-[13px] font-medium text-text">{cred.vendor}</span>
                    <span className="text-[11px] text-text-muted font-mono">{cred.slug}</span>
                    {cred.hasApiKey && (
                      <span className="text-[10px] text-green border border-green/40 rounded px-1">key set</span>
                    )}
                  </div>
                  <div className="text-[11px] text-text-muted mt-0.5 font-mono truncate">
                    {cred.baseUrl ?? 'default endpoint'}
                  </div>
                </div>
                <button
                  onClick={() => setModal({ mode: 'edit', cred })}
                  className="text-[11px] px-2 py-1 rounded-md border border-border text-text-muted hover:text-text transition-colors"
                >
                  Edit
                </button>
                <button
                  onClick={() => handleDelete(cred.slug)}
                  className="text-[11px] px-2 py-1 rounded-md border border-border text-text-muted hover:text-red transition-colors"
                >
                  Delete
                </button>
              </div>
            ))}

            {credentials.length === 0 && (
              <button
                onClick={() => setModal({ mode: 'add' })}
                className="w-full p-4 rounded-xl border-2 border-dashed border-border text-text-muted hover:border-accent/50 hover:text-accent transition-all text-[13px] font-medium"
              >
                + Add your first credential
              </button>
            )}
          </div>
        </div>
      </div>

      {modal && (
        <CredentialModal
          mode={modal.mode}
          cred={modal.mode === 'edit' ? modal.cred : undefined}
          presets={apiKeyPresets}
          onClose={() => setModal(null)}
          onSaved={async () => { await reload(); setModal(null) }}
        />
      )}
    </div>
  )
}

// ==================== Add / Edit modal ====================

function CredentialModal({ mode, cred, presets, onClose, onSaved }: {
  mode: 'add' | 'edit'
  cred?: CredentialSummary
  presets: Preset[]
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  // In edit mode the vendor is fixed → resolve its preset up front; in add mode
  // the user picks one from the grid first.
  const initialPreset = mode === 'edit' && cred ? vendorPreset(cred.vendor, presets) ?? null : null
  const [preset, setPreset] = useState<Preset | null>(initialPreset)
  const [baseUrl, setBaseUrl] = useState(cred?.baseUrl ?? '')
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState('')
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; response?: string; error?: string } | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  // When a preset is chosen (add mode), seed baseUrl + the test model.
  const pickPreset = (p: Preset) => {
    setPreset(p)
    setBaseUrl(presetBaseUrl(p))
    setModel(presetModels(p)[0]?.id ?? '')
    setTestResult(null)
    setError('')
  }

  useEffect(() => {
    if (initialPreset && !model) setModel(presetModels(initialPreset)[0]?.id ?? '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const models = preset ? presetModels(preset) : []

  const handleTest = async () => {
    if (!preset) return
    const key = apiKey.trim() // edit mode may keep the stored key — can't test without re-entering
    if (!key) { setError('Enter the API key to test'); return }
    if (!model) { setError('Pick a model to test with'); return }
    setError(''); setTestResult(null); setTesting(true)
    try {
      const result = await api.config.testCredential({
        shape: presetShape(preset),
        baseUrl: baseUrl.trim() || undefined,
        apiKey: key,
        model,
        wireApi: presetWireApi(preset),
      })
      setTestResult(result)
    } catch (err) {
      setTestResult({ ok: false, error: err instanceof Error ? err.message : 'Test failed' })
    } finally {
      setTesting(false)
    }
  }

  const handleSave = async () => {
    if (!preset) return
    const vendor = VENDOR_BY_PRESET[preset.id] ?? 'custom'
    setSaving(true); setError('')
    try {
      if (mode === 'edit' && cred) {
        await api.config.updateCredential(cred.slug, {
          vendor,
          baseUrl: baseUrl.trim() || undefined,
          ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        })
      } else {
        if (!apiKey.trim()) { setError('API key is required'); setSaving(false); return }
        await api.config.addCredential({ vendor, baseUrl: baseUrl.trim() || undefined, apiKey: apiKey.trim() })
      }
      await onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed')
      setSaving(false)
    }
  }

  const title = mode === 'edit' && cred ? `Edit credential: ${cred.slug}` : 'Add credential'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-bg border border-border rounded-xl shadow-2xl w-full max-w-lg max-h-[82vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between p-4 border-b border-border">
          <h2 className="text-[15px] font-semibold text-text">{title}</h2>
          <button onClick={onClose} className="text-text-muted hover:text-text transition-colors">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {!preset ? (
            <div className="grid grid-cols-2 gap-2">
              {presets.map((p) => (
                <button
                  key={p.id}
                  onClick={() => pickPreset(p)}
                  className="flex flex-col items-start gap-0.5 p-3 rounded-lg border border-border bg-bg hover:bg-bg-tertiary hover:border-accent/40 transition-all text-left"
                >
                  <span className="text-[12px] font-medium text-text">{p.label}</span>
                  <span className="text-[10px] text-text-muted leading-snug">{p.description}</span>
                </button>
              ))}
            </div>
          ) : (
            <>
              {preset.hint && (
                <p className="text-[11px] text-text-muted bg-bg-tertiary rounded-lg p-3 leading-relaxed">{preset.hint}</p>
              )}

              <Field label="Base URL (optional)">
                <input className={inputClass} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder="leave empty for the official endpoint" spellCheck={false} autoCapitalize="off" autoCorrect="off" />
              </Field>

              <Field label="API key">
                <input className={inputClass} type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)}
                  placeholder={mode === 'edit' ? '(leave empty to keep the stored key)' : 'Enter API key'}
                  spellCheck={false} autoCapitalize="off" autoCorrect="off" />
              </Field>

              <Field label="Test model" description="Used only to verify the key — not stored on the credential.">
                {models.length > 0 ? (
                  <select className={inputClass} value={model} onChange={(e) => setModel(e.target.value)}>
                    {models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                  </select>
                ) : (
                  <input className={inputClass} value={model} onChange={(e) => setModel(e.target.value)} placeholder="model id" />
                )}
              </Field>

              {error && <p className="text-[12px] text-red">{error}</p>}
              {testing && <p className="text-[12px] text-text-muted">Testing connection…</p>}
              {testResult && (
                <div className={`text-[12px] rounded-lg p-3 ${testResult.ok ? 'bg-green/10 text-green' : 'bg-red/10 text-red'}`}>
                  {testResult.ok ? `Connected: "${testResult.response?.slice(0, 120)}"` : `Failed: ${testResult.error}`}
                </div>
              )}
            </>
          )}
        </div>

        {preset && (
          <div className="flex items-center gap-2 p-3 border-t border-border">
            <button onClick={handleSave} disabled={saving} className="btn-primary disabled:opacity-50">
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button onClick={handleTest} disabled={testing}
              className="text-[12px] px-3 py-1.5 rounded-md border border-border text-text-muted hover:text-text hover:bg-bg-tertiary transition-colors disabled:opacity-50">
              {testing ? 'Testing…' : 'Test'}
            </button>
            {mode === 'add' && (
              <button onClick={() => setPreset(null)} className="text-[12px] px-3 py-1.5 rounded-md text-text-muted hover:text-text">Back</button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
