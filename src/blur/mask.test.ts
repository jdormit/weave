import { describe, expect, test } from "bun:test"
import { blurRadius, confidenceToMask, MASK_PIXELS, rgbaToInput } from "./mask.ts"

describe("rgbaToInput", () => {
  test("splits RGBA into scaled R, G and B planes and drops alpha", () => {
    const rgba = new Uint8ClampedArray(4 * MASK_PIXELS)
    rgba.set([255, 0, 51, 7], 0)
    rgba.set([0, 102, 255, 9], 4 * (MASK_PIXELS - 1))
    const out = rgbaToInput(rgba)
    expect(out.length).toBe(3 * MASK_PIXELS)
    const last = MASK_PIXELS - 1
    const got = [out[0], out[MASK_PIXELS], out[2 * MASK_PIXELS], out[last], out[MASK_PIXELS + last], out[2 * MASK_PIXELS + last]]
    const want = [1, 0, 0.2, 0, 0.4, 1]
    got.forEach((v, i) => expect(v).toBeCloseTo(want[i]!, 6))
  })

  test("rejects the wrong size", () => {
    expect(() => rgbaToInput(new Uint8ClampedArray(16))).toThrow()
  })
})

describe("confidenceToMask", () => {
  const alphaFor = (c: number) => {
    const conf = new Float32Array(MASK_PIXELS).fill(c)
    return confidenceToMask(conf)[3]
  }

  test("background is transparent and the person is opaque", () => {
    expect(alphaFor(0)).toBe(0)
    expect(alphaFor(0.2)).toBe(0)
    expect(alphaFor(0.8)).toBe(255)
    expect(alphaFor(1)).toBe(255)
  })

  test("fades smoothly in between", () => {
    expect(alphaFor(0.5)).toBe(128)
    const a = alphaFor(0.35)!
    const b = alphaFor(0.65)!
    expect(a).toBeGreaterThan(0)
    expect(a).toBeLessThan(128)
    expect(a + b).toBe(255)
  })

  test("writes white pixels so only alpha matters", () => {
    const out = confidenceToMask(new Float32Array(MASK_PIXELS).fill(0.5))
    expect(Array.from(out.subarray(0, 4))).toEqual([255, 255, 255, 128])
  })
})

test("blurRadius scales with width and has a floor", () => {
  expect(blurRadius(1280)).toBe(21)
  expect(blurRadius(100)).toBe(4)
})

test("a light blur is much smaller than a strong one", () => {
  expect(blurRadius(1280, "light")).toBe(6)
  expect(blurRadius(1280, "strong")).toBe(21)
  expect(blurRadius(100, "light")).toBe(2)
})
