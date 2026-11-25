import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { unmetReason, type Capabilities } from '../../core/capabilities';
import { estimateRefresh, rampMaxN, trialPasses } from '../../core/frame-bench';
import { runFixed, type RunConfig, type RunResult } from './run';
import { throughput } from './sim';
import { registry, type VariantEntry } from './variants';
import { VERIFY_COUNT, VERIFY_STEPS, VERIFY_TOLERANCE, verifyNBody } from './verify';

const SERIES_COLORS = ['#e4572e', '#17bebb', '#ffc914'];
const RAMP_MAX = 262_144;
const RAMP_FRAMES = { warmupFrames: 15, measureFrames: 60 };

const EXPLAINER = [
  '2차원 원반 모양으로 돌고 있는 N개의 물체가 서로 모두에게 softened 중력을 받습니다. 모든 쌍(i, j)을 계산하므로 한 스텝의 일이 N²에 비례합니다 (O(N²)).',
  '적분은 symplectic Euler(반암시적 오일러)입니다. v ← v + a(p)·dt 로 속도를 먼저 갱신하고, 새 속도로 p ← p + v·dt 를 계산합니다. dt는 1/60초로 고정이고 CPU와 WGSL이 같은 규칙을 씁니다.',
  '쌍 하나는 부동소수점 연산 약 20개이고 읽는 데이터는 위치 8바이트입니다. 데이터를 재사용하는 비율(산술 강도)이 높아서 GPU의 연산 장치가 메모리보다 먼저 포화됩니다. 그래서 N-body는 GPU가 크게 이기는 대표 사례입니다.',
  '순진한 커널은 스레드마다 모든 물체를 전역 메모리에서 읽습니다. 타일링 커널은 워크그룹이 물체 256개를 var<workgroup> 메모리에 한 번 올려 모든 스레드가 공유하고, workgroupBarrier로 "다 올렸다 / 다 썼다"를 맞춥니다.',
  '상태는 GPU 스토리지 버퍼 두 개를 번갈아 쓰며(핑퐁) 한 스텝이 끝나면 렌더 패스가 같은 버퍼를 그대로 읽습니다. 컴퓨트와 렌더가 한 커맨드 인코더에 들어가므로 프레임마다 CPU로 읽어올 필요가 없습니다.',
  'CPU 변형도 그리기는 같은 WebGPU 포인트 렌더러를 쓰고 매 프레임 상태를 업로드합니다. 비교 대상은 시뮬레이션 계산뿐입니다.',
];

const LIMITS_NOTES = [
  '표의 "스텝/초"와 "쌍/초"는 실효 프레임 시간(큐를 비운 뒤 측정)에서 계산합니다. 변형이 주사율을 따라가는 동안에는 rAF가 프레임을 주사율로 묶으므로 이 값은 실제 처리량이 아니라 하한입니다. 처리량을 보려면 "스텝/프레임"을 올리거나 N을 키우세요.',
  '"주사율에서 유지되는 최대 N"은 중앙값 간격, 드롭 비율, 실효 프레임 시간이 모두 기준 안일 때 통과로 보고 배가 후 이분 탐색으로 찾습니다. N²이므로 N을 2배로 하면 일이 4배입니다.',
  'gpu 시간 열은 컴퓨트 패스 시작부터 렌더 패스 끝까지입니다. timestamp-query가 없거나 양자화되면 "-"입니다.',
  '다른 GPU 작업이 동시에 돌면 모든 수치가 흔들립니다. 헤드리스 스모크 수치는 성능 주장이 아닙니다.',
];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

const f = (x: number, d = 2) => x.toFixed(d);
const si = (x: number) => (x >= 1e9 ? `${f(x / 1e9)}G` : x >= 1e6 ? `${f(x / 1e6)}M` : x >= 1e3 ? `${f(x / 1e3)}k` : f(x, 0));

