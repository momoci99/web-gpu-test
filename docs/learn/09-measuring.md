---
title: GPU 성능을 제대로 재는 법
order: 9
summary: CPU와 GPU가 서로 다른 타임라인에서 일한다는 사실에서 출발해, 이 저장소가 GPU 시간을 재는 방법과 실제로 겪은 측정 버그 두 가지, 직접 잴 때의 체크리스트를 정리합니다.
---

# GPU 성능을 제대로 재는 법

이 장을 읽고 나면 WebGPU 코드의 실행 시간을 잴 때 어떤 숫자가 무엇을 뜻하는지 구분할 수 있습니다. `performance.now()`로 감싼 시간, `onSubmittedWorkDone`까지의 시간, timestamp-query로 잰 GPU 시간이 서로 다른 이유를 다룹니다. 이 저장소가 실제로 잘못 잰 사례 두 가지와 그 수정도 봅니다.

측정 코드는 모두 `src/core/`에 있습니다. 프레임 단위 측정은 `frame-loop.ts`와 `frame-bench.ts`, 한 번 실행하는 작업의 측정은 `oneshot.ts`, GPU 안의 시간은 `gpu-timer.ts`가 맡습니다.

## GPU는 다른 타임라인에서 일한다

[1장](01-webgpu-basics.md)에서 본 것처럼 `device.queue.submit()`은 GPU가 일을 마칠 때까지 기다리지 않고 바로 돌아옵니다. 웹 개발에 빗대면 `fetch()`를 호출하고 `await` 하지 않은 상태입니다. 요청은 떠났지만 응답이 언제 오는지는 모릅니다.

그래서 아래처럼 재면 GPU 작업 시간을 재지 못합니다.

```ts
const t0 = performance.now();
device.queue.submit([encoder.finish()]);
const ms = performance.now() - t0; // 명령을 큐에 넣는 시간일 뿐, GPU 실행 시간이 아님
```

이 저장소의 프레임 루프도 같은 방식으로 CPU 시간을 잽니다. 다만 이 값이 무엇인지 알고 씁니다.

```ts
// src/core/frame-loop.ts (10-26행)
export function collectFrames(frame: () => void, count: number): Promise<FrameSample[]> {
  return new Promise((resolve) => {
    const samples: FrameSample[] = [];
    let prev: number | null = null;
    const tick = (ts: number) => {
      if (prev !== null) {
        const t0 = performance.now();
        frame();
        samples.push({ intervalMs: ts - prev, cpuMs: performance.now() - t0 });
        if (samples.length >= count) return resolve(samples);
      }
      prev = ts;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}
```

한 프레임에서 두 값을 기록합니다.

- `intervalMs`: 이번 `requestAnimationFrame`(rAF) 콜백과 지난 콜백의 타임스탬프 차이입니다. 화면 주사율이 60 Hz면 정상일 때 약 16.7 ms입니다.
- `cpuMs`: `frame()` 호출 앞뒤의 `performance.now()` 차이입니다. WebGPU 렌더러에서는 인코딩과 제출 시간만 뜻합니다.

둘 다 GPU가 실제로 일한 시간은 아닙니다. GPU 시간은 따로 물어봐야 합니다. 방법은 두 가지입니다.

## onSubmittedWorkDone으로 큐가 비었는지 묻기

`device.queue.onSubmittedWorkDone()`은 지금까지 제출한 작업이 GPU에서 모두 끝나면 이행되는 Promise를 돌려줍니다. 한 번 실행하는 작업(리덕션, 정렬 등)의 측정은 이 Promise를 기준점으로 씁니다.

```ts
// src/core/oneshot.ts (181-196행)
async function runGpuOnce<O>(device: GPUDevice, run: GpuRun<O>, timer: GpuTimer | null): Promise<{ sample: RunSample; output: O }> {
  const t0 = performance.now();
  run.upload();
  const encoder = device.createCommandEncoder();
  run.encode(encoder, timer ?? undefined);
  timer?.resolve(encoder);
  device.queue.submit([encoder.finish()]);
  const timed = timer?.afterSubmit();
  await device.queue.onSubmittedWorkDone();
  const t1 = performance.now();
  const output = await run.readback();
  const t2 = performance.now();
  await timed;
  const kernel = timer?.drain()[0];
  return { sample: { e2e: t2 - t0, compute: t1 - t0, readback: t2 - t1, kernel }, output };
}
```

