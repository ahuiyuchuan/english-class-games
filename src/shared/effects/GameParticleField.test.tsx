// @vitest-environment jsdom
/** 装饰预算与资源释放回归；只模拟绘图设备，不冒充浏览器视觉验收。 @author ahui */
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { GameParticleField } from './GameParticleField';
import { CompletionBurst } from '../../games/word-beat/ClassroomVisuals';

let width = 1366;
let height = 768;
let reduced = false;
let notifyPreference: () => void;
let resize: () => void;
let nextFrame: FrameRequestCallback | undefined;
const disconnect = vi.fn();
const arc = vi.fn();
const context = {
  setTransform: vi.fn(),
  clearRect: vi.fn(),
  beginPath: vi.fn(),
  moveTo: vi.fn(),
  lineTo: vi.fn(),
  stroke: vi.fn(),
  fill: vi.fn(),
  arc,
  ellipse: vi.fn(),
  createLinearGradient: () => ({ addColorStop: vi.fn() }),
};

beforeEach(() => {
  width = 1366;
  height = 768;
  reduced = false;
  nextFrame = undefined;
  vi.clearAllMocks();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    context as unknown as CanvasRenderingContext2D,
  );
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockImplementation(
    () => ({ width, height, left: 0, top: 0 }) as DOMRect,
  );
  vi.stubGlobal('matchMedia', () => ({
    get matches() {
      return reduced;
    },
    addEventListener: (_name: string, listener: () => void) => {
      notifyPreference = listener;
    },
    removeEventListener: vi.fn(),
  }));
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        resize = callback;
      }
      observe() {}
      disconnect = disconnect;
    },
  );
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn((callback: FrameRequestCallback) => {
      nextFrame = callback;
      return 1;
    }),
  );
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('暂停保持最后帧，同尺寸不重绘，实际缩放重投影且卸载释放订阅', () => {
  const view = render(<GameParticleField active />);
  const canvas = view.container.querySelector('canvas')!;
  const count = canvas.dataset.frame;
  view.rerender(<GameParticleField active={false} />);
  expect(canvas.dataset.frame).toBe(count);
  act(() => resize());
  expect(canvas.dataset.frame).toBe(count);
  width = 720;
  height = 480;
  act(() => resize());
  expect(canvas.width).toBe(720);
  expect(canvas.height).toBe(480);
  expect(Number(canvas.dataset.frame)).toBe(Number(count) + 1);
  expect(cancelAnimationFrame).toHaveBeenCalled();
  view.unmount();
  expect(disconnect).toHaveBeenCalledTimes(2);
});

it('连续慢绘制触发单向降级并实际减少绘图量，暂停继续不恢复高负载', () => {
  const view = render(<GameParticleField active />);
  const canvas = view.container.querySelector('canvas')!;
  // 可控绘图成本用于验证分支，不能作为真实设备帧率结果。
  let cost = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => {
    cost += 10;
    return cost;
  });
  arc.mockClear();
  act(() => nextFrame?.(100));
  const fullDraws = arc.mock.calls.length;
  for (let index = 1; index < 8; index++) act(() => nextFrame?.(100 + index * 30));
  expect(canvas.dataset.quality).toBe('low');
  arc.mockClear();
  act(() => nextFrame?.(400));
  expect(arc.mock.calls.length).toBeLessThan(fullDraws);
  view.rerender(<GameParticleField active={false} />);
  view.rerender(<GameParticleField active />);
  expect(canvas.dataset.quality).toBe('low');
});

it('完成碎片有限、自然结束后清理；减少动态中断后不补播', () => {
  const view = render(<CompletionBurst enabled />);
  expect(view.container.querySelectorAll('i')).toHaveLength(24);
  fireEvent.animationEnd(view.container.querySelectorAll('i')[23]);
  expect(view.container.querySelectorAll('i')).toHaveLength(0);
  view.unmount();
  const interrupted = render(<CompletionBurst enabled />);
  act(() => {
    reduced = true;
    notifyPreference();
  });
  expect(interrupted.container.querySelectorAll('i')).toHaveLength(0);
  act(() => {
    reduced = false;
    notifyPreference();
  });
  expect(interrupted.container.querySelectorAll('i')).toHaveLength(0);
});
