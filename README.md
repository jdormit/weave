# Weave

Weave is an open source alternative to Loom. It records your screen, camera and microphone, transcribes the recording on your own computer, and lets you edit the video by editing its transcript.

Everything stays in your browser. Recordings are saved on your device, and speech is turned into text by a Whisper model that runs in the browser. Nothing is uploaded.

## What it does

- **Record** a browser tab, a window or your whole screen, with your camera and microphone. Pause, resume, restart a take, or cancel. The controls also float in a small always-on-top window.
- **Transcribe** with Whisper (Tiny, Base, Small or Large v3 Turbo). It uses WebGPU when your browser has it, and the CPU when it doesn't. Weave detects the spoken language, or you can choose it.
- **Edit by transcript.** Select words and delete them, and the video skips them. Undo, redo and restore work as you'd expect.
- **Edit on the timeline.** Split clips, delete them, and trim their ends. The transcript and the timeline share one list of cuts.
- **Clean up** long pauses and filler words ("um", "uh") in one step.
- **Place the camera.** Drag and resize the camera bubble, make it a circle or a rounded rectangle, or hide it.
- **Export** an MP4 with your edits and the camera bubble burned in, the original screen and camera files, and the transcript as SRT, VTT, TXT or JSON. Subtitles use the edited timing.

Weave works best in Chrome, Edge and other Chromium browsers. Other browsers are missing parts of the screen recording and video encoding APIs it needs.

## Develop

You need [Bun](https://bun.sh) 1.4 or later.

```sh
bun install
bun run dev        # http://localhost:5173, rebuilds and reloads on change
bun run test       # unit tests
bun run typecheck
bun run e2e        # end-to-end tests in headless Chromium
```

The end-to-end tests use Chromium's fake camera, screen and microphone. The microphone plays `e2e/fixtures/speech.wav`. They download the Whisper Base and Tiny models from Hugging Face (about 120 MB), and they check exported video with `ffprobe` and `ffmpeg`, so both must be installed. To use a Chromium that is already installed, set `PW_CHROMIUM_PATH`.

## How it's built

- React for the interface, with [Effect](https://effect.website) for services, errors and data schemas.
- Recordings are written to the Origin Private File System in one-second pieces while you record, so a crash loses at most a second. Metadata, transcripts and edits live in IndexedDB.
- [Transformers.js](https://huggingface.co/docs/transformers.js) runs Whisper in a Web Worker. ONNX Runtime's files are served by Weave itself.
- [Mediabunny](https://mediabunny.dev) reads recordings and encodes the export in a Web Worker, with the browser's WebCodecs.

The source is in `src/`: `domain/` holds the pure logic (cuts, transcript formats, clean-up), `services/` the browser services, `workers/` the transcription and export workers, and `ui/` the screens.

## Deploy

Weave is a static site. `wrangler.jsonc` deploys `dist/` to Cloudflare Workers as static assets, with the cross-origin isolation headers that multithreaded transcription needs:

```sh
bunx wrangler login
bun run deploy
```

Any static host works if it sends these headers on every response, and serves `index.html` for unknown paths:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: credentialless
```

## Credits

- [Inter](https://rsms.me/inter/) by Rasmus Andersson, under the SIL Open Font License 1.1.
- The test recording `e2e/fixtures/speech.wav` is from John F. Kennedy's 1961 inaugural address, which is in the public domain.
- Whisper models by OpenAI, converted for the web by Hugging Face.

## License

MIT. See [LICENSE](LICENSE).
