/** 版本检查的数字排序、失败语义和网络隐私边界回归。 @author ahui */
import { afterEach, expect, it, vi } from 'vitest';
import { checkForUpdates } from './updates';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** 构造 GitHub 正式发行响应，不访问真实网络。 */
function release(tag: string, status = 200) {
  const fetchMock = vi.fn().mockImplementation(
    async () =>
      new Response(JSON.stringify({ tag_name: tag, draft: false, prerelease: false }), {
        status,
      }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

it('按数字比较稳定版本，兼容 v 前缀及构建元数据', async () => {
  const fetchMock = release('v1.10.0+build.1');
  expect(await checkForUpdates('1.9.0')).toEqual({ latest: '1.10.0+build.1', available: true });
  expect(fetchMock).toHaveBeenCalledWith(
    'https://api.github.com/repos/ahuiyuchuan/english-class-games/releases/latest',
    expect.objectContaining({
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
    }),
  );
  expect((await checkForUpdates('1.10.0')).available).toBe(false);
  expect((await checkForUpdates('2.0.0')).available).toBe(false);
});

it('无发行信息不冒充最新版，限流可重试', async () => {
  release('1.0.0', 404);
  expect(await checkForUpdates('1.0.0')).toEqual({ latest: null, available: false });
  release('1.0.0', 403);
  await expect(checkForUpdates('1.0.0')).rejects.toThrow('限制请求');
});

it('拒绝不规范、预发行和不完整响应', async () => {
  for (const tag of ['1.01.0', '1.2.0-rc.1', 'not-a-version', '9007199254740992.0.0']) {
    release(tag);
    await expect(checkForUpdates('1.0.0')).rejects.toThrow();
  }
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}')));
  await expect(checkForUpdates('1.0.0')).rejects.toThrow('格式不正确');
});

it('网络错误明确提示，15 秒超时中断请求', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
  await expect(checkForUpdates('1.0.0')).rejects.toThrow('无法连接');
  vi.useFakeTimers();
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (_url, options: RequestInit) =>
        new Promise((_resolve, reject) => {
          options.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    ),
  );
  const pending = expect(checkForUpdates('1.0.0')).rejects.toThrow('超时');
  await vi.advanceTimersByTimeAsync(15_000);
  await pending;
});

it('离页取消与15秒超时分开处理，清理计时器', async () => {
  vi.useFakeTimers();
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (_url, options: RequestInit) =>
        new Promise((_resolve, reject) => {
          options.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    ),
  );
  const controller = new AbortController();
  const pending = expect(checkForUpdates('1.0.0', controller.signal)).rejects.toMatchObject({
    name: 'AbortError',
  });
  controller.abort();
  await pending;
  expect(vi.getTimerCount()).toBe(0);
});
