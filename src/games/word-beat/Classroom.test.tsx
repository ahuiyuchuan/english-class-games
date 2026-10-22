// @vitest-environment jsdom
/** 真实课堂组件交互回归；声音驱动只替代设备，保留真实状态机。 @author ahui */
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssetMap } from '../../platform/types';
import type { RuntimeCue, RuntimeTimeline } from '../../runtime/types';
import { WordBeatClassroom } from './Classroom';
import { bindRecording, compileWordBeat, createWordBeatLesson, getEntries } from './rules';
import type { WordBeatCueData } from './timeline';

const harness = vi.hoisted(() => ({
  now: 0,
  failNext: false,
  prepared: true,
  prepareOnce: null as (() => Promise<void>) | null,
  frame: null as FrameRequestCallback | null,
  sessions: [] as {
    prepare: ReturnType<typeof vi.fn>;
    play: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
    pause: ReturnType<typeof vi.fn>;
    setVolumes: ReturnType<typeof vi.fn>;
  }[],
}));

vi.mock('../../runtime/audio', () => ({
  WebAudioSession: class {
    constructor() {
      harness.sessions.push(this);
    }
    now = () => harness.now;
    isPrepared = () => harness.prepared;
    prepare = vi.fn(async (_timeline: RuntimeTimeline<WordBeatCueData>, _index: number) => {
      const pending = harness.prepareOnce;
      harness.prepareOnce = null;
      if (pending) await pending();
      if (harness.failNext) {
        harness.failNext = false;
        throw new Error('声音设备暂时不可用');
      }
    });
    play = vi.fn((_cue: RuntimeCue<WordBeatCueData>, _offset: number) => undefined);
    pause = vi.fn();
    stop = vi.fn();
    tick = vi.fn();
    dispose = vi.fn();
    setVolumes = vi.fn();
  },
}));

/** 默认仍走正式新课配置；只有等待教师的用例才显式指定step。 */
function lesson(progression?: 'auto' | 'step') {
  const result = createWordBeatLesson(
    [
      { id: 'a', english: 'photosynthesis', meaning: '光合作用', priority: false },
      { id: 'b', english: 'sustainable development', meaning: '可持续发展', priority: true },
    ],
    { soundMode: 'teacher', seed: 1, progression },
  );
  Object.values(result.gameData.slogans).forEach((item) => {
    item.enabled = false;
  });
  // Existing classroom fixtures retain their original 2/3-round settings.
  getEntries(result).forEach((entry) => {
    entry.rounds.value = entry.priority ? 3 : 2;
  });
  return result;
}

/** 正式绑定每个词的独立录音，验证课堂改字不会借旧音或改写传入素材。 */
function withEntryRecordings(current: ReturnType<typeof lesson>) {
  const assets: AssetMap = {};
  let playable = current;
  for (const entry of getEntries(current)) {
    const asset = {
      assetId: `classroom-word-${entry.id}`,
      mimeType: 'audio/wav',
      durationMs: 900,
      byteLength: 44,
      sha256: 'a'.repeat(64),
    };
    assets[asset.assetId] = asset;
    playable = bindRecording(playable, entry.id, asset);
  }
  return { playable, assets };
}

async function click(name: string) {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name }));
  });
}

/** 用正式词表中的稳定 ID 点击选项，改词后也不会因显示名称改变而选错条目。 */
function wordOption(id: string) {
  const option = within(screen.getByRole('listbox', { name: '选择要调整的词' }))
    .getAllByRole('option')
    .find((item) => item.getAttribute('data-entry-id') === id);
  if (!option) throw new Error(`课堂词表中找不到条目：${id}`);
  return option;
}

/** 选词不通过组件内部状态或原生 select 注入，保留真实列表点击路径。 */
async function selectWord(id: string) {
  await act(async () => fireEvent.click(wordOption(id)));
}

/** 模拟设备时钟前进，再触发16ms音频时钟轮询；装饰rAF不负责推进课堂。 */
async function advance(milliseconds: number) {
  harness.now += milliseconds;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(16);
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  harness.now = 0;
  harness.failNext = false;
  harness.prepared = true;
  harness.prepareOnce = null;
  harness.sessions.length = 0;
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn((callback: FrameRequestCallback) => {
      harness.frame = callback;
      return 1;
    }),
  );
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('课堂通知与真实状态隔离', () => {
  it('重新打开真实保存的设置后恢复提示四秒收起，不改已保存设置或阻止开始', async () => {
    const current = lesson();
    const view = render(<WordBeatClassroom lesson={current} assets={{}} />);
    await click('课堂设置');
    fireEvent.change(screen.getByRole('spinbutton', { name: '节拍音量百分比' }), {
      target: { value: '35' },
    });
    await click('完成设置');
    const key = localStorage.key(0)!;
    const saved = localStorage.getItem(key);
    view.unmount();
    render(<WordBeatClassroom lesson={current} assets={{}} />);
    expect(screen.getByRole('status')).toHaveTextContent('已恢复本课在当前浏览器保存的设置');
    await act(async () => vi.advanceTimersByTimeAsync(4300));
    expect(screen.queryByRole('button', { name: '关闭课堂提示' })).not.toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(localStorage.getItem(key)).toBe(saved);
    expect(screen.getByRole('button', { name: '开始课堂' })).toBeEnabled();
    await click('课堂设置');
    expect(screen.getByRole('spinbutton', { name: '节拍音量百分比' })).toHaveValue(35);
  });

  it('损坏、过期和读取失败的恢复警告持续显示，不因成功提示自动收起规则被隐藏', async () => {
    // 三类异常均从正式完成设置产生记录；每轮单独卸载，防止计时器或故障桩跨场景污染。
    for (const failure of ['corrupt', 'stale', 'unavailable'] as const) {
      const current = lesson();
      const view = render(<WordBeatClassroom lesson={current} assets={{}} />);
      await click('课堂设置');
      fireEvent.change(screen.getByRole('spinbutton', { name: '节拍音量百分比' }), {
        target: { value: '35' },
      });
      await click('完成设置');
      const key = localStorage.key(0)!;
      view.unmount();
      if (failure === 'corrupt') localStorage.setItem(key, '{');
      if (failure === 'stale') current.gameData.bpm.value = 120;
      const readFailure =
        failure === 'unavailable'
          ? vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
              throw new Error('浏览器禁用本地存储');
            })
          : undefined;
      const reopened = render(<WordBeatClassroom lesson={current} assets={{}} />);
      readFailure?.mockRestore();
      const expected =
        failure === 'corrupt'
          ? '本地课堂设置损坏'
          : failure === 'stale'
            ? '课件内容或版本已变化'
            : '浏览器无法读取本地设置';
      expect(screen.getByRole('status')).toHaveTextContent(expected);
      expect(reopened.container.querySelector('.ecg-classroom-message')).toHaveAttribute(
        'data-tone',
        'warning',
      );
      await act(async () => vi.advanceTimersByTimeAsync(6000));
      expect(screen.getByRole('status')).toHaveTextContent(expected);
      expect(screen.getByRole('button', { name: '开始课堂' })).toBeEnabled();
      reopened.unmount();
      localStorage.clear();
    }
  });

  it('声音短试听结束的普通提示四秒收起，音源保持释放且可再次测试', async () => {
    render(<WordBeatClassroom lesson={lesson()} assets={{}} />);
    await click('测试声音');
    await act(async () => vi.advanceTimersByTimeAsync(1800));
    expect(screen.getByRole('status')).toHaveTextContent('试听结束，请确认教室音箱实际发声。');
    expect(harness.sessions[0].dispose).toHaveBeenCalledOnce();
    await act(async () => vi.advanceTimersByTimeAsync(4300));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '测试声音' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '开始课堂' })).toBeEnabled();
    expect(harness.sessions[0].dispose).toHaveBeenCalledOnce();
  });

  it('全屏受限的普通提示四秒收起，窗口模式主操作继续可用', async () => {
    const view = render(<WordBeatClassroom lesson={lesson()} assets={{}} />);
    const root = view.container.firstElementChild as HTMLElement;
    root.requestFullscreen = vi.fn(async () => {
      throw new Error('拒绝全屏');
    });
    await click('全屏');
    expect(screen.getByRole('status')).toHaveTextContent('可继续使用窗口模式上课。');
    await act(async () => vi.advanceTimersByTimeAsync(4300));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '开始课堂' })).toBeEnabled();
    expect(harness.sessions).toHaveLength(0);
  });

  it('放弃草稿的普通提示四秒收起，已保存设置和重新开始条件保持不变', async () => {
    render(<WordBeatClassroom lesson={lesson()} assets={{}} />);
    await click('课堂设置');
    fireEvent.change(screen.getByRole('spinbutton', { name: '节奏 BPM' }), {
      target: { value: '' },
    });
    expect(screen.getByRole('button', { name: '完成设置' })).toBeDisabled();
    await click('放弃未完成输入');
    await click('收起');
    expect(screen.getByRole('status')).toHaveTextContent('已放弃未完成输入，保留上次完成的设置。');
    await act(async () => vi.advanceTimersByTimeAsync(4300));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(localStorage.length).toBe(0);
    expect(screen.getByRole('button', { name: '开始课堂' })).toBeEnabled();
  });

  it('连续保存同文案成功提示重置显示时间，旧定时器不能提前清除新提示', async () => {
    render(<WordBeatClassroom lesson={lesson()} assets={{}} />);
    await click('课堂设置');
    fireEvent.change(screen.getByRole('spinbutton', { name: '节拍音量百分比' }), {
      target: { value: '35' },
    });
    await click('完成设置');
    expect(screen.getByRole('status')).toHaveTextContent('已保存到当前浏览器');
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    await click('课堂设置');
    fireEvent.change(screen.getByRole('spinbutton', { name: '节拍音量百分比' }), {
      target: { value: '45' },
    });
    await click('完成设置');
    await act(async () => vi.advanceTimersByTimeAsync(1200));
    expect(screen.getByRole('status')).toHaveTextContent('已保存到当前浏览器');
    expect(screen.getByRole('button', { name: '关闭课堂提示' })).toBeEnabled();
    await act(async () => vi.advanceTimersByTimeAsync(3400));
    expect(screen.queryByRole('button', { name: '关闭课堂提示' })).not.toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '开始课堂' })).toBeEnabled();
  });

  it('关闭按钮聚焦时成功通知到时保留，主动关闭后焦点返回开始而不启动课堂', async () => {
    render(<WordBeatClassroom lesson={lesson()} assets={{}} />);
    await click('课堂设置');
    fireEvent.change(screen.getByRole('spinbutton', { name: '节拍音量百分比' }), {
      target: { value: '35' },
    });
    await click('完成设置');
    const saved = localStorage.getItem(localStorage.key(0)!);
    // 先完成 Dialog 的异步焦点还原，再模拟教师 Tab 到外部通知关闭按钮。
    await act(async () => vi.advanceTimersByTimeAsync(0));
    const dismiss = screen.getByRole('button', { name: '关闭课堂提示' });
    act(() => dismiss.focus());
    expect(dismiss).toHaveFocus();
    // 到时销毁有键盘焦点的通知会把焦点落到 BODY；聚焦期间保留供教师主动关闭。
    await act(async () => vi.advanceTimersByTimeAsync(6000));
    expect(dismiss).toBeInTheDocument();
    expect(dismiss).toHaveFocus();
    await click('关闭课堂提示');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '开始课堂' })).toHaveFocus();
    expect(harness.sessions).toHaveLength(0);
    expect(localStorage.getItem(localStorage.key(0)!)).toBe(saved);
  });

  it('普通通知聚焦超时后移到开始按钮重新留足四秒，再收起且不抢走焦点', async () => {
    render(<WordBeatClassroom lesson={lesson()} assets={{}} />);
    await click('课堂设置');
    fireEvent.change(screen.getByRole('spinbutton', { name: '节拍音量百分比' }), {
      target: { value: '35' },
    });
    await click('完成设置');
    await act(async () => vi.advanceTimersByTimeAsync(0));
    const dismiss = screen.getByRole('button', { name: '关闭课堂提示' });
    act(() => dismiss.focus());
    await act(async () => vi.advanceTimersByTimeAsync(6000));
    expect(dismiss).toHaveFocus();
    const start = screen.getByRole('button', { name: '开始课堂' });
    act(() => start.focus());
    await act(async () => vi.advanceTimersByTimeAsync(3900));
    expect(dismiss).toBeInTheDocument();
    await act(async () => vi.advanceTimersByTimeAsync(200));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(start).toHaveFocus();
    expect(start).toBeEnabled();
    expect(harness.sessions).toHaveLength(0);
  });

  it('普通通知悬停超时仍可阅读，移开后重新留足四秒并自动收起', async () => {
    render(<WordBeatClassroom lesson={lesson()} assets={{}} />);
    await click('课堂设置');
    fireEvent.change(screen.getByRole('spinbutton', { name: '节拍音量百分比' }), {
      target: { value: '35' },
    });
    await click('完成设置');
    await act(async () => vi.advanceTimersByTimeAsync(0));
    const notice = screen.getByRole('status');
    fireEvent.pointerOver(notice);
    await act(async () => vi.advanceTimersByTimeAsync(6000));
    expect(notice).toBeInTheDocument();
    fireEvent.pointerOut(notice);
    await act(async () => vi.advanceTimersByTimeAsync(3900));
    expect(notice).toBeInTheDocument();
    await act(async () => vi.advanceTimersByTimeAsync(200));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '开始课堂' })).toBeEnabled();
    expect(harness.sessions).toHaveLength(0);
  });

  it('设置内主动关闭已保存通知时焦点接续完成设置，不关闭弹窗或再次保存', async () => {
    render(<WordBeatClassroom lesson={lesson()} assets={{}} />);
    await click('课堂设置');
    fireEvent.change(screen.getByRole('spinbutton', { name: '节拍音量百分比' }), {
      target: { value: '35' },
    });
    await click('完成设置');
    const saved = localStorage.getItem(localStorage.key(0)!);
    await click('课堂设置');
    const drawer = screen.getByRole('dialog', { name: '课堂设置' });
    const dismiss = within(drawer).getByRole('button', { name: '关闭课堂提示' });
    act(() => dismiss.focus());
    expect(dismiss).toHaveFocus();
    await click('关闭课堂提示');
    expect(drawer).toBeInTheDocument();
    expect(within(drawer).queryByRole('button', { name: '关闭课堂提示' })).not.toBeInTheDocument();
    expect(within(drawer).getByRole('status')).toHaveTextContent('设置已就绪');
    expect(within(drawer).getByRole('button', { name: '完成设置' })).toHaveFocus();
    expect(localStorage.getItem(localStorage.key(0)!)).toBe(saved);
    expect(harness.sessions).toHaveLength(0);
  });

  it('课中主动关闭待生效通知时焦点接续继续，保留暂停和已保存安排', async () => {
    render(<WordBeatClassroom lesson={lesson()} assets={{}} />);
    await click('开始课堂');
    await click('下一词');
    await click('课堂设置');
    fireEvent.change(screen.getByRole('spinbutton', { name: '当前词轮数' }), {
      target: { value: '3' },
    });
    await click('完成设置');
    const saved = localStorage.getItem(localStorage.key(0)!);
    const plays = harness.sessions[0].play.mock.calls.length;
    expect(screen.getByRole('status')).toHaveTextContent('当前词和重读保持原安排');
    const dismiss = screen.getByRole('button', { name: '关闭课堂提示' });
    act(() => dismiss.focus());
    expect(dismiss).toHaveFocus();
    await click('关闭课堂提示');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '继续' })).toHaveFocus();
    expect(screen.getByRole('button', { name: '继续' })).toBeEnabled();
    expect(harness.sessions[0].play).toHaveBeenCalledTimes(plays);
    expect(localStorage.getItem(localStorage.key(0)!)).toBe(saved);
  });

  it('试听失败作为错误持续显示且不能关闭，不用自动淡出冒充错误已解决', async () => {
    harness.failNext = true;
    render(<WordBeatClassroom lesson={lesson()} assets={{}} />);
    await click('测试声音');
    expect(screen.getByRole('alert')).toHaveTextContent('声音设备暂时不可用');
    expect(screen.queryByRole('button', { name: '关闭课堂提示' })).not.toBeInTheDocument();
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(screen.getByRole('alert')).toHaveTextContent('声音设备暂时不可用');
    expect(screen.queryByRole('button', { name: '关闭课堂提示' })).not.toBeInTheDocument();
    expect(harness.sessions[0].dispose).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: '测试声音' })).toBeEnabled();
    await click('课堂设置');
    fireEvent.change(screen.getByRole('textbox', { name: '教学释义' }), {
      target: { value: '试听失败后仍可保留的合法草稿' },
    });
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(within(screen.getByRole('dialog')).getByRole('alert')).toHaveTextContent(
      '声音设备暂时不可用',
    );
    expect(screen.queryByRole('button', { name: '关闭课堂提示' })).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: '教学释义' })).toHaveValue(
      '试听失败后仍可保留的合法草稿',
    );
  });

  it('声音故障在设置内合法文字草稿出现后仍可见，始终只有一个错误通知', async () => {
    render(<WordBeatClassroom lesson={lesson()} assets={{}} />);
    await click('开始课堂');
    harness.failNext = true;
    await click('下一词');
    expect(screen.getByRole('alert')).toHaveTextContent('声音设备暂时不可用');
    await click('课堂设置');
    fireEvent.change(screen.getByRole('textbox', { name: '教学释义' }), {
      target: { value: '仍需处理声音故障的合法草稿' },
    });
    const drawer = screen.getByRole('dialog', { name: '课堂设置' });
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(within(drawer).getByRole('alert')).toHaveTextContent('声音设备暂时不可用');
    expect(within(drawer).getByRole('alert')).toHaveTextContent('重试当前阶段');
    expect(screen.queryByRole('button', { name: '关闭课堂提示' })).not.toBeInTheDocument();
    await act(async () => vi.advanceTimersByTimeAsync(6000));
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(screen.getByRole('alert')).toHaveTextContent('声音设备暂时不可用');
    expect(screen.getByRole('textbox', { name: '教学释义' })).toHaveValue(
      '仍需处理声音故障的合法草稿',
    );
  });

  it('关闭提示只清通知，不改变本地设置、未完成输入保护或待生效时间轴', async () => {
    render(<WordBeatClassroom lesson={lesson()} assets={{}} />);
    await click('课堂设置');
    fireEvent.change(screen.getByRole('spinbutton', { name: '节拍音量百分比' }), {
      target: { value: '35' },
    });
    await click('完成设置');
    const saved = localStorage.getItem(localStorage.key(0)!);
    await click('关闭课堂提示');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(localStorage.getItem(localStorage.key(0)!)).toBe(saved);
    expect(screen.getByRole('button', { name: '开始课堂' })).toBeEnabled();
    await click('课堂设置');
    fireEvent.change(screen.getByRole('spinbutton', { name: '节奏 BPM' }), {
      target: { value: '' },
    });
    expect(screen.getByRole('button', { name: '完成设置' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: '关闭课堂提示' })).not.toBeInTheDocument();
    await click('收起');
    expect(screen.getByRole('button', { name: '开始课堂' })).toBeDisabled();
    expect(localStorage.getItem(localStorage.key(0)!)).toBe(saved);
    await act(async () => vi.advanceTimersByTimeAsync(6000));
    expect(screen.getByRole('button', { name: '开始课堂' })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('节奏需为 50～180 的整数 BPM');
    await click('课堂设置');
    await click('放弃未完成输入');
    await click('完成设置');
    await click('开始课堂');
    await click('下一词');
    await click('课堂设置');
    fireEvent.change(screen.getByRole('spinbutton', { name: '当前词轮数' }), {
      target: { value: '3' },
    });
    await click('完成设置');
    const pendingSaved = localStorage.getItem(localStorage.key(0)!);
    expect(screen.getByRole('status')).toHaveTextContent('当前词和重读保持原安排');
    // 待生效提示可以隐藏，但隐藏不能取消真实控制器已排队的新安排。
    await act(async () => vi.advanceTimersByTimeAsync(6000));
    expect(screen.getByRole('status')).toHaveTextContent('当前词和重读保持原安排');
    await click('关闭课堂提示');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(localStorage.getItem(localStorage.key(0)!)).toBe(pendingSaved);
    expect(screen.getByRole('button', { name: '继续' })).toBeEnabled();
    await click('重读');
    await click('继续');
    expect(harness.sessions[0].play).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ roundCount: 2 }) }),
      0,
    );
    await click('下一词');
    await click('上一词');
    expect(harness.sessions[0].play).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ roundCount: 3 }) }),
      0,
    );
    expect(localStorage.getItem(localStorage.key(0)!)).toBe(pendingSaved);
  });
});

