import type { Capabilities } from '../../core/capabilities';
import { CpuFilter } from './cpu-filter';
import type { FilterParams } from './filters';
import { GpuFilter } from './gpu-filter';
import { createPatternCanvas } from './source';
import { requestFilterDevice } from './variants';

const WIDTH = 640;
const HEIGHT = 360;
const PATTERN_FRAME = 37;
// Both sides round to 8 bits at the end and clamp to the edge. The GPU keeps the blur's middle texture in float16
// (relative error 2^-11, under 0.13 levels at 255) and may fuse multiply-adds, so the sums differ by a fraction of a
// level and a rounding boundary can flip one level. A wrong tap, weight or edge rule moves pixels by many levels.
export const MAX_DIFF_TOLERANCE = 2;
export const MEAN_DIFF_TOLERANCE = 0.1;
const MIN_SPREAD = 16;

const CASES: readonly FilterParams[] = [
  { filter: 'grayscale', radius: 1 },
  { filter: 'blur', radius: 1 },
  { filter: 'blur', radius: 8 },
  { filter: 'blur', radius: 32 },
  { filter: 'sobel', radius: 1 },
];

export interface ParityCase extends FilterParams {
  maxAbsDiff: number;
  meanAbsDiff: number;
  /** Largest minus smallest RGB value in the CPU output; a flat image would make the comparison vacuous. */
  outputSpread: number;
  pass: boolean;
}

export interface ParityResult {
  pass: boolean;
  width: number;
  height: number;
  maxTolerance: number;
  meanTolerance: number;
  cases: ParityCase[];
}

export async function verifyParity(caps: Capabilities): Promise<ParityResult> {
  const canvas = createPatternCanvas(WIDTH, HEIGHT, PATTERN_FRAME);
  const src = canvas.getContext('2d')!.getImageData(0, 0, WIDTH, HEIGHT).data;
  const cpu = new CpuFilter(WIDTH, HEIGHT);

  const device = await requestFilterDevice(caps);
  try {
    const input = device.createTexture({
      size: { width: WIDTH, height: HEIGHT },
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    device.queue.copyExternalImageToTexture({ source: canvas }, { texture: input }, { width: WIDTH, height: HEIGHT });
    const filter = await GpuFilter.create(device, WIDTH, HEIGHT);
    const bytesPerRow = Math.ceil((WIDTH * 4) / 256) * 256;
    const readback = device.createBuffer({ size: bytesPerRow * HEIGHT, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });

    const cases: ParityCase[] = [];
    for (const params of CASES) {
      const expected = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
      cpu.run(src, expected, params);

      filter.setParams(params);
      const encoder = device.createCommandEncoder();
      filter.encode(encoder, { kind: 'texture', view: input.createView() });
      encoder.copyTextureToBuffer({ texture: filter.output }, { buffer: readback, bytesPerRow }, { width: WIDTH, height: HEIGHT });
      device.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ);
      const gpu = new Uint8Array(readback.getMappedRange().slice(0));
      readback.unmap();

      let max = 0;
      let sum = 0;
      let lo = 255;
      let hi = 0;
      for (let y = 0; y < HEIGHT; y++) {
        for (let x = 0; x < WIDTH; x++) {
          for (let c = 0; c < 4; c++) {
            const d = Math.abs(gpu[y * bytesPerRow + x * 4 + c]! - expected[(y * WIDTH + x) * 4 + c]!);
            if (d > max) max = d;
            sum += d;
            if (c < 3) {
              const e = expected[(y * WIDTH + x) * 4 + c]!;
              if (e < lo) lo = e;
              if (e > hi) hi = e;
            }
          }
        }
      }
      const mean = sum / (WIDTH * HEIGHT * 4);
      const spread = hi - lo;
      cases.push({ ...params, maxAbsDiff: max, meanAbsDiff: mean, outputSpread: spread, pass: spread >= MIN_SPREAD && max <= MAX_DIFF_TOLERANCE && mean <= MEAN_DIFF_TOLERANCE });
    }
    return { pass: cases.every((c) => c.pass), width: WIDTH, height: HEIGHT, maxTolerance: MAX_DIFF_TOLERANCE, meanTolerance: MEAN_DIFF_TOLERANCE, cases };
  } finally {
    device.destroy();
  }
}
