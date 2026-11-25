import { unmetReason, type Capabilities } from '../../core/capabilities';
import { estimateRefresh } from '../../core/frame-bench';
import { button, callout, capsPanel, chart, checkList, controls, el, figure, livePreview, page, resultsTable, section, segmented, seriesVar, slider, status, type SeriesToken } from '../../ui';
import { FILTERS, MAX_RADIUS, RESOLUTIONS, type FilterId } from './filters';
import { findMaxRadius, runVariant, type RunConfig, type RunResult } from './run';
import { CameraError, openSource, type SourceKind, type VideoSource } from './source';
import { registry, type VariantEntry, type VariantId } from './variants';
import { verifyParity } from './verify';

const CHAPTER = '08-textures-video';
const SWEEP_RADII = [1, 2, 4, 8, 16, 32];
const PREVIEW_ORDER: VariantId[] = ['gpu-compute', 'cpu-canvas'];
const SERIES: Record<VariantId, SeriesToken> = { 'cpu-canvas': 'cpu-a', 'gpu-compute': 'gpu-a' };

const LIMITS_NOTES = [
  '헤드리스 Chromium 수치는 스모크 값이며, 다른 GPU 작업과 겹치면 흔들립니다. 성능 주장으로 쓰지 마세요.',
  'rAF는 주사율에서 멈추므로 프레임 간격 중앙값만으로는 부하를 구분할 수 없습니다. 실효 프레임 시간(큐를 비운 뒤 측정)이 판정 기준입니다.',
  'CPU 변형의 cpu 값은 drawImage + getImageData + 필터 + putImageData 전체입니다. WebGPU 변형의 cpu 값은 인코딩 + 제출만이고, GPU 시간은 gpu 열에 따로 나옵니다.',
  '미리보기는 합성 영상을 WebGPU 필터에 통과시킨 것이며 측정값이 아닙니다. 측정이 시작되면 멈춥니다.',
  '합성 영상은 canvas.captureStream()으로 만든 비디오라 카메라와 같은 경로(video 요소)를 지나지만 압축 지연이 없고 내용이 결정적입니다.',
];

const f = (x: number, d = 2) => x.toFixed(d);

