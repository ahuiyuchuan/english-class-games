/** 真正执行处理算法，验证时长、音高及有限资源边界，不用模拟处理结果。 @author ahui */
import { describe, expect, it } from 'vitest';
import { stretchMusic } from './music-stretch';

describe('保音高音乐预处理', () => {
  const sampleRate = 48000;
  const tone = Float32Array.from(
    { length: sampleRate * 4 },
    (_, i) => Math.sin((i * 2 * Math.PI * 440) / sampleRate) * 0.5,
  );
  /** 稳态区间正向过零计数；明确不把时长正确当作音高正确。 */
  function frequency(data: Float32Array) {
    let crosses = 0;
    for (let i = sampleRate + 1; i < sampleRate * 2; i++)
      if (data[i - 1] <= 0 && data[i] > 0) crosses++;
    return crosses;
  }
  it.each([0.75, 0.9, 1, 1.1, 1.2, 1.25])('%s倍保留440Hz并按真实倍率改变时长', (rate) => {
    const before = tone.slice();
    const [output] = stretchMusic([tone], sampleRate, rate, true);
    expect(output.length).toBe(Math.ceil(tone.length / rate));
    expect(frequency(output)).toBeGreaterThanOrEqual(437);
    expect(frequency(output)).toBeLessThanOrEqual(443);
    expect(tone).toEqual(before);
  });
  it('明确关闭保音高才允许升调；超范围拒绝', () => {
    expect(frequency(stretchMusic([tone], sampleRate, 1.2, false)[0])).toBeCloseTo(528, 0);
    expect(() => stretchMusic([tone], sampleRate, 1.3, true)).toThrow('0.75');
  });
});
