---
title: 렌더 파이프라인으로 원 그리기
order: 2
summary: 같은 튀는 원 장면을 SVG, Canvas2D, WebGL2, WebGPU로 그려 보고, 한 번의 draw로 원 수십만 개를 그리는 인스턴싱과 블렌딩을 익힙니다.
demo: render-compare
---

# 렌더 파이프라인으로 원 그리기

이 장을 읽고 나면 WebGPU가 화면에 무언가를 그리는 과정을 설명할 수 있습니다. 정점 셰이더, 프래그먼트 셰이더, 인스턴싱, 블렌딩이 각각 무슨 일을 하는지, 그리고 SVG와 Canvas2D가 원 몇만 개에서 멈추는 이유를 다룹니다. `render-compare` 데모를 열어 두고 읽으면 좋습니다.

[1장](01-webgpu-basics.md)에서 배운 adapter, device, queue, 버퍼, 바인드 그룹, 커맨드 인코더는 여기서 다시 설명하지 않습니다. 1장은 컴퓨트 패스를 다뤘고, 이 장은 렌더 패스를 다룹니다.

## 같은 장면, 다섯 가지 렌더러

데모는 800×600 영역 안에서 원 N개가 벽에 부딪혀 튀는 장면을 그립니다. 다섯 렌더러가 같은 장면을 그립니다.

| id | 시뮬레이션 위치 | 그리는 방법 |
|---|---|---|
| `svg` | CPU | 원마다 `<circle>` 노드 하나 |
| `canvas2d` | CPU | 원마다 `arc` + `fill` 호출 |
| `webgl2` | CPU | 인스턴스 draw 한 번 |
| `webgpu-cpu` | CPU | 인스턴스 draw 한 번 |
| `webgpu-compute` | GPU 컴퓨트 패스 | 인스턴스 draw 한 번 |

공정한 비교를 위해 장면 데이터는 한 곳에서 만듭니다. `src/demos/render-compare/scene.ts`의 `createScene`은 시드로 결정되는 난수(mulberry32)로 원을 만들고, 매 프레임 바뀌는 값은 `state` 배열 하나뿐입니다.

```ts
// src/demos/render-compare/scene.ts (10-17행)
export interface SceneData {
  config: SceneConfig;
  /** Interleaved [x, y, vx, vy] per instance, CSS px and px/s. The only per-frame mutable data. */
  state: Float32Array;
  radius: Float32Array;
  /** RGBA8 packed with r in the low byte. Alpha is below 255 so blending cost is real. */
  color: Uint32Array;
}
```

원 하나는 `state`에서 float 4개, 즉 16바이트를 차지합니다. 반지름과 색은 처음에 정해지고 바뀌지 않습니다. 색의 알파는 90~200(255 기준)이라 원이 반투명합니다. 겹친 원을 섞는 블렌딩 비용이 실제로 들도록 일부러 정한 값입니다.

시간 간격은 벽시계가 아니라 고정값 `FIXED_DT = 1 / 60`초입니다. 그래서 어느 렌더러에서든 k번째 프레임의 원 위치가 같습니다. 렌더러가 느려도 장면이 바뀌지 않으니, 렌더러 사이의 차이는 그리는 비용에서만 나옵니다.

## SVG가 먼저 멈추는 이유

SVG 렌더러는 원마다 DOM 노드를 하나 만들고, 매 프레임 모든 노드의 `cx`, `cy` 속성을 바꿉니다.

```ts
// src/demos/render-compare/renderers/svg.ts (33-41행)
      frame() {
        stepScene(scene, FIXED_DT);
        const s = scene.state;
        for (let i = 0; i < count; i++) {
          const el = circles[i]!;
          el.setAttribute('cx', String(s[i * STATE_STRIDE]));
          el.setAttribute('cy', String(s[i * STATE_STRIDE + 1]));
        }
      },
```

