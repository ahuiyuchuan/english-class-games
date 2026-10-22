// @vitest-environment jsdom
/** 验证保存竞争、失败恢复与撤销素材生命周期，避免教师输入被旧回包覆盖。 @author ahui */
import type { ReactNode } from 'react';
import { act, cleanup, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WordBeatLesson } from '../games/word-beat/model';
import { createWordBeatLesson, getEntries } from '../games/word-beat/rules';
import { useEditor } from './useEditor';

const api = vi.hoisted(() => ({ save: vi.fn(), retain: vi.fn(), release: vi.fn() }));
vi.mock('../platform/repository', () => ({ desktopAvailable: true, saveLesson: api.save }));
vi.mock('../platform/native', () => ({ retainAssets: api.retain, releaseAssets: api.release }));

/** 手工结束一次受控IO，精确验证保存期间发生的新编辑。 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

/** 各用例使用独立查询缓存，不让异步失效刷新泄漏到其他编辑会话。 */
function setup() {
  const initial = createWordBeatLesson(
    [{ id: crypto.randomUUID(), english: 'achievement', meaning: '成就', priority: false }],
    { soundMode: 'teacher' },
  );
  initial.revision = 1;
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { initial, ...renderHook(() => useEditor(initial), { wrapper }) };
}

beforeEach(() => {
  vi.useFakeTimers();
  api.save.mockReset().mockImplementation(async (document: WordBeatLesson, expected: number) => ({
    ...structuredClone(document),
    revision: expected + 1,
    updatedAt: new Date().toISOString(),
  }));
  api.retain.mockReset().mockResolvedValue(undefined);
  api.release.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe('编辑保存与教师输入保护', () => {
  it('合并并发flush，先保存的旧回包不覆盖期间修改，第二次使用新CAS修订', async () => {
    const first = deferred<WordBeatLesson>();
    api.save.mockImplementationOnce(() => first.promise);
    const { result } = setup();
    act(() => result.current.edit((previous) => ({ ...previous, name: '第一份输入' })));
    let draining!: Promise<WordBeatLesson>;
    await act(async () => {
      draining = result.current.flush();
      expect(result.current.flush()).toBe(draining);
    });
    expect(api.save).toHaveBeenCalledTimes(1);
    const firstSnapshot = api.save.mock.calls[0][0] as WordBeatLesson;
    act(() => result.current.edit((previous) => ({ ...previous, name: '保存中的新输入' })));
    await act(async () => {
      first.resolve({ ...firstSnapshot, revision: 2 });
      await draining;
    });
    expect(api.save).toHaveBeenCalledTimes(2);
    expect(api.save.mock.calls.map((call) => call[1])).toEqual([1, 2]);
    expect(api.save.mock.calls[1][0].name).toBe('保存中的新输入');
    expect(result.current.lesson.name).toBe('保存中的新输入');
    expect(result.current.lesson.revision).toBe(3);
    expect(result.current.saveState).toBe('saved');
  });

  it('素材引用失败时保留输入，重试重建引用后才能保存', async () => {
    const { result } = setup();
    await act(async () => {
      await Promise.resolve();
    });
    api.retain.mockRejectedValue(new Error('引用服务暂不可用'));
    act(() => result.current.edit((previous) => ({ ...previous, name: '必须保留' })));
    await act(async () => {
      await expect(result.current.flush()).rejects.toThrow('引用服务暂不可用');
    });
    expect(api.save).not.toHaveBeenCalled();
    expect(result.current.saveState).toBe('error');
    api.retain.mockResolvedValue(undefined);
    await act(async () => {
      await result.current.flush();
    });
    expect(result.current.lesson.name).toBe('必须保留');
    expect(result.current.saveState).toBe('saved');
    expect(api.retain.mock.calls.every((call) => /^[0-9a-f-]{36}$/u.test(call[0]))).toBe(true);
  });

  it('保存失败后不推进修订，显式重试仍提交原预期版本及全部输入', async () => {
    api.save.mockRejectedValueOnce(new Error('磁盘暂时不可写'));
    const { result } = setup();
    act(() => result.current.edit((previous) => ({ ...previous, name: '未丢失的草稿' })));
    await act(async () => {
      await expect(result.current.flush()).rejects.toThrow('磁盘暂时不可写');
    });
    expect(result.current.lesson.revision).toBe(1);
    expect(result.current.saveError).toContain('磁盘暂时不可写');
    await act(async () => {
      await result.current.flush();
    });
    expect(api.save.mock.calls.map((call) => call[1])).toEqual([1, 1]);
    expect(result.current.lesson.name).toBe('未丢失的草稿');
  });

  it('修订冲突保留输入及未保存状态，后续输入、撤销、计时和显式保存均不盲目重试', async () => {
    const conflict = Object.assign(new Error('课件已有更新'), { code: 'REVISION_CONFLICT' });
    api.save.mockRejectedValue(conflict);
    const { result } = setup();
    act(() => result.current.edit((previous) => ({ ...previous, name: '本地输入' })));
    await act(async () => {
      await expect(result.current.flush()).rejects.toBe(conflict);
    });
    expect(result.current.saveConflict).toBe(true);
    expect(result.current.lesson.name).toBe('本地输入');
    act(() => result.current.edit((previous) => ({ ...previous, name: '冲突后继续编辑' })));
    act(() => result.current.undo());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
      await expect(result.current.flush()).rejects.toBe(conflict);
    });
    expect(api.save).toHaveBeenCalledTimes(1);
    expect(result.current.lesson.name).toBe('本地输入');
    expect(result.current.saveState).toBe('error');
    const unloading = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unloading);
    expect(unloading.defaultPrevented).toBe(true);
  });

  it('明确接受已保存版本后重建基线与撤销栈，下一次保存使用真实新修订', async () => {
    const { result } = setup();
    act(() => result.current.edit((previous) => ({ ...previous, name: '本地旧输入' })));
    const expected = structuredClone(result.current.lesson);
    const saved = { ...structuredClone(expected), name: '服务器新版本', revision: 12 };
    act(() => result.current.replaceWithSaved(saved, expected));
    expect(result.current.saveState).toBe('saved');
    expect(result.current.canUndo).toBe(false);
    act(() => result.current.undo());
    expect(result.current.lesson.name).toBe('服务器新版本');
    act(() => result.current.edit((previous) => ({ ...previous, name: '新基线的修改' })));
    await act(async () => {
      await result.current.flush();
    });
    expect(api.save.mock.calls[0][1]).toBe(12);
    expect(result.current.lesson.revision).toBe(13);
  });

  it('重载或另存等待期间的新输入不能被稍早捕获的结果替换', () => {
    const { result } = setup();
    const expected = structuredClone(result.current.lesson);
    act(() => result.current.edit((previous) => ({ ...previous, name: '异步期间的新输入' })));
    expect(() => result.current.replaceWithSaved({ ...expected, revision: 9 }, expected)).toThrow(
      '当前输入已保留',
    );
    expect(result.current.lesson.name).toBe('异步期间的新输入');
    expect(result.current.saveState).toBe('saving');
  });

  it('准备回调只接受本课合法且不倒退的保存修订，不改写本地输入', () => {
    const { result, initial } = setup();
    act(() => result.current.acceptPrepared(1, crypto.randomUUID()));
    expect(result.current.lesson.preparedRevision).toBe(initial.preparedRevision);

    const saved = { ...structuredClone(initial), revision: 5, preparedRevision: 4 };
    act(() => result.current.replaceWithSaved(saved, initial));
    act(() => result.current.edit((previous) => ({ ...previous, name: '仍未保存的新输入' })));
    for (const revision of [0, -1, 1.5, Number.NaN, 3, 6]) {
      act(() => result.current.acceptPrepared(revision, initial.id));
      expect(result.current.lesson.preparedRevision).toBe(4);
    }
    act(() => result.current.acceptPrepared(5, initial.id));
    expect(result.current.lesson.preparedRevision).toBe(5);
    expect(result.current.lesson.name).toBe('仍未保存的新输入');
    expect(result.current.saveState).toBe('saving');
    expect(result.current.canUndo).toBe(true);
  });

  it('同一字段连续编辑跨自动保存仍只算一次撤销，离开字段后开始下一次', async () => {
    const { result, initial } = setup();
    const input = document.createElement('input');
    document.body.append(input);
    input.focus();
    act(() => result.current.edit((previous) => ({ ...previous, name: '输入一' })));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    act(() => result.current.edit((previous) => ({ ...previous, name: '输入二' })));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    input.blur();
    act(() => result.current.undo());
    expect(result.current.lesson.name).toBe(initial.name);
    expect(result.current.canUndo).toBe(false);
    act(() => result.current.redo());
    expect(result.current.lesson.name).toBe('输入二');
  });

  it('后台制作完成独立于当前输入分组，撤销结果后继续保留教师正在输入的文字', () => {
    const { result, initial } = setup();
    const input = document.createElement('input');
    document.body.append(input);
    input.focus();
    act(() => result.current.edit((previous) => ({ ...previous, name: '教师未离开字段' })));
    act(() =>
      result.current.edit((previous) => {
        getEntries(previous)[0].meaning = '后台结果';
        return previous;
      }, 'separate'),
    );
    act(() => result.current.edit((previous) => ({ ...previous, name: '教师继续输入' })));
    input.blur();
    act(() => result.current.undo());
    expect(result.current.lesson.name).toBe('教师未离开字段');
    expect(getEntries(result.current.lesson)[0].meaning).toBe('后台结果');
    act(() => result.current.undo());
    expect(result.current.lesson.name).toBe('教师未离开字段');
    expect(getEntries(result.current.lesson)[0].meaning).toBe('成就');
    act(() => result.current.undo());
    expect(result.current.lesson.name).toBe(initial.name);
  });

  it('多行换行不拆分连续编辑，一次撤销恢复完整字段', () => {
    const { result, initial } = setup();
    const textarea = document.createElement('textarea');
    document.body.append(textarea);
    textarea.focus();
    act(() => result.current.edit((previous) => ({ ...previous, name: '第一行' })));
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    act(() => result.current.edit((previous) => ({ ...previous, name: '第一行\n第二行' })));
    textarea.blur();
    act(() => result.current.undo());
    expect(result.current.lesson.name).toBe(initial.name);
    expect(result.current.canUndo).toBe(false);
    act(() => result.current.redo());
    expect(result.current.lesson.name).toBe('第一行\n第二行');
  });

  it('单行输入法确认不结束编辑，普通 Enter 明确开始下次编辑分组', () => {
    const { result, initial } = setup();
    const input = document.createElement('input');
    document.body.append(input);
    input.focus();
    act(() => result.current.edit((previous) => ({ ...previous, name: '输入法选词前' })));
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: true }),
    );
    act(() => result.current.edit((previous) => ({ ...previous, name: '输入法选词后' })));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    act(() => result.current.edit((previous) => ({ ...previous, name: '下一次字段编辑' })));
    input.blur();
    act(() => result.current.undo());
    expect(result.current.lesson.name).toBe('输入法选词后');
    act(() => result.current.undo());
    expect(result.current.lesson.name).toBe(initial.name);
    expect(result.current.canUndo).toBe(false);
  });

  it('保存采用仓库权威已准备指针，不沿用打开编辑时的旧指针', async () => {
    api.save.mockImplementationOnce(async (document: WordBeatLesson, expected: number) => ({
      ...document,
      revision: expected + 1,
      preparedRevision: 1,
    }));
    const { result } = setup();
    act(() => result.current.edit((previous) => ({ ...previous, name: '后台已准备后的编辑' })));
    await act(async () => {
      await result.current.flush();
    });
    expect(result.current.lesson.preparedRevision).toBe(1);
    expect(result.current.lesson.name).toBe('后台已准备后的编辑');
  });

  it('删除词条仍为撤销保留关闭的旧声音，会话结束才释放owner', async () => {
    const { result, initial, unmount } = setup();
    const oldAsset = crypto.randomUUID();
    act(() =>
      result.current.edit((previous) => {
        getEntries(previous)[0].audio = {
          source: 'recording',
          status: 'stale',
          assetId: oldAsset,
          text: 'old',
          language: 'en-US',
          rate: 1,
        };
        return previous;
      }),
    );
    act(() =>
      result.current.edit((previous) => {
        previous.gameData.segments[0].entries = [];
        return previous;
      }),
    );
    await act(async () => {
      await result.current.flush();
    });
    expect(api.retain.mock.calls.at(-1)?.[1]).toContain(oldAsset);
    expect(api.retain.mock.calls.at(-1)?.[2]).toBe(initial.id);
    const owner = api.retain.mock.calls.at(-1)?.[0];
    unmount();
    await act(async () => {
      await Promise.resolve();
    });
    expect(api.release).toHaveBeenCalledWith(owner);
  });

  it('整次编辑校验失败不产生撤销记录或改变内容', () => {
    const { result, initial } = setup();
    expect(() =>
      act(() =>
        result.current.edit(() => {
          throw new Error('整批不合法');
        }),
      ),
    ).toThrow('整批不合法');
    expect(result.current.lesson).toEqual(initial);
    expect(result.current.canUndo).toBe(false);
  });
});
