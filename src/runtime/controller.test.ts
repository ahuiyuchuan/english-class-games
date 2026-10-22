/** 课堂控制回归：可控设备时钟验证边界，不将模拟驱动当系统配音验收。 @author ahui */
import { describe, expect, it, vi } from 'vitest';
import { TimelineController } from './controller';
import type { RuntimeAudioDriver, RuntimeTimeline } from './types';

/** 通用数字载荷不含节拍/英语字段，证明运行核心不依赖单词游戏模型。 */
function plan(): RuntimeTimeline<number> {
  const definitions = [
    { kind: 'before', itemIndex: null, navigation: { previous: null, next: 0, repeat: null } },
    { kind: 'show', itemIndex: 0, navigation: { previous: null, next: 1, repeat: 0 } },
    { kind: 'respond', itemIndex: 0, navigation: { previous: null, next: 1, repeat: 0 } },
    { kind: 'gap', itemIndex: null, navigation: { previous: 0, next: 1, repeat: null } },
    { kind: 'show', itemIndex: 1, navigation: { previous: 0, next: 2, repeat: 1 } },
    { kind: 'respond', itemIndex: 1, navigation: { previous: 0, next: 2, repeat: 1 } },
    { kind: 'gap', itemIndex: null, navigation: { previous: 1, next: 2, repeat: null } },
    { kind: 'show', itemIndex: 2, navigation: { previous: 1, next: null, repeat: 2 } },
    { kind: 'respond', itemIndex: 2, navigation: { previous: 1, next: null, repeat: 2 } },
    { kind: 'after', itemIndex: null, navigation: { previous: 2, next: null, repeat: null } },
  ];
  return {
    cues: definitions.map((cue, index) => ({
      ...cue,
      id: `cue-${index}`,
      startMs: index * 100,
      durationMs: 100,
      sectionIndex: 0,
      data: index,
    })),
    items: [
      { id: 'a', sectionIndex: 0, firstCue: 1, lastCue: 2 },
      { id: 'b', sectionIndex: 0, firstCue: 4, lastCue: 5 },
      { id: 'c', sectionIndex: 0, firstCue: 7, lastCue: 8 },
    ],
    durationMs: 1000,
  };
}

function fixture(mode: 'auto' | 'step' = 'auto', resumePreparation = false) {
  let now = 0;
  let wall = 0;
  const audio: RuntimeAudioDriver<number> = {
    now: () => now,
    prepare: vi.fn(async () => undefined),
    play: vi.fn(),
    pause: vi.fn(),
    stop: vi.fn(),
    dispose: vi.fn(),
  };
  const timeline = plan();
  if (resumePreparation)
    timeline.resumeCue = {
      ...timeline.cues[0],
      id: 'resume',
      kind: 'resume',
      durationMs: 200,
    };
  const controller = new TimelineController(timeline, audio, { mode, wallNow: () => wall });
  const advance = async (ms = 100) => {
    now += ms;
    wall += ms;
    controller.tick();
    await Promise.resolve();
    await Promise.resolve();
  };
  return {
    controller,
    audio,
    advance,
    wall: (ms: number) => {
      wall += ms;
    },
  };
}

/**
 * 用全局阶段序号模拟正式编排器：前项轮数变化会移动后项的阶段 ID。
 * 音乐位置属于编排结果，控制器必须原样采用新目标阶段，不能自行重算。
 */
function revisedPlan(
  firstRounds: number,
  boundary: 'continuous' | 'gap' | 'section',
  revision: 'old' | 'new',
): RuntimeTimeline<string> {
  const cues: RuntimeTimeline<string>['cues'] = [];
  const push = (kind: string, itemIndex: number | null, round?: number) => {
    const index = cues.length;
    cues.push({
      id: `${kind}:${index}`,
      kind,
      startMs: index * 100,
      durationMs: 100,
      itemIndex,
      sectionIndex: boundary === 'section' && itemIndex === 1 ? 1 : 0,
      round,
      musicPositionMs:
        itemIndex === 0
          ? (round! - 1) * 100
          : itemIndex === 1
            ? boundary === 'section'
              ? 0
              : firstRounds * 100 + (boundary === 'gap' ? 100 : 0)
            : undefined,
      navigation: {
        previous: itemIndex === 1 ? 0 : null,
        next: itemIndex === 1 ? null : itemIndex === null && kind === 'after' ? null : 1,
        repeat: itemIndex,
      },
      data: `${revision}:${itemIndex ?? kind}`,
    });
  };
  push('before', null);
  for (let round = 1; round <= firstRounds; round++) push('show', 0, round);
  const firstLastCue = cues.length - 1;
  if (boundary === 'gap') push('gap', null);
  if (boundary === 'section') {
    push('section-slogan', null);
    push('section-ready', null);
  }
  const secondFirstCue = cues.length;
  push('show', 1, 1);
  push('after', null);
  // 开场导航与非条目转场声明独立目标；这里保持与其实际教学位置一致。
  cues[0].navigation.next = 0;
  return {
    cues,
    items: [
      { id: 'a', sectionIndex: 0, firstCue: 1, lastCue: firstLastCue },
      {
        id: 'b',
        sectionIndex: boundary === 'section' ? 1 : 0,
        firstCue: secondFirstCue,
        lastCue: secondFirstCue,
      },
    ],
    durationMs: cues.length * 100,
  };
}

