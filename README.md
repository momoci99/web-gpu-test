# web-gpu-test

Demos of where WebGPU gives measurable gains over non-WebGPU baselines. Phase 1 is the shared frame-benchmark harness and the `render-compare` demo: one bouncing-circles scene drawn by SVG, Canvas2D, WebGL2, WebGPU with CPU simulation, and WebGPU with compute-shader simulation. The design is in [docs/architecture.md](docs/architecture.md).

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server |
| `npm run build` | Typecheck, then production build into `dist/` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run test` | Vitest unit tests for the pure logic (rng, `stepScene`, `summarize`, `rampMaxN`) |
| `npm run smoke` | Builds, previews, and drives every available renderer in Playwright Chromium, then runs `verifyComputeParity` |

First run of the smoke script needs a browser: `npx playwright install chromium`.

## Smoke script

`scripts/smoke.mjs` tries new headless Chromium with `--enable-unsafe-webgpu`, and falls back to a headed window when WebGPU has no adapter. Set `SMOKE_HEADED=1` to skip straight to headed. If WebGPU is still unavailable it says why, skips the WebGPU renderers, and still checks the rest. Its timings are smoke values at a tiny N in a headless browser. They are not performance results.

## Parity check

`verifyComputeParity` runs 60 steps on the CPU and in the WGSL compute pass and compares the final state. The tolerance is 1e-2 px: a GPU may fuse `v * dt + p` into one rounding, which drifts about 1 ulp per step (3.6e-3 px after 60 steps on Apple M1 / Metal), while a wrong bounce rule is off by whole pixels.
