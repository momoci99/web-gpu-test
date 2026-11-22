export type WebGpuCaps =
  | { kind: 'available'; timestampQuery: boolean; adapterInfo: string }
  | { kind: 'unavailable'; reason: string };

export interface Capabilities {
  webgpu: WebGpuCaps;
  webgl2: boolean;
  longAnimationFrames: boolean;
  dpr: number;
}

export type Requirement = 'none' | 'webgl2' | 'webgpu';

async function detectWebGpu(): Promise<WebGpuCaps> {
  if (!('gpu' in navigator)) {
    return { kind: 'unavailable', reason: 'navigator.gpu가 없습니다 (브라우저가 WebGPU를 지원하지 않거나 보안 컨텍스트가 아닙니다)' };
  }
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
      return { kind: 'unavailable', reason: 'requestAdapter()가 null을 반환했습니다 (사용 가능한 GPU 어댑터 없음)' };
    }
    const { vendor, architecture, device, description } = adapter.info;
    const adapterInfo = [vendor, architecture, device, description].filter(Boolean).join(' / ') || '알 수 없음';
    return { kind: 'available', timestampQuery: adapter.features.has('timestamp-query'), adapterInfo };
  } catch (err) {
    return { kind: 'unavailable', reason: `requestAdapter() 실패: ${String(err)}` };
  }
}

function detectWebGl2(): boolean {
  try {
    return document.createElement('canvas').getContext('webgl2') !== null;
  } catch {
    return false;
  }
}

function detectLongAnimationFrames(): boolean {
  return (PerformanceObserver.supportedEntryTypes ?? []).includes('long-animation-frame');
}

export async function detectCapabilities(): Promise<Capabilities> {
  return {
    webgpu: await detectWebGpu(),
    webgl2: detectWebGl2(),
    longAnimationFrames: detectLongAnimationFrames(),
    dpr: window.devicePixelRatio || 1,
  };
}

export function unmetReason(requires: Requirement, caps: Capabilities): string | null {
  switch (requires) {
    case 'none':
      return null;
    case 'webgl2':
      return caps.webgl2 ? null : 'WebGL2를 사용할 수 없습니다';
    case 'webgpu':
      return caps.webgpu.kind === 'available' ? null : caps.webgpu.reason;
  }
}
