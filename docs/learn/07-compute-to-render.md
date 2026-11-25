---
title: 계산 결과를 바로 그리기 (N-body)
order: 7
summary: 컴퓨트 패스가 쓴 스토리지 버퍼를 렌더 패스가 그대로 읽어, 매 프레임 CPU로 읽어 오지 않고 N체 중력 시뮬레이션을 그립니다.
demo: nbody
---

# 계산 결과를 바로 그리기 (N-body)

이 장을 읽고 나면 컴퓨트 셰이더가 계산한 결과를 CPU로 읽어 오지 않고 같은 프레임 안에서 바로 그리는 구조를 이해할 수 있습니다. 상태를 버퍼 두 개에 번갈아 쓰는 핑퐁(ping-pong)과, 교과서적인 최적화인 타일링이 실제 기기에서는 이기지 못한 측정 결과도 함께 봅니다. N-body 데모를 열어 두고 읽으세요.

앞 장에서 배운 것을 그대로 씁니다. API 흐름은 [WebGPU 첫걸음](01-webgpu-basics.md), 인스턴싱과 블렌딩은 [렌더 파이프라인](02-render-pipeline.md), 워크그룹과 디스패치는 [리덕션](03-compute-reduction.md), `var<workgroup>`과 `workgroupBarrier`는 [워크그룹 메모리](04-workgroup-memory.md)에서 설명했습니다.

## 데모가 비교하는 세 가지

데모는 2차원 원반에 놓인 물체 N개가 서로 모두에게 중력을 받는 시뮬레이션입니다. 같은 일을 세 가지로 구현합니다.

- `cpu-js`: 메인 스레드의 JS 이중 루프로 계산합니다.
- `gpu-naive`: 물체 하나당 스레드 하나가 스토리지 버퍼에서 모든 물체를 직접 읽습니다.
- `gpu-tiled`: 워크그룹이 물체를 256개씩 `var<workgroup>` 타일에 올려 공유합니다.

세 변형 모두 같은 WebGPU 렌더러로 점을 그립니다. 그래서 그리기 비용은 같고, 차이는 시뮬레이션 계산에서만 나옵니다.

## N-body에서 GPU가 크게 이기는 이유

모든 쌍을 계산하면 한 스텝의 일이 N²입니다. N=16,384이면 약 2.7억 쌍입니다. 쌍 하나에는 뺄셈, 제곱, `inverseSqrt`, 곱셈, 누적을 합쳐 부동소수점 연산이 약 20개 듭니다.

데이터는 그만큼 늘지 않습니다. 위치는 물체당 8바이트(`x`, `y` 두 개의 f32)이므로 전체가 N×8바이트입니다. 읽은 위치 하나를 N번 다시 쓰므로, 읽은 바이트당 연산 수인 산술 강도(arithmetic intensity)가 N에 비례해 커집니다. 이런 일은 메모리 대역폭보다 연산 장치 수가 속도를 정합니다. [00장](00-why-gpu.md)의 기준으로 보면 GPU에 가장 유리한 모양입니다. 읽은 값을 한 번씩만 쓰는 [리덕션](03-compute-reduction.md)과 정반대입니다.

물체끼리는 서로 기다리지 않습니다. 물체 i의 가속도는 "이전 스텝의 모든 위치"만 읽습니다. 그래서 스레드 N개를 동시에 돌려도 순서를 신경 쓸 필요가 없습니다.

## 물리 규칙

- 가속도: `a_i = (GM/N) · Σ_j (p_j - p_i) / (|p_j - p_i|² + ε²)^{3/2}`. ε는 softening 길이이고 `SIM.eps = 10`입니다. 두 물체가 겹쳐도 분모가 0이 되지 않고, i=j 항은 분자가 0이라 따로 빼지 않아도 됩니다.
- 적분: symplectic Euler(반암시적 오일러)입니다. `v ← v + a(p)·dt`로 속도를 먼저 갱신하고, 새 속도로 `p ← p + v·dt`를 계산합니다. 새 속도를 쓰는 점이 일반 오일러와 다르고, 이 덕분에 오래 돌려도 에너지가 한쪽으로 새지 않습니다.
- `dt = 1/60`로 고정합니다. 실제 시계를 쓰면 실행마다 결과가 달라져 CPU와 GPU를 비교할 수 없습니다.
- 초기 상태는 `core/rng`의 mulberry32로 만든 원반입니다. 각 물체는 안쪽 질량에 맞는 원 궤도 속도로 돕니다.

