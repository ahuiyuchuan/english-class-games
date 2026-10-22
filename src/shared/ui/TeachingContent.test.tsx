// @vitest-environment jsdom
/**
 * 教学文字区域的边界与生命周期回归。jsdom 不提供真实排版，因此仅替换尺寸读取，
 * 检查组件确实使用自身容器、先压缩留白、保持固定档位与完整原文；实际排版另由浏览器验证。
 * @author ahui
 */
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TeachingContent } from './TeachingContent';

interface Layout {
  width: number;
  height: number;
  compactGain: number;
  textHeight: (wordSize: number, meaningSize: number) => number;
}

let layout: Layout;
let observedResize: (() => void) | undefined;
let disconnected: ReturnType<typeof vi.fn>;
let animationFrames: FrameRequestCallback[];

/** 模拟布局引擎对容器和已换行文字的测量结果，不依赖窗口尺寸或组件内部循环次数。 */
beforeEach(() => {
  layout = { width: 1200, height: 700, compactGain: 40, textHeight: () => 200 };
  animationFrames = [];
  disconnected = vi.fn();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        observedResize = callback;
      }
      observe() {}
      disconnect() {
        disconnected();
      }
    },
  );
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    animationFrames.push(callback);
    return animationFrames.length;
  });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function () {
    return layout.width;
  });
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return (
      layout.height +
      (this.classList.contains('teaching-content') && this.dataset.compact === 'true'
        ? layout.compactGain
        : 0)
    );
  });
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(() => layout.width);
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    const region = this.closest<HTMLElement>('.teaching-content');
    return layout.textHeight(
      Number.parseInt(region?.style.getPropertyValue('--teaching-word-size') || '144', 10),
      Number.parseInt(region?.style.getPropertyValue('--teaching-meaning-size') || '64', 10),
    );
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  observedResize = undefined;
});

/** 舞台提供可用空间和装饰；组件不得改变舞台外的教师控制。 */
function mount(english = 'achievement', meaning?: string) {
  return render(
    <main>
      <TeachingContent english={english} meaning={meaning} />
      <button>下一词</button>
    </main>,
  );
}

describe('共享教学文字适配', () => {
  it('最大档换行后能够完整显示时不压缩留白，不增加多余键盘入口', () => {
    mount('take part in', '参加');
    const region = screen.getByRole('region', { name: '教学内容' });
    expect(region).toHaveAttribute('data-compact', 'false');
    expect(region).toHaveAttribute('data-overflow', 'false');
    expect(region.style.getPropertyValue('--teaching-word-size')).toBe('144px');
    expect(region.style.getPropertyValue('--teaching-meaning-size')).toBe('64px');
    expect(region.tabIndex).toBe(-1);
    expect(screen.getByRole('heading', { name: 'take part in' })).toBeVisible();
  });

  it('真实高度不足时先压缩装饰留白，能够容纳最大档就不降字号', () => {
    layout.height = 220;
    layout.textHeight = () => 250;
    mount();
    const region = screen.getByRole('region', { name: '教学内容' });
    expect(region).toHaveAttribute('data-compact', 'true');
    expect(region.style.getPropertyValue('--teaching-word-size')).toBe('144px');
    expect(region).toHaveAttribute('data-overflow', 'false');
  });

  it('只读取自身容器，在相同大窗口内仍可为窄预览选择较小档位', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1920 });
    layout.width = 300;
    layout.height = 200;
    layout.compactGain = 0;
    layout.textHeight = (wordSize) => (wordSize <= 48 ? 180 : 300);
    mount('responsibility');
    expect(
      screen
        .getByRole('region', { name: '教学内容' })
        .style.getPropertyValue('--teaching-word-size'),
    ).toBe('48px');
  });

  it('英文和中文共同降档，不为保留最大英文把释义先降为最小', () => {
    layout.height = 220;
    layout.compactGain = 0;
    layout.textHeight = (wordSize, meaningSize) => wordSize * 1.15 + meaningSize * 1.3;
    mount('achievement', '成就');
    const region = screen.getByRole('region', { name: '教学内容' });
    expect(region.style.getPropertyValue('--teaching-word-size')).toBe('128px');
    expect(region.style.getPropertyValue('--teaching-meaning-size')).toBe('56px');
  });

  it('正常宽高不使用窄区档位，最低档仍放不下时完整保留原文并允许纵向滚动', () => {
    layout.textHeight = () => 1000;
    const english = 'x'.repeat(120);
    const meaning = '长教学释义'.repeat(40);
    mount(english, meaning);
    const region = screen.getByRole('region', { name: '教学内容，可纵向滚动查看全文' });
    expect(region.style.getPropertyValue('--teaching-word-size')).toBe('64px');
    expect(region.style.getPropertyValue('--teaching-meaning-size')).toBe('32px');
    expect(region).toHaveAttribute('data-overflow', 'true');
    expect(region.tabIndex).toBe(0);
    expect(screen.getByRole('heading', { name: english })).toHaveTextContent(english);
    expect(screen.getByText(meaning, { exact: true })).toBeVisible();
    expect(screen.getByRole('button', { name: '下一词' })).toBeEnabled();
  });

  it('窄区使用规定的最低档，切换教学内容后恢复最大档并重置本区滚动位置', () => {
    layout.width = 300;
    layout.height = 180;
    layout.textHeight = () => 900;
    const view = mount('x'.repeat(120), '较长释义');
    const region = screen.getByRole('region', { name: '教学内容，可纵向滚动查看全文' });
    expect(region.style.getPropertyValue('--teaching-word-size')).toBe('40px');
    expect(region.style.getPropertyValue('--teaching-meaning-size')).toBe('24px');
    region.scrollTop = 200;
    layout.textHeight = () => 100;
    view.rerender(
      <main>
        <TeachingContent english="word" />
        <button>下一词</button>
      </main>,
    );
    expect(region.scrollTop).toBe(0);
    expect(region.style.getPropertyValue('--teaching-word-size')).toBe('144px');
    expect(region).toHaveAttribute('data-overflow', 'false');
    expect(screen.queryByText('较长释义')).not.toBeInTheDocument();
  });

  it('隐藏预览等待真实尺寸，显示或容器改变时重测，卸载释放观察器', () => {
    layout.width = 0;
    layout.height = 0;
    const view = mount();
    const region = screen.getByRole('region', { name: '教学内容' });
    expect(region.style.getPropertyValue('--teaching-word-size')).toBe('');
    layout.width = 600;
    layout.height = 400;
    act(() => {
      observedResize?.();
      animationFrames.shift()?.(0);
    });
    expect(region.style.getPropertyValue('--teaching-word-size')).toBe('144px');
    layout.width = 300;
    layout.height = 200;
    layout.textHeight = (wordSize) => (wordSize <= 48 ? 200 : 500);
    act(() => {
      observedResize?.();
      animationFrames.shift()?.(0);
    });
    expect(region.style.getPropertyValue('--teaching-word-size')).toBe('48px');
    view.unmount();
    expect(disconnected).toHaveBeenCalledOnce();
  });
});