이 함수는 시각 세 개로 구간 세 개를 만듭니다.

| 이름 | 구간 | 포함하는 것 |
|---|---|---|
| `compute` | `t0` → `t1` | 입력 업로드, 인코딩, 제출, GPU 실행 완료까지 |
| `readback` | `t1` → `t2` | 결과를 `mapAsync`로 읽고 디코딩 |
| `e2e` | `t0` → `t2` | 위 둘을 합친 전체 |

`e2e`는 "JS에 배열이 있고, 결과를 JS로 받고 싶다"는 상황의 실제 비용입니다. 사용자가 기다리는 시간도 이 값입니다.

이 값들은 CPU 시계로 잰 벽시계 시간이므로 GPU 실행 외에 브라우저 내부의 지연도 섞입니다. 커널만의 시간을 따로 보려면 GPU 안에서 재야 합니다.

## timestamp-query로 GPU 안에서 재기

timestamp-query는 GPU가 패스의 시작과 끝에 자기 시계 값을 기록하게 하는 기능입니다. 선택 기능(feature)이라 device를 만들 때 요청해야 합니다. `src/demos/compute-bench/device.ts`는 adapter가 지원할 때만 `requiredFeatures: ['timestamp-query']`를 넣고, `createGpuTimer`는 device에 이 기능이 없으면 `null`을 돌려줍니다.

`GpuTimer`는 기록 칸 2개짜리 쿼리 셋(query set)을 만들고, 패스에 넘길 `timestampWrites`를 세 가지로 준비합니다.

- `only`: 패스가 하나일 때. 그 패스의 시작을 0번, 끝을 1번 칸에 씁니다.
- `first`: 여러 패스 중 첫 패스. 시작만 0번 칸에 씁니다.
- `last`: 여러 패스 중 마지막 패스. 끝만 1번 칸에 씁니다.

그래서 측정값은 첫 패스 시작부터 마지막 패스 끝까지입니다. [3장](03-compute-reduction.md)의 리덕션처럼 패스가 3개면 세 패스와 그 사이 간격이 모두 들어갑니다.

기록된 값은 GPU 메모리에 있으므로 읽어 와야 합니다.

```ts
// src/core/gpu-timer.ts (38-61행)
  resolve(encoder: GPUCommandEncoder): void {
    const buf = this.#free.pop();
    if (!buf) return;
    encoder.resolveQuerySet(this.#querySet, 0, QUERY_COUNT, this.#resolveBuf, 0);
    encoder.copyBufferToBuffer(this.#resolveBuf, 0, buf, 0, BYTES);
    this.#pending = buf;
  }

  /** Call right after `queue.submit`. The returned promise settles once the sample is in `drain()`; per-frame callers ignore it. */
  afterSubmit(): Promise<void> {
    const buf = this.#pending;
    if (!buf) return Promise.resolve();
    this.#pending = null;
    return buf
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
```

1. `resolveQuerySet`이 쿼리 값을 일반 버퍼로 옮깁니다. 값은 나노초 단위의 64비트 정수입니다.
2. `copyBufferToBuffer`가 그 값을 CPU가 매핑할 수 있는(`MAP_READ`) 버퍼로 복사합니다.
3. 제출 뒤 `mapAsync`가 이행되면 두 값의 차이를 밀리초로 바꿔 `#samples`에 넣습니다. 나중에 `drain()`이 모아서 꺼냅니다.

매핑용 버퍼는 4개짜리 풀입니다. 매 프레임 측정하는 렌더러는 `afterSubmit()`이 돌려준 Promise를 기다리지 않습니다. 기다리면 GPU가 끝날 때까지 다음 프레임이 멈추고, 그러면 재려던 대상이 바뀝니다. 풀이 모두 사용 중이면 `resolve`가 그 프레임을 건너뜁니다. 그래서 프레임 측정에서 GPU 표본 수는 프레임 수보다 적을 수 있습니다.

### 양자화 때문에 짧은 커널은 0으로 보일 수 있다