JS 루프 자체는 짧습니다. 비싼 부분은 이 함수가 끝난 뒤에 일어납니다. 속성이 바뀐 노드가 N개이므로 브라우저는 스타일 계산, 레이아웃, 페인트를 N개 노드에 대해 다시 합니다. 숫자를 문자열로 바꿔 속성에 넣고, 브라우저가 그 문자열을 다시 숫자로 파싱하는 과정도 원마다 두 번씩 일어납니다.

> **주의**
> 결과 표의 **cpu 중앙값** 열은 `frame()` 호출 시간만 잽니다. SVG의 비용 대부분은 JS 밖(스타일, 레이아웃, 페인트)에서 생기므로 이 값은 실제보다 작게 나옵니다. SVG의 진짜 비용은 프레임 간격과 Long Animation Frame 항목에 드러납니다. 측정 방법은 [9장](09-measuring.md)에서 다룹니다.

## Canvas2D가 그다음에 멈추는 이유

Canvas2D는 DOM 노드를 만들지 않습니다. 매 프레임 캔버스를 지우고 원을 하나씩 다시 그립니다.

```ts
// src/demos/render-compare/renderers/canvas2d.ts (24-34행)
      frame() {
        stepScene(scene, FIXED_DT);
        const s = scene.state;
        ctx.clearRect(0, 0, width, height);
        for (let i = 0; i < count; i++) {
          ctx.fillStyle = fills[i]!;
          ctx.beginPath();
          ctx.arc(s[i * STATE_STRIDE]!, s[i * STATE_STRIDE + 1]!, scene.radius[i]!, 0, TAU);
          ctx.fill();
        }
      },
```

레이아웃이 없으니 SVG보다 훨씬 오래 버팁니다. 그래도 원 하나에 API 호출이 4번(`fillStyle`, `beginPath`, `arc`, `fill`)이고, 호출마다 JS에서 브라우저 엔진으로 넘어가는 비용과 경로를 만드는 비용이 듭니다. 색 문자열은 `fills` 배열에 미리 만들어 두었으므로, 남은 비용은 원 개수에 비례하는 호출 비용입니다. 원이 N개면 호출이 4N번입니다.

두 방식의 공통 한계는 "원 하나당 CPU가 무언가를 한다"는 점입니다. GPU 렌더러는 이 구조를 바꿉니다. CPU는 "원 N개를 그려라"라는 명령 하나만 내리고, 원마다 하는 일은 GPU가 병렬로 합니다.

## 렌더 파이프라인의 단계

GPU가 그림을 그리는 과정은 정해진 단계를 차례로 지납니다. 이 단계들의 묶음을 렌더 파이프라인(render pipeline)이라고 부릅니다.

![렌더 파이프라인의 단계: 스토리지 버퍼, 정점 셰이더, 래스터화, 프래그먼트 셰이더, 블렌딩](img/render-pipeline-flow.svg)

1. **정점 셰이더(vertex shader).** 꼭짓점마다 한 번 실행되어 그 꼭짓점이 화면 어디에 놓이는지 계산합니다.
2. **래스터화(rasterization).** 꼭짓점 3개가 이루는 삼각형이 덮는 픽셀을 GPU가 찾습니다. 코드를 쓰지 않는 고정 단계입니다.
3. **프래그먼트 셰이더(fragment shader).** 삼각형이 덮은 픽셀마다 한 번 실행되어 그 픽셀의 색을 정합니다.
4. **블렌딩(blending).** 프래그먼트 셰이더가 낸 색을 캔버스에 이미 있는 색과 섞습니다. 이것도 파이프라인 설정으로 정하는 고정 단계입니다.

GPU는 삼각형만 그릴 줄 압니다. 원을 그리려면 원을 덮는 사각형(삼각형 2개)을 그리고, 프래그먼트 셰이더에서 원 밖 픽셀을 버립니다. 이 데모의 원은 모두 이 방법으로 그립니다.

## 캔버스를 WebGPU에 연결하기

WebGPU로 그린 결과를 보려면 `<canvas>`에서 `webgpu` 컨텍스트를 얻고 device와 연결합니다. 이 작업은 `configure`가 합니다.

