---
title: 텍스처와 비디오로 만드는 실시간 필터
order: 8
summary: 비디오 프레임을 importExternalTexture로 복사 없이 가져와 스토리지 텍스처 위에서 분리형 블러를 돌리고, getImageData 기반 CPU 필터와 비교합니다.
demo: webcam-filter
---

# 텍스처와 비디오로 만드는 실시간 필터

이 장을 읽고 나면 버퍼와 텍스처가 어떻게 다른지, 비디오 프레임을 GPU로 가져오는 `importExternalTexture`가 왜 프레임마다 다시 불려야 하는지, 블러를 두 패스로 나누면 왜 싸지는지 설명할 수 있습니다. 웹캠 필터 데모를 열어 두고 읽으세요. 카메라가 없어도 합성 영상으로 모든 실험을 할 수 있습니다.

API 흐름은 [01장](01-webgpu-basics.md), 렌더 패스와 화면 출력은 [02장](02-render-pipeline.md), 워크그룹과 디스패치는 [03장](03-compute-reduction.md)에서 설명했습니다. 여기서는 텍스처와 비디오에 새로 필요한 것만 다룹니다.

## 데모 구성

같은 비디오 프레임에 같은 필터를 두 가지 방법으로 적용합니다.

- `cpu-canvas`: Canvas2D에 프레임을 그리고 `getImageData`로 픽셀을 꺼내 JS 루프로 필터링한 뒤 `putImageData`로 되돌립니다.
- `gpu-compute`: `importExternalTexture`로 프레임을 가져와 컴퓨트 패스로 필터링하고 캔버스에 그립니다.

필터는 그레이스케일, 가우시안 블러(분리형), 소벨 엣지 검출 세 가지입니다. 소스는 합성 영상(결정적이라 측정에 씀)과 웹캠(`getUserMedia`) 중에서 고르고, 처리 해상도는 640×360, 1280×720, 1920×1080입니다.

| 파일 | 역할 |
|---|---|
| `filters.ts` | 필터 정의, 가우시안 가중치, 최대 반경 탐색 |
| `cpu-filter.ts` | CPU 기준 구현 (RGBA 바이트 배열, 가장자리는 clamp-to-edge) |
| `gpu-filter.ts` | WGSL 컴퓨트 패스: ingest, 가로 블러, 세로 블러, 소벨, 그레이스케일 |
| `variants.ts` | 두 변형과 페이지 공용 GPU 디바이스 |
| `source.ts` | 합성 영상(캔버스를 `captureStream()`으로 비디오화)과 카메라 |
| `verify.ts` | 같은 고정 프레임을 CPU와 GPU에 통과시켜 차이를 보고 |

## CPU 경로와 getImageData

CPU 변형의 한 프레임입니다.

`src/demos/webcam-filter/variants.ts` 49~54행
```ts
      frame() {
        ctx.drawImage(source.video, 0, 0, width, height);
        const img = ctx.getImageData(0, 0, width, height);
        filter.run(img.data, out.data, params);
        ctx.putImageData(out, 0, 0);
      },
```

웹 개발자에게 익숙한 방법이지만 단계마다 비용이 있습니다. `getImageData`는 캔버스의 픽셀을 JS 메모리로 읽어 오는 동기 호출입니다. 캔버스가 GPU에 있으면 GPU 작업이 끝나기를 기다린 뒤 CPU 메모리로 복사해야 하고, 결과는 매번 새 `ImageData`로 할당됩니다. 이 데모는 `getContext('2d', { willReadFrequently: true })`로 브라우저에 "자주 읽는다"고 알려 캔버스를 CPU 쪽에 두게 합니다. 그래서 CPU 기준선이 불필요하게 불리하지 않습니다.

측정해 보면 이 기기에서는 복사보다 JS 루프가 훨씬 컸습니다. 1280×720에서 `drawImage`와 `getImageData`를 합쳐 약 2ms, `putImageData`가 약 0.5ms였습니다 (헤드리스 Chromium, Apple M1, 1회 측정, 참고용). 블러 프레임 전체가 40ms 이상이었으니 작은 몫입니다. M1은 CPU와 GPU가 메모리를 공유합니다. 별도 VRAM이 있는 GPU에서는 읽어 오는 비용의 비중이 더 클 수 있으므로 이 비율을 일반화하지 마세요.

