import { el } from './dom';

export interface Column {
  label: string;
  /** Shown under the label, e.g. "ms". */
  unit?: string;
  /** Right-aligned monospace. The first column is always text. */
  numeric?: boolean;
}

export interface ResultsTable {
  el: HTMLElement;
  setRows(rows: readonly (readonly string[])[]): void;
}

export function resultsTable(columns: readonly Column[]): ResultsTable {
  const body = el('tbody');
  const head = el(
    'tr',
    {},
    ...columns.map((c, i) => {
      const th = el('th', { scope: 'col' }, c.label, c.unit ? el('span', { className: 'unit', textContent: c.unit }) : null);
      if (i > 0 && c.numeric !== false) th.className = 'num';
      return th;
    }),
  );
  const table = el('table', { className: 'results' }, el('thead', {}, head), body);
  return {
    el: el('div', { className: 'table' }, table),
    setRows(rows) {
      body.replaceChildren(
        ...rows.map((r) =>
          el('tr', {}, ...r.map((cell, i) => el(i === 0 ? 'th' : 'td', { textContent: cell, className: i > 0 && columns[i]?.numeric !== false ? 'num' : '', ...(i === 0 ? { scope: 'row' } : {}) }))),
        ),
      );
    },
  };
}