```ts
// src/demos/render-compare/renderers/gpu-common.ts (79-89행)
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: 'premultiplied' });

  const module = device.createShaderModule({ code: DRAW_WGSL });
  const blend: GPUBlendComponent = { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' };
  const pipeline = device.createRenderPipeline({
    layout: 'auto',
    vertex: { module },
    fragment: { module, targets: [{ format, blend: { color: blend, alpha: blend } }] },
    primitive: { topology: 'triangle-list' },
  });
```

- `getPreferredCanvasFormat()`는 이 기기에서 화면 출력에 가장 효율적인 픽셀 형식(`'bgra8unorm'` 또는 `'rgba8unorm'`)을 돌려줍니다. 파이프라인의 출력 형식(`targets[0].format`)도 같은 값이어야 합니다.
- `alphaMode: 'premultiplied'`는 캔버스 픽셀의 RGB에 이미 알파가 곱해져 있다고 브라우저에 알립니다. 아래 블렌딩 절에서 설명합니다.
- `topology: 'triangle-list'`는 꼭짓점을 3개씩 끊어 삼각형 하나로 읽으라는 뜻입니다.
- 컴퓨트 파이프라인은 `compute` 진입점 하나였지만, 렌더 파이프라인은 `vertex`와 `fragment` 두 진입점을 받습니다. 두 셰이더가 한 WGSL 모듈에 같이 들어 있어서 `module`을 두 번 넘깁니다. 진입점 이름(`vs`, `fs`)은 모듈에 해당 단계 함수가 하나뿐이라 생략했습니다.

캔버스는 매 프레임 새 텍스처를 내줍니다. 그래서 렌더 패스를 시작할 때마다 `context.getCurrentTexture()`를 다시 부릅니다.

```ts
// src/demos/render-compare/renderers/gpu-common.ts (108-119행)
    encode(encoder, timestampWrites) {
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          { view: context.getCurrentTexture().createView(), clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' },
        ],
        timestampWrites,
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.draw(6, count);
      pass.end();
    },
```

`loadOp: 'clear'`는 패스 시작 시 텍스처를 `clearValue`(완전 투명)로 지웁니다. Canvas2D의 `clearRect`와 같은 역할입니다. `storeOp: 'store'`는 패스가 끝난 뒤 결과를 텍스처에 남깁니다. 그래야 브라우저가 그 텍스처를 화면에 합성합니다.

## 인스턴싱으로 draw 한 번에 원 N개 그리기

핵심은 `pass.draw(6, count)` 한 줄입니다. 첫 인자는 인스턴스 하나의 꼭짓점 수(6), 둘째 인자는 인스턴스 수(N)입니다. GPU는 정점 셰이더를 6 × N번 실행합니다. 이렇게 같은 도형을 여러 벌 한 번에 그리는 방법을 인스턴싱(instancing)이라고 합니다.

> **용어**
> 인스턴스(instance)는 같은 도형의 복사본 하나입니다. 여기서는 원 하나가 인스턴스 하나입니다.

정점 셰이더는 자기가 몇 번째 인스턴스의 몇 번째 꼭짓점인지 내장 값(builtin)으로 받습니다.

- `@builtin(vertex_index)`: 인스턴스 안에서의 꼭짓점 번호, 0~5.
- `@builtin(instance_index)`: 인스턴스 번호, 0~N-1.

정점 셰이더는 이 두 번호로 필요한 데이터를 직접 찾아 읽습니다.

```wgsl
// src/demos/render-compare/renderers/gpu-common.ts (20-35행)
const CORNERS = array<vec2f, 6>(
  vec2f(-1, -1), vec2f(1, -1), vec2f(-1, 1),
  vec2f(-1, 1), vec2f(1, -1), vec2f(1, 1),
);

@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VsOut {
  let r = radius[ii];
  let local = CORNERS[vi] * (r + 1.0);
  let px = state[ii].xy + local;
  var out: VsOut;
  out.pos = vec4f(px.x / frame.size.x * 2.0 - 1.0, 1.0 - px.y / frame.size.y * 2.0, 0.0, 1.0);
  out.local = local;
  out.radius = r;
  out.color = unpack4x8unorm(color[ii]);
  return out;
}
```

