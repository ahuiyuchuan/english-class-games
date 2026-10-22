/**
 * 显式提交表单的离开保护。仅在离开会丢失未提交输入时询问，自动保存页面不使用此钩子。
 * @author ahui
 */
import { useCallback, useEffect, useRef } from 'react';
import { useFeedback } from './index';

/**
 * 返回稳定的异步离开检查；调用方收到 true 后才关闭表单或切换页面。
 * @param state dirty 表示当前表单有未提交修改；busy 表示保存或应用尚未结束；
 * subject 是教师可读的修改对象，不能包含内部标识或敏感数据。
 * @returns 检查函数。未修改时直接允许；处理中或取消确认时拒绝；重复关闭共用一次确认。
 */
export function useDiscardGuard(state: { dirty: boolean; busy?: boolean; subject: string }) {
  const { confirm } = useFeedback();
  const latest = useRef(state);
  latest.current = state;
  const pending = useRef<Promise<boolean> | null>(null);
  useEffect(() => {
    if (!state.dirty && !state.busy) return;
    // 浏览器刷新无法等待自定义异步对话框，由浏览器提供最后一道离开提示。
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [state.dirty, state.busy]);

  return useCallback((): Promise<boolean> => {
    if (latest.current.busy) return Promise.resolve(false);
    if (pending.current) return pending.current;
    if (!latest.current.dirty) return Promise.resolve(true);
    // 关闭按钮、Esc 和页面导航可能在同一帧到达，必须共享确认，避免后一个确认取消前一个。
    pending.current = confirm({
      title: '未保存的修改',
      message: `${latest.current.subject}尚未应用。放弃后将丢失这些修改。`,
      confirmLabel: '放弃修改',
      cancelLabel: '继续编辑',
    })
      .then((accepted) => accepted && !latest.current.busy)
      .finally(() => {
        pending.current = null;
      });
    return pending.current;
  }, [confirm]);
}
