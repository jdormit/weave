import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { Page } from "@playwright/test"
import { allRecordings, downloadsDir, expect, opfsFiles, readDb, resetAppData, test } from "./fixtures.ts"

/**
 * Walks through every feature of Weave in one browser, in order: record,
 * transcribe, edit by transcript and timeline, clean up, move the camera,
 * export, and manage storage and models. Uses Chromium's fake screen, camera
 * and microphone; the microphone plays e2e/fixtures/speech.wav on a loop.
 */
test.describe.configure({ mode: "serial" })

let id = ""

const words = (page: Page) => page.locator("[data-testid=transcript] span.w")
const msOf = async (page: Page, testId: "time-now" | "time-total") =>
  Number(await page.getByTestId(testId).getAttribute("data-ms"))
const cutFlags = (page: Page) => words(page).evaluateAll((els) => els.map((e) => e.getAttribute("data-cut") === "true"))
const wordTimes = (page: Page) =>
  words(page).evaluateAll((els) =>
    els.map((e) => ({ text: e.textContent ?? "", start: Number(e.getAttribute("data-start")), end: Number(e.getAttribute("data-end")) }))
  )
/** Selects words a..b with a click and a Shift-click, and checks the selection. */
const selectWords = async (page: Page, a: number, b: number) => {
  await words(page).nth(a).click()
  await words(page).nth(b).click({ modifiers: ["Shift"] })
  await expect
    .poll(() => words(page).evaluateAll((els) => els.flatMap((e, i) => (e.classList.contains("picked") ? [i] : []))))
    .toEqual(Array.from({ length: b - a + 1 }, (_, k) => a + k))
}
const totalCut = (cuts: ReadonlyArray<{ startMs: number; endMs: number }>) => cuts.reduce((s, c) => s + c.endMs - c.startMs, 0)
const edits = async (page: Page) => (await readDb(page, "edits", id)) ?? { cuts: [], splits: [] }
/** Waits until the saved edit list has this many cuts, then returns it. */
const savedCuts = async (page: Page, n: number) => {
  await expect.poll(async () => (await edits(page)).cuts.length).toBe(n)
  return (await edits(page)).cuts as Array<{ startMs: number; endMs: number }>
}
const mod = process.platform === "darwin" ? "Meta" : "Control"

const openEditor = async (page: Page) => {
  await page.goto(`/r/${id}`)
  await expect(page.getByTestId("editor")).toBeVisible()
  await expect(words(page).first()).toBeVisible({ timeout: 30_000 })
}

/** Sets up the recording screen: the fake mic only, so the transcript is predictable. */
const setUpRecord = async (page: Page) => {
  await page.goto("/record")
  const sysAudio = page.locator("label.check input[type=checkbox]")
  if ((await sysAudio.count()) > 0 && (await sysAudio.isChecked())) await sysAudio.uncheck()
  await expect(page.getByTestId("camera-preview")).toBeVisible()
}

const startRecording = async (page: Page) => {
  await page.getByRole("button", { name: "Start recording" }).click()
  const view = page.getByTestId("recording-view")
  await expect(view).toHaveAttribute("data-phase", "countdown", { timeout: 15_000 })
  await expect(view).toHaveAttribute("data-phase", "recording", { timeout: 10_000 })
  return view
}

test("set up: clean data, choose the Base model", async ({ page }) => {
  await resetAppData(page)
  await expect(page.getByRole("heading", { name: "No recordings yet" })).toBeVisible()
  await page.goto("/settings")
  await page.getByTestId("model-base").click()
  // Base is the default.
  await expect(page.getByTestId("model-base").locator("input")).toBeChecked()
})

