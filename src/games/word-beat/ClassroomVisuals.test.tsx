// @vitest-environment jsdom
/** 朗读次数与真实基础拍的语义回归；不以 jsdom 结果代替实际视觉验收。 @author ahui */
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BeatTrail, type BeatTrailProps } from './ClassroomVisuals';

beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** 来自编排的合法拍位；测试只修改呈现输入，不创建或推进课堂时钟。 */
const props: BeatTrailProps = {
  mode: 'blocks',
  english: 'take part in',
  activeBeat: 0,
  totalBeats: 4,
  beatsPerRead: 2,
  beatsElapsed: 0,
  playing: true,
  animations: true,
  timelineKey: 'same-word-same-round',
};

it.each(['centered', 'blocks'] as const)(
  '%s：四拍两次朗读常驻解释，两拍刻度独立更新而不重复朗读强调',
  (mode) => {
    const view = render(<BeatTrail {...props} mode={mode} />);
    expect(view.container.querySelector('.ecg-chorus-summary')).toHaveTextContent(
      '每轮 4 拍 · 读 2 次 · 每次 2 拍',
    );
    expect(view.container.querySelectorAll('.ecg-beat-block')).toHaveLength(2);
    expect(view.container.querySelectorAll('.ecg-read-beats [data-current]')).toHaveLength(4);
    expect(screen.getByText('第 1 次')).toBeInTheDocument();
    expect(screen.getByText('第 2 次')).toBeInTheDocument();
    const active = () => view.container.querySelector('.ecg-read-beats [data-current="true"]');
    expect(active()).toHaveTextContent('1');
    const firstWord = view.container.querySelector('.ecg-beat-word');
    const firstHit = view.container.querySelector('.ecg-beat-hit');
    view.rerender(<BeatTrail {...props} mode={mode} beatsElapsed={1} activeBeat={1} />);
    expect(active()).toHaveTextContent('2');
    expect(view.container.querySelector('.ecg-beat-word')).toBe(firstWord);
    expect(view.container.querySelector('.ecg-beat-hit')).toBe(firstHit);
    expect(view.container.querySelector('.ecg-pulse-active .ecg-beat-number')).toHaveTextContent(
      '第 1 次',
    );
    view.rerender(<BeatTrail {...props} mode={mode} beatsElapsed={2} activeBeat={2} />);
    expect(active()).toHaveTextContent('3');
    expect(view.container.querySelector('.ecg-beat-hit')).not.toBe(firstHit);
    expect(view.container.querySelector('.ecg-pulse-active .ecg-beat-number')).toHaveTextContent(
      '第 2 次',
    );
    view.rerender(<BeatTrail {...props} mode={mode} beatsElapsed={3} playing={false} />);
    expect(active()).toHaveTextContent('4');
    expect(view.container.querySelector('.ecg-beat-hit')).not.toBeInTheDocument();
    expect(view.container.querySelectorAll('.ecg-beat-word')).toHaveLength(2);
  },
);

it.each([
  [1, 1, 0, 1, 1],
  [4, 1, 3, 4, 4],
  [8, 2, 7, 4, 8],
  [32, 1, 8, 4, 9],
  [32, 2, 8, 4, 9],
])(
  '%s拍/每次%s拍在第%s个偏移仍只显示%s个朗读槽，保留真实拍号%s',
  (totalBeats, beatsPerRead, beatsElapsed, count, activeNumber) => {
    const view = render(
      <BeatTrail
        {...props}
        totalBeats={totalBeats}
        beatsPerRead={beatsPerRead}
        beatsElapsed={beatsElapsed}
        playing={false}
      />,
    );
    expect(view.container.querySelectorAll('.ecg-beat-block')).toHaveLength(count);
    expect(view.container.querySelectorAll('.ecg-read-beats [data-current]')).toHaveLength(
      count * beatsPerRead,
    );
    expect(view.container.querySelector('.ecg-read-beats [data-current="true"]')).toHaveTextContent(
      String(activeNumber),
    );
    expect(view.container.querySelector('.ecg-chorus-summary')).toHaveTextContent(
      `读 ${totalBeats / beatsPerRead} 次`,
    );
    expect(
      [...view.container.querySelectorAll('.ecg-beat-word')].every(
        (node) => node.getAttribute('data-word') === props.english,
      ),
    ).toBe(true);
  },
);

it('原有示范/跟读与准备仍使用原四拍结构，不显示齐读摘要或次数标签', () => {
  const view = render(<BeatTrail {...props} totalBeats={undefined} />);
  expect(view.container.querySelector('.ecg-chorus-guide')).not.toBeInTheDocument();
  expect(view.container.querySelector('.ecg-read-caption')).not.toBeInTheDocument();
  expect(view.container.querySelectorAll('.ecg-beat-block')).toHaveLength(4);
  expect(view.container.querySelector('.ecg-beat-number')).toHaveTextContent('1');
  view.rerender(<BeatTrail {...props} totalBeats={undefined} preparationBeats={2} english="" />);
  expect(view.container.querySelectorAll('.ecg-beat-block')).toHaveLength(2);
  expect(view.container.querySelector('.ecg-chorus-summary')).not.toBeInTheDocument();
});
