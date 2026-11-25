import type { Capabilities } from '../../core/capabilities';
import { crossoverN, type AnyImpl, type AnyWorkload, type OneShotResult } from '../../core/oneshot';
import { button, callout, capsPanel, chapterLink, chart, checkList, controls, el, page, resultsTable, section, seriesVar, slider, status, type SeriesToken } from '../../ui';
import { implRunnable, sweep } from './sweep';

const CHAPTER = '03-compute-reduction';
const WORKLOAD_CHAPTERS: Record<string, { slug: string; label: string }> = {
  reduction: { slug: '03-compute-reduction', label: '03 리덕션' },
  gemm: { slug: '04-workgroup-memory', label: '04 행렬 곱(GEMM)' },
  binning2d: { slug: '05-atomics', label: '05 2D 빈닝' },
  'radix-sort': { slug: '06-multi-pass-sort', label: '06 기수 정렬' },
};

const LIMITS_NOTES = [
  'GPU e2e는 입력 업로드 + 커널 + 결과 읽기(mapAsync)를 모두 포함합니다. 작은 입력에서는 이 고정 비용이 계산 시간보다 커서 CPU가 이깁니다.',
  '커널만(점선) 시간은 timestamp-query로 잰 값입니다. e2e와의 차이가 업로드와 읽기 비용입니다. 데이터가 GPU에 계속 머무는 파이프라인이라면 이 비용은 나눠 갚게 됩니다.',
  'setup(파이프라인 컴파일, 버퍼 할당)은 e2e에 포함하지 않고 따로 표시합니다. 각 구현은 측정 전에 1회 워밍업합니다.',
  'CPU는 performance.now()의 해상도(약 0.1 ms)보다 짧게 끝나는 작은 N에서 여러 번을 묶어 평균낸 값을 1회로 칩니다. GPU 작은 N의 e2e도 이 해상도에 걸려 거칠게 나옵니다.',
  '각 (구현, N)은 최소 3회, 최대 10회(또는 합계 2초 초과 시 중단) 실행한 중앙값입니다. 검증(check)은 첫 실행과 마지막 실행의 출력에 적용합니다.',
  'Chrome은 WebGPU Developer Features 플래그가 꺼져 있으면 timestamp-query를 약 100 µs 단위로 양자화합니다.',
  '미리보기는 가장 작은 N 몇 개만 잰 것이라 GPU가 불리한 구간만 보입니다. 교차점은 전체 스윕에서 확인합니다.',
];

const CPU_TOKENS: SeriesToken[] = ['cpu-a', 'cpu-b'];
const GPU_TOKENS: SeriesToken[] = ['gpu-a', 'gpu-b', 'gpu-c'];

const f = (x: number, d = 3) => x.toFixed(d);
const fOpt = (s: { median: number } | null, d = 3) => (s ? f(s.median, d) : '-');

export interface ComputeBenchControl {
  /** Resolves once any running preview sweep has finished, and stops new ones from starting. */
  suspendPreview(): Promise<void>;
  resumePreview(): void;
}

