import { describe, expect, it } from 'vitest';
import { barHeights, cardBarHeight, carouselCard, chronoFrame, chronoY0, flickTarget, gridStep, smoothPath } from '../src/timeline/chrono-math.ts';

describe('Chronoscope maths (as in the original design)', () => {
  it('floors the y axis to 5% steps below the worst run', () => {
    expect(chronoY0([0.97, 0.99])).toBeCloseTo(0.95);
    expect(chronoY0([0.91])).toBeCloseTo(0.85);
    expect(chronoY0([0.2])).toBeCloseTo(0.15);
    expect(chronoY0([0])).toBe(0);
    expect(chronoY0([])).toBeCloseTo(0.95);
    expect([gridStep(0.85), gridStep(0.15)]).toEqual([0.05, 0.1]);
  });

  it('maps days across the inner width and 100% to the top', () => {
    const f = chronoFrame(1000, 7, [0.9]);
    expect(f.H).toBe(300);
    expect(f.X(0)).toBe(40);
    expect(f.X(7)).toBe(990);
    expect(f.Y(1)).toBe(12);
    expect(f.Y(f.y0)).toBeCloseTo(12 + f.ih);
    expect(chronoFrame(500, 7, []).H).toBe(250);
  });

  it('draws horizontal-tangent cubic segments', () => {
    expect(smoothPath([[0, 10], [10, 20]])).toBe('M0,10 C5,10 5,20 10,20');
    expect(smoothPath([])).toBe('');
  });

  it('scales failed/flaky bars to the busiest day', () => {
    expect(barHeights([{ failed: 2, flaky: 2 }, { failed: 1, flaky: 0 }], 40)).toEqual([{ hf: 20, hl: 20 }, { hf: 10, hl: 0 }]);
    expect(barHeights([{ failed: 0, flaky: 0 }], 40)).toEqual([{ hf: 0, hl: 0 }]);
  });

  it('sizes card bars from 75% (floor 6%) to 100%', () => {
    expect(cardBarHeight(100)).toBe(100);
    expect(cardBarHeight(87.5)).toBe(50);
    expect(cardBarHeight(50)).toBe(6);
  });
});

describe('carousel', () => {
  it('shows the selected card in front and hides cards far round the cylinder', () => {
    const front = carouselCard(3, 3, 210);
    expect(front).toMatchObject({ visible: true, opacity: 1, zIndex: 100 });
    expect(front.transform).toContain('rotateY(0rad)');
    expect(carouselCard(4, 3, 210).opacity).toBeLessThan(1);
    expect(carouselCard(12, 3, 210).visible).toBe(false);
  });

  it('lets a flick carry on in its direction, within the cards', () => {
    expect(flickTarget(3, 0, 210, 7)).toBe(3);
    expect(flickTarget(3, -1, 210, 7)).toBe(4); // dragging left moves forward
    expect(flickTarget(3, 10, 210, 7)).toBe(0);
    expect(flickTarget(3, -10, 210, 7)).toBe(6);
  });
});