test("1. records screen, camera and microphone, with pause and resume", async ({ page }) => {
  await setUpRecord(page)
  const view = await startRecording(page)
  await page.waitForTimeout(4_000)
  await page.getByRole("button", { name: "Pause", exact: true }).click()
  await expect(view).toHaveAttribute("data-phase", "paused")
  const pausedAt = await page.getByTestId("elapsed").first().innerText()
  await page.waitForTimeout(1_500)
  // The timer stands still while paused.
  expect(await page.getByTestId("elapsed").first().innerText()).toBe(pausedAt)
  await page.getByRole("button", { name: "Resume", exact: true }).click()
  await expect(view).toHaveAttribute("data-phase", "recording")
  await page.waitForTimeout(15_000)
  await page.getByRole("button", { name: "Stop", exact: true }).click()
  await page.waitForURL(/\/r\/[^/]+$/, { timeout: 60_000 })
  id = decodeURIComponent(new URL(page.url()).pathname.split("/").pop()!)

  const rec = await readDb(page, "recordings", id)
  expect(rec.status).toBe("ready")
  expect(rec.hasAudio).toBe(true)
  // About 19 seconds were recorded, not counting the pause.
  expect(rec.durationMs).toBeGreaterThan(16_500)
  expect(rec.durationMs).toBeLessThan(22_000)
  expect(rec.hasCamera).toBe(true)
  const files = await opfsFiles(page)
  expect(files[id]).toEqual(expect.arrayContaining(["screen.webm", "camera.webm", "thumb.webp"]))
  // Chunk files are removed once the recording is assembled.
  expect(files[id]).not.toContain("chunks")
  await expect(page.getByTestId("time-total")).toHaveAttribute("data-ms", String(rec.durationMs))
})

test("2. transcribes the recording with word timings", async ({ page }) => {
  await expect(page.getByTestId("transcription-progress").or(words(page).first())).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId("transcription-progress")).toHaveCount(0, { timeout: 200_000 })
  const list = await wordTimes(page)
  const text = list.map((w) => w.text).join(" ").toLowerCase()
  // A small Whisper model on a looped clip isn't word-perfect, so look for most of the key words.
  const found = ["country", "americans", "fellow", "ask", "can do"].filter((k) => text.includes(k))
  expect(found.length, text).toBeGreaterThanOrEqual(2)
  expect(list.length, text).toBeGreaterThan(9)
  for (let i = 1; i < list.length; i++) expect(list[i]!.start).toBeGreaterThanOrEqual(list[i - 1]!.start)
  for (const w of list) expect(w.end).toBeGreaterThanOrEqual(w.start)
  const t = await readDb(page, "transcripts", id)
  expect(t.language).toBe("en")
  expect((await readDb(page, "recordings", id)).transcriptStatus).toBe("done")
})

test("3. clicking a word moves the playhead to it", async ({ page }) => {
  const list = await wordTimes(page)
  const i = Math.floor(list.length / 2)
  await words(page).nth(i).click()
  await expect.poll(() => msOf(page, "time-now")).toBeGreaterThanOrEqual(list[i]!.start - 60)
  expect(await msOf(page, "time-now")).toBeLessThan(list[i]!.start + 250)
  // The click also moves the start marker.
  await expect(page.getByTestId("marker")).toHaveAttribute("data-ms", String(list[i]!.start))
})

const markerMs = async (page: Page) => Number(await page.getByTestId("marker").getAttribute("data-ms"))

test("3b. the playhead drags, and playback returns to the start marker like a DAW", async ({ page }) => {
  const duration = (await readDb(page, "recordings", id)).durationMs
  const ruler = (await page.getByTestId("ruler").boundingBox())!

  // Drag the playhead along the timeline. Nothing on the page gets text-selected.
  const grab = page.getByTestId("playhead").locator(".grab")
  const gb = (await grab.boundingBox())!
  await page.mouse.move(gb.x + gb.width / 2, gb.y + gb.height / 2)
  await page.mouse.down()
  await page.mouse.move(ruler.x + ruler.width * 0.3, gb.y + gb.height / 2, { steps: 6 })
  await page.mouse.move(ruler.x + ruler.width * 0.6, gb.y + gb.height / 2, { steps: 6 })
  await page.mouse.up()
  await expect.poll(() => msOf(page, "time-now")).toBeGreaterThan(duration * 0.55)
  expect(await msOf(page, "time-now")).toBeLessThan(duration * 0.65)
  expect(Math.abs((await markerMs(page)) - (await msOf(page, "time-now")))).toBeLessThan(5)
  expect(await page.evaluate(() => window.getSelection()?.toString() ?? "")).toBe("")

  // Jump to the very start with the transport button.
  await page.getByRole("button", { name: "Jump to start" }).click()
  await expect.poll(() => msOf(page, "time-now")).toBe(0)
  expect(await markerMs(page)).toBe(0)

  // Play: the playhead moves, the marker stays. Stop: back to the marker.
  await page.getByRole("button", { name: "Play", exact: true }).click()
  await expect.poll(() => msOf(page, "time-now")).toBeGreaterThan(800)
  expect(await markerMs(page)).toBe(0)
  await page.getByRole("button", { name: "Stop", exact: true }).click()
  await expect.poll(() => msOf(page, "time-now")).toBe(0)
  await expect(page.getByRole("button", { name: "Play", exact: true })).toBeVisible()

  // Click a word, play, stop: the playhead goes back to that word, again and again.
  const w = (await wordTimes(page))[8]!
  await words(page).nth(8).click()
  for (let round = 0; round < 2; round++) {
    await page.getByRole("button", { name: "Play", exact: true }).click()
    await expect.poll(() => msOf(page, "time-now")).toBeGreaterThan(w.start + 500)
    await page.getByRole("button", { name: "Stop", exact: true }).click()
    await expect.poll(() => msOf(page, "time-now")).toBe(w.start)
  }

  // Forward and back 5 seconds, then the End and Home keys.
  await page.getByRole("button", { name: "Forward 5 seconds" }).click()
  await expect.poll(() => markerMs(page)).toBe(w.start + 5000)
  await page.getByRole("button", { name: "Back 5 seconds" }).click()
  await expect.poll(() => markerMs(page)).toBe(w.start)
  await page.keyboard.press("End")
  await expect.poll(() => msOf(page, "time-now")).toBeGreaterThan(duration - 100)
  await page.keyboard.press("Home")
  await expect.poll(() => msOf(page, "time-now")).toBe(0)

  // Clicking at the very left edge of the timeline also reaches the start.
  await words(page).nth(8).click()
  await page.mouse.click(ruler.x + 1, ruler.y + ruler.height / 2)
  await expect.poll(() => markerMs(page)).toBe(0)
})