![사각형 하나를 이루는 꼭짓점 6개와 그 안에 그려지는 원](img/render-pipeline-quad.svg)

한 줄씩 보겠습니다.

- `CORNERS`는 사각형의 꼭짓점 6개(삼각형 2개)입니다. 사각형을 위한 정점 버퍼는 따로 없고, `vi`로 이 상수 배열을 고릅니다.
- `local`은 원 중심에서 꼭짓점까지의 픽셀 거리입니다. 반지름보다 1픽셀 크게(`r + 1.0`) 잡아 가장자리 안티에일리어싱이 들어갈 여유를 둡니다.
- `state[ii].xy`는 이 원의 중심 위치입니다. `state`는 `array<vec4f>`로 선언되어 있어서 원 하나의 `[x, y, vx, vy]` 16바이트가 `vec4f` 하나에 그대로 들어맞습니다.
- `out.pos`는 픽셀 좌표를 클립 공간(clip space)으로 바꾼 값입니다. 클립 공간은 화면 왼쪽 아래가 (-1, -1), 오른쪽 위가 (1, 1)인 좌표계입니다. 캔버스 픽셀 좌표는 y가 아래로 커지므로 y를 뒤집습니다(`1.0 - ...`).
- `unpack4x8unorm`은 u32 하나에 담긴 바이트 4개를 0~1 범위의 `vec4f`로 풉니다. 첫 성분이 가장 낮은 바이트이므로, `scene.ts`가 r을 낮은 바이트에 넣은 순서와 맞습니다.

`VsOut`의 `@location` 필드는 다음 단계로 넘어가는 값입니다. 래스터화 단계는 삼각형 안의 픽셀마다 이 값을 세 꼭짓점 값 사이에서 보간해 프래그먼트 셰이더에 넘깁니다. 반지름과 색은 인스턴스 안에서 같은 값이므로 `@interpolate(flat)`으로 보간하지 않게 했습니다. `local`은 보간되므로, 프래그먼트 셰이더는 픽셀마다 "원 중심에서 이 픽셀까지의 벡터"를 받습니다.

> **핵심**
> CPU는 원 N개에 대해 아무것도 하지 않습니다. `draw(6, count)` 한 번을 인코딩하고 제출할 뿐입니다. 원마다 하는 일은 GPU의 정점 셰이더와 프래그먼트 셰이더가 병렬로 합니다.

## 프래그먼트 셰이더로 원 모양 만들기

```wgsl
// src/demos/render-compare/renderers/gpu-common.ts (37-42행)
@fragment fn fs(in: VsOut) -> @location(0) vec4f {
  let cover = 1.0 - smoothstep(in.radius - 0.5, in.radius + 0.5, length(in.local));
  if (cover <= 0.0) { discard; }
  let a = in.color.a * cover;
  return vec4f(in.color.rgb * a, a);
}
```

- `length(in.local)`은 원 중심에서 이 픽셀까지의 거리입니다.
- `smoothstep(r - 0.5, r + 0.5, d)`는 거리가 `r - 0.5`보다 작으면 0, `r + 0.5`보다 크면 1이고, 그 사이 1픽셀 구간에서 부드럽게 변합니다. `cover`는 이 값을 뒤집은 것이라 원 안쪽은 1, 바깥은 0, 경계는 그 사이입니다. 경계를 계단 없이 그리는 간단한 안티에일리어싱입니다.
- `discard`는 이 픽셀을 그리지 않고 버립니다. 사각형의 네 귀퉁이가 여기서 사라집니다.
- 반환값은 색에 알파를 곱한 `(rgb × a, a)`입니다. 이 형식을 premultiplied alpha라고 부릅니다.

## 블렌딩과 premultiplied alpha

원이 겹치면 뒤에 그린 원의 색을 앞서 그려진 색과 섞어야 합니다. 이 계산은 셰이더가 아니라 파이프라인의 블렌드 설정이 합니다. 위 `configure` 예제의 `blend`는 다음 식을 뜻합니다.

```text
결과 = src × 1 + dst × (1 - src.a)      // srcFactor 'one', dstFactor 'one-minus-src-alpha', operation 'add'
```

