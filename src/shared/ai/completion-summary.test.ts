/** 真实补全成果口径：只有教师明确接受且仍存在的字段才计数。 @author ahui */
import { describe, expect, it } from 'vitest';
import type { TeachingEntry } from '../../platform/types';
import { countConfirmedFields } from './completion-summary';

const entry: TeachingEntry = {
  id: 'word',
  english: 'challenge',
  meaning: '挑战',
  partOfSpeech: 'n.',
  priority: false,
  meaningSource: { name: '基础词库', version: '1', english: 'challenge' },
};

describe('确认补全字段', () => {
  it('已有内容、候选或旧资料没有明确接受记录时不倒推成果', () => {
    expect(countConfirmedFields([entry, { ...entry, meaningSource: undefined }])).toBe(0);
  });
  it('释义与词性按实际接受字段分别计数，同条重复标记不累计', () => {
    expect(
      countConfirmedFields([
        {
          ...entry,
          meaningSource: {
            ...entry.meaningSource!,
            acceptedFields: ['meaning', 'partOfSpeech', 'meaning'],
          },
        },
      ]),
    ).toBe(2);
  });
  it('教师已清空的字段不继续冒充当前补全成果', () => {
    expect(
      countConfirmedFields([
        {
          ...entry,
          meaning: ' ',
          meaningSource: { ...entry.meaningSource!, acceptedFields: ['meaning', 'partOfSpeech'] },
        },
      ]),
    ).toBe(1);
  });
});