describe('课堂临时文字统一保存与运行隔离', () => {
  it.each(['英文／短语', '教学释义'] as const)(
    '试听准备中编辑%s立即取消旧样本，迟到准备不播放也不影响新试听',
    async (field) => {
      const current = lesson();
      current.gameData.soundMode = 'voiced';
      const { playable, assets } = withEntryRecordings(current);
      let prepareOld!: () => void;
      harness.prepareOnce = () =>
        new Promise<void>((resolve) => {
          prepareOld = resolve;
        });
      render(<WordBeatClassroom lesson={playable} assets={assets} />);
      await click('课堂设置');
      await click('测试声音');
      const old = harness.sessions[0];
      expect(old.play).not.toHaveBeenCalled();
      fireEvent.change(screen.getByRole('textbox', { name: field }), {
        target: { value: field === '英文／短语' ? 'replacement word' : '新的课堂释义' },
      });
      expect(old.dispose).toHaveBeenCalledOnce();
      expect(screen.queryByRole('button', { name: '停止测试' })).not.toBeInTheDocument();
      if (field === '英文／短语') await click('本课改为文字领读');
      expect(screen.getByRole('button', { name: '测试声音' })).toBeEnabled();
      await click('测试声音');
      const latest = harness.sessions[1];
      expect(latest.play).toHaveBeenCalledOnce();
      await act(async () => prepareOld());
      expect(old.play).not.toHaveBeenCalled();
      expect(latest.dispose).not.toHaveBeenCalled();
      expect(latest.play).toHaveBeenCalledOnce();
      expect(screen.getByRole('button', { name: '停止测试' })).toBeEnabled();
      await click('停止测试');
      expect(latest.dispose).toHaveBeenCalledOnce();
    },
  );

  it('试听文字领读时恢复失配配音立即取消旧样本，重新领读试听不受迟到失败影响', async () => {
    const current = lesson();
    current.gameData.soundMode = 'voiced';
    const { playable, assets } = withEntryRecordings(current);
    let rejectOld!: (error: Error) => void;
    render(<WordBeatClassroom lesson={playable} assets={assets} />);
    await click('课堂设置');
    fireEvent.change(screen.getByRole('textbox', { name: '英文／短语' }), {
      target: { value: 'replacement word' },
    });
    await click('本课改为文字领读');
    harness.prepareOnce = () =>
      new Promise<void>((_resolve, reject) => {
        rejectOld = reject;
      });
    await click('测试声音');
    const old = harness.sessions[0];
    expect(old.play).not.toHaveBeenCalled();
    await click('恢复配音跟读');
    expect(old.dispose).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: '测试声音' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '完成设置' })).toBeDisabled();
    await click('本课改为文字领读');
    await click('测试声音');
    const latest = harness.sessions[1];
    expect(latest.play).toHaveBeenCalledOnce();
    await act(async () => rejectOld(new Error('旧模式试听准备失败')));
    expect(old.play).not.toHaveBeenCalled();
    expect(latest.dispose).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '停止测试' })).toBeEnabled();
    expect(screen.queryByText('旧模式试听准备失败')).not.toBeInTheDocument();
    await click('停止测试');
  });

  it.each(['teacher', 'chorus', 'voiced'] as const)(
    '%s课前复用选词器编辑，统一保存v5，重开恢复文字及原模式',
    async (mode) => {
      const current = lesson();
      current.gameData.soundMode = mode;
      const { playable, assets } = withEntryRecordings(current);
      const original = structuredClone(playable);
      const [first, second] = getEntries(playable);
      const originalPlan = compileWordBeat(playable, assets);
      const english = mode === 'voiced' ? first.english : 'classroom phrase';
      const view = render(<WordBeatClassroom lesson={playable} assets={assets} />);
      await click('课堂设置');
      expect(screen.getAllByRole('listbox', { name: '选择要调整的词' })).toHaveLength(1);
      fireEvent.change(screen.getByRole('textbox', { name: '英文／短语' }), {
        target: { value: english },
      });
      fireEvent.change(screen.getByRole('textbox', { name: '教学释义' }), {
        target: { value: '本课教学释义' },
      });
      await selectWord(second.id);
      fireEvent.change(screen.getByRole('textbox', { name: '教学释义' }), {
        target: { value: '' },
      });
      expect(screen.getByText(/释义留空，仅练习英文/)).toBeInTheDocument();
      expect(localStorage.length).toBe(0);
      expect(screen.queryByRole('button', { name: '保存文字' })).not.toBeInTheDocument();
      await click('完成设置');
      const stored = JSON.parse(localStorage.getItem(localStorage.key(0)!)!);
      expect(stored.version).toBe(5);
      expect(stored.settings.soundMode).toBe(mode);
      expect(stored.settings.entries).toEqual([
        { id: first.id, english, meaning: '本课教学释义' },
        { id: second.id, english: second.english, meaning: '' },
      ]);
      expect(playable).toEqual(original);
      view.unmount();
      render(<WordBeatClassroom lesson={playable} assets={assets} />);
      // 恢复记录已经完成，schema 字段顺序不能使它被误判为一份未保存草稿。
      expect(screen.getByRole('button', { name: '开始课堂' })).toBeEnabled();
      await click('课堂设置');
      expect(screen.getByRole('textbox', { name: '英文／短语' })).toHaveValue(english);
      expect(screen.getByRole('textbox', { name: '教学释义' })).toHaveValue('本课教学释义');
      await selectWord(second.id);
      expect(screen.getByRole('textbox', { name: '教学释义' })).toHaveValue('');
      expect(screen.queryByRole('button', { name: '还原此词文字' })).not.toBeInTheDocument();
      await click('完成设置');
      await click('开始课堂');
      await click('下一词');
      expect(harness.sessions[0].play).toHaveBeenLastCalledWith(
        expect.objectContaining({
          kind: mode === 'chorus' ? 'chorus' : 'model',
          durationMs: originalPlan.cues[originalPlan.items[0].firstCue].durationMs,
          data: expect.objectContaining({ english, meaning: '本课教学释义' }),
          audioAssetId: mode === 'voiced' ? first.audio?.assetId : undefined,
        }),
        0,
      );
      if (mode === 'teacher') {
        // 普通词改成含空格文字也不暗改为短语，从而给跟读公式额外增加一拍。
        const modelIndex = originalPlan.items[0].firstCue;
        await advance(originalPlan.cues[modelIndex].durationMs);
        expect(harness.sessions[0].play).toHaveBeenLastCalledWith(
          expect.objectContaining({
            kind: 'follow',
            durationMs: originalPlan.cues[modelIndex + 1].durationMs,
          }),
          0,
        );
      }
    },
  );

  it('配音英文失配阻断旧读音，显式整课领读可放弃和恢复，口号与原音频保留', async () => {
    const current = lesson();
    current.gameData.soundMode = 'voiced';
    current.gameData.slogans.opening.enabled = true;
    const { playable: recorded, assets } = withEntryRecordings(current);
    const opening = {
      assetId: 'classroom-word-opening',
      mimeType: 'audio/wav',
      durationMs: 900,
      byteLength: 44,
      sha256: 'b'.repeat(64),
    };
    assets[opening.assetId] = opening;
    const playable = bindRecording(recorded, current.gameData.slogans.opening.id, opening);
    const original = structuredClone(playable);
    const view = render(<WordBeatClassroom lesson={playable} assets={assets} />);
    await click('课堂设置');
    const english = () => screen.getByRole('textbox', { name: '英文／短语' });
    fireEvent.change(english(), { target: { value: 'new classroom word' } });
    expect(screen.getByRole('button', { name: '完成设置' })).toBeDisabled();
    expect(screen.getByText(/本课全部词改为文字领读/)).toHaveTextContent('原配音保留');
    expect(screen.getByRole('button', { name: '本课改为文字领读' })).toBeEnabled();
    expect(localStorage.length).toBe(0);
    await click('本课改为文字领读');
    expect(
      screen.getByText('本课全部词将由教师示范；原配音保留，底部完成设置统一保存。'),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: '完成设置' })).toBeEnabled();
    expect(screen.getByRole('spinbutton', { name: '口号音量百分比' })).toBeInTheDocument();
    expect(
      screen.queryByRole('spinbutton', { name: '示范 / 口号音量百分比' }),
    ).not.toBeInTheDocument();
    await click('恢复配音跟读');
    expect(screen.getByRole('button', { name: '完成设置' })).toBeDisabled();
    expect(english()).toHaveValue('new classroom word');
    await click('本课改为文字领读');
    await click('放弃未完成输入');
    expect(english()).toHaveValue(getEntries(playable)[0].english);
    expect(screen.queryByRole('button', { name: '恢复配音跟读' })).not.toBeInTheDocument();
    expect(screen.getByRole('spinbutton', { name: '示范 / 口号音量百分比' })).toBeInTheDocument();
    expect(localStorage.length).toBe(0);
    fireEvent.change(english(), { target: { value: 'new classroom word' } });
    await click('本课改为文字领读');
    await click('完成设置');
    expect(JSON.parse(localStorage.getItem(localStorage.key(0)!)!).settings.soundMode).toBe(
      'teacher',
    );
    view.unmount();
    render(<WordBeatClassroom lesson={playable} assets={assets} />);
    expect(screen.getByText(/WORD BEAT \/ 文字领读/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '开始课堂' })).toBeEnabled();
    await click('开始课堂');
    expect(harness.sessions[0].play).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: 'opening', audioAssetId: opening.assetId }),
      0,
    );
    await click('下一词');
    expect(harness.sessions[0].play).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: 'model',
        audioAssetId: undefined,
        data: expect.objectContaining({ english: 'new classroom word', label: '教师示范' }),
      }),
      0,
    );
    expect(playable).toEqual(original);
  });

  it('配音课中改词及整课领读延后安装，当前词重读仍用旧音而跨词不再读旧音', async () => {
    const current = lesson();
    current.gameData.soundMode = 'voiced';
    const { playable, assets } = withEntryRecordings(current);
    const original = structuredClone(playable);
    const first = getEntries(playable)[0];
    render(<WordBeatClassroom lesson={playable} assets={assets} />);
    await click('开始课堂');
    await click('下一词');
    await click('课堂设置');
    fireEvent.change(screen.getByRole('textbox', { name: '英文／短语' }), {
      target: { value: 'temporary replacement' },
    });
    await click('本课改为文字领读');
    await click('完成设置');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(first.english);
    await click('重读');
    await click('继续');
    expect(harness.sessions[0].play).toHaveBeenLastCalledWith(
      expect.objectContaining({
        audioAssetId: first.audio?.assetId,
        data: expect.objectContaining({ english: first.english, label: '示范' }),
      }),
      0,
    );
    await click('下一词');
    expect(harness.sessions[0].play).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: 'model',
        audioAssetId: undefined,
        data: expect.objectContaining({ label: '教师示范' }),
      }),
      0,
    );
    await click('上一词');
    expect(harness.sessions[0].play).toHaveBeenLastCalledWith(
      expect.objectContaining({
        audioAssetId: undefined,
        data: expect.objectContaining({ english: 'temporary replacement', label: '教师示范' }),
      }),
      0,
    );
    expect(playable).toEqual(original);
  });

  it.each([
    { field: '英文／短语', raw: '' },
    { field: '英文／短语', raw: 'a'.repeat(121) },
    { field: '英文／短语', raw: 'word\u0001' },
    { field: '教学释义', raw: '义'.repeat(201) },
    { field: '教学释义', raw: '释义\u007f' },
  ])('$field非法原文保留，收起重开及快捷键不能绕过统一校验（$raw）', async ({ field, raw }) => {
    const current = lesson();
    const [first, second] = getEntries(current);
    render(<WordBeatClassroom lesson={current} assets={{}} />);
    await click('课堂设置');
    const input = screen.getByRole('textbox', { name: field });
    fireEvent.change(input, { target: { value: raw } });
    expect(input).toHaveValue(raw);
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(within(input.parentElement!).getByRole('alert')).toBeVisible();
    // 文字错误跟随原条目保留，教师仍可核对其他词；切词不能解除整课完成保护。
    expect(wordOption(second.id)).toBeEnabled();
    await selectWord(second.id);
    expect(screen.getByRole('button', { name: '完成设置' })).toBeDisabled();
    await selectWord(first.id);
    expect(screen.getByRole('textbox', { name: field })).toHaveValue(raw);
    expect(screen.getByRole('button', { name: '完成设置' })).toBeDisabled();
    fireEvent.keyDown(input, { code: 'Space', key: ' ' });
    expect(harness.sessions).toHaveLength(0);
    await click('收起');
    expect(screen.getByRole('button', { name: '开始课堂' })).toBeDisabled();
    await click('课堂设置');
    expect(screen.getByRole('textbox', { name: field })).toHaveValue(raw);
    expect(screen.getByRole('button', { name: '完成设置' })).toBeDisabled();
    expect(localStorage.length).toBe(0);
    await click('还原此词文字');
    expect(screen.getByRole('textbox', { name: '英文／短语' })).toHaveValue('photosynthesis');
    expect(screen.getByRole('textbox', { name: '教学释义' })).toHaveValue('光合作用');
    expect(screen.getByRole('button', { name: '完成设置' })).toBeEnabled();
  });

  it('文字独立还原不取消轮数拍数或其他词；同词仅提示不合并', async () => {
    const current = lesson();
    current.gameData.soundMode = 'chorus';
    const [first, second] = getEntries(current);
    render(<WordBeatClassroom lesson={current} assets={{}} />);
    await click('课堂设置');
    fireEvent.change(screen.getByRole('textbox', { name: '英文／短语' }), {
      target: { value: second.english },
    });
    fireEvent.change(screen.getByRole('textbox', { name: '教学释义' }), {
      target: { value: '临时释义' },
    });
    expect(screen.getByText(/与本课第 2 词英文相同，各自保留/)).toBeVisible();
    expect(screen.getByRole('button', { name: '完成设置' })).toBeEnabled();
    fireEvent.change(screen.getByRole('spinbutton', { name: '当前词轮数' }), {
      target: { value: '4' },
    });
    fireEvent.change(screen.getByRole('spinbutton', { name: '每轮总拍数' }), {
      target: { value: '8' },
    });
    await selectWord(second.id);
    fireEvent.change(screen.getByRole('textbox', { name: '英文／短语' }), {
      target: { value: 'second classroom word' },
    });
    await selectWord(first.id);
    await click('还原此词文字');
    expect(screen.getByRole('textbox', { name: '英文／短语' })).toHaveValue(first.english);
    expect(screen.getByRole('textbox', { name: '教学释义' })).toHaveValue(first.meaning);
    expect(screen.getByRole('spinbutton', { name: '当前词轮数' })).toHaveValue(4);
    expect(screen.getByRole('spinbutton', { name: '每轮总拍数' })).toHaveValue(8);
    await selectWord(second.id);
    expect(screen.getByRole('textbox', { name: '英文／短语' })).toHaveValue(
      'second classroom word',
    );
    await click('完成设置');
    const settings = JSON.parse(localStorage.getItem(localStorage.key(0)!)!).settings;
    expect(settings.entries[0]).toEqual({
      id: first.id,
      english: first.english,
      meaning: first.meaning,
    });
    expect(settings.entries[1].english).toBe('second classroom word');
    expect(settings.rounds[0].value).toBe(4);
    expect(settings.chorus[0].beats.value).toBe(8);
  });

  it('文字保存配额失败保留草稿和旧课堂，明确放弃后不会带入临时词', async () => {
    const current = lesson();
    current.gameData.soundMode = 'chorus';
    const view = render(<WordBeatClassroom lesson={current} assets={{}} />);
    await click('开始课堂');
    await click('下一词');
    await click('课堂设置');
    fireEvent.change(screen.getByRole('textbox', { name: '英文／短语' }), {
      target: { value: 'unsaved classroom word' },
    });
    const fail = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
    await click('完成设置');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('浏览器未能保存');
    expect(screen.getByRole('textbox', { name: '英文／短语' })).toHaveValue(
      'unsaved classroom word',
    );
    expect(localStorage.length).toBe(0);
    expect(view.container.querySelector('h1')).toHaveTextContent('photosynthesis');
    expect(harness.sessions[0].play).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ english: 'photosynthesis' }) }),
      0,
    );
    fail.mockRestore();
    await click('放弃未完成输入');
    expect(screen.getByRole('textbox', { name: '英文／短语' })).toHaveValue('photosynthesis');
    await click('完成设置');
    await click('继续');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('photosynthesis');
    expect(
      JSON.parse(localStorage.getItem(localStorage.key(0)!)!).settings.entries[0].english,
    ).toBe('photosynthesis');
  });

  it('课中当前词与重读保留旧文，跨词和重玩才更新正文词轨，草稿不泄漏', async () => {
    const current = lesson();
    current.gameData.soundMode = 'chorus';
    const [first, second] = getEntries(current);
    const view = render(<WordBeatClassroom lesson={current} assets={{}} />);
    const trackWords = () =>
      Array.from(view.container.querySelectorAll('.ecg-word-track-word')).map((item) =>
        item.getAttribute('data-word'),
      );
    await click('开始课堂');
    await click('下一词');
    await click('课堂设置');
    fireEvent.change(screen.getByRole('textbox', { name: '英文／短语' }), {
      target: { value: 'updated first word' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: '教学释义' }), {
      target: { value: '第一词新释义' },
    });
    await selectWord(second.id);
    fireEvent.change(screen.getByRole('textbox', { name: '英文／短语' }), {
      target: { value: 'updated second word' },
    });
    await click('收起');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(first.english);
    expect(trackWords()).toEqual([first.english, second.english]);
    expect(screen.getByRole('button', { name: '继续' })).toBeDisabled();
    await click('课堂设置');
    await click('完成设置');
    expect(screen.getByRole('status')).toHaveTextContent('当前词和重读保持原安排');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(first.english);
    expect(trackWords()).toEqual([first.english, second.english]);
    await click('重读');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(first.english);
    await click('继续');
    expect(harness.sessions[0].play).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ english: first.english, meaning: first.meaning }),
      }),
      0,
    );
    await click('暂停');
    await click('下一词');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('updated second word');
    expect(trackWords()).toEqual(['updated first word', 'updated second word']);
    await click('继续');
    await click('上一词');
    expect(harness.sessions[0].play).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ english: 'updated first word', meaning: '第一词新释义' }),
      }),
      0,
    );
    await click('结束课堂');
    await click('重新播放');
    await click('下一词');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('updated first word');
    expect(trackWords()).toEqual(['updated first word', 'updated second word']);
  });
});

