/** Evidence-based column suggestions leave ambiguous teacher content unresolved. @author ahui */
import { expect, it } from 'vitest';
import { suggestMaterialColumns } from '../src/platform/materials/parser';

it('suggests bilingual/POS/unit/priority fields without inventing a tag column', () => {
  expect(
    suggestMaterialColumns([
      ['achievement', '成就', 'n.', 'Unit 1', '是'],
      ['concentrate', '集中', 'v.', 'Unit 2', '否'],
    ]),
  ).toEqual(['english', 'meaning', 'partOfSpeech', 'unit', 'priority']);
  expect(suggestMaterialColumns([['record', '记录', 'n.', 'Unit 1', '复习', '是']])).toEqual([
    'english',
    '',
    'partOfSpeech',
    'unit',
    '',
    'priority',
  ]);
});

it('does not choose among competing language/metadata columns or assign empty fields', () => {
  expect(suggestMaterialColumns([['record', 'read', '记录', 'n.', 'v.', '']])).toEqual([
    '',
    '',
    'meaning',
    '',
    '',
    '',
  ]);
  expect(suggestMaterialColumns([])).toEqual([]);
});
