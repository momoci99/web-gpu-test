export type SourceKind = 'synthetic' | 'camera';

export interface VideoSource {
  readonly kind: SourceKind;
  readonly video: HTMLVideoElement;
  stop(): void;
}

/** Deterministic in `n` only: no wall clock, so frame n looks the same on every run. */
export function drawPattern(ctx: CanvasRenderingContext2D, width: number, height: number, n: number): void {
  const grad = ctx.createLinearGradient(0, 0, width, height);
  grad.addColorStop(0, `hsl(${(n * 2) % 360} 70% 45%)`);
  grad.addColorStop(1, `hsl(${(n * 2 + 140) % 360} 70% 30%)`);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, width, height);

  const cell = Math.max(8, Math.round(height / 22));
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  for (let y = 0; y < height / 3; y += cell) {
    for (let x = 0; x < width / 3; x += cell) {
      if (((x + y) / cell) % 2 === 0) ctx.fillRect(x, y, cell, cell);
    }
  }

  ctx.lineWidth = 2;
  ctx.strokeStyle = '#fff';
  for (let i = 0; i < 24; i++) {
    const x = (i * width) / 12 + ((n * 3) % (width / 12));
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x - height / 2, height);
    ctx.stroke();
  }

  for (let i = 0; i < 6; i++) {
    const a = n * 0.03 + i * 1.047;
    const cx = width / 2 + Math.cos(a) * width * 0.3;
    const cy = height / 2 + Math.sin(a * 1.3) * height * 0.3;
    ctx.fillStyle = i % 2 ? '#111' : '#ffd23f';
    ctx.beginPath();
    ctx.arc(cx, cy, height * 0.09, 0, Math.PI * 2);
    ctx.fill();
  }
}

export function createPatternCanvas(width: number, height: number, n: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  drawPattern(canvas.getContext('2d', { willReadFrequently: true })!, width, height, n);
  return canvas;
}

async function playable(video: HTMLVideoElement): Promise<void> {
  video.muted = true;
  video.playsInline = true;
  await video.play();
  if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
    await new Promise<void>((resolve) => video.addEventListener('loadeddata', () => resolve(), { once: true }));
  }
}

/** The pattern canvas is captured into a video element so both variants read the same kind of source as a camera. */
export async function openSyntheticSource(width: number, height: number): Promise<VideoSource> {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  const stream = canvas.captureStream(0);
  const track = stream.getVideoTracks()[0] as MediaStreamTrack & { requestFrame(): void };
  let n = 0;
  let raf = 0;
  const loop = () => {
    drawPattern(ctx, width, height, n++);
    track.requestFrame();
    raf = requestAnimationFrame(loop);
  };
  loop();
  const video = document.createElement('video');
  video.srcObject = stream;
  await playable(video);
  return {
    kind: 'synthetic',
    video,
    stop() {
      cancelAnimationFrame(raf);
      video.pause();
      video.srcObject = null;
      for (const t of stream.getTracks()) t.stop();
    },
  };
}

export class CameraError extends Error {}

function cameraMessage(err: unknown): string {
  const name = err instanceof DOMException ? err.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return '카메라 권한이 거부되었습니다. 브라우저 주소창의 권한 설정에서 카메라를 허용한 뒤 다시 시도하세요. 합성 영상은 카메라 없이 쓸 수 있습니다.';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return '사용 가능한 카메라를 찾을 수 없습니다. 합성 영상을 대신 사용하세요.';
  if (name === 'NotReadableError') return '카메라가 다른 앱에서 사용 중이라 열 수 없습니다.';
  return `카메라를 시작하지 못했습니다: ${String(err)}`;
}

export async function openCameraSource(width: number, height: number): Promise<VideoSource> {
  if (!navigator.mediaDevices?.getUserMedia) throw new CameraError('이 브라우저는 getUserMedia를 지원하지 않거나 보안 컨텍스트가 아닙니다.');
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: width }, height: { ideal: height } }, audio: false });
  } catch (err) {
    throw new CameraError(cameraMessage(err));
  }
  const video = document.createElement('video');
  video.srcObject = stream;
  await playable(video);
  return {
    kind: 'camera',
    video,
    stop() {
      video.pause();
      video.srcObject = null;
      for (const t of stream.getTracks()) t.stop();
    },
  };
}

export function openSource(kind: SourceKind, width: number, height: number): Promise<VideoSource> {
  return kind === 'camera' ? openCameraSource(width, height) : openSyntheticSource(width, height);
}
