---
title: 리덕션으로 배우는 컴퓨트 셰이더
order: 3
summary: 숫자 N개의 합을 GPU로 구하면서 워크그룹, 호출 ID, 디스패치 크기 계산, 트리 리덕션, 여러 패스를 익히고, 이 작업에서 GPU가 CPU를 이기지 못하는 이유를 봅니다.
demo: compute-bench
---

# 리덕션으로 배우는 컴퓨트 셰이더

이 장을 읽고 나면 컴퓨트 셰이더가 수많은 스레드에 일을 나누는 방법을 설명할 수 있습니다. 워크그룹과 호출 ID, 디스패치 크기 계산, 값 여러 개를 하나로 줄이는 트리 리덕션을 다룹니다. 마지막으로 이 작업에서 GPU가 측정한 모든 크기에서 CPU에 지는 이유를 숫자로 봅니다. `compute-bench` 데모를 열고 워크로드에서 **리덕션 (f32 합계)**를 고르세요.

[1장](01-webgpu-basics.md)에서 배운 컴퓨트 파이프라인, 바인드 그룹, `dispatchWorkgroups`, `mapAsync` readback은 다시 설명하지 않습니다. 코드는 모두 `src/demos/compute-bench/workloads/reduction/index.ts`에 있습니다.

## 합계를 병렬로 만들기 어려운 이유

CPU 구현은 루프 한 줄입니다.

```ts
// src/demos/compute-bench/workloads/reduction/index.ts (39-43행)
  run(input) {
    let s = 0;
    for (let i = 0; i < input.length; i++) s += input[i]!;
    return s;
  },
```

이 루프는 매 반복이 앞 반복의 `s`를 기다립니다. n = 2^24면 반복 약 1,677만 번이 한 줄로 이어진 의존 사슬입니다. 스레드 수천 개가 있어도 이 순서대로라면 한 번에 덧셈 하나만 할 수 있습니다.

덧셈은 순서를 바꿔도 결과가 같습니다(부동소수점 반올림 오차는 뒤에서 다룹니다). 그래서 사슬 하나를 여러 개로 쪼갤 수 있습니다. 스레드마다 일부를 더하고, 그 부분합들을 다시 더하고, 하나가 남을 때까지 반복합니다. 값 여러 개를 연산 하나로 줄여 값 하나를 만드는 작업을 리덕션(reduction)이라고 부릅니다. 합계, 최댓값, 최솟값이 모두 리덕션입니다.

## 워크그룹과 호출

컴퓨트 셰이더 함수는 한 번만 실행되지 않습니다. GPU가 같은 함수를 수많은 스레드에서 동시에 실행합니다. WebGPU는 이 스레드 하나하나를 호출(invocation)이라고 부르고, 호출을 일정한 크기로 묶은 단위를 워크그룹(workgroup)이라고 부릅니다.

- `@workgroup_size(256)`은 워크그룹 하나에 호출 256개를 넣으라는 뜻입니다. 셰이더 코드에 적는 고정값입니다.
- `pass.dispatchWorkgroups(g)`는 워크그룹 g개를 띄우라는 뜻입니다. JS에서 정하는 값입니다.
- 전체 호출 수는 g × 256입니다.

같은 워크그룹 안의 호출끼리는 빠른 공유 메모리(`var<workgroup>`)를 함께 쓰고 서로를 기다릴 수 있습니다. 다른 워크그룹의 호출과는 둘 다 할 수 없습니다. 이 제약이 리덕션 설계 전체를 결정합니다.

> **용어**
> 호출(invocation)은 셰이더 함수의 실행 하나입니다. 이 문서에서는 "스레드"와 같은 뜻으로 씁니다. 워크그룹(workgroup)은 메모리를 공유하고 서로 동기화할 수 있는 호출의 묶음입니다.

## 호출이 자기 위치를 아는 방법

모든 호출이 같은 코드를 실행하므로, 각자 다른 데이터를 처리하려면 자기 번호를 알아야 합니다. WGSL은 이 번호를 내장 값(builtin)으로 줍니다. 1차원 디스패치(`dispatchWorkgroups(g)`)에서는 `.x` 성분만 의미가 있습니다.