## 버퍼와 텍스처의 차이

지금까지의 장은 모두 버퍼를 썼습니다. 버퍼는 바이트가 한 줄로 늘어선 메모리이고, 그 바이트를 어떻게 해석할지는 셰이더 선언이 정합니다. 이미지를 버퍼에 담으면 픽셀 (x, y)의 위치를 `y * width + x`로 직접 계산해야 하고, RGBA 네 채널을 묶고 푸는 일과 가장자리 처리도 코드가 맡습니다.

텍스처는 텍셀(texel)이 2차원 같은 격자로 놓인 리소스입니다. 생성할 때 포맷을 정하고, 포맷이 텍셀 하나의 모양을 정합니다.

- `rgba8unorm`: 채널 4개, 채널당 8비트 정수입니다. 셰이더에서 읽으면 0~1 실수로 바뀝니다. 캔버스 픽셀과 같은 정밀도입니다.
- `rgba16float`: 채널 4개, 채널당 16비트 부동소수점입니다.

셰이더는 텍스처를 정수 좌표로 읽거나(`textureLoad`) 0~1 범위의 UV 좌표와 샘플러로 읽습니다(`textureSample` 계열). 샘플러는 텍셀 사이를 보간하고 범위 밖 좌표를 처리합니다. 메모리에서 텍셀을 어떤 순서로 배치할지는 구현이 정하므로, 셰이더는 좌표로만 접근합니다.

![버퍼는 바이트의 1차원 배열이고 인덱스를 직접 계산하며, 텍스처는 포맷이 있는 2차원 텍셀 격자이고 좌표로 읽는 그림](img/08-textures-video-buffer-vs-texture.svg)

컴퓨트 셰이더가 텍스처에 쓰려면 스토리지 텍스처(storage texture)로 바인딩합니다. WGSL에서 `texture_storage_2d<rgba16float, write>`처럼 포맷과 접근 방식을 선언하고 `textureStore`로 씁니다. 스토리지 텍스처로 쓸 수 있는 포맷은 정해져 있고, `rgba8unorm`과 `rgba16float`은 그 목록에 있습니다.

이 데모가 만드는 텍스처는 세 개입니다.

`src/demos/webcam-filter/gpu-filter.ts` 126~133행
```ts
    const size = { width, height };
    const mid = GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING;
    this.#a = device.createTexture({ size, format: 'rgba16float', usage: mid });
    this.#b = device.createTexture({ size, format: 'rgba16float', usage: mid });
    this.output = device.createTexture({ size, format: 'rgba8unorm', usage: mid | GPUTextureUsage.COPY_SRC });
    this.#sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    this.#weights = device.createBuffer({ size: (MAX_RADIUS + 1) * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.#radius = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
```

- `STORAGE_BINDING`은 한 패스에서 `textureStore`로 쓰기 위해, `TEXTURE_BINDING`은 다음 패스에서 `textureLoad`로 읽기 위해 붙였습니다. `output`의 `COPY_SRC`는 검증할 때 버퍼로 복사해 읽어 오기 위한 것입니다.
- 중간 텍스처 `a`, `b`가 `rgba16float`인 이유는 정밀도입니다. 가로 블러 결과를 8비트로 반올림하면 세로 블러가 그 오차를 다시 섞습니다. CPU 구현도 중간 결과를 `Float32Array`에 둡니다.
- 버퍼는 가우시안 가중치(`array<f32>`)와 반경(유니폼)에만 씁니다. 크기가 작고 이미지 모양이 아닌 데이터입니다.

> **용어**
> 텍스처(texture)는 포맷이 있는 텍셀 격자이고, 샘플러(sampler)는 텍스처를 UV 좌표로 읽을 때 보간과 범위 처리 규칙을 담은 객체입니다. 스토리지 텍스처는 컴퓨트 셰이더가 `textureStore`로 쓰도록 바인딩한 텍스처입니다.

## importExternalTexture로 비디오 프레임 가져오기

`<video>`의 현재 프레임은 비디오 디코더가 만든 메모리에 있습니다. 흔히 YUV 같은 RGB가 아닌 형식입니다. `copyExternalImageToTexture`를 쓰면 이 프레임을 일반 텍스처로 복사합니다. `device.importExternalTexture({ source: video })`는 복사하지 않고 그 메모리를 `GPUExternalTexture`로 감쌉니다. 셰이더는 이것을 `texture_external` 타입으로 받고, 읽을 때 RGB 변환과 색 공간 변환이 같이 처리됩니다.

