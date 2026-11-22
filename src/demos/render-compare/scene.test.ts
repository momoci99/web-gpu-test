import { describe, expect, it } from 'vitest';
import { createScene, stepScene, unpackColor, FIXED_DT, type SceneData } from './scene';

const config = { seed: 7, count: 64, width: 300, height: 200 };

function single(x: number, y: number, vx: number, vy: number, r: number): SceneData {
  return {
    config: { seed: 0, count: 1, width: 100, height: 100 },
    state: new Float32Array([x, y, vx, vy]),
    radius: new Float32Array([r]),
    color: new Uint32Array([0]),
  };
}

describe('createScene', () => {
  it('is deterministic from the seed', () => {
    const a = createScene(config);
    const b = createScene(config);
    expect(a.state).toEqual(b.state);
    expect(a.radius).toEqual(b.radius);
    expect(a.color).toEqual(b.color);
  });

  it('starts every circle inside the bounds with translucent color', () => {
    const s = createScene(config);
    for (let i = 0; i < config.count; i++) {
      const [x, y] = [s.state[i * 4]!, s.state[i * 4 + 1]!];
      const r = s.radius[i]!;
      expect(x - r).toBeGreaterThanOrEqual(0);
      expect(x + r).toBeLessThanOrEqual(config.width);
      expect(y - r).toBeGreaterThanOrEqual(0);
      expect(y + r).toBeLessThanOrEqual(config.height);
      expect(unpackColor(s.color[i]!).a).toBeLessThan(255);
    }
  });
});

describe('stepScene', () => {
  it('advances by v * dt away from walls', () => {
    const s = single(50, 50, 60, -30, 5);
    stepScene(s, FIXED_DT);
    expect(s.state[0]).toBeCloseTo(51, 4);
    expect(s.state[1]).toBeCloseTo(49.5, 4);
    expect(s.state[2]).toBe(60);
    expect(s.state[3]).toBe(-30);
  });

  it('clamps to the low wall and reflects velocity to positive', () => {
    const s = single(5.1, 50, -60, 0, 5);
    stepScene(s, FIXED_DT);
    expect(s.state[0]).toBe(5);
    expect(s.state[2]).toBe(60);
  });

  it('clamps to the high wall and reflects velocity to negative', () => {
    const s = single(94.9, 50, 60, 0, 5);
    stepScene(s, FIXED_DT);
    expect(s.state[0]).toBe(95);
    expect(s.state[2]).toBe(-60);
  });

  it('handles each axis independently', () => {
    const s = single(50, 94.9, 10, 60, 5);
    stepScene(s, FIXED_DT);
    expect(s.state[1]).toBe(95);
    expect(s.state[3]).toBe(-60);
    expect(s.state[2]).toBe(10);
  });

  it('keeps velocity direction pointing inward when already past a wall', () => {
    const s = single(2, 50, 60, 0, 5);
    stepScene(s, FIXED_DT);
    expect(s.state[0]).toBe(5);
    expect(s.state[2]).toBe(60);
  });

  it('keeps every circle in bounds over many steps', () => {
    const s = createScene(config);
    for (let k = 0; k < 600; k++) stepScene(s, FIXED_DT);
    for (let i = 0; i < config.count; i++) {
      const r = s.radius[i]!;
      expect(s.state[i * 4]!).toBeGreaterThanOrEqual(r);
      expect(s.state[i * 4]!).toBeLessThanOrEqual(config.width - r);
      expect(s.state[i * 4 + 1]!).toBeGreaterThanOrEqual(r);
      expect(s.state[i * 4 + 1]!).toBeLessThanOrEqual(config.height - r);
    }
  });

  it('produces identical frame k for identical seeds', () => {
    const a = createScene(config);
    const b = createScene(config);
    for (let k = 0; k < 30; k++) {
      stepScene(a, FIXED_DT);
      stepScene(b, FIXED_DT);
    }
    expect(a.state).toEqual(b.state);
  });
});