CPU 기준 구현의 이중 루프입니다.

`src/demos/nbody/sim.ts` 44~56행
```ts
  for (let i = 0; i < count; i++) {
    const xi = src[i * 4]!;
    const yi = src[i * 4 + 1]!;
    let ax = 0;
    let ay = 0;
    for (let j = 0; j < count; j++) {
      const dx = src[j * 4]! - xi;
      const dy = src[j * 4 + 1]! - yi;
      const inv = 1 / Math.sqrt(dx * dx + dy * dy + eps2);
      const inv3 = inv * inv * inv;
      ax += dx * inv3;
      ay += dy * inv3;
    }
```

## 바깥 루프가 디스패치가 된다

GPU 커널로 옮길 때 바뀌는 것은 바깥 루프 하나입니다. `for (let i ...)`가 사라지고, 스레드마다 `global_invocation_id.x`로 자기 `i`를 받습니다. 안쪽 `j` 루프는 그대로 남습니다.

`src/demos/nbody/kernels.ts` 21~34행
```ts
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
```

`pull`과 `integrate`는 두 커널이 공유하는 `COMMON` 부분에 있습니다. JS의 `inv3` 계산과 속도, 위치 갱신이 그대로 옮겨져 있습니다.

`src/demos/nbody/kernels.ts` 10~19행
```ts
fn pull(d: vec2f) -> vec2f {
  let inv = inverseSqrt(dot(d, d) + p.eps2);
  return d * (inv * inv * inv);
}

fn integrate(me: vec4f, a: vec2f) -> vec4f {
  let v = me.zw + a * p.kdt;
  return vec4f(me.xy + v * p.dt, v);
}
`;
```

`NAIVE_WORKGROUP`은 64이고, 디스패치할 워크그룹 수는 `Math.ceil(count / workgroup)`입니다 (`gpu.ts`). N이 64의 배수가 아니면 마지막 워크그룹에 남는 스레드가 생기므로 `if (i >= p.n) { return; }`로 걸러 냅니다. 디스패치 크기 계산은 [03장](03-compute-reduction.md)에서 다룬 것과 같습니다.

`p.kdt`는 `(GM/N)·dt`를 CPU에서 미리 곱해 둔 값입니다. 유니폼 구조체 `Params { n: u32, dt: f32, kdt: f32, eps2: f32 }`는 u32와 f32가 섞여 있어서, JS에서는 `ArrayBuffer` 하나에 뷰 두 개를 겹쳐 씁니다.

`src/demos/nbody/gpu.ts` 50~54행
```ts
  const params = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const raw = new ArrayBuffer(16);
  new Uint32Array(raw)[0] = count;
  new Float32Array(raw).set([SIM.dt, (SIM.gm / count) * SIM.dt, SIM.eps * SIM.eps], 1);
  device.queue.writeBuffer(params, 0, raw);
