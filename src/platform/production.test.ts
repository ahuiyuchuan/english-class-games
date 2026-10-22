/** 验证真实任务结果与多个教学位置的绑定；受控IPC不替代系统语音实机验证。 @author ahui */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AudioAsset, AudioRequest } from './types';
import type { TaskRecord } from './native';
import {
  createWordBeatLesson,
  getAudioProductionSummary,
  getEntries,
} from '../games/word-beat/rules';
import { produceLesson } from '../games/word-beat/production';
import { restoreWordBeatAudioTask } from '../games/word-beat/audio-results';
import { runAudioTask } from './production';

const api = vi.hoisted(() => ({ synthesize: vi.fn(), getTask: vi.fn(), cancel: vi.fn() }));
vi.mock('./native', () => ({
  synthesizeSpeech: api.synthesize,
  getTask: api.getTask,
  cancelTask: api.cancel,
}));

/** 只提供可识别的音频元信息，不将夹具描述成实际可播放音频。 */
function asset(): AudioAsset {
  return {
    assetId: crypto.randomUUID(),
    mimeType: 'audio/wav',
    durationMs: 900,
    byteLength: 100,
    sha256: 'a'.repeat(64),
  };
}
function fixture() {
  const lesson = createWordBeatLesson(
    ['take  part in', 'take part in', 'US', 'us'].map((english) => ({
      id: crypto.randomUUID(),
      english,
      meaning: '',
      priority: false,
    })),
  );
  lesson.gameData.voices.englishVoiceId = 'en-test';
  lesson.gameData.slogans.opening.enabled = false;
  lesson.gameData.slogans.closing.enabled = false;
  return lesson;
}
function terminal(requests: AudioRequest[], failed = false): TaskRecord {
  return {
    taskId: crypto.randomUUID(),
    kind: 'speech',
    state: failed ? 'partialFailure' : 'completed',
    stage: '检查',
    completed: failed ? 1 : requests.length,
    total: requests.length,
    results: (failed ? requests.slice(0, 1) : requests).map((request) => ({
      requestId: request.requestId,
      objectId: request.objectId,
      asset: asset(),
      cached: false,
    })),
    failures: failed
      ? [
          {
            requestId: requests[1].requestId,
            objectId: requests[1].objectId,
            error: { code: 'SYNTHESIS_FAILED', message: '合成失败', retryable: true },
          },
        ]
      : [],
    cancelRequested: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}
beforeEach(() => {
  api.synthesize.mockReset();
  api.getTask.mockReset();
  api.cancel.mockReset();
});

describe('制作固定输入的声音', () => {
  it('规范空白后的重复文本只合成一次，绑定每个独立位置且保留大小写区别', async () => {
    api.synthesize.mockImplementation(async (requests: AudioRequest[]) => terminal(requests));
    const input = fixture();
    const before = structuredClone(input);
    const result = await produceLesson(input, {}, vi.fn(), 'previous-task');
    const requests = api.synthesize.mock.calls[0][0] as AudioRequest[];
    expect(requests).toHaveLength(3);
    expect(api.synthesize).toHaveBeenCalledWith(
      requests,
      input.id,
      input.revision,
      'previous-task',
    );
    const entries = getEntries(result.lesson);
    expect(entries.every((entry) => entry.audio?.status === 'ready')).toBe(true);
    expect(entries[0].audio?.assetId).toBe(entries[1].audio?.assetId);
    expect(entries[2].audio?.assetId).not.toBe(entries[3].audio?.assetId);
    expect(new Set(entries.map((entry) => entry.id)).size).toBe(4);
    expect(input).toEqual(before);
  });

  it('部分失败仅采用成功声音，失败需求不能假装就绪', async () => {
    api.synthesize.mockImplementation(async (requests: AudioRequest[]) => terminal(requests, true));
    const result = await produceLesson(fixture(), {}, vi.fn());
    expect(getEntries(result.lesson).map((entry) => entry.audio?.status === 'ready')).toEqual([
      true,
      true,
      false,
      false,
    ]);
    expect(result.task?.state).toBe('partialFailure');
    expect(Object.keys(result.assets)).toHaveLength(1);
  });

  it('后端命中的旧音色缓存绑定所有位置并计为复用，已绑定声音重查不发新任务', async () => {
    api.synthesize.mockImplementation(async (requests: AudioRequest[]) => {
      const cached = terminal(requests);
      return {
        ...cached,
        results: cached.results.map((result) => ({ ...result, cached: true })),
      };
    });
    const input = fixture();
    const first = await produceLesson(input, {}, vi.fn());
    expect(first.task?.results.every((result) => result.cached)).toBe(true);
    expect(getEntries(first.lesson).every((entry) => entry.audio?.status === 'ready')).toBe(true);
    expect(getAudioProductionSummary(input, {}, first.task?.results)).toMatchObject({
      total: 3,
      created: 0,
      reused: 3,
      unfinished: 0,
    });
    api.synthesize.mockClear();
    const second = await produceLesson(first.lesson, first.assets, vi.fn());
    expect(api.synthesize).not.toHaveBeenCalled();
    expect(second.task).toBeUndefined();
    expect(second.lesson).toEqual(first.lesson);
  });

  it('重开任务按固定修订及教学对象恢复重复位置，忽略旧请求UUID且不改原草稿', () => {
    const input = fixture();
    const before = structuredClone(input);
    const ready = asset();
    const restored = restoreWordBeatAudioTask(
      input,
      {},
      {
        lessonId: input.id,
        inputRevision: input.revision,
        results: [{ objectId: getEntries(input)[0].id, asset: ready }],
      },
    );
    const entries = getEntries(restored.lesson);
    expect(entries[0].audio?.assetId).toBe(ready.assetId);
    expect(entries[1].audio?.assetId).toBe(ready.assetId);
    expect(entries[2].audio?.status).not.toBe('ready');
    expect(input).toEqual(before);
    expect(() =>
      restoreWordBeatAudioTask(
        input,
        {},
        {
          lessonId: input.id,
          inputRevision: input.revision + 1,
          results: [],
        },
      ),
    ).toThrow('声音成果与课件版本不一致');
  });

  it('停止页面观察会移除后续轮询，后台任务不被误取消', async () => {
    vi.useFakeTimers();
    try {
      const request: AudioRequest = {
        requestId: crypto.randomUUID(),
        objectId: crypto.randomUUID(),
        text: 'achievement',
        language: 'en-US',
        voiceId: 'en-test',
        rate: 1,
      };
      api.synthesize.mockResolvedValue({ ...terminal([request]), state: 'running', results: [] });
      const controller = new AbortController();
      const onTask = vi.fn();
      const operation = runAudioTask(
        [request],
        { lessonId: 'fixed', revision: 1 },
        onTask,
        controller.signal,
      );
      const stopped = expect(operation).rejects.toMatchObject({ name: 'AbortError' });
      await Promise.resolve();
      expect(onTask).toHaveBeenCalledOnce();
      controller.abort();
      await stopped;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(api.getTask).not.toHaveBeenCalled();
      expect(api.cancel).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