이 데모의 첫 패스(ingest)는 외부 텍스처를 읽어 `a`에 씁니다.

`src/demos/webcam-filter/gpu-filter.ts` 8~17행
```ts
const INGEST_EXTERNAL = /* wgsl */ `
@group(0) @binding(0) var ext: texture_external;
@group(0) @binding(1) var smp: sampler;
@group(0) @binding(2) var dst: texture_storage_2d<rgba16float, write>;
@compute @workgroup_size(${WG}, ${WG}) fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(dst);
  if (id.x >= size.x || id.y >= size.y) { return; }
  let uv = (vec2f(id.xy) + 0.5) / vec2f(size);
  textureStore(dst, id.xy, textureSampleBaseClampToEdge(ext, smp, uv));
}`;
```

- 워크그룹은 8×8 = 64 스레드이고, 스레드 하나가 픽셀 하나를 맡습니다. 2차원 이미지라 `@workgroup_size(8, 8)`과 `dispatchWorkgroups(ceil(width / 8), ceil(height / 8))`처럼 디스패치도 2차원입니다.
- 비디오 크기와 처리 해상도는 다를 수 있습니다. 카메라는 요청한 크기(`ideal`)를 그대로 주지 않을 수 있습니다. 그래서 정수 좌표 대신 텍셀 중심의 UV(`(id + 0.5) / size`)를 만들고, 선형 보간 샘플러로 읽어 처리 해상도에 맞춥니다.
- `textureSampleBaseClampToEdge`는 `texture_external`을 샘플러로 읽는 함수입니다. 일반 `textureSample`은 `texture_external`에 쓸 수 없습니다.

### 외부 텍스처의 수명은 이번 task까지

`GPUExternalTexture`는 오래 들고 있을 수 없습니다. WebGPU 명세에 따르면 `HTMLVideoElement`에서 가져온 외부 텍스처는 가져온 뒤 자동으로 만료(expire)됩니다. 만료 작업은 별도 task로 예약되므로, 지금 실행 중인 JS task가 끝나면 그 객체는 더 이상 쓸 수 없습니다. 명세는 "텍스처를 쓰는 task 안에서 가져오라"고 권합니다. 만료된 뒤에는 `importExternalTexture`를 다시 불러야 합니다. 비디오 프레임이 바뀌지 않았다면 브라우저가 같은 객체를 다시 돌려줄 수도 있습니다.

`requestAnimationFrame` 콜백 하나가 task 하나라고 보면, 실용적인 규칙은 "프레임마다 가져오고, 같은 콜백 안에서 바인드 그룹을 만들고 제출한다"입니다.

![rAF 콜백마다 importExternalTexture를 다시 부르고, 가져온 외부 텍스처는 그 task가 끝나면 만료되는 타임라인](img/08-textures-video-external-lifetime.svg)

`src/demos/webcam-filter/variants.ts` 109~112행
```ts
      frame() {
        const encoder = device.createCommandEncoder();
        // The external texture expires at the end of the current task, so it is imported again every frame.
        filter.encode(encoder, { kind: 'external', texture: device.importExternalTexture({ source: source.video }) }, timer?.first);
```

바인드 그룹은 생성할 때 리소스를 붙잡습니다. 외부 텍스처가 프레임마다 새로 생기니, 그것을 담는 바인드 그룹도 프레임마다 새로 만듭니다. 다른 바인드 그룹(블러, 소벨)은 생성자에서 한 번만 만들어 재사용합니다.

`src/demos/webcam-filter/gpu-filter.ts` 181~190행
```ts
    const ingest = encoder.beginComputePass({ timestampWrites: first });
    if (source.kind === 'external') {
      ingest.setPipeline(this.#ingestExternal);
      ingest.setBindGroup(
        0,
        this.device.createBindGroup({
          layout: this.#ingestExternal.getBindGroupLayout(0),
          entries: [{ binding: 0, resource: source.texture }, { binding: 1, resource: this.#sampler }, { binding: 2, resource: a }],
        }),
      );
```

