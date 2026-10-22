// @vitest-environment jsdom
/**
 * 显式保存表单的离开边界回归。使用真实确认组件验证重复关闭、处理中保护与浏览器离开提示，
 * 不把浏览器模拟事件当作原生窗口关闭或磁盘保存验收。
 * @author ahui
 */
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, renderHook, screen, within } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { FeedbackProvider } from './index';
import { useDiscardGuard } from './useDiscardGuard';

afterEach(cleanup);

function Wrapper({ children }: PropsWithChildren) {
  return <FeedbackProvider>{children}</FeedbackProvider>;
}

describe('未提交表单离开保护', () => {
  it('无修改直接允许，处理中拒绝关闭，浏览器提示随状态移除', async () => {
    const { result, rerender, unmount } = renderHook(
      (state) => useDiscardGuard({ ...state, subject: '教学材料' }),
      { initialProps: { dirty: false, busy: false }, wrapper: Wrapper },
    );
    expect(await result.current()).toBe(true);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    rerender({ dirty: false, busy: true });
    expect(await result.current()).toBe(false);
    const busyUnload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(busyUnload);
    expect(busyUnload.defaultPrevented).toBe(true);
    rerender({ dirty: false, busy: false });
    const cleanUnload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(cleanUnload);
    expect(cleanUnload.defaultPrevented).toBe(false);
    rerender({ dirty: true, busy: false });
    unmount();
    const releasedUnload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(releasedUnload);
    expect(releasedUnload.defaultPrevented).toBe(false);
  });

  it('同一帧重复关闭只显示一次确认，继续编辑与放弃有独立结果', async () => {
    const { result } = renderHook(() => useDiscardGuard({ dirty: true, subject: '导入材料' }), {
      wrapper: Wrapper,
    });
    let first!: Promise<boolean>;
    let repeated!: Promise<boolean>;
    act(() => {
      first = result.current();
      repeated = result.current();
    });
    expect(first).toBe(repeated);
    const dialog = screen.getByRole('dialog', { name: '未保存的修改' });
    expect(dialog).toHaveTextContent('导入材料尚未应用');
    expect(within(dialog).getByRole('button', { name: '继续编辑' })).toHaveFocus();
    fireEvent.click(within(dialog).getByRole('button', { name: '继续编辑' }));
    expect(await first).toBe(false);
    let discard!: Promise<boolean>;
    act(() => {
      discard = result.current();
    });
    fireEvent.click(screen.getByRole('button', { name: '放弃修改' }));
    expect(await discard).toBe(true);
  });

  it('确认显示后开始保存，先前的放弃不能关闭仍在提交的表单', async () => {
    const { result, rerender } = renderHook(
      (state) => useDiscardGuard({ ...state, subject: '课件名称' }),
      { initialProps: { dirty: true, busy: false }, wrapper: Wrapper },
    );
    let pending!: Promise<boolean>;
    act(() => {
      pending = result.current();
    });
    rerender({ dirty: true, busy: true });
    fireEvent.click(screen.getByRole('button', { name: '放弃修改' }));
    expect(await pending).toBe(false);
    expect(await result.current()).toBe(false);
  });
});
