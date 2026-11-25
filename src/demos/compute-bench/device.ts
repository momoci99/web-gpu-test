import type { Capabilities } from '../../core/capabilities';

/** One device per page. Raises the buffer limits to what the adapter offers so large workloads fit. */
export async function requestComputeDevice(caps: Capabilities): Promise<GPUDevice | null> {
  if (caps.webgpu.kind !== 'available') return null;
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) return null;
  const device = await adapter.requestDevice({
    requiredFeatures: adapter.features.has('timestamp-query') ? ['timestamp-query'] : [],
    requiredLimits: {
      maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
      maxBufferSize: adapter.limits.maxBufferSize,
    },
  });
  device.addEventListener('uncapturederror', (e) => console.error('WebGPU 오류:', (e as GPUUncapturedErrorEvent).error.message));
  return device;
}