Chrome은 보안상 이유로 timestamp-query 값을 약 100 µs 단위로 양자화합니다. 크롬 플래그 **WebGPU Developer Features**를 켜면 양자화가 꺼집니다. 이 저장소의 스모크 스크립트(`scripts/smoke.mjs`)는 `--enable-webgpu-developer-features`로 Chromium을 띄우므로, 학습 노트에 인용한 커널 시간은 양자화되지 않은 값입니다. 평소 쓰는 브라우저 창에서 재면 100 µs보다 짧은 커널은 0이나 100 µs로 나옵니다.

위 코드의 `if (ns > 0)`은 0으로 양자화된 표본을 버립니다. 모든 표본이 버려지면 결과 표의 kernel 칸은 비고, `OneShotResult.kernel`은 `null`이 됩니다.

> **주의**
> kernel 칸이 비었다고 커널이 0 ms였다는 뜻은 아닙니다. timestamp-query를 지원하지 않거나, 커널이 양자화 단위보다 짧았다는 뜻입니다.

## rAF가 WebGPU를 늦춰 주지 않아 생긴 버그

`render-compare` 데모의 **최대 N 찾기**는 원 개수 N을 1,000부터 두 배씩 늘리며 각 N에서 120프레임을 재고, 처음 실패한 N과 마지막으로 통과한 N 사이를 이분 탐색합니다(`rampMaxN`). 탐색 상한은 2,000,000입니다.

처음 만든 통과 기준은 rAF 간격만 봤습니다. 프레임 간격의 중앙값이 주사율 주기의 1.1배 이하이고, 1.5배를 넘는 프레임(드롭)이 5% 이하이면 통과였습니다. SVG와 Canvas2D는 메인 스레드에서 그리므로, 프레임이 무거우면 다음 rAF 콜백이 늦어지고 간격이 늘어납니다. 이 기준이 그 지연을 잡습니다.

WebGPU 렌더러는 시도한 모든 N에서 통과했습니다. 탐색은 상한 2,000,000까지 올라갔고, 하네스는 최대 N으로 2,000,000을 보고했습니다. 원 200만 개를 60 Hz로 그릴 수 있다는 뜻이었습니다.

같은 실행에서 timestamp-query로 잰 GPU 시간은 다른 이야기를 했습니다. 헤드리스 Chromium, Apple M1, 1회 측정, 참고용 값으로, rAF 간격은 16.7 ms로 정상이었는데 프레임 하나의 GPU 시간은 54~142 ms였습니다. GPU는 한 프레임에 3~8 주기 분량의 일을 하고 있었습니다.

![rAF는 16.7 ms마다 제출하지만 GPU는 프레임당 54 ms가 걸려 큐에 일이 쌓이고, settle이 끝난 t1에서야 실제 프레임 시간이 드러나는 타임라인](img/measuring-timeline.svg)

원인은 `submit`이 기다리지 않는다는 앞 절의 사실입니다. rAF 콜백은 16.7 ms마다 돌아와 인코딩과 제출을 마치고 바로 끝났습니다. 제출된 작업은 GPU 큐에 계속 쌓였고, 측정 구간 120프레임이 끝났을 때 GPU는 아직 앞쪽 프레임을 처리하고 있었습니다. 이 환경에서는 브라우저가 rAF 주기를 늦춰 CPU를 GPU 속도에 맞춰 주지 않았습니다. 통과 기준은 CPU 쪽 숫자만 봤으므로 이 밀림을 볼 수 없었습니다.

### 큐를 비운 뒤의 벽시계 시간으로 판정하도록 수정

수정은 측정 구간의 끝을 "마지막 rAF 콜백"이 아니라 "GPU가 마지막 프레임까지 끝낸 시점"으로 옮긴 것입니다. 렌더러는 선택 메서드 `settle()`을 제공하고, WebGPU 렌더러는 이것을 `device.queue.onSubmittedWorkDone()`으로 구현합니다.

```ts
// src/core/frame-bench.ts (69-72행)
    const t0 = performance.now();
    const samples = await collectFrames(() => renderer.frame(), measureFrames);
    await renderer.settle?.();
    const t1 = performance.now();
```

`effectiveFrameMs`는 `(t1 - t0) / samples.length`, 즉 큐에 쌓인 일까지 모두 끝낸 실제 프레임당 시간입니다. 통과 기준에 세 번째 조건으로 들어갑니다.

```ts
// src/core/frame-bench.ts (103-110행)
export function trialPasses(r: FrameStats): boolean {
  const period = 1000 / r.refreshHz;
  return (
    r.interval.median <= PASS_MEDIAN_FACTOR * period &&
    r.droppedRatio <= PASS_DROPPED_RATIO &&
    r.effectiveFrameMs <= PASS_MEDIAN_FACTOR * period
  );
}
```

