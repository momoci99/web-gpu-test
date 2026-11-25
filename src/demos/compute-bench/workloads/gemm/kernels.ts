export const TILE = 16;
export const BLOCK = 4;
export const BLOCK_TILE = TILE * BLOCK;

export const NAIVE_WGSL = /* wgsl */ `
struct Params { n: u32 }
@group(0) @binding(0) var<storage, read> a: array<f32>;
@group(0) @binding(1) var<storage, read> b: array<f32>;
@group(0) @binding(2) var<storage, read_write> c: array<f32>;
@group(0) @binding(3) var<uniform> params: Params;

@compute @workgroup_size(${TILE}, ${TILE})
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let n = params.n;
  if (gid.x >= n || gid.y >= n) { return; }
  var acc = 0.0;
  for (var k = 0u; k < n; k++) {
    acc += a[gid.y * n + k] * b[k * n + gid.x];
  }
  c[gid.y * n + gid.x] = acc;
}
`;

export const TILED_WGSL = /* wgsl */ `
struct Params { n: u32 }
@group(0) @binding(0) var<storage, read> a: array<f32>;
@group(0) @binding(1) var<storage, read> b: array<f32>;
@group(0) @binding(2) var<storage, read_write> c: array<f32>;
@group(0) @binding(3) var<uniform> params: Params;

var<workgroup> tileA: array<f32, ${TILE * TILE}>;
var<workgroup> tileB: array<f32, ${TILE * TILE}>;

@compute @workgroup_size(${TILE}, ${TILE})
fn main(
  @builtin(workgroup_id) wg: vec3u,
  @builtin(local_invocation_id) lid: vec3u,
) {
  let n = params.n;
  let row = wg.y * ${TILE}u + lid.y;
  let col = wg.x * ${TILE}u + lid.x;
  var acc = 0.0;
  let tiles = (n + ${TILE - 1}u) / ${TILE}u;
  for (var t = 0u; t < tiles; t++) {
    let ak = t * ${TILE}u + lid.x;
    let bk = t * ${TILE}u + lid.y;
    tileA[lid.y * ${TILE}u + lid.x] = select(0.0, a[row * n + ak], row < n && ak < n);
    tileB[lid.y * ${TILE}u + lid.x] = select(0.0, b[bk * n + col], bk < n && col < n);
    workgroupBarrier();
    for (var k = 0u; k < ${TILE}u; k++) {
      acc += tileA[lid.y * ${TILE}u + k] * tileB[k * ${TILE}u + lid.x];
    }
    workgroupBarrier();
  }
  if (row < n && col < n) { c[row * n + col] = acc; }
}
`;

export const BLOCKED_WGSL = /* wgsl */ `
struct Params { n: u32 }
@group(0) @binding(0) var<storage, read> a: array<f32>;
@group(0) @binding(1) var<storage, read> b: array<f32>;
@group(0) @binding(2) var<storage, read_write> c: array<f32>;
@group(0) @binding(3) var<uniform> params: Params;

const T = ${TILE}u;
const R = ${BLOCK}u;
const BT = ${BLOCK_TILE}u;

var<workgroup> tileA: array<f32, ${BLOCK_TILE * TILE}>;
var<workgroup> tileB: array<f32, ${TILE * BLOCK_TILE}>;

@compute @workgroup_size(${TILE}, ${TILE})
fn main(
  @builtin(workgroup_id) wg: vec3u,
  @builtin(local_invocation_id) lid: vec3u,
) {
  let n = params.n;
  let tid = lid.y * T + lid.x;
  let rowBase = wg.y * BT;
  let colBase = wg.x * BT;
  var acc: array<f32, ${BLOCK * BLOCK}>;
  let tiles = (n + T - 1u) / T;
  for (var t = 0u; t < tiles; t++) {
    for (var r = 0u; r < R; r++) {
      let idx = tid + r * ${TILE * TILE}u;
      let ar = idx / T;
      let ak = idx % T;
      let gr = rowBase + ar;
      let gk = t * T + ak;
      tileA[idx] = select(0.0, a[gr * n + gk], gr < n && gk < n);
      let bk = idx / BT;
      let bc = idx % BT;
      let gbk = t * T + bk;
      let gc = colBase + bc;
      tileB[idx] = select(0.0, b[gbk * n + gc], gbk < n && gc < n);
    }
    workgroupBarrier();
    for (var k = 0u; k < T; k++) {
      var ra: array<f32, ${BLOCK}>;
      var rb: array<f32, ${BLOCK}>;
      for (var i = 0u; i < R; i++) {
        ra[i] = tileA[(lid.y * R + i) * T + k];
        rb[i] = tileB[k * BT + lid.x * R + i];
      }
      for (var i = 0u; i < R; i++) {
        for (var j = 0u; j < R; j++) {
          acc[i * R + j] += ra[i] * rb[j];
        }
      }
    }
    workgroupBarrier();
  }
  for (var i = 0u; i < R; i++) {
    for (var j = 0u; j < R; j++) {
      let gr = rowBase + lid.y * R + i;
      let gc = colBase + lid.x * R + j;
      if (gr < n && gc < n) { c[gr * n + gc] = acc[i * R + j]; }
    }
  }
}
`;
