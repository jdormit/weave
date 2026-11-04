import { Effect, Layer, ManagedRuntime } from "effect"
import { Capture } from "./Capture.ts"
import { Exporter } from "./Exporter.ts"
import { Player } from "./Player.ts"
import { Recorder } from "./Recorder.ts"
import { RecordingStore } from "./RecordingStore.ts"
import { Settings } from "./Settings.ts"
import { Transcriber } from "./Transcriber.ts"

export const AppLayer = Layer.mergeAll(
  Recorder.layer.pipe(Layer.provideMerge(RecordingStore.layer)),
  Capture.layer,
  Settings.layer,
  Transcriber.layer,
  Exporter.layer,
  Player.layer
)

export type AppServices = Layer.Success<typeof AppLayer>

/** The one runtime the UI uses to run effects. */
export const runtime = ManagedRuntime.make(AppLayer)

export const run = <A, E>(effect: Effect.Effect<A, E, AppServices>): Promise<A> => runtime.runPromise(effect)