`src`는 프래그먼트 셰이더가 낸 색, `dst`는 캔버스에 이미 있는 색입니다. 이 식이 맞으려면 `src.rgb`에 알파가 미리 곱해져 있어야 합니다. 그래서 셰이더가 `rgb * a`를 돌려줍니다.

예를 들어 알파 0.5인 빨강을 불투명한 파랑 위에 그리면 계산은 다음과 같습니다.

```text
src = (1×0.5, 0, 0, 0.5) = (0.5, 0, 0, 0.5)     // premultiplied 빨강
dst = (0, 0, 1, 1)                              // 불투명 파랑
결과 = (0.5, 0, 0, 0.5) + (0, 0, 1, 1) × 0.5 = (0.5, 0, 0.5, 1)
```

premultiplied 형식을 쓰는 이유는 세 가지입니다.

- **같은 식이 색과 알파 모두에 맞습니다.** 알파 채널에도 `결과.a = src.a + dst.a × (1 - src.a)`가 적용되는데, 이것이 반투명한 두 층을 겹쳤을 때의 정확한 불투명도입니다. 알파를 곱하지 않은 색(straight alpha)으로 `srcFactor: 'src-alpha'`를 쓰면 RGB는 맞지만, 같은 설정을 알파 채널에도 쓰면 `src.a × src.a`가 되어 틀립니다.
- **경계 처리가 한 번의 곱셈입니다.** `cover`로 덮인 정도를 표현할 때 네 성분에 같은 값을 곱하면 됩니다.
- **브라우저 합성과 맞습니다.** 캔버스는 투명(0, 0, 0, 0)으로 지워지므로, 원이 없는 곳은 페이지 배경이 비쳐야 합니다. `alphaMode: 'premultiplied'`는 브라우저에게 캔버스 픽셀을 premultiplied로 해석하라고 알립니다. 셰이더 출력 형식과 이 설정이 다르면 반투명한 부분의 색이 틀어집니다.

> **해보기**
> `gpu-common.ts`에서 셰이더 반환값을 `vec4f(in.color.rgb, a)`로 바꾸고 데모를 다시 실행해 보세요. 반투명한 원과 원 경계가 지나치게 밝아집니다. premultiplied를 가정한 블렌드 식에 알파가 곱해지지 않은 색이 들어갔기 때문입니다.

## WebGL2와 비교하기

WebGL2 렌더러(`src/demos/render-compare/renderers/webgl2.ts`)도 같은 방법으로 그립니다. 꼭짓점 6개짜리 사각형 인스턴스를 draw 호출 한 번으로 그리고, 프래그먼트 셰이더 내용도 GLSL로 옮긴 것뿐입니다. 블렌드도 `gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)`, 컨텍스트도 `premultipliedAlpha: true`로 같습니다.

차이는 인스턴스 데이터를 셰이더에 전달하는 방식에 있습니다. WebGPU 버전은 스토리지 버퍼를 바인드 그룹으로 묶고 셰이더가 `state[ii]`처럼 직접 인덱싱합니다. WebGL2 버전은 버퍼를 정점 속성(vertex attribute)으로 연결하고, `vertexAttribDivisor(…, 1)`로 "꼭짓점마다가 아니라 인스턴스마다 다음 값으로 넘어가라"고 설정합니다.

```ts
// src/demos/render-compare/renderers/webgl2.ts (73-78행)
    const stateBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, stateBuf);
    gl.bufferData(gl.ARRAY_BUFFER, scene.state.byteLength, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 16, 0);
    gl.vertexAttribDivisor(0, 1);
```

매 프레임 하는 일도 거의 같습니다.

| 단계 | WebGL2 | WebGPU (CPU 시뮬레이션) |
|---|---|---|
| 시뮬레이션 | `stepScene` (CPU, 원 N개 루프) | `stepScene` (CPU, 원 N개 루프) |
| 상태 업로드 | `gl.bufferSubData` | `device.queue.writeBuffer` |
| 그리기 | `gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, count)` | `pass.draw(6, count)` 후 `queue.submit` |
| 꼭짓점 번호 | `gl_VertexID` | `@builtin(vertex_index)` |
| 인스턴스 데이터 | 정점 속성 + divisor | 스토리지 버퍼 + `instance_index` |