describe('课堂词语管理与结构保存', () => {
  it.each(['teacher', 'chorus'] as const)(
    '%s新增改词删除排序由完成统一保存v5，重开保持词表和适用练习参数',
    async (mode) => {
      const current = lesson();
      current.gameData.soundMode = mode;
      const original = structuredClone(current);
      const [first, second] = getEntries(current);
      const view = render(<WordBeatClassroom lesson={current} assets={{}} />);
      await click('课堂设置');
      await click('新增词语');
      expect(screen.getByRole('button', { name: '完成设置' })).toBeDisabled();
      expect(screen.getByRole('textbox', { name: '英文／短语' })).toHaveValue('');
      expect(screen.getByRole('spinbutton', { name: '当前词轮数' })).toHaveValue(1);
      const added = within(screen.getByRole('listbox'))
        .getByRole('option', { selected: true })
        .getAttribute('data-entry-id')!;
      fireEvent.change(screen.getByRole('textbox', { name: '英文／短语' }), {
        target: { value: 'take a breath' },
      });
      fireEvent.change(screen.getByRole('textbox', { name: '教学释义' }), {
        target: { value: '深呼吸' },
      });
      fireEvent.change(screen.getByRole('combobox', { name: '词语类型' }), {
        target: { value: 'phrase' },
      });
      fireEvent.click(screen.getByRole('checkbox', { name: '重点词' }));
      fireEvent.change(screen.getByRole('spinbutton', { name: '当前词轮数' }), {
        target: { value: '3' },
      });
      if (mode === 'chorus') {
        fireEvent.change(screen.getByLabelText('每轮总拍数', { exact: true }), {
          target: { value: '8' },
        });
        fireEvent.change(screen.getByRole('combobox', { name: '每次朗读占用拍数' }), {
          target: { value: '2' },
        });
      } else {
        fireEvent.change(screen.getByLabelText('教师示范拍数', { exact: true }), {
          target: { value: '6' },
        });
        fireEvent.change(screen.getByLabelText('学生跟读拍数', { exact: true }), {
          target: { value: '8' },
        });
      }
      await click('上移当前词');
      await click('上移当前词');
      expect(screen.getByRole('button', { name: '上移当前词' })).toBeDisabled();
      await selectWord(first.id);
      fireEvent.change(screen.getByRole('textbox', { name: '英文／短语' }), {
        target: { value: 'updated first word' },
      });
      await selectWord(second.id);
      await click('删除当前词');
      expect(within(screen.getByRole('listbox')).getAllByRole('option')).toHaveLength(2);
      expect(localStorage.length).toBe(0);
      await click('完成设置');
      const stored = JSON.parse(localStorage.getItem(localStorage.key(0)!)!);
      expect(stored.version).toBe(5);
      expect(stored.settings.entries).toEqual([
        { id: added, english: 'take a breath', meaning: '深呼吸' },
        { id: first.id, english: 'updated first word', meaning: first.meaning },
      ]);
      expect(stored.settings.segments).toEqual([
        { id: current.gameData.segments[0].id, entryIds: [added, first.id] },
      ]);
      expect(stored.settings.practice[0]).toMatchObject({
        id: added,
        entryType: 'phrase',
        entryTypeSource: 'manual',
        priority: true,
      });
      expect(stored.settings.rounds[0]).toMatchObject({ id: added, value: 3 });
      expect(current).toEqual(original);
      view.unmount();
      render(<WordBeatClassroom lesson={current} assets={{}} />);
      expect(screen.getByRole('button', { name: '开始课堂' })).toBeEnabled();
      await click('课堂设置');
      expect(
        within(screen.getByRole('listbox'))
          .getAllByRole('option')
          .map((item) => item.getAttribute('data-entry-id')),
      ).toEqual([added, first.id]);
      expect(screen.getByRole('textbox', { name: '英文／短语' })).toHaveValue('take a breath');
      expect(screen.getByRole('checkbox', { name: '重点词' })).toBeChecked();
      expect(screen.getByRole('spinbutton', { name: '当前词轮数' })).toHaveValue(3);
      if (mode === 'chorus') {
        expect(screen.getByLabelText('每轮总拍数', { exact: true })).toHaveValue(8);
        expect(screen.getByRole('combobox', { name: '每次朗读占用拍数' })).toHaveValue('2');
      } else {
        expect(screen.getByLabelText('教师示范拍数', { exact: true })).toHaveValue(6);
        expect(screen.getByLabelText('学生跟读拍数', { exact: true })).toHaveValue(8);
      }
      await click('完成设置');
      await click('开始课堂');
      await click('下一词');
      expect(harness.sessions[0].play).toHaveBeenLastCalledWith(
        expect.objectContaining({
          kind: mode === 'chorus' ? 'chorus' : 'model',
          data: expect.objectContaining({ english: 'take a breath', roundCount: 3 }),
        }),
        0,
      );
    },
  );

  it('课中词表结构保存成功才释放旧课堂并返回开始页，不让旧索引继续运行', async () => {
    const current = lesson();
    current.gameData.soundMode = 'chorus';
    render(<WordBeatClassroom lesson={current} assets={{}} />);
    await click('开始课堂');
    await click('下一词');
    const old = harness.sessions[0];
    await click('课堂设置');
    await click('新增词语');
    fireEvent.change(screen.getByRole('textbox', { name: '英文／短语' }), {
      target: { value: 'new classroom word' },
    });
    expect(screen.getByText('词表已调整：完成后返回开始页，按新词表从头开始。')).toBeVisible();
    const saveFailure = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
    await click('完成设置');
    expect(screen.getByRole('alert')).toHaveTextContent('浏览器未能保存');
    expect(old.dispose).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
    saveFailure.mockRestore();
    await click('完成设置');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('已返回开始页');
    expect(screen.getByRole('button', { name: '开始课堂' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: '继续' })).not.toBeInTheDocument();
    expect(old.dispose).toHaveBeenCalledOnce();
    const oldPlays = old.play.mock.calls.length;
    await advance(10_000);
    expect(old.play).toHaveBeenCalledTimes(oldPlays);
    await click('开始课堂');
    expect(harness.sessions).toHaveLength(2);
    await click('下一词');
    expect(harness.sessions[1].play).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ english: 'photosynthesis' }) }),
      0,
    );
  });

  it('四拍读两次可一键改为四次，范围覆盖手动值需明确允许且始终保留锁定', async () => {
    const current = lesson();
    current.gameData.soundMode = 'chorus';
    const locked = structuredClone(getEntries(current)[1]);
    locked.id = 'locked-third';
    locked.english = 'locked word';
    current.gameData.segments[0].entries.push(locked);
    getEntries(current).forEach((entry) => {
      entry.chorus = {
        beats: { value: 4, source: 'manual', locked: false },
        beatsPerRead: { value: 2, source: 'manual', locked: entry.id === locked.id },
      };
    });
    const original = structuredClone(current);
    const view = render(<WordBeatClassroom lesson={current} assets={{}} />);
    await click('课堂设置');
    await click('此词四拍读四次');
    expect(screen.getByRole('combobox', { name: '每次朗读占用拍数' })).toHaveValue('1');
    await selectWord(getEntries(current)[1].id);
    expect(screen.getByRole('combobox', { name: '每次朗读占用拍数' })).toHaveValue('2');
    await click('范围内四拍读四次');
    expect(screen.getByRole('combobox', { name: '每次朗读占用拍数' })).toHaveValue('2');
    fireEvent.click(screen.getByRole('checkbox', { name: '同时调整手动值（保留锁定）' }));
    expect(screen.getByRole('combobox', { name: '每次朗读占用拍数' })).toHaveValue('1');
    await selectWord(locked.id);
    expect(screen.getByRole('combobox', { name: '每次朗读占用拍数' })).toHaveValue('2');
    expect(screen.getByRole('combobox', { name: '每次朗读占用拍数' })).toBeDisabled();
    await click('完成设置');
    const stored = JSON.parse(localStorage.getItem(localStorage.key(0)!)!);
    expect(
      stored.settings.chorus.map(
        (entry: { beatsPerRead: { value: number } }) => entry.beatsPerRead.value,
      ),
    ).toEqual([1, 1, 2]);
    expect(current).toEqual(original);
    view.unmount();
    render(<WordBeatClassroom lesson={current} assets={{}} />);
    await click('课堂设置');
    await selectWord(getEntries(current)[1].id);
    expect(screen.getByRole('combobox', { name: '每次朗读占用拍数' })).toHaveValue('1');
    await selectWord(locked.id);
    expect(screen.getByRole('combobox', { name: '每次朗读占用拍数' })).toHaveValue('2');
  });

  it('范围四拍读四次后逐词改八拍，保存重开不会被旧批量目标覆盖', async () => {
    const current = lesson();
    current.gameData.soundMode = 'chorus';
    getEntries(current).forEach((entry) => {
      entry.chorus = {
        beats: { value: 4, source: 'manual', locked: false },
        beatsPerRead: { value: 2, source: 'manual', locked: false },
      };
    });
    const original = structuredClone(current);
    const [first, second] = getEntries(current);
    const view = render(<WordBeatClassroom lesson={current} assets={{}} />);
    await click('课堂设置');
    await click('范围内四拍读四次');
    fireEvent.click(screen.getByRole('checkbox', { name: '同时调整手动值（保留锁定）' }));
    expect(screen.getByRole('combobox', { name: '每次朗读占用拍数' })).toHaveValue('1');
    await selectWord(second.id);
    // 范围预览先落为当前草稿，随后教师的逐词八拍应成为最新决定。
    fireEvent.change(screen.getByLabelText('每轮总拍数', { exact: true }), {
      target: { value: '8' },
    });
    await selectWord(first.id);
    expect(screen.getByLabelText('每轮总拍数', { exact: true })).toHaveValue(4);
    expect(screen.getByRole('combobox', { name: '每次朗读占用拍数' })).toHaveValue('1');
    await click('完成设置');
    const stored = JSON.parse(localStorage.getItem(localStorage.key(0)!)!);
    expect(stored.settings.chorus).toEqual([
      expect.objectContaining({
        id: first.id,
        beats: expect.objectContaining({ value: 4 }),
        beatsPerRead: expect.objectContaining({ value: 1 }),
      }),
      expect.objectContaining({
        id: second.id,
        beats: expect.objectContaining({ value: 8 }),
        beatsPerRead: expect.objectContaining({ value: 1 }),
      }),
    ]);
    expect(current).toEqual(original);
    view.unmount();
    render(<WordBeatClassroom lesson={current} assets={{}} />);
    await click('课堂设置');
    for (const [id, beats] of [
      [first.id, 4],
      [second.id, 8],
    ] as const) {
      await selectWord(id);
      expect(screen.getByLabelText('每轮总拍数', { exact: true })).toHaveValue(beats);
      expect(screen.getByRole('combobox', { name: '每次朗读占用拍数' })).toHaveValue('1');
    }
  });

  it.each(['删除当前词', '下移当前词'])(
    '%s后撤销只恢复词表结构，不覆盖随后修改的其他词文本和练习安排',
    async (operation) => {
      const current = lesson();
      current.gameData.soundMode = 'chorus';
      const original = structuredClone(current);
      const [first, second] = getEntries(current);
      render(<WordBeatClassroom lesson={current} assets={{}} />);
      await click('课堂设置');
      await selectWord(first.id);
      await click(operation);
      // 删除后只剩一词会隐藏无意义的选词列表，组件已自动选中该词。
      if (operation !== '删除当前词') await selectWord(second.id);
      fireEvent.change(screen.getByRole('textbox', { name: '英文／短语' }), {
        target: { value: 'later classroom edit' },
      });
      fireEvent.change(screen.getByRole('textbox', { name: '教学释义' }), {
        target: { value: '结构操作后的教学调整' },
      });
      fireEvent.change(screen.getByRole('spinbutton', { name: '当前词轮数' }), {
        target: { value: '5' },
      });
      fireEvent.change(screen.getByLabelText('每轮总拍数', { exact: true }), {
        target: { value: '8' },
      });
      fireEvent.change(screen.getByRole('combobox', { name: '每次朗读占用拍数' }), {
        target: { value: '2' },
      });
      // 结构撤销的边界仅为增删与顺序；已存在条目的后续教学编辑必须保留。
      await click('撤销上次词表操作');
      expect(
        within(screen.getByRole('listbox'))
          .getAllByRole('option')
          .map((item) => item.getAttribute('data-entry-id')),
      ).toEqual([first.id, second.id]);
      await selectWord(second.id);
      expect(screen.getByRole('textbox', { name: '英文／短语' })).toHaveValue(
        'later classroom edit',
      );
      expect(screen.getByRole('textbox', { name: '教学释义' })).toHaveValue('结构操作后的教学调整');
      expect(screen.getByRole('spinbutton', { name: '当前词轮数' })).toHaveValue(5);
      expect(screen.getByLabelText('每轮总拍数', { exact: true })).toHaveValue(8);
      expect(screen.getByRole('combobox', { name: '每次朗读占用拍数' })).toHaveValue('2');
      await click('完成设置');
      const stored = JSON.parse(localStorage.getItem(localStorage.key(0)!)!);
      expect(stored.settings.entries).toEqual([
        { id: first.id, english: first.english, meaning: first.meaning },
        { id: second.id, english: 'later classroom edit', meaning: '结构操作后的教学调整' },
      ]);
      expect(stored.settings.rounds[1]).toMatchObject({ id: second.id, value: 5 });
      expect(stored.settings.chorus[1]).toMatchObject({
        id: second.id,
        beats: { value: 8 },
        beatsPerRead: { value: 2 },
      });
      expect(current).toEqual(original);
    },
  );

  it.each(['', '0'])(
    '统一轮数原始输入%s非法时删除到单词，不能因范围面板隐藏而放行保存',
    async (raw) => {
      render(<WordBeatClassroom lesson={lesson()} assets={{}} />);
      await click('课堂设置');
      // 原课件轮数不同，范围共同值初始为空；先输入再清空才是真实的未完成编辑。
      fireEvent.change(screen.getByRole('spinbutton', { name: '统一轮数' }), {
        target: { value: '2' },
      });
      fireEvent.change(screen.getByRole('spinbutton', { name: '统一轮数' }), {
        target: { value: raw },
      });
      expect(screen.getByRole('button', { name: '完成设置' })).toBeDisabled();
      expect(screen.getByRole('button', { name: '删除当前词' })).toBeDisabled();
      await click('删除当前词');
      // 非法范围输入仍是未完成的教师意图，不能因条目数减少被当作合法旧值。
      expect(screen.getByRole('button', { name: '完成设置' })).toBeDisabled();
      expect(screen.getByRole('spinbutton', { name: '统一轮数' })).toHaveValue(
        raw === '' ? null : 0,
      );
      expect(localStorage.length).toBe(0);
    },
  );

  it('取消最后一个重点后仍明确保留原范围，教师选择全部后才扩大统一轮数作用范围', async () => {
    const current = lesson();
    const second = getEntries(current)[1];
    render(<WordBeatClassroom lesson={current} assets={{}} />);
    await click('课堂设置');
    fireEvent.change(screen.getByRole('combobox', { name: '统一调整范围' }), {
      target: { value: 'priority' },
    });
    await selectWord(second.id);
    fireEvent.click(screen.getByRole('checkbox', { name: '重点词' }));
    // 不能把已选的“仅重点词”伪装成全部，更不能擅自扩大教师确认的范围。
    expect(screen.getByRole('combobox', { name: '统一调整范围' })).toHaveValue('priority');
    fireEvent.change(screen.getByRole('combobox', { name: '统一调整范围' }), {
      target: { value: 'all' },
    });
    fireEvent.change(screen.getByRole('spinbutton', { name: '统一轮数' }), {
      target: { value: '4' },
    });
    await click('完成设置');
    const stored = JSON.parse(localStorage.getItem(localStorage.key(0)!)!);
    expect(stored.settings.rounds.map((entry: { value: number }) => entry.value)).toEqual([4, 4]);
  });

  it.each(['word', 'phrase'] as const)(
    '已保存的课堂新增%s可再次切换词型并恢复，含空格不覆盖明确选择',
    async (initialType) => {
      const current = lesson();
      current.gameData.soundMode = 'chorus';
      const original = structuredClone(current);
      const view = render(<WordBeatClassroom lesson={current} assets={{}} />);
      await click('课堂设置');
      await click('新增词语');
      const added = within(screen.getByRole('listbox'))
        .getByRole('option', { selected: true })
        .getAttribute('data-entry-id')!;
      fireEvent.change(screen.getByRole('textbox', { name: '英文／短语' }), {
        target: { value: 'take a breath' },
      });
      fireEvent.change(screen.getByRole('combobox', { name: '词语类型' }), {
        target: { value: initialType },
      });
      await click('完成设置');
      await click('课堂设置');
      await selectWord(added);
      const changedType = initialType === 'word' ? 'phrase' : 'word';
      fireEvent.change(screen.getByRole('combobox', { name: '词语类型' }), {
        target: { value: changedType },
      });
      // 新词的隐藏模式默认参数始终从原课件边界重建，不能因已经保存过而误作原词。
      await click('完成设置');
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      const stored = JSON.parse(localStorage.getItem(localStorage.key(0)!)!);
      expect(
        stored.settings.practice.find((entry: { id: string }) => entry.id === added),
      ).toMatchObject({
        entryType: changedType,
        entryTypeSource: 'manual',
      });
      expect(current).toEqual(original);
      view.unmount();
      render(<WordBeatClassroom lesson={current} assets={{}} />);
      await click('课堂设置');
      await selectWord(added);
      expect(screen.getByRole('combobox', { name: '词语类型' })).toHaveValue(changedType);
      expect(screen.getByRole('button', { name: '完成设置' })).toBeEnabled();
    },
  );

  it('配音课堂新增词没有示范音频时阻止保存，明确改为文字领读后才可入本地词表', async () => {
    const current = lesson();
    current.gameData.soundMode = 'voiced';
    const { playable, assets } = withEntryRecordings(current);
    render(<WordBeatClassroom lesson={playable} assets={assets} />);
    await click('课堂设置');
    await click('新增词语');
    fireEvent.change(screen.getByRole('textbox', { name: '英文／短语' }), {
      target: { value: 'new word without recording' },
    });
    expect(screen.getByRole('button', { name: '完成设置' })).toBeDisabled();
    expect(localStorage.length).toBe(0);
    await click('本课改为文字领读');
    expect(screen.getByRole('button', { name: '完成设置' })).toBeEnabled();
    await click('完成设置');
    const stored = JSON.parse(localStorage.getItem(localStorage.key(0)!)!);
    expect(stored.settings.soundMode).toBe('teacher');
    expect(stored.settings.entries.at(-1).english).toBe('new word without recording');
    expect(getEntries(playable)).toHaveLength(2);
  });
});