test("4. deleting words cuts them from the video and playback skips them", async ({ page }) => {
  const list = await wordTimes(page)
  const total = await msOf(page, "time-total")
  const a = 4
  const b = 6
  await selectWords(page, a, b)
  await expect(page.getByTestId("selection-bar")).toBeVisible()
  await page.keyboard.press("Delete")
  await expect.poll(async () => (await cutFlags(page)).slice(a, b + 1)).toEqual([true, true, true])
  expect((await cutFlags(page))[a - 1]).toBe(false)
  expect((await cutFlags(page))[b + 1]).toBe(false)

  const cuts = await savedCuts(page, 1)
  const cut = cuts[0]!
  // The cut covers the words, up to (not into) the next word.
  expect(cut.startMs).toBeLessThanOrEqual(list[a]!.start + 1)
  expect(cut.endMs).toBeGreaterThanOrEqual(list[b]!.end - 1)
  expect(cut.endMs).toBeLessThanOrEqual(list[b + 1]!.start + 1)
  await expect.poll(() => msOf(page, "time-total")).toBe(total - totalCut(cuts))
  await expect(page.locator("[data-testid=transcript] span.w[data-cut=true]").first()).toHaveCSS("text-decoration-line", /line-through/)

  // Play from two words before the cut, and watch the video's clock.
  await words(page).nth(a - 2).click()
  await page.getByRole("button", { name: "Play", exact: true }).click()
  const samples: Array<number> = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const v = document.querySelector<HTMLVideoElement>("[data-testid=screen-video]")!
        const out: Array<number> = []
        const t0 = performance.now()
        const tick = () => {
          out.push(v.currentTime * 1000)
          if (performance.now() - t0 < 3_500) requestAnimationFrame(tick)
          else resolve(out)
        }
        tick()
      })
  )
  await page.getByRole("button", { name: "Stop", exact: true }).click()
  expect(Math.max(...samples)).toBeGreaterThan(cut.endMs)
  // Stopping returns to where playback started.
  await expect.poll(() => msOf(page, "time-now")).toBe(list[a - 2]!.start)
  const inside = samples.filter((t) => t > cut.startMs + 80 && t < cut.endMs - 80)
  expect(inside).toEqual([])
})