`kind: 'texture'` 분기는 검증용입니다. `verify.ts`는 고정된 캔버스 패턴을 `copyExternalImageToTexture`로 일반 텍스처에 복사해 넣습니다. 비디오 재생 타이밍과 상관없이 매번 같은 입력을 쓰기 위해서입니다.

> **해보기**
> `variants.ts`에서 `importExternalTexture`를 `create()` 안으로 옮겨 한 번만 부르고, `frame()`에서는 그 객체를 재사용해 보세요. 미리보기가 멈추거나 콘솔에 `WebGPU 오류:`로 시작하는 검증 오류가 찍히는지 확인합니다. 데모는 `uncapturederror` 이벤트를 콘솔에 출력합니다.

## 분리형 블러와 핑퐁 텍스처

반경 r인 2차원 가우시안 블러는 픽셀마다 (2r+1)×(2r+1)개의 이웃을 읽습니다. 가우시안은 가로 방향 1차원 가우시안과 세로 방향 1차원 가우시안의 곱이라서, 가로로 한 번, 세로로 한 번 1차원 블러를 하면 결과가 같습니다. 그러면 픽셀당 읽기가 2·(2r+1)번으로 줄어듭니다. r=16이면 1,089번이 66번입니다.

![반경 2의 2차원 커널은 25탭이지만 가로 5탭과 세로 5탭 두 패스로 나누면 10탭이 되는 그림](img/08-textures-video-separable.svg)

가중치는 CPU와 GPU가 같은 함수로 만듭니다. 시그마는 r/2이고, 전체 합이 1이 되게 정규화합니다.

`src/demos/webcam-filter/filters.ts` 31~40행
```ts
export function gaussianWeights(radius: number): Float32Array {
  const sigma = Math.max(radius / 2, 0.5);
  const w = new Float64Array(radius + 1);
  let sum = 0;
  for (let k = 0; k <= radius; k++) {
    w[k] = Math.exp(-(k * k) / (2 * sigma * sigma));
    sum += k === 0 ? w[k]! : 2 * w[k]!;
  }
  return Float32Array.from(w, (x) => x / sum);
}
```

블러 셰이더는 가로와 세로를 코드 하나로 처리합니다.

`src/demos/webcam-filter/gpu-filter.ts` 28~46행
```ts
const blurShader = (format: string) => /* wgsl */ `
override horizontal: bool;
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var dst: texture_storage_2d<${format}, write>;
@group(0) @binding(2) var<storage, read> weights: array<f32>;
@group(0) @binding(3) var<uniform> radius: u32;
@compute @workgroup_size(${WG}, ${WG}) fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = vec2i(textureDimensions(src));
  if (id.x >= u32(size.x) || id.y >= u32(size.y)) { return; }
  let p = vec2i(id.xy);
  let dir = select(vec2i(0, 1), vec2i(1, 0), horizontal);
  let last = size - vec2i(1);
  var acc = weights[0] * textureLoad(src, p, 0);
  for (var k = 1u; k <= radius; k++) {
    let o = dir * i32(k);
    acc += weights[k] * (textureLoad(src, clamp(p - o, vec2i(0), last), 0) + textureLoad(src, clamp(p + o, vec2i(0), last), 0));
  }
  textureStore(dst, p, vec4f(acc.rgb, 1.0));
}`;
```

- `textureLoad`로 정수 좌표의 텍셀을 정확히 읽습니다. 보간이 끼면 CPU 구현과 결과가 달라지므로 블러에는 샘플러를 쓰지 않습니다.
- `clamp(p ± o, 0, last)`가 가장자리 처리입니다. 이미지 밖 좌표는 가장 가까운 가장자리 픽셀로 바뀝니다. CPU 구현의 `x - k < 0 ? 0 : x - k`와 같은 규칙입니다.
- `override horizontal: bool`은 파이프라인 오버라이드 상수입니다. 셰이더 코드는 그대로 두고, 파이프라인을 만들 때 값을 정합니다.

`src/demos/webcam-filter/gpu-filter.ts` 159~166행
```ts
    const [ingestExternal, ingestTexture, blurH, blurV, gray, sobel] = await Promise.all([
      compute(INGEST_EXTERNAL),
      compute(INGEST_TEXTURE),
      compute(blurShader('rgba16float'), 'main', { horizontal: 1 }),
      compute(blurShader('rgba8unorm'), 'main', { horizontal: 0 }),
      device.createComputePipelineAsync({ layout: 'auto', compute: { module: point, entryPoint: 'gray' } }),
      device.createComputePipelineAsync({ layout: 'auto', compute: { module: point, entryPoint: 'sobel' } }),
    ]);
```

