/** 游戏声明驱动的双修订身份重建；只访问显式位置，教学文字与原文不替换。 @author ahui */
import type { LessonDocument, PackageIdentityPlan } from './types';

/** JSON Pointer只用于已验证对象；拒绝原型链键，不能由声明读写任意原型。 */
function location(
  value: unknown,
  pointer: string,
): { object: Record<string, unknown>; key: string } {
  const parts = pointer
    .split('/')
    .slice(1)
    .map((part) => part.replace(/~1/gu, '/').replace(/~0/gu, '~'));
  if (
    !pointer.startsWith('/') ||
    parts.some((part) => ['__proto__', 'constructor', 'prototype'].includes(part))
  )
    throw new Error('身份位置不合法。');
  const key = parts.pop()!;
  let current = value as Record<string, unknown>;
  for (const part of parts) {
    if (!current || typeof current !== 'object' || !Object.hasOwn(current, part))
      throw new Error('身份位置不存在。');
    current = current[part] as Record<string, unknown>;
  }
  if (!current || typeof current !== 'object' || !Object.hasOwn(current, key))
    throw new Error('身份位置不存在。');
  return { object: current, key };
}

/**
 * 编码引用遵循 RFC 6901：空指针表示整个 JSON 值，合法值也可能只是一个身份字符串。
 * 用独立容器承接根值替换；非空指针仍走完整位置校验，不允许普通课件声明访问文档根。
 */
function encodedLocation(root: { value: unknown }, pointer: string): ReturnType<typeof location> {
  return pointer === '' ? { object: root, key: 'value' } : location(root.value, pointer);
}

/**
 * 浏览器预览与原生包复制采用相同的声明契约。所有修订共用映射，旧版独有对象也重建；
 * 字段错误的位置键与objectId同步变更，raw/message始终原样保留。
 */
export function remapLocalSnapshots<T>(
  documents: LessonDocument<T>[],
  layouts: PackageIdentityPlan['revisions'],
): LessonDocument<T>[] {
  const copies = structuredClone(documents);
  const mapping = new Map<string, string>([[documents[0].id, crypto.randomUUID()]]);
  const register = (value: unknown) => {
    if (typeof value !== 'string' || !value) throw new Error('身份声明不是非空文本。');
    if (!mapping.has(value)) mapping.set(value, crypto.randomUUID());
  };
  for (const [index, document] of copies.entries()) {
    const layout = layouts[index].layout;
    for (const pointer of [...layout.identities, ...layout.references]) {
      const { object, key } = location(document, pointer);
      register(object[key]);
    }
    for (const encoded of layout.encodedReferences ?? []) {
      const { object, key } = location(document, encoded.path);
      const parsed = { value: JSON.parse(String(object[key])) as unknown };
      for (const pointer of encoded.references) {
        const target = encodedLocation(parsed, pointer);
        register(target.object[target.key]);
      }
    }
  }
  const replace = ({ object, key }: ReturnType<typeof location>) => {
    object[key] = mapping.get(String(object[key])) ?? object[key];
  };
  for (const [index, document] of copies.entries()) {
    const layout = layouts[index].layout;
    for (const pointer of [...layout.identities, ...layout.references])
      replace(location(document, pointer));
    for (const encoded of layout.encodedReferences ?? []) {
      const target = location(document, encoded.path);
      const parsed = { value: JSON.parse(String(target.object[target.key])) as unknown };
      for (const pointer of encoded.references) replace(encodedLocation(parsed, pointer));
      target.object[target.key] = JSON.stringify(parsed.value);
    }
    document.id = mapping.get(document.id)!;
    if (document.draftInputs)
      document.draftInputs = Object.fromEntries(
        Object.entries(document.draftInputs).map(([key, input]) => [
          key
            .split('.')
            .map((part) => mapping.get(part) ?? part)
            .join('.'),
          {
            ...input,
            ...(input.objectId ? { objectId: mapping.get(input.objectId) ?? input.objectId } : {}),
          },
        ]),
      );
  }
  return copies;
}
