# 웹캠 필터: 블러와 엣지 검출 (CPU vs WebGPU)

같은 비디오 프레임에 같은 필터를 CPU(Canvas2D `getImageData` + JS 루프)와 WebGPU 컴퓨트로 적용하고, 블러 반경이 커질 때 비용이 어떻게 달라지는지 봅니다. 코드는 `src/demos/webcam-filter/`에 있습니다.

## 구조

| 파일 | 역할 |
|---|---|
| `filters.ts` | 필터 정의, 가우시안 가중치, `maxRadiusAtRefresh`(반경 탐색, `rampMaxN` 재사용) |
| `cpu-filter.ts` | CPU 기준 구현 (RGBA 바이트 배열, clamp-to-edge) |
| `gpu-filter.ts` | WGSL 컴퓨트 패스: ingest, 가로 블러, 세로 블러, 소벨, 그레이스케일 |
| `variants.ts` | 변형 `cpu-canvas`, `gpu-compute`. 둘 다 `FrameTarget`이라 `runFrames`로 잰다 |
| `source.ts` | 합성 영상(캔버스 패턴을 `captureStream()`으로 비디오화)과 `getUserMedia` 카메라 |
| `verify.ts` | 같은 고정 프레임을 CPU와 GPU에 통과시켜 차이를 보고 |

## importExternalTexture는 왜 복사를 피하나

`device.importExternalTexture({ source: video })`는 비디오 디코더가 만든 프레임(보통 YUV 표면)을 새 텍스처로 복사하지 않고 `texture_external`로 감쌉니다. 셰이더에서 `textureSampleBaseClampToEdge`로 읽을 때 YUV에서 RGB로의 변환과 색 공간 변환이 같이 처리됩니다. 비교하면 `copyExternalImageToTexture`는 프레임을 일반 텍스처로 복사합니다.

`GPUExternalTexture`의 수명은 한 프레임입니다. 현재 작업(task)이 끝나면 만료되므로 프레임마다 `importExternalTexture`를 다시 부르고, 그 텍스처가 들어간 바인드 그룹도 프레임마다 새로 만듭니다. 이 데모의 ingest 패스가 그 일을 하고, 결과를 `rgba16float` 스토리지 텍스처에 씁니다.

## 스토리지 텍스처와 버퍼

- 스토리지 텍스처: 2D 좌표로 `textureLoad`/`textureStore` 합니다. 이미지 처리에서는 인덱스 계산이 필요 없고 경계 처리를 `clamp`로 쓰기 쉽습니다. 쓰기 전용(`write`)으로 선언할 수 있는 포맷이 정해져 있어서 중간 결과는 `rgba16float`, 최종 결과는 `rgba8unorm`을 썼습니다.
- 스토리지 버퍼: 포맷 제약이 없고 임의 구조를 담을 수 있지만 `y * width + x` 계산과 픽셀 패킹을 직접 해야 합니다. 이 데모는 가우시안 가중치(`array<f32>`)에만 버퍼를 씁니다.
- 가로 패스는 `a`를 읽어 `b`에 쓰고, 세로 패스는 `b`를 읽어 최종 텍스처에 씁니다. 읽는 텍스처와 쓰는 텍스처를 분리하는 것이 핑퐁입니다.

## 분리형 컨볼루션

반경 r인 2D 가우시안은 가로 1D와 세로 1D의 곱으로 나뉩니다. 한 픽셀에 (2r+1)×(2r+1) 탭이 필요한 대신 가로 2r+1, 세로 2r+1, 합계 2·(2r+1) 탭이면 됩니다. r=16이면 1089탭이 66탭이 됩니다. 그래도 비용은 `반경 × 픽셀 수`로 늘어서, CPU에서는 반경을 키울수록 프레임 시간이 거의 선형으로 늘어납니다.

이 데모의 GPU 구현은 공유 메모리 타일링 없이 탭마다 `textureLoad`를 합니다. 인접 스레드가 같은 텍셀을 읽으므로 텍스처 캐시가 대부분 받아 줄 것으로 추정합니다(측정하지 않았습니다). 더 줄이는 방법은 워크그룹 공유 메모리 타일이나 선형 샘플링 트릭이지만 이 데모의 범위 밖입니다.

## getImageData는 왜 느릴 수 있나

