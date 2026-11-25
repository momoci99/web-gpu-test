import { unmetReason, type Capabilities } from '../../core/capabilities';
import { estimateRefresh, rampMaxN, trialPasses } from '../../core/frame-bench';
import { button, callout, capsPanel, chapterLink, chart, checkList, controls, el, figure, livePreview, numberField, page, resultsTable, section, seriesVar, status, type SeriesToken } from '../../ui';
import { registry } from './renderers/registry';
import type { RendererEntry, RendererId } from './renderers/types';
import { runFixed, type RunResult } from './run';
import { createScene, type SceneConfig } from './scene';
import { verifyComputeParity } from './verify';

const SCENE_SIZE = { width: 800, height: 600 };
const PREVIEW_COUNT = 1200;
const PREVIEW_ORDER: RendererId[] = ['webgpu-compute', 'webgpu-cpu', 'webgl2', 'canvas2d', 'svg'];
const CHAPTER = '02-render-pipeline';

const SERIES: Record<RendererId, SeriesToken> = {
  svg: 'cpu-a',
  canvas2d: 'cpu-b',
  webgl2: 'gpu-a',
  'webgpu-cpu': 'gpu-b',
  'webgpu-compute': 'gpu-c',
};

const LIMITS_NOTES = [
  'rAF는 화면 주사율에서 멈추므로 헤드라인 지표는 fps가 아니라 "주사율에서 유지되는 최대 N"입니다.',
  'SVG 비용은 대부분 JS 밖(스타일, 레이아웃, 페인트)에서 발생하므로 cpuMs는 과소 측정됩니다. 프레임 간격과 LoAF가 이를 반영합니다.',
  'WebGPU의 cpuMs는 인코딩과 제출 시간만 뜻합니다. GPU 작업은 gpuMs에 나타나고, GPU가 병목이면 프레임 간격에도 나타납니다.',
  'WebGPU 제출은 rAF가 늦춰 주지 않아 작업이 큐에 쌓일 수 있습니다. 그래서 측정 구간 끝에서 큐를 비운 뒤(settle) 실효 프레임 시간으로 통과 여부를 판정합니다.',
  'Chrome은 WebGPU Developer Features 플래그가 꺼져 있으면 timestamp-query를 약 100 µs 단위로 양자화합니다.',
];

const f = (x: number, d = 2) => x.toFixed(d);

