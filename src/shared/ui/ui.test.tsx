// @vitest-environment jsdom
/** 公共表单、确认与浮层的键盘回归；验证教师可操作的语义和生命周期。 @author ahui */
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Button, FeedbackProvider, Field, InputField, Modal, Notice, useFeedback } from './index';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** 不使用 Dialog.Trigger，复现平台通过列表按钮打开属性/任务浮层的用法。 */
function ModalExample() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>打开属性</Button>
      <Modal open={open} onOpenChange={setOpen} title="词条属性" description="修改仅影响当前词条。">
        <InputField label="英文" defaultValue="achievement" />
      </Modal>
    </>
  );
}

/** 保留确认结果用于检查取消/替换/卸载；通知不主动移动焦点。 */
function FeedbackExample({ onResult }: { onResult: (value: boolean) => void }) {
  const { confirm, notify } = useFeedback();
  return (
    <>
      <Button
        onClick={() => {
          void confirm({
            title: '删除课件',
            message: '删除后将从课件列表移除，已有导出文件仍可使用。',
            danger: true,
            confirmLabel: '删除',
          }).then(onResult);
        }}
      >
        请求删除
      </Button>
      <Button onClick={() => notify('已保存')}>显示通知</Button>
    </>
  );
}

/** 同时覆盖树内嵌套 Portal 与树外全局确认，不能依赖两个 Portal 的 DOM 顺序。 */
function NestedModalExample({ onResult }: { onResult: (value: boolean) => void }) {
  const [parentOpen, setParentOpen] = useState(false);
  const [childOpen, setChildOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setParentOpen(true)}>打开材料</Button>
      <Modal open={parentOpen} onOpenChange={setParentOpen} title="编辑材料">
        <InputField label="教师校对" defaultValue="保留本次修改" />
        <Button onClick={() => setChildOpen(true)}>切换材料</Button>
        <Modal
          open={childOpen}
          onOpenChange={setChildOpen}
          title="确认材料切换"
          footer={
            <Button data-modal-safe-action onClick={() => setChildOpen(false)}>
              保留材料
            </Button>
          }
        >
          <FeedbackExample onResult={onResult} />
        </Modal>
      </Modal>
    </>
  );
}

