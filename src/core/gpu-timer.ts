const SLOTS = 4;
const QUERY_COUNT = 2;
const BYTES = QUERY_COUNT * 8;

export type TimestampWrites = GPUComputePassTimestampWrites & GPURenderPassTimestampWrites;

/**
 * Timestamp-query helper. Query 0 is the start of the first timed pass, query 1 the end of the last.
 * Results are read back through a small pool of mappable buffers and never awaited by the frame.
 */
export class GpuTimer {
  readonly first: TimestampWrites;
  readonly last: TimestampWrites;
  readonly only: TimestampWrites;

  #querySet: GPUQuerySet;
  #resolveBuf: GPUBuffer;
  #free: GPUBuffer[] = [];
  #all: GPUBuffer[] = [];
  #pending: GPUBuffer | null = null;
  #samples: number[] = [];
  #destroyed = false;

  constructor(device: GPUDevice) {
    this.#querySet = device.createQuerySet({ type: 'timestamp', count: QUERY_COUNT });
    this.#resolveBuf = device.createBuffer({ size: BYTES, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
    for (let i = 0; i < SLOTS; i++) {
      const b = device.createBuffer({ size: BYTES, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      this.#free.push(b);
      this.#all.push(b);
    }
    this.first = { querySet: this.#querySet, beginningOfPassWriteIndex: 0 };
    this.last = { querySet: this.#querySet, endOfPassWriteIndex: 1 };
    this.only = { querySet: this.#querySet, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 };
  }

  /** Call after the timed passes, before `encoder.finish()`. Skips the frame when every readback buffer is busy. */
  resolve(encoder: GPUCommandEncoder): void {
    const buf = this.#free.pop();
    if (!buf) return;
    encoder.resolveQuerySet(this.#querySet, 0, QUERY_COUNT, this.#resolveBuf, 0);
    encoder.copyBufferToBuffer(this.#resolveBuf, 0, buf, 0, BYTES);
    this.#pending = buf;
  }

  /** Call right after `queue.submit`. */
  afterSubmit(): void {
    const buf = this.#pending;
    if (!buf) return;
    this.#pending = null;
    buf
      .mapAsync(GPUMapMode.READ)
      .then(() => {
        const t = new BigUint64Array(buf.getMappedRange().slice(0));
        buf.unmap();
        const ns = Number(t[1]! - t[0]!);
        if (ns > 0) this.#samples.push(ns / 1e6);
        if (!this.#destroyed) this.#free.push(buf);
      })
      .catch(() => {});
  }

  drain(): number[] {
    const out = this.#samples;
    this.#samples = [];
    return out;
  }

  destroy(): void {
    this.#destroyed = true;
    this.#querySet.destroy();
    this.#resolveBuf.destroy();
    for (const b of this.#all) b.destroy();
  }
}

export function createGpuTimer(device: GPUDevice): GpuTimer | null {
  return device.features.has('timestamp-query') ? new GpuTimer(device) : null;
}
