import { canvas2dEntry } from './canvas2d';
import { svgEntry } from './svg';
import type { RendererEntry } from './types';

export const registry: readonly RendererEntry[] = [svgEntry, canvas2dEntry];