describe('共享运行生命周期', () => {
  it('运行中资源未就绪不推进或自动发声，准备好后由教师继续该阶段起点', async () => {
    const { controller, audio } = fixture('auto', true);
    await controller.start();
    let complete!: () => void;
    audio.isPrepared = vi.fn(() => false);
    vi.mocked(audio.prepare).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          complete = resolve;
        }),
    );
    const calls = vi.mocked(audio.play).mock.calls.length;
    const pending = controller.next();
    expect(controller.getState()).toMatchObject({
      status: 'preparing',
      cueIndex: 1,
      elapsedInCueMs: 0,
    });
    controller.tick();
    expect(audio.play).toHaveBeenCalledTimes(calls);
    audio.isPrepared = vi.fn(() => true);
    complete();
    await pending;
    expect(controller.getState()).toMatchObject({ status: 'paused', resourceReady: true });
    expect(audio.play).toHaveBeenCalledTimes(calls);
    await controller.resume();
    expect(controller.getActiveCue()?.kind).toBe('show');
    expect(audio.play).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'cue-1' }), 0);
  });

  it('主动结束和自然完成保留不同原因，重播清空上一会话统计', async () => {
    const { controller, advance } = fixture();
    await controller.start();
    controller.end();
    expect(controller.getState().completionReason).toBe('ended');
    await controller.start();
    expect(controller.getState()).toMatchObject({
      repeats: 0,
      completedItems: 0,
      completionReason: undefined,
    });
    for (let index = 0; index < 10; index++) await advance();
    expect(controller.getState()).toMatchObject({
      status: 'completed',
      completionReason: 'finished',
      completedItems: 3,
    });
  });

  it('资源准备中暂停后继续只准备原阶段，不插入教学恢复两拍', async () => {
    const { controller, audio } = fixture('auto', true);
    await controller.start();
    let ready!: () => void;
    audio.isPrepared = vi.fn(() => false);
    vi.mocked(audio.prepare).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          ready = resolve;
        }),
    );
    const pending = controller.next();
    controller.pause();
    ready();
    await pending;
    audio.isPrepared = vi.fn(() => true);
    await controller.resume();
    expect(controller.getActiveCue()?.id).toBe('cue-1');
    expect(audio.play).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'show' }), 0);
  });
  it('阶段使用绝对时钟并传递超出部分，帧延迟不逐段累积', async () => {
    const { controller, audio, advance } = fixture();
    await controller.start();
    await advance(116);
    expect(controller.getState().cueIndex).toBe(1);
    expect(audio.play).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'cue-1' }), 16);
    await advance(84);
    expect(controller.getState().cueIndex).toBe(2);
  });

  it('暂停恢复原阶段偏移；暂停时切词只定位，继续才播放', async () => {
    const { controller, audio, advance } = fixture();
    await controller.start();
    await advance(40);
    controller.pause();
    const calls = vi.mocked(audio.play).mock.calls.length;
    await controller.next();
    expect(controller.getState().status).toBe('paused');
    expect(controller.getState().cueIndex).toBe(1);
    expect(vi.mocked(audio.play).mock.calls.length).toBe(calls);
    await controller.resume();
    expect(controller.getState().status).toBe('running');
  });

  it('逐词轮次全部结束才等待；主动作保留转场，直接导航跳过转场，末词不等待', async () => {
    const { controller, advance } = fixture('step');
    await controller.start();
    await advance();
    await advance();
    await advance();
    expect(controller.getState().status).toBe('waiting');
    expect(controller.getState().cueIndex).toBe(2);
    await controller.toggle();
    expect(controller.getState().cueIndex).toBe(3);
    await advance();
    expect(controller.getState().cueIndex).toBe(4);
    await advance();
    await advance();
    expect(controller.getState().status).toBe('waiting');
    await controller.next();
    expect(controller.getState().cueIndex).toBe(7);
    await advance();
    await advance();
    expect(controller.getState().cueIndex).toBe(9);
    await advance();
    expect(controller.getState().status).toBe('completed');
    expect(controller.getState().completedItems).toBe(3);
  });

  it('等待后失焦暂停、切自动不发声；继续仍先播放原转场', async () => {
    const { controller, audio, advance } = fixture('step');
    await controller.start();
    await advance();
    await advance();
    await advance();
    controller.pause();
    const calls = vi.mocked(audio.play).mock.calls.length;
    controller.setMode('auto');
    expect(controller.getState().status).toBe('paused');
    expect(vi.mocked(audio.play).mock.calls.length).toBe(calls);
    await controller.toggle();
    expect(controller.getState().status).toBe('running');
    expect(controller.getState().cueIndex).toBe(3);
    await advance();
    expect(controller.getState().cueIndex).toBe(4);
  });

  it('等待暂停恢复仍为逐词时回到等待，R重读当前词', async () => {
    const { controller, advance } = fixture('step');
    await controller.start();
    await advance();
    await advance();
    await advance();
    controller.pause();
    await controller.resume();
    expect(controller.getState().status).toBe('waiting');
    await controller.repeat();
    expect(controller.getState().cueIndex).toBe(1);
    expect(controller.getState().repeats).toBe(1);
  });

  it('非条目阶段导航遵守计划，重读禁用', async () => {
    const { controller, audio } = fixture();
    await controller.start();
    const calls = vi.mocked(audio.play).mock.calls.length;
    await controller.repeat();
    await controller.previous();
    expect(vi.mocked(audio.play).mock.calls.length).toBe(calls);
    await controller.next();
    expect(controller.getState().cueIndex).toBe(1);
  });

  it('快速连续切词只有最终准备结果能发声，迟到旧任务被忽略', async () => {
    const { controller, audio } = fixture();
    await controller.start();
    let completeFirst!: () => void;
    let completeSecond!: () => void;
    vi.mocked(audio.prepare)
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            completeFirst = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            completeSecond = resolve;
          }),
      );
    const first = controller.next();
    const second = controller.next();
    completeSecond();
    await second;
    expect(controller.getState().cueIndex).toBe(4);
    const calls = vi.mocked(audio.play).mock.calls.length;
    completeFirst();
    await first;
    expect(vi.mocked(audio.play).mock.calls.length).toBe(calls);
  });

  it('播放中替换时间轴到下一词才生效，暂停替换仍保持暂停', async () => {
    const { controller, advance } = fixture();
    await controller.start();
    await controller.next();
    const changed = plan();
    changed.cues.forEach((cue) => {
      cue.durationMs = 200;
    });
    changed.durationMs = 2000;
    controller.replaceTimeline(changed);
    expect(controller.getTimeline().durationMs).toBe(1000);
    await advance();
    await advance();
    expect(controller.getTimeline().durationMs).toBe(1000);
    await advance();
    expect(controller.getState().cueIndex).toBe(4);
    expect(controller.getTimeline().durationMs).toBe(2000);
    controller.pause();
    controller.replaceTimeline(plan());
    expect(controller.getState().status).toBe('paused');
    expect(controller.getState().elapsedInCueMs).toBe(0);
  });

  it('逐项等待保留待生效安排，重读沿用当前安排，自然继续保留转场后在下一条目生效', async () => {
    const { controller, audio, advance } = fixture('step');
    await controller.start();
    await controller.next();
    await advance();
    await advance();
    expect(controller.getState().status).toBe('waiting');
    const changed = plan();
    changed.cues.forEach((cue, index) => {
      cue.durationMs = 200;
      cue.startMs = index * 200;
    });
    changed.durationMs = 2000;
    const plays = vi.mocked(audio.play).mock.calls.length;
    controller.replaceTimeline(changed);
    expect(controller.getTimeline().durationMs).toBe(1000);
    expect(controller.getState().status).toBe('waiting');
    expect(audio.play).toHaveBeenCalledTimes(plays);
    await controller.repeat();
    expect(controller.getTimeline().durationMs).toBe(1000);
    expect(audio.play).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 'cue-1', durationMs: 100 }),
      0,
    );
    await advance();
    await advance();
    expect(controller.getState().status).toBe('waiting');
    expect(controller.getTimeline().durationMs).toBe(1000);
    await controller.toggle();
    expect(controller.getActiveCue()?.kind).toBe('gap');
    expect(controller.getTimeline().durationMs).toBe(1000);
    await advance();
    expect(controller.getTimeline()).toBe(changed);
    expect(audio.play).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 'cue-4', durationMs: 200 }),
      0,
    );
  });

  it.each(['previous', 'next'] as const)(
    '等待时主动%s到另一条目立即采用待生效安排，不补播转场',
    async (action) => {
      const { controller, audio, advance } = fixture('step');
      await controller.start();
      await controller.next();
      await controller.next();
      await advance();
      await advance();
      expect(controller.getState()).toMatchObject({ status: 'waiting', cueIndex: 5 });
      const changed = plan();
      changed.durationMs = 2000;
      changed.cues.forEach((cue) => {
        cue.durationMs = 200;
      });
      controller.replaceTimeline(changed);
      expect(controller.getTimeline().durationMs).toBe(1000);
      const plays = vi.mocked(audio.play).mock.calls.length;
      await controller[action]();
      expect(controller.getTimeline()).toBe(changed);
      expect(controller.getState()).toMatchObject({
        status: 'running',
        cueIndex: action === 'previous' ? 1 : 7,
      });
      expect(audio.play).toHaveBeenCalledTimes(plays + 1);
      expect(audio.play).toHaveBeenLastCalledWith(
        expect.objectContaining({ kind: 'show', durationMs: 200 }),
        0,
      );
    },
  );

  it('播放中重读也不提前安装待生效安排，之后主动切条才使用新安排', async () => {
    const { controller, audio } = fixture();
    await controller.start();
    await controller.next();
    const changed = plan();
    changed.durationMs = 2000;
    changed.cues.forEach((cue) => {
      cue.durationMs = 200;
    });
    controller.replaceTimeline(changed);
    await controller.repeat();
    expect(controller.getTimeline().durationMs).toBe(1000);
    expect(audio.play).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 'cue-1', durationMs: 100 }),
      0,
    );
    await controller.next();
    expect(controller.getTimeline()).toBe(changed);
    expect(audio.play).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 'cue-4', durationMs: 200 }),
      0,
    );
  });

  it.each(
    (['auto', 'step'] as const).flatMap((mode) =>
      (['continuous', 'gap', 'section'] as const).flatMap((boundary) =>
        [true, false].map((increase) => ({ mode, boundary, increase })),
      ),
    ),
  )(
    '$mode / $boundary / increase=$increase：前项阶段数与文本变化后按稳定条目进入下一项',
    async ({ mode, boundary, increase }) => {
      const originalRounds = increase ? 1 : 3;
      const original = revisedPlan(originalRounds, boundary, 'old');
      const changed = revisedPlan(increase ? 3 : 1, boundary, 'new');
      let time = 0;
      const audio: RuntimeAudioDriver<string> = {
        now: () => time,
        prepare: vi.fn(async () => undefined),
        play: vi.fn(),
        pause: vi.fn(),
        stop: vi.fn(),
      };
      const controller = new TimelineController(original, audio, { mode });
      const advance = async () => {
        time += 100;
        controller.tick();
        await Promise.resolve();
        await Promise.resolve();
      };
      await controller.start();
      await controller.next();
      controller.replaceTimeline(changed, true);
      await controller.repeat();
      expect(controller.getTimeline()).toBe(original);
      expect(controller.getActiveCue()?.data).toBe('old:0');
      for (let round = 0; round < originalRounds; round++) await advance();
      if (mode === 'step') {
        expect(controller.getState().status).toBe('waiting');
        expect(controller.getTimeline()).toBe(original);
        await controller.toggle();
      }
      const boundaries =
        boundary === 'section'
          ? ['section-slogan', 'section-ready']
          : boundary === 'gap'
            ? ['gap']
            : [];
      for (const kind of boundaries) {
        // 自然继续先走完旧安排已确定的空拍、口号和准备，不跳过也不重播。
        expect(controller.getActiveCue()?.kind).toBe(kind);
        expect(controller.getTimeline()).toBe(original);
        await advance();
      }
      const targetIndex = changed.items[1].firstCue;
      const target = changed.cues[targetIndex];
      expect(controller.getTimeline()).toBe(changed);
      expect(controller.getActiveCue()).toBe(target);
      expect(controller.getActiveCue()?.data).toBe('new:1');
      expect(controller.getState()).toMatchObject({
        status: 'running',
        cueIndex: targetIndex,
        elapsedInCueMs: 0,
        completedItems: 1,
      });
      expect(audio.prepare).toHaveBeenLastCalledWith(changed, targetIndex);
      expect(audio.play).toHaveBeenLastCalledWith(target, 0);
      expect(target.musicPositionMs).toBe(
        boundary === 'section' ? 0 : (increase ? 300 : 100) + (boundary === 'gap' ? 100 : 0),
      );
      await advance();
      await advance();
      expect(controller.getState()).toMatchObject({
        status: 'completed',
        completionReason: 'finished',
        completedItems: 2,
      });
      controller.dispose();
    },
  );

  it('实际用时含暂停和等待；结束停止所有声音，dispose后迟到结果不能播放', async () => {
    const { controller, audio, advance, wall } = fixture();
    await controller.start();
    await advance(40);
    controller.pause();
    wall(5000);
    await controller.resume();
    controller.end();
    expect(controller.getState().actualElapsedMs).toBe(5040);
    expect(audio.stop).toHaveBeenCalled();
    controller.dispose();
    expect(audio.dispose).toHaveBeenCalled();
  });

  it('首次准备失败保留未开课状态，重试才开始实际计时', async () => {
    const { controller, audio } = fixture();
    vi.mocked(audio.prepare).mockRejectedValueOnce(new Error('声音损坏'));
    await controller.start();
    expect(controller.getState()).toMatchObject({ status: 'error', hasStarted: false });
    expect(audio.play).not.toHaveBeenCalled();
    await controller.retry();
    expect(controller.getState()).toMatchObject({ status: 'running', hasStarted: true });
  });

  it('首次准备和失败重试的等待不计用时，开播后的等待与暂停计入', async () => {
    const { controller, audio, advance, wall } = fixture('step');
    vi.mocked(audio.prepare).mockImplementationOnce(async () => {
      wall(5000);
      throw new Error('首次准备失败');
    });
    await controller.start();
    wall(3000);
    controller.tick();
    expect(controller.getState().actualElapsedMs).toBe(0);
    vi.mocked(audio.prepare).mockImplementationOnce(async () => {
      wall(2000);
    });
    await controller.retry();
    expect(controller.getState().actualElapsedMs).toBe(0);
    await advance();
    await advance();
    await advance();
    wall(700);
    controller.pause();
    wall(500);
    controller.end();
    expect(controller.getState().actualElapsedMs).toBe(1500);
  });

  it('初次准备失焦后留在开始页，迟到结果不播放且可重新开始', async () => {
    const { controller, audio } = fixture();
    let ready!: () => void;
    vi.mocked(audio.prepare).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          ready = resolve;
        }),
    );
    const pending = controller.start();
    await controller.next();
    expect(controller.getState().cueIndex).toBe(0);
    controller.pause();
    ready();
    await pending;
    expect(controller.getState()).toMatchObject({ status: 'idle', hasStarted: false });
    expect(audio.play).not.toHaveBeenCalled();
    await controller.start();
    expect(controller.getState()).toMatchObject({ status: 'running', hasStarted: true });
  });

  it('等待切自动保留段间口号和准备，独立下一条直接到首轮', async () => {
    const timeline = plan();
    timeline.cues.splice(
      3,
      1,
      { ...timeline.cues[3], id: 'section-slogan', kind: 'section-slogan' },
      { ...timeline.cues[3], id: 'section-ready', kind: 'section-ready' },
    );
    timeline.items[1].firstCue += 1;
    timeline.items[1].lastCue += 1;
    timeline.items[2].firstCue += 1;
    timeline.items[2].lastCue += 1;
    let time = 0;
    const audio: RuntimeAudioDriver<number> = {
      now: () => time,
      prepare: vi.fn(async () => undefined),
      play: vi.fn(),
      pause: vi.fn(),
      stop: vi.fn(),
    };
    const controller = new TimelineController(timeline, audio, { mode: 'step' });
    const advance = async () => {
      time += 100;
      controller.tick();
      await Promise.resolve();
      await Promise.resolve();
    };
    await controller.start();
    await advance();
    await advance();
    await advance();
    controller.setMode('auto');
    await Promise.resolve();
    expect(controller.getActiveCue()?.kind).toBe('section-slogan');
    await advance();
    expect(controller.getActiveCue()?.kind).toBe('section-ready');
    await advance();
    expect(controller.getActiveCue()?.id).toBe('cue-4');
    await controller.previous();
    await controller.next();
    expect(controller.getActiveCue()?.id).toBe('cue-4');
    expect(
      vi.mocked(audio.play).mock.calls.filter(([cue]) => cue.kind === 'section-slogan'),
    ).toHaveLength(1);
  });

  it('空计划禁止开始，不产生声源', async () => {
    const { audio } = fixture();
    const controller = new TimelineController({ cues: [], items: [], durationMs: 0 }, audio);
    await controller.start();
    expect(controller.getState().status).toBe('error');
    expect(audio.play).not.toHaveBeenCalled();
  });

  it('恢复准备可再暂停，完成后精确恢复原偏移，不计完成词数', async () => {
    const { controller, audio, advance } = fixture('auto', true);
    await controller.start();
    await controller.next();
    await advance(40);
    controller.pause();
    await controller.resume();
    expect(controller.getActiveCue()?.kind).toBe('resume');
    await advance(80);
    controller.pause();
    await controller.resume();
    expect(audio.play).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'resume' }), 80);
    await advance(120);
    expect(controller.getActiveCue()?.id).toBe('cue-1');
    expect(audio.play).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'cue-1' }), 40);
    expect(controller.getState().completedItems).toBe(0);
    expect(controller.getTimeline().durationMs).toBe(1000);
  });

  it('等待恢复不额外准备；恢复准备期间切词立即取消临时提示', async () => {
    const { controller, audio, advance } = fixture('step', true);
    await controller.start();
    await advance();
    await advance();
    await advance();
    controller.pause();
    await controller.resume();
    expect(controller.getState().status).toBe('waiting');
    expect(controller.getActiveCue()?.kind).toBe('respond');
    await controller.next();
    controller.pause();
    await controller.resume();
    expect(controller.getActiveCue()?.kind).toBe('resume');
    await controller.next();
    expect(audio.play).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'cue-7' }), 0);
  });

  it('错误态主动作重试当前位置，不清空已完成词数或重播开头', async () => {
    const { controller, audio, advance } = fixture();
    await controller.start();
    await advance();
    await advance();
    await advance();
    controller.fail('设备暂时不可用');
    const before = controller.getState();
    await controller.toggle();
    expect(controller.getState().completedItems).toBe(before.completedItems);
    expect(controller.getState().cueIndex).toBe(before.cueIndex);
    expect(audio.play).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: `cue-${before.cueIndex}` }),
      0,
    );
  });

  it('阶段内设备调度失败可重试阶段起点，暂停和错误也持续更新实际用时', async () => {
    const { controller, audio, advance, wall } = fixture();
    await controller.start();
    await controller.next();
    await advance(40);
    audio.tick = vi.fn(() => {
      throw new Error('设备调度失败');
    });
    await advance(20);
    expect(controller.getState()).toMatchObject({ status: 'error', elapsedInCueMs: 60 });
    const listener = vi.fn();
    controller.subscribe(listener);
    wall(5000);
    controller.tick();
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ actualElapsedMs: 5060 }));
    audio.tick = vi.fn();
    await controller.retry();
    expect(audio.play).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'cue-1' }), 0);
    controller.pause();
    wall(1000);
    controller.tick();
    expect(listener).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'paused', actualElapsedMs: 6060 }),
    );
  });

  it('跳词不计完成，重读与整课循环只累计不同位置，结束后重读不改计数', async () => {
    const { controller, advance } = fixture();
    await controller.start();
    await controller.next();
    await advance(40);
    await controller.next();
    expect(controller.getState().completedItems).toBe(0);
    await advance();
    await advance();
    expect(controller.getState().completedItems).toBe(1);
    await controller.previous();
    await controller.repeat();
    await advance();
    await advance();
    expect(controller.getState()).toMatchObject({ completedItems: 1, repeats: 1 });
    controller.setLoop(true);
    for (let index = 0; index < 6; index++) await advance();
    expect(controller.getState().status).toBe('running');
    for (let index = 0; index < 10; index++) await advance();
    expect(controller.getState().completedItems).toBe(3);
    controller.pause();
    await controller.repeat();
    expect(controller.getState().status).toBe('paused');
    const count = controller.getState().repeats;
    controller.end();
    await controller.repeat();
    expect(controller.getState().repeats).toBe(count);
  });
});
