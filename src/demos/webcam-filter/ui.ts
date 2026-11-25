import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { unmetReason, type Capabilities } from '../../core/capabilities';
import { estimateRefresh } from '../../core/frame-bench';
import { FILTERS, MAX_RADIUS, RESOLUTIONS, type FilterId } from './filters';
import { findMaxRadius, runVariant, type RunConfig, type RunResult } from './run';
import { CameraError, openSource, type SourceKind, type VideoSource } from './source';
import { registry, type VariantEntry } from './variants';
import { verifyParity } from './verify';

const SERIES_COLORS = ['#e4572e', '#17bebb'];
const SWEEP_RADII = [1, 2, 4, 8, 16, 32];

const EXPLAINER = [
  'importExternalTexture는 비디오 프레임을 GPU 텍스처로 복사하지 않고 그대로 바인딩합니다. 대신 이 GPUExternalTexture는 한 프레임 동안만 유효해서 프레임마다 새로 만들어야 합니다.',
  'CPU 경로의 병목은 계산만이 아닙니다. getImageData는 GPU 쪽 비디오 프레임을 CPU 메모리로 읽어 오는 동기 readback이고, putImageData는 다시 올리는 비용입니다.',
  '분리형 블러는 (2r+1)×(2r+1) 탭 대신 가로 2r+1, 세로 2r+1 탭, 합계 2·(2r+1) 탭이면 됩니다. 그래도 CPU 비용은 반경 × 픽셀 수에 비례해 늘어납니다.',
  'GPU 블러는 가로 패스 결과를 스토리지 텍스처 한 장에 쓰고 세로 패스가 그것을 읽는 핑퐁 구조입니다. 가장자리는 CPU와 GPU 모두 clamp-to-edge입니다.',
];

const LIMITS_NOTES = [
  '헤드리스 Chromium 수치는 스모크 값이며, 다른 GPU 작업과 겹치면 흔들립니다. 성능 주장으로 쓰지 마세요.',
  'rAF는 주사율에서 멈추므로 프레임 간격 중앙값만으로는 부하를 구분할 수 없습니다. 실효 프레임 시간(큐를 비운 뒤 측정)이 판정 기준입니다.',
  'CPU 변형의 cpu 값은 drawImage + getImageData + 필터 + putImageData 전체입니다. WebGPU 변형의 cpu 값은 인코딩 + 제출만이고, GPU 시간은 gpu 열에 따로 나옵니다.',
  '합성 영상은 canvas.captureStream()으로 만든 비디오라 카메라와 같은 경로(video 요소)를 지나지만 압축 지연이 없고 내용이 결정적입니다.',
];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

const f = (x: number, d = 2) => x.toFixed(d);

