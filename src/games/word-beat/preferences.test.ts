/** 新课默认值范围与隔离回归，不允许平台代替模块猜测数据。 @author ahui */
import { describe, expect, it } from 'vitest';
import {
  getDefaultWordBeatPreferences,
  migrateLegacyWordBeatPreferences,
  validateWordBeatPreferences,
} from './preferences';

describe('单词节拍模块偏好', () => {
  it('补齐缺省且返回独立对象，合法值只用于新课', () => {
    const defaults = getDefaultWordBeatPreferences();
    expect(defaults).toMatchObject({
      preset: 'regular',
      englishRate: 1,
      progression: 'auto',
      displayMode: 'blocks',
      targetDurationMs: 300_000,
    });
    defaults.targetDurationMs = 60_000;
    expect(getDefaultWordBeatPreferences().targetDurationMs).toBe(300_000);
    expect(
      validateWordBeatPreferences({
        preset: 'quick',
        englishRate: 0.75,
        progression: 'step',
        displayMode: 'centered',
        targetDurationMs: 1_800_000,
      }),
    ).toMatchObject({ preset: 'quick', progression: 'step', displayMode: 'centered' });
  });
  it.each([
    { englishRate: 0.7 },
    { chineseRate: 1.3 },
    { targetDurationMs: 30_000 },
    { progression: 'manual' },
    { bpm: 100 },
    null,
  ])('拒绝非法值而非悄悄保存 %j', (input) => {
    expect(() => validateWordBeatPreferences(input)).toThrow(/不合法/);
  });
  it('旧平铺值由模块认领，未知字段不被带入本游戏', () => {
    expect(migrateLegacyWordBeatPreferences({ unrelated: true })).toBeUndefined();
    expect(migrateLegacyWordBeatPreferences({ preset: 'quick', unrelated: true })).toMatchObject({
      preset: 'quick',
    });
    expect(() => migrateLegacyWordBeatPreferences({ englishRate: 8 })).toThrow(/不合法/);
  });
});
