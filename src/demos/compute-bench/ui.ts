import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import type { Capabilities } from '../../core/capabilities';
import { crossoverN, type AnyWorkload, type OneShotResult } from '../../core/oneshot';
import { implRunnable, sweep } from './sweep';

const COLORS = ['#e4572e', '#17bebb', '#ffc914', '#76b041', '#7b5ea7', '#2e86ab'];

const LIMITS_NOTES = [
  'GPU e2e는 입력 업로드 + 커널 + 결과 읽기(mapAsync)를 모두 포함합니다. 작은 입력에서는 이 고정 비용이 계산 시간보다 커서 CPU가 이깁니다.',
  '커널만(kernel) 시간은 timestamp-query로 잰 값입니다. e2e와의 차이가 업로드와 읽기 비용입니다. 데이터가 GPU에 계속 머무는 파이프라인이라면 이 비용은 나눠 갚게 됩니다.',
  'setup(파이프라인 컴파일, 버퍼 할당)은 e2e에 포함하지 않고 따로 표시합니다. 각 구현은 측정 전에 1회 워밍업합니다.',
  'CPU는 performance.now()의 해상도(약 0.1 ms)보다 짧게 끝나는 작은 N에서 여러 번을 묶어 평균낸 값을 1회로 칩니다. GPU 작은 N의 e2e도 이 해상도에 걸려 거칠게 나옵니다.',
  '각 (구현, N)은 최소 3회, 최대 10회(또는 합계 2초 초과 시 중단) 실행한 중앙값입니다. 검증(check)은 첫 실행과 마지막 실행의 출력에 적용합니다.',
  'Chrome은 WebGPU Developer Features 플래그가 꺼져 있으면 timestamp-query를 약 100 µs 단위로 양자화합니다.',
];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

const f = (x: number, d = 3) => x.toFixed(d);
const fOpt = (s: { median: number } | null, d = 3) => (s ? f(s.median, d) : '-');