두 렌더러 모두 매 프레임 CPU가 원 N개의 위치를 계산하고 N × 16바이트를 GPU로 올립니다. GPU 쪽 작업도 같은 셰이더 계산입니다. 그래서 이 장면에서는 두 API의 성능 차이가 크게 나지 않을 것으로 예상할 수 있고, 측정 결과도 그렇습니다(아래 표).

WebGPU가 WebGL2보다 확실히 나은 점은 다른 데 있습니다. WebGPU는 컴퓨트 셰이더를 제공하고, 컴퓨트 패스가 쓴 버퍼를 렌더 패스가 그대로 읽을 수 있습니다. 다음 절의 다섯 번째 렌더러가 이 점을 이용합니다.

## 시뮬레이션까지 GPU로 옮기기

`webgpu-cpu` 렌더러의 매 프레임 비용 중 원 개수에 비례하는 부분은 `stepScene` 루프와 `writeBuffer` 업로드입니다. `webgpu-compute` 렌더러는 이 둘을 없앱니다. 상태는 처음부터 GPU 스토리지 버퍼에 있고, 컴퓨트 패스가 매 프레임 바운스 규칙을 계산합니다.

```wgsl
// src/demos/render-compare/renderers/compute-sim.ts (12-24행)
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
```

스레드 하나가 원 하나를 맡아, `scene.ts`의 `bounceAxis`와 같은 규칙을 x와 y에 적용합니다. 워크그룹 크기 64와 `global_invocation_id`, 범위 검사(`if (i >= params.count)`)의 의미는 [3장](03-compute-reduction.md)에서 자세히 다룹니다.

한 프레임은 커맨드 인코더 하나에 컴퓨트 패스와 렌더 패스를 차례로 기록하고 한 번 제출합니다.

```ts
// src/demos/render-compare/renderers/webgpu-compute.ts (19-26행)
      frame() {
        const encoder = device.createCommandEncoder();
        sim.encodeStep(encoder, timer?.first);
        drawer.encode(encoder, timer?.last);
        timer?.resolve(encoder);
        device.queue.submit([encoder.finish()]);
        timer?.afterSubmit();
      },
```

두 패스가 같은 `stateBuf`를 씁니다. 컴퓨트 패스는 `read_write`로 쓰고 렌더 패스는 `read`로 읽습니다. 같은 인코더 안에서 앞 패스가 쓴 값은 뒤 패스에서 보이므로, 렌더 패스는 이번 프레임에 갱신된 위치를 그립니다. CPU는 원 개수와 무관하게 인코딩과 제출만 합니다. 결과를 CPU로 읽어 오는 readback도 없습니다. 이런 "계산하고 바로 그리기" 구조는 [7장](07-compute-to-render.md)의 N-body 데모에서 더 크게 쓰입니다.

> **주의**
> WGSL은 CPU 코드와 같은 결과를 내야 합니다. 데모의 **컴퓨트 검증** 버튼은 원 4,096개로 CPU `stepScene`과 컴퓨트 패스를 각각 60스텝 돌린 뒤 GPU 상태를 한 번 읽어 와 최대 오차를 비교합니다(`src/demos/render-compare/verify.ts`, 기준 0.01픽셀 이하). GPU는 `p + v × dt`를 한 번에 반올림할 수 있어서 0이 아닌 작은 오차가 정상입니다. 바운스 규칙이 틀리면 오차가 픽셀 단위로 커집니다. 성능을 비교하기 전에 두 구현이 같은 일을 하는지부터 확인합니다.

## 측정 결과

데모의 **최대 N 찾기**는 원 개수를 두 배씩 늘리다가 실패하면 이분 탐색으로 좁혀서, 주사율을 유지하는 최대 N을 찾습니다. 통과 기준과 그 기준이 왜 그렇게 생겼는지는 [9장](09-measuring.md)에서 설명합니다.