| builtin | 타입 | 의미 | 범위 (크기 256, 워크그룹 g개) |
|---|---|---|---|
| `workgroup_id` | `vec3u` | 이 호출이 속한 워크그룹 번호 | `.x`는 0 ~ g-1 |
| `local_invocation_id` | `vec3u` | 워크그룹 안에서의 번호 | `.x`는 0 ~ 255 |
| `local_invocation_index` | `u32` | 워크그룹 안 번호를 한 줄로 편 값 | 0 ~ 255 |
| `global_invocation_id` | `vec3u` | 전체에서의 번호 | `.x`는 0 ~ g×256-1 |

1차원에서는 `global_invocation_id.x = workgroup_id.x × 256 + local_invocation_id.x`입니다. 웹 개발에 빗대면, 페이지 크기가 256인 페이지네이션에서 `workgroup_id`는 페이지 번호, `local_invocation_index`는 페이지 안의 행 번호, `global_invocation_id`는 전체 목록에서의 행 번호입니다.

원소 하나에 스레드 하나를 붙이는 가장 단순한 경우는 `global_invocation_id`만 있으면 됩니다. [2장](02-render-pipeline.md)의 원 시뮬레이션이 그렇습니다. 리덕션은 워크그룹 단위로 일을 나누므로 `workgroup_id`와 `local_invocation_index`를 씁니다.

## 디스패치 크기 계산

원소가 N개이고 워크그룹 하나가 원소 K개를 맡으면, 필요한 워크그룹 수는 N / K를 올림한 값입니다. [2장](02-render-pipeline.md)의 컴퓨트 시뮬레이션은 원 하나에 호출 하나를 붙이고 워크그룹 크기를 64로 잡았습니다.

```ts
// src/demos/render-compare/renderers/compute-sim.ts (61-61행)
  const workgroups = Math.ceil(count / WORKGROUP_SIZE);
```

올림 때문에 마지막 워크그룹에는 데이터가 없는 호출이 생깁니다. 원이 100개면 워크그룹 2개, 호출 128개가 뜨고 그중 28개는 할 일이 없습니다. 그래서 셰이더 첫 줄에서 범위를 검사합니다.

```wgsl
// src/demos/render-compare/renderers/compute-sim.ts (13-14행)
  let i = gid.x;
  if (i >= params.count) { return; }
```

이 검사를 빼면 마지막 28개 호출이 버퍼 끝 너머를 읽고 씁니다. WebGPU는 범위 밖 접근이 다른 메모리를 건드리지 않도록 막아 주지만, 결과값은 보장하지 않습니다. 범위 검사는 직접 해야 합니다.

> **주의**
> `dispatchWorkgroups`의 각 차원에는 상한이 있습니다. 기본 한도(`maxComputeWorkgroupsPerDimension`)는 65,535입니다. 리덕션이 원소 하나에 호출 하나를 붙였다면 n = 2^24에서 워크그룹이 2^24 / 256 = 65,536개 필요해 한도를 1개 넘습니다. 큰 입력에서는 호출 하나가 원소 여러 개를 맡게 하거나 2차원으로 디스패치해야 합니다. 리덕션 구현은 앞의 방법을 씁니다.

## 워크그룹 하나 안에서의 트리 리덕션

리덕션 커널 전체입니다. 워크그룹 크기 `GROUP`은 256, 호출 하나가 맡는 원소 수 `PER_THREAD`는 4, 그래서 워크그룹 하나가 원소 `PER_GROUP` = 1,024개를 맡습니다.

```wgsl
// src/demos/compute-bench/workloads/reduction/index.ts (15-32행)
var<workgroup> scratch: array<f32, ${GROUP}>;

@compute @workgroup_size(${GROUP})
fn main(@builtin(workgroup_id) wg: vec3u, @builtin(local_invocation_index) lid: u32) {
  let base = wg.x * ${PER_GROUP}u + lid;
  var acc = 0.0;
  for (var k = 0u; k < ${PER_THREAD}u; k++) {
    let i = base + k * ${GROUP}u;
    if (i < params.count) { acc += src[i]; }
  }
  scratch[lid] = acc;
  workgroupBarrier();
  for (var s = ${GROUP / 2}u; s > 0u; s >>= 1u) {
    if (lid < s) { scratch[lid] += scratch[lid + s]; }
    workgroupBarrier();
  }
  if (lid == 0u) { dst[wg.x] = scratch[0]; }
}
```

`${GROUP}` 같은 부분은 JS 템플릿 리터럴이 셰이더 문자열을 만들 때 숫자로 바뀝니다. WGSL 문법이 아닙니다. 세 단계로 나눠 보겠습니다.

