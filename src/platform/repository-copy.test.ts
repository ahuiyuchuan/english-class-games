/** 本地另存使用真实repository编排，原生事务另由Rust集成验证。 @author ahui */
import { beforeEach, expect, it, vi } from 'vitest';
// 在收集测试时载入真实持久化模块；用例只计时另存操作，避免首次依赖载入超时后迟到调用。
import { saveLocalLessonCopy } from './repository';
import {
  createWordBeatLesson,
  refreshAudioDependencies,
  resolveSloganText,
} from '../games/word-beat/rules';

const ipc = vi.hoisted(() => ({ get: vi.fn(), copy: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true }));
vi.mock('./native', () => ({ getLesson: ipc.get, saveLessonCopy: ipc.copy }));
beforeEach(() => {
  vi.clearAllMocks();
});

it('只读取明确准备修订，双快照保留本地错误与未保存修改，异步期间的新编辑不混入', async () => {
  const old = createWordBeatLesson(
    [{ id: crypto.randomUUID(), english: 'knowledge', meaning: '知识', priority: false }],
    { soundMode: 'teacher' },
  );
  old.revision = 3;
  old.preparedRevision = 3;
  old.gameData.slogans.opening.text = '{{lessonName}}，开始跟读';
  old.gameData.slogans.opening.audio = {
    source: 'recording',
    assetId: crypto.randomUUID(),
    text: resolveSloganText(old, old.gameData.slogans.opening),
    language: 'zh-CN',
    rate: 1,
    status: 'ready',
  };
  const local = structuredClone(old);
  local.revision = 4;
  local.name = '教师当前未保存';
  local.draftInputs = { bpm: { raw: '-', message: '未完成' } };
  ipc.get.mockResolvedValueOnce(old);
  ipc.copy.mockImplementation(async (documents) => documents.at(-1));
  const pending = saveLocalLessonCopy(local, ' 本地独立副本 ');
  local.name = '发起后新的输入';
  local.draftInputs.bpm.raw = 'later';
  await pending;
  expect(ipc.get).toHaveBeenCalledExactlyOnceWith(old.id, 3);
  const [documents, layouts] = ipc.copy.mock.calls[0];
  expect(documents.map((document: { revision: number }) => document.revision)).toEqual([1, 2]);
  expect(documents.map((document: { name: string }) => document.name)).toEqual([
    old.name,
    '本地独立副本',
  ]);
  expect(refreshAudioDependencies(documents[0]).gameData.slogans.opening.audio?.status).toBe(
    'ready',
  );
  expect(refreshAudioDependencies(documents[1]).gameData.slogans.opening.audio?.status).toBe(
    'stale',
  );
  expect(documents[1].draftInputs.bpm.raw).toBe('-');
  expect(documents[0].sourceLesson.revision).toBe(3);
  expect(documents[1].sourceLesson.revision).toBe(4);
  expect(layouts.map((layout: { revision: number }) => layout.revision)).toEqual([1, 2]);
  expect(old.name).not.toBe('本地独立副本');
});

it('没有准备版只保存一份；非法名称在任何读取与写入前拒绝', async () => {
  const local = createWordBeatLesson(
    [{ id: crypto.randomUUID(), english: 'test', meaning: '', priority: false }],
    { soundMode: 'teacher' },
  );
  local.revision = 1;
  await expect(saveLocalLessonCopy(local, ' ')).rejects.toThrow('副本名称');
  expect(ipc.get).not.toHaveBeenCalled();
  expect(ipc.copy).not.toHaveBeenCalled();
  ipc.copy.mockImplementation(async (documents) => documents.at(-1));
  await saveLocalLessonCopy(local, '未完成备课');
  expect(ipc.get).not.toHaveBeenCalled();
  expect(ipc.copy.mock.calls[0][0]).toHaveLength(1);
  expect(ipc.copy.mock.calls[0][0][0].preparedRevision).toBeNull();
});