test("5. undo, redo, and restore", async ({ page }) => {
  const a = 4
  const b = 6
  const before = await msOf(page, "time-total")
  await page.locator("body").click({ position: { x: 5, y: 5 } })
  await page.keyboard.press(`${mod}+z`)
  await expect.poll(async () => (await cutFlags(page)).slice(a, b + 1)).toEqual([false, false, false])
  await savedCuts(page, 0)
  await page.keyboard.press(`${mod}+Shift+z`)
  await expect.poll(async () => (await cutFlags(page)).slice(a, b + 1)).toEqual([true, true, true])
  expect(await msOf(page, "time-total")).toBe(before)
  await page.getByRole("button", { name: "Undo" }).click()
  await expect.poll(async () => (await cutFlags(page)).slice(a, b + 1)).toEqual([false, false, false])
  await page.getByRole("button", { name: "Redo" }).click()
  await expect.poll(async () => (await cutFlags(page)).slice(a, b + 1)).toEqual([true, true, true])

  // Restore: select the struck-through words and restore them.
  await selectWords(page, a, b)
  await page.getByTestId("selection-bar").getByRole("button", { name: "Restore" }).click()
  await expect.poll(async () => (await cutFlags(page)).slice(a, b + 1)).toEqual([false, false, false])
  await savedCuts(page, 0)
  expect(await msOf(page, "time-total")).toBe((await readDb(page, "recordings", id)).durationMs)
})

test("6. timeline: split, delete a clip, and trim", async ({ page }) => {
  const duration = (await readDb(page, "recordings", id)).durationMs
  const clips = page.getByTestId("clip")
  await expect(clips).toHaveCount(1)
  // Clicking the clip selects it and moves the playhead.
  const box = (await clips.first().boundingBox())!
  await page.mouse.click(box.x + box.width * 0.6, box.y + box.height / 2)
  const at = await msOf(page, "time-now")
  expect(at).toBeGreaterThan(duration * 0.5)
  expect(at).toBeLessThan(duration * 0.7)
  await page.getByTestId("split").click()
  await expect(clips).toHaveCount(2)
  const second = clips.nth(1)
  const splitMs = Number(await second.getAttribute("data-start"))
  expect(Math.abs(splitMs - at)).toBeLessThan(100)

  // Delete the second clip: every word after the split is cut.
  const b2 = (await second.boundingBox())!
  await page.mouse.click(b2.x + b2.width / 2, b2.y + b2.height / 2)
  await page.getByTestId("delete-clip").click()
  const list = await wordTimes(page)
  await expect.poll(async () => {
    const flags = await cutFlags(page)
    return list.filter((w, i) => flags[i] !== Math.min((w.start + w.end) / 2, w.end - 0.5) >= splitMs).map((w) => `${w.text}@${w.start}-${w.end}`)
  }).toEqual([])
  await expect.poll(() => msOf(page, "time-total")).toBe(splitMs)
  await expect(page.getByTestId("cutmark")).toHaveCount(1)
  await page.getByRole("button", { name: "Undo" }).click()
  await expect.poll(async () => (await cutFlags(page)).some(Boolean)).toBe(false)

  // Trim the start of the first clip past the first word.
  const first = clips.first()
  const fb = (await first.boundingBox())!
  await page.mouse.click(fb.x + fb.width / 2, fb.y + fb.height / 2)
  const handle = page.getByTestId("trim-start")
  await expect(handle).toBeVisible()
  const hb = (await handle.boundingBox())!
  const pxPerMs = fb.width / splitMs
  const targetMs = list[0]!.end + 200
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2)
  await page.mouse.down()
  await page.mouse.move(hb.x + hb.width / 2 + targetMs * pxPerMs / 2, hb.y + hb.height / 2, { steps: 5 })
  await page.mouse.move(hb.x + hb.width / 2 + targetMs * pxPerMs, hb.y + hb.height / 2, { steps: 5 })
  await page.mouse.up()
  await expect.poll(async () => (await cutFlags(page))[0]).toBe(true)
  const cuts = await savedCuts(page, 1)
  expect(cuts[0]!.startMs).toBe(0)
  expect(Math.abs(cuts[0]!.endMs - targetMs)).toBeLessThan(200)
  await page.getByRole("button", { name: "Undo" }).click()
  await expect.poll(async () => (await edits(page)).cuts.length).toBe(0)
})

test("7. clean up shortens long pauses", async ({ page }) => {
  const before = await msOf(page, "time-total")
  await page.getByRole("button", { name: "Clean up" }).click()
  const dialog = page.getByTestId("cleanup")
  await expect(dialog).toBeVisible()
  await expect(dialog.getByTestId("cleanup-pauses-count")).toHaveText(/[1-9]/)
  await dialog.getByTestId("cleanup-apply").click()
  await expect(dialog).toHaveCount(0)
  await expect.poll(async () => (await edits(page)).cuts.length).toBeGreaterThan(0)
  const { cuts } = await edits(page)
  // The recording has a 3.5-second silence; at least a second of it goes.
  expect(totalCut(cuts)).toBeGreaterThan(1_000)
  await expect.poll(() => msOf(page, "time-total")).toBe(before - totalCut(cuts))
  // Speech is kept: most words are not cut.
  const flags = await cutFlags(page)
  expect(flags.filter(Boolean).length).toBeLessThan(flags.length / 4)
})

