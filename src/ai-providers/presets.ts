/**
 * AI Provider Presets — serialization layer.
 *
 * Reads preset definitions from preset-catalog.ts and converts
 * their Zod schemas to JSON Schema for the frontend.
 *
 * Post-processing:
 *   - Model fields: enum → oneOf + const + title (labeled dropdowns)
 *   - API key fields: marked writeOnly (password inputs)
 */

import { z } from 'zod'
import { PRESET_CATALOG, WIRE_SHAPE_LABELS, type PresetDef, type WireShape } from './preset-catalog.js'

// ==================== Serialized Preset (sent to frontend) ====================

/** A wire shape + its endpoints, with a human label, for the create form. */
export interface SerializedWire {
  shape: WireShape
  shapeLabel: string
  endpoints: Array<{ id: string; label: string }>
}

export interface SerializedPreset {
  id: string
  label: string
  description: string
  category: 'official' | 'third-party' | 'custom'
  hint?: string
  defaultName: string
  schema: Record<string, unknown>
  /** Supported wire shapes × endpoints — drives the form's shape/region pickers. */
  wires?: SerializedWire[]
}

// ==================== Schema post-processing ====================

function buildJsonSchema(def: PresetDef): Record<string, unknown> {
  const raw = z.toJSONSchema(def.zodSchema) as Record<string, unknown>
  const props = (raw.properties ?? {}) as Record<string, Record<string, unknown>>

  // Replace scalar string fields with labeled oneOf when a catalog is provided
  const labeledFields: Array<[string, Array<{ id: string; label: string }> | undefined]> = [
    ['model', def.models],
    ['baseUrl', def.endpoints],
  ]
  for (const [field, options] of labeledFields) {
    if (options?.length && props[field]) {
      const oneOf = options.map(o => ({ const: o.id, title: o.label }))
      const { enum: _e, ...rest } = props[field]
      props[field] = { ...rest, oneOf }
    }
  }

  // Mark writeOnly fields
  for (const field of def.writeOnlyFields ?? []) {
    if (props[field]) props[field].writeOnly = true
  }

  raw.properties = props
  return raw
}

// ==================== Exported ====================

export const BUILTIN_PRESETS: SerializedPreset[] = PRESET_CATALOG.map(def => ({
  id: def.id,
  label: def.label,
  description: def.description,
  category: def.category,
  hint: def.hint,
  defaultName: def.defaultName,
  schema: buildJsonSchema(def),
  ...(def.wires
    ? {
        wires: def.wires.map((w) => ({
          shape: w.shape,
          shapeLabel: WIRE_SHAPE_LABELS[w.shape],
          endpoints: w.endpoints.map((e) => ({ id: e.id, label: e.label })),
        })),
      }
    : {}),
}))