GPU 시간(`gpu` 열)이 아니라 벽시계 시간으로 판정한 이유는 세 가지입니다.

- timestamp-query가 없는 기기에서도 동작합니다.
- 양자화의 영향을 받지 않습니다.
- 패스 사이 간격, 캔버스 합성처럼 timestamp가 재지 않는 비용까지 포함합니다.

`runFrames`는 워밍업 뒤와 `dispose` 전에도 `settle()`을 기다립니다. 워밍업 프레임의 밀린 일이 측정 구간으로 넘어오지 않게 하고, GPU가 아직 쓰는 자원을 파괴하지 않게 하기 위해서입니다. 이 수정 뒤의 측정값은 [2장](02-render-pipeline.md)의 최대 N 표에 있습니다.

> **핵심**
> 프레임 간격이 정상이라는 것은 CPU가 주기를 지켰다는 뜻일 뿐입니다. GPU가 따라왔는지는 큐를 비운 뒤의 시간으로 확인합니다.

## 워밍업으로 첫 실행 버리기

첫 실행에는 다음부터는 없을 비용이 섞입니다. 셰이더 컴파일과 파이프라인 생성의 잔여 작업, 첫 레이아웃, JS 엔진의 JIT 컴파일, 메모리 할당입니다. 이 비용을 측정에 넣으면 작은 입력의 결과가 크게 왜곡됩니다.

- **프레임 측정.** `runFrames`는 기본값으로 워밍업 30프레임을 실행하고 버린 뒤, 큐를 비우고 GPU 표본도 비운 다음 120프레임을 잽니다.
- **한 번 실행 측정, GPU.** `prepare`(파이프라인 컴파일, 버퍼 할당)는 따로 재서 `setupMs`로 보고하고 e2e에 넣지 않습니다. 그 뒤 `runGpuOnce`를 한 번 실행해 버리고 측정을 시작합니다.
- **한 번 실행 측정, CPU.** 아래 절의 배치 보정 전에 한 번 실행해 버립니다. 이 한 줄은 실제 버그를 고치면서 들어갔습니다.

## 0 ms로 나온 CPU 측정 버그

`performance.now()`는 보안상 이유로 해상도가 약 0.1 ms입니다. 작은 입력의 CPU 구현은 한 번에 0.01 ms도 안 걸리므로, 한 번씩 재면 대부분 0이 나옵니다. 그래서 하네스는 여러 번을 묶어(batch) 재고 평균을 1회 시간으로 씁니다. 묶음 크기는 걸린 시간이 기준 이상이 될 때까지 두 배씩 늘려 정합니다.

```ts
// src/core/oneshot.ts (163-172행)
function calibrateBatch<I, O>(impl: CpuImpl<I, O>, input: I): number {
  impl.run(input);
  let batch = 1;
  for (;;) {
    const t0 = performance.now();
    for (let i = 0; i < batch; i++) impl.run(input);
    if (performance.now() - t0 >= CALIBRATE_MS || batch >= MAX_BATCH) return batch;
    batch *= 2;
  }
}
```

처음 버전에는 첫 줄 `impl.run(input);`이 없었고 기준은 1 ms였습니다. 그러자 스모크 테스트가 가끔 실패했습니다. 첫 호출은 JIT 컴파일과 메모리 할당 때문에 1 ms를 넘길 때가 있었고, 그러면 보정이 batch 1에서 끝났습니다. 측정 단계에서는 함수가 이미 데워져 0.01 ms 만에 끝나므로, batch 1로 재면 0.1 ms 해상도의 시계에서 0 ms가 나왔습니다. `compute-bench`의 스모크 검사(`src/demos/compute-bench/smoke.mjs`)는 e2e 중앙값이 0 이하이면 실패로 처리하므로, 이 경우 스모크가 실패했습니다. 첫 호출이 느린지에 따라 결과가 갈렸으므로 실패는 가끔만 일어났습니다.

수정은 세 가지입니다. 보정 전에 시간을 재지 않는 실행을 한 번 넣었고(위 코드 첫 줄), 기준을 2 ms(`CALIBRATE_MS`)로 올렸고, 묶음 상한을 2^20(`MAX_BATCH`)으로 올렸습니다.