export function mountNBody(root: HTMLElement, caps: Capabilities): void {
  const selected = new Set<string>();
  const results: RunResult[] = [];
  const maxNs = new Map<string, number>();
  let refreshHz = 60;
  let busy = false;

  const capsList = el('ul', { className: 'caps' });
  const renderCaps = () => {
    const gpu = caps.webgpu;
    capsList.replaceChildren(
      el('li', { textContent: `WebGPU: ${gpu.kind === 'available' ? `사용 가능 (${gpu.adapterInfo})` : `사용 불가 (${gpu.reason})`}` }),
      el('li', { textContent: `timestamp-query: ${gpu.kind === 'available' && gpu.timestampQuery ? '지원' : '미지원'}` }),
      el('li', { textContent: `Long Animation Frames: ${caps.longAnimationFrames ? '지원' : '미지원'}` }),
      el('li', { textContent: `주사율(추정): ${f(refreshHz, 1)} Hz · DPR ${caps.dpr}` }),
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
    const label = el('label', { className: reason ? 'disabled' : '' }, input, ` ${entry.label}`);
    return el('div', { className: 'renderer' }, label, el('small', { textContent: reason ? `비활성: ${reason}` : entry.summary }));
  });

  const countInput = el('input', { type: 'number', min: '2', step: '1024', value: '4096' });
  const stepsInput = el('input', { type: 'number', min: '1', step: '1', value: '1' });
  const runBtn = el('button', { textContent: '고정 N 실행' });
  const rampBtn = el('button', { textContent: '최대 N 찾기' });
  const verifyBtn = el('button', { textContent: '정확도 검증' });
  const status = el('p', { className: 'status', textContent: '준비됨' });
  const stage = el('div', { className: 'stage' });
  const tableHost = el('div', { className: 'table' });
  const maxHost = el('ul', { className: 'caps' });
  const verifyHost = el('ul', { className: 'caps' });
  const chartHost = el('div', { className: 'chart' });

  const entriesSelected = (): VariantEntry[] => registry.filter((e) => selected.has(e.id));
  const syncButtons = () => {
    const disabled = busy || selected.size === 0;
    runBtn.disabled = disabled;
    rampBtn.disabled = disabled;
    verifyBtn.disabled = busy || caps.webgpu.kind !== 'available';
  };

  const configFor = (count: number): RunConfig => ({
    seed: 1,
    count,
    stepsPerFrame: Math.max(1, Math.floor(Number(stepsInput.value)) || 1),
  });

  const plot = new uPlot(
    {
      width: 800,
      height: 320,
      title: 'N 대비 실효 프레임 시간 (ms, 로그-로그)',
      scales: { x: { distr: 3, time: false }, y: { distr: 3 } },
      axes: [{ label: '물체 개수 N' }, { label: '실효 프레임 시간 (ms)' }],
      series: [
        {},
        ...registry.map((e, i) => ({ label: e.label, stroke: SERIES_COLORS[i % SERIES_COLORS.length], width: 2, spanGaps: true, points: { show: true } })),
      ],
    },
    [[], ...registry.map(() => [])],
    chartHost,
  );

  const refreshOutputs = () => {
    const header = ['변형', 'N', '스텝/프레임', '실효 프레임(ms)', '스텝/초', '쌍/초', '간격 중앙값', 'p95', 'cpu 중앙값', 'gpu 중앙값', '드롭 비율'];
    const rows = results.map((r) => {
      const t = throughput(r.count, r.stepsPerFrame, r.effectiveFrameMs);
      return [
        registry.find((e) => e.id === r.variantId)?.label ?? r.variantId,
        String(r.count),
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
    });
    tableHost.replaceChildren(
      el(
        'table',
        {},
        el('thead', {}, el('tr', {}, ...header.map((h) => el('th', { textContent: h })))),
        el('tbody', {}, ...rows.map((cells) => el('tr', {}, ...cells.map((c) => el('td', { textContent: c }))))),
      ),
    );
    maxHost.replaceChildren(
      ...registry.filter((e) => maxNs.has(e.id)).map((e) => el('li', { textContent: `${e.label}: ${f(refreshHz, 0)} Hz 유지 최대 N ≈ ${maxNs.get(e.id)}` })),
    );
    const xs = [...new Set(results.map((r) => r.count))].sort((a, b) => a - b);
    const series = registry.map((e) =>
      xs.map((x) => {
        const hits = results.filter((r) => r.variantId === e.id && r.count === x);
        return hits.length ? hits[hits.length - 1]!.effectiveFrameMs : null;
      }),
    );
    plot.setData([xs, ...series]);
  };

  const guarded = (label: string, job: () => Promise<string | void>) => async () => {
    busy = true;
    syncButtons();
    try {
      status.textContent = (await job()) ?? `${label} 완료`;
    } catch (err) {
      status.textContent = `${label} 실패: ${String(err)}`;
    } finally {
      stage.replaceChildren();
      busy = false;
      syncButtons();
    }
  };

  runBtn.addEventListener(
    'click',
    guarded('고정 N 실행', async () => {
      const count = Math.max(2, Math.floor(Number(countInput.value)));
      for (const entry of entriesSelected()) {
        status.textContent = `${entry.label} 측정 중 (N=${count})`;
        results.push(await runFixed(entry, configFor(count), caps, refreshHz, { host: stage }));
        refreshOutputs();
      }
    }),
  );

  rampBtn.addEventListener(
    'click',
    guarded('최대 N 찾기', async () => {
      for (const entry of entriesSelected()) {
        const { maxN } = await rampMaxN(
          async (n) => {
            status.textContent = `${entry.label} 탐색 중 (N=${n})`;
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
    }),
  );

  verifyBtn.addEventListener(
    'click',
    guarded('정확도 검증', async () => {
      const rs = await verifyNBody(caps);
      verifyHost.replaceChildren(
        ...rs.map((r) => el('li', { textContent: `${r.id}: ${r.pass ? '통과' : '실패'} · 최대 절대 위치 오차 ${r.maxAbsError.toExponential(2)} (허용 ${r.tolerance}) · N=${r.count}, ${r.steps}스텝` })),
      );
      return `정확도 검증 ${rs.every((r) => r.pass) ? '통과' : '실패'}`;
    }),
  );

  root.replaceChildren(
    el('h1', { textContent: 'WebGPU N체 중력 시뮬레이션' }),
    el('h2', { textContent: '이 데모는 무엇을 보여주나요' }),
    el('ul', {}, ...EXPLAINER.map((t) => el('li', { textContent: t }))),
    el('h2', { textContent: '환경' }),
    capsList,
    el('h2', { textContent: '변형' }),
    ...variantBoxes,
    el(
      'div',
      { className: 'controls' },
      el('label', {}, '물체 개수 N ', countInput),
      el('label', {}, '스텝/프레임 ', stepsInput),
      runBtn,
      rampBtn,
      verifyBtn,
    ),
    status,
    stage,
    el('h2', { textContent: '결과' }),
    maxHost,
    tableHost,
    chartHost,
    el('h2', { textContent: '정확도 검증' }),
    el('p', {
      textContent: `같은 시드에서 N=${VERIFY_COUNT}, ${VERIFY_STEPS}스텝을 CPU(f64 누산)와 각 GPU 커널(f32)로 돌려 최대 절대 위치 오차를 비교합니다. 허용 오차는 ${VERIFY_TOLERANCE} px입니다. 중력은 가까운 만남에서 반올림 차이를 증폭하고 합산 순서도 CPU와 GPU가 달라서, 스텝이 길어질수록 차이가 벌어지는 것이 정상입니다. 그래서 스텝 수를 작게 잡았고, 허용 오차는 측정된 오차(약 3e-5 px, 반지름 300 부근 f32의 1 ulp)의 30배 여유이면서, 타일(256개) 하나를 빼먹는 버그가 만드는 오차(약 0.06 px)보다 60배 작게 잡았습니다. 물체 하나를 빼먹는 정도의 미세한 버그는 잡지 못합니다.`,
    }),
    verifyHost,
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