describe('公共字段语义', () => {
  it('说明不污染字段名称，支持聚焦、点击固定及 Esc 优先关闭', async () => {
    const user = userEvent.setup();
    render(
      <Modal open onOpenChange={() => {}} title="设置">
        <InputField label="轮数" help="每词完整练习的轮数。" defaultValue="2" />
      </Modal>,
    );
    expect(screen.getByRole('textbox', { name: '轮数' })).toHaveValue('2');
    const help = screen.getByRole('button', { name: '轮数说明' });
    await user.hover(help);
    expect(screen.getByRole('tooltip')).toHaveTextContent('每词完整练习的轮数。');
    await user.click(help);
    await user.hover(screen.getByRole('textbox', { name: '轮数' }));
    expect(help).toHaveAttribute('aria-expanded', 'true');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(help).toHaveFocus();
    await user.tab({ shift: true });
    await user.tab();
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    fireEvent.scroll(window);
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });
  it('错误提示默认播报，显式角色优先，普通说明不冒充警报', () => {
    render(
      <>
        <Notice tone="error">保存失败，请重试</Notice>
        <Notice tone="error" role="status">
          后台校验结果
        </Notice>
        <Notice>本地运行</Notice>
      </>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('保存失败，请重试');
    expect(screen.getByRole('status')).toHaveTextContent('后台校验结果');
    expect(screen.getAllByRole('alert')).toHaveLength(1);
  });
  it('单行 Enter 结束当前字段编辑，且不会误提交外层表单', async () => {
    const blur = vi.fn();
    const submit = vi.fn((event: React.FormEvent) => event.preventDefault());
    render(
      <form onSubmit={submit}>
        <InputField label="单元" defaultValue="Unit 1" onBlur={blur} />
        <button type="submit">保存表单</button>
      </form>,
    );
    const input = screen.getByRole('textbox', { name: '单元' });
    const user = userEvent.setup();
    await user.click(input);
    await user.keyboard('{Enter}');
    expect(input).not.toHaveFocus();
    expect(input).toHaveValue('Unit 1');
    expect(blur).toHaveBeenCalledOnce();
    expect(submit).not.toHaveBeenCalled();
  });

  it('输入法确认及调用方接管的 Enter 不结束编辑，多行 Enter 保持换行', async () => {
    const blur = vi.fn();
    render(
      <>
        <InputField label="材料名" onBlur={blur} />
        <InputField label="专用输入" onKeyDown={(event) => event.preventDefault()} />
        <Field label="阅读原文">
          <textarea />
        </Field>
      </>,
    );
    const composing = screen.getByRole('textbox', { name: '材料名' });
    composing.focus();
    fireEvent.keyDown(composing, { key: 'Enter', isComposing: true });
    expect(composing).toHaveFocus();
    expect(blur).not.toHaveBeenCalled();
    const intercepted = screen.getByRole('textbox', { name: '专用输入' });
    intercepted.focus();
    fireEvent.keyDown(intercepted, { key: 'Enter' });
    expect(intercepted).toHaveFocus();
    const multiline = screen.getByRole('textbox', { name: '阅读原文' });
    const user = userEvent.setup();
    await user.click(multiline);
    await user.type(multiline, 'first{Enter}second');
    expect(multiline).toHaveValue('first\nsecond');
    expect(multiline).toHaveFocus();
  });

  it('原生下拉与可见标签、提示及错误建立关联，不覆盖调用方已有说明', () => {
    render(
      <>
        <small id="external-help">当前只处理所选词条。</small>
        <Field label="词条类型" hint="短语会预留额外跟读空间。" error="请选择类型。">
          <select id="entry-type" aria-describedby="external-help" defaultValue="">
            <option value="">请选择</option>
            <option value="word">单词</option>
          </select>
        </Field>
      </>,
    );
    const control = screen.getByRole('combobox', { name: '词条类型' });
    expect(control).toBeInvalid();
    expect(control).toHaveAttribute('id', 'entry-type');
    expect(control).toHaveAccessibleDescription(
      '当前只处理所选词条。 短语会预留额外跟读空间。 请选择类型。',
    );
    expect(screen.getByLabelText('词条类型')).toBe(control);
  });

  it('文本输入保留显式标识与错误语义，修正错误不会丢失辅助说明', () => {
    const view = render(
      <InputField id="lesson-name" label="课件名" hint="最多80个字符。" error="名称不能为空。" />,
    );
    const input = screen.getByRole('textbox', { name: '课件名' });
    expect(input).toHaveAttribute('id', 'lesson-name');
    expect(input).toHaveAccessibleDescription('最多80个字符。 名称不能为空。');
    expect(input).toBeInvalid();
    view.rerender(<InputField id="lesson-name" label="课件名" hint="最多80个字符。" />);
    expect(input).not.toBeInvalid();
    expect(input).toHaveAccessibleDescription('最多80个字符。');
  });
});

describe('浮层与确认生命周期', () => {
  it('无Trigger浮层有描述，Esc关闭后恢复原按钮焦点', async () => {
    render(<ModalExample />);
    const opener = screen.getByRole('button', { name: '打开属性' });
    opener.focus();
    fireEvent.click(opener);
    const dialog = screen.getByRole('dialog', { name: '词条属性' });
    expect(dialog).toHaveAccessibleDescription('修改仅影响当前词条。');
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    fireEvent.keyDown(document.activeElement!, { key: 'Escape', code: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it('嵌套及全局确认均高于父层，逐层Esc保留输入并在最后释放背景锁', async () => {
    const result = vi.fn();
    const user = userEvent.setup();
    render(
      <FeedbackProvider>
        <NestedModalExample onResult={result} />
      </FeedbackProvider>,
    );
    const opener = screen.getByRole('button', { name: '打开材料' });
    await user.click(opener);
    const parent = screen.getByRole('dialog', { name: '编辑材料' });
    const switcher = screen.getByRole('button', { name: '切换材料' });
    await user.click(switcher);
    const child = screen.getByRole('dialog', { name: '确认材料切换' });
    expect(Number(child.style.zIndex)).toBeGreaterThan(Number(parent.style.zIndex));
    expect(screen.getByRole('button', { name: '保留材料' })).toHaveFocus();
    expect(document.body.style.pointerEvents).toBe('none');

    const globalOpener = screen.getByRole('button', { name: '请求删除' });
    await user.click(globalOpener);
    const global = screen.getByRole('dialog', { name: '删除课件' });
    expect(Number(global.style.zIndex)).toBeGreaterThan(Number(child.style.zIndex));
    expect(screen.getByRole('button', { name: '取消' })).toHaveFocus();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(result).toHaveBeenCalledWith(false));
    await waitFor(() => expect(globalOpener).toHaveFocus());
    expect(child).toBeInTheDocument();
    expect(parent).toBeInTheDocument();

    await user.keyboard('{Escape}');
    await waitFor(() => expect(child).not.toBeInTheDocument());
    await waitFor(() => expect(switcher).toHaveFocus());
    expect(screen.getByRole('textbox', { name: '教师校对' })).toHaveValue('保留本次修改');
    expect(document.body.style.pointerEvents).toBe('none');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(parent).not.toBeInTheDocument());
    await waitFor(() => expect(opener).toHaveFocus());
    expect(document.body.style.pointerEvents).toBe('');
    expect(document.body).not.toHaveAttribute('data-scroll-locked');
  });

  it('危险确认先聚焦取消，Esc按取消处理且返回发起按钮', async () => {
    const result = vi.fn();
    render(
      <FeedbackProvider>
        <FeedbackExample onResult={result} />
      </FeedbackProvider>,
    );
    const opener = screen.getByRole('button', { name: '请求删除' });
    opener.focus();
    fireEvent.click(opener);
    expect(screen.getByRole('button', { name: '取消' })).toHaveFocus();
    expect(screen.getByRole('dialog')).toHaveAccessibleDescription(
      '删除后将从课件列表移除，已有导出文件仍可使用。',
    );
    fireEvent.keyDown(document.activeElement!, { key: 'Escape', code: 'Escape' });
    await waitFor(() => expect(result).toHaveBeenCalledWith(false));
    await waitFor(() => expect(opener).toHaveFocus());
    expect(result).toHaveBeenCalledOnce();
  });

  it('关闭和卸载均完成未决确认，不留下永远等待的调用', async () => {
    const result = vi.fn();
    const view = render(
      <FeedbackProvider>
        <FeedbackExample onResult={result} />
      </FeedbackProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: '请求删除' }));
    fireEvent.click(screen.getByRole('button', { name: '关闭对话框' }));
    await waitFor(() => expect(result).toHaveBeenCalledTimes(1));
    expect(result).toHaveBeenLastCalledWith(false);
    fireEvent.click(screen.getByRole('button', { name: '请求删除' }));
    view.unmount();
    await act(async () => undefined);
    expect(result).toHaveBeenCalledTimes(2);
    expect(result).toHaveBeenLastCalledWith(false);
  });

  it('通知不抢焦点，新通知重新计时，卸载清理计时器', async () => {
    vi.useFakeTimers();
    const view = render(
      <FeedbackProvider>
        <FeedbackExample onResult={vi.fn()} />
      </FeedbackProvider>,
    );
    const button = screen.getByRole('button', { name: '显示通知' });
    button.focus();
    fireEvent.click(button);
    expect(button).toHaveFocus();
    expect(screen.getByRole('status')).toHaveTextContent('已保存');
    act(() => vi.advanceTimersByTime(3000));
    fireEvent.click(button);
    act(() => vi.advanceTimersByTime(1500));
    expect(screen.getByRole('status')).toHaveTextContent('已保存');
    act(() => vi.advanceTimersByTime(2500));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    fireEvent.click(button);
    const clear = vi.spyOn(globalThis, 'clearTimeout');
    view.unmount();
    expect(clear).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