두 버그의 공통점은 "숫자가 나왔다"와 "그 숫자가 재려던 것을 쟀다"가 다르다는 점입니다. 2,000,000은 탐색 상한이었고, 0 ms는 시계 해상도였습니다. 결과가 상한, 하한, 해상도 같은 경계값과 같으면 먼저 의심합니다.

## 한 번이 아니라 여러 번, 평균이 아니라 중앙값

한 번 잰 값에는 가비지 컬렉션, 다른 탭, 운영체제 스케줄링 같은 잡음이 섞입니다. 그래서 하네스는 여러 번 재고 `summarize`(`src/core/stats.ts`)로 중앙값, p95, 평균, 최솟값, 최댓값을 함께 냅니다.

- **중앙값(median)을 주 지표로 씁니다.** 한두 번 튄 값이 평균은 크게 끌어올리지만 중앙값은 거의 움직이지 않습니다.
- **p95는 꼬리를 봅니다.** 프레임 측정에서 중앙값은 괜찮은데 p95가 크면, 가끔 끊기는 프레임이 있다는 뜻입니다.
- **반복 횟수에 규칙이 있습니다.** 한 번 실행 측정은 최소 3회, 그리고 10회를 채우거나 누적 시간이 2초를 넘을 때까지 반복합니다(`shouldStop`). 큰 입력은 몇 번만, 작은 입력은 10번 잽니다.

프레임 측정은 120프레임의 중앙값과 드롭 비율을 함께 봅니다. 중앙값만 보면 5프레임에 한 번씩 크게 끊기는 렌더러도 통과하기 때문입니다.

## e2e와 kernel은 다른 질문에 답한다

`compute-bench` 결과 표에는 e2e와 kernel이 나란히 있습니다. 둘 중 하나가 맞는 숫자인 것이 아니라, 묻는 질문이 다릅니다.

| 질문 | 볼 숫자 |
|---|---|
| JS 배열을 GPU로 처리해서 JS로 결과를 받으면 CPU보다 빠른가? | e2e |
| 데이터가 이미 GPU에 있고 결과도 GPU에서 쓴다면 얼마나 걸리는가? | kernel |
| 둘의 차이, 즉 데이터를 옮기는 비용은 얼마인가? | e2e - kernel |

[3장](03-compute-reduction.md)의 리덕션은 n = 2^24에서 kernel 약 3 ms, e2e 약 16~19 ms였습니다(헤드리스 Chromium, Apple M1, 1회 측정, 참고용). e2e로 보면 GPU가 CPU에 지고, kernel로 보면 GPU가 빠릅니다. 둘 다 사실이고, 어느 쪽이 내 상황인지가 결론을 정합니다. [7장](07-compute-to-render.md)의 N-body처럼 계산 결과를 바로 그리는 구조라면 readback이 없으므로 kernel 쪽에 가깝습니다.

교차점(`crossoverN`)은 e2e 기준입니다. 측정한 가장 큰 n부터 거꾸로 보며 GPU의 e2e 중앙값이 CPU보다 작은 구간이 끊기지 않는 가장 작은 n을 찾습니다.

## 헤드리스 측정의 한계

이 학습 노트에 인용한 숫자는 모두 스모크 스크립트가 헤드리스 Chromium에서 잰 값입니다. 그대로 일반화하면 안 되는 이유가 있습니다.

- **기기 하나, 1회 측정입니다.** Apple M1 한 대에서 한 번 실행했습니다. GPU 구조, 드라이버, 메모리 구조(M1은 CPU와 GPU가 메모리를 공유합니다)가 다르면 업로드 비용과 교차점이 달라집니다.
- **헤드리스 브라우저는 실제 화면에 그리지 않습니다.** rAF 주기와 캔버스 합성 경로가 실제 창과 다를 수 있습니다. 그래서 하네스는 60 Hz를 가정하지 않고 `estimateRefresh()`로 빈 rAF 60번의 간격 중앙값을 재서 주기로 씁니다.
- **실행 플래그가 다릅니다.** 스모크 스크립트는 `--enable-unsafe-webgpu`, `--enable-webgpu-developer-features` 등을 켭니다. 일반 사용자 브라우저에서는 timestamp가 양자화됩니다.
- **WebGPU를 못 쓰면 창을 띄워 다시 시도합니다.** 헤드리스에서 adapter를 얻지 못하면 스크립트가 일반 창(headed) 모드로 다시 실행합니다. 어느 모드로 쟀는지는 실행 로그에 남습니다.
- **SVG의 비용은 `cpuMs`에 다 잡히지 않습니다.** 스타일, 레이아웃, 페인트는 `frame()` 밖에서 일어납니다. 지원하는 브라우저에서는 Long Animation Frame 항목(`long-animation-frame` PerformanceObserver)을 함께 모아 이 비용을 봅니다.

