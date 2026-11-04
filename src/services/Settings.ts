import { Context, Effect, Layer, Schema } from "effect"
import { defaultSettings, Settings as SettingsSchema } from "../domain/schema.ts"
import type { Settings as SettingsType } from "../domain/schema.ts"

const KEY = "weave.settings.v1"

const decode = Schema.decodeUnknownSync(Schema.fromJsonString(SettingsSchema))
const encode = Schema.encodeSync(Schema.fromJsonString(SettingsSchema))

/** Reads stored settings, keeping any field that is valid and falling back to defaults for the rest. */
export const parseSettings = (raw: string | null): SettingsType => {
  if (!raw) return defaultSettings
  try {
    return decode(raw)
  } catch {
    try {
      const partial = JSON.parse(raw) as Record<string, unknown>
      return decode(JSON.stringify({ ...defaultSettings, ...partial }))
    } catch {
      return defaultSettings
    }
  }
}

export const serializeSettings = (s: SettingsType): string => encode(s)

/** User preferences stored in localStorage, checked with a Schema. */
export class Settings extends Context.Service<Settings, {
  readonly get: Effect.Effect<SettingsType>
  set(next: SettingsType): Effect.Effect<void>
}>()("weave/Settings") {
  static readonly layer = Layer.succeed(Settings, Settings.of({
    get: Effect.sync(() => {
      try {
        return parseSettings(localStorage.getItem(KEY))
      } catch {
        return defaultSettings
      }
    }),
    set: (next) =>
      Effect.sync(() => {
        try {
          localStorage.setItem(KEY, serializeSettings(next))
        } catch {
          // Private windows can refuse storage. Settings then last for this visit only.
        }
      })
  }))

  static readonly layerMemory = (initial: SettingsType = defaultSettings) => {
    let current = initial
    return Layer.succeed(Settings, Settings.of({
      get: Effect.sync(() => current),
      set: (next) => Effect.sync(() => {
        current = next
      })
    }))
  }
}
