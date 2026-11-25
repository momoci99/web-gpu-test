---
title: 워크그룹 메모리와 타일링
order: 4
summary: "타일링으로 글로벌 메모리 로드를 줄입니다: 행렬 곱 예제"
demo: compute-bench      # optional
---

# 워크그룹 메모리와 타일링

이 장을 읽고 나면 타일링이 왜 빠른지 설명할 수 있습니다. `compute-bench`에서 GEMM을 엽니다.

## 메모리 계층

글로벌 메모리는 느리고 `var<workgroup>`은 빠릅니다. 자세한 내용은 [아토믹](05-atomics.md)과 [측정](09-measuring.md#타임스탬프)을 봅니다.

![메모리 계층 다이어그램](img/memory-hierarchy.svg)

> **핵심**
> 같은 값을 여러 스레드가 읽는다면 한 번만 올려서 공유합니다.

> **주의** 두 번째 배리어를 빼면 틀린 값이 나옵니다.

> **해보기**
> n을 1024로 두고 gpu-naive와 gpu-tiled를 비교합니다.
>
> 두 번째 문단도 같은 상자에 들어갑니다.

> **측정 한계**: 헤드리스 Chromium, Apple M1, 1회 측정, 참고용.

> **용어**
> 워크그룹(workgroup)은 메모리를 공유하는 스레드 묶음입니다.

> 라벨이 없는 인용문은 보통 인용문으로 남습니다.

## 코드

```wgsl
@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {}
```

```ts
const device = await adapter.requestDevice();
```

```js
console.log('hi');
```

```text
plain output
```

## 표

| 커널 | 로드 수 | 비고 |
|---|---:|---|
| naive | 2n | 느림 |
| tiled | 2n/16 | 빠름 |

## 링크

[저장소 파일](../../src/demos/compute-bench/workloads/gemm/kernels.ts) 과 [외부](https://gpuweb.github.io/gpuweb/) 와 [같은 장](#메모리-계층).

## 코드

같은 제목이 두 번 나오면 두 번째에 `-2`가 붙습니다.