`README.md`와 `docs/architecture.md`도 스모크 수치를 성능 주장으로 쓰지 말라고 적고 있습니다. 이 노트가 숫자마다 "1회 측정, 참고용"을 붙이는 이유입니다.

## 직접 잴 때의 체크리스트

내 기기에서 데모를 실행하거나 측정 코드를 직접 작성할 때 다음을 확인하세요.

1. **무엇을 재는지 먼저 정하세요.** CPU가 바쁜 시간인지, GPU 실행 시간인지, 사용자가 결과를 받기까지의 시간인지 정하고 그에 맞는 숫자(`cpuMs`, kernel, e2e)를 고릅니다.
2. **`submit` 앞뒤의 `performance.now()`를 GPU 시간으로 읽지 마세요.** GPU 작업 완료는 `onSubmittedWorkDone()`이나 `mapAsync`로 기다린 뒤 잽니다.
3. **프레임 루프는 큐를 비운 뒤의 시간으로 판정하세요.** rAF 간격만으로는 GPU가 밀리는 것을 볼 수 없습니다.
4. **워밍업을 버리세요.** 파이프라인 생성은 측정 밖으로 빼고, 첫 실행은 버립니다.
5. **여러 번 재고 중앙값을 보세요.** 꼬리가 중요하면 p95도 봅니다.
6. **시계 해상도를 확인하세요.** `performance.now()`는 약 0.1 ms, timestamp-query는 플래그 없이 약 100 µs입니다. 이보다 짧은 일은 묶어서 재거나 입력을 키웁니다.
7. **경계값을 의심하세요.** 결과가 탐색 상한, 0, 시계 해상도의 배수와 같으면 측정이 막혔을 가능성이 큽니다.
8. **결과가 맞는지 함께 확인하세요.** 데모의 verify처럼 CPU 기준값과 비교합니다. 틀린 결과를 빠르게 내는 구현은 비교 대상이 아닙니다.
9. **일반 브라우저 창에서, 전원을 연결하고, 다른 무거운 탭을 닫고 재세요.** 노트북은 배터리 모드와 발열에 따라 클럭이 바뀝니다.
10. **기기와 조건을 숫자 옆에 적으세요.** GPU 이름(데모의 환경 패널에 나오는 adapter 정보), 브라우저 버전, 주사율, 측정 횟수를 함께 남깁니다.

## 정리

- `queue.submit()`은 바로 돌아오므로, 그 앞뒤의 `performance.now()`는 인코딩과 제출 시간일 뿐입니다. GPU 작업이 끝난 시점은 `onSubmittedWorkDone()`으로 알 수 있습니다.
- timestamp-query는 GPU 안에서 패스 시간을 잽니다. 결과는 비동기로 읽어 오고, Chrome은 플래그 없이 약 100 µs 단위로 양자화합니다.
- 이 저장소는 rAF 간격만 보고 WebGPU 렌더러의 최대 N을 2,000,000(탐색 상한)으로 잘못 보고했습니다. 큐를 비운 뒤의 실효 프레임 시간을 판정에 넣어 고쳤습니다.
- CPU 배치 보정은 데워지지 않은 첫 호출 때문에 batch 1에서 멈춰 0 ms를 냈습니다. 보정 전 워밍업 실행으로 고쳤습니다.
- e2e와 kernel은 다른 질문에 답합니다. 헤드리스 1회 측정값은 경향을 보는 참고용이고, 결론은 내 기기에서 다시 재서 냅니다.

## 다음 장

이 장으로 본문이 끝납니다. 앞 장에서 나온 용어는 [용어집](glossary.md)에서 다시 찾아볼 수 있고, 처음부터 다시 읽으려면 [0장 GPU는 왜 빠르고, 언제 느린가](00-why-gpu.md)로 돌아가세요.
