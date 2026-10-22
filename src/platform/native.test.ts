/** IPC 代次保护回归：模拟传输边界，不将其计作 Windows 实机验证。 @author ahui */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ipc = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: ipc.invoke }));

beforeEach(() => {
  vi.resetModules();
  ipc.invoke.mockReset();
  vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
});
afterEach(() => vi.unstubAllGlobals());

describe('原生适配的数据代次', () => {
  it('并发初始化共用真实 getter，读取与写入固定同一代次', async () => {
    ipc.invoke.mockImplementation(async (command: string) =>
      command === 'get_data_epoch' ? 123_456_789 : [],
    );
    const native = await import('./native');
    await Promise.all([native.listLessons(), native.listAssets()]);
    await native.deleteLesson('lesson');
    expect(ipc.invoke.mock.calls.filter(([command]) => command === 'get_data_epoch')).toHaveLength(
      1,
    );
    expect(ipc.invoke).toHaveBeenCalledWith('list_lessons', { dataEpoch: 123_456_789 });
    expect(ipc.invoke).toHaveBeenCalledWith('delete_lesson', {
      lessonId: 'lesson',
      dataEpoch: 123_456_789,
    });
  });

  it('恢复后保留旧代次并返回原错误，后续旧页写入不能偷偷获得新授权', async () => {
    const rejected = {
      code: 'DATA_REPLACED',
      message: '数据已恢复，请重新载入。',
      retryable: false,
    };
    ipc.invoke.mockImplementation(async (command: string) => {
      if (command === 'get_data_epoch') return 73;
      if (command === 'save_lesson') throw rejected;
      return [];
    });
    const native = await import('./native');
    await native.listLessons();
    const document = { id: 'same-object', revision: 1 } as Parameters<typeof native.saveLesson>[0];
    await expect(native.saveLesson(document, 1)).rejects.toBe(rejected);
    await expect(native.saveLesson(document, 1)).rejects.toBe(rejected);
    expect(ipc.invoke.mock.calls.filter(([command]) => command === 'get_data_epoch')).toHaveLength(
      1,
    );
    const writes = ipc.invoke.mock.calls.filter(([command]) => command === 'save_lesson');
    expect(writes.map(([, args]) => args.dataEpoch)).toEqual([73, 73]);
  });

  it('首次 getter 暂时失败可重试，首次未取得代次时不发送业务写入', async () => {
    ipc.invoke.mockRejectedValueOnce(new Error('startup transport failure'));
    const native = await import('./native');
    await expect(native.deleteLesson('lesson')).rejects.toMatchObject({ code: 'NATIVE_ERROR' });
    expect(ipc.invoke.mock.calls.map(([command]) => command)).toEqual(['get_data_epoch']);
    ipc.invoke.mockImplementation(async (command: string) =>
      command === 'get_data_epoch' ? 91 : null,
    );
    await native.deleteLesson('lesson');
    expect(ipc.invoke).toHaveBeenLastCalledWith('delete_lesson', {
      lessonId: 'lesson',
      dataEpoch: 91,
    });
  });

  it('普通浏览器不调用原生服务或伪造操作成功', async () => {
    vi.stubGlobal('window', {});
    const native = await import('./native');
    await expect(native.deleteLesson('lesson')).rejects.toMatchObject({
      code: 'NATIVE_UNAVAILABLE',
    });
    expect(ipc.invoke).not.toHaveBeenCalled();
  });
});
