# web-gpu-test

Demos of where WebGPU gives measurable gains over non-WebGPU baselines, and where it does not. Every demo pairs a fair CPU (or SVG, Canvas2D, WebGL2) baseline with one or more WebGPU variants, checks that both produce the same result, and explains its numbers. The design is in [docs/architecture.md](docs/architecture.md).

## Demos

Run `npm run dev` and pick a demo on the home page (`#/<id>`).

| Demo | What it compares | Learning note |
|---|---|---|
| `render-compare` | One bouncing-circles scene drawn by SVG, Canvas2D, WebGL2, WebGPU with CPU simulation, and WebGPU with a compute-shader simulation. Headline metric: max N that holds the display refresh rate. | [architecture.md](docs/architecture.md) |
| `compute-bench` | One-shot workloads, CPU vs GPU, swept over input size, with upload, kernel and readback timed separately and the CPU/GPU crossover size reported. | per workload below |
| `compute-bench` / `reduction` | Sum of n floats. Transfer-bound: the GPU kernel is fast, the upload is not. | (see architecture.md) |
| `compute-bench` / `gemm` | n×n matrix multiply: naive, workgroup-tiled, register-blocked kernels. | [gemm.md](docs/learn/gemm.md) |
| `compute-bench` / `radix-sort` | LSD radix sort: histogram, scan, stable scatter. | [radix-sort.md](docs/learn/radix-sort.md) |
| `compute-bench` / `binning2d` | 2D density histogram for large scatter plots: global vs workgroup-privatized atomics. | [binning2d.md](docs/learn/binning2d.md) |
| `nbody` | All-pairs 2D gravity: JS vs naive and tiled compute shaders. | [nbody.md](docs/learn/nbody.md) |
| `webcam-filter` | Blur, Sobel and grayscale on a camera or synthetic video: Canvas2D `getImageData` vs `importExternalTexture` + compute passes. | [webcam-filter.md](docs/learn/webcam-filter.md) |

Numbers quoted in the learning notes are headless Chromium smoke values on one Apple M1. Measure on your own machine in a normal browser window before drawing conclusions.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server |
| `npm run build` | Typecheck, then production build into `dist/` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run test` | Vitest unit tests for the pure logic |
| `npm run smoke` | Builds, previews, and runs every demo's `smoke.mjs` in Playwright Chromium. `SMOKE_ONLY=<id>` runs one demo. |

First run of the smoke script needs a browser: `npx playwright install chromium`.

## Smoke script

`scripts/smoke.mjs` tries new headless Chromium with `--enable-unsafe-webgpu` (plus a fake camera for `webcam-filter`), and falls back to a headed window when WebGPU has no adapter. Set `SMOKE_HEADED=1` to skip straight to headed. If WebGPU is still unavailable it says why, skips the WebGPU variants, and still checks the rest. Its timings are smoke values at small sizes. They are not performance results.

## Adding a demo or workload

Follow the checklists at the end of [docs/architecture.md](docs/architecture.md). A new demo or workload touches only its own folder.