헤드리스 Chromium, Apple M1, 1회 측정, 참고용입니다.

| 렌더러 | 주사율을 유지한 최대 N |
|---|---|
| SVG | 약 5,750 |
| Canvas2D | 약 48,000 |
| WebGL2 | 약 560,000 |
| WebGPU (CPU 시뮬레이션) | 약 592,000 |
| WebGPU (컴퓨트 시뮬레이션) | 약 640,000 |

읽는 방법은 다음과 같습니다.

- **SVG에서 Canvas2D로 약 8배.** 원마다 DOM 노드를 갱신하던 비용이 원마다 API 호출 4번으로 바뀐 차이입니다.
- **Canvas2D에서 GPU 렌더러로 약 10배 이상.** 원마다 하던 CPU 작업이 draw 호출 한 번으로 바뀐 차이입니다.
- **WebGL2와 WebGPU(CPU 시뮬레이션)는 비슷합니다.** 약 6% 차이는 1회 측정의 잡음 범위 안이므로 "WebGPU가 더 빠르다"는 근거가 되지 못합니다. 두 렌더러는 매 프레임 같은 CPU 루프와 같은 크기의 업로드를 하고, GPU에서도 같은 셰이더를 돌리기 때문입니다.
- **컴퓨트 시뮬레이션은 CPU를 비웁니다.** 최대 N은 크게 늘지 않았지만, 이 렌더러의 `frame()`에는 원 개수에 비례하는 CPU 작업이 없습니다. 메인 스레드가 다른 일(UI, 네트워크, 게임 로직)을 할 여유가 생긴다는 뜻입니다. 최대 N이 640,000 근처에서 멈춘 원인은 측정하지 않았습니다. 원 수십만 개가 겹쳐 그려지는 프래그먼트 셰이더와 블렌딩 비용, 즉 GPU 쪽 픽셀 처리량이 한계일 것으로 추정합니다.

> **해보기**
> 데모에서 N을 정하고 **고정 N 실행**으로 `webgl2`, `webgpu-cpu`, `webgpu-compute`를 실행한 뒤 결과 표의 **cpu 중앙값** 열을 비교해 보세요. N을 두 배로 늘렸을 때 앞의 두 렌더러는 이 값이 함께 늘어나지만, `webgpu-compute`는 거의 그대로일 것입니다. 이 장의 측정값과 다를 수 있으니 직접 확인하세요.

## 정리

- SVG는 원마다 DOM 노드를 갱신해서 스타일, 레이아웃, 페인트 비용이 원 개수만큼 듭니다. Canvas2D는 원마다 API 호출이 4번입니다. 둘 다 원 하나당 CPU 작업이 있어 일찍 한계에 닿습니다.
- 렌더 파이프라인은 정점 셰이더, 래스터화, 프래그먼트 셰이더, 블렌딩 순서로 진행합니다. 원은 사각형을 그린 뒤 프래그먼트 셰이더에서 원 밖 픽셀을 `discard`해서 만듭니다.
- 인스턴싱은 `draw(6, count)` 한 번으로 같은 도형 N개를 그립니다. 셰이더는 `vertex_index`와 `instance_index`로 자기 데이터를 찾아 읽습니다.
- premultiplied alpha와 `one`, `one-minus-src-alpha` 블렌드를 함께 쓰면 색과 알파가 같은 식으로 맞게 섞이고, `alphaMode: 'premultiplied'` 캔버스와 브라우저 합성도 맞습니다.
- 이 장면에서 WebGL2와 WebGPU의 그리기 성능은 측정 잡음 범위 안에서 같습니다. WebGPU의 차이는 컴퓨트 패스로 시뮬레이션을 GPU에 옮겨 CPU를 비울 수 있다는 점에서 나옵니다.

## 다음 장

[3장 리덕션으로 배우는 컴퓨트 셰이더](03-compute-reduction.md)에서는 이 장에서 넘어간 워크그룹, 호출 ID, 디스패치 크기 계산을 숫자 N개의 합을 구하는 예제로 자세히 봅니다.
