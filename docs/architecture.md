# Architecture: web-gpu-test

Phase 1 (scaffold, frame harness, render-compare) comes first. Phase 2 (multi-demo shell, one-shot harness, compute-bench) follows and ends with the checklists for adding a demo or a compute workload. Phase 2 replaced `bench.ts` with `frame-bench.ts` and `window.__bench` with `window.__demo`.

## Phase 1: scaffold + harness + render-compare

Goal: web project that demos where WebGPU gives measurable performance gains. Every demo pairs a fair non-WebGPU baseline. Phase 1 = scaffold, shared frame-benchmark harness, first demo "render-compare": the same bouncing-circles scene drawn by SVG, Canvas2D, WebGL2, WebGPU (CPU sim), WebGPU (compute sim).

## Stack

- Vite 8 + TypeScript 7 (vanilla, no UI framework: a framework's reconciliation would pollute SVG numbers). `@webgpu/types`, `uplot` for charts, `vitest` for pure-logic unit tests, `playwright` for a browser smoke script. Install every dep at its latest version (`npm view <pkg> version` at install time). Use current, non-deprecated APIs.
- Single page (`index.html` → `src/main.ts`), hash router over `src/demos/*` (phase 2).

## Two shapes considered

| | Shape A: one closed `Renderer` per variant (picked) | Shape B: `Simulator` × `Drawer` matrix |
|---|---|---|
| Variants | 5 registry entries, each owns sim location + draw | cpu/gpu sim × svg/canvas/webgl2/webgpu draw |
| Illegal states | none: each entry is a valid combo | gpu-sim + svg needs readback; must be forbidden by extra checks |
| Caller knowledge | harness calls `create / frame / dispose` | harness wires two objects and their buffer handoff |
| Shared sim logic | pure `stepScene()` reused by the 4 CPU-sim renderers; WGSL mirrors it | same |

Shape A wins: one owner per piece of state, one way to run a variant, harness knows least.

## Data shape (src/demos/render-compare/scene.ts)

```ts
interface SceneConfig { seed: number; count: number; width: number; height: number } // CSS px
interface SceneData {
  config: SceneConfig;
  state: Float32Array;   // interleaved [x, y, vx, vy] * count — the only per-frame mutable data, 16 B/instance, uploaded as-is by webgpu-cpu
  radius: Float32Array;  // count, static
  color: Uint32Array;    // count, static, RGBA8 packed (r in low byte), alpha < 1 so overdraw/blend cost is real
}
createScene(config): SceneData          // deterministic from seed (mulberry32 in src/core/rng.ts)
stepScene(scene, dt): void               // fixed dt = 1/60 s, NOT wall clock: frame k is identical across renderers
```

Bounce rule (CPU and WGSL must match exactly): `p += v*dt`; if `p - r < 0` → `p = r`, `v = abs(v)`; if `p + r > size` → `p = size - r`, `v = -abs(v)`; per axis.

## Renderer contract (src/demos/render-compare/renderers/types.ts)

```ts
type RendererId = 'svg' | 'canvas2d' | 'webgl2' | 'webgpu-cpu' | 'webgpu-compute';
type Requirement = 'none' | 'webgl2' | 'webgpu';
interface Renderer {
  readonly id: RendererId;
  frame(): void;                    // advance one fixed step + draw; harness times this call = main-thread cost
  settle?(): Promise<void>;         // resolves when all submitted work finished on the GPU; WebGPU renderers only (device.queue.onSubmittedWorkDone)
  drainGpuSamples?(): number[];     // resolved timestamp-query durations (ms) since last drain; absent = no GPU timing
  dispose(): void;                  // idempotent; removes DOM, destroys GPU resources
}
interface RendererEntry {
  id: RendererId; label: string; summary: string; requires: Requirement;
  create(host: HTMLElement, scene: SceneData, caps: Capabilities): Promise<Renderer>;
}
// registry.ts: readonly RendererEntry[] — UI and harness iterate it; no switch on id anywhere else.
```

- Each renderer creates its own element (svg / canvas) in `host`, sized to config width/height CSS px, backing store × devicePixelRatio.
- Visual parity: same circle, same RGBA, same alpha blending (GPU: premultiplied, `alphaMode: 'premultiplied'`; fragment discards outside radius with ~1px smoothstep AA). Instanced quad, 6 verts via vertex_index, no vertex buffer for the quad.
- webgpu-cpu: `stepScene` on CPU, `queue.writeBuffer(state)` each frame, instanced draw.
- webgpu-compute: state lives in a storage buffer; compute pass (workgroup 64) runs the bounce rule, then render pass reads the same buffer. No per-frame CPU loop, no readback.
- Each WebGPU renderer requests its own adapter/device and destroys it on dispose.

## Boundary (src/core/capabilities.ts)

`detectCapabilities(): Promise<Capabilities>` — the only place that probes the platform.

```ts
type WebGpuCaps = { kind: 'available'; timestampQuery: boolean; adapterInfo: string } | { kind: 'unavailable'; reason: string };
interface Capabilities { webgpu: WebGpuCaps; webgl2: boolean; longAnimationFrames: boolean; dpr: number }
```

UI disables an entry whose `requires` is unmet and shows the reason. Internals trust these types.

## Harness (src/core/)

- `rng.ts` mulberry32. `stats.ts` `summarize(xs): { median, p95, mean, min, max, n }`.
- `gpu-timer.ts` timestamp-query helper: passes `timestampWrites` for a pass, resolves into a pool of mappable buffers (never stall the frame waiting on mapAsync), pushes ms samples into a queue the renderer drains. Created only when `caps.webgpu.timestampQuery`.
- `frame-loop.ts` rAF driver: each frame records `{ intervalMs (rAF timestamp delta), cpuMs (performance.now around renderer.frame()) }`.
- `frame-bench.ts` (was `bench.ts`):
  - `estimateRefresh(): Promise<number>` median idle rAF interval over 60 frames → Hz.
  - `runFrames(create, caps, refreshHz, { warmupFrames: 30, measureFrames: 120 }): Promise<FrameStats>` (render-compare wraps it as `runFixed` in `run.ts`; see phase 2) — create, warm up (discarded: includes pipeline compile, first layout), measure, dispose. Collects `long-animation-frame` entries via PerformanceObserver during the measure window when supported.
  - `rampMaxN(trial: (n) => Promise<boolean>, { start: 1000, max: 2_000_000, precision: 0.05 })` — PURE search: double until fail, then bisect to precision. Unit-tested with a fake trial.
  - Pass criterion for a trial: median interval ≤ 1.1 × refresh period AND dropped ratio (interval > 1.5 × period) ≤ 5 % AND `effectiveFrameMs` ≤ 1.1 × period.
  - `effectiveFrameMs = (t1 - t0) / frames`, where `t0` is taken before the measured frames and `t1` after `renderer.settle?.()` resolves. `runFixed` also settles after warm-up and before dispose.

```ts
interface RunResult {
  rendererId: RendererId; count: number; refreshHz: number; frames: number;
  interval: Summary; cpu: Summary; gpu: Summary | null;
  longFrames: { count: number; totalBlockingMs: number } | null;
  droppedRatio: number;
  effectiveFrameMs: number;
}
```

Known measurement limits to surface in the UI text (not to hide):
- rAF caps at display refresh, so "max N at refresh Hz" is the headline, not fps.
- SVG cost is mostly style/layout/paint outside JS: cpuMs undercounts it; interval and LoAF capture it.
- WebGPU cpuMs = encode + submit only; GPU work shows in gpuMs and, when GPU-bound, in interval.
- WebGPU submissions are not throttled by rAF (work queues up while the interval stays at one period), so the harness settles the queue and judges by effective frame time.
- Chrome quantizes timestamp-query (~100 µs) unless WebGPU Developer Features flag is on.

One-shot compute timing (GEMM, sort) is a different measurement; phase 2 adds it as `core/oneshot.ts`.

## Correctness check (src/demos/render-compare/verify.ts)

`verifyComputeParity(caps)`: same seed, count 4096, run CPU `stepScene` and the WGSL compute pass 60 steps each, read back GPU state once, report max abs error; pass ≤ 1e-3. Exposed as a UI button and in the smoke script.

## UI (src/demos/render-compare/ui.ts)

Controls: renderer checkboxes (disabled + reason when unsupported), N input, "Run fixed N", "Find max N" (ramp each selected renderer), "Verify compute". Live stage area showing the renderer under test. Results table (RunResult fields) + uPlot chart (N vs median interval per renderer). Capabilities panel (WebGPU adapter, timestamp-query, LoAF, refresh Hz). Text in Korean.

## Verification lever

- `npm run test` (vitest): rng determinism, stepScene bounce rule, summarize, rampMaxN search.
- `npm run build` + `tsc --noEmit` clean.
- `scripts/smoke.mjs` (playwright Chromium, WebGPU flags as needed): start vite preview, open page, for each available renderer runFixed at small N, assert no console errors, RunResult shape sane, verifyComputeParity passes; print a summary table. Headless numbers are smoke only, never reported as performance claims.

---

# Phase 2: multi-demo shell, one-shot harness, compute-bench

Hard rule: **adding a demo or a compute workload touches only files inside its own folder.** No registry file, no smoke list, no vite config edit.

## Shell (src/main.ts, src/core/demo.ts)

- `index.html` is the only page. `src/main.ts` eager-globs `./demos/*/meta.ts` (home cards, sorted by `order`, then `id`) and lazy-globs `./demos/*/main.ts`.
- Routes (`src/router.ts`): empty hash is home, `#/learn` and `#/learn/<slug>[#<heading-id>]` are learn pages (navigating between them re-renders without a reload). `#/<id>`: the top bar + `mount(host, caps)`. Unknown id: home with a notice. `hashchange` reloads the page, so no state or GPU device leaks between demos.
- The shell sets `window.__caps` (the `Capabilities`) before mounting. A demo sets `window.__demo` (typed `unknown` globally) to its own test-hook object; its `smoke.mjs` knows the shape. `window.__bench` no longer exists.

```ts
interface DemoMeta { id: string; title: string; summary: string; order: number }   // src/core/demo.ts
type MountDemo = (root: HTMLElement, caps: Capabilities) => Promise<void>
```

`id` must equal the folder name. render-compare uses `order` 10 and compute-bench 20; pick an unused number for a new demo.

## Frame harness (src/core/frame-bench.ts)

```ts
interface FrameTarget { frame(): void; drainGpuSamples?(): number[]; settle?(): Promise<void>; dispose(): void }
interface FrameStats { refreshHz; frames; interval: Summary; cpu: Summary; gpu: Summary | null; longFrames; droppedRatio; effectiveFrameMs }
runFrames(create: () => Promise<FrameTarget>, caps, refreshHz, { warmupFrames?, measureFrames? }): Promise<FrameStats>
trialPasses(s: FrameStats): boolean;  rampMaxN(trial, opts);  estimateRefresh()
```

Core imports nothing from a demo. render-compare wraps it in `run.ts` (`RunResult = { rendererId, count } & FrameStats`). A frame-loop demo (n-body, webcam filter) implements `FrameTarget` and calls `runFrames`. Per run: create, warm up (discarded), settle, measure, settle, dispose. `effectiveFrameMs` is judged after settle, so GPU-bound work cannot hide behind rAF.

## One-shot harness (src/core/oneshot.ts)

For work that runs once per input, and for CPU-vs-GPU crossover sweeps.

```ts
interface CpuImpl<I, O> { kind: 'cpu'; id; label; maxN?; run(input: I): O }
interface GpuImpl<I, O> { kind: 'gpu'; id; label; maxN?; prepare(device, input: I): Promise<GpuRun<O>> }   // compile + allocate; reported as setupMs, not in e2e
interface GpuRun<O> {
  upload(): void;                                    // queue.writeBuffer of the input
  encode(encoder, ts?: { first; last; only }): void; // every kernel pass, then copy the result into a MAP_READ buffer
  readback(): Promise<O>;                            // mapAsync + decode
  dispose(): void;
}
interface Workload<I, O> { id; label; summary; sizes; smokeSizes; sizeLabel(n); makeInput(n, seed); impls; verify(input, output): CheckResult; work?(n): { amount; unit } }
```

- GPU run: `t0` -> `upload` -> `encode` -> `submit` -> `onSubmittedWorkDone` (`t1`) -> `readback` (`t2`). `computeMs = t1 - t0`, `readbackMs = t2 - t1`, `e2eMs = t2 - t0`. `kernelMs` is the timestamp-query span from `first` to `last` (null when unsupported or quantized to 0).
- `encode` also records the copy into the MAP_READ buffer (one submit per run), so `readback` only maps and decodes.
- Timestamps: with one pass use `ts?.only` as that pass's `timestampWrites`; with several, `ts?.first` on the first pass and `ts?.last` on the last. Use `undefined` when `ts` is absent.
- CPU run: wall time of `run`. `performance.now()` is quantized to about 0.1 ms, so the harness first doubles a batch until it takes at least 1 ms (cap 4096 runs) and times each sample as a batch average.
- Repeat rule: one warm-up, then runs until at least 3 and (10 runs or more than 2 s of accumulated time). `verify` runs on the first and the last measured output only; the reported `check` is the first failure, else the last result.
- `crossoverN(results)`: smallest n from which the best GPU e2e median beats the best CPU e2e median at every larger measured n (null if never). Sizes missing one kind are ignored.
- `oneshot.test.ts` covers the stop rule, result assembly and `crossoverN` with fake impls and a fake device.

## compute-bench (src/demos/compute-bench/)

- One `GPUDevice` per page (`device.ts`), with `timestamp-query` when available and buffer limits raised to the adapter maximum.
- `sweep.ts` discovers workloads with `import.meta.glob('./workloads/*/index.ts', { eager: true })` (each exports `workload`), sorted by id, and runs a sweep: one input per n shared by all impls.
- Generic UI (`ui.ts`): workload select, impl and size checkboxes, "실행", table, log-log uPlot chart (solid e2e median per impl, dashed kernel-only per GPU impl), crossover text.
- `window.__demo = { workloads: [{ id, sizes, smokeSizes, impls: [{ id, kind, maxN }] }], hasDevice, runSweep(workloadId, sizes?, implIds?) -> { results: OneShotResult[], crossoverN } }`.
- Reference workload: `workloads/reduction/` (sum of f32; CPU loop with f64 accumulate; GPU 256-thread workgroup tree, 4 elements per thread, repeated passes until one value; verify: relative error <= 1e-4 against an f64 sum).

## Smoke runner (scripts/smoke.mjs)

Builds, previews, launches Chromium (WebGPU flags, fake media-stream flags, headless then headed fallback), checks that the home page shows one card per demo folder with a `meta.ts`, then for each `src/demos/<id>/smoke.mjs` opens a fresh page at `#/<id>`, waits for `window.__demo`, and calls `smoke({ page, caps, url, log, fail })`. Console errors on that page fail the demo. A demo folder without `smoke.mjs` fails. `SMOKE_ONLY=<id> npm run smoke` runs one demo and skips the home check. Smoke numbers are never performance claims.

## UI kit and demo page pattern

Styling lives in `src/style.css` (tokens, fonts, base, shell, legacy classes) and `src/ui/kit.css` (kit components). The learn pages add `src/learn/learn.css`. Tokens are CSS variables with a light set and a `prefers-color-scheme: dark` set: `--bg --surface --sunken --text --muted --border --accent --accent-soft --code-bg`. Fonts are self-hosted from npm (Pretendard Variable, JetBrains Mono). Body text is 17px with `word-break: keep-all` for Korean.

**Series palette.** Chart and legend colors are fixed per role, never picked per demo: `cpu-a` and `cpu-b` are warm (CPU-side work), `gpu-a`, `gpu-b` and `gpu-c` are cool (GPU-side work). Use `seriesVar(token)` for a swatch and `SeriesToken` for chart series. render-compare maps svg to `cpu-a`, canvas2d to `cpu-b`, webgl2 to `gpu-a`, webgpu-cpu to `gpu-b`, webgpu-compute to `gpu-c`. Map a new demo's variants onto the same roles (a CPU baseline is warm, a GPU variant is cool).

**Kit API (`import { ... } from '../../ui'`).** Build demo DOM with these; do not hand-write styles for what they cover.

```ts
page({ title, lede, chapter?, eyebrow? }, ...children): HTMLElement   // article + header; `chapter` is a learn slug, the link appears once the chapter exists
section({ title }, ...children): HTMLElement                          // h2 block in the reading column
figure({ caption, wide?, width?, height? }): { el, stage, setCaption } // live stage, 1040px break-out, stage max-width = width
controls(...nodes) ; button({ label, variant?, onClick }) ; numberField({ label, value, min?, max?, step?, unit? }) -> { el, input, read() }
slider({ label, min, max, step?, value, format?, onInput? }) ; segmented({ label, options, value, onChange? }) -> { el, get, set }
checkList(items: CheckItem[], onChange?) -> { el, selected() }       // CheckItem: { id, label, hint?, disabledReason?, checked?, swatch? }
status(initial?) -> { el, set(text, tone?: 'info' | 'ok' | 'error') }  // the element has class .status
resultsTable(columns: { label, unit?, numeric? }[]) -> { el, setRows(string[][]) }  // wrapper has class .table; first column is the row header
chart({ title?, xLabel, yLabel, series: { label, color: SeriesToken, dashed? }[], logX?, logY?, height? }) -> { el, setData(xs, ys[][]) }  // uPlot, themed, resizes
callout(kind, body, title?)  // kind: 핵심 | 주의 | 해보기 | 측정 한계 | 용어
capsPanel(caps, extra?) -> { el, update(extra) } ; chapterLink(slug) ; livePreview(create, onError?) -> { start, suspend, resume }
```

**Demo page pattern.** Order, top to bottom: `page` header (title, lede, chapter link), a live `figure`, "무엇을 비교하나" (short text plus the variant `checkList`), "직접 측정하기" (`controls` and `status`), "결과" (max-N list, `resultsTable`, `chart`, `capsPanel`), `callout('측정 한계', ...)`, `callout('해보기', ...)`, closing `chapterLink`. Tables, charts and figures break out to 1040px on their own; text stays at 720px. The layout is one root: `root.replaceChildren(page(...))`.

**Alive on load.** The figure shows a running preview at a modest size using the best available variant, started with `livePreview(create)` where `create` returns a `FrameTarget`. It stops while the tab is hidden. Call `preview.suspend()` before every measurement (and clear the stage), `preview.resume()` after, so a preview never shares the GPU or main thread with a run. Measure in the figure's `stage` so the reader sees what is measured. The preview size follows `stage.clientWidth`; measurements keep their fixed scene size so numbers stay comparable. Expose `suspendPreview` and `resumePreview` on `window.__demo` (see render-compare `main.ts`) and have `smoke.mjs` wait for the preview to draw, then suspend it before it calls measurement hooks directly.

**Smoke selectors.** Keep the kit's class names that smoke can rely on: `.status` (one per page), `.table tbody tr`, `.chart canvas`, `.stage`. Button names are Korean labels, so keep them stable.

**Not yet on the kit.** A demo that has not been restyled still renders: its children get a padded 1040px column and the base classes (`.controls`, `.status`, `.table`, `.chart`, `.caps`, `.checks`, `.stage`) are themed. Restyling means replacing that DOM with the kit, not adding new classes.

**Learn pages.** `#/learn` and `#/learn/<slug>` render `docs/learn/*.md` (marked plus shiki, loaded lazily). Slug is the file name without `.md`. Front matter keys: `title`, `order`, `summary`, `demo`. Callouts are blockquotes whose first line is a bold label (`> **핵심**`). `NN-slug.md` links become routes, other relative links become GitHub URLs, `img/*.svg` is inlined so `currentColor` follows the theme.

## Adding a demo

Create `src/demos/<id>/`. Read `src/demos/render-compare/` as the example (it is the reference for the kit and the page pattern above).

1. `meta.ts`: `export const meta: DemoMeta = { id, title, summary, order }`, Korean `title` and `summary`. The home page loads every `meta.ts` eagerly, so import only types here (`import type { DemoMeta } from '../../core/demo'`).
2. `main.ts`: `export const mount: MountDemo = async (root, caps) => { ... }`. Set `window.__demo = { ...hooks }` first, then render into `root`. Do not touch the DOM outside `root`. The page reloads on hash change, so no teardown is needed.
3. Hooks: expose what `smoke.mjs` needs to run your measurement from `page.evaluate` and read plain JSON back (variant registry, a run function, a verify function). Frame-loop demos implement `FrameTarget` and measure with `runFrames` from `core/frame-bench`. Import what you need from `core/` (`capabilities`, `stats`, `rng`, `gpu-timer`, `frame-loop`, `oneshot`) instead of copying it.
4. `smoke.mjs`: `export default async function smoke({ page, caps, url, log, fail }) {}`. `caps` is the page's `Capabilities` as JSON. Run each variant at a small size; call `fail(msg)` on any wrong result (bad shape, non-finite numbers, failed correctness check); skip WebGPU-only variants when `caps.webgpu.kind !== 'available'`; `log` a summary table. Do not call `process.exit`. The runner reports console errors.
5. UI text is Korean; code, identifiers and commit messages are English. Vanilla TS, no framework. Build the page from `src/ui/` as described above. Do not edit `src/style.css` or `src/ui/`; if the kit lacks something, put a small `<style>` element in your `mount` for that one thing and report the gap.
6. Pure logic gets a `*.test.ts` next to it (vitest picks up `src/**/*.test.ts`).
7. Edit nothing outside your folder. If you need a change in `core/`, the kit or the shell, stop and report it.
8. Bar before you hand back: `npm run typecheck`, `npm run test`, `npm run build` and `SMOKE_ONLY=<id> npm run smoke` pass, then the full `npm run smoke` passes once and its home check lists your demo.

## Adding a compute workload

Create only `src/demos/compute-bench/workloads/<id>/index.ts` (plus more files and tests in that folder). Read `workloads/reduction/index.ts` as the example. No other file changes: the UI, chart, crossover text and smoke discover it.

1. `export const workload: Workload<I, O>` (from `core/oneshot`). `id` equals the folder name. Fields: `label` and `summary` (Korean), `sizes` (default sweep, ascending, wide enough to show the small-n loss), `smokeSizes` (2 to 3 tiny sizes; every impl finishes each in well under a second), `sizeLabel(n)`, `makeInput(n, seed)` (deterministic, use `core/rng`), `impls`, `verify`, optional `work(n)` (`amount` in `unit`, shown as `unit/s`).
2. Impls: at least one `kind: 'cpu'` baseline that is a fair, straightforward implementation, and at least one `kind: 'gpu'`. Set `maxN` on an impl that cannot run at the largest sizes (memory, 65535 workgroups per dispatch dimension, buffer limits); `smokeSizes` must stay under it.
3. GPU impl: `prepare(device, input)` creates the pipeline (`createComputePipelineAsync`) and every buffer, and returns a `GpuRun`. `upload()` only writes the input (`queue.writeBuffer`). Create nothing in `upload`, `encode` or `readback`. `encode(encoder, ts)` records every pass (timestamp writes as above), then `copyBufferToBuffer`s the result into a `MAP_READ | COPY_DST` buffer. `readback()` maps, copies out (`getMappedRange().slice(0)`), unmaps and returns the decoded output. `dispose()` destroys every buffer. The harness calls `upload`, `encode` and `readback` 12 or more times on one `GpuRun`, so each run must overwrite its own outputs fully.
4. `verify(input, output)` is yours: compare against a trusted reference (an f64 or exact CPU computation), state the tolerance and why in `detail`, return `{ ok, detail }`. Sampling is fine for expensive references (GEMM) if `detail` says so. It runs twice per (impl, n) outside the timed region, so an O(n) reference is fine and anything costlier should be sampled.
5. CPU and GPU impls return the same `O`, so one `verify` judges both.
6. Bar before you hand back: `npm run typecheck`, `npm run test`, `npm run build` pass; `SMOKE_ONLY=compute-bench npm run smoke` shows your workload's rows as PASS for every impl; and run the default sweep once (`await page.evaluate(() => window.__demo.runSweep('<id>'))` at `#/compute-bench` in headless Chromium, or the UI) and report n, impl, e2e median, kernel median, check and crossover text. Say whether the curve has the expected shape and what limits the GPU at the largest n. Headless numbers are smoke, not performance claims.