export function mountWebcamFilter(root: HTMLElement, caps: Capabilities): void {
  const selected = new Set<string>();
  const results: RunResult[] = [];
  const maxRadii = new Map<string, number>();
  let refreshHz = 60;
  let busy = false;
  let source: VideoSource | null = null;
  let sourceSize = '';
  let preview: { stop(): Promise<void> } | null = null;

  const capsList = el('ul', { className: 'caps' });
  const renderCaps = () => {
    const gpu = caps.webgpu;
    capsList.replaceChildren(
      el('li', { textContent: `WebGPU: ${gpu.kind === 'available' ? `사용 가능 (${gpu.adapterInfo})` : `사용 불가 (${gpu.reason})`}` }),
      el('li', { textContent: `timestamp-query: ${gpu.kind === 'available' && gpu.timestampQuery ? '지원' : '미지원'}` }),
      el('li', { textContent: `주사율(추정): ${f(refreshHz, 1)} Hz` }),
    );
  };

  const variantBoxes = registry.map((entry) => {
    const reason = unmetReason(entry.requires, caps);
    const input = el('input', { type: 'checkbox', disabled: reason !== null });
    input.addEventListener('change', () => {
      if (input.checked) selected.add(entry.id);
      else selected.delete(entry.id);
      syncButtons();
    });
    if (reason === null) {
      input.checked = true;
      selected.add(entry.id);
    }
    return el(
      'div',
      { className: 'renderer' },
      el('label', { className: reason ? 'disabled' : '' }, input, ` ${entry.label}`),
      el('small', { textContent: reason ? `비활성: ${reason}` : entry.summary }),
    );
  });

  const kindSelect = el('select', {}, el('option', { value: 'synthetic', textContent: '합성 영상 (결정적, 카메라 불필요)' }), el('option', { value: 'camera', textContent: '웹캠 (getUserMedia)' }));
  const cameraBtn = el('button', { textContent: '카메라 시작' });
  const resSelect = el('select', {}, ...RESOLUTIONS.map((r, i) => el('option', { value: String(i), textContent: `${r.width}×${r.height}`, selected: i === 1 })));
  const filterSelect = el('select', {}, ...FILTERS.map((x) => el('option', { value: x.id, textContent: x.label, selected: x.id === 'blur' })));
  const radiusInput = el('input', { type: 'range', min: '1', max: String(MAX_RADIUS), step: '1', value: '4' });
  const radiusOut = el('output', { textContent: '4' });
  radiusInput.addEventListener('input', () => (radiusOut.textContent = radiusInput.value));
  const runBtn = el('button', { textContent: '고정 설정 실행' });
  const sweepBtn = el('button', { textContent: '반경 스윕 (블러)' });
  const maxBtn = el('button', { textContent: '최대 반경 찾기 (블러)' });
  const verifyBtn = el('button', { textContent: '정합성 검증' });
  const previewBtn = el('button', { textContent: '미리보기 시작' });
  const status = el('p', { className: 'status', textContent: '준비됨' });
  const stage = el('div', { className: 'stage' });
  const tableHost = el('div', { className: 'table' });
  const maxHost = el('ul', { className: 'caps' });
  const chartHost = el('div', { className: 'chart' });

  const resolution = () => RESOLUTIONS[Number(resSelect.value)]!;
  const kind = () => kindSelect.value as SourceKind;
  const variantsSelected = (): VariantEntry[] => registry.filter((e) => selected.has(e.id));
  const syncButtons = () => {
    const noVariant = selected.size === 0;
    runBtn.disabled = sweepBtn.disabled = maxBtn.disabled = busy || noVariant;
    previewBtn.disabled = noVariant || (busy && !preview);
    verifyBtn.disabled = busy || caps.webgpu.kind !== 'available';
    cameraBtn.disabled = busy || kind() !== 'camera';
    cameraBtn.hidden = kind() !== 'camera';
  };

  const closeSource = () => {
    source?.stop();
    source = null;
    sourceSize = '';
  };
  kindSelect.addEventListener('change', () => {
    closeSource();
    syncButtons();
  });

  const startCamera = async (): Promise<string> => {
    const { width, height } = resolution();
    closeSource();
    source = await openSource('camera', width, height);
    sourceSize = 'camera';
    return `카메라 시작됨 (${source.video.videoWidth}×${source.video.videoHeight})`;
  };

  const ensureSource = async (): Promise<VideoSource> => {
    if (kind() === 'camera') {
      if (!source) throw new CameraError('먼저 "카메라 시작"을 눌러 카메라를 켜세요.');
      return source;
    }
    const { width, height } = resolution();
    const key = `${width}x${height}`;
    if (!source || sourceSize !== key) {
      closeSource();
      source = await openSource('synthetic', width, height);
      sourceSize = key;
    }
    return source;
  };

  const plot = new uPlot(
    {
      width: 800,
      height: 320,
      title: '블러 반경 대비 실효 프레임 시간 (ms)',
      scales: { x: { time: false }, y: { range: (_u, _min, max) => [0, Math.max(20, max * 1.1)] } },
      axes: [{ label: '블러 반경' }, { label: '실효 프레임 시간 (ms)' }],
      series: [{}, ...registry.map((e, i) => ({ label: e.label, stroke: SERIES_COLORS[i % SERIES_COLORS.length], width: 2, spanGaps: true, points: { show: true } }))],
    },
    [[], ...registry.map(() => [])],
    chartHost,
  );

  const labelOf = (id: string) => registry.find((e) => e.id === id)?.label ?? id;
  const filterLabel = (id: FilterId) => FILTERS.find((x) => x.id === id)?.label.split(' ')[0] ?? id;

  const refreshOutputs = () => {
    const header = ['변형', '해상도', '필터', '반경', '프레임 간격 중앙값', 'p95', 'cpu 중앙값', 'gpu 중앙값', '드롭 비율', '실효 프레임 시간'];
    const rows = results.map((r) => [
      labelOf(r.variantId),
      `${r.width}×${r.height}`,
      filterLabel(r.filter),
      r.filter === 'blur' ? String(r.radius) : '-',
      f(r.interval.median),
      f(r.interval.p95),
      f(r.cpu.median, 3),
      r.gpu ? f(r.gpu.median, 3) : '-',
      f(r.droppedRatio, 3),
      f(r.effectiveFrameMs),
    ]);
    tableHost.replaceChildren(
      el(
        'table',
        {},
        el('thead', {}, el('tr', {}, ...header.map((h) => el('th', { textContent: h })))),
        el('tbody', {}, ...rows.map((cells) => el('tr', {}, ...cells.map((c) => el('td', { textContent: c }))))),
      ),
    );
    maxHost.replaceChildren(
      ...registry
        .filter((e) => maxRadii.has(e.id))
        .map((e) => {
          const r = maxRadii.get(e.id)!;
          const text = r === 0 ? `반경 1에서도 ${f(refreshHz, 0)} Hz 미달` : r >= MAX_RADIUS ? `반경 ${MAX_RADIUS} 이상 (탐색 상한)` : `반경 ${r}`;
          return el('li', { textContent: `${e.label}: ${f(refreshHz, 0)} Hz 유지 최대 블러 ${text}` });
        }),
    );
    const { width, height } = resolution();
    const blur = results.filter((r) => r.filter === 'blur' && r.width === width && r.height === height);
    const xs = [...new Set(blur.map((r) => r.radius))].sort((a, b) => a - b);
    plot.setData([
      xs,
      ...registry.map((e) =>
        xs.map((x) => {
          const hits = blur.filter((r) => r.variantId === e.id && r.radius === x);
          return hits.length ? hits[hits.length - 1]!.effectiveFrameMs : null;
        }),
      ),
    ]);
  };

  const stopPreview = async () => {
    await preview?.stop();
    preview = null;
    previewBtn.textContent = '미리보기 시작';
  };

  const guarded = (label: string, job: () => Promise<string | void>) => async () => {
    await stopPreview();
    busy = true;
    syncButtons();
    try {
      status.textContent = (await job()) ?? `${label} 완료`;
    } catch (err) {
      status.textContent = err instanceof CameraError ? err.message : `${label} 실패: ${String(err)}`;
    } finally {
      stage.replaceChildren();
      busy = false;
      syncButtons();
    }
  };

  const config = (radius = Number(radiusInput.value)): RunConfig => ({ ...resolution(), filter: filterSelect.value as FilterId, radius });
  const measure = async (entry: VariantEntry, cfg: RunConfig) => {
    const r = await runVariant(entry, cfg, await ensureSource(), caps, refreshHz, { host: stage });
    results.push(r);
    refreshOutputs();
    return r;
  };

  cameraBtn.addEventListener('click', guarded('카메라 시작', startCamera));

  runBtn.addEventListener(
    'click',
    guarded('고정 설정 실행', async () => {
      const cfg = config();
      for (const entry of variantsSelected()) {
        status.textContent = `${entry.label} 측정 중`;
        await measure(entry, cfg);
      }
    }),
  );

  sweepBtn.addEventListener(
    'click',
    guarded('반경 스윕', async () => {
      for (const entry of variantsSelected()) {
        for (const radius of SWEEP_RADII) {
          status.textContent = `${entry.label} 측정 중 (반경 ${radius})`;
          await measure(entry, { ...config(radius), filter: 'blur' });
        }
      }
    }),
  );

  maxBtn.addEventListener(
    'click',
    guarded('최대 반경 찾기', async () => {
      const source = await ensureSource();
      for (const entry of variantsSelected()) {
        const { width, height } = resolution();
        const max = await findMaxRadius(entry, { width, height }, source, caps, refreshHz, {
          host: stage,
          onTrial: (r) => {
            status.textContent = `${entry.label} 탐색 중 (반경 ${r.radius})`;
            results.push(r);
            refreshOutputs();
          },
        });
        maxRadii.set(entry.id, max);
        refreshOutputs();
      }
    }),
  );

  verifyBtn.addEventListener(
    'click',
    guarded('정합성 검증', async () => {
      const r = await verifyParity(caps);
      const parts = r.cases.map((c) => `${c.filter}${c.filter === 'blur' ? ` r=${c.radius}` : ''} 최대 ${c.maxAbsDiff} 평균 ${f(c.meanAbsDiff, 4)}`);
      return `정합성 검증 ${r.pass ? '통과' : '실패'} (${r.width}×${r.height}, 허용 최대 ${r.maxTolerance} 평균 ${r.meanTolerance}): ${parts.join(' / ')}`;
    }),
  );

  previewBtn.addEventListener('click', async () => {
    if (preview) {
      await stopPreview();
      syncButtons();
      return;
    }
    const entry = variantsSelected()[0];
    if (!entry) return;
    busy = true;
    syncButtons();
    try {
      const cfg = config();
      const target = await entry.create({ host: stage, source: await ensureSource(), width: cfg.width, height: cfg.height, params: cfg, caps });
      let raf = 0;
      const loop = () => {
        target.frame();
        raf = requestAnimationFrame(loop);
      };
      loop();
      preview = {
        async stop() {
          cancelAnimationFrame(raf);
          await target.settle?.();
          target.dispose();
          stage.replaceChildren();
        },
      };
      previewBtn.textContent = '미리보기 중지';
      status.textContent = `${entry.label} 미리보기 중`;
    } catch (err) {
      status.textContent = err instanceof CameraError ? err.message : `미리보기 실패: ${String(err)}`;
    } finally {
      busy = false;
      syncButtons();
    }
  });

  resSelect.addEventListener('change', refreshOutputs);

  const style = el('style', {
    textContent: '.wf-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr)); gap: 8px 16px; margin: 0.5rem 0; } .wf-grid label { display: flex; flex-direction: column; gap: 2px; } .wf-grid input[type=range] { width: 100%; }',
  });

  root.replaceChildren(
    style,
    el('h1', { textContent: 'WebGPU 웹캠 필터: 블러와 엣지 검출' }),
    el('p', { textContent: '같은 비디오 소스에 같은 필터를 CPU(Canvas2D getImageData + JS 루프)와 WebGPU 컴퓨트로 적용해 결과 이미지를 맞추고 비용을 비교합니다.' }),
    el('details', {}, el('summary', { textContent: '이 데모가 보여 주는 것' }), el('ul', {}, ...EXPLAINER.map((t) => el('li', { textContent: t })))),
    el('h2', { textContent: '환경' }),
    capsList,
    el('h2', { textContent: '변형' }),
    ...variantBoxes,
    el('h2', { textContent: '설정' }),
    el(
      'div',
      { className: 'wf-grid' },
      el('label', {}, '소스', kindSelect),
      el('label', {}, '처리 해상도', resSelect),
      el('label', {}, '필터', filterSelect),
      el('label', {}, el('span', {}, '블러 반경 ', radiusOut), radiusInput),
    ),
    el('div', { className: 'controls' }, cameraBtn, runBtn, sweepBtn, maxBtn, verifyBtn, previewBtn),
    status,
    stage,
    el('h2', { textContent: '결과' }),
    maxHost,
    tableHost,
    chartHost,
    el('h2', { textContent: '측정 한계' }),
    el('ul', {}, ...LIMITS_NOTES.map((t) => el('li', { textContent: t }))),
  );

  renderCaps();
  refreshOutputs();
  syncButtons();
  estimateRefresh().then((hz) => {
    refreshHz = hz;
    renderCaps();
  });
}
