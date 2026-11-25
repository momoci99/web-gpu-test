---
title: 용어집
order: 99
summary: 이 사이트에 나오는 GPU와 WebGPU 용어의 짧은 정의와, 그 용어를 설명하는 장의 링크입니다.
---

# 용어집

이 사이트의 장에 나오는 용어를 가나다순으로 모았습니다. 정의는 이 사이트에서 쓰는 뜻으로 짧게 적었습니다. 자세한 설명과 예제는 오른쪽 열의 장에 있습니다.

| 용어 | 영어 | 뜻 | 설명하는 장 |
|---|---|---|---|
| 경쟁 상태 | race condition | 여러 호출이 같은 메모리를 동시에 읽고 써서 결과가 실행 순서에 따라 달라지는 상태. | [5장](05-atomics.md) |
| 경합 | contention | 많은 호출이 같은 주소에 아토믹 연산을 하려고 줄을 서서 느려지는 현상. | [5장](05-atomics.md) |
| 교차점 | crossover | 그 크기부터 측정한 모든 더 큰 입력에서 GPU가 CPU보다 빠른 가장 작은 입력 크기. | [0장](00-why-gpu.md) |
| 내장 값 | builtin, `@builtin` | GPU가 셰이더에 넘겨주는 값. `global_invocation_id`, `workgroup_id`, `local_invocation_index` 등으로 호출이 자기 번호를 안다. | [1장](01-webgpu-basics.md), [3장](03-compute-reduction.md) |
| 데이터 병렬 | data parallelism | 원소마다 같은 계산을 서로 독립적으로 하는 일의 형태. GPU가 가장 잘하는 일이다. | [0장](00-why-gpu.md) |
| 디바이스 | device, `GPUDevice` | 페이지와 GPU 사이의 논리적 연결. 버퍼, 셰이더, 파이프라인을 만들고, 만든 객체는 그 디바이스 안에서만 쓸 수 있다. | [1장](01-webgpu-basics.md) |
| 디바이스 손실 | device lost | 드라이버 문제나 `destroy()`로 디바이스를 더 쓸 수 없게 된 상태. `device.lost` 프라미스로 알 수 있다. | [1장](01-webgpu-basics.md) |
| 디스패치 | dispatch, `dispatchWorkgroups` | 컴퓨트 셰이더를 워크그룹 몇 개로 실행할지 지정하는 명령. 호출 수가 아니라 워크그룹 수를 넘긴다. | [1장](01-webgpu-basics.md), [3장](03-compute-reduction.md) |
| 레인 | lane | GPU의 단순한 연산 장치 하나. 레인 여러 개가 묶여 같은 명령을 서로 다른 데이터에 실행한다. | [0장](00-why-gpu.md) |
| 렌더 파이프라인 | render pipeline | 정점 셰이더, 프래그먼트 셰이더, 출력 형식, 블렌딩을 묶은 그리기용 파이프라인. | [2장](02-render-pipeline.md) |
| 리덕션 | reduction | 배열 전체를 값 하나로 줄이는 계산. 합계, 최댓값 등. GPU에서는 트리 모양으로 짝지어 더한다. | [3장](03-compute-reduction.md) |
| 리드백 | readback | GPU 버퍼의 결과를 CPU로 가져오는 과정. 복사, `mapAsync`, `getMappedRange`로 이루어진다. | [1장](01-webgpu-basics.md), [9장](09-measuring.md) |
| 맵핑 | mapping, `mapAsync` | 버퍼의 소유권을 잠시 CPU에 넘겨 JS에서 내용을 읽거나 쓰게 하는 일. `unmap`으로 GPU에 돌려준다. 셰이더가 쓴 결과는 `MAP_READ \| COPY_DST` 버퍼(스테이징 버퍼)로 복사한 뒤 맵핑한다. | [1장](01-webgpu-basics.md) |
| 바인드 그룹 | bind group | 셰이더의 `@group`/`@binding` 칸마다 실제 버퍼나 텍스처를 채운 객체. 셰이더 호출에 넘기는 인자 객체에 해당한다. 칸의 모양은 `layout: 'auto'`로 셰이더에서 자동으로 만들 수 있다. | [1장](01-webgpu-basics.md) |
| 배리어 | barrier, `workgroupBarrier` | 워크그룹의 모든 호출이 이 지점에 올 때까지 기다리게 하는 명령. 워크그룹 메모리에 쓴 값을 다른 호출이 읽기 전에 둔다. | [3장](03-compute-reduction.md), [4장](04-workgroup-memory.md) |
| 버퍼 | buffer, `GPUBuffer` | GPU가 관리하는 타입 없는 바이트 덩어리. 셰이더와 JS가 같은 바이트를 각자의 타입으로 해석한다. | [1장](01-webgpu-basics.md) |
| 셰이더 | shader | GPU에서 실행되는 함수. 컴퓨트 셰이더는 계산을, 정점 셰이더와 프래그먼트 셰이더는 그리기를 맡는다. | [1장](01-webgpu-basics.md), [2장](02-render-pipeline.md) |
| 스캔 | scan, prefix sum | 각 위치까지의 누적 합을 구하는 계산. 접두사 합이라고도 한다. 기수 정렬에서 원소가 갈 위치를 정한다. | [6장](06-multi-pass-sort.md) |
| 아토믹 | atomic, `atomic<u32>` | 다른 호출의 간섭 없이 한 번에 끝나는 메모리 연산. `atomicAdd` 등으로 경쟁 상태를 막는다. | [5장](05-atomics.md) |
| 안정 정렬 | stable sort | 키가 같은 원소의 입력 순서를 유지하는 정렬. LSD 기수 정렬은 자릿수마다 안정 정렬이어야 결과가 맞다. | [6장](06-multi-pass-sort.md) |
| 어댑터 | adapter, `GPUAdapter` | 실제 GPU 하나와 그 드라이버를 나타내는 객체. 지원 기능과 한계값을 알려 주고, 여기서 디바이스를 만든다. | [1장](01-webgpu-basics.md) |
| 업로드 | upload, `writeBuffer` | CPU 메모리의 데이터를 GPU 버퍼로 복사하는 일. 데이터가 크면 GPU 계산보다 오래 걸릴 수 있다. | [0장](00-why-gpu.md), [1장](01-webgpu-basics.md) |
| 연산 강도 | arithmetic intensity | 읽거나 옮긴 데이터 1바이트당 연산 수. 높을수록 GPU가 이득을 보기 쉽다. | [0장](00-why-gpu.md), [4장](04-workgroup-memory.md) |
| 오류 스코프 | error scope | `pushErrorScope`와 `popErrorScope` 사이에서 난 WebGPU 오류를 코드로 받는 방법. | [1장](01-webgpu-basics.md) |
| 외부 텍스처 | external texture, `importExternalTexture` | `<video>` 프레임을 복사를 줄여 셰이더에 넘기는 텍스처. 가져온 작업(task)이 끝나면 만료되므로 프레임마다 다시 가져온다. | [8장](08-textures-video.md) |
| 워크그룹 | workgroup | 함께 실행되는 호출의 묶음. 크기는 `@workgroup_size`로 정하고, 같은 워크그룹의 호출끼리만 워크그룹 메모리를 나누고 배리어로 기다릴 수 있다. | [1장](01-webgpu-basics.md), [3장](03-compute-reduction.md) |
| 워크그룹 메모리 | workgroup memory, `var<workgroup>` | 한 워크그룹의 호출들이 함께 쓰는 작고 빠른 메모리. 전역 메모리 읽기를 줄이는 데 쓴다. 공유 메모리(shared memory)라고도 부른다. | [4장](04-workgroup-memory.md) |
| 인스턴싱 | instancing | 같은 모양을 한 번의 그리기 호출로 여러 개 그리는 기법. 셰이더는 `instance_index`로 몇 번째인지 안다. | [2장](02-render-pipeline.md) |
| 제출 | submit | 인코더가 기록한 명령 버퍼(`encoder.finish()`)를 큐에 넣는 일. 프라미스를 돌려주지 않고 바로 반환한다. | [1장](01-webgpu-basics.md) |
| 주소 공간 | address space | WGSL 변수가 놓이는 메모리 종류. `storage`, `uniform`, `workgroup`, `function` 등이 있다. | [1장](01-webgpu-basics.md), [4장](04-workgroup-memory.md) |
| 지연 시간 | latency | 일 하나가 시작해서 끝날 때까지 걸리는 시간. | [0장](00-why-gpu.md) |
| 처리량 | throughput | 단위 시간에 끝내는 일의 양. GPU는 지연 시간보다 처리량에 맞춰 설계된다. | [0장](00-why-gpu.md) |
| 커널 시간 | kernel time | GPU가 셰이더를 실행한 구간만 잰 시간. 타임스탬프 쿼리로 잰다. | [0장](00-why-gpu.md), [9장](09-measuring.md) |
| 커맨드 인코더 | command encoder | GPU 명령을 기록하는 객체. 기록만 하고, 실행은 `submit` 뒤에 일어난다. | [1장](01-webgpu-basics.md) |
| 컴퓨트 파이프라인 | compute pipeline | 셰이더 진입점과 리소스 레이아웃을 묶어 GPU용으로 컴파일한 결과. `createComputePipelineAsync`로 만든다. | [1장](01-webgpu-basics.md) |
| 큐 | queue, `GPUQueue` | 디바이스에 일을 보내는 통로. `writeBuffer`와 `submit`이 큐를 거치고, 들어온 순서대로 실행된다. | [1장](01-webgpu-basics.md) |
| 타일링 | tiling | 데이터를 작은 조각(타일)으로 나눠 워크그룹 메모리에 올려 두고 여러 번 재사용하는 기법. | [4장](04-workgroup-memory.md), [7장](07-compute-to-render.md) |
| 타임스탬프 쿼리 | timestamp query | 패스의 시작과 끝에 GPU 시각을 기록하는 기능. 디바이스를 만들 때 `timestamp-query`를 요청해야 쓸 수 있다. | [1장](01-webgpu-basics.md), [9장](09-measuring.md) |
| 텍스처 | texture | 2차원 이미지 같은 데이터를 담는 GPU 리소스. 버퍼와 달리 픽셀 형식과 차원을 가진다. | [8장](08-textures-video.md) |
| 패스 | pass | 인코더 안에서 같은 종류의 GPU 작업을 묶는 구간. 컴퓨트 패스와 렌더 패스가 있다. | [1장](01-webgpu-basics.md), [6장](06-multi-pass-sort.md) |
| 프라이빗화 | privatization | 워크그룹마다 결과의 사본을 워크그룹 메모리에 두고 마지막에 합쳐 전역 경합을 줄이는 기법. | [5장](05-atomics.md) |
| 핑퐁 버퍼 | ping-pong buffers | 버퍼 둘을 번갈아 입력과 출력으로 쓰는 방법. 읽는 중인 데이터를 덮어쓰지 않게 한다. | [6장](06-multi-pass-sort.md), [7장](07-compute-to-render.md) |
| 호출 | invocation | 셰이더 함수가 한 번 실행되는 단위. JS 루프 한 바퀴에 해당한다. 스레드(thread)라고도 부른다. | [1장](01-webgpu-basics.md), [3장](03-compute-reduction.md) |
| e2e | end to end | 업로드부터 결과를 JS로 받을 때까지의 벽시계 시간. CPU와 비교하는 기준이다. | [0장](00-why-gpu.md), [9장](09-measuring.md) |
| FLOP | floating-point operation | 부동소수점 연산 하나. 곱셈과 덧셈을 각각 하나로 센다. 초당 FLOP 수가 FLOP/s다. | [0장](00-why-gpu.md), [4장](04-workgroup-memory.md) |
| storage 버퍼 | storage buffer, `var<storage>` | 셰이더가 읽고 쓸 수 있는 큰 버퍼. 컴퓨트 셰이더의 입력과 출력에 주로 쓴다. | [1장](01-webgpu-basics.md) |
| uncapturederror | uncaptured error event | 오류 스코프가 잡지 않은 WebGPU 오류를 알리는 디바이스 이벤트. | [1장](01-webgpu-basics.md) |
| uniform 버퍼 | uniform buffer, `var<uniform>` | 작고 읽기만 하는 버퍼. 모든 호출이 같은 값을 읽는 설정값에 쓴다. | [1장](01-webgpu-basics.md), [3장](03-compute-reduction.md) |
| usage 플래그 | usage flags, `GPUBufferUsage` | 버퍼를 만들 때 밝히는 용도 목록. `STORAGE`, `COPY_DST`, `MAP_READ` 등을 비트 OR로 묶고, 밝히지 않은 용도로 쓰면 오류다. | [1장](01-webgpu-basics.md) |
| WGSL | WebGPU Shading Language | WebGPU의 셰이더 언어. 정적 타입이고 숫자 타입 사이의 자동 변환이 거의 없다. | [1장](01-webgpu-basics.md) |
