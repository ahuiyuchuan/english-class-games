/** 双修订复制保留教学文本与错误原值，仅重建声明的身份。 @author ahui */
import { describe, expect, it } from 'vitest';
import { remapLocalSnapshots } from './snapshot-copy';
import type { LessonDocument } from './types';

describe('统一双修订身份映射', () => {
  it('旧版独有对象与建议引用统一重建，原文恰好等于ID仍不改写', () => {
    const source: LessonDocument = {
      id: 'lesson',
      name: '原课',
      revision: 1,
      dataVersion: 1,
      gameId: 'fixture',
      createdAt: '',
      updatedAt: '',
      gameData: {
        cards: [{ id: 'card', text: 'card' }],
        focus: 'card',
        dependency: JSON.stringify({ ref: 'card', text: 'card' }),
        rootDependency: JSON.stringify('card'),
        teachingDependency: JSON.stringify('card'),
      },
    };
    const draft: LessonDocument = {
      ...structuredClone(source),
      revision: 2,
      gameData: { cards: [], focus: 'card' },
      draftInputs: { 'card.answer': { objectId: 'card', raw: 'card', message: '未完成' } },
    };
    const copies = remapLocalSnapshots(
      [source, draft],
      [
        {
          revision: 1,
          layout: {
            identities: ['/gameData/cards/0/id'],
            references: ['/gameData/focus'],
            encodedReferences: [
              { path: '/gameData/dependency', references: ['/ref'] },
              { path: '/gameData/rootDependency', references: [''] },
              { path: '/gameData/teachingDependency', references: [] },
            ],
          },
        },
        { revision: 2, layout: { identities: [], references: ['/gameData/focus'] } },
      ],
    );
    const old = copies[0].gameData as typeof source.gameData & {
      cards: { id: string; text: string }[];
      focus: string;
      dependency: string;
      rootDependency: string;
      teachingDependency: string;
    };
    expect(copies[0].id).toBe(copies[1].id);
    expect(copies[0].id).not.toBe(source.id);
    expect(old.cards[0].id).not.toBe('card');
    expect(old.cards[0].text).toBe('card');
    expect((copies[1].gameData as { focus: string }).focus).toBe(old.cards[0].id);
    expect(JSON.parse(old.dependency)).toEqual({ ref: old.cards[0].id, text: 'card' });
    expect(JSON.parse(old.rootDependency)).toBe(old.cards[0].id);
    expect(JSON.parse(old.teachingDependency)).toBe('card');
    expect(copies[1].draftInputs?.[`${old.cards[0].id}.answer`]).toEqual({
      objectId: old.cards[0].id,
      raw: 'card',
      message: '未完成',
    });
    expect(source.id).toBe('lesson');
    expect(draft.draftInputs?.['card.answer'].raw).toBe('card');
  });

  it.each([
    { name: '普通课件根位置', path: '', encoded: false, value: 'card', message: '不合法' },
    { name: '编码根值为空', path: '', encoded: true, value: '', message: '非空文本' },
    { name: '编码根值为数字', path: '', encoded: true, value: 12, message: '非空文本' },
    {
      name: '编码原型链位置',
      path: '/__proto__/id',
      encoded: true,
      value: {},
      message: '不合法',
    },
    {
      name: '编码相对位置',
      path: 'id',
      encoded: true,
      value: { id: 'card' },
      message: '不合法',
    },
    {
      name: '编码不存在位置',
      path: '/missing',
      encoded: true,
      value: { id: 'card' },
      message: '不存在',
    },
  ])('$name仍拒绝，失败不改变原课件', ({ path, encoded, value, message }) => {
    const source: LessonDocument = {
      id: 'lesson',
      name: '原课',
      revision: 1,
      dataVersion: 1,
      gameId: 'fixture',
      createdAt: '',
      updatedAt: '',
      gameData: { dependency: JSON.stringify(value) },
    };
    const before = structuredClone(source);
    expect(() =>
      remapLocalSnapshots(
        [source],
        [
          {
            revision: 1,
            layout: {
              identities: [],
              references: encoded ? [] : [path],
              encodedReferences: encoded
                ? [{ path: '/gameData/dependency', references: [path] }]
                : [],
            },
          },
        ],
      ),
    ).toThrow(message);
    expect(source).toEqual(before);
  });
});