describe('课堂设置统一校验与会话保留', () => {
  it('先还原统一目标不残留批量值，连续完成的撤销只退最近一笔', async () => {
    const current = lesson();
    current.gameData.soundMode = 'chorus';
    render(<WordBeatClassroom lesson={current} assets={{}} />);
    await click('课堂设置');
    fireEvent.change(screen.getByLabelText('统一总拍数'), { target: { value: '8' } });
    await click('还原统一总拍数');
    fireEvent.change(screen.getByRole('combobox', { name: '每次朗读占用拍数' }), {
      target: { value: '2' },
    });
    expect(screen.getByLabelText('每轮总拍数', { exact: true })).toHaveValue(4);
    expect(screen.getByRole('combobox', { name: '每次朗读占用拍数' })).toHaveValue('2');
    await click('完成设置');
    await click('课堂设置');
    fireEvent.change(screen.getByLabelText('每轮总拍数', { exact: true }), {
      target: { value: '8' },
    });
    await click('完成设置');
    await click('课堂设置');
    fireEvent.change(screen.getByLabelText('每轮总拍数', { exact: true }), {
      target: { value: '16' },
    });
    await click('完成设置');
    await click('课堂设置');
    await click('撤销上次齐读拍数调整');
    expect(screen.getByLabelText('每轮总拍数', { exact: true })).toHaveValue(8);
    expect(screen.getByRole('combobox', { name: '每次朗读占用拍数' })).toHaveValue('2');
  });

  it('齐读直接字段显示真实混合值，选择词和范围只定位原安排，不产生修改', async () => {
    const current = lesson();
    current.gameData.soundMode = 'chorus';
    const entries = getEntries(current);
    entries.forEach((entry) => {
      entry.chorus = {
        beats: { value: entry.priority ? 8 : 4, source: 'preset', locked: false },
        beatsPerRead: { value: entry.priority ? 2 : 1, source: 'preset', locked: false },
      };
    });
    render(<WordBeatClassroom lesson={current} assets={{}} />);
    await click('课堂设置');
    const bulkBeats = () => screen.getByRole('spinbutton', { name: '统一总拍数' });
    const bulkPerRead = () => screen.getByRole('combobox', { name: '统一每次占拍' });
    expect(bulkBeats()).toBeVisible();
    expect(bulkBeats()).toHaveValue(null);
    expect(bulkBeats()).toHaveAttribute('placeholder', '各词不同，输入统一拍数');
    expect(bulkPerRead()).toHaveValue('');
    expect(screen.queryByRole('checkbox', { name: /统一.*拍/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '还原统一总拍数' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '还原统一每次占拍' })).toBeDisabled();
    await selectWord(entries[1].id);
    expect(screen.getByLabelText('每轮总拍数', { exact: true })).toHaveValue(8);
    expect(screen.getByRole('combobox', { name: '每次朗读占用拍数' })).toHaveValue('2');
    fireEvent.change(screen.getByRole('combobox', { name: '统一调整范围' }), {
      target: { value: 'priority' },
    });
    expect(bulkBeats()).toHaveValue(8);
    expect(bulkPerRead()).toHaveValue('2');
    expect(screen.queryByRole('button', { name: '放弃未完成输入' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox', { name: '统一调整范围' }), {
      target: { value: 'all' },
    });
    expect(bulkBeats()).toHaveValue(null);
    expect(bulkPerRead()).toHaveValue('');
    expect(screen.getByRole('button', { name: '完成设置' })).toBeEnabled();
    expect(entries.map((entry) => entry.chorus!.beats.value)).toEqual([4, 8]);
  });

  it('齐读范围直接编辑单字段且独立还原，空白目标不能冒充保持原安排', async () => {
    const current = lesson();
    current.gameData.soundMode = 'chorus';
    const entries = getEntries(current);
    entries.forEach((entry) => {
      entry.chorus = {
        beats: { value: entry.priority ? 8 : 4, source: 'preset', locked: false },
        beatsPerRead: { value: entry.priority ? 2 : 1, source: 'preset', locked: false },
      };
    });
    const view = render(<WordBeatClassroom lesson={current} assets={{}} />);
    await click('课堂设置');
    fireEvent.change(screen.getByRole('combobox', { name: '统一每次占拍' }), {
      target: { value: '1' },
    });
    fireEvent.change(screen.getByLabelText('统一总拍数'), { target: { value: '16' } });
    await click('还原统一总拍数');
    expect(screen.getByLabelText('统一总拍数')).toHaveValue(null);
    expect(screen.getByRole('combobox', { name: '统一每次占拍' })).toHaveValue('1');
    expect(screen.getByRole('button', { name: '还原统一每次占拍' })).toBeEnabled();
    // 未编辑的混合空白不是错误；教师清空已经输入的目标必须保留为非法草稿。
    fireEvent.change(screen.getByLabelText('统一总拍数'), { target: { value: '16' } });
    fireEvent.change(screen.getByLabelText('统一总拍数'), { target: { value: '' } });
    expect(screen.getByRole('button', { name: '完成设置' })).toBeDisabled();
    await click('还原统一总拍数');
    expect(screen.getByRole('button', { name: '完成设置' })).toBeEnabled();
    await click('完成设置');
    view.unmount();
    render(<WordBeatClassroom lesson={current} assets={{}} />);
    await click('课堂设置');
    await selectWord(entries[1].id);
    expect(screen.getByLabelText('每轮总拍数', { exact: true })).toHaveValue(8);
    expect(screen.getByRole('combobox', { name: '每次朗读占用拍数' })).toHaveValue('1');
    await selectWord(entries[0].id);
    expect(screen.getByLabelText('每轮总拍数', { exact: true })).toHaveValue(4);
    expect(entries.map((entry) => entry.chorus!.beatsPerRead.value)).toEqual([1, 2]);
  });

  it('仅改词间间隔不产生无效的拍数撤销入口', async () => {
    const current = lesson();
    current.gameData.soundMode = 'chorus';
    render(<WordBeatClassroom lesson={current} assets={{}} />);
    await click('课堂设置');
    fireEvent.change(screen.getByLabelText('词间间隔', { exact: true }), {
      target: { value: '4' },
    });
    await click('完成设置');
    await click('课堂设置');
    expect(screen.queryByRole('button', { name: '撤销上次齐读拍数调整' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('词间间隔', { exact: true })).toHaveValue(4);
  });

  it('齐读拍数组合草稿、范围保护、统一保存和重新打开完整恢复', async () => {
    const current = lesson();
    current.gameData.soundMode = 'chorus';
    getEntries(current).forEach((entry) => {
      entry.chorus = {
        beats: { value: 4, source: 'preset', locked: false },
        beatsPerRead: { value: 1, source: 'preset', locked: false },
      };
    });
    getEntries(current)[1].chorus!.beatsPerRead.value = 2;
    const view = render(<WordBeatClassroom lesson={current} assets={{}} />);
    await click('课堂设置');
    await selectWord(getEntries(current)[1].id);
    expect(screen.getByRole('combobox', { name: '每次朗读占用拍数' })).toHaveValue('2');
    fireEvent.change(screen.getByLabelText('每轮总拍数', { exact: true }), {
      target: { value: '3' },
    });
    expect(document.getElementById('classroom-rhythm-feedback')).toHaveTextContent(
      '3 拍不能分成每次 2 拍',
    );
    expect(screen.getByRole('button', { name: '完成设置' })).toBeDisabled();
    expect(screen.getByText(/暂不能计算新编排时长/)).toBeInTheDocument();
    await click('收起');
    expect(screen.getByRole('button', { name: '开始课堂' })).toBeDisabled();
    await click('课堂设置');
    expect(screen.getByLabelText('每轮总拍数', { exact: true })).toHaveValue(3);
    fireEvent.change(screen.getByRole('combobox', { name: '每次朗读占用拍数' }), {
      target: { value: '1' },
    });
    fireEvent.change(screen.getByLabelText('词间间隔', { exact: true }), {
      target: { value: '4' },
    });
    await click('完成设置');
    view.unmount();
    render(<WordBeatClassroom lesson={current} assets={{}} />);
    await click('课堂设置');
    await selectWord(getEntries(current)[1].id);
    expect(screen.getByLabelText('每轮总拍数', { exact: true })).toHaveValue(3);
    expect(screen.getByRole('combobox', { name: '每次朗读占用拍数' })).toHaveValue('1');
    expect(screen.getByLabelText('词间间隔', { exact: true })).toHaveValue(4);
    expect(getEntries(current)[1].chorus!.beats.value).toBe(4);
  });

  it('课中齐读占拍、拍数、间隔与BPM共同推迟，重读保留旧安排，切词与重玩安装新值', async () => {
    const current = lesson();
    current.gameData.soundMode = 'chorus';
    getEntries(current).forEach((item) => {
      item.rounds.value = 1;
    });
    render(<WordBeatClassroom lesson={current} assets={{}} />);
    await click('开始课堂');
    await click('下一词');
    await click('课堂设置');
    fireEvent.change(screen.getByLabelText('统一总拍数'), { target: { value: '8' } });
    fireEvent.change(screen.getByLabelText('统一每次占拍'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('节奏 BPM'), { target: { value: '120' } });
    fireEvent.change(screen.getByLabelText('词间间隔', { exact: true }), {
      target: { value: '2' },
    });
    await click('完成设置');
    await click('重读');
    expect(harness.sessions[0].play.mock.calls.at(-1)?.[0]).toMatchObject({
      kind: 'chorus',
      durationMs: 2400,
      data: { totalBeats: 4, beatsPerRead: 1 },
    });
    await click('下一词');
    await click('继续');
    expect(harness.sessions[0].play.mock.calls.at(-1)?.[0]).toMatchObject({
      kind: 'chorus',
      durationMs: 4000,
      data: { totalBeats: 8, beatsPerRead: 2 },
    });
    await click('结束课堂');
    await click('回到开始页');
    await click('课堂设置');
    expect(screen.getByLabelText('每轮总拍数', { exact: true })).toHaveValue(8);
    expect(screen.getByRole('combobox', { name: '每次朗读占用拍数' })).toHaveValue('2');
    expect(screen.getByLabelText('词间间隔', { exact: true })).toHaveValue(2);
  });

  it.each(['teacher', 'chorus', 'voiced'] as const)(
    '%s 统一完成才写本地；卸载重开恢复全部值，恢复取消无副作用',
    async (mode) => {
      const current = lesson();
      current.gameData.soundMode = mode;
      const assets = {};
      // 配音模式使用正式录音绑定，恢复测试不依赖系统语音。
      let playable = current;
      if (mode === 'voiced') {
        for (const entry of getEntries(current)) {
          const asset = {
            assetId: `audio-${entry.id}`,
            mimeType: 'audio/wav',
            durationMs: 900,
            byteLength: 44,
            sha256: 'a'.repeat(64),
          };
          Object.assign(assets, { [asset.assetId]: asset });
          playable = bindRecording(playable, entry.id, asset);
        }
      }
      const view = render(<WordBeatClassroom lesson={playable} assets={assets} />);
      await click('课堂设置');
      fireEvent.change(screen.getByRole('spinbutton', { name: '统一轮数' }), {
        target: { value: '4' },
      });
      expect(screen.getByRole('spinbutton', { name: '当前词轮数' })).toHaveValue(4);
      expect(screen.getByText(/每词 4 轮/u)).toBeInTheDocument();
      fireEvent.change(screen.getByRole('spinbutton', { name: '节奏 BPM' }), {
        target: { value: '120' },
      });
      fireEvent.change(screen.getByRole('spinbutton', { name: '节拍音量百分比' }), {
        target: { value: '35' },
      });
      fireEvent.click(screen.getByRole('checkbox', { name: '舞台特效' }));
      expect(screen.queryByRole('button', { name: '应用' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: '应用到范围内词语' })).not.toBeInTheDocument();
      expect(localStorage.length).toBe(0);
      await click('收起');
      expect(screen.getByRole('button', { name: '开始课堂' })).toBeDisabled();
      await click('课堂设置');
      await click('完成设置');
      expect(localStorage.length).toBe(1);
      view.unmount();
      render(<WordBeatClassroom lesson={playable} assets={assets} />);
      await click('课堂设置');
      expect(screen.getByRole('spinbutton', { name: '当前词轮数' })).toHaveValue(4);
      expect(screen.getByRole('spinbutton', { name: '节奏 BPM' })).toHaveValue(120);
      expect(screen.getByRole('spinbutton', { name: '节拍音量百分比' })).toHaveValue(35);
      expect(screen.getByRole('checkbox', { name: '舞台特效' })).not.toBeChecked();
      await click('恢复课件原始设置');
      await click('取消恢复');
      expect(localStorage.length).toBe(1);
      expect(screen.getByRole('spinbutton', { name: '当前词轮数' })).toHaveValue(4);
      await click('恢复课件原始设置');
      await click('确认恢复并返回开始页');
      expect(localStorage.length).toBe(0);
      await click('课堂设置');
      expect(screen.getByRole('spinbutton', { name: '当前词轮数' })).toHaveValue(2);
      expect(screen.getByRole('spinbutton', { name: '节奏 BPM' })).toHaveValue(100);
    },
  );

  it('保存失败保留草稿且不应用；可重试成功或明确仅本次使用', async () => {
    render(<WordBeatClassroom lesson={lesson()} assets={{}} />);
    await click('开始课堂');
    await click('课堂设置');
    fireEvent.change(screen.getByRole('spinbutton', { name: '节拍音量百分比' }), {
      target: { value: '35' },
    });
    const fail = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
    await click('完成设置');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('浏览器未能保存');
    expect(harness.sessions[0].setVolumes).not.toHaveBeenCalled();
    expect(screen.getByRole('spinbutton', { name: '节拍音量百分比' })).toHaveValue(35);
    fail.mockRestore();
    await click('完成设置');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(harness.sessions[0].setVolumes).toHaveBeenLastCalledWith(
      expect.objectContaining({ beat: 0.35 }),
    );
    const raw = localStorage.getItem(localStorage.key(0)!);
    await click('课堂设置');
    fireEvent.change(screen.getByRole('spinbutton', { name: '节拍音量百分比' }), {
      target: { value: '50' },
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    await click('完成设置');
    await click('仅本次使用');
    expect(screen.getByRole('status')).toHaveTextContent('未保存到浏览器');
    expect(localStorage.getItem(localStorage.key(0)!)).toBe(raw);
    expect(harness.sessions[0].setVolumes).toHaveBeenLastCalledWith(
      expect.objectContaining({ beat: 0.5 }),
    );
  });

  it('开始前有全屏，运行中无需打开设置即可结束，清空音源后可以重玩', async () => {
    render(<WordBeatClassroom lesson={lesson()} assets={{}} />);
    expect(screen.getByRole('button', { name: '全屏' })).toBeEnabled();
    await click('开始课堂');
    await click('下一词');
    await click('结束课堂');
    expect(screen.getByRole('heading', { name: '本次练习记录' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '全屏' })).toBeEnabled();
    await click('重新播放');
    expect(screen.getByRole('button', { name: '结束课堂' })).toBeEnabled();
  });

  it('默认批量建议也必须通过音乐长度校验，失败拦截完成，放弃后清除旧错误', async () => {
    const current = lesson();
    current.gameData.soundMode = 'chorus';
    for (const entry of getEntries(current)) entry.rounds.value = 1;
    current.gameData.music = {
      enabled: true,
      assetId: 'short-music',
      loop: false,
      syncEnabled: true,
      sync: { bpm: 100, firstBeatMs: 0, loopStartMs: 0, loopEndMs: 6000 },
    };
    const asset = {
      assetId: 'short-music',
      mimeType: 'audio/wav',
      durationMs: 6000,
      byteLength: 3,
      sha256: 'a'.repeat(64),
    };
    render(<WordBeatClassroom lesson={current} assets={{ 'short-music': asset }} />);
    await click('课堂设置');
    expect(screen.getByRole('button', { name: '完成设置' })).toBeEnabled();
    // 原段两词各一轮共4.8秒；统一两轮需9.6秒，完整候选校验拒绝保存。
    fireEvent.change(screen.getByRole('spinbutton', { name: '统一轮数' }), {
      target: { value: '2' },
    });
    expect(screen.getByRole('alert')).toHaveTextContent('音乐不足以覆盖完整段落');
    expect(screen.getByRole('button', { name: '完成设置' })).toBeDisabled();
    await click('收起');
    await click('课堂设置');
    expect(screen.getByRole('alert')).toHaveTextContent('音乐不足以覆盖完整段落');
    await click('放弃未完成输入');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '完成设置' })).toBeEnabled();
    fireEvent.change(screen.getByRole('spinbutton', { name: '当前词轮数' }), {
      target: { value: '3' },
    });
    expect(screen.getByRole('alert')).toHaveTextContent('音乐不足以覆盖完整段落');
    await click('收起');
    await click('课堂设置');
    expect(screen.getByRole('alert')).toHaveTextContent('音乐不足以覆盖完整段落');
    await click('放弃未完成输入');
    fireEvent.change(screen.getByRole('spinbutton', { name: '当前词轮数' }), {
      target: { value: '' },
    });
    expect(screen.queryByText(/音乐不足以覆盖完整段落/)).not.toBeInTheDocument();
    await click('放弃未完成输入');
    await click('完成设置');
    await click('开始课堂');
    expect(harness.sessions[0].play).toHaveBeenCalled();
  });

  it.each(['201', '-1', '', '12.5'])(
    '非法音量 %s 不完成、不试听，收起后键盘也不能开局',
    async (raw) => {
      render(<WordBeatClassroom lesson={lesson()} assets={{}} />);
      await click('课堂设置');
      const input = screen.getByRole('spinbutton', { name: '节拍音量百分比' });
      fireEvent.change(input, { target: { value: raw } });
      expect(input).toHaveAttribute('aria-invalid', 'true');
      await click('完成设置');
      expect(screen.getByRole('dialog')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '测试声音' })).toBeDisabled();
      await click('收起');
      expect(screen.getByRole('button', { name: '开始课堂' })).toBeDisabled();
      fireEvent.keyDown(document.body, { code: 'Space' });
      expect(harness.sessions).toHaveLength(0);
      await click('课堂设置');
      expect(screen.getByRole('spinbutton', { name: '节拍音量百分比' })).toHaveValue(
        raw === '' ? null : Number(raw),
      );
      await click('放弃未完成输入');
      expect(screen.getByRole('spinbutton', { name: '节拍音量百分比' })).toHaveValue(20);
      await click('完成设置');
      await click('开始课堂');
      expect(harness.sessions[0].play).toHaveBeenCalled();
    },
  );

  it('已应用音量保留，非法草稿不混音；停止试听始终可用', async () => {
    render(<WordBeatClassroom lesson={lesson()} assets={{}} />);
    await click('课堂设置');
    await click('测试声音');
    const input = screen.getByRole('spinbutton', { name: '节拍音量百分比' });
    for (const value of ['0', '100', '35']) {
      fireEvent.change(input, { target: { value } });
      expect(harness.sessions[0].setVolumes).toHaveBeenLastCalledWith(
        expect.objectContaining({ beat: Number(value) / 100 }),
      );
      expect(screen.getByRole('button', { name: '完成设置' })).toBeEnabled();
    }
    fireEvent.change(input, { target: { value: '201' } });
    expect(harness.sessions[0].setVolumes).toHaveBeenCalledTimes(4);
    await click('停止测试');
    expect(harness.sessions[0].dispose).toHaveBeenCalledOnce();
    await click('放弃未完成输入');
    expect(input).toHaveValue(20);
  });

  it('长口号试听沿用最新语音音量，短伴奏停止后修改音量不重新开启伴奏', async () => {
    const current = lesson();
    current.gameData.slogans.opening.enabled = true;
    const asset = {
      assetId: 'long-opening',
      mimeType: 'audio/wav',
      durationMs: 4000,
      byteLength: 44,
      sha256: 'a'.repeat(64),
    };
    const playable = bindRecording(current, current.gameData.slogans.opening.id, asset);
    render(<WordBeatClassroom lesson={playable} assets={{ [asset.assetId]: asset }} />);
    await click('课堂设置');
    await click('测试声音');
    fireEvent.change(screen.getByRole('spinbutton', { name: '口号音量百分比' }), {
      target: { value: '35' },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1900);
    });
    expect(harness.sessions[0].setVolumes).toHaveBeenLastCalledWith({
      voice: 0.35,
      beat: 0,
      music: 0,
    });
    fireEvent.change(screen.getByRole('spinbutton', { name: '节拍音量百分比' }), {
      target: { value: '50' },
    });
    fireEvent.change(screen.getByRole('spinbutton', { name: '口号音量百分比' }), {
      target: { value: '45' },
    });
    expect(harness.sessions[0].setVolumes).toHaveBeenLastCalledWith({
      voice: 0.45,
      beat: 0,
      music: 0,
    });
    expect(screen.getByRole('spinbutton', { name: '节拍音量百分比' })).toHaveValue(50);
    await click('停止测试');
    expect(harness.sessions[0].dispose).toHaveBeenCalledOnce();
  });

  it.each([
    { mode: 'voiced', slogan: false, label: '示范' },
    { mode: 'teacher', slogan: true, label: '口号' },
    { mode: 'voiced', slogan: true, label: '示范 / 口号' },
    { mode: 'chorus', slogan: false, label: null },
  ] as const)(
    '$mode 课堂的语音音量仅标记实际使用的声部（$label）',
    async ({ mode, slogan, label }) => {
      const current = lesson();
      current.gameData.soundMode = mode;
      current.gameData.slogans.opening.enabled = slogan;
      const assets = {};
      let playable = current;
      // 每种模式都保留已绑定的示范音频；音量标签必须依据实际时间轴，不能依据素材是否存在。
      for (const entry of getEntries(current)) {
        const asset = {
          assetId: `voice-label-${entry.id}`,
          mimeType: 'audio/wav',
          durationMs: 900,
          byteLength: 44,
          sha256: 'a'.repeat(64),
        };
        Object.assign(assets, { [asset.assetId]: asset });
        playable = bindRecording(playable, entry.id, asset);
      }
      if (slogan) {
        const asset = {
          assetId: 'voice-label-opening',
          mimeType: 'audio/wav',
          durationMs: 900,
          byteLength: 44,
          sha256: 'b'.repeat(64),
        };
        Object.assign(assets, { [asset.assetId]: asset });
        playable = bindRecording(playable, current.gameData.slogans.opening.id, asset);
      }
      render(<WordBeatClassroom lesson={playable} assets={assets} />);
      await click('课堂设置');
      const voiceLabels = ['示范', '口号', '示范 / 口号'];
      for (const candidate of voiceLabels) {
        const control = screen.queryByRole('spinbutton', { name: `${candidate}音量百分比` });
        if (candidate === label) expect(control).toBeVisible();
        else expect(control).not.toBeInTheDocument();
      }
    },
  );

  it('未编辑批量输入反映真实轮数；混合留空可完成，放弃和返回开始不虚构一轮', async () => {
    render(<WordBeatClassroom lesson={lesson()} assets={{}} />);
    await click('课堂设置');
    const bulk = () => screen.getByRole('spinbutton', { name: '统一轮数' });
    expect(bulk()).toHaveValue(null);
    expect(bulk()).toHaveAttribute('aria-invalid', 'false');
    expect(screen.getByText(/当前范围各词轮数不同/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '完成设置' })).toBeEnabled();
    fireEvent.change(bulk(), { target: { value: '3' } });
    await click('完成设置');
    await click('课堂设置');
    expect(bulk()).toHaveValue(3);
    expect(screen.getByText(/当前范围每词 3 轮/)).toBeInTheDocument();
    fireEvent.change(screen.getByRole('spinbutton', { name: '节奏 BPM' }), {
      target: { value: '120' },
    });
    await click('放弃未完成输入');
    expect(bulk()).toHaveValue(3);
    await click('完成设置');
    await click('开始课堂');
    await click('结束课堂');
    await click('回到开始页');
    await click('课堂设置');
    expect(bulk()).toHaveValue(3);
    expect(screen.getByText(/当前范围每词 3 轮/)).toBeInTheDocument();
  });

  it('只切批量范围不产生修改，编辑目标后切范围保留目标且只影响新范围', async () => {
    const current = lesson();
    const [first, second] = getEntries(current);
    render(<WordBeatClassroom lesson={current} assets={{}} />);
    await click('课堂设置');
    const scope = () => screen.getByRole('combobox', { name: '统一调整范围' });
    const bulk = () => screen.getByRole('spinbutton', { name: '统一轮数' });
    fireEvent.change(scope(), { target: { value: 'priority' } });
    expect(bulk()).toHaveValue(3);
    expect(screen.getByRole('button', { name: '完成设置' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: '放弃未完成输入' })).not.toBeInTheDocument();
    fireEvent.change(scope(), { target: { value: 'all' } });
    expect(bulk()).toHaveValue(null);
    expect(bulk()).toHaveAttribute('aria-invalid', 'false');
    await click('完成设置');
    await click('课堂设置');
    expect(wordOption(first.id)).toHaveTextContent('2轮');
    expect(wordOption(second.id)).toHaveTextContent('3轮');
    fireEvent.change(bulk(), { target: { value: '4' } });
    fireEvent.change(scope(), { target: { value: 'normal' } });
    expect(bulk()).toHaveValue(4);
    expect(screen.getByText(/将调整 1 词/)).toBeInTheDocument();
    await click('完成设置');
    await click('课堂设置');
    expect(wordOption(first.id)).toHaveTextContent('4轮');
    expect(wordOption(second.id)).toHaveTextContent('3轮');
  });

  it('BPM 和批量草稿由底部统一完成，收起不丢失作用范围', async () => {
    const current = lesson();
    render(<WordBeatClassroom lesson={current} assets={{}} />);
    await click('课堂设置');
    fireEvent.change(screen.getByRole('spinbutton', { name: '节奏 BPM' }), {
      target: { value: '120' },
    });
    expect(screen.getByRole('button', { name: '完成设置' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: '应用' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox', { name: '统一调整范围' }), {
      target: { value: 'priority' },
    });
    fireEvent.change(screen.getByRole('spinbutton', { name: '统一轮数' }), {
      target: { value: '9' },
    });
    await click('收起');
    await click('课堂设置');
    expect(screen.getByRole('combobox', { name: '统一调整范围' })).toHaveValue('priority');
    expect(screen.getByRole('spinbutton', { name: '统一轮数' })).toHaveValue(9);
    expect(screen.getByRole('button', { name: '完成设置' })).toBeDisabled();
    fireEvent.change(screen.getByRole('spinbutton', { name: '统一轮数' }), {
      target: { value: '4' },
    });
    expect(screen.getByRole('button', { name: '完成设置' })).toBeEnabled();
    await click('完成设置');
    await click('课堂设置');
    expect(wordOption(getEntries(current)[1].id)).toHaveTextContent('4轮');
  });

  it('全部设置统一完成后，重开重玩及返回开始均保留本地值', async () => {
    const current = lesson();
    const before = structuredClone(current);
    render(<WordBeatClassroom lesson={current} assets={{}} />);
    await click('课堂设置');
    fireEvent.change(screen.getByRole('spinbutton', { name: '当前词轮数' }), {
      target: { value: '3' },
    });
    fireEvent.change(screen.getByRole('spinbutton', { name: '节奏 BPM' }), {
      target: { value: '120' },
    });
    fireEvent.change(screen.getByRole('combobox', { name: '推进方式' }), {
      target: { value: 'step' },
    });
    fireEvent.change(screen.getByRole('combobox', { name: '展示模式' }), {
      target: { value: 'centered' },
    });
    for (const name of ['整课循环', '继续前准备两拍'])
      fireEvent.click(screen.getByRole('checkbox', { name }));
    for (const name of ['显示释义', '舞台特效', '显示前后词预告'])
      fireEvent.click(screen.getByRole('checkbox', { name }));
    fireEvent.change(screen.getByRole('spinbutton', { name: '节拍音量百分比' }), {
      target: { value: '35' },
    });
    const verify = () => {
      expect(screen.getByRole('spinbutton', { name: '当前词轮数' })).toHaveValue(3);
      expect(screen.getByRole('spinbutton', { name: '节奏 BPM' })).toHaveValue(120);
      expect(screen.getByRole('spinbutton', { name: '节拍音量百分比' })).toHaveValue(35);
      expect(screen.getByRole('combobox', { name: '推进方式' })).toHaveValue('step');
      expect(screen.getByRole('combobox', { name: '展示模式' })).toHaveValue('centered');
      for (const name of ['整课循环', '继续前准备两拍'])
        expect(screen.getByRole('checkbox', { name })).toBeChecked();
      for (const name of ['显示释义', '舞台特效', '显示前后词预告'])
        expect(screen.getByRole('checkbox', { name })).not.toBeChecked();
    };
    await click('完成设置');
    await click('课堂设置');
    verify();
    await click('完成设置');
    await click('开始课堂');
    await click('课堂设置');
    verify();
    fireEvent.change(screen.getByRole('spinbutton', { name: '节拍音量百分比' }), {
      target: { value: '201' },
    });
    await click('结束本次课堂');
    await click('重新播放');
    await click('课堂设置');
    verify();
    await click('结束本次课堂');
    await click('回到开始页');
    await click('课堂设置');
    verify();
    expect(current).toEqual(before);
  });
});