**1단계: 호출마다 원소 4개를 더합니다.** 워크그룹 `wg.x`는 원소 `wg.x × 1024`부터 1,024개를 맡습니다. 호출 `lid`는 그중 `lid`, `lid + 256`, `lid + 512`, `lid + 768`번째를 더합니다. 원소 4개를 연속으로 읽지 않고 256칸씩 건너뛰는 데는 이유가 있습니다. 매 반복에서 이웃한 호출들이 이웃한 주소를 읽게 되어, GPU가 메모리를 큰 덩어리로 한 번에 가져올 수 있습니다. 범위 검사(`if (i < params.count)`)는 마지막 워크그룹의 빈 칸을 0으로 남깁니다.

**2단계: 공유 메모리에서 반씩 접어 더합니다.** 각 호출이 부분합을 `scratch[lid]`에 씁니다. 그다음 `s`를 128, 64, 32, …, 1로 줄이면서 `lid < s`인 호출만 `scratch[lid] += scratch[lid + s]`를 합니다. 한 단계마다 남은 값이 반으로 줄어 8단계(256 = 2^8) 뒤에는 `scratch[0]`에 워크그룹 전체의 합이 남습니다. 아래 그림은 같은 과정을 8칸으로 줄여 그린 것입니다.

![8칸짜리 트리 리덕션. 단계마다 앞쪽 절반의 호출이 뒤쪽 절반의 값을 더하고, 3단계 뒤 0번 칸에 합계 31이 남습니다](img/compute-reduction-tree.svg)

**3단계: 대표 하나가 결과를 씁니다.** `lid == 0`인 호출만 `dst[wg.x]`에 워크그룹 합을 씁니다. 워크그룹이 g개면 부분합 g개가 `dst`에 남습니다.

순차 루프는 덧셈 256번이 한 줄로 이어지지만, 트리는 8단계입니다. 단계마다 할 덧셈은 여러 호출이 동시에 합니다.

### workgroupBarrier가 하는 일

`workgroupBarrier()`는 워크그룹의 모든 호출이 이 지점에 도착할 때까지 기다리게 하고, 그 전에 `var<workgroup>` 메모리에 쓴 값을 모든 호출이 볼 수 있게 합니다. 이것이 없으면 `scratch[lid + s]`를 읽는 순간 다른 호출이 아직 그 칸에 쓰지 않았을 수 있습니다. 1단계 뒤의 배리어는 모든 부분합이 `scratch`에 들어간 뒤에 접기를 시작하게 하고, 루프 안의 배리어는 한 단계가 끝난 뒤에 다음 단계를 시작하게 합니다.

> **주의**
> `workgroupBarrier()`는 워크그룹의 모든 호출이 같은 흐름으로 도달하는 자리에만 둘 수 있습니다. 위 코드에서 배리어는 `if (lid < s)` 밖에 있습니다. `s`는 모든 호출에서 같은 값이라 루프 반복 횟수도 같습니다. 배리어를 `if (lid < s)` 안으로 옮기면 일부 호출만 배리어에 도달하므로, WGSL 컴파일러가 셰이더 모듈을 만들 때 균일성(uniformity) 오류로 거부합니다.

공유 메모리와 배리어는 [4장](04-workgroup-memory.md)에서 행렬 곱 타일링을 예로 더 자세히 다룹니다.

## 워크그룹끼리는 합칠 수 없으므로 패스를 반복한다

커널 하나가 끝나면 워크그룹마다 부분합이 하나씩 남습니다. 이 부분합들을 같은 디스패치 안에서 합칠 수는 없습니다. 다른 워크그룹이 언제 끝나는지 알 방법이 없고, 기다릴 방법도 없기 때문입니다.

> **용어**
> 패스(pass)는 `beginComputePass()`부터 `end()`까지 기록한 작업 묶음입니다. 리덕션 구현은 패스 하나에 디스패치 하나를 넣습니다.

답은 패스 경계입니다. 같은 커맨드 인코더 안에서 앞 패스가 스토리지 버퍼에 쓴 값은 다음 패스가 볼 수 있습니다. 그래서 같은 커널을 다시 실행해 부분합 g개를 g / 1024개로 줄이고, 하나가 남을 때까지 반복합니다. `prepare`는 패스마다 들어가는 원소 수를 미리 계산합니다.

