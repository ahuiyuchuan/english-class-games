/**
 * 浏览器真实 IndexedDB 一致性回归。每例使用独立上下文，不模拟事务完成、CAS或落盘，
 * 不修改其他端到端案例的资料；直接调用应用实际持久化适配器检查公共数据契约。
 * @author ahui
 */
import { expect, test } from '@playwright/test';

test('旧客户端保存保留准备指针，两个并发保存仅一个CAS成功', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const repositoryPath = '/src/platform/repository.ts';
    const rulesPath = '/src/games/word-beat/rules.ts';
    const repository = await import(repositoryPath);
    const { createWordBeatLesson } = await import(rulesPath);
    const initial = createWordBeatLesson(
      [{ id: crypto.randomUUID(), english: 'achievement', meaning: '成就', priority: false }],
      { soundMode: 'teacher' },
    );
    initial.gameData.slogans.opening.enabled = false;
    initial.gameData.slogans.closing.enabled = false;
    // 新课不能通过客户端伪造历史准备指针。
    initial.preparedRevision = 999;
    const first = await repository.saveLesson(initial, 0);
    const oldClient = structuredClone(first);
    await repository.markPrepared(first);
    const second = await repository.saveLesson({ ...oldClient, name: '保留已准备修订' }, 1);
    const head = await repository.getLesson(first.id);
    const contenders = await Promise.allSettled([
      repository.saveLesson({ ...second, name: '并发甲', preparedRevision: 999 }, 2),
      repository.saveLesson({ ...second, name: '并发乙', preparedRevision: null }, 2),
    ]);
    const current = await repository.getLesson(first.id);
    // 历史入口仅允许当前确实保留的最近准备版，不把任意旧草稿提升为准备版。
    const historical = await Promise.allSettled([repository.markPrepared(second, [], true)]);
    const afterRejectedPrepare = await repository.getLesson(first.id);
    return {
      forgedPointer: first.preparedRevision ?? null,
      preservedPointer: second.preparedRevision,
      headPointer: head.preparedRevision,
      acceptedSaves: contenders.filter((item) => item.status === 'fulfilled').length,
      rejectedSaves: contenders.filter((item) => item.status === 'rejected').length,
      finalRevision: current.revision,
      finalPointer: current.preparedRevision,
      historicalState: historical[0].status,
      pointerAfterRejectedPrepare: afterRejectedPrepare.preparedRevision,
    };
  });
  expect(result).toEqual({
    forgedPointer: null,
    preservedPointer: 1,
    headPointer: 1,
    acceptedSaves: 1,
    rejectedSaves: 1,
    finalRevision: 3,
    finalPointer: 1,
    historicalState: 'rejected',
    pointerAfterRejectedPrepare: 1,
  });
});

test('游戏偏好经模块校验、隔离持久化，旧平铺迁移不自动回写', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const repositoryPath = '/src/platform/repository.ts';
    const repository = await import(repositoryPath);
    const original = { gameDefaults: { 'uninstalled-game': { layout: 'wide' } } };
    const next = repository.withGamePreferences(original, 'word-beat', {
      preset: 'focus',
      targetDurationMs: 450_000,
    });
    await repository.saveTeacherPreferences(next);
    const restored = await repository.readTeacherPreferences();
    const defaults = repository.getGamePreferences(restored, 'word-beat');
    defaults.preset = 'quick';
    const invalid: string[] = [];
    for (const value of [{ targetDurationMs: 30_000 }, { englishRate: 0.7 }, { bpm: 100 }]) {
      try {
        repository.withGamePreferences(restored, 'word-beat', value);
      } catch {
        invalid.push('rejected');
      }
    }
    const legacy = { preset: 'quick', targetDurationMs: 120_000 };
    await repository.writeAppData('preferences', legacy);
    const migrated = await repository.readTeacherPreferences();
    const storedAfterRead = await repository.readAppData('preferences', null);
    return {
      original,
      restored,
      independentPreset: repository.getGamePreferences(restored, 'word-beat').preset,
      invalid,
      legacyPreset: repository.getGamePreferences(migrated, 'word-beat').preset,
      storedAfterRead,
    };
  });
  expect(result.original).toEqual({ gameDefaults: { 'uninstalled-game': { layout: 'wide' } } });
  expect(result.restored.gameDefaults['uninstalled-game']).toEqual({ layout: 'wide' });
  expect(result.independentPreset).toBe('focus');
  expect(result.invalid).toEqual(['rejected', 'rejected', 'rejected']);
  expect(result.legacyPreset).toBe('quick');
  expect(result.storedAfterRead).toEqual({ preset: 'quick', targetDurationMs: 120_000 });
});
