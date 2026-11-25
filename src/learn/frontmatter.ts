export interface FrontMatter {
  title?: string;
  order?: number;
  summary?: string;
  demo?: string;
}

export interface Parsed {
  data: FrontMatter;
  body: string;
  /** True when a closed `---` block opened the file. */
  found: boolean;
}

const KEYS = ['title', 'order', 'summary', 'demo'] as const;

function parseValue(raw: string): string {
  const v = raw.trim();
  const quoted = /^(['"])(.*?)\1(?:\s+#.*)?$/.exec(v);
  if (quoted) return quoted[2]!;
  return v.replace(/\s+#.*$/, '').trim();
}

/** Reads only title, order, summary and demo. Unknown keys and malformed lines are ignored. */
export function parseFrontMatter(source: string): Parsed {
  const text = source.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const m = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(text);
  if (!m) return { data: {}, body: text, found: false };
  const data: FrontMatter = {};
  for (const line of m[1]!.split('\n')) {
    const kv = /^([A-Za-z_]+)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1] as (typeof KEYS)[number];
    if (!KEYS.includes(key)) continue;
    const value = parseValue(kv[2]!);
    if (value === '') continue;
    if (key === 'order') {
      const n = Number(value);
      if (Number.isFinite(n)) data.order = n;
    } else {
      data[key] = value;
    }
  }
  return { data, body: text.slice(m[0].length), found: true };
}