export function mountComputeBench(root: HTMLElement, all: AnyWorkload[], device: GPUDevice | null, caps: Capabilities): ComputeBenchControl {
  let workload = all.find((w) => w.id === 'reduction') ?? all[0]!;
  let results: OneShotResult[] = [];
  let mode: 'preview' | 'full' = 'preview';
  let busy = false;
  let suspended = false;
  let generation = 0;
  let previewRun: Promise<void> = Promise.resolve();
  let picks = checkList([]);
  let sizeSlider = slider({ label: '', min: 1, max: 1, value: 1 });
  let plot = chart({ xLabel: '', yLabel: '', series: [] });

  const timestamps = caps.webgpu.kind === 'available' && caps.webgpu.timestampQuery;
  const select = el('select', { id: 'workload-select' }, ...all.map((w) => el('option', { value: w.id, textContent: w.label })));
  const selectField = el('label', { className: 'field' }, el('span', { className: 'field-label', textContent: '워크로드' }), select);
  const summary = el('p');
  const chapterLinks = el('p', { className: 'workload-chapters' });
  const pickHost = el('div');
  const sizeHost = el('span');
  const plotHost = el('div');
  const state = status();
  const crossText = el('p', { className: 'crossover' });
  const table = resultsTable([
    { label: '구현', numeric: false },
    { label: 'N' },
    { label: 'e2e 중앙값', unit: 'ms' },
    { label: 'compute', unit: 'ms' },
    { label: 'readback', unit: 'ms' },
    { label: 'kernel', unit: 'ms' },
    { label: 'setup', unit: 'ms' },
    { label: '처리량' },
    { label: '검증', numeric: false },
  ]);
  table.el.style.overflowX = 'auto';
  const tableFix = el('style', { textContent: '@media (max-width: 640px) { table.results tbody th { white-space: normal; max-width: 8.5rem; min-width: 6rem; } }' });
  const runBtn = button({ label: '전체 스윕 실행', variant: 'primary', onClick: () => void runFull() });
  runBtn.dataset.role = 'run-full';
  const previewBtn = button({ label: '빠른 미리보기 다시 실행', onClick: () => void runPreview() });
  previewBtn.dataset.role = 'run-preview';

  const selectedImpls = (): AnyImpl[] => workload.impls.filter((i) => picks.selected().has(i.id));
  const syncButtons = () => {
    const none = picks.selected().size === 0;
    runBtn.disabled = busy || none;
    previewBtn.disabled = busy || none || suspended;
    select.disabled = busy;
    sizeSlider.input.disabled = busy;
  };

  const tokenFor = (impl: AnyImpl): SeriesToken => {
    const same = workload.impls.filter((i) => i.kind === impl.kind);
    const tokens = impl.kind === 'cpu' ? CPU_TOKENS : GPU_TOKENS;
    return tokens[same.indexOf(impl) % tokens.length]!;
  };

  const buildPlot = () => {
    const series = workload.impls.map((i) => ({ label: i.label, color: tokenFor(i) }));
    const kernelSeries = timestamps ? workload.impls.filter((i) => i.kind === 'gpu').map((i) => ({ label: `${i.label} 커널만`, color: tokenFor(i), dashed: true })) : [];
    plot = chart({
      title: 'N 대비 e2e 중앙값',
      xLabel: '입력 크기 N (로그)',
      yLabel: '시간 중앙값 (ms, 로그)',
      logX: true,
      logY: true,
      series: [...series, ...kernelSeries],
      emptyText: '결과를 기다리는 중입니다. 작은 N 몇 개를 자동으로 재는 빠른 미리보기가 곧 이 자리에 그려집니다.',
    });
    plotHost.replaceChildren(plot.el);
  };

  const refreshOutputs = () => {
    const unit = workload.work?.(1).unit;
    table.setRows(
      results.map((r) => [
        workload.impls.find((i) => i.id === r.implId)?.label ?? r.implId,
        workload.sizeLabel(r.n),
        f(r.e2e.median),
        fOpt(r.compute),
        fOpt(r.readback),
        fOpt(r.kernel),
        r.setupMs === null ? '-' : f(r.setupMs, 1),
        r.throughput === null ? '-' : `${r.throughput.toPrecision(3)} ${unit}/s`,
        r.check.ok ? '통과' : `실패: ${r.check.detail}`,
      ]),
    );

    const kinds = new Set(results.map((r) => r.kind));
    if (kinds.size < 2) crossText.textContent = '교차점을 구하려면 CPU와 GPU 구현을 모두 측정해야 합니다.';
    else {
      const x = crossoverN(results);
      crossText.textContent = x === null ? '측정 범위에서 교차 없음' : `이 크기부터 GPU가 CPU보다 빠름: n ≈ ${workload.sizeLabel(x)}`;
    }

    const xs = [...new Set(results.map((r) => r.n))].sort((a, b) => a - b);
    const at = (id: string, n: number) => results.find((r) => r.implId === id && r.n === n);
    plot.setData(xs, [
      ...workload.impls.map((i) => xs.map((n) => at(i.id, n)?.e2e.median ?? null)),
      ...(timestamps ? workload.impls.filter((i) => i.kind === 'gpu').map((i) => xs.map((n) => at(i.id, n)?.kernel?.median ?? null)) : []),
    ]);
    const title = plot.el.querySelector('.chart-title');
    if (title) title.textContent = mode === 'preview' ? `빠른 미리보기: 작은 N ${workload.smokeSizes.length}개의 e2e 중앙값` : 'N 대비 e2e 중앙값 (전체 스윕)';
  };

  const loadWorkload = () => {
    generation++;
    workload = all.find((w) => w.id === select.value)!;
    summary.textContent = workload.summary;
    const link = WORKLOAD_CHAPTERS[workload.id];
    chapterLinks.replaceChildren(...(link ? ['이 워크로드의 원리: ', chapterLink(link.slug, link.label)] : []));
    picks = checkList(
      workload.impls.map((i) => ({
        id: i.id,
        label: i.label,
        swatch: seriesVar(tokenFor(i)),
        disabledReason: implRunnable(i, device) ? null : caps.webgpu.kind === 'unavailable' ? caps.webgpu.reason : 'GPUDevice를 만들 수 없습니다',
      })),
      syncButtons,
    );
    pickHost.replaceChildren(picks.el);
    sizeSlider = slider({
      label: '전체 스윕의 최대 입력 크기',
      min: 1,
      max: workload.sizes.length,
      value: workload.sizes.length,
      format: (v) => workload.sizeLabel(workload.sizes[v - 1]!),
    });
    sizeHost.replaceChildren(sizeSlider.el);
    results = [];
    mode = 'preview';
    buildPlot();
    refreshOutputs();
    syncButtons();
  };

  const execute = async (label: string, sizes: readonly number[], nextMode: 'preview' | 'full') => {
    const mine = ++generation;
    busy = true;
    mode = nextMode;
    results = [];
    refreshOutputs();
    syncButtons();
    state.set(`${label} 측정 중`);
    try {
      await sweep(workload, sizes, selectedImpls(), device, (r) => {
        if (mine !== generation) return;
        results.push(r);
        state.set(`${label}: ${workload.sizeLabel(r.n)} 측정 완료`);
        refreshOutputs();
      });
      if (mine !== generation) return;
      const failed = results.filter((r) => !r.check.ok).length;
      const done = nextMode === 'preview' ? '빠른 미리보기 완료. 작은 N만 잰 값이라 GPU가 불리하게 보입니다. 전체 스윕을 실행해 교차점을 찾아보세요.' : '전체 스윕 완료';
      state.set(failed > 0 ? `${label} 완료, 검증 실패 ${failed}건` : done, failed > 0 ? 'error' : 'ok');
    } catch (err) {
      state.set(`${label} 실패: ${String(err)}`, 'error');
    } finally {
      if (mine === generation) busy = false;
      syncButtons();
    }
  };

  const runPreview = (): Promise<void> => {
    if (suspended || document.hidden || busy || selectedImpls().length === 0) return previewRun;
    previewRun = execute('빠른 미리보기', workload.smokeSizes, 'preview');
    return previewRun;
  };

  const runFull = async () => {
    await previewRun;
    await execute('전체 스윕', workload.sizes.slice(0, sizeSlider.value()), 'full');
  };

  select.addEventListener('change', () => {
    loadWorkload();
    void runPreview();
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && results.length === 0) void runPreview();
  });

  root.replaceChildren(
    page(
      {
        title: '컴퓨트 벤치: CPU 대 GPU 교차점',
        lede: '같은 계산을 CPU와 WebGPU로 돌려, 입력이 얼마나 커져야 GPU가 이기기 시작하는지 찾습니다.',
        chapter: CHAPTER,
      },
      section(
        { title: '무엇을 비교하나' },
        el('p', { textContent: '구현마다 같은 입력에서 걸린 시간(e2e)을 잽니다. GPU의 e2e에는 업로드, 계산, 결과 읽기가 모두 들어 있습니다. 작은 입력에서는 이 고정 비용 때문에 CPU가 이기고, 입력이 커지면 순서가 뒤집힙니다.' }),
        plotHost,
        state.el,
      ),
      section(
        { title: '직접 측정하기' },
        controls(selectField, el('span', {}, sizeHost), runBtn, previewBtn),
        summary,
        chapterLinks,
        pickHost,
      ),
      section({ title: '결과' }, crossText, table.el, tableFix, capsPanel(caps).el),
      callout('측정 한계', [el('ul', {}, ...LIMITS_NOTES.map((t) => el('li', { textContent: t })))]),
      callout('해보기', '워크로드를 행렬 곱(GEMM)으로 바꾸고 전체 스윕을 실행해 보세요. N이 커질수록 GPU 선이 CPU 선 아래로 내려가는 지점이 교차점입니다. 점선(커널만)과 실선(e2e)의 간격이 업로드와 읽기 비용입니다.'),
    ),
  );
  select.value = workload.id;
  loadWorkload();
  void runPreview();

  return {
    async suspendPreview() {
      suspended = true;
      syncButtons();
      await previewRun;
    },
    resumePreview() {
      suspended = false;
      syncButtons();
      if (results.length === 0) void runPreview();
    },
  };
}