가로 패스는 `rgba16float`인 `b`에, 세로 패스는 `rgba8unorm`인 `output`에 씁니다. 스토리지 텍스처의 포맷은 WGSL 선언에 들어가야 하므로 `blurShader`가 포맷을 인자로 받아 두 모듈을 만듭니다. 파이프라인 6개는 `createComputePipelineAsync`로 한꺼번에 요청하고 `Promise.all`로 기다립니다.

### 패스 순서와 핑퐁

`src/demos/webcam-filter/gpu-filter.ts` 211~215행
```ts
    switch (this.#params.filter) {
      case 'blur':
        run(this.#blurH, this.#blurHGroup);
        run(this.#blurV, this.#blurVGroup);
        break;
```

`run`은 패스 하나를 열고 디스패치 한 번 뒤 닫습니다. 블러 프레임 하나는 ingest(`video → a`), 가로(`a → b`), 세로(`b → output`), present(`output → 캔버스`) 순서로 패스 네 개를 거칩니다. 모두 커맨드 인코더 하나에 들어가고 `queue.submit`은 한 번입니다.

![비디오 프레임을 가져와 ingest, 가로 블러, 세로 블러, present 패스를 거쳐 캔버스에 그리는 흐름](img/08-textures-video-passes.svg)

한 패스에서 읽는 텍스처와 쓰는 텍스처는 항상 다릅니다. 같은 텍스처를 한 디스패치 안에서 `texture_2d`로 읽으면서 스토리지 텍스처로 쓰는 바인딩은 WebGPU가 검증 오류로 막습니다. 막지 않더라도 스레드 순서가 정해져 있지 않으니, 이웃 픽셀이 이미 블러된 값인지 아닌지 알 수 없습니다. [07장](07-compute-to-render.md)의 N-body가 버퍼 두 개로 핑퐁한 것과 같은 이유입니다.

이 구현은 [04장](04-workgroup-memory.md)에서 본 워크그룹 메모리 타일링을 쓰지 않고 탭마다 `textureLoad`를 합니다. 이웃 스레드들이 거의 같은 텍셀을 읽으므로 텍스처 캐시가 대부분을 받아 줄 것으로 추정합니다. 측정으로 확인하지는 않았습니다.

마지막 present 패스는 [02장](02-render-pipeline.md)의 렌더 파이프라인입니다. `PRESENT_SHADER`(`gpu-filter.ts`)는 화면 전체를 덮는 삼각형 하나를 `draw(3)`으로 그리고, 프래그먼트 셰이더가 픽셀 좌표 `pos.xy`로 `output`을 `textureLoad`합니다.

> **해보기**
> 필터를 "소벨 엣지 검출"로 바꿔 보세요. 소벨은 이웃 3×3을 읽는 패스 하나라서 반경과 상관없이 비용이 일정합니다. 그레이스케일은 픽셀 하나만 읽는 패스 하나입니다.

## 디바이스는 페이지에 하나

이 데모는 처음에 실행마다 GPU 디바이스를 만들고, 실행이 끝나면 `device.destroy()`로 닫았습니다. 그런데 비디오 프레임을 가져온 실행 뒤에, 다음 실행의 `requestAdapter`나 `requestDevice`가 Chromium에서 실패하는 일이 생겼습니다. 한동안은 재시도로 가렸지만, 해결책은 디바이스를 페이지에 하나만 두는 것이었습니다 (커밋 `e882902`). Chromium 내부의 원인은 조사하지 않았습니다.

`src/demos/webcam-filter/variants.ts` 62~80행
```ts
let sharedDevice: Promise<GPUDevice> | null = null;

// One device per page, never destroyed by a run. Destroying a device that imported video frames and requesting a new
// one right after left Chromium without a valid instance for the next requestAdapter/requestDevice.
export function getFilterDevice(caps: Capabilities): Promise<GPUDevice> {
  if (caps.webgpu.kind !== 'available') return Promise.reject(new Error('WebGPU를 사용할 수 없습니다'));
  const requiredFeatures: GPUFeatureName[] = caps.webgpu.timestampQuery ? ['timestamp-query'] : [];
  sharedDevice ??= (async () => {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('requestAdapter()가 null을 반환했습니다');
    const device = await adapter.requestDevice({ requiredFeatures });
    device.addEventListener('uncapturederror', (e) => console.error('WebGPU 오류:', (e as GPUUncapturedErrorEvent).error.message));
    void device.lost.then(() => {
      sharedDevice = null;
    });
    return device;
  })();
  return sharedDevice;
}
```

