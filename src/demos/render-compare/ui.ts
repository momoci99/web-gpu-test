import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { estimateRefresh, rampMaxN, runFixed, trialPasses, type RunResult } from '../../core/bench';
import { unmetReason, type Capabilities } from '../../core/capabilities';
import { registry } from './renderers/registry';
import type { RendererEntry } from './renderers/types';
import type { SceneConfig } from './scene';
import { verifyComputeParity } from './verify';

const SCENE_SIZE = { width: 800, height: 600 };
const SERIES_COLORS = ['#e4572e', '#17bebb', '#ffc914', '#76b041', '#7b5ea7'];

const LIMITS_NOTES = [
  'rAF는 화면 주사율에서 멈추므로 헤드라인 지표는 fps가 아니라 "주사율에서 유지되는 최대 N"입니다.',
  'SVG 비용은 대부분 JS 밖(스타일/레이아웃/페인트)에서 발생하므로 cpuMs는 과소 측정됩니다. 프레임 간격과 LoAF가 이를 반영합니다.',
  'WebGPU의 cpuMs는 인코딩 + 제출 시간만 의미합니다. GPU 작업은 gpuMs에 나타나고, GPU 병목일 때는 프레임 간격에도 나타납니다.',
  'Chrome은 WebGPU Developer Features 플래그가 꺼져 있으면 timestamp-query를 약 100 µs 단위로 양자화합니다.',
];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

const f = (x: number, d = 2) => x.toFixed(d);

export function mountRenderCompare(root: HTMLElement, caps: Capabilities): void {
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
      el('li', { textContent: `WebGL2: ${caps.webgl2 ? '지원' : '미지원'}` }),
      el('li', { textContent: `Long Animation Frames: ${caps.longAnimationFrames ? '지원' : '미지원'}` }),
      el('li', { textContent: `주사율(추정): ${f(refreshHz, 1)} Hz · DPR ${caps.dpr}` }),
    );
  };

  const rendererBoxes = registry.map((entry) => {
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
    const note = el('small', { textContent: reason ? `비활성: ${reason}` : entry.summary });
    return el('div', { className: 'renderer' }, label, note);
  });

  const countInput = el('input', { type: 'number', min: '1', step: '1000', value: '5000' });
  const runBtn = el('button', { textContent: '고정 N 실행' });
  const rampBtn = el('button', { textContent: '최대 N 찾기' });
  const verifyBtn = el('button', { textContent: '컴퓨트 검증' });
  const status = el('p', { className: 'status', textContent: '준비됨' });
  const stage = el('div', { className: 'stage' });
  stage.style.width = `${SCENE_SIZE.width}px`;
  stage.style.height = `${SCENE_SIZE.height}px`;
  const tableHost = el('div', { className: 'table' });
  const maxHost = el('ul', { className: 'caps' });
  const chartHost = el('div', { className: 'chart' });

  const entriesSelected = (): RendererEntry[] => registry.filter((e) => selected.has(e.id));
  const syncButtons = () => {
    const disabled = busy || selected.size === 0;
    runBtn.disabled = disabled;
    rampBtn.disabled = disabled;
    verifyBtn.disabled = busy || caps.webgpu.kind !== 'available';
  };

  const sceneFor = (count: number): SceneConfig => ({ seed: 1, count, ...SCENE_SIZE });

  const plot = new uPlot(
    {
      width: 800,
      height: 320,
      title: 'N 대비 프레임 간격 중앙값 (ms)',
      scales: { x: { distr: 3, time: false }, y: { range: (_u, _min, max) => [0, Math.max(20, max * 1.1)] } },
      axes: [{ label: '원 개수 N' }, { label: '프레임 간격 중앙값 (ms)' }],
      series: [
        {},
        ...registry.map((e, i) => ({
          label: e.label,
          stroke: SERIES_COLORS[i % SERIES_COLORS.length],
          width: 2,
          spanGaps: true,
          points: { show: true },
        })),
      ],
    },
    [[], ...registry.map(() => [])],
    chartHost,
  );

  const refreshOutputs = () => {
    const header = ['렌더러', 'N', '프레임 간격 중앙값', 'p95', 'cpu 중앙값', 'gpu 중앙값', '드롭 비율', 'LoAF(횟수/차단ms)'];
    const rows = results.map((r) => [
      registry.find((e) => e.id === r.rendererId)?.label ?? r.rendererId,
      String(r.count),
      f(r.interval.median),
      f(r.interval.p95),
      f(r.cpu.median, 3),
      r.gpu ? f(r.gpu.median, 3) : '-',
      f(r.droppedRatio, 3),
      r.longFrames ? `${r.longFrames.count} / ${f(r.longFrames.totalBlockingMs, 1)}` : '-',
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
      ...registry.filter((e) => maxNs.has(e.id)).map((e) => el('li', { textContent: `${e.label}: ${f(refreshHz, 0)} Hz 유지 최대 N ≈ ${maxNs.get(e.id)}` })),
    );
    const xs = [...new Set(results.map((r) => r.count))].sort((a, b) => a - b);
    const series = registry.map((e) =>
      xs.map((x) => {
        const hits = results.filter((r) => r.rendererId === e.id && r.count === x);
        return hits.length ? hits[hits.length - 1]!.interval.median : null;
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

  const measure = (entry: RendererEntry, count: number) => runFixed(entry, sceneFor(count), caps, refreshHz, { host: stage });

  runBtn.addEventListener(
    'click',
    guarded('고정 N 실행', async () => {
      const count = Math.max(1, Math.floor(Number(countInput.value)));
      for (const entry of entriesSelected()) {
        status.textContent = `${entry.label} 측정 중 (N=${count})`;
        results.push(await measure(entry, count));
        refreshOutputs();
      }
    }),
  );

  rampBtn.addEventListener(
    'click',
    guarded('최대 N 찾기', async () => {
      for (const entry of entriesSelected()) {
        const { maxN } = await rampMaxN(async (n) => {
          status.textContent = `${entry.label} 탐색 중 (N=${n})`;
          const r = await measure(entry, n);
          results.push(r);
          refreshOutputs();
          return trialPasses(r);
        });
        maxNs.set(entry.id, maxN);
        refreshOutputs();
      }
    }),
  );

  verifyBtn.addEventListener(
    'click',
    guarded('컴퓨트 검증', async () => {
      const r = await verifyComputeParity(caps);
      return `컴퓨트 검증 ${r.pass ? '통과' : '실패'}: 최대 절대 오차 ${r.maxAbsError.toExponential(2)} (원 ${r.count}개, ${r.steps}스텝)`;
    }),
  );

  root.replaceChildren(
    el('h1', { textContent: 'WebGPU 렌더링 비교: 튀는 원 장면' }),
    el('p', { textContent: '같은 장면(같은 시드, 고정 dt)을 SVG, Canvas2D, WebGL2, WebGPU(CPU 시뮬레이션), WebGPU(컴퓨트 시뮬레이션)로 그려 비교합니다.' }),
    el('h2', { textContent: '환경' }),
    capsList,
    el('h2', { textContent: '렌더러' }),
    ...rendererBoxes,
    el('div', { className: 'controls' }, el('label', {}, '원 개수 N ', countInput), runBtn, rampBtn, verifyBtn),
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
