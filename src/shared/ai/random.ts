/** 可重复选择工具；规则版本固定时不因打开、保存或导出改变结果。 @author ahui */

/**
 * 创建 xorshift32 序列。seed 必须为非零无符号32位整数；输出在 [0,1) 内。
 * @throws seed 不合法时抛 RangeError，不将非法值静默夹到允许范围。
 */
export function createRandom(seed: number): () => number {
  if (!Number.isInteger(seed) || seed <= 0 || seed > 0xffffffff) {
    throw new RangeError('随机选择标记必须是非零32位整数。');
  }
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
}

/** Fisher–Yates 只返回排列后的副本，不改变输入数组或其他段落。 */
export function shuffle<T>(items: readonly T[], random: () => number): T[] {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1));
    [result[index], result[target]] = [result[target], result[index]];
  }
  return result;
}

/** 生成可持久化标记；仅创建新课或教师主动改编时调用。 */
export function newRandomSeed(): number {
  const values = new Uint32Array(1);
  globalThis.crypto.getRandomValues(values);
  return values[0] || 1;
}

/** 规范化语音空白，保留大小写、撇号和连字符以防误用声音。 */
export function normalizeSpeechText(text: string): string {
  return text.trim().replace(/\s+/gu, ' ');
}