- 캐시하는 것은 디바이스가 아니라 `Promise<GPUDevice>`입니다. 두 호출이 동시에 들어와도 디바이스는 하나만 만들어집니다.
- 실행이 끝나면 그 실행이 만든 것만 정리합니다. 텍스처와 버퍼는 `destroy()`, 캔버스 컨텍스트는 `unconfigure()`를 부르고, 디바이스는 그대로 둡니다.
- 디바이스를 잃으면(`device.lost`) 캐시를 비웁니다. 다음 호출이 새 디바이스를 만듭니다.
- 검증(`verify.ts`)도 같은 `getFilterDevice`를 씁니다.

DB 커넥션과 비슷하게 생각하면 됩니다. 요청마다 연결을 열고 닫지 않고, 앱이 살아 있는 동안 하나를 두고 씁니다. 데모처럼 실행을 반복하는 페이지라면 디바이스는 한 번 만들고 실행 단위 리소스만 정리하는 편이 단순합니다.

## 결과 읽기

헤드리스 Chromium, Apple M1, 1회 측정, 참고용입니다. 다른 GPU 작업이 동시에 돌던 상태였고 주사율은 약 60Hz였습니다.

1280×720, 블러, 합성 영상:

| 변형 | 반경 4: 실효 프레임 / cpu / gpu | 반경 16: 실효 프레임 / cpu / gpu |
|---|---|---|
| cpu-canvas | 40.6 / 39.7 / - ms | 126.8 / 124.6 / - ms |
| gpu-compute | 16.8 / 0.8 / 2.2 ms | 16.8 / 0.9 / 5.1 ms |

- **실효 프레임 시간.** 큐를 비운 뒤 잰 프레임당 시간입니다. rAF가 주사율(16.7ms)에 묶으므로 빠른 변형은 모두 약 17ms로 같게 나옵니다.
- **cpu 열.** CPU 변형은 `drawImage`, `getImageData`, 필터, `putImageData` 전체입니다. GPU 변형은 명령 기록과 제출뿐이고, GPU에서 걸린 시간은 timestamp-query로 잰 gpu 열에 따로 나옵니다.
- **CPU.** 반경이 4배가 되자 비용이 약 3배가 되었습니다. 탭 수는 18에서 66으로 약 3.7배지만, 반경과 무관한 캔버스 복사 약 2.5ms가 섞여 있습니다.
- **GPU.** GPU 시간은 2.2ms에서 5.1ms로 늘었지만 16.7ms 안이라 실효 프레임에는 드러나지 않습니다.

"주사율에서 유지되는 최대 블러 반경"은 반경 1부터 두 배씩 키우다 실패하면 이분 탐색한 값입니다.

| 변형 | 640×360 | 1280×720 | 1920×1080 |
|---|---|---|---|
| cpu-canvas | 8 | 0 | 0 |
| gpu-compute | 32 (탐색 상한) | 32 (탐색 상한) | 32 (탐색 상한) |

- 0은 반경 1에서도 주사율을 맞추지 못했다는 뜻입니다. CPU의 한계는 JS 필터 루프입니다. 640×360에서 반경 9의 실효 프레임은 이미 19.3ms(기준 18.4ms)였습니다.
- 32는 `MAX_RADIUS`이고 GPU의 한계가 아닙니다. 반경 32의 GPU 시간은 1280×720에서 5.9ms, 1920×1080에서 7.7ms였습니다.

측정 방법과 함정은 [09장](09-measuring.md)에서 다룹니다.

> **해보기**
> 처리 해상도를 640×360과 1920×1080으로 바꿔 "반경 스윕 (블러)"을 돌려 보세요. CPU 곡선은 픽셀 수와 반경에 비례해 올라가고, GPU 곡선은 16.7ms 근처에 붙어 있습니다.

## 정합성 검증