```

## 상태를 버퍼 두 개에 두는 핑퐁

상태는 물체마다 `[x, y, vx, vy]`를 이어 붙인 `Float32Array`입니다. 물체 하나가 16바이트이고, WGSL에서는 `array<vec4f>`로 읽습니다. `.xy`가 위치, `.zw`가 속도입니다.

상태를 버퍼 하나에 두면 문제가 생깁니다. 스레드 i가 자기 위치를 덮어쓰는 순간, 아직 계산 중인 스레드 j가 그 새 위치를 읽을 수 있습니다. 어떤 스레드는 이전 스텝을, 어떤 스레드는 절반쯤 갱신된 상태를 보게 됩니다. 스레드 실행 순서는 정해져 있지 않으므로 결과가 실행마다 달라집니다.

그래서 버퍼를 두 개 두고, 한 스텝은 A에서 읽어 B에 쓰고 다음 스텝은 B에서 읽어 A에 씁니다. 이것이 핑퐁입니다. 셰이더 쪽에서는 `src`가 `var<storage, read>`, `dst`가 `var<storage, read_write>`입니다. 정렬 장의 [핑퐁 버퍼](06-multi-pass-sort.md)와 같은 아이디어입니다.

![컴퓨트 패스 안에서 버퍼 A와 B를 번갈아 읽고 쓰고, 렌더 패스가 마지막 버퍼를 읽는 그림](img/07-compute-to-render-pingpong.svg)

`createGpuSim`은 두 방향의 바인드 그룹을 미리 만들어 두고, 스텝마다 번갈아 끼웁니다.

`src/demos/nbody/gpu.ts` 56~80행
```ts
  const groups = [0, 1].map((from) =>
    device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: params } },
        { binding: 1, resource: { buffer: bufs[from]! } },
        { binding: 2, resource: { buffer: bufs[1 - from]! } },
      ],
    }),
  );

  const groupCount = Math.ceil(count / workgroup);
  let latest = 0;
  return {
    encodeSteps(encoder, steps, timestampWrites) {
      const pass = encoder.beginComputePass({ timestampWrites });
      pass.setPipeline(pipeline);
      for (let s = 0; s < steps; s++) {
        pass.setBindGroup(0, groups[latest]!);
        pass.dispatchWorkgroups(groupCount);
        latest = 1 - latest;
      }
      pass.end();
    },
    current: () => bufs[latest]!,
```

`groups[0]`은 `bufs[0]`을 읽어 `bufs[1]`에 쓰고, `groups[1]`은 그 반대입니다. `latest`는 최신 상태가 든 버퍼의 번호이고, `current()`가 그 버퍼를 돌려줍니다. CPU의 `runCpu`도 `[a, b] = [b, a]`로 같은 일을 합니다.

스텝 여러 개가 컴퓨트 패스 하나 안의 디스패치 여러 번으로 들어갑니다. 두 번째 디스패치는 첫 번째가 쓴 값을 읽어야 하는데, WebGPU는 같은 큐의 명령을 기록한 순서대로 실행하고 앞 디스패치의 쓰기를 뒤 디스패치에 보이게 합니다. 컴퓨트 패스에서는 디스패치마다 사용 범위(usage scope)를 따로 검사하므로, 같은 버퍼를 한 디스패치에서는 `read`로, 다음 디스패치에서는 `read_write`로 묶어도 검증 오류가 나지 않습니다. 패스 사이의 가시성은 [06장](06-multi-pass-sort.md)에서 더 자세히 다룹니다.

> **해보기**
> 데모의 "스텝/프레임"을 1에서 8로 올리고 "고정 N 실행"을 누르세요. GPU 변형은 컴퓨트 패스 하나에 디스패치가 8번 기록됩니다. 실효 프레임 시간이 16.7ms 안에 머무는 동안은 표의 스텝/초가 8배가 됩니다. `cpu-js`는 JS 루프가 8번 돌기 때문에 실효 프레임 시간이 늘어납니다.

## 렌더 패스가 같은 버퍼를 읽어 그린다

상태 버퍼의 usage에는 `STORAGE`가 들어 있습니다.

`src/demos/nbody/gpu.ts` 46~48행
```ts
  const stateUsage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
  const bufs = [0, 1].map(() => device.createBuffer({ size: initial.byteLength, usage: stateUsage }));
  device.queue.writeBuffer(bufs[0]!, 0, initial as GPUAllowSharedBufferSource);
```

`STORAGE`는 컴퓨트 셰이더 전용 플래그가 아닙니다. 버텍스 셰이더도 스토리지 버퍼를 바인딩할 수 있습니다. 다만 버텍스 단계에서는 읽기 전용(`var<storage, read>`)만 허용됩니다. `COPY_DST`는 초기 상태를 `writeBuffer`로 올리기 위해, `COPY_SRC`는 검증할 때 읽어 오기 위해 붙였습니다.

점을 그리는 셰이더는 [02장](02-render-pipeline.md)의 인스턴싱 그대로입니다. 인스턴스 하나가 물체 하나이고, 버텍스 6개로 사각형 하나를 만듭니다. 위치는 버텍스 버퍼가 아니라 `bodies[ii]`에서 직접 읽습니다.

`src/demos/nbody/kernels.ts` 61~79행
```ts
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
```

그리기 호출은 `pass.draw(6, count)` 한 번입니다. 블렌딩은 `srcFactor: 'one', dstFactor: 'one'`인 덧셈이라, 물체가 겹친 곳이 밝아집니다. 렌더러의 바인드 그룹은 버퍼별로 `Map`에 캐시합니다. `current()`가 `bufs[0]`과 `bufs[1]` 사이를 오가므로 바인드 그룹도 두 개면 충분합니다.

## 한 인코더, 한 번의 제출, 읽기 없음

GPU 변형의 `frame()`은 다음이 전부입니다.

`src/demos/nbody/variants.ts` 78~83행
```ts
      frame() {
        const encoder = device.createCommandEncoder();
        sim.encodeSteps(encoder, stepsPerFrame, timer?.first);
        drawer.encode(encoder, sim.current(), timer?.last);
        finish(device, encoder, drawer);
      },
```

커맨드 인코더 하나에 컴퓨트 패스와 렌더 패스를 차례로 기록하고, `finish()` 안에서 `queue.submit`을 한 번 부릅니다. 같은 큐 안의 패스는 기록 순서대로 실행되므로 렌더 패스는 컴퓨트 패스가 쓴 최신 위치를 읽습니다. 이 사이에 CPU가 할 일은 없습니다.

이 루프에는 `mapAsync`가 없습니다. CPU는 물체가 어디 있는지 몰라도 됩니다. GPU 메모리를 원격 서버라고 생각하면, `writeBuffer`는 업로드이고 `mapAsync`는 다운로드입니다. 이 프레임 루프는 업로드도 다운로드도 하지 않고 명령만 보냅니다. [01장](01-webgpu-basics.md)에서 본 readback은 `await`로 GPU가 끝나기를 기다려야 해서, 매 프레임 하면 CPU와 GPU가 서로를 기다리게 됩니다.

![cpu-js는 매 프레임 상태를 GPU로 올리고, GPU 변형은 명령만 보내며 상태는 GPU에 머무는 그림](img/07-compute-to-render-paths.svg)

`cpu-js`는 반대 방향입니다. JS에서 스텝을 돌린 뒤 결과를 `writeBuffer`로 올리고 같은 렌더러로 그립니다.

`src/demos/nbody/variants.ts` 52~61행
```ts
    frame() {
      for (let s = 0; s < stepsPerFrame; s++) {
        stepCpu(a, b, count);
        [a, b] = [b, a];
      }
      device.queue.writeBuffer(stateBuf, 0, a as GPUAllowSharedBufferSource);
      const encoder = device.createCommandEncoder();
      drawer.encode(encoder, stateBuf, drawer.timer?.only);
      finish(device, encoder, drawer);
    },
```

올리는 양은 N×16바이트입니다. N=8,192이면 128KiB(계산값)이고, 이 크기의 업로드는 이 데모에서 병목이 아닙니다. `cpu-js`가 느린 이유는 업로드가 아니라 `stepCpu`의 N² 루프입니다.

데이터를 CPU로 읽어 오는 곳은 `verify.ts` 하나입니다. 정확도를 확인할 때 한 번만 `copyBufferToBuffer`로 `MAP_READ` 버퍼에 복사한 뒤 `mapAsync`합니다.

`src/demos/nbody/verify.ts` 23~33행
```ts
async function readBack(device: GPUDevice, source: GPUBuffer, byteLength: number): Promise<Float32Array> {
  const staging = device.createBuffer({ size: byteLength, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const encoder = device.createCommandEncoder();
  encoder.copyBufferToBuffer(source, 0, staging, 0, byteLength);
  device.queue.submit([encoder.finish()]);
  await staging.mapAsync(GPUMapMode.READ);
  const out = new Float32Array(staging.getMappedRange().slice(0));
  staging.unmap();
  staging.destroy();
  return out;
}
```

> **핵심**
> 계산 결과를 화면에 그릴 거라면 결과를 GPU 밖으로 꺼내지 않습니다. 컴퓨트가 쓴 스토리지 버퍼를 렌더 패스가 그대로 바인딩해서 읽습니다.

## 타일링이 항상 빠르지는 않다

순진한 커널은 스레드마다 `src[j]`를 N번 읽으므로 전역 메모리 읽기가 N²번입니다. 타일링 커널은 GPU Gems 3의 31장 방식으로 이 횟수를 줄입니다. 원리는 [04장](04-workgroup-memory.md)의 행렬 곱 타일링과 같습니다.

`src/demos/nbody/kernels.ts` 37~58행
```ts
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
```

1. 워크그룹의 스레드 256개가 각자 물체 하나의 위치를 `tile[lid]`에 올립니다.
2. 첫 번째 `workgroupBarrier()`에서 모두 올릴 때까지 기다립니다.
3. 각 스레드가 타일의 물체 256개와의 힘을 계산합니다. 읽기는 워크그룹 메모리에서 합니다.
4. 두 번째 `workgroupBarrier()`에서 모두 다 읽을 때까지 기다립니다. 이 배리어가 없으면 빠른 스레드가 다음 타일을 올리면서 아직 읽는 중인 값을 덮어씁니다.
5. 다음 타일로 넘어갑니다.

전역 메모리 읽기는 N²에서 N²/256으로 줄어듭니다. 순진한 커널과 달리 범위 밖 스레드도 `return`하지 않습니다. 배리어는 워크그룹의 모든 스레드가 같이 지나야 하므로, `inRange`로 로드와 쓰기만 건너뜁니다. 마지막 타일이 덜 찼을 때를 위해 안쪽 루프 상한은 `min(256, n - base)`입니다.

여기까지는 교과서대로입니다. 그런데 이 저장소의 측정에서는 타일링 커널이 순진한 커널을 이기지 못했습니다 (아래 표). 원인은 확인하지 않았습니다. 가능성이 큰 설명은 이렇습니다. 순진한 커널에서 같은 워크그룹의 스레드들은 같은 순간에 같은 `src[j]`를 읽습니다. 같은 주소에 대한 읽기를 하드웨어나 캐시가 한 번으로 합쳐 주면, 순진한 커널도 실제 메모리 트래픽이 이미 적습니다. 그러면 타일링이 줄여 줄 몫이 별로 없고, 배리어 비용만 남습니다. 이 구현이 `vec2f` 타일 하나만 쓰고 안쪽 루프를 펼치지 않은 것도 최적화의 끝이 아니라는 뜻입니다.

> **주의**
> "공유 메모리 타일링은 빠르다"는 일반론은 기기마다 맞을 수도, 틀릴 수도 있습니다. Apple M1에서 이 커널은 이득이 없었습니다. 별도 VRAM이 있는 GPU에서 결과가 다를 수 있으므로, 목표 기기에서 재 보고 판단하세요.

> **해보기**
> `kernels.ts`의 `TILE`을 128이나 64로 바꾸고 "최대 N 찾기"를 다시 돌려 보세요. `TILE`은 타일 크기이면서 워크그룹 크기이기도 합니다. 512로 올리면 기본 한도 `maxComputeInvocationsPerWorkgroup`(256)을 넘어서 파이프라인 생성이 실패합니다.

> **해보기**
> 타일 루프의 두 번째 `workgroupBarrier()`를 지우고 "정확도 검증"을 눌러 보세요. 경합이 실제로 일어나면 오차가 허용치를 넘습니다. 통과하더라도 코드가 맞다는 뜻은 아닙니다. 경합은 타이밍에 따라 드러나기도, 숨기도 합니다.

## 결과 읽기

헤드리스 Chromium, Apple M1, 1회 측정, 참고용입니다. 다른 GPU 작업이 동시에 돌던 상태였고 주사율은 약 60Hz였습니다. 숫자는 흔들리므로 경향만 보세요.

| 변형 | 60Hz 유지 최대 N | N=8,192 실효 프레임(ms) | N=65,536 실효 프레임(ms) |
|---|---|---|---|
| cpu-js | 약 2,750 | 120.0 | 측정 안 함 |
| gpu-naive | 약 26,000 | 17.0 (주사율에 묶임) | 102.6 |
| gpu-tiled | 약 25,000 | 16.9 (주사율에 묶임) | 105.1 |

- **최대 N.** 프레임 간격 중앙값, 드롭 비율, 실효 프레임 시간이 모두 기준 안인 가장 큰 N입니다. N을 두 배씩 키우다 실패하면 이분 탐색하고, 상한은 262,144입니다. 일이 N²이므로 N이 2배면 필요한 시간은 4배입니다.
- **CPU와 GPU의 차이.** GPU는 CPU보다 약 9.5배 큰 N을 유지합니다. 쌍 수로는 약 90배입니다.
- **N=8,192.** CPU는 120ms라 초당 8프레임 남짓입니다. GPU 변형은 GPU 시간이 약 5ms인데 실효 프레임은 약 17ms입니다. GPU가 빨리 끝나도 `requestAnimationFrame`이 프레임을 주사율(16.7ms)에 묶기 때문입니다. 이 구간의 스텝/초는 실제 처리량이 아니라 하한입니다.
- **N=65,536.** 두 커널 모두 약 100ms입니다. 초당 약 4×10¹⁰쌍이고, 쌍당 20 FLOP으로 환산하면 약 0.8 TFLOP/s입니다. 이 정도면 메모리보다 연산 장치가 먼저 찬 것으로 추정합니다 (측정으로 확인하지 않은 추론입니다). 연산이 한계라면 메모리 읽기를 줄이는 타일링이 이기지 못하는 것과도 맞습니다.
- **gpu 시간 열.** 컴퓨트 패스 시작부터 렌더 패스 끝까지의 timestamp-query 차이입니다. 그리기 비용이 포함됩니다.

실효 프레임 시간, rAF가 처리량을 가리는 문제, timestamp-query의 의미는 [09장](09-measuring.md)에서 자세히 다룹니다.

> **해보기**
> N을 8,192로 두고 "스텝/프레임"을 4, 8, 16으로 올려 보세요. GPU 변형의 실효 프레임 시간이 16.7ms를 넘기 시작하는 지점에서 비로소 진짜 처리량이 보입니다.

## 정확도 검증은 10스텝만

`verifyNBody`는 같은 시드(1234)로 N=4,096 물체를 만들고, CPU와 각 GPU 커널로 10스텝씩 돌린 뒤 위치의 최대 절대 오차를 봅니다. CPU는 f64로 누적하고 f32로 저장하며, GPU는 f32로 계산합니다. 합산 순서도 다릅니다.

스텝 수를 작게 잡은 이유는 중력의 성질에 있습니다. 두 물체가 가까이 스쳐 지나가면, 위치의 작은 차이가 궤도를 크게 바꿉니다. 반올림 차이가 스텝마다 증폭되므로, 오래 돌리면 정상적인 CPU와 GPU도 크게 벌어집니다. 그러면 오차가 커도 버그인지 정상인지 구분할 수 없습니다.

- 허용 오차는 `VERIFY_TOLERANCE = 1e-3` px입니다.
- 이 기기에서 측정한 오차는 약 3e-5 px였습니다. 반지름 300 부근에서 f32 한 칸(1 ulp) 크기입니다.
- 타일 하나(물체 256개)를 빼먹는 버그는 CPU 실험에서 약 0.3 px의 오차를 냈습니다. 허용 오차는 측정 오차의 30배 여유를 두면서 이 버그보다 훨씬 작습니다.
- 물체 하나를 빼먹는 정도의 작은 버그는 이 검증으로 잡지 못합니다.

> **해보기**
> `sim.ts`의 `SIM.eps`를 10에서 1로 줄이고 검증을 다시 돌려 보세요. softening이 작으면 가까운 만남에서 힘이 더 커지고, CPU와 GPU의 오차도 커집니다. 허용치를 넘는지 확인해 보세요.

## 정리

- N-body는 쌍마다 약 20 FLOP을 쓰고 읽은 위치를 N번 재사용합니다. 산술 강도가 N에 비례하므로 GPU가 크게 이깁니다. 측정에서는 60Hz 유지 N이 약 9.5배였습니다.
- 상태는 스토리지 버퍼 두 개에 두고 스텝마다 읽기와 쓰기 버퍼를 바꿉니다. 한 스텝 안에서 모든 스레드가 같은 이전 상태를 봅니다.
- 렌더 패스의 버텍스 셰이더가 같은 스토리지 버퍼를 `var<storage, read>`로 읽습니다. 인코더 하나, 제출 한 번이고, 프레임마다 `mapAsync`는 없습니다.
- 타일링은 Apple M1에서 순진한 커널을 이기지 못했습니다. 최적화의 효과는 목표 기기에서 재야 압니다.
- 혼돈계의 정확도는 짧은 스텝으로 검증합니다. 길게 돌리면 정상적인 반올림 차이와 버그를 구분할 수 없습니다.

## 다음 장

[텍스처와 비디오로 만드는 실시간 필터](08-textures-video.md)에서는 버퍼 대신 텍스처를 쓰고, 비디오 프레임을 복사 없이 GPU로 가져와 필터를 거는 방법을 봅니다.