test("8. camera overlay: move, resize, reshape, hide; kept after reload", async ({ page }) => {
  const bubble = page.getByTestId("bubble")
  await expect(bubble).toBeVisible()
  const start = (await readDb(page, "recordings", id)).overlay
  const bb = (await bubble.boundingBox())!
  // Move it to the top left.
  await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2)
  await page.mouse.down()
  await page.mouse.move(bb.x + bb.width / 2 - 200, bb.y + bb.height / 2 - 150, { steps: 8 })
  await page.mouse.up()
  await expect.poll(async () => (await readDb(page, "recordings", id)).overlay.x).toBeLessThan(start.x - 0.05)
  const moved = (await readDb(page, "recordings", id)).overlay
  expect(moved.y).toBeLessThan(start.y - 0.05)
  // Make it bigger from the bottom-right corner.
  const se = page.getByTestId("handle-se")
  await expect(se).toBeVisible()
  const hb = (await se.boundingBox())!
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2)
  await page.mouse.down()
  await page.mouse.move(hb.x + hb.width / 2 + 60, hb.y + hb.height / 2 + 60, { steps: 8 })
  await page.mouse.up()
  await expect.poll(async () => (await readDb(page, "recordings", id)).overlay.size).toBeGreaterThan(moved.size + 0.03)
  // Rounded rectangle.
  await page.getByRole("group", { name: "Camera shape" }).getByRole("button", { name: "Rounded" }).click()
  await expect(bubble).toHaveAttribute("data-shape", "rounded")
  // Saving is asynchronous; wait for it before reloading.
  await expect.poll(async () => (await readDb(page, "recordings", id)).overlay.shape).toBe("rounded")
  const shaped = (await readDb(page, "recordings", id)).overlay

  await page.reload()
  await expect(bubble).toBeVisible({ timeout: 30_000 })
  await expect(bubble).toHaveAttribute("data-shape", "rounded")
  const after = (await readDb(page, "recordings", id)).overlay
  expect(after).toEqual(shaped)
  const b2 = (await bubble.boundingBox())!
  expect(b2.width / b2.height).toBeCloseTo(4 / 3, 1)

  // Hide it, check it stays hidden, then show it again for the export.
  await bubble.click()
  await page.getByRole("group", { name: "Camera shape" }).getByRole("button", { name: "Hide" }).click()
  await expect(bubble).toBeHidden()
  await expect.poll(async () => (await readDb(page, "recordings", id)).overlay.visible).toBe(false)
  await page.reload()
  await expect(page.getByRole("button", { name: "Show camera" })).toBeVisible({ timeout: 30_000 })
  await expect(bubble).toBeHidden()
  await page.getByRole("button", { name: "Show camera" }).click()
  await expect(bubble).toBeVisible()
  await expect.poll(async () => (await readDb(page, "recordings", id)).overlay.visible).toBe(true)
})

const ffprobe = (file: string) =>
  JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", file]).toString()) as {
    streams: Array<{ codec_type: string; codec_name: string; width?: number; height?: number }>
    format: { duration: string }
  }