`verifyParity`는 640×360 합성 패턴의 37번 프레임 하나를 CPU와 GPU에 같은 필터와 반경으로 통과시키고, 결과를 바이트 단위로 비교합니다. 대상은 그레이스케일, 블러 반경 1, 8, 32, 소벨입니다.

`src/demos/webcam-filter/verify.ts` 11~15행
```ts
// Both sides round to 8 bits at the end and clamp to the edge. The GPU keeps the blur's middle texture in float16
// (relative error 2^-11, under 0.13 levels at 255) and may fuse multiply-adds, so the sums differ by a fraction of a
// level and a rounding boundary can flip one level. A wrong tap, weight or edge rule moves pixels by many levels.
export const MAX_DIFF_TOLERANCE = 2;
export const MEAN_DIFF_TOLERANCE = 0.1;
```

- 정상적인 차이는 반올림 경계에서 한 단계가 뒤집히는 정도입니다. 탭 위치, 가중치, 가장자리 규칙이 틀리면 수십 단계가 어긋납니다. 그래서 허용 오차는 채널당 최대 2, 평균 0.1(0~255 기준)입니다.
- 실측은 최대 1, 평균 0.01~0.05였습니다.
- CPU 출력에서 RGB 값의 최댓값과 최솟값 차이가 16 미만이면 실패로 처리합니다(`MIN_SPREAD`). 평평한 이미지끼리는 틀린 필터도 같아 보이기 때문입니다.

GPU 결과를 읽어 오는 부분에는 텍스처만의 규칙이 하나 있습니다.

`src/demos/webcam-filter/verify.ts` 64~71행
```ts
      filter.setParams(params);
      const encoder = device.createCommandEncoder();
      filter.encode(encoder, { kind: 'texture', view: input.createView() });
      encoder.copyTextureToBuffer({ texture: filter.output }, { buffer: readback, bytesPerRow }, { width: WIDTH, height: HEIGHT });
      device.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ);
      const gpu = new Uint8Array(readback.getMappedRange().slice(0));
      readback.unmap();
```

`copyTextureToBuffer`의 `bytesPerRow`는 256의 배수여야 합니다. 그래서 `bytesPerRow = Math.ceil((WIDTH * 4) / 256) * 256`으로 올림하고, 비교할 때도 `y * bytesPerRow + x * 4`로 행을 건너뜁니다. 640×4 = 2,560바이트는 이미 256의 배수지만, 너비가 다르면 행 끝에 빈 바이트가 생깁니다.

> **해보기**
> `gpu-filter.ts`에서 중간 텍스처 `a`, `b`의 포맷을 `rgba8unorm`으로 바꿔 보세요. 두 ingest 셰이더(`INGEST_EXTERNAL`, `INGEST_TEXTURE`)와 `blurShader('rgba16float')`의 포맷 문자열도 같이 바꿔야 합니다. 그런 다음 "정합성 검증"을 돌려 블러의 최대, 평균 오차가 어떻게 변하는지 봅니다.

## 정리

- 버퍼는 셰이더 선언이 해석하는 바이트 배열이고, 텍스처는 포맷이 있는 텍셀 격자입니다. 이미지 처리에서는 텍스처를 쓰면 좌표 계산과 가장자리 처리가 단순해집니다.
- `importExternalTexture`는 비디오 프레임을 복사하지 않고 감쌉니다. 가져온 객체는 현재 task가 끝나면 만료되므로 프레임마다 다시 가져오고, 그 바인드 그룹도 프레임마다 새로 만듭니다.
- 분리형 블러는 픽셀당 읽기를 (2r+1)²에서 2·(2r+1)로 줄입니다. 가로와 세로 패스는 서로 다른 텍스처에 쓰는 핑퐁 구조입니다.
- Apple M1의 1280×720 블러에서 CPU는 반경 4에 약 41ms, 반경 16에 약 127ms였고, GPU는 GPU 시간 2~5ms로 주사율 안에 들었습니다. CPU 쪽 비용은 대부분 JS 루프였습니다.
- GPU 디바이스는 페이지에 하나만 두고, 실행마다 만든 리소스만 정리합니다.

## 다음 장

[GPU 성능을 제대로 재는 법](09-measuring.md)에서는 이 장과 앞 장의 표에 나온 실효 프레임 시간, gpu 열, "주사율에 묶임"이 어떻게 측정되었는지 설명합니다.