```ts
// src/demos/compute-bench/workloads/reduction/index.ts (55-61행)
    // counts[i] is the element count entering pass i; pass i writes ceil(counts[i] / PER_GROUP) partials.
    const counts: number[] = [];
    let c = n;
    do {
      counts.push(c);
      c = Math.ceil(c / PER_GROUP);
    } while (c > 1);
```

데모에서 가장 큰 입력인 n = 2^24로 계산해 보면 패스는 3개입니다.

| 패스 | 들어가는 원소 | 워크그룹 수 | 나오는 부분합 | 읽는 버퍼 | 쓰는 버퍼 |
|---|---|---|---|---|---|
| 0 | 16,777,216 | 16,384 | 16,384 | `inBuf` | `ping` |
| 1 | 16,384 | 16 | 16 | `ping` | `pong` |
| 2 | 16 | 1 | 1 | `pong` | `ping` |

![n = 2^24에서 세 패스가 inBuf, ping, pong을 거쳐 합계 하나를 만들고 readBuf로 복사하는 흐름](img/compute-reduction-passes.svg)

부분합을 담을 버퍼는 `ping`과 `pong` 두 개뿐입니다. 패스마다 읽는 버퍼와 쓰는 버퍼를 맞바꾸므로, 패스가 몇 개든 버퍼 두 개로 충분합니다. 이 방법을 핑퐁(ping-pong) 버퍼라고 부릅니다.

```ts
// src/demos/compute-bench/workloads/reduction/index.ts (69-73행)
    const passes = counts.map((count, i) => {
      const src = i === 0 ? inBuf : i % 2 === 1 ? ping : pong;
      const dst = i % 2 === 0 ? ping : pong;
      const params = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(params, 0, new Uint32Array([count]));
```

패스마다 원소 수(`count`)가 다르므로 유니폼 버퍼와 바인드 그룹도 패스마다 하나씩 미리 만듭니다. 측정할 때마다 반복되는 `encode`는 이미 만든 객체를 순서대로 기록하기만 합니다.

```ts
// src/demos/compute-bench/workloads/reduction/index.ts (90-101행)
      encode(encoder, ts) {
        passes.forEach((p, i) => {
          const timestampWrites =
            passes.length === 1 ? ts?.only : i === 0 ? ts?.first : i === passes.length - 1 ? ts?.last : undefined;
          const pass = encoder.beginComputePass({ timestampWrites });
          pass.setPipeline(pipeline);
          pass.setBindGroup(0, p.bindGroup);
          pass.dispatchWorkgroups(p.groups);
          pass.end();
        });
        encoder.copyBufferToBuffer(finalBuf, 0, readBuf, 0, 4);
      },
```

세 패스와 마지막 4바이트 복사가 커맨드 인코더 하나에 들어가고, 제출은 한 번입니다. `timestampWrites`는 첫 패스의 시작과 마지막 패스의 끝에 GPU 시각을 기록해 커널 시간을 잽니다. 이 장치는 [9장](09-measuring.md)에서 설명합니다.

> **핵심**
> 워크그룹 안에서는 공유 메모리와 배리어로 합치고, 워크그룹 사이에서는 패스 경계로 합칩니다. 여러 패스로 나누는 구조는 [6장](06-multi-pass-sort.md)의 기수 정렬에서 다시 나옵니다.

`atomicAdd`로 모든 호출이 한 변수에 더하면 패스가 하나로 끝나지 않을까 생각할 수 있습니다. WGSL의 아토믹은 `i32`와 `u32`만 지원하므로 f32 합계에는 쓸 수 없습니다. 아토믹은 [5장](05-atomics.md)에서 다룹니다.

## 더하는 순서가 바뀌면 결과가 조금 바뀐다

부동소수점 덧셈은 순서를 바꾸면 반올림 오차가 달라집니다. CPU 구현은 JS `number`(f64)로 누적하고, GPU 구현은 f32로 트리 순서대로 더합니다. 두 결과는 비트 단위로 같지 않습니다.

그래서 `verify`는 f64로 다시 더한 기준값과 비교해 상대 오차가 `1e-4` 이하인지 봅니다. 입력은 0~1 사이 난수입니다. f32 하나의 상대 정밀도는 약 1e-7이고, 트리 리덕션은 비슷한 크기의 값끼리 더하므로 f32 순차 루프보다 오차가 덜 쌓입니다.

## 리덕션에는 교차점이 없다

