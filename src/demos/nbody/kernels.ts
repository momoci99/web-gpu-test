export const NAIVE_WORKGROUP = 64;
export const TILE = 256;

const COMMON = /* wgsl */ `
struct Params { n: u32, dt: f32, kdt: f32, eps2: f32 }
@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var<storage, read> src: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> dst: array<vec4f>;

fn pull(d: vec2f) -> vec2f {
  let inv = inverseSqrt(dot(d, d) + p.eps2);
  return d * (inv * inv * inv);
}

fn integrate(me: vec4f, a: vec2f) -> vec4f {
  let v = me.zw + a * p.kdt;
  return vec4f(me.xy + v * p.dt, v);
}
`;

/** One invocation per body; every invocation streams all N bodies from the storage buffer. */
export const NAIVE_WGSL = /* wgsl */ `${COMMON}
@compute @workgroup_size(${NAIVE_WORKGROUP})
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= p.n) { return; }
  let me = src[i];
  var a = vec2f(0.0);
  for (var j = 0u; j < p.n; j++) {
    a += pull(src[j].xy - me.xy);
  }
  dst[i] = integrate(me, a);
}
`;

/** GPU Gems 3 ch. 31: each workgroup stages TILE bodies in shared memory, so global memory is read N/TILE times per workgroup, not N. */
export const TILED_WGSL = /* wgsl */ `${COMMON}
var<workgroup> tile: array<vec2f, ${TILE}>;

@compute @workgroup_size(${TILE})
fn main(@builtin(global_invocation_id) gid: vec3u, @builtin(local_invocation_index) lid: u32) {
  let i = gid.x;
  let inRange = i < p.n;
  var me = vec4f(0.0);
  if (inRange) { me = src[i]; }
  var a = vec2f(0.0);
  for (var base = 0u; base < p.n; base += ${TILE}u) {
    let j = base + lid;
    if (j < p.n) { tile[lid] = src[j].xy; }
    workgroupBarrier();
    let count = min(${TILE}u, p.n - base);
    for (var k = 0u; k < count; k++) {
      a += pull(tile[k] - me.xy);
    }
    workgroupBarrier();
  }
  if (inRange) { dst[i] = integrate(me, a); }
}
`;

export const DRAW_WGSL = /* wgsl */ `
struct Draw { half: f32, radiusNdc: f32, intensity: f32, pad: f32 }
@group(0) @binding(0) var<uniform> draw: Draw;
@group(0) @binding(1) var<storage, read> bodies: array<vec4f>;

struct VsOut { @builtin(position) pos: vec4f, @location(0) local: vec2f }

const CORNERS = array<vec2f, 6>(
  vec2f(-1, -1), vec2f(1, -1), vec2f(-1, 1),
  vec2f(-1, 1), vec2f(1, -1), vec2f(1, 1),
);

@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VsOut {
  let c = CORNERS[vi];
  var out: VsOut;
  out.pos = vec4f(bodies[ii].xy / draw.half + c * draw.radiusNdc, 0.0, 1.0);
  out.local = c;
  return out;
}

@fragment fn fs(in: VsOut) -> @location(0) vec4f {
  let a = draw.intensity * (1.0 - smoothstep(0.0, 1.0, length(in.local)));
  return vec4f(vec3f(1.0, 0.62, 0.3) * a, a);
}
`;
