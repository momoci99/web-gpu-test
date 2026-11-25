import { el } from './dom';

let uid = 0;
const nextId = (prefix: string) => `${prefix}-${++uid}`;

/** Horizontal wrapping row for fields and buttons. */
export function controls(...children: (Node | null)[]): HTMLElement {
  return el('div', { className: 'controls' }, ...children);
}

export function button(spec: { label: string; variant?: 'primary' | 'secondary'; onClick: () => void }): HTMLButtonElement {
  const b = el('button', { type: 'button', textContent: spec.label, className: spec.variant === 'primary' ? 'primary' : '' });
  b.addEventListener('click', spec.onClick);
  return b;
}

export interface NumberField {
  el: HTMLLabelElement;
  input: HTMLInputElement;
  /** Parsed integer, clamped to min/max. Falls back to `value` when the input is empty. */
  read(): number;
}

export function numberField(spec: { label: string; value: number; min?: number; max?: number; step?: number; unit?: string }): NumberField {
  const input = el('input', { type: 'number', value: String(spec.value), step: String(spec.step ?? 1) });
  if (spec.min !== undefined) input.min = String(spec.min);
  if (spec.max !== undefined) input.max = String(spec.max);
  const root = el('label', { className: 'field' }, el('span', { className: 'field-label', textContent: spec.label }), input, spec.unit ? el('span', { className: 'field-unit', textContent: spec.unit }) : null);
  const read = () => {
    const n = Math.floor(Number(input.value));
    const v = Number.isFinite(n) && input.value !== '' ? n : spec.value;
    return Math.min(spec.max ?? Infinity, Math.max(spec.min ?? -Infinity, v));
  };
  return { el: root, input, read };
}

export interface Slider {
  el: HTMLLabelElement;
  input: HTMLInputElement;
  value(): number;
}

export function slider(spec: { label: string; min: number; max: number; step?: number; value: number; format?: (v: number) => string; onInput?: (v: number) => void }): Slider {
  const format = spec.format ?? String;
  const input = el('input', { type: 'range', min: String(spec.min), max: String(spec.max), step: String(spec.step ?? 1), value: String(spec.value) });
  const out = el('output', { textContent: format(spec.value) });
  input.addEventListener('input', () => {
    const v = Number(input.value);
    out.textContent = format(v);
    spec.onInput?.(v);
  });
  const root = el('label', { className: 'field slider' }, el('span', { className: 'field-label', textContent: spec.label }), input, out);
  return { el: root, input, value: () => Number(input.value) };
}

export interface Segmented<T extends string> {
  el: HTMLElement;
  get(): T;
  set(value: T): void;
}

export function segmented<T extends string>(spec: { label: string; options: readonly { value: T; label: string }[]; value: T; onChange?: (v: T) => void }): Segmented<T> {
  const name = nextId('seg');
  let current = spec.value;
  const inputs = spec.options.map((o) => {
    const input = el('input', { type: 'radio', name, value: o.value, checked: o.value === spec.value });
    input.addEventListener('change', () => {
      if (!input.checked) return;
      current = o.value;
      spec.onChange?.(current);
    });
    return { input, node: el('label', {}, input, el('span', { textContent: o.label })) };
  });
  const root = el('div', { className: 'segmented-field' }, el('span', { className: 'field-label', textContent: spec.label }), el('div', { className: 'segmented', role: 'radiogroup' }, ...inputs.map((i) => i.node)));
  return {
    el: root,
    get: () => current,
    set(v) {
      current = v;
      for (const { input } of inputs) input.checked = input.value === v;
    },
  };
}

export interface CheckItem {
  id: string;
  label: string;
  /** Sub-label shown under the label. */
  hint?: string;
  /** When set the item is disabled and this text replaces the hint. */
  disabledReason?: string | null;
  checked?: boolean;
  /** Series role color shown as a swatch. */
  swatch?: string;
}

export interface CheckList {
  el: HTMLElement;
  selected(): Set<string>;
}

function swatch(color: string): HTMLElement {
  const i = el('i', { className: 'swatch' });
  i.style.background = color;
  return i;
}

/** Disabled items start unchecked. `onChange` receives the selected ids. */
export function checkList(items: readonly CheckItem[], onChange?: (selected: Set<string>) => void): CheckList {
  const boxes = new Map<string, HTMLInputElement>();
  const selected = () => new Set([...boxes].filter(([, b]) => b.checked).map(([id]) => id));
  const rows = items.map((item) => {
    const disabled = !!item.disabledReason;
    const input = el('input', { type: 'checkbox', disabled, checked: !disabled && item.checked !== false });
    input.addEventListener('change', () => onChange?.(selected()));
    boxes.set(item.id, input);
    return el(
      'label',
      { className: disabled ? 'check-item disabled' : 'check-item' },
      input,
      el('span', { className: 'check-text' }, el('span', { className: 'check-name' }, item.swatch ? swatch(item.swatch) : null, item.label), el('small', { textContent: disabled ? `사용 불가: ${item.disabledReason}` : (item.hint ?? '') })),
    );
  });
  return { el: el('div', { className: 'check-list' }, ...rows), selected };
}