export function mountWebcamFilter(root: HTMLElement, caps: Capabilities): { suspendPreview(): void; resumePreview(): void } {
  const selected = new Set<string>();
  const results: RunResult[] = [];
  const maxRadii = new Map<string, number>();
  let refreshHz = 60;
  let busy = false;
  let source: VideoSource | null = null;
  let sourceSize = '';

  const fig = figure({ caption: '미리보기를 준비하는 중입니다.', width: 800 });
  const stage = fig.stage;

  const previewEntry = PREVIEW_ORDER.map((id) => registry.find((e) => e.id === id)).find((e) => e && unmetReason(e.requires, caps) === null);

  const picks = checkList(
    registry.map((entry) => ({ id: entry.id, label: entry.label, hint: entry.summary, disabledReason: unmetReason(entry.requires, caps), swatch: seriesVar(SERIES[entry.id]) })),
    (s) => {
      selected.clear();
      s.forEach((id) => selected.add(id));
      syncButtons();
    },
  );
  picks.selected().forEach((id) => selected.add(id));

  const sourceSeg = segmented<SourceKind>({
    label: '소스',
    options: [
      { value: 'synthetic', label: '합성 영상' },
      { value: 'camera', label: '웹캠' },
    ],
    value: 'synthetic',
    onChange: () => {
      closeSource();
      syncButtons();
      restartPreview();
    },
  });
  const resSeg = segmented<string>({
    label: '처리 해상도',
    options: RESOLUTIONS.map((r, i) => ({ value: String(i), label: `${r.width}×${r.height}` })),
    value: '0',
    onChange: () => {
      refreshOutputs();
      restartPreview();
    },
  });
  const filterSeg = segmented<FilterId>({
    label: '필터',
    options: FILTERS.map((x) => ({ value: x.id, label: x.label.split(' ')[0]! })),
    value: 'blur',
    onChange: restartPreview,
  });
  const radiusSlider = slider({ label: '블러 반경', min: 1, max: MAX_RADIUS, value: 4 });
  radiusSlider.input.addEventListener('change', restartPreview);

  const cameraBtn = button({ label: '카메라 켜기', onClick: () => void cameraJob() });
  const runBtn = button({ label: '고정 설정 실행', variant: 'primary', onClick: () => void runJob() });
  const sweepBtn = button({ label: '반경 스윕 (블러)', onClick: () => void sweepJob() });
  const maxBtn = button({ label: '최대 반경 찾기 (블러)', onClick: () => void maxJob() });
  const verifyBtn = button({ label: '정합성 검증', onClick: () => void verifyJob() });
  const state = status();
  const maxList = el('ul', { className: 'max-list' });
  const verifyList = el('ul', { className: 'max-list' });
  const table = resultsTable([
    { label: '변형', numeric: false },
    { label: '해상도' },
    { label: '필터' },
    { label: '반경' },
    { label: '프레임 간격 중앙값', unit: 'ms' },
    { label: 'cpu 중앙값', unit: 'ms' },
    { label: 'gpu 중앙값', unit: 'ms' },
    { label: '드롭 비율' },
    { label: '실효 프레임 시간', unit: 'ms' },
  ]);
  table.el.style.overflowX = 'auto';
  const tableFix = el('style', { textContent: '@media (max-width: 640px) { table.results tbody th { white-space: normal; max-width: 8.5rem; min-width: 6rem; } }' });
  const plot = chart({
    title: '블러 반경 대비 실효 프레임 시간',
    xLabel: '블러 반경',
    yLabel: '실효 프레임 시간 (ms)',
    series: registry.map((e) => ({ label: e.label, color: SERIES[e.id] })),
    emptyText: '아직 측정 결과가 없습니다. 반경 스윕을 실행하면 반경별 비용 곡선이 이 자리에 그려집니다.',
  });
  const env = capsPanel(caps, [['주사율(추정)', `${f(refreshHz, 1)} Hz`]]);

  const resolution = () => RESOLUTIONS[Number(resSeg.get())]!;
  const kind = () => sourceSeg.get();
  const variantsSelected = (): VariantEntry[] => registry.filter((e) => selected.has(e.id));
  const syncButtons = () => {
    const noVariant = selected.size === 0;
    runBtn.disabled = sweepBtn.disabled = maxBtn.disabled = busy || noVariant;
    verifyBtn.disabled = busy || caps.webgpu.kind !== 'available';
    cameraBtn.disabled = busy;
    cameraBtn.hidden = kind() !== 'camera';
  };

  const closeSource = () => {
    source?.stop();
    source = null;
    sourceSize = '';
  };

  const ensureSource = async (): Promise<VideoSource> => {
    if (kind() === 'camera') {
      if (!source) throw new CameraError('먼저 "카메라 켜기"를 눌러 카메라를 켜세요.');
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

  const config = (radius = radiusSlider.value()): RunConfig => ({ ...resolution(), filter: filterSeg.get(), radius });

  const preview = livePreview(
    async () => {
      if (kind() === 'camera' && !source) {
        fig.setCaption('"카메라 켜기"를 누르면 웹캠 영상이 같은 필터를 거쳐 여기에 나옵니다. 카메라는 누르기 전까지 켜지지 않습니다.');
        throw new CameraError('camera not started');
      }
      const cfg = config();
      const entry = previewEntry!;
      const target = await entry.create({ host: stage, source: await ensureSource(), width: cfg.width, height: cfg.height, params: cfg, caps });
      const what = kind() === 'camera' ? '웹캠 영상' : '합성 영상';
      fig.setCaption(`${what}을 ${entry.label}로 처리하는 중입니다 (${cfg.width}×${cfg.height}, ${FILTERS.find((x) => x.id === cfg.filter)!.label}). 측정을 시작하면 미리보기는 멈춥니다.`);
      return target;
    },
    (err) => {
      if (!(err instanceof CameraError && err.message === 'camera not started')) fig.setCaption(err instanceof CameraError ? err.message : `미리보기를 시작하지 못했습니다: ${String(err)}`);
    },
  );
  function restartPreview() {
    preview.suspend();
    if (!busy) preview.resume();
  }

  const labelOf = (id: string) => registry.find((e) => e.id === id)?.label ?? id;
  const filterLabel = (id: FilterId) => FILTERS.find((x) => x.id === id)?.label.split(' ')[0] ?? id;

  function refreshOutputs() {
    table.setRows(
      results.map((r) => [
        labelOf(r.variantId),
        `${r.width}×${r.height}`,
        filterLabel(r.filter),
        r.filter === 'blur' ? String(r.radius) : '-',
        f(r.interval.median),
        f(r.cpu.median, 3),
        r.gpu ? f(r.gpu.median, 3) : '-',
        f(r.droppedRatio, 3),
        f(r.effectiveFrameMs),
      ]),
    );
    maxList.replaceChildren(
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
    plot.setData(
      xs,
      registry.map((e) => xs.map((x) => blur.findLast((r) => r.variantId === e.id && r.radius === x)?.effectiveFrameMs ?? null)),
    );
  }

  const guarded = async (label: string, job: () => Promise<string | void>) => {
    busy = true;
    preview.suspend();
    stage.replaceChildren();
    fig.setCaption('측정 중에는 미리보기를 멈춥니다. 같은 영역에 측정 대상 영상이 그려집니다.');
    syncButtons();
    try {
      state.set((await job()) ?? `${label} 완료`, 'ok');
    } catch (err) {
      state.set(err instanceof CameraError ? err.message : `${label} 실패: ${String(err)}`, 'error');
    } finally {
      stage.replaceChildren();
      busy = false;
      syncButtons();
      preview.resume();
    }
  };

  const measure = async (entry: VariantEntry, cfg: RunConfig) => {
    const r = await runVariant(entry, cfg, await ensureSource(), caps, refreshHz, { host: stage });
    results.push(r);
    refreshOutputs();
    return r;
  };

  const cameraJob = () =>
    guarded('카메라 켜기', async () => {
      const { width, height } = resolution();
      closeSource();
      source = await openSource('camera', width, height);
      sourceSize = 'camera';
      return `카메라 시작됨 (${source.video.videoWidth}×${source.video.videoHeight})`;
    });

  const runJob = () =>
    guarded('고정 설정 실행', async () => {
      const cfg = config();
      for (const entry of variantsSelected()) {
        state.set(`${entry.label} 측정 중`);
        await measure(entry, cfg);
      }
    });

  const sweepJob = () =>
    guarded('반경 스윕', async () => {
      for (const entry of variantsSelected()) {
        for (const radius of SWEEP_RADII) {
          state.set(`${entry.label} 측정 중 (반경 ${radius})`);
          await measure(entry, { ...config(radius), filter: 'blur' });
        }
      }
    });

  const maxJob = () =>
    guarded('최대 반경 찾기', async () => {
      const src = await ensureSource();
      for (const entry of variantsSelected()) {
        const { width, height } = resolution();
        const max = await findMaxRadius(entry, { width, height }, src, caps, refreshHz, {
          host: stage,
          onTrial: (r) => {
            state.set(`${entry.label} 탐색 중 (반경 ${r.radius})`);
            results.push(r);
            refreshOutputs();
          },
        });
        maxRadii.set(entry.id, max);
        refreshOutputs();
      }
    });

  const verifyJob = () =>
    guarded('정합성 검증', async () => {
      const r = await verifyParity(caps);
      verifyList.replaceChildren(
        ...r.cases.map((c) => el('li', { textContent: `${c.filter}${c.filter === 'blur' ? ` r=${c.radius}` : ''}: 최대 ${c.maxAbsDiff}, 평균 ${f(c.meanAbsDiff, 4)}` })),
      );
      return `정합성 검증 ${r.pass ? '통과' : '실패'} (${r.width}×${r.height}, 허용 최대 ${r.maxTolerance}, 평균 ${r.meanTolerance})`;
    });

  root.replaceChildren(
    page(
      {
        title: '카메라 영상에 필터를 거는 가장 빠른 길',
        lede: '같은 영상에 같은 필터를 CPU(Canvas2D와 JS 루프)와 WebGPU 컴퓨트로 걸어, 결과 이미지를 맞춘 뒤 비용을 비교합니다.',
        chapter: CHAPTER,
      },
      fig.el,
      section(
        { title: '무엇을 비교하나' },
        el('p', { textContent: '화면의 영상은 합성 영상이 WebGPU 필터를 통과한 것입니다. 아래에서 필터와 반경을 바꾸면 미리보기가 바로 따라 바뀝니다. 웹캠은 "웹캠"을 고르고 "카메라 켜기"를 누를 때만 켜집니다.' }),
        picks.el,
        callout('핵심', 'importExternalTexture는 비디오 프레임을 복사 없이 GPU에 바인딩합니다. 대신 한 프레임 동안만 유효해서 프레임마다 새로 만듭니다. CPU 경로는 getImageData로 프레임을 CPU 메모리로 읽어 오는 동기 readback이 병목입니다.'),
      ),
      section(
        { title: '직접 측정하기' },
        controls(sourceSeg.el, resSeg.el, filterSeg.el, radiusSlider.el, cameraBtn),
        controls(runBtn, sweepBtn, maxBtn, verifyBtn),
        state.el,
      ),
      section({ title: '결과' }, maxList, table.el, tableFix, plot.el, verifyList, env.el),
      callout('측정 한계', [el('ul', {}, ...LIMITS_NOTES.map((t) => el('li', { textContent: t })))]),
      callout('해보기', '필터를 블러로 두고 반경 스윕을 실행해 보세요. 반경이 커질수록 CPU의 실효 프레임 시간은 가파르게 오르는데 GPU는 얼마나 평평한지 확인합니다. 웹캠이 있다면 같은 설정을 카메라로 반복해 보세요.'),
    ),
  );

  syncButtons();
  void estimateRefresh().then((hz) => {
    refreshHz = hz;
    env.update([['주사율(추정)', `${f(hz, 1)} Hz`]]);
  });
  if (previewEntry) void preview.start();
  else fig.setCaption('이 환경에서는 미리보기를 그릴 수 있는 변형이 없습니다.');
  return { suspendPreview: preview.suspend, resumePreview: preview.resume };
}
