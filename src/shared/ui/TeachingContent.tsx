/**
 * 桌面预览与离线课堂共用的教学文字区域。按真实排版结果选择固定字号，
 * 不用屏幕宽度推算长词、短语或中文释义的尺寸，也不改变教学原文。
 * @author ahui
 */
import { useLayoutEffect, useRef } from 'react';
import './teaching-content.css';

/** 档位由设计规范统一管理；较小档位仅在实际内容区较窄或较矮时开放。 */
const WORD_SIZES = [144, 128, 112, 96, 80, 64];
// 中英文成对降档，避免大英文抢占空间、把后排需要看的中文先压成辅助小字。
const MEANING_SIZES = [64, 56, 48, 40, 36, 32];

/** 教学内容只负责文字布局；声音、节奏、阶段和教师控制由外部场景管理。 */
export interface TeachingContentProps {
  /** 原样显示的英文或口号；空态由调用方传入明确文字。 */
  english: string;
  /** 当前可见的教学释义；不显示时省略，不保留空白占位。 */
  meaning?: string;
  /** 课堂使用 h1，编辑器静态预览使用 div，避免增加无关标题层级。 */
  wordAs?: 'h1' | 'div';
  /** 场景附加样式，不得覆盖本组件的固定字号或将内容裁切。 */
  className?: string;
}

/**
 * 在分配到的内容区域内选择可同时容纳英文与释义的最大成对档位。
 * 最大档自然换行仍溢出时先压缩父舞台装饰留白，之后才降字号；最低档仍不足
 * 则保留全文并只让本区域纵向滚动。布局测量与播放时钟完全独立。
 */
export function TeachingContent({
  english,
  meaning,
  wordAs: Word = 'h1',
  className = '',
}: TeachingContentProps) {
  const contentRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const content = contentRef.current;
    const text = textRef.current;
    const stage = content?.parentElement;
    if (!content || !text || !stage) return;

    let frame = 0;
    let disposed = false;
    let measuredSize = '';

    /** 只观察外部可用空间，避免字号变化后重复处理同一最终尺寸。 */
    const sizeKey = () =>
      `${content.clientWidth}:${content.clientHeight}:${stage.clientWidth}:${stage.clientHeight}`;
    const setSizes = (wordSize: number, meaningSize: number) => {
      content.style.setProperty('--teaching-word-size', `${wordSize}px`);
      content.style.setProperty('--teaching-meaning-size', `${meaningSize}px`);
    };
    const fits = () =>
      text.scrollHeight <= content.clientHeight + 1 && text.scrollWidth <= content.clientWidth + 1;

    const fit = () => {
      frame = 0;
      if (disposed || content.clientWidth <= 0 || content.clientHeight <= 0) return;

      // 每次外部尺寸或原文改变，都从正常留白和最大字号重查，允许放大窗口后恢复。
      content.dataset.compact = 'false';
      setSizes(WORD_SIZES[0], MEANING_SIZES[0]);
      if (!fits()) content.dataset.compact = 'true';

      // CSS 的 :has() 会先收紧舞台间距，再读实际内容区，不能只按窗口断点假定能放下。
      const narrow = content.clientWidth < 1000 || content.clientHeight < 640;
      const wordSizes = narrow ? [...WORD_SIZES, 48, 40] : WORD_SIZES;
      const meaningSizes = narrow ? [...MEANING_SIZES, 28, 24] : MEANING_SIZES;
      let fitted = false;
      // 每个英文档位对应一个释义档位，最多八次测量；无释义时仍按英文档位适配。
      for (const [index, wordSize] of wordSizes.entries()) {
        setSizes(wordSize, meaningSizes[index]);
        if (fits()) {
          fitted = true;
          break;
        }
      }

      // 只有确实需要滚动时增加键盘入口；不把全文改成省略号或缩到规范之外。
      content.dataset.overflow = fitted ? 'false' : 'true';
      content.tabIndex = fitted ? -1 : 0;
      content.setAttribute('aria-label', fitted ? '教学内容' : '教学内容，可纵向滚动查看全文');
      measuredSize = sizeKey();
    };
    const schedule = () => {
      if (!disposed && !frame && sizeKey() !== measuredSize) frame = requestAnimationFrame(fit);
    };

    content.scrollTop = 0;
    fit();
    const observer =
      typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(schedule);
    observer?.observe(content);
    observer?.observe(stage);
    window.addEventListener('resize', schedule);
    // 系统字体加载完成也重新测量；不引入网络字体或依赖字体的固定字符宽度估算。
    void document.fonts?.ready.then(() => {
      if (!disposed) {
        measuredSize = '';
        schedule();
      }
    });
    return () => {
      disposed = true;
      observer?.disconnect();
      window.removeEventListener('resize', schedule);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [english, meaning]);

  return (
    <div
      ref={contentRef}
      className={`teaching-content ${className}`.trim()}
      role="region"
      aria-label="教学内容"
      data-compact="false"
    >
      <div ref={textRef} className="teaching-content__text">
        <Word className="teaching-content__word">{english}</Word>
        {meaning && <p className="teaching-content__meaning">{meaning}</p>}
      </div>
    </div>
  );
}