`compute-bench`는 입력 크기 n을 2^10부터 2^24까지 늘리며 CPU와 GPU의 e2e(end-to-end) 시간을 잽니다. GPU의 e2e는 업로드, 커널, 결과 읽기를 모두 포함합니다. 데모는 GPU가 CPU보다 빨라지기 시작하는 크기를 교차점(crossover)으로 보여 주는데, 리덕션은 측정 범위 전체에서 "교차 없음"입니다.

n = 2^24에서 GPU 쪽 시간을 나누면 이렇습니다. 헤드리스 Chromium, Apple M1, 1회 측정, 참고용입니다.

| 항목 | 시간 |
|---|---|
| 커널 (timestamp-query, 첫 패스 시작부터 마지막 패스 끝까지) | 약 3 ms |
| e2e (업로드 + 커널 + 읽기) | 약 16~19 ms |

e2e의 대부분은 커널이 아닙니다. 차이 13~16 ms는 64 MiB(2^24 × 4바이트)를 GPU로 올리는 업로드, 제출, 결과 4바이트를 읽는 readback에 쓰였습니다. 읽는 데이터가 4바이트뿐이므로 대부분이 업로드일 것으로 추정합니다. 항목별로 나눠 재지는 않았습니다.

원인은 원소 하나당 일의 양입니다. 리덕션은 원소 하나(4바이트)를 올리고 덧셈 한 번을 합니다. 옮긴 데이터에 비해 계산이 너무 적어서, GPU가 계산을 아무리 빨리 해도 업로드 시간을 갚을 수 없습니다. 반면 CPU 루프는 이미 메모리에 있는 배열을 한 번 훑으면 끝납니다. 이렇게 데이터를 옮기는 시간이 전체 시간을 정하는 작업을 전송 병목(transfer-bound)이라고 합니다. 연산 대 데이터 비율, 즉 산술 강도(arithmetic intensity)는 [0장](00-why-gpu.md)에서 설명합니다.

비교를 위해 행렬 곱(GEMM)을 보면, n×n 행렬 두 개는 원소 2n²개를 올려 곱셈-덧셈 n³번을 합니다. 원소 하나당 일이 n에 비례해 늘어나므로 n이 커지면 GPU가 이깁니다. [4장](04-workgroup-memory.md)에서 그 교차점을 봅니다.

> **해보기**
> 데모 차트의 실선은 e2e 중앙값, 점선은 커널만의 시간입니다. 리덕션을 실행하고 두 선 사이의 간격을 보세요. 간격이 업로드 비용입니다. 데이터가 이미 GPU에 있는 경우, 예를 들어 앞 컴퓨트 패스의 결과를 바로 합산하는 경우에는 점선이 실제 비용입니다.

커널 3 ms가 빠르다고 해서 GPU 계산이 공짜라는 뜻은 아닙니다. 64 MiB를 3 ms에 읽었다면 약 22 GB/s이고(측정값으로 계산한 값), 덧셈 한 번은 이 읽기보다 훨씬 쌉니다. 리덕션 커널 자체도 계산보다 메모리 읽기 속도에 묶여 있습니다.

## 정리

- `@workgroup_size`는 워크그룹 하나의 호출 수를, `dispatchWorkgroups(g)`는 워크그룹 수를 정합니다. 워크그룹 수는 `Math.ceil(N / 워크그룹이 맡는 원소 수)`로 구하고, 남는 호출은 셰이더의 범위 검사로 걸러 냅니다.
- 호출은 `workgroup_id`, `local_invocation_index`, `global_invocation_id` 같은 builtin으로 자기 위치를 압니다.
- 워크그룹 안에서는 `var<workgroup>` 메모리와 `workgroupBarrier()`로 값을 반씩 접어 더합니다. 256개를 8단계에 합칩니다.
- 워크그룹 사이에는 동기화가 없으므로, 부분합이 하나가 될 때까지 패스를 반복합니다. 패스 경계가 전체 동기화 지점입니다.
- 리덕션은 원소당 덧셈 한 번이라 업로드 비용을 갚지 못하고, 측정 범위에서 GPU가 CPU를 이기지 못했습니다. n = 2^24에서 커널은 e2e의 약 1/5~1/6입니다.

## 다음 장

[4장 워크그룹 메모리와 타일링](04-workgroup-memory.md)에서는 이 장에서 맛본 `var<workgroup>` 메모리를 본격적으로 써서, 원소 하나당 일이 많은 행렬 곱이 GPU에서 크게 빨라지는 과정을 봅니다.