`getImageData`는 캔버스에 그려진 픽셀을 JS 메모리로 읽어 옵니다. 캔버스가 GPU에 있으면 GPU 작업을 기다렸다가 CPU 메모리로 복사(readback)하는 동기 호출이고, 결과는 매번 새 `ImageData`로 할당됩니다. 이 데모는 `willReadFrequently: true`로 소프트웨어 캔버스를 써서 그 비용을 줄인 공정한 기준선입니다.

이번 측정(Apple M1, 통합 메모리, 1280×720)에서 `drawImage + getImageData`는 약 2 ms, `putImageData`는 약 0.5 ms였습니다. 즉 이 기계에서는 readback보다 JS 필터 루프가 지배적입니다. 별도 VRAM이 있는 GPU에서는 readback 비중이 더 클 수 있어서, 이 비율을 일반화하면 안 됩니다.

## 숫자 읽는 법

모든 값은 헤드리스 Chromium(Apple M1)에서 다른 GPU 작업과 겹쳐 돈 스모크 값입니다. 성능 주장이 아닙니다.

- rAF가 주사율(약 60 Hz, 16.7 ms)에서 멈추므로 프레임 간격 중앙값만 보면 "빠른" 변형들이 모두 16.7 ms로 같게 나옵니다. 그래서 큐를 비운 뒤 재는 `실효 프레임 시간`이 판정 기준입니다.
- CPU 변형의 `cpu` 열은 drawImage + getImageData + 필터 + putImageData 전체입니다. WebGPU 변형의 `cpu` 열은 인코딩 + 제출만이고, GPU 시간은 `gpu`(timestamp-query) 열에 따로 나옵니다.
- "주사율에서 유지되는 최대 블러 반경"은 반경 1..32를 두 배씩 키우다 실패하면 이분 탐색한 값입니다. 32가 나오면 탐색 상한이고 GPU의 한계가 아닙니다. 0이면 반경 1에서도 주사율을 못 맞춘다는 뜻입니다.

스모크 값 예시 (1280×720, 블러, 실효 프레임 시간 / cpu 중앙값 / gpu 중앙값):

| 변형 | 반경 4 | 반경 16 |
|---|---|---|
| cpu-canvas | 40.6 ms / 39.7 ms / - | 126.8 ms / 124.6 ms / - |
| gpu-compute | 16.8 ms / 0.8 ms / 2.2 ms | 16.8 ms / 0.9 ms / 5.1 ms |

CPU는 반경이 4배가 되자 비용이 약 3배로 늘었고 (반경과 무관한 drawImage·getImageData·putImageData 약 2.5 ms가 섞여 있음), GPU는 GPU 시간이 2.2 ms에서 5.1 ms로 늘었지만 16.7 ms 안에 들어와 프레임 간격에는 드러나지 않습니다.

## 정합성

`verifyParity`는 640×360 합성 패턴 한 프레임(37번)을 CPU와 GPU에 같은 필터와 반경으로 통과시키고 읽어 옵니다. 가장자리는 둘 다 clamp-to-edge입니다. 허용 오차는 채널당 최대 2, 평균 0.1(0..255 기준)입니다. 둘 다 마지막에 8비트로 반올림하고, GPU는 블러 중간 텍스처를 float16(상대 오차 2^-11)에 두고 곱셈-덧셈이 합쳐질 수 있어 합이 1단계의 몇 분의 일만큼 다릅니다. 반올림 경계에서 1단계가 뒤집히는 정도이며, 탭 위치·가중치·가장자리 규칙이 틀리면 수십 단계가 어긋납니다. 실측은 최대 1, 평균 0.01 ~ 0.05였습니다.

## 반경 탐색 결과 읽기

같은 스모크 환경에서 주사율(59.9 Hz)을 유지한 최대 블러 반경은 다음과 같았습니다.

- cpu-canvas: 640×360에서 8, 1280×720과 1920×1080에서 0. 한계는 JS 필터 루프입니다. 반경 9에서 이미 실효 프레임 시간이 19.3 ms(기준 18.4 ms)였습니다.
- gpu-compute: 모든 해상도에서 32(탐색 상한). 한계를 찾지 못한 것입니다. 반경 32의 GPU 시간은 1280×720에서 5.9 ms, 1920×1080에서 7.7 ms로 16.7 ms 안이었습니다.
