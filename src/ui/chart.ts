import { compactNumber } from './format';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { el } from './dom';
import { resolveCssColor, seriesVar, type SeriesToken } from './series';

export interface ChartSpec {
  title?: string;
  xLabel: string;
  yLabel: string;
  series: readonly { label: string; color: SeriesToken; dashed?: boolean }[];
  logX?: boolean;
  logY?: boolean;
  height?: number;
  /** Shown instead of an empty frame while there is no data. */
  emptyText?: string;
}

export interface Chart {
  el: HTMLElement;
  /** `ys[i]` belongs to `spec.series[i]`; `null` leaves a gap. */
  setData(xs: readonly number[], ys: readonly (readonly (number | null)[])[]): void;
}

const MOBILE = 520;

/** uPlot with theme tokens and the fixed series palette. Rebuilds on light/dark change and resizes with its box. */
export function chart(spec: ChartSpec): Chart {
  const host = el('div', { className: 'chart' });
  const empty = el('p', { className: 'chart-empty', textContent: spec.emptyText ?? '아직 측정 결과가 없습니다. 측정을 실행하면 이 자리에 그래프가 그려집니다.' });
  const root = el('div', { className: 'chart-box' }, spec.title ? el('div', { className: 'chart-title', textContent: spec.title }) : null, empty, host);
  root.classList.add('is-empty');
  let data: uPlot.AlignedData = [[], ...spec.series.map(() => [])];
  let plot: uPlot | null = null;
  let width = 0;

  const build = () => {
    plot?.destroy();
    const text = resolveCssColor('var(--muted)');
    const grid = resolveCssColor('var(--border)');
    const mono = `12px ${resolveCssColor('var(--font-mono)')}`;
    const axis = (label: string, size: number): uPlot.Axis => ({
      label,
      stroke: text,
      font: mono,
      labelFont: `13px ${resolveCssColor('var(--font-sans)')}`,
      grid: { stroke: grid, width: 1 },
      ticks: { stroke: grid, width: 1 },
      size,
      labelSize: 22,
    });
    plot = new uPlot(
      {
        width,
        height: spec.height ?? (width < MOBILE ? 260 : 340),
        padding: [12, 44, 0, 0],
        legend: { show: true, live: false },
        cursor: { points: { size: 7 } },
        scales: {
          x: { distr: spec.logX ? 3 : 1, time: false },
          y: spec.logY ? { distr: 3 } : { range: (_u, _min, max) => [0, Math.max(max * 1.1, 1e-9)] },
        },
        axes: [
          { ...axis(spec.xLabel, 46), ...(spec.logX ? { values: (_u: uPlot, splits: (number | null)[]) => splits.map((v) => (v == null ? '' : compactNumber(v))) } : {}) },
          axis(spec.yLabel, width < MOBILE ? 56 : 64),
        ],
        series: [
          {},
          ...spec.series.map((s) => ({
            label: s.label,
            stroke: resolveCssColor(seriesVar(s.color)),
            width: 2,
            dash: s.dashed ? [6, 4] : undefined,
            spanGaps: true,
            points: { show: true, size: 6, fill: resolveCssColor('var(--surface)'), stroke: resolveCssColor(seriesVar(s.color)), width: 2 },
          })),
        ],
      },
      data,
      host,
    );
  };

  const ro = new ResizeObserver(() => {
    const w = Math.floor(host.clientWidth);
    if (w < 40 || w === width) return;
    const crossed = (w < MOBILE) !== (width < MOBILE);
    width = w;
    if (!plot || crossed) build();
    else plot.setSize({ width: w, height: spec.height ?? 340 });
  });
  ro.observe(host);
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => width > 0 && build());

  return {
    el: root,
    setData(xs, ys) {
      data = [xs as number[], ...(ys as (number | null)[][])];
      root.classList.toggle('is-empty', xs.length === 0);
      plot?.setData(data);
    },
  };
}

