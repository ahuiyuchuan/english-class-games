/** 手动读取公开发行信息；无账号、无教学数据、无后台轮询或安装副作用。 @author ahui */
export const UPDATE_SOURCES = {
  github: {
    label: 'GitHub',
    repository: 'https://github.com/ahuiyuchuan/english-class-games',
    endpoint: 'https://api.github.com/repos/ahuiyuchuan/english-class-games/releases/latest',
  },
} as const;

export interface UpdateResult {
  /** 无正式发行版时为空；只接受稳定的三段数字版本。 */
  latest: string | null;
  available: boolean;
}

/**
 * 将稳定版本转为可比较的数字段，避免 1.10.0 被按字符串排在 1.9.0 前面。
 * 允许 Git 标签常用的 v 前缀和不影响优先级的构建元数据；预发行版明确拒绝。
 */
function stableVersion(value: string): number[] {
  const match =
    /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
      value,
    );
  if (!match) throw new Error('发行版本号格式不受支持，请前往发行版本页面核对。');
  const parts = match.slice(1, 4).map(Number);
  if (!parts.every(Number.isSafeInteger)) throw new Error('发行版本号超出支持范围。');
  return parts;
}

/**
 * 用户点击后调用；15 秒超时包含响应体读取，失败允许重新检查。
 * 404 只表示公开 API 没有可用正式发行信息，不能据此断言当前已是最新版。
 * @param current 当前构建版本，要求为稳定语义版本。
 * @param signal 关于页卸载时中止请求；超时仍覆盖响应体读取。
 * @returns 最新正式版本及是否高于本机；不返回或执行远端下载地址。
 * @throws 网络、超时、限流、无效响应或版本格式错误。
 */
export async function checkForUpdates(
  current: string,
  signal?: AbortSignal,
): Promise<UpdateResult> {
  const installed = stableVersion(current);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) controller.abort();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(UPDATE_SOURCES.github.endpoint, {
      signal: controller.signal,
      headers: { Accept: 'application/vnd.github+json' },
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
    });
    if (response.status === 404) return { latest: null, available: false };
    if (response.status === 403 || response.status === 429)
      throw new Error('版本服务暂时限制请求，请稍后重试或前往发行版本页面查看。');
    if (!response.ok) throw new Error('版本服务暂不可用，请稍后重试。');
    const data: unknown = await response.json();
    if (
      !data ||
      typeof data !== 'object' ||
      !('tag_name' in data) ||
      typeof data.tag_name !== 'string' ||
      !('draft' in data) ||
      data.draft !== false ||
      !('prerelease' in data) ||
      data.prerelease !== false
    )
      throw new Error('发行信息格式不正确，请前往发行版本页面核对。');
    const latest = stableVersion(data.tag_name);
    const different = latest.findIndex((part, index) => part !== installed[index]);
    return {
      latest: data.tag_name.replace(/^v/, ''),
      available: different !== -1 && latest[different] > installed[different],
    };
  } catch (cause) {
    if (signal?.aborted) throw new DOMException('已取消检查更新。', 'AbortError');
    if (controller.signal.aborted) throw new Error('检查更新超时，请检查网络后重试。');
    if (cause instanceof TypeError)
      throw new Error('无法连接版本服务，请检查网络后重试，或前往发行版本页面查看。');
    throw cause;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}
