/**
 * 工作台的全息编排装置：以材料卡、编排核心及声音轨道说明真实制作能力。
 * 轨道与粒子是独立装饰，既不代表任务正在运行，也不伪造制作进度或学生分数。
 * SVG 使用实例内渐变标识，避免多实例串色；减少动态效果时保留完整静态示意。
 * @author ahui
 */
import { useId } from 'react';
import type { CSSProperties } from 'react';
import { FileText, Sparkle, SpeakerHigh, Waveform } from '@phosphor-icons/react';

const WAVE_HEIGHTS = [10, 23, 17, 35, 25, 44, 31, 53, 28, 45, 34, 19, 30, 15, 23];

/** 单个可访问说明描述能力图；内部装饰不重复进入键盘或读屏顺序。 */
export function PreparationVisual() {
  const instanceId = useId().replace(/:/g, '');
  const coreGradient = `${instanceId}-core`;
  const ringGradient = `${instanceId}-ring`;

  return (
    <div
      className="preparation-visual"
      role="img"
      aria-label="智能制作示意：教学材料进入本地规则编排核心，结合声音与节拍，生成可编辑、可携带的课堂文件。"
    >
      <div className="preparation-canvas" aria-hidden="true">
        <div className="preparation-grid" />
        <div className="preparation-beam preparation-beam--one" />
        <div className="preparation-beam preparation-beam--two" />
        <div className="preparation-particles">
          {Array.from({ length: 22 }, (_, index) => (
            <i
              key={index}
              style={
                {
                  '--particle-x': `${(index * 37 + 13) % 100}%`,
                  '--particle-y': `${(index * 19 + 7) % 100}%`,
                  '--particle-delay': `${-(index % 7)}s`,
                  '--particle-duration': `${6 + (index % 5)}s`,
                } as CSSProperties
              }
            />
          ))}
        </div>
        <div className="preparation-caption">
          <span className="preparation-caption-mark">
            <Sparkle size={14} weight="fill" /> LOCAL RULES
          </span>
          <span>智能制作示意</span>
        </div>
        <svg className="preparation-hologram" viewBox="0 0 600 430" fill="none">
          <defs>
            <linearGradient
              id={coreGradient}
              gradientUnits="userSpaceOnUse"
              x1="240"
              y1="105"
              x2="350"
              y2="290"
            >
              <stop stopColor="var(--game-cyan)" />
              <stop offset="0.55" stopColor="var(--game-violet)" />
              <stop offset="1" stopColor="var(--game-pink)" />
            </linearGradient>
            <linearGradient
              id={ringGradient}
              gradientUnits="userSpaceOnUse"
              x1="90"
              y1="220"
              x2="510"
              y2="310"
            >
              <stop stopColor="var(--game-cyan)" stopOpacity="0.05" />
              <stop offset="0.4" stopColor="var(--game-cyan)" />
              <stop offset="1" stopColor="var(--game-violet)" stopOpacity="0.2" />
            </linearGradient>
          </defs>
          <g className="preparation-platform">
            <ellipse cx="300" cy="319" rx="194" ry="63" fill="var(--game-violet)" opacity="0.04" />
            <ellipse
              cx="300"
              cy="310"
              rx="193"
              ry="61"
              stroke={`url(#${ringGradient})`}
              strokeWidth="2"
            />
            <ellipse
              cx="300"
              cy="310"
              rx="164"
              ry="48"
              stroke="var(--game-violet)"
              strokeOpacity="0.3"
            />
            <ellipse
              className="preparation-orbit-dash"
              cx="300"
              cy="310"
              rx="211"
              ry="76"
              stroke="var(--game-cyan)"
              strokeOpacity="0.5"
              strokeDasharray="16 20 3 20"
            />
            <path
              d="M174 310h35m182 0h35M300 257v18m0 70v18"
              stroke="var(--game-cyan)"
              strokeOpacity="0.6"
            />
            <path
              d="m300 349-51-29 51-29 51 29-51 29Z"
              fill="var(--game-cyan)"
              fillOpacity="0.08"
              stroke="var(--game-cyan)"
              strokeOpacity="0.35"
            />
          </g>
          <g className="preparation-core">
            <path
              d="M300 108 375 151v87l-75 44-75-44v-87l75-43Z"
              fill="var(--game-panel)"
              stroke={`url(#${coreGradient})`}
              strokeWidth="2"
            />
            <path
              d="m300 108 75 43-75 45-75-45 75-43Z"
              fill={`url(#${coreGradient})`}
              fillOpacity="0.24"
            />
            <path d="m225 151 75 45v86l-75-44v-87Z" fill="var(--game-cyan)" fillOpacity="0.07" />
            <path d="m375 151-75 45v86l75-44v-87Z" fill="var(--game-violet)" fillOpacity="0.2" />
            <path
              d="m225 151 75 45 75-45M300 196v86"
              stroke={`url(#${coreGradient})`}
              strokeWidth="1.5"
            />
            <path
              d="m300 129 39 23-39 23-39-23 39-23Z"
              fill={`url(#${coreGradient})`}
              fillOpacity="0.8"
            />
            <path
              d="m245 181 31 18m-31-6 31 18m46-10 31-18m-31 30 31-18"
              stroke="var(--game-cyan)"
              strokeOpacity="0.75"
              strokeWidth="2"
            />
            <path
              d="M300 91v-9m-94 61-9-5m197 5 9-5M300 298v-9"
              stroke="var(--game-cyan)"
              strokeWidth="2"
            />
          </g>
          <path
            className="preparation-signal preparation-signal--one"
            d="M102 180h50l38 38h35"
            stroke="var(--game-cyan)"
            strokeOpacity="0.7"
            strokeDasharray="5 7"
          />
          <path
            className="preparation-signal preparation-signal--two"
            d="M375 224h35l36 36h53"
            stroke="var(--game-violet)"
            strokeOpacity="0.7"
            strokeDasharray="5 7"
          />
          <circle cx="191" cy="310" r="4" fill="var(--game-cyan)" />
          <circle cx="409" cy="310" r="4" fill="var(--game-violet)" />
        </svg>
        <div className="preparation-core-label">
          <span>规则</span>
          <strong>本地编排核心</strong>
          <small>词库 · 规则 · 模板</small>
        </div>
        <div className="preparation-float-card preparation-source">
          <span className="preparation-card-kicker">
            <FileText size={14} /> 教学材料
          </span>
          <strong>confident</strong>
          <span>adj. 自信的</span>
          <div className="preparation-paper">
            <i />
            <i />
            <i />
          </div>
        </div>
        <div className="preparation-float-card preparation-output">
          <span className="preparation-card-kicker">
            <SpeakerHigh size={14} /> 声音 × 节拍
          </span>
          <div className="preparation-wave">
            {WAVE_HEIGHTS.map((height, index) => (
              <i key={index} style={{ height }} />
            ))}
          </div>
          <span>示范 / 跟读 / 转场</span>
        </div>
        <div className="preparation-result">
          <span className="preparation-result-icon">
            <Waveform size={23} />
          </span>
          <div>
            <strong>把知识，变成全班的节奏</strong>
            <span>可编辑课件 · 单文件离线课堂</span>
          </div>
          <span className="preparation-result-tag">HTML</span>
        </div>
      </div>
    </div>
  );
}
