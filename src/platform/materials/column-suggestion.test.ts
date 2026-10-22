/** 列建议不得越过歧义和教师确认边界。 @author ahui */
import { expect, it } from 'vitest';
import { suggestBilingualColumns } from './parser';
it('识别正反双列，不自动接受混合、缺失或三列材料', () => {
  expect(
    suggestBilingualColumns([
      ['record', '记录'],
      ['take part in', '参加'],
    ]),
  ).toEqual(['english', 'meaning']);
  expect(suggestBilingualColumns([['记录', 'record']])).toEqual(['meaning', 'english']);
  expect(
    suggestBilingualColumns([
      ['record', 'n.'],
      ['take part in', '参加'],
    ]),
  ).toBeUndefined();
  expect(suggestBilingualColumns([['record', '']])).toBeUndefined();
  expect(suggestBilingualColumns([['record', '记录', 'n.']])).toBeUndefined();
});
