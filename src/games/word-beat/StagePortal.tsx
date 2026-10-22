/**
 * 单词节拍的开场主视觉：以真实课件词语组成悬浮卡与节拍核心，
 * 图形只表达课堂风格，不假装学生成绩、模型推理或语音识别。
 * 旋转、扫描及悬浮由父场景的 data-motion 统一控制，无独立计时器。
 * @author ahui
 */
import { Sparkle, Waveform } from '@phosphor-icons/react';
import { useId } from 'react';

/** 门户只接收已确认课件的少量展示词，不保留或修改教学数据。 */
export interface StagePortalProps {
  /** 最多展示前三个词；没有词时保留节拍图形，不制造教学内容。 */
  words: string[];
}

/**
 * 纯 SVG/CSS 构成的立体能量装置，内嵌离线 HTML 后不依赖字体服务或外部图片。
 * 内容与上方课名重复，整块装饰从辅助技术中隐藏并且不拦截操作。
 */
export function StagePortal({ words }: StagePortalProps) {
  const gradientId = useId();
  return (
    <div className="ecg-stage-portal" aria-hidden="true">
      <div className="ecg-portal-aura" />
      <div className="ecg-portal-orbit ecg-portal-orbit--outer" />
      <div className="ecg-portal-orbit ecg-portal-orbit--inner" />
      <svg className="ecg-portal-diagram" viewBox="0 0 520 520" fill="none">
        <defs>
          <linearGradient
            id={gradientId}
            gradientUnits="userSpaceOnUse"
            x1="80"
            y1="80"
            x2="440"
            y2="440"
          >
            <stop stopColor="var(--game-cyan)" />
            <stop offset="0.5" stopColor="var(--game-violet)" />
            <stop offset="1" stopColor="var(--game-pink)" />
          </linearGradient>
        </defs>
        <g className="ecg-portal-ring">
          <circle cx="260" cy="260" r="220" stroke={`url(#${gradientId})`} strokeWidth="2" />
          <circle
            cx="260"
            cy="260"
            r="207"
            stroke="var(--game-cyan)"
            strokeDasharray="2 19"
            strokeWidth="6"
          />
          <path
            d="M260 40 A220 220 0 0 1 480 260 M260 480 A220 220 0 0 1 40 260"
            stroke="var(--game-cyan)"
            strokeWidth="7"
          />
        </g>
        <g className="ecg-portal-ring ecg-portal-ring--reverse">
          <path
            d="M260 88 409 174 409 346 260 432 111 346 111 174Z"
            stroke={`url(#${gradientId})`}
            strokeWidth="2"
          />
          <circle
            cx="260"
            cy="260"
            r="158"
            stroke="var(--game-violet)"
            strokeDasharray="90 25 6 25"
            strokeWidth="3"
          />
          <circle cx="260" cy="88" r="7" fill="var(--game-cyan)" />
          <circle cx="409" cy="346" r="6" fill="var(--game-pink)" />
        </g>
        <path
          d="M56 382 108 382 136 354 M412 140 440 112 498 112 M29 174 83 174"
          stroke="var(--game-cyan)"
          strokeWidth="2"
        />
        <circle cx="56" cy="382" r="4" fill="var(--game-cyan)" />
        <circle cx="498" cy="112" r="4" fill="var(--game-pink)" />
      </svg>
      <div className="ecg-portal-core">
        <span className="ecg-portal-core-kicker">
          <Sparkle weight="fill" size={16} /> 本地节拍核心
        </span>
        <strong>
          WORD<span>BEAT</span>
        </strong>
        <div className="ecg-portal-wave">
          <Waveform weight="fill" size={58} />
          <span>词语 × 声音 × 节奏</span>
        </div>
      </div>
      {words.slice(0, 3).map((word, index) => (
        <div className={`ecg-portal-word ecg-portal-word--${index}`} key={`${index}-${word}`}>
          <span>{String(index + 1).padStart(2, '0')}</span>
          <strong>{word}</strong>
          <i />
        </div>
      ))}
      <div className="ecg-portal-platform">
        <i />
        <i />
        <i />
      </div>
    </div>
  );
}