export function mountComputeBench(root: HTMLElement, all: AnyWorkload[], device: GPUDevice | null, caps: Capabilities): void {
  let workload = all[0]!;
  let results: OneShotResult[] = [];
  let plot: uPlot | null = null;
  let busy = false;

  const select = el('select', {}, ...all.map((w) => el('option', { value: w.id, textContent: w.label })));
  const summary = el('p');
  const sizeBox = el('div', { className: 'checks' });
  const implBox = el('div', { className: 'checks' });
  const runBtn = el('button', { textContent: '실행' });
  const status = el('p', { className: 'status', textContent: '준비됨' });
  const crossText = el('p', { className: 'crossover' });
  const tableHost = el('div', { className: 'table' });
  const chartHost = el('div', { className: 'chart' });

  const checked = (box: HTMLElement) => [...box.querySelectorAll<HTMLInputElement>('input:checked')].map((i) => i.value);
  const syncButtons = () => {
    runBtn.disabled = busy || checked(sizeBox).length === 0 || checked(implBox).length === 0;
    select.disabled = busy;
  };

  const checkbox = (value: string, text: string, on: boolean, disabledReason: string | null = null) => {
    const input = el('input', { type: 'checkbox', value, checked: on && disabledReason === null, disabled: disabledReason !== null });
    input.addEventListener('change', syncButtons);
    return el('label', { className: disabledReason ? 'disabled' : '', title: disabledReason ?? '' }, input, ` ${text}`);
  };

  const loadWorkload = () => {
    workload = all.find((w) => w.id === select.value)!;
    summary.textContent = workload.summary;
    sizeBox.replaceChildren(...workload.sizes.map((n) => checkbox(String(n), workload.sizeLabel(n), true)));
    implBox.replaceChildren(
      ...workload.impls.map((i) =>
        checkbox(i.id, i.label, true, implRunnable(i, device) ? null : caps.webgpu.kind === 'unavailable' ? caps.webgpu.reason : 'GPUDevice를 만들 수 없습니다'),
      ),
    );
    results = [];
    refreshOutputs();
    syncButtons();
  };

  const refreshOutputs = () => {
    const header = ['구현', 'N', 'e2e 중앙값 (ms)', 'e2e p95', '실행 횟수', 'compute (ms)', 'readback (ms)', 'kernel (ms)', 'setup (ms)', '처리량', 'check'];
    const unit = workload.work?.(1).unit;
    const rows = results.map((r) => {
      const impl = workload.impls.find((i) => i.id === r.implId);
      return [
        impl?.label ?? r.implId,
        workload.sizeLabel(r.n),
        f(r.e2e.median),
        f(r.e2e.p95),
        String(r.runs),
        fOpt(r.compute),
        fOpt(r.readback),
        fOpt(r.kernel),
        r.setupMs === null ? '-' : f(r.setupMs, 1),
        r.throughput === null ? '-' : `${r.throughput.toPrecision(3)} ${unit}/s`,
        `${r.check.ok ? '통과' : '실패'}: ${r.check.detail}`,
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

    const kinds = new Set(results.map((r) => r.kind));
    if (kinds.size < 2) crossText.textContent = '교차점을 구하려면 CPU와 GPU 구현을 모두 측정해야 합니다.';
    else {
      const x = crossoverN(results);
      crossText.textContent = x === null ? '측정 범위에서 교차 없음' : `이 크기부터 GPU가 CPU보다 빠름: n ≈ ${workload.sizeLabel(x)}`;
    }
    drawChart();
  };

  const drawChart = () => {
    plot?.destroy();
    plot = null;
    if (results.length === 0) return chartHost.replaceChildren();
    const ids = workload.impls.map((i) => i.id).filter((id) => results.some((r) => r.implId === id));
    const xs = [...new Set(results.map((r) => r.n))].sort((a, b) => a - b);
    const at = (id: string, n: number) => results.find((r) => r.implId === id && r.n === n);
    const kernelIds = ids.filter((id) => results.some((r) => r.implId === id && r.kernel));
    const series: uPlot.Series[] = [{}];
    const data: (number | null)[][] = [xs];
    ids.forEach((id, i) => {
      series.push({ label: workload.impls.find((x) => x.id === id)!.label, stroke: COLORS[i % COLORS.length], width: 2, points: { show: true }, spanGaps: true });
      data.push(xs.map((n) => at(id, n)?.e2e.median ?? null));
    });
    kernelIds.forEach((id) => {
      const i = ids.indexOf(id);
      series.push({ label: `${workload.impls.find((x) => x.id === id)!.label} 커널만`, stroke: COLORS[i % COLORS.length], width: 1.5, dash: [6, 4], spanGaps: true });
      data.push(xs.map((n) => at(id, n)?.kernel?.median ?? null));
    });
    plot = new uPlot(
      {
        width: 800,
        height: 360,
        title: 'N 대비 e2e 중앙값 (ms, 로그-로그)',
        scales: { x: { distr: 3, time: false }, y: { distr: 3 } },
        axes: [{ label: '입력 크기 N' }, { label: '시간 중앙값 (ms)' }],
        series,
      },
      data as uPlot.AlignedData,
      chartHost,
    );
  };

  runBtn.addEventListener('click', async () => {
    busy = true;
    syncButtons();
    results = [];
    refreshOutputs();
    try {
      const sizes = checked(sizeBox).map(Number);
      const impls = workload.impls.filter((i) => checked(implBox).includes(i.id));
      await sweep(workload, sizes, impls, device, (r) => {
        results.push(r);
        status.textContent = `${workload.sizeLabel(r.n)} 측정 완료`;
        refreshOutputs();
      });
      const failed = results.filter((r) => !r.check.ok).length;
      status.textContent = failed > 0 ? `완료, 검증 실패 ${failed}건` : '완료';
    } catch (err) {
      status.textContent = `실패: ${String(err)}`;
    } finally {
      busy = false;
      syncButtons();
    }
  });
  select.addEventListener('change', loadWorkload);

  const gpu = caps.webgpu;
  root.replaceChildren(
    el('h1', { textContent: '컴퓨트 벤치: CPU 대 GPU 교차점' }),
    el('p', { textContent: `WebGPU: ${gpu.kind === 'available' ? `사용 가능 (${gpu.adapterInfo}), timestamp-query ${gpu.timestampQuery ? '지원' : '미지원'}` : `사용 불가 (${gpu.reason})`}` }),
    el('div', { className: 'controls' }, el('label', {}, '워크로드 ', select), runBtn),
    summary,
    el('h2', { textContent: '구현' }),
    implBox,
    el('h2', { textContent: '입력 크기' }),
    sizeBox,
    status,
    el('h2', { textContent: '결과' }),
    crossText,
    tableHost,
    chartHost,
    el('h2', { textContent: '측정 한계' }),
    el('ul', {}, ...LIMITS_NOTES.map((t) => el('li', { textContent: t }))),
  );
  loadWorkload();
}