/** Reads one RGB pixel from a frame of a video file. */
const pixel = (file: string, atSec: number, x: number, y: number) => {
  const raw = execFileSync("ffmpeg", [
    "-v", "error", "-ss", String(atSec), "-i", file, "-frames:v", "1",
    "-vf", `crop=2:2:${2 * Math.floor(x / 2)}:${2 * Math.floor(y / 2)}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"
  ])
  return { r: raw[0]!, g: raw[1]!, b: raw[2]! }
}

test("9. exports an MP4 with the edits and the camera overlay", async ({ page }) => {
  const edited = await msOf(page, "time-total")
  const overlay = (await readDb(page, "recordings", id)).overlay
  await page.getByRole("button", { name: "Export", exact: true }).click()
  const dialog = page.getByTestId("export")
  await expect(dialog).toBeVisible()
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 200_000 }),
    dialog.getByTestId("export-video").click()
  ])
  expect(await download.failure()).toBeNull()
  const file = join(downloadsDir, download.suggestedFilename())
  await download.saveAs(file)
  expect(file).toMatch(/\.mp4$/)
  const info = ffprobe(file)
  const video = info.streams.find((s) => s.codec_type === "video")!
  const audio = info.streams.find((s) => s.codec_type === "audio")
  expect(video.codec_name).toBe("h264")
  expect(audio).toBeTruthy()
  expect(Math.abs(Number(info.format.duration) * 1000 - edited)).toBeLessThan(100)

  // The middle of the camera bubble shows the fake camera (green), and a
  // spot well outside it shows the fake screen.
  const w = video.width!
  const h = video.height!
  const bh = overlay.size * h
  const bw = overlay.shape === "circle" ? bh : (bh * 4) / 3
  const cx = Math.min(overlay.x * w, w - bw) + bw / 2
  const cy = Math.min(overlay.y * h, h - bh) + bh / 2
  const cam = pixel(file, 1, cx, cy - bh * 0.3)
  expect(cam.g).toBeGreaterThan(cam.r + 25)
  expect(cam.g).toBeGreaterThan(cam.b + 25)
  const outside = pixel(file, 1, cx > w / 2 ? w * 0.1 : w * 0.9, cy > h / 2 ? h * 0.1 : h * 0.9)
  expect(Math.abs(outside.r - cam.r) + Math.abs(outside.g - cam.g) + Math.abs(outside.b - cam.b)).toBeGreaterThan(40)

  // The original files download unchanged.
  const [screen] = await Promise.all([page.waitForEvent("download"), dialog.getByTestId("download-screen").click()])
  expect(screen.suggestedFilename()).toMatch(/\.webm$/)
  const [camera] = await Promise.all([page.waitForEvent("download"), dialog.getByTestId("download-camera").click()])
  expect(camera.suggestedFilename()).toMatch(/\.webm$/)
})

test("10. exports the transcript as SRT, VTT, TXT and JSON in edited time", async ({ page }) => {
  const edited = await msOf(page, "time-total")
  const dialog = page.getByTestId("export")
  const get = async (format: string) => {
    const [d] = await Promise.all([page.waitForEvent("download"), dialog.getByTestId(`export-${format}`).click()])
    expect(d.suggestedFilename()).toMatch(new RegExp(`\\.${format}$`))
    const file = join(downloadsDir, d.suggestedFilename())
    await d.saveAs(file)
    return readFileSync(file, "utf8")
  }
  const toMs = (s: string) => {
    const [hms, ms] = s.replace(",", ".").split(".")
    const [hh, mm, ss] = hms!.split(":").map(Number)
    return ((hh! * 60 + mm!) * 60 + ss!) * 1000 + Number(ms)
  }
  const srt = await get("srt")
  const srtTimes = [...srt.matchAll(/(\d\d:\d\d:\d\d,\d\d\d) --> (\d\d:\d\d:\d\d,\d\d\d)/g)]
  expect(srtTimes.length).toBeGreaterThan(1)
  expect(srt.trim().startsWith("1\n")).toBe(true)
  // Edited time: no cue runs past the end of the edited video.
  expect(toMs(srtTimes.at(-1)![2]!)).toBeLessThanOrEqual(edited + 1)
  for (const m of srtTimes) expect(toMs(m[2]!)).toBeGreaterThan(toMs(m[1]!))
  const vtt = await get("vtt")
  expect(vtt.startsWith("WEBVTT")).toBe(true)
  const vttTimes = [...vtt.matchAll(/(\d\d:\d\d:\d\d\.\d\d\d) --> (\d\d:\d\d:\d\d\.\d\d\d)/g)]
  expect(vttTimes.length).toBe(srtTimes.length)
  expect(toMs(vttTimes.at(-1)![2]!)).toBeLessThanOrEqual(edited + 1)
  const txt = await get("txt")
  const first = (await wordTimes(page))[0]!.text.trim()
  expect(txt).toContain(first)
  const json = JSON.parse(await get("json"))
  expect(json.words.length).toBeGreaterThan(5)
  // JSON keeps source times, with each word's cut flag and the cut list.
  expect(Math.round(json.editedDurationMs)).toBe(edited)
  expect(json.cuts.length).toBeGreaterThan(0)
  expect(json.words.map((w: { cut: boolean }) => w.cut)).toEqual(await cutFlags(page))
  await page.keyboard.press("Escape")
  await expect(dialog).toHaveCount(0)
})

test("11. everything is kept after a reload; deleting removes it from disk", async ({ page }) => {
  const before = await msOf(page, "time-total")
  const flags = await cutFlags(page)
  await openEditor(page)
  await expect.poll(() => msOf(page, "time-total")).toBe(before)
  expect(await cutFlags(page)).toEqual(flags)

  await page.goto("/")
  const card = page.getByTestId("recording-card")
  await expect(card).toHaveCount(1)
  await expect(card.getByText("Transcribed")).toBeVisible()
  await card.getByRole("button", { name: "More actions" }).click()
  await card.getByRole("menuitem", { name: "Delete" }).click()
  await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click()
  await expect(card).toHaveCount(0)
  expect(await allRecordings(page)).toEqual([])
  expect(await readDb(page, "transcripts", id)).toBeUndefined()
  expect(await readDb(page, "edits", id)).toBeUndefined()
  expect(Object.keys(await opfsFiles(page))).not.toContain(id)
})

test("12. Cancel saves nothing; Restart keeps only the second take", async ({ page }) => {
  await setUpRecord(page)
  const view = await startRecording(page)
  await page.waitForTimeout(2_000)
  await page.getByRole("button", { name: "Cancel and discard" }).click()
  await expect(view).toHaveAttribute("data-phase", "confirmCancel")
  await page.getByRole("button", { name: "Delete recording" }).click()
  await expect(page.getByRole("button", { name: "Start recording" })).toBeVisible({ timeout: 15_000 })
  expect(await allRecordings(page)).toEqual([])
  expect(Object.keys(await opfsFiles(page))).toEqual([])

  await startRecording(page)
  await page.waitForTimeout(4_000)
  await page.getByRole("button", { name: "Restart", exact: true }).click()
  await expect(view).toHaveAttribute("data-phase", "confirmRestart")
  await page.getByRole("dialog").getByRole("button", { name: "Restart" }).or(page.getByRole("button", { name: "Restart", exact: true }).last()).first().click()
  await expect(view).toHaveAttribute("data-phase", "countdown")
  await expect(view).toHaveAttribute("data-phase", "recording", { timeout: 10_000 })
  await page.waitForTimeout(2_000)
  await page.getByRole("button", { name: "Stop", exact: true }).click()
  await page.waitForURL(/\/r\/[^/]+$/, { timeout: 60_000 })
  const all = await allRecordings(page)
  expect(all).toHaveLength(1)
  expect(all[0].durationMs).toBeGreaterThan(1_200)
  expect(all[0].durationMs).toBeLessThan(3_500)
  expect(Object.keys(await opfsFiles(page))).toEqual([all[0].id])
})

test("13. settings: switch model, see what's downloaded, delete a model", async ({ page }) => {
  await page.goto("/settings")
  // Base was downloaded for the transcripts above. Download Tiny here, then delete it.
  const tiny = page.getByTestId("model-tiny")
  await expect(page.getByTestId("model-base").getByTestId("downloaded")).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId("model-base").locator(".size")).toHaveText(/\d+(\.\d+)? MB/)
  await expect(page.getByTestId("models-total")).toContainText("Downloaded models use")
  await tiny.click()
  await expect(tiny.locator("input")).toBeChecked()
  expect((await page.evaluate(() => JSON.parse(localStorage.getItem("weave.settings.v1")!))).model).toBe("tiny")
  await page.reload()
  await expect(tiny.locator("input")).toBeChecked()
  await tiny.getByRole("button", { name: "Download" }).click()
  await expect(tiny.getByTestId("downloaded")).toBeVisible({ timeout: 180_000 })
  await expect(tiny.locator(".size")).toHaveText(/\d+(\.\d+)? MB/)
  await tiny.getByRole("button", { name: "Delete downloaded Tiny model" }).click()
  await expect(tiny.getByTestId("downloaded")).toHaveCount(0)
  await expect(tiny.getByRole("button", { name: "Download" })).toBeVisible()
  const left = await page.evaluate(async () => (await (await caches.open("transformers-cache")).keys()).filter((k) => k.url.includes("whisper-tiny")).length)
  expect(left).toBe(0)
  await expect(page.getByTestId("model-base").getByTestId("downloaded")).toBeVisible()
})
