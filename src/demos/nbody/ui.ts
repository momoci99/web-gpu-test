import { unmetReason, type Capabilities } from '../../core/capabilities';
import { estimateRefresh, rampMaxN, trialPasses } from '../../core/frame-bench';
import { button, callout, capsPanel, chart, checkList, controls, el, figure, livePreview, numberField, page, resultsTable, section, seriesVar, status, type SeriesToken } from '../../ui';
import { runFixed, type RunConfig, type RunResult } from './run';
import { createBodies, throughput } from './sim';
import { registry, type VariantEntry, type VariantId } from './variants';
import { VERIFY_COUNT, VERIFY_STEPS, VERIFY_TOLERANCE, verifyNBody } from './verify';

const CHAPTER = '07-compute-to-render';
const RAMP_MAX = 262_144;
const RAMP_FRAMES = { warmupFrames: 15, measureFrames: 60 };
const PREVIEW_ORDER: VariantId[] = ['gpu-tiled', 'gpu-naive', 'cpu-js'];
const PREVIEW_COUNT: Record<VariantId, number> = { 'gpu-tiled': 4096, 'gpu-naive': 4096, 'cpu-js': 1024 };

const SERIES: Record<VariantId, SeriesToken> = { 'cpu-js': 'cpu-a', 'gpu-naive': 'gpu-a', 'gpu-tiled': 'gpu-b' };

const LIMITS_NOTES = [
  '정확도 검증의 허용 오차는 측정된 오차(약 3e-5 px)의 30배 여유이고 타일 하나를 빼먹는 버그(약 0.3 px)보다 훨씬 작습니다. 중력은 가까운 만남에서 반올림 차이를 증폭하므로 스텝이 길어질수록 차이가 벌어지는 것이 정상이고, 물체 하나를 빼먹는 정도의 미세한 버그는 잡지 못합니다.',
  '"스텝/초"와 "쌍/초"는 실효 프레임 시간(큐를 비운 뒤 측정)에서 계산합니다. 변형이 주사율을 따라가는 동안에는 rAF가 프레임을 주사율로 묶으므로 이 값은 실제 처리량이 아니라 하한입니다. 처리량을 보려면 "스텝/프레임"을 올리거나 N을 키우세요.',
  '"주사율에서 유지되는 최대 N"은 중앙값 간격, 드롭 비율, 실효 프레임 시간이 모두 기준 안일 때 통과로 보고 배가 후 이분 탐색으로 찾습니다. 일이 N²이므로 N을 2배로 하면 일이 4배입니다.',
  'gpu 시간 열은 컴퓨트 패스 시작부터 렌더 패스 끝까지입니다. timestamp-query가 없거나 양자화되면 "-"입니다.',
  'CPU 변형도 그리기는 같은 WebGPU 포인트 렌더러를 쓰고 매 프레임 상태를 업로드합니다. 비교 대상은 시뮬레이션 계산뿐입니다.',
  '다른 GPU 작업이 동시에 돌면 모든 수치가 흔들립니다. 헤드리스 스모크 수치는 성능 주장이 아닙니다.',
];

const f = (x: number, d = 2) => x.toFixed(d);
const si = (x: number) => (x >= 1e9 ? `${f(x / 1e9)}G` : x >= 1e6 ? `${f(x / 1e6)}M` : x >= 1e3 ? `${f(x / 1e3)}k` : f(x, 0));