describe('课堂教师控制与焦点边界', () => {
  it.each(['centered', 'blocks'] as const)(
    '%s 单组准备不重复组名，齐读仍保留四个真实词槽',
    async (displayMode) => {
      const current = lesson();
      current.gameData.soundMode = 'chorus';
      current.gameData.displayMode = displayMode;
      // 空段不参与编排，不能因此把唯一有效组显示成第二组。
      current.gameData.segments.unshift({ id: 'empty', name: '空组', entries: [] });
      const view = render(<WordBeatClassroom lesson={current} assets={{}} />);
      await click('开始课堂');
      expect(view.container.querySelector('.ecg-classroom-progress')).toHaveTextContent('2 词');
      expect(view.container.querySelector('.ecg-classroom-progress')).not.toHaveTextContent('组');
      expect(screen.queryByText('第 1 组')).not.toBeInTheDocument();
      expect(
        screen.getByLabelText('4 拍准备提示').querySelectorAll('.ecg-beat-block'),
      ).toHaveLength(4);
      expect(view.container.querySelectorAll('.ecg-beat-word')).toHaveLength(0);
      await click('下一词');
      const pads = view.container.querySelectorAll('.ecg-beat-word');
      expect(pads).toHaveLength(4);
      for (const pad of pads) expect(pad).toHaveAttribute('data-word', 'photosynthesis');
      expect(view.container.querySelector('.ecg-stage-tempo')).toHaveTextContent('1 / 4 拍');
      expect(view.container.querySelector('.ecg-classroom-detail')).not.toHaveTextContent('拍');
    },
  );

  it('多组保留位置及教师名称，后组准备只有两拍且不填朗读词槽', async () => {
    const current = lesson();
    const second = current.gameData.segments[0].entries.splice(1);
    current.gameData.segments.push(
      { id: 'empty', name: '空组', entries: [] },
      { id: 'second', name: '环保主题', entries: second },
    );
    const timeline = compileWordBeat(current, {});
    const view = render(<WordBeatClassroom lesson={current} assets={{}} />);
    await click('开始课堂');
    expect(view.container.querySelector('.ecg-classroom-progress')).toHaveTextContent('第 1 组');
    expect(screen.getByText('第 1 组')).toBeInTheDocument();
    for (const cue of timeline.cues) {
      if (cue.kind === 'preparation' && cue.sectionIndex === 1) break;
      await advance(cue.durationMs);
    }
    expect(view.container.querySelector('.ecg-classroom-progress')).toHaveTextContent('第 2 组');
    expect(screen.getByText('环保主题')).toBeInTheDocument();
    expect(screen.getByLabelText('2 拍准备提示').querySelectorAll('.ecg-beat-block')).toHaveLength(
      2,
    );
    expect(view.container.querySelectorAll('.ecg-beat-word')).toHaveLength(0);
  });

  it('单词课堂直接调轮数，无前后词与批量入口；原有推进设置不被覆盖', async () => {
    const current = lesson('step');
    current.gameData.segments[0].entries.splice(1);
    const view = render(<WordBeatClassroom lesson={current} assets={{}} />);
    await click('课堂设置');
    expect(screen.queryByRole('listbox', { name: '选择要调整的词' })).not.toBeInTheDocument();
    expect(screen.queryByRole('spinbutton', { name: '统一轮数' })).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: '推进方式' })).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: '显示前后词预告' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole('spinbutton', { name: '当前词轮数' }), {
      target: { value: '4' },
    });
    await click('撤销上次轮数调整');
    expect(screen.getByRole('spinbutton', { name: '当前词轮数' })).toHaveValue(2);
    await click('完成设置');
    await click('开始课堂');
    expect(view.container.querySelector('.ecg-word-track')).not.toBeVisible();
    await click('下一词');
    expect(screen.getByRole('button', { name: '重读' })).toBeEnabled();
    expect(current.gameData.progression).toBe('step');
  });

  it('全部普通词不提供空重点范围或重复的普通范围', async () => {
    const current = lesson();
    for (const entry of getEntries(current)) entry.priority = false;
    render(<WordBeatClassroom lesson={current} assets={{}} />);
    await click('课堂设置');
    expect(screen.queryByRole('combobox', { name: '统一调整范围' })).not.toBeInTheDocument();
    expect(screen.getByRole('spinbutton', { name: '统一轮数' })).toBeInTheDocument();
    expect(screen.getByText('全部词语')).toBeInTheDocument();
  });

  it('课中未完成轮数输入阻止继续，结束后放弃草稿而不阻塞重玩', async () => {
    render(<WordBeatClassroom lesson={lesson()} assets={{}} />);
    await click('开始课堂');
    await click('下一词');
    await click('课堂设置');
    fireEvent.change(screen.getByRole('spinbutton', { name: '当前词轮数' }), {
      target: { value: '' },
    });
    await click('收起');
    expect(screen.getByRole('button', { name: '继续' })).toBeDisabled();
    await click('课堂设置');
    await click('结束本次课堂');
    await click('重新播放');
    expect(screen.getByRole('button', { name: '暂停' })).toBeInTheDocument();
  });
  it('齐读四拍每次两拍改轮数仍每轮读两次，时长随真实轮数更新', async () => {
    const current = lesson();
    current.gameData.soundMode = 'chorus';
    current.gameData.bpm.value = 100;
    for (const entry of getEntries(current)) {
      entry.chorus = {
        beats: { value: 4, source: 'manual', locked: false },
        beatsPerRead: { value: 2, source: 'manual', locked: false },
      };
    }
    render(<WordBeatClassroom lesson={current} assets={{}} />);
    await click('课堂设置');
    fireEvent.change(screen.getByRole('spinbutton', { name: '当前词轮数' }), {
      target: { value: '8' },
    });
    expect(
      screen.getByText(/每轮 4 拍 · 读 2 次 · 每次 2 拍 · 共 8 轮（合计提示 16 次）/),
    ).toBeInTheDocument();
    const changed = structuredClone(current);
    getEntries(changed)[0].rounds.value = 8;
    const expected = compileWordBeat(changed, {});
    expect(
      screen.getByText(new RegExp(`预计编排 ${(expected.durationMs / 1000).toFixed(1)} 秒`)),
    ).toBeInTheDocument();
    await click('完成设置');
    await click('开始课堂');
    await click('下一词');
    expect(harness.sessions[0].play).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: 'chorus',
        durationMs: 2400,
        data: expect.objectContaining({ roundCount: 8, totalBeats: 4, beatsPerRead: 2 }),
      }),
      0,
    );
  });

  it('待生效轮数与后续调速合并，最后一词修改在重玩时安装', async () => {
    const current = lesson();
    render(<WordBeatClassroom lesson={current} assets={{}} />);
    await click('开始课堂');
    await click('下一词');
    await click('下一词');
    await click('课堂设置');
    expect(wordOption(getEntries(current)[1].id)).toHaveAttribute('aria-selected', 'true');
    fireEvent.change(screen.getByRole('spinbutton', { name: '统一轮数' }), {
      target: { value: '1' },
    });
    fireEvent.change(screen.getByRole('spinbutton', { name: '节奏 BPM' }), {
      target: { value: '120' },
    });
    await click('完成设置');
    await click('课堂设置');
    await click('结束本次课堂');
    await click('重新播放');
    await click('下一词');
    expect(harness.sessions[0].play).toHaveBeenLastCalledWith(
      expect.objectContaining({
        pulseIntervalMs: 500,
        data: expect.objectContaining({ roundCount: 1 }),
      }),
      0,
    );
  });
  it('课前逐词轮数改变真实时间轴，非法草稿跨关闭保留，撤销不改原课件', async () => {
    const current = lesson();
    const original = structuredClone(current);
    render(<WordBeatClassroom lesson={current} assets={{}} />);
    await click('课堂设置');
    const input = screen.getByRole('spinbutton', { name: '当前词轮数' });
    fireEvent.change(input, { target: { value: '' } });
    await click('收起');
    expect(screen.getByRole('button', { name: '开始课堂' })).toBeDisabled();
    await click('课堂设置');
    expect(screen.getByRole('spinbutton', { name: '当前词轮数' })).toHaveValue(null);
    fireEvent.change(screen.getByRole('spinbutton', { name: '当前词轮数' }), {
      target: { value: '8' },
    });
    await click('完成设置');
    await click('开始课堂');
    await click('下一词');
    expect(harness.sessions[0].play).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ roundCount: 8 }) }),
      0,
    );
    await click('课堂设置');
    await click('撤销上次轮数调整');
    expect(screen.getByRole('spinbutton', { name: '当前词轮数' })).toHaveValue(
      getEntries(original)[0].rounds.value,
    );
    expect(current).toEqual(original);
  });

  it('课中缩减轮数不删除当前阶段，重读沿用旧轮数，切词才生效并用于重玩', async () => {
    const current = lesson();
    getEntries(current).forEach((entry) => {
      entry.rounds.value = 3;
    });
    render(<WordBeatClassroom lesson={current} assets={{}} />);
    await click('开始课堂');
    await click('下一词');
    await click('课堂设置');
    fireEvent.change(screen.getByRole('spinbutton', { name: '统一轮数' }), {
      target: { value: '1' },
    });
    await click('完成设置');
    await click('重读');
    await click('继续');
    expect(harness.sessions[0].play).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ roundCount: 3 }) }),
      0,
    );
    await click('下一词');
    expect(harness.sessions[0].play).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ roundCount: 1 }) }),
      0,
    );
    await click('课堂设置');
    await click('结束本次课堂');
    await click('重新播放');
    await click('下一词');
    expect(harness.sessions[0].play).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ roundCount: 1 }) }),
      0,
    );
  });

  it('范围调整保护手动和锁定，重点范围不波及普通词，逐词修改可撤销', async () => {
    const current = lesson();
    const [normal, priority] = getEntries(current);
    normal.rounds = { value: 7, source: 'manual', locked: true };
    render(<WordBeatClassroom lesson={current} assets={{}} />);
    await click('课堂设置');
    expect(screen.getByRole('spinbutton', { name: '当前词轮数' })).toBeDisabled();
    fireEvent.change(screen.getByRole('combobox', { name: '统一调整范围' }), {
      target: { value: 'priority' },
    });
    fireEvent.change(screen.getByRole('spinbutton', { name: '统一轮数' }), {
      target: { value: '8' },
    });
    await click('完成设置');
    await click('课堂设置');
    expect(screen.getByRole('spinbutton', { name: '当前词轮数' })).toHaveValue(7);
    await selectWord(priority.id);
    expect(screen.getByRole('spinbutton', { name: '当前词轮数' })).toHaveValue(8);
    fireEvent.change(screen.getByRole('spinbutton', { name: '当前词轮数' }), {
      target: { value: '2' },
    });
    expect(screen.getByText(/当前范围每词 2 轮；编辑后才统一调整/)).toBeInTheDocument();
    await click('撤销上次轮数调整');
    expect(screen.getByRole('spinbutton', { name: '当前词轮数' })).toHaveValue(8);
  });
  it('课前节奏、推进、循环和恢复准备进入首次键盘开局，原课件不变', async () => {
    const current = lesson();
    const original = structuredClone(current);
    render(<WordBeatClassroom lesson={current} assets={{}} />);
    await click('课堂设置');
    fireEvent.change(screen.getByLabelText('推进方式'), { target: { value: 'step' } });
    fireEvent.click(screen.getByLabelText('整课循环'));
    fireEvent.click(screen.getByLabelText('继续前准备两拍'));
    fireEvent.change(screen.getByRole('spinbutton', { name: '节奏 BPM' }), {
      target: { value: '120' },
    });
    await click('完成设置');
    expect(screen.getByRole('status')).toHaveTextContent('已保存到当前浏览器');
    expect(screen.getByText('推进方式：逐词等待教师')).toBeInTheDocument();
    await act(async () => {
      fireEvent.keyDown(document.body, { code: 'Space' });
    });
    expect(harness.sessions[0].play).toHaveBeenLastCalledWith(
      expect.objectContaining({ pulseIntervalMs: 500 }),
      0,
    );
    await click('下一词');
    await click('暂停');
    await click('继续');
    expect(harness.sessions[0].play).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: 'resume-preparation', durationMs: 1000 }),
      0,
    );
    await click('课堂设置');
    expect(screen.getByLabelText('整课循环')).toBeChecked();
    expect(current).toEqual(original);
  });

  it('恢复准备仅课前可调；运行中说明限制，回到开始页后恢复可编辑', async () => {
    render(<WordBeatClassroom lesson={lesson()} assets={{}} />);
    await click('课堂设置');
    expect(screen.getByRole('checkbox', { name: '继续前准备两拍' })).toBeEnabled();
    expect(screen.queryByText('仅课前调整；需要修改请回到开始页。')).not.toBeInTheDocument();
    await click('完成设置');
    await click('开始课堂');
    await click('课堂设置');
    expect(screen.getByRole('checkbox', { name: '继续前准备两拍' })).toBeDisabled();
    expect(screen.getByText('仅课前调整；需要修改请回到开始页。')).toBeVisible();
    await click('完成设置');
    await click('结束课堂');
    await click('回到开始页');
    await click('课堂设置');
    expect(screen.getByRole('checkbox', { name: '继续前准备两拍' })).toBeEnabled();
    expect(screen.queryByText('仅课前调整；需要修改请回到开始页。')).not.toBeInTheDocument();
  });

  it('新课默认节奏方块和自动推进，开始后无需切词即可完成整课', async () => {
    const current = lesson();
    expect(current.gameData.progression).toBe('auto');
    expect(current.gameData.displayMode).toBe('blocks');
    const plan = compileWordBeat(current, {});
    const view = render(<WordBeatClassroom lesson={current} assets={{}} />);
    expect(screen.getByText('推进方式：自动推进')).toBeInTheDocument();
    expect(view.container.firstElementChild).toHaveClass('ecg-classroom--blocks');
    await click('开始课堂');
    // 使用真实编排时长驱动真实状态机；本例从不点下一词、继续或跳过阶段。
    for (const cue of plan.cues) {
      await advance(cue.durationMs);
      expect(screen.queryByText('等待教师')).not.toBeInTheDocument();
    }
    expect(screen.getByText('练习完成')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '本次练习记录' })).toHaveFocus();
    expect(screen.getByLabelText(/已完成 2 \/ 2 条/)).toBeInTheDocument();
    expect(screen.getByLabelText(/主动重读 0 次/)).toBeInTheDocument();
    for (const itemIndex of [0, 1])
      expect(harness.sessions[0].play).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'model', itemIndex }),
        0,
      );
  });

  it.each(['none', 'valid', 'invalid'] as const)(
    '结束反馈只在真实存在%s草稿时说明放弃，返回开始仍使用已完成值',
    async (draft) => {
      render(<WordBeatClassroom lesson={lesson()} assets={{}} />);
      await click('开始课堂');
      await click('暂停');
      if (draft !== 'none') {
        await click('课堂设置');
        fireEvent.change(screen.getByRole('spinbutton', { name: '节奏 BPM' }), {
          target: { value: draft === 'valid' ? '120' : '0' },
        });
        await click('结束本次课堂');
      } else {
        await click('结束课堂');
      }
      expect(screen.getByRole('status')).toHaveTextContent(
        draft === 'none' ? '课堂已结束。' : '课堂已结束，已放弃未完成输入，保留上次完成的设置。',
      );
      if (draft === 'none')
        expect(screen.getByRole('status')).not.toHaveTextContent('已放弃未完成输入');
      await click('回到开始页');
      await click('课堂设置');
      expect(screen.getByRole('spinbutton', { name: '节奏 BPM' })).toHaveValue(100);
      expect(screen.getByRole('button', { name: '完成设置' })).toBeEnabled();
    },
  );

  it('提前结束无成功徽章，设置关闭接续结果焦点，重播和返回开始清理状态', async () => {
    const view = render(<WordBeatClassroom lesson={lesson()} assets={{}} />);
    await click('开始课堂');
    await click('下一词');
    await click('重读');
    await click('课堂设置');
    await click('结束本次课堂');
    expect(screen.getByRole('heading', { name: '本次练习记录' })).toHaveFocus();
    expect(view.container.querySelector('.ecg-stage-emblem--ended')).toBeInTheDocument();
    expect(view.container.querySelector('.ecg-completion-burst')).toBeNull();
    expect(screen.getByLabelText(/主动重读 1 次/)).toBeInTheDocument();
    await click('重新播放');
    expect(screen.getByText('已完成 0 / 2 词')).toBeInTheDocument();
    await click('课堂设置');
    await click('结束本次课堂');
    expect(screen.getByLabelText(/主动重读 0 次/)).toBeInTheDocument();
    await click('回到开始页');
    expect(screen.getByRole('button', { name: '开始课堂' })).toHaveFocus();
  });

  it('准备倒数使用真实四拍显示3、2、1、GO，暂停冻结后从原拍继续', async () => {
    render(<WordBeatClassroom lesson={lesson()} assets={{}} />);
    await click('开始课堂');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('3');
    await advance(600);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('2');
    await click('暂停');
    await advance(1200);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('2');
    await click('继续');
    await advance(600);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('1');
    await advance(600);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('GO');
    await advance(600);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('photosynthesis');
  });

  for (const mode of ['centered', 'blocks'] as const) {
    it.each([
      [1, 1],
      [2, 2],
      [3, 2],
      [5, 3],
    ])('%s拍示范接%s拍跟读在' + mode + '模式连续落拍，新轮重新开始', async (model, follow) => {
      const current = lesson();
      current.gameData.displayMode = mode;
      const entry = current.gameData.segments[0].entries[0];
      entry.modelBeats.value = model;
      entry.follow = { mode: 'manual', beats: follow, locked: false };
      entry.rounds.value = 2;
      const view = render(<WordBeatClassroom lesson={current} assets={{}} />);
      await click('开始课堂');
      await click('下一词');
      // 检查实际组件的高亮和词轨迹，不以存在四个装饰节点代替拍序正确。
      for (let round = 0; round < 2; round += 1) {
        for (let beat = 0; beat < model + follow; beat += 1) {
          const pads = [...view.container.querySelectorAll('.ecg-beat-block')];
          expect(pads.findIndex((pad) => pad.classList.contains('ecg-pulse-active'))).toBe(
            beat % 4,
          );
          expect(pads.filter((pad) => pad.getAttribute('data-reached') === 'true')).toHaveLength(
            Math.min(4, beat + 1),
          );
          expect(screen.getByText(beat < model ? '教师示范' : '跟读')).toBeInTheDocument();
          if (mode === 'blocks')
            expect(pads[beat % 4].querySelector('.ecg-beat-word')?.getAttribute('data-word')).toBe(
              entry.english,
            );
          await advance(600);
        }
      }
    });
  }

  it.each(['centered', 'blocks'] as const)(
    '自主齐读%s保留词槽，双拍不重复开始，32拍分页后词语仍在',
    async (mode) => {
      const current = lesson();
      current.gameData.soundMode = 'chorus';
      current.gameData.displayMode = mode;
      const entry = current.gameData.segments[0].entries[0];
      entry.chorus = {
        beats: { value: 32, source: 'manual', locked: false },
        beatsPerRead: { value: 2, source: 'manual', locked: false },
      };
      const view = render(<WordBeatClassroom lesson={current} assets={{}} />);
      await click('开始课堂');
      await click('下一词');
      const words = () => Array.from(view.container.querySelectorAll('.ecg-beat-word'));
      expect(words()).toHaveLength(4);
      expect(words().every((word) => word.getAttribute('data-word') === entry.english)).toBe(true);
      // 每次占两拍时，第二拍沿用同一次词语提示，不能重新创建入场动画。
      const firstWord = words()[0];
      await advance(600);
      expect(words()[0]).toBe(firstWord);
      expect(view.container.querySelector('.ecg-pulse-active .ecg-beat-number')).toHaveTextContent(
        '1',
      );
      for (let beat = 1; beat < 8; beat++) await advance(600);
      expect(view.container.querySelector('.ecg-beat-trail')).toHaveAttribute(
        'aria-label',
        '第 9 / 32 拍，朗读 5 / 16 次',
      );
      expect(view.container.querySelector('.ecg-beat-number')).toHaveTextContent('5');
      expect(words()).toHaveLength(4);
      expect(words().every((word) => word.getAttribute('data-word') === entry.english)).toBe(true);
      await click('暂停');
      expect(words().every((word) => word.getAttribute('data-word') === entry.english)).toBe(true);
    },
  );

  it('跟读暂停保留第三拍，独立恢复准备后续拍，等待终点保留第四拍', async () => {
    const current = lesson('step');
    current.gameData.resumePreparationBeats = 2;
    current.gameData.segments[0].entries[0].rounds.value = 1;
    const view = render(<WordBeatClassroom lesson={current} assets={{}} />);
    const activePad = () =>
      view.container.querySelector('.ecg-pulse-active .ecg-beat-number')?.textContent;
    await click('开始课堂');
    await click('下一词');
    await advance(1200);
    await advance(300);
    expect(activePad()).toBe('3');
    await click('暂停');
    await advance(1800);
    expect(activePad()).toBe('3');
    expect(view.container.querySelector('.ecg-beat-hit')).toBeNull();
    await click('继续');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('1');
    await advance(600);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('GO');
    await advance(600);
    expect(screen.getByText('跟读')).toBeInTheDocument();
    expect(activePad()).toBe('3');
    await advance(300);
    expect(activePad()).toBe('4');
    await advance(600);
    expect(screen.getByText('等待教师')).toBeInTheDocument();
    expect(activePad()).toBe('4');
    await click('重读');
    expect(activePad()).toBe('1');
    await click('暂停');
    await click('下一词');
    expect(activePad()).toBe('1');
    expect(screen.getByRole('button', { name: '继续' })).toBeInTheDocument();
  });

  it('HTML提前结束有真实标识与总数，返回开始页释放旧会话再重播', async () => {
    render(<WordBeatClassroom lesson={lesson()} assets={{}} />);
    await click('开始课堂');
    const audio = harness.sessions[0];
    await click('课堂设置');
    await click('结束本次课堂');
    expect(screen.getByText('已提前结束')).toBeInTheDocument();
    expect(screen.getByLabelText(/已完成 0 \/ 2 条/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '返回编辑' })).not.toBeInTheDocument();
    await click('回到开始页');
    expect(audio.dispose).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: '开始课堂' })).toBeInTheDocument();
    await click('开始课堂');
    expect(harness.sessions).toHaveLength(2);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('桌面成果预演使用返回成果标签，重新播放没有旧统计', async () => {
    const current = lesson();
    current.gameData.segments[0].entries.splice(1);
    const onExit = vi.fn();
    render(<WordBeatClassroom lesson={current} assets={{}} onExit={onExit} exitLabel="返回成果" />);
    await click('开始课堂');
    expect(screen.getByRole('button', { name: '返回成果' })).toBeInTheDocument();
    await advance(2400);
    for (let index = 0; index < 4; index++) await advance(1200);
    expect(screen.getByText('练习完成')).toBeInTheDocument();
    expect(screen.getByLabelText(/已完成 1 \/ 1 条/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '回到开始页' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '返回成果' })).toBeInTheDocument();
    await click('重新播放');
    expect(screen.queryByLabelText(/已完成 1 \/ 1 条/)).not.toBeInTheDocument();
    await click('返回成果');
    expect(onExit).toHaveBeenCalledOnce();
    expect(harness.sessions[0].dispose).toHaveBeenCalledOnce();
  });

  it('运行中资源等待后显示继续，不自动发声或推进词序', async () => {
    let ready!: () => void;
    render(<WordBeatClassroom lesson={lesson()} assets={{}} />);
    await click('开始课堂');
    harness.prepared = false;
    harness.prepareOnce = () =>
      new Promise<void>((resolve) => {
        ready = resolve;
      });
    const audio = harness.sessions[0];
    const calls = audio.play.mock.calls.length;
    await click('下一词');
    expect(screen.getByText('准备声音资源')).toBeInTheDocument();
    expect(audio.play).toHaveBeenCalledTimes(calls);
    await act(async () => {
      harness.prepared = true;
      ready();
    });
    expect(screen.getByText('声音已就绪，请点击继续')).toBeInTheDocument();
    expect(audio.play).toHaveBeenCalledTimes(calls);
    await click('继续');
    expect(audio.play).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: 'model', itemIndex: 0 }),
      0,
    );
  });
  it('抽屉限制焦点及快捷键，Esc收起回到触发按钮；失焦后需教师继续', async () => {
    render(<WordBeatClassroom lesson={lesson()} assets={{}} />);
    await click('开始课堂');
    await click('下一词');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('photosynthesis');
    expect(screen.getByRole('button', { name: '上一词' })).toBeDisabled();
    await click('课堂设置');
    const drawer = screen.getByRole('dialog', { name: '课堂设置' });
    expect(drawer).toContainElement(document.activeElement as HTMLElement);
    const bpm = within(drawer).getByRole('spinbutton', { name: '节奏 BPM' });
    bpm.focus();
    const calls = harness.sessions[0].play.mock.calls.length;
    fireEvent.keyDown(bpm, { code: 'ArrowRight', key: 'ArrowRight' });
    fireEvent.keyDown(bpm, { code: 'Space', key: ' ' });
    expect(harness.sessions[0].play).toHaveBeenCalledTimes(calls);
    await act(async () => {
      fireEvent.keyDown(bpm, { code: 'Escape', key: 'Escape' });
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(screen.getByRole('button', { name: '课堂设置' })).toHaveFocus();
    fireEvent.blur(window);
    expect(screen.getByRole('button', { name: '继续' })).toBeInTheDocument();
    fireEvent.focus(window);
    expect(harness.sessions[0].play).toHaveBeenCalledTimes(calls);
    await click('继续');
    expect(screen.getByRole('button', { name: '暂停' })).toBeInTheDocument();
  });

  it('逐词等待后空格先转场再进入下一词；输入法和长按R不重播', async () => {
    const current = lesson();
    current.gameData.progression = 'step';
    render(<WordBeatClassroom lesson={current} assets={{}} />);
    await click('开始课堂');
    await click('下一词');
    await advance(1200);
    await advance(1200);
    await advance(1200);
    await advance(1200);
    expect(screen.getByText('等待教师')).toBeInTheDocument();
    const calls = harness.sessions[0].play.mock.calls.length;
    fireEvent.keyDown(document.body, { code: 'KeyR', key: 'r', repeat: true });
    fireEvent.keyDown(document.body, { code: 'KeyR', key: 'r', isComposing: true });
    expect(harness.sessions[0].play).toHaveBeenCalledTimes(calls);
    await act(async () => {
      fireEvent.keyDown(document.body, { code: 'Space', key: ' ' });
    });
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('准备下一词');
    expect(harness.sessions[0].play).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: 'transition' }),
      0,
    );
    expect(harness.sessions[0].play).toHaveBeenCalledTimes(calls + 1);
    await advance(600);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('sustainable development');
    expect(screen.getByRole('button', { name: '下一词' })).toBeDisabled();
  });

  it('首次声音准备失败留在开始页，展示错误与推进方式，可直接重试', async () => {
    const current = lesson();
    harness.failNext = true;
    render(<WordBeatClassroom lesson={current} assets={{}} />);
    await click('开始课堂');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(current.name);
    expect(screen.getByText('推进方式：自动推进')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('声音设备暂时不可用');
    expect(screen.getByRole('alert')).toHaveTextContent('点击“开始课堂”重试');
    expect(screen.getByRole('button', { name: '课堂设置' })).toBeInTheDocument();
    expect(harness.sessions[0].play).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '开始课堂' })).toBeEnabled();
    await click('开始课堂');
    expect(screen.getByRole('button', { name: '暂停' })).toBeInTheDocument();
    expect(harness.sessions).toHaveLength(1);
  });

  it('首批声音准备仍显示开始页且防重复提交，失焦后迟到结果不播放', async () => {
    let ready!: () => void;
    harness.prepareOnce = () =>
      new Promise<void>((resolve) => {
        ready = resolve;
      });
    render(<WordBeatClassroom lesson={lesson()} assets={{}} />);
    await click('开始课堂');
    expect(screen.getByText('正在准备首批声音资源…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '正在准备…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '测试声音' })).toBeDisabled();
    act(() => {
      fireEvent.blur(window);
    });
    await act(async () => {
      ready();
    });
    expect(screen.getByRole('button', { name: '开始课堂' })).toBeEnabled();
    expect(harness.sessions[0].play).not.toHaveBeenCalled();
  });

  it('设备错误主动作重试当前词，不重播开场；卸载释放会话', async () => {
    const view = render(<WordBeatClassroom lesson={lesson()} assets={{}} />);
    await click('开始课堂');
    harness.failNext = true;
    await click('下一词');
    expect(screen.getByRole('alert')).toHaveTextContent('声音设备暂时不可用');
    expect(screen.getByText('播放已中断')).toBeInTheDocument();
    await click('课堂设置');
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(within(screen.getByRole('dialog')).getByRole('alert')).toHaveTextContent('关闭设置后');
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await click('重试当前阶段');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText('播放已中断')).not.toBeInTheDocument();
    expect(harness.sessions[0].play).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: 'model', itemIndex: 0 }),
      0,
    );
    view.unmount();
    expect(harness.sessions[0].dispose).toHaveBeenCalledOnce();
  });

  it('声音测试失焦即停止，定时任务不在停止后提示测试完成', async () => {
    vi.useFakeTimers();
    render(<WordBeatClassroom lesson={lesson()} assets={{}} />);
    await click('测试声音');
    expect(harness.sessions[0].play).toHaveBeenCalledOnce();
    await act(async () => {
      fireEvent.blur(window);
    });
    expect(harness.sessions[0].dispose).toHaveBeenCalledOnce();
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.queryByText(/试听结束/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '测试声音' })).toBeInTheDocument();
  });

  it('较长的真实示范样本保留完整阶段，测试声音不固定截成1.8秒', async () => {
    vi.useFakeTimers();
    const current = lesson();
    const opening = current.gameData.slogans.opening;
    opening.enabled = true;
    opening.audio = {
      source: 'recording',
      assetId: 'opening-sample',
      text: opening.text,
      language: opening.language,
      rate: 1,
      status: 'ready',
    };
    render(
      <WordBeatClassroom
        lesson={current}
        assets={{
          'opening-sample': {
            assetId: 'opening-sample',
            mimeType: 'audio/wav',
            durationMs: 3000,
            byteLength: 3,
            sha256: 'a'.repeat(64),
          },
        }}
      />,
    );
    await click('测试声音');
    // 100 BPM 下声音加尾部缓冲占6拍；播放器与声音长度保护采用同一阶段。
    expect(harness.sessions[0].play).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: 'opening', durationMs: 3600 }),
      0,
    );
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.getByRole('button', { name: '停止测试' })).toBeInTheDocument();
    await act(async () => {
      vi.advanceTimersByTime(1600);
    });
    expect(screen.getByRole('button', { name: '测试声音' })).toBeInTheDocument();
    expect(harness.sessions[0].dispose).toHaveBeenCalledOnce();
  });

  it('已停止试听迟到失败不会关闭后来开始的新试听', async () => {
    let rejectOld!: (error: Error) => void;
    harness.prepareOnce = () =>
      new Promise((_resolve, reject) => {
        rejectOld = reject;
      });
    render(<WordBeatClassroom lesson={lesson()} assets={{}} />);
    await click('测试声音');
    await click('停止测试');
    await click('测试声音');
    expect(harness.sessions[1].play).toHaveBeenCalledOnce();
    await act(async () => {
      rejectOld(new Error('旧试听失败'));
    });
    expect(harness.sessions[1].dispose).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '停止测试' })).toBeInTheDocument();
    expect(screen.queryByText('旧试听失败')).not.toBeInTheDocument();
  });

  it('课中设置暂停但不自动继续，数值和滑杆同步，非法音量保留原混音', async () => {
    render(<WordBeatClassroom lesson={lesson()} assets={{}} />);
    await click('开始课堂');
    await click('下一词');
    const audio = harness.sessions[0];
    const pauses = audio.pause.mock.calls.length;
    await click('课堂设置');
    expect(audio.pause).toHaveBeenCalledTimes(pauses + 1);
    const drawer = screen.getByRole('dialog', { name: '课堂设置' });
    const input = within(drawer).getByRole('spinbutton', { name: '节拍音量百分比' });
    fireEvent.change(input, { target: { value: '35' } });
    expect(audio.setVolumes).not.toHaveBeenCalled();
    expect(within(drawer).getByRole('slider')).toHaveValue('0.35');
    const calls = audio.setVolumes.mock.calls.length;
    fireEvent.change(input, { target: { value: '101' } });
    expect(audio.setVolumes).toHaveBeenCalledTimes(calls);
    expect(screen.getByText('请输入 0～100 的整数百分比；未应用此输入。')).toBeInTheDocument();
    fireEvent.change(within(drawer).getByRole('slider'), { target: { value: '0.5' } });
    expect(input).toHaveValue(50);
    const plays = audio.play.mock.calls.length;
    fireEvent.keyDown(document.body, { code: 'Space', key: ' ' });
    expect(audio.play).toHaveBeenCalledTimes(plays);
    expect(audio.pause).toHaveBeenCalledTimes(pauses + 1);
    await click('收起');
    expect(screen.getByRole('button', { name: '继续' })).toBeDisabled();
    await click('课堂设置');
    await click('完成设置');
    expect(audio.setVolumes).toHaveBeenLastCalledWith(expect.objectContaining({ beat: 0.5 }));
    expect(screen.getByRole('button', { name: '继续' })).toBeEnabled();
    expect(audio.play).toHaveBeenCalledTimes(plays);
  });

  it('非法BPM不改变进度，暂停改合法BPM后仍须主动继续阶段起点', async () => {
    render(<WordBeatClassroom lesson={lesson()} assets={{}} />);
    await click('开始课堂');
    await click('下一词');
    await advance(300);
    await click('暂停');
    await click('课堂设置');
    const input = screen.getByRole('spinbutton', { name: '节奏 BPM' });
    fireEvent.change(input, { target: { value: '49' } });
    await click('完成设置');
    expect(screen.getByRole('alert')).toHaveTextContent('节奏需为 50～180 的整数 BPM');
    const plays = harness.sessions[0].play.mock.calls.length;
    fireEvent.change(input, { target: { value: '120' } });
    await click('完成设置');
    await click('课堂设置');
    expect(harness.sessions[0].play).toHaveBeenCalledTimes(plays);
    expect(screen.getByRole('status')).toHaveTextContent('继续后从当前阶段起点生效');
    expect(screen.getByText('当前节奏：120 BPM。')).toBeInTheDocument();
    await click('收起');
    await click('继续');
    expect(harness.sessions[0].play).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: 'model', itemIndex: 0 }),
      0,
    );
  });

  it('拍位和实际用时不逐拍读屏播报，阶段和播放按钮仍有可读取文字', async () => {
    render(<WordBeatClassroom lesson={lesson()} assets={{}} />);
    await click('开始课堂');
    await click('下一词');
    expect(screen.getByLabelText('四拍循环提示')).toHaveAttribute('aria-live', 'off');
    const elapsed = screen.getByText(/实际用时/);
    expect(elapsed).toHaveAttribute('aria-live', 'off');
    expect(screen.getByText('教师示范')).toHaveAttribute('aria-live', 'polite');
    expect(screen.getByRole('button', { name: '暂停' })).toBeInTheDocument();
    await advance(600);
    expect(elapsed).toHaveAttribute('aria-live', 'off');
    expect(screen.getByLabelText('四拍循环提示')).not.toHaveAttribute('role', 'status');
  });

  it('等待调速显示当前与待生效值，重读维持本词节奏，进入下一词后才显示已更新', async () => {
    render(<WordBeatClassroom lesson={lesson('step')} assets={{}} />);
    await click('开始课堂');
    await click('下一词');
    for (let index = 0; index < 4; index++) await advance(1200);
    expect(screen.getByText('等待教师')).toBeInTheDocument();
    await click('课堂设置');
    fireEvent.change(screen.getByRole('spinbutton', { name: '节奏 BPM' }), {
      target: { value: '120' },
    });
    await click('完成设置');
    await click('课堂设置');
    expect(screen.getByText(/当前节奏：100 BPM。待生效：120 BPM/)).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('节奏将在下一词生效');
    expect(screen.getByRole('status')).not.toHaveTextContent('节奏已更新');
    await click('收起');
    await click('重读');
    expect(harness.sessions[0].play).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: 'model',
        itemIndex: 0,
        pulseIntervalMs: 600,
        durationMs: 1200,
      }),
      0,
    );
    for (let index = 0; index < 4; index++) await advance(1200);
    expect(screen.getByText('等待教师')).toBeInTheDocument();
    await click('继续下一词');
    expect(harness.sessions[0].play).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: 'transition', pulseIntervalMs: 600 }),
      0,
    );
    await advance(600);
    expect(harness.sessions[0].play).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: 'model',
        itemIndex: 1,
        pulseIntervalMs: 500,
        durationMs: 1500,
      }),
      0,
    );
    expect(screen.getByRole('status')).toHaveTextContent('课堂安排已生效，当前节奏 120 BPM。');
    await click('课堂设置');
    expect(screen.getByText('当前节奏：120 BPM。')).toBeInTheDocument();
    expect(screen.queryByText(/待生效：/)).not.toBeInTheDocument();
  });

  it('收起后重开设置，等待调速反馈仍可访问，课堂和弹窗只保留一个状态区域', async () => {
    const view = render(<WordBeatClassroom lesson={lesson('step')} assets={{}} />);
    await click('开始课堂');
    await click('下一词');
    for (let index = 0; index < 4; index++) await advance(1200);
    await click('课堂设置');
    fireEvent.change(screen.getByRole('spinbutton', { name: '节奏 BPM' }), {
      target: { value: '120' },
    });
    await click('完成设置');
    await click('课堂设置');
    expect(screen.getByRole('status')).toHaveTextContent('节奏将在下一词生效');
    await click('收起');
    expect(screen.getByRole('status')).toHaveTextContent('节奏将在下一词生效');
    await click('课堂设置');
    fireEvent.change(screen.getByRole('spinbutton', { name: '节奏 BPM' }), {
      target: { value: '140' },
    });
    await click('完成设置');
    await click('课堂设置');
    const drawer = screen.getByRole('dialog', { name: '课堂设置' });
    expect(screen.getByRole('status')).toHaveTextContent('节奏将在下一词生效');
    expect(within(drawer).getByRole('status')).toBe(screen.getByRole('status'));
    expect(view.container.querySelectorAll('[role="status"]')).toHaveLength(1);
    expect(screen.getByText(/当前节奏：100 BPM。待生效：140 BPM/)).toBeInTheDocument();
    await click('收起');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('节奏将在下一词生效');
    expect(view.container.querySelectorAll('[role="status"]')).toHaveLength(1);
  });

  it('重开设置后超过32拍的调速错误仍可访问，保留当前节奏及暂停进度', async () => {
    const current = lesson();
    current.gameData.soundMode = 'voiced';
    current.gameData.segments[0].entries.splice(1);
    const entry = current.gameData.segments[0].entries[0];
    const asset = {
      assetId: 'long-model',
      mimeType: 'audio/wav',
      durationMs: 11_000,
      byteLength: 3,
      sha256: 'a'.repeat(64),
    };
    render(
      <WordBeatClassroom
        lesson={bindRecording(current, entry.id, asset)}
        assets={{ [asset.assetId]: asset }}
      />,
    );
    await click('开始课堂');
    await click('下一词');
    await click('暂停');
    await click('课堂设置');
    fireEvent.change(screen.getByRole('spinbutton', { name: '节奏 BPM' }), {
      target: { value: '120' },
    });
    await click('完成设置');
    await click('课堂设置');
    expect(screen.getByRole('status')).toHaveTextContent('节奏已更新');
    await click('收起');
    await click('课堂设置');
    const plays = harness.sessions[0].play.mock.calls.length;
    const input = screen.getByRole('spinbutton', { name: '节奏 BPM' });
    // 11秒录音在120 BPM可运行；180 BPM会使整拍跟读超过32拍，必须明确拒绝。
    fireEvent.change(input, { target: { value: '180' } });
    await click('完成设置');
    const drawer = screen.getByRole('dialog', { name: '课堂设置' });
    expect(screen.getByRole('alert')).toHaveTextContent('跟读超过32拍');
    expect(within(drawer).getByRole('alert')).toBe(screen.getByRole('alert'));
    // 无效新输入保留供教师修正，实际编排仍为原来的120 BPM。
    expect(input).toHaveValue(180);
    expect(screen.getByText(/当前节奏：120 BPM。/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '完成设置' })).toBeDisabled();
    expect(harness.sessions[0].play).toHaveBeenCalledTimes(plays);
    await click('收起');
    expect(screen.getByRole('alert')).toHaveTextContent('跟读超过32拍');
    expect(screen.getByRole('button', { name: '继续' })).toBeDisabled();
  });

  it('全屏被拒绝可继续窗口上课，真实全屏事件更新控件名称', async () => {
    const view = render(<WordBeatClassroom lesson={lesson()} assets={{}} />);
    const root = view.container.firstElementChild as HTMLElement;
    root.requestFullscreen = vi.fn(async () => {
      throw new Error('拒绝全屏');
    });
    await click('开始课堂');
    await click('全屏');
    expect(screen.getByRole('status')).toHaveTextContent('可继续使用窗口模式上课。');
    expect(screen.getByRole('button', { name: '暂停' })).toBeEnabled();
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: root });
    fireEvent(document, new Event('fullscreenchange'));
    expect(screen.getByRole('button', { name: '退出全屏' })).toBeInTheDocument();
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: null });
    fireEvent(document, new Event('fullscreenchange'));
    expect(screen.getByRole('button', { name: '全屏' })).toBeInTheDocument();
  });

  it('全部声部关闭时说明没有启用声音，仍可进行文字课堂', async () => {
    const current = lesson();
    current.gameData.beatEnabled = false;
    render(<WordBeatClassroom lesson={current} assets={{}} />);
    expect(screen.queryByRole('button', { name: '测试声音' })).not.toBeInTheDocument();
    expect(screen.getByText('本课按画面节奏练习，未启用声音。')).toBeInTheDocument();
    expect(harness.sessions).toHaveLength(0);
    await click('开始课堂');
    expect(screen.getByRole('button', { name: '暂停' })).toBeInTheDocument();
  });

  it.each(['centered', 'blocks'] as const)(
    '%s模式完整展示120字符长词，保留教师控制',
    async (mode) => {
      const current = lesson();
      current.gameData.displayMode = mode;
      const word = 'a'.repeat(120);
      current.gameData.segments[0].entries[0].english = word;
      const view = render(<WordBeatClassroom lesson={current} assets={{}} />);
      await click('开始课堂');
      await click('下一词');
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(word);
      expect(view.container.firstElementChild).toHaveClass(`ecg-classroom--${mode}`);
      expect(screen.getByRole('button', { name: '暂停' })).toBeEnabled();
      expect(screen.getByRole('button', { name: '重读' })).toBeEnabled();
    },
  );
});