export function mountRenderCompare(root: HTMLElement, caps: Capabilities): { suspendPreview(): void; resumePreview(): void } {
  const selected = new Set<string>();
  const results: RunResult[] = [];
  const maxNs = new Map<string, number>();
  let refreshHz = 60;
  let busy = false;

  const fig = figure({ caption: '미리보기를 준비하는 중입니다.', width: SCENE_SIZE.width, height: SCENE_SIZE.height });
  const stage = fig.stage;

  const previewEntry = PREVIEW_ORDER.map((id) => registry.find((e) => e.id === id)).find((e) => e && unmetReason(e.requires, caps) === null);
  const preview = livePreview(
    async () => {
      const width = Math.min(SCENE_SIZE.width, Math.max(280, Math.round(stage.clientWidth)));
      const config: SceneConfig = { seed: 1, count: PREVIEW_COUNT, width, height: Math.round((width * SCENE_SIZE.height) / SCENE_SIZE.width) };
      fig.setCaption(`${previewEntry!.label}로 원 ${PREVIEW_COUNT.toLocaleString('ko-KR')}개를 그리는 중입니다. 측정을 시작하면 미리보기는 멈춥니다.`);
      return previewEntry!.create(stage, createScene(config), caps);
    },
    (err) => fig.setCaption(`미리보기를 시작하지 못했습니다: ${String(err)}`),
  );

  const picks = checkList(
    registry.map((entry) => ({ id: entry.id, label: entry.label, hint: entry.summary, disabledReason: unmetReason(entry.requires, caps), swatch: seriesVar(SERIES[entry.id]) })),
    (s) => {
      selected.clear();
      s.forEach((id) => selected.add(id));
      syncButtons();
    },
  );
  picks.selected().forEach((id) => selected.add(id));

  const countField = numberField({ label: '원 개수 N', value: 5000, min: 1, step: 1000 });
  const runBtn = button({ label: '고정 N 실행', variant: 'primary', onClick: () => void runFixedJob() });
  const rampBtn = button({ label: '최대 N 찾기', onClick: () => void rampJob() });
  const verifyBtn = button({ label: '컴퓨트 검증', onClick: () => void verifyJob() });
  const state = status();

  const table = resultsTable([
    { label: '렌더러', numeric: false },
    { label: 'N' },
    { label: '프레임 간격 중앙값', unit: 'ms' },
    { label: 'p95', unit: 'ms' },
    { label: 'cpu 중앙값', unit: 'ms' },
    { label: 'gpu 중앙값', unit: 'ms' },
    { label: '드롭 비율' },
    { label: '실효 프레임 시간', unit: 'ms' },
    { label: 'LoAF', unit: '횟수 / 차단 ms' },
  ]);
  const maxList = el('ul', { className: 'max-list' });
  const plot = chart({
    title: 'N에 따른 프레임 간격 중앙값',
    xLabel: '원 개수 N (로그)',
    yLabel: '프레임 간격 (ms)',
    logX: true,
    series: registry.map((e) => ({ label: e.label, color: SERIES[e.id] })),
  });
  const env = capsPanel(caps, [['주사율(추정)', `${f(refreshHz, 1)} Hz`]]);

  const entriesSelected = (): RendererEntry[] => registry.filter((e) => selected.has(e.id));
  const syncButtons = () => {
    runBtn.disabled = rampBtn.disabled = busy || selected.size === 0;
    verifyBtn.disabled = busy || caps.webgpu.kind !== 'available';
  };

  const refreshOutputs = () => {
    table.setRows(
      results.map((r) => [
        registry.find((e) => e.id === r.rendererId)?.label ?? r.rendererId,
        r.count.toLocaleString('en-US'),
        f(r.interval.median),
        f(r.interval.p95),
        f(r.cpu.median, 3),
        r.gpu ? f(r.gpu.median, 3) : '-',
        f(r.droppedRatio, 3),
        f(r.effectiveFrameMs),
        r.longFrames ? `${r.longFrames.count} / ${f(r.longFrames.totalBlockingMs, 1)}` : '-',
      ]),
    );
    maxList.replaceChildren(
      ...registry.filter((e) => maxNs.has(e.id)).map((e) => el('li', {}, `${e.label}: ${f(refreshHz, 0)} Hz 유지 최대 N ≈ `, el('strong', { textContent: maxNs.get(e.id)!.toLocaleString('en-US') }))),
    );
    const xs = [...new Set(results.map((r) => r.count))].sort((a, b) => a - b);
    plot.setData(
      xs,
      registry.map((e) => xs.map((x) => results.findLast((r) => r.rendererId === e.id && r.count === x)?.interval.median ?? null)),
    );
  };

  const guarded = async (label: string, job: () => Promise<string | void>) => {
    busy = true;
    preview.suspend();
    stage.replaceChildren();
    fig.setCaption('측정 중에는 미리보기를 멈춥니다. 같은 영역에 측정 대상 장면이 그려집니다.');
    syncButtons();
    try {
      state.set((await job()) ?? `${label} 완료`, 'ok');
    } catch (err) {
      state.set(`${label} 실패: ${String(err)}`, 'error');
    } finally {
      stage.replaceChildren();
      busy = false;
      syncButtons();
      preview.resume();
    }
  };

  const measure = (entry: RendererEntry, count: number) => runFixed(entry, { seed: 1, count, ...SCENE_SIZE }, caps, refreshHz, { host: stage });

  const runFixedJob = () =>
    guarded('고정 N 실행', async () => {
      const count = countField.read();
      for (const entry of entriesSelected()) {
        state.set(`${entry.label} 측정 중 (N=${count})`);
        results.push(await measure(entry, count));
        refreshOutputs();
      }
    });

  const rampJob = () =>
    guarded('최대 N 찾기', async () => {
      for (const entry of entriesSelected()) {
        const { maxN } = await rampMaxN(async (n) => {
          state.set(`${entry.label} 탐색 중 (N=${n})`);
          const r = await measure(entry, n);
          results.push(r);
          refreshOutputs();
          return trialPasses(r);
        });
        maxNs.set(entry.id, maxN);
        refreshOutputs();
      }
    });

  const verifyJob = () =>
    guarded('컴퓨트 검증', async () => {
      const r = await verifyComputeParity(caps);
      return `컴퓨트 검증 ${r.pass ? '통과' : '실패'}: 최대 절대 오차 ${r.maxAbsError.toExponential(2)} (원 ${r.count}개, ${r.steps}스텝)`;
    });

  root.replaceChildren(
    page(
      {
        title: '튀는 원, 누가 주사율을 지킬까',
        lede: '같은 장면을 SVG, Canvas2D, WebGL2, WebGPU로 그려, 화면 주사율을 유지하는 최대 원 개수를 비교합니다.',
        chapter: CHAPTER,
      },
      fig.el,
      section(
        { title: '무엇을 비교하나' },
        el('p', { textContent: '장면은 모두 같습니다. 같은 시드, 같은 고정 시간 간격(1/60초), 같은 색과 알파 블렌딩으로 원이 벽에 튕깁니다. 다른 것은 "누가 위치를 계산하고 누가 그리느냐"입니다.' }),
        picks.el,
      ),
      section(
        { title: '직접 측정하기' },
        el('p', { textContent: 'N을 정하고 고정 N 실행을 누르면 선택한 방식이 차례로 측정됩니다. 최대 N 찾기는 각 방식이 주사율을 유지하는 한계를 이분 탐색으로 찾습니다.' }),
        controls(countField.el, runBtn, rampBtn, verifyBtn),
        state.el,
      ),
      section({ title: '결과' }, maxList, table.el, plot.el, env.el),
      callout('측정 한계', [el('ul', {}, ...LIMITS_NOTES.map((t) => el('li', { textContent: t })))]),
      callout('해보기', 'N을 20000으로 올려 SVG와 WebGPU(컴퓨트)를 함께 실행해 보세요. 두 방식의 프레임 간격이 어느 N에서 갈라지는지, 그 차이가 cpu 중앙값에도 나타나는지 확인합니다.'),
      el('p', {}, chapterLink(CHAPTER)),
    ),
  );

  syncButtons();
  void estimateRefresh().then((hz) => {
    refreshHz = hz;
    env.update([['주사율(추정)', `${f(hz, 1)} Hz`]]);
  });
  if (previewEntry) void preview.start();
  else fig.setCaption('이 환경에서는 미리보기를 그릴 수 있는 렌더러가 없습니다.');
  return { suspendPreview: preview.suspend, resumePreview: preview.resume };
}