export function mountNBody(root: HTMLElement, caps: Capabilities): { suspendPreview(): void; resumePreview(): void } {
  const selected = new Set<string>();
  const results: RunResult[] = [];
  const maxNs = new Map<string, number>();
  let refreshHz = 60;
  let busy = false;

  const fig = figure({ caption: '미리보기를 준비하는 중입니다.', width: 720, height: 720 });
  const stage = fig.stage;

  const previewEntry = PREVIEW_ORDER.map((id) => registry.find((e) => e.id === id)).find((e) => e && unmetReason(e.requires, caps) === null);
  const preview = livePreview(
    async () => {
      const count = PREVIEW_COUNT[previewEntry!.id];
      fig.setCaption(`${previewEntry!.label}로 물체 ${count.toLocaleString('ko-KR')}개의 중력 시뮬레이션을 돌리는 중입니다. 측정을 시작하면 미리보기는 멈춥니다.`);
      return previewEntry!.create({ host: stage, caps, bodies: createBodies({ seed: 1, count }), stepsPerFrame: 1 });
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

  const countField = numberField({ label: '물체 개수 N', value: 4096, min: 2, step: 1024 });
  const stepsField = numberField({ label: '스텝/프레임', value: 1, min: 1, step: 1 });
  const runBtn = button({ label: '고정 N 실행', variant: 'primary', onClick: () => void runFixedJob() });
  const rampBtn = button({ label: '최대 N 찾기', onClick: () => void rampJob() });
  const verifyBtn = button({ label: '정확도 검증', onClick: () => void verifyJob() });
  const state = status();
  const table = resultsTable([
    { label: '변형', numeric: false },
    { label: 'N' },
    { label: '스텝/프레임' },
    { label: '실효 프레임', unit: 'ms' },
    { label: '스텝/초' },
    { label: '쌍/초' },
    { label: '간격 중앙값', unit: 'ms' },
    { label: 'p95', unit: 'ms' },
    { label: 'cpu 중앙값', unit: 'ms' },
    { label: 'gpu 중앙값', unit: 'ms' },
    { label: '드롭 비율' },
  ]);
  table.el.style.overflowX = 'auto';
  const tableFix = el('style', { textContent: '@media (max-width: 640px) { table.results tbody th { white-space: normal; max-width: 8.5rem; min-width: 6rem; } }' });
  const maxList = el('ul', { className: 'max-list' });
  const verifyList = el('ul', { className: 'max-list' });
  const plot = chart({
    title: 'N 대비 실효 프레임 시간',
    xLabel: '물체 개수 N (로그)',
    yLabel: '실효 프레임 시간 (ms, 로그)',
    logX: true,
    logY: true,
    series: registry.map((e) => ({ label: e.label, color: SERIES[e.id] })),
  });
  const env = capsPanel(caps, [['주사율(추정)', `${f(refreshHz, 1)} Hz`]]);

  const entriesSelected = (): VariantEntry[] => registry.filter((e) => selected.has(e.id));
  const syncButtons = () => {
    runBtn.disabled = rampBtn.disabled = busy || selected.size === 0;
    verifyBtn.disabled = busy || caps.webgpu.kind !== 'available';
  };
  const configFor = (count: number): RunConfig => ({ seed: 1, count, stepsPerFrame: Math.max(1, Math.floor(Number(stepsField.input.value)) || 1) });

  const refreshOutputs = () => {
    table.setRows(
      results.map((r) => {
        const t = throughput(r.count, r.stepsPerFrame, r.effectiveFrameMs);
        return [
          registry.find((e) => e.id === r.variantId)?.label ?? r.variantId,
          r.count.toLocaleString('en-US'),
          String(r.stepsPerFrame),
          f(r.effectiveFrameMs),
          f(t.stepsPerSec, 1),
          si(t.pairsPerSec),
          f(r.interval.median),
          f(r.interval.p95),
          f(r.cpu.median, 3),
          r.gpu ? f(r.gpu.median, 3) : '-',
          f(r.droppedRatio, 3),
        ];
      }),
    );
    maxList.replaceChildren(
      ...registry.filter((e) => maxNs.has(e.id)).map((e) => el('li', {}, `${e.label}: ${f(refreshHz, 0)} Hz 유지 최대 N ≈ `, el('strong', { textContent: maxNs.get(e.id)!.toLocaleString('en-US') }))),
    );
    const xs = [...new Set(results.map((r) => r.count))].sort((a, b) => a - b);
    plot.setData(
      xs,
      registry.map((e) => xs.map((x) => results.findLast((r) => r.variantId === e.id && r.count === x)?.effectiveFrameMs ?? null)),
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

  const runFixedJob = () =>
    guarded('고정 N 실행', async () => {
      const count = Math.max(2, countField.read());
      for (const entry of entriesSelected()) {
        state.set(`${entry.label} 측정 중 (N=${count})`);
        results.push(await runFixed(entry, configFor(count), caps, refreshHz, { host: stage }));
        refreshOutputs();
      }
    });

  const rampJob = () =>
    guarded('최대 N 찾기', async () => {
      for (const entry of entriesSelected()) {
        const { maxN } = await rampMaxN(
          async (n) => {
            state.set(`${entry.label} 탐색 중 (N=${n})`);
            const r = await runFixed(entry, configFor(n), caps, refreshHz, { host: stage, ...RAMP_FRAMES });
            results.push(r);
            refreshOutputs();
            return trialPasses(r);
          },
          { max: RAMP_MAX },
        );
        maxNs.set(entry.id, maxN);
        refreshOutputs();
      }
    });

  const verifyJob = () =>
    guarded('정확도 검증', async () => {
      const rs = await verifyNBody(caps);
      verifyList.replaceChildren(...rs.map((r) => el('li', { textContent: `${r.id}: ${r.pass ? '통과' : '실패'}, 최대 절대 위치 오차 ${r.maxAbsError.toExponential(2)} (허용 ${r.tolerance}), N=${r.count}, ${r.steps}스텝` })));
      return `정확도 검증 ${rs.every((r) => r.pass) ? '통과' : '실패'}`;
    });

  root.replaceChildren(
    page(
      {
        title: '서로 끌어당기는 별들, 누가 더 많이 돌릴까',
        lede: '모든 물체 쌍의 중력을 매 프레임 계산하는 N체 시뮬레이션을 CPU와 WebGPU로 돌려, 주사율을 지키는 최대 물체 수를 비교합니다.',
        chapter: CHAPTER,
      },
      fig.el,
      section(
        { title: '무엇을 비교하나' },
        el('p', { textContent: '원반 모양으로 도는 N개의 물체가 서로 모두에게 중력을 받습니다. 쌍을 전부 계산하므로 한 스텝의 일은 N²에 비례합니다. 같은 시드와 같은 고정 시간 간격(1/60초)에서 "계산을 누가 하느냐"만 다릅니다.' }),
        picks.el,
        callout('핵심', '쌍 하나에 부동소수점 연산이 약 20개인데 읽는 데이터는 8바이트뿐입니다. 데이터를 재사용하는 비율이 높아 GPU 연산 장치가 먼저 포화되므로, N-body는 GPU가 크게 이기는 대표 사례입니다. 상태는 GPU 버퍼에 머물고 렌더 패스가 같은 버퍼를 바로 읽어 CPU로 되가져오지 않습니다.'),
      ),
      section(
        { title: '직접 측정하기' },
        controls(countField.el, stepsField.el, runBtn, rampBtn, verifyBtn),
        state.el,
      ),
      section({ title: '결과' }, maxList, table.el, tableFix, plot.el, env.el),
      section(
        { title: '정확도 검증' },
        el('p', { textContent: `같은 시드에서 N=${VERIFY_COUNT}, ${VERIFY_STEPS}스텝을 CPU(f64 누산)와 각 GPU 커널(f32)로 돌려 최대 절대 위치 오차를 비교합니다. 허용 오차는 ${VERIFY_TOLERANCE} px입니다.` }),
        verifyList,
      ),
      callout('측정 한계', [el('ul', {}, ...LIMITS_NOTES.map((t) => el('li', { textContent: t })))]),
      callout('해보기', 'N을 16384로 올리고 세 변형을 함께 실행해 보세요. 순진한 커널과 타일링 커널의 실효 프레임 시간이 어디서 갈라지는지, CPU는 어느 N에서 주사율을 놓치는지 확인합니다.'),
    ),
  );

  syncButtons();
  void estimateRefresh().then((hz) => {
    refreshHz = hz;
    env.update([['주사율(추정)', `${f(hz, 1)} Hz`]]);
  });
  if (previewEntry) void preview.start();
  else fig.setCaption('이 환경에서는 미리보기를 그릴 수 있는 변형이 없습니다. WebGPU가 필요합니다.');
  return { suspendPreview: preview.suspend, resumePreview: preview.resume };
}
