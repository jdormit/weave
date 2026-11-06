/// <reference lib="webworker" />
/**
 * Segments camera frames for the live previews (Record screen, floating
 * controls, editor). Runs the model off the main thread so playback stays smooth.
 */
import { createSegmenter, type Segmenter } from "../blur/segmenter.ts"
import type { BlurRequest, BlurResponse } from "../blur/live.ts"

declare const self: DedicatedWorkerGlobalScope

let segmenter: Promise<Segmenter> | null = null

self.onmessage = async (e: MessageEvent<BlurRequest>) => {
  const { id, pixels } = e.data
  try {
    segmenter ??= createSegmenter(self.location.origin)
    const mask = await (await segmenter).segment(new Uint8ClampedArray(pixels))
    self.postMessage({ id, mask: mask.buffer } satisfies BlurResponse, [mask.buffer])
  } catch (err) {
    segmenter = null
    self.postMessage({ id, error: err instanceof Error ? err.message : String(err) } satisfies BlurResponse)
  }
}
