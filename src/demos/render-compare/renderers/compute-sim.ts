import { FIXED_DT, type SceneData } from '../scene';

const WORKGROUP_SIZE = 64;

// Mirrors stepScene in scene.ts. Keep the two in sync.
const STEP_WGSL = /* wgsl */ `
struct Params { size: vec2f, dt: f32, count: u32 }
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read_write> state: array<vec4f>;
@group(0) @binding(2) var<storage, read> radius: array<f32>;

@compute @workgroup_size(${WORKGROUP_SIZE}) fn step(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= params.count) { return; }
  let s = state[i];
  let r = radius[i];
  var pos = s.xy + s.zw * params.dt;
  var vel = s.zw;
  if (pos.x - r < 0.0) { pos.x = r; vel.x = abs(vel.x); }
  if (pos.x + r > params.size.x) { pos.x = params.size.x - r; vel.x = -abs(vel.x); }
  if (pos.y - r < 0.0) { pos.y = r; vel.y = abs(vel.y); }
  if (pos.y + r > params.size.y) { pos.y = params.size.y - r; vel.y = -abs(vel.y); }
  state[i] = vec4f(pos, vel);
}
`;

export interface ComputeSim {
  /** Interleaved [x, y, vx, vy] state, readable by render passes and copyable for readback. */
  readonly stateBuf: GPUBuffer;
  encodeStep(encoder: GPUCommandEncoder, timestampWrites?: GPUComputePassTimestampWrites): void;
}

export function createComputeSim(device: GPUDevice, scene: SceneData): ComputeSim {
  const { count, width, height } = scene.config;
  const stateBuf = device.createBuffer({
    size: scene.state.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
  });
  device.queue.writeBuffer(stateBuf, 0, scene.state);
  const radiusBuf = device.createBuffer({ size: scene.radius.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(radiusBuf, 0, scene.radius);

  const paramsData = new ArrayBuffer(16);
  new Float32Array(paramsData, 0, 3).set([width, height, FIXED_DT]);
  new Uint32Array(paramsData, 12, 1)[0] = count;
  const paramsBuf = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(paramsBuf, 0, paramsData);

  const pipeline = device.createComputePipeline({
    layout: 'auto',
    compute: { module: device.createShaderModule({ code: STEP_WGSL }), entryPoint: 'step' },
  });
  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: paramsBuf } },
      { binding: 1, resource: { buffer: stateBuf } },
      { binding: 2, resource: { buffer: radiusBuf } },
    ],
  });
  const workgroups = Math.ceil(count / WORKGROUP_SIZE);

  return {
    stateBuf,
    encodeStep(encoder, timestampWrites) {
      const pass = encoder.beginComputePass({ timestampWrites });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(workgroups);
      pass.end();
    },
  };
}
