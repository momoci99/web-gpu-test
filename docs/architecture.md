# Architecture sketch — web-gpu-test, phase 1 (scaffold + harness + render-compare demo)

Goal: web project that demos where WebGPU gives measurable performance gains. Every demo pairs a fair non-WebGPU baseline. Phase 1 = scaffold, shared frame-benchmark harness, first demo "render-compare": the same bouncing-circles scene drawn by SVG, Canvas2D, WebGL2, WebGPU (CPU sim), WebGPU (compute sim).

## Stack

- Vite 8 + TypeScript 7 (vanilla, no UI framework: a framework's reconciliation would pollute SVG numbers). `@webgpu/types`, `uplot` for charts, `vitest` for pure-logic unit tests, `playwright` for a browser smoke script. Install every dep at its latest version (`npm view <pkg> version` at install time). Use current, non-deprecated APIs.
- Single page (`index.html` → `src/main.ts` mounts render-compare). No router until a second demo exists.

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
- `bench.ts`:
  - `estimateRefresh(): Promise<number>` median idle rAF interval over 60 frames → Hz.
  - `runFixed(entry, config, caps, { warmupFrames: 30, measureFrames: 120 }): Promise<RunResult>` — create, warm up (discarded: includes pipeline compile, first layout), measure, dispose. Collects `long-animation-frame` entries via PerformanceObserver during the measure window when supported.
  - `rampMaxN(trial: (n) => Promise<boolean>, { start: 1000, max: 2_000_000, precision: 0.05 })` — PURE search: double until fail, then bisect to precision. Unit-tested with a fake trial.
  - Pass criterion for a trial: median interval ≤ 1.1 × refresh period AND dropped ratio (interval > 1.5 × period) ≤ 5 %.

```ts
interface RunResult {
  rendererId: RendererId; count: number; refreshHz: number; frames: number;
  interval: Summary; cpu: Summary; gpu: Summary | null;
  longFrames: { count: number; totalBlockingMs: number } | null;
  droppedRatio: number;
}
```

Known measurement limits to surface in the UI text (not to hide):
- rAF caps at display refresh, so "max N at refresh Hz" is the headline, not fps.
- SVG cost is mostly style/layout/paint outside JS: cpuMs undercounts it; interval and LoAF capture it.
- WebGPU cpuMs = encode + submit only; GPU work shows in gpuMs and, when GPU-bound, in interval.
- Chrome quantizes timestamp-query (~100 µs) unless WebGPU Developer Features flag is on.

Deliberately not generalized: one-shot compute timing (GEMM, sort) is a different measurement; add it with the GEMM demo, not now.

## Correctness check (src/demos/render-compare/verify.ts)

`verifyComputeParity(caps)`: same seed, count 4096, run CPU `stepScene` and the WGSL compute pass 60 steps each, read back GPU state once, report max abs error; pass ≤ 1e-3. Exposed as a UI button and in the smoke script.

## UI (src/demos/render-compare/ui.ts)

Controls: renderer checkboxes (disabled + reason when unsupported), N input, "Run fixed N", "Find max N" (ramp each selected renderer), "Verify compute". Live stage area showing the renderer under test. Results table (RunResult fields) + uPlot chart (N vs median interval per renderer). Capabilities panel (WebGPU adapter, timestamp-query, LoAF, refresh Hz). Text in Korean.

## Verification lever

- `npm run test` (vitest): rng determinism, stepScene bounce rule, summarize, rampMaxN search.
- `npm run build` + `tsc --noEmit` clean.
- `scripts/smoke.mjs` (playwright Chromium, WebGPU flags as needed): start vite preview, open page, for each available renderer runFixed at small N, assert no console errors, RunResult shape sane, verifyComputeParity passes; print a summary table. Headless numbers are smoke only, never reported as performance claims.
