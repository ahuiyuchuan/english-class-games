/**
 * 节拍课堂与编辑器静态预览共用的舞台装饰；不发声、不读取麦克风，
 * 不创建播放时钟。拍位必须由真实课堂阶段传入。
 * @author ahui
 */
import { useEffect, useState, type CSSProperties } from 'react';
import { MusicNote, MusicNotes } from '@phosphor-icons/react';
import { GameParticleField, useGameMotion } from '../../shared/effects/GameParticleField';
import './classroom-visuals.css';

/**
 * 自然完成徽章的一次性收束，不表达学生成绩。24 枚碎片从徽章两侧向外散开，
 * 由 CSS 生命周期清理；中断后不补播，卸载无需遗留计时器或监听。
 * @param enabled 会话特效开关，系统减少动态与页面隐藏拥有优先权。
 */
export function CompletionBurst({ enabled }: { enabled: boolean }) {
  const motion = useGameMotion(enabled);
  const [visible, setVisible] = useState(motion);
  useEffect(() => {
    if (!motion) setVisible(false);
  }, [motion]);
  if (!visible || !motion) return null;
  return (
    <span className="ecg-completion-burst" aria-hidden="true">
      {Array.from({ length: 24 }, (_, index) => (
        <i
          key={index}
          style={
            {
              '--finish-x': `${(index % 2 ? 1 : -1) * (80 + (index % 6) * 15)}px`,
              '--finish-y': `${-95 + (index % 8) * 24}px`,
              '--finish-turn': `${index * 41}deg`,
              '--finish-delay': `${(index % 6) * 24}ms`,
            } as CSSProperties
          }
          onAnimationEnd={index === 23 ? () => setVisible(false) : undefined}
        />
      ))}
    </span>
  );
}

/**
 * 将会话开关与页面可见性、系统减少动态效果设置合并。
 * 复用通用游戏环境订阅，不创建课堂播放时钟。
 * @param requested 教师是否允许本次运行的动态装饰。
 * @returns 页面可见、系统允许动画且教师开启时为 true。
 */
export function useClassroomMotion(requested: boolean): boolean {
  return useGameMotion(requested);
}

/** 氛围层参数；调用方应让父容器建立定位上下文，并将教学内容置于其上。 */
export interface ClassroomAtmosphereProps {
  /** 开场氛围或真实播放时开启；暂停、等待、后台和静态预览传 false。 */
  active: boolean;
  /** 来自真实阶段与拍序的事件标识；省略时不产生击拍爆发。 */
  beatKey?: string | number;
  /** 装饰强度 0～1，缺省 1；不影响节拍、音量或教学内容。 */
  intensity?: number;
  /** 真实阶段名，只用于跟读/示范的色彩区分，不推断课堂表现。 */
  phase?: string;
}

/**
 * 游戏能量舞台：透视网格、环形反应堆、光束、星尘与真实击拍爆发。
 * CSS 负责有层次的静态骨架，Canvas 只负责有界运动，完全离线可携带。
 * 整层禁止点击并隐藏辅助技术语义；编辑器预览传 active=false 保留完整造型。
 */
export function ClassroomAtmosphere({
  active,
  beatKey,
  intensity = 1,
  phase,
}: ClassroomAtmosphereProps) {
  const animated = useClassroomMotion(active);
  return (
    <div className="ecg-atmosphere" data-active={animated} data-phase={phase} aria-hidden="true">
      <div className="ecg-atmosphere-nebula" />
      <div className="ecg-atmosphere-halo ecg-atmosphere-halo--cyan" />
      <div className="ecg-atmosphere-halo ecg-atmosphere-halo--violet" />
      <div className="ecg-atmosphere-beam ecg-atmosphere-beam--left" />
      <div className="ecg-atmosphere-beam ecg-atmosphere-beam--right" />
      <div className="ecg-atmosphere-horizon" />
      <div className="ecg-atmosphere-grid" />
      <div className="ecg-atmosphere-reactor">
        <span className="ecg-reactor-ring ecg-reactor-ring--outer" />
        <span className="ecg-reactor-ring ecg-reactor-ring--mid" />
        <span className="ecg-reactor-ring ecg-reactor-ring--inner" />
        <span className="ecg-reactor-axis" />
        {animated && beatKey !== undefined && <span key={beatKey} className="ecg-reactor-pulse" />}
      </div>
      <GameParticleField active={animated} pulseKey={beatKey} intensity={intensity} />
      {/* 少量大型音符/切片让远处投影仍看得见，全部由同一环境开关冻结。 */}
      {Array.from({ length: 10 }, (_, index) => (
        <span
          key={index}
          className={`ecg-atmosphere-particle ${index % 3 === 0 ? 'ecg-atmosphere-particle--note' : ''}`}
          style={
            {
              '--particle-x': `${index % 2 === 0 ? 5 + ((index * 7) % 17) : 78 + ((index * 3) % 15)}%`,
              '--particle-y': `${16 + ((index * 23) % 63)}%`,
              '--particle-duration': `${5 + (index % 5)}s`,
              '--particle-delay': `${-(index % 7)}s`,
              '--particle-drift': `${index % 2 === 0 ? 32 : -32}px`,
            } as CSSProperties
          }
        >
          {index % 3 === 0 &&
            (index % 2 === 0 ? <MusicNotes weight="duotone" /> : <MusicNote weight="duotone" />)}
        </span>
      ))}
    </div>
  );
}

/** 真实拍位与朗读提示参数；拍序取自编排，同轮示范和跟读连续计数。 */
export interface BeatTrailProps {
  /** 居中拍位，或高低错落的节奏方块；齐读时两者均保留词语。 */
  mode: 'centered' | 'blocks';
  /** 当前阶段英文；只作重复视觉，完整教学原文仍由 TeachingContent 显示。 */
  english?: string;
  /** 准备阶段的真实拍数（当前编排为 2 或 4）；不当作齐读次数或改变教学计时。 */
  preparationBeats?: number;
  /** 当前真实拍位，范围 0～3。 */
  activeBeat: number;
  /** 齐读每轮真实总拍数 1～32；省略时保留原模式四拍循环，不推断朗读次数。 */
  totalBeats?: number;
  /** 每次朗读占用 1 或 2 拍，缺省 1；必须整除总拍数，合法性由正式编排校验。 */
  beatsPerRead?: number;
  /** 本轮已到达的零基拍序；超过四次朗读后切换词槽窗口，刻度保留真实拍号。 */
  beatsElapsed: number;
  /** 是否真实播放；false 停止拍击动画，但保留当前拍位的静态高亮。 */
  playing: boolean;
  /** 是否允许涟漪动画；减少动态效果的系统设置仍拥有优先权。 */
  animations: boolean;
  /** 阶段标识；切词、切阶段时重置涟漪，不能用每帧时间作为 key。 */
  timelineKey: string;
}

/**
 * 真实拍位与朗读提示台。齐读词槽表示朗读次数，槽内刻度表示所占基础拍，
 * 二者不能因“4 拍读 2 次”而混称。最多四个朗读槽，随真实拍位分页。
 * 厚实的四色 pad、轨道和落拍喷溅承担游戏反馈，
 * 重复单词由 CSS 读取 data-word，避免读屏逐拍打断完整教学原文。
 * 数字拍位保持可读取；喷溅仅在真实拍序变化时重建，不自行推进节拍。
 */
export function BeatTrail({
  mode,
  english = '',
  preparationBeats,
  activeBeat,
  totalBeats,
  beatsPerRead = 1,
  beatsElapsed,
  playing,
  animations,
  timelineKey,
}: BeatTrailProps) {
  const animated = useClassroomMotion(playing && animations);
  const reading = Math.floor(beatsElapsed / beatsPerRead);
  const page = Math.floor(reading / 4) * 4;
  const count = totalBeats
    ? Math.max(0, Math.min(4, Math.ceil(totalBeats / beatsPerRead) - page))
    : (preparationBeats ?? 4);
  const trail = (
    <div
      className={`ecg-pulse-row ecg-beat-trail ecg-beat-trail--${mode}`}
      aria-label={
        totalBeats
          ? `第 ${beatsElapsed + 1} / ${totalBeats} 拍，朗读 ${reading + 1} / ${totalBeats / beatsPerRead} 次`
          : preparationBeats
            ? `${preparationBeats} 拍准备提示`
            : '四拍循环提示'
      }
      aria-live="off"
      data-animated={animated}
      data-chorus={totalBeats !== undefined}
      data-preparation={preparationBeats !== undefined}
    >
      {Array.from({ length: count }, (_, index) => {
        // 暂停/等待时仍能看见停在哪一拍；运动仅由 animated 控制。
        const current = index === (totalBeats ? reading % 4 : activeBeat);
        const reached = totalBeats ? page + index <= reading : index <= beatsElapsed;
        return (
          <span
            key={totalBeats ? page + index : index}
            className={`ecg-beat-block ${current ? 'ecg-pulse-active' : ''}`}
            data-reached={reached}
          >
            <span className="ecg-beat-pad-depth" aria-hidden="true" />
            <span className="ecg-beat-pad-surface" aria-hidden="true" />
            {totalBeats ? (
              <span className="ecg-read-caption">
                <span className="ecg-beat-number">第 {page + index + 1} 次</span>
                {/* 每次占两拍仍只创建一次词语强调；第二拍仅移动真实刻度高亮。 */}
                <span className="ecg-read-beats" aria-hidden="true">
                  {Array.from({ length: beatsPerRead }, (_, beat) => {
                    const position = (page + index) * beatsPerRead + beat;
                    return (
                      <span
                        key={position}
                        data-current={position === beatsElapsed}
                        data-reached={position <= beatsElapsed}
                      >
                        {position + 1}
                      </span>
                    );
                  })}
                  <span className="ecg-read-beats-unit">拍</span>
                </span>
              </span>
            ) : (
              <span className="ecg-beat-number">{index + 1}</span>
            )}
            {/* 齐读的两种展示均保留待读词语；强调仍由真实朗读起点触发。 */}
            {english && (mode === 'blocks' || totalBeats !== undefined) && (
              <span
                key={`${english}-${reached}`}
                className="ecg-beat-word"
                data-word={totalBeats !== undefined || reached ? english : ''}
                aria-hidden="true"
              />
            )}
            {current && animated && (
              <span
                key={`${timelineKey}-${totalBeats ? reading : beatsElapsed}`}
                className="ecg-beat-hit"
                aria-hidden="true"
              >
                <span className="ecg-beat-impact" />
                <span className="ecg-beat-impact ecg-beat-impact--echo" />
                <span className="ecg-beat-column" />
                {Array.from({ length: 10 }, (_, spark) => (
                  <i
                    key={spark}
                    className="ecg-beat-spark"
                    style={
                      {
                        '--spark-x': `${Math.cos((spark / 10) * Math.PI * 2) * (45 + (spark % 3) * 18)}px`,
                        '--spark-y': `${Math.sin((spark / 10) * Math.PI * 2) * 40 - 35}px`,
                        '--spark-turn': `${spark * 47}deg`,
                      } as CSSProperties
                    }
                  />
                ))}
              </span>
            )}
          </span>
        );
      })}
    </div>
  );
  // 关键规则常驻可见，不能只藏在 aria-label；旧模式保持原四拍提示与空间。
  return totalBeats ? (
    <div className="ecg-chorus-guide">
      <p className="ecg-chorus-summary" aria-live="off">
        每轮 {totalBeats} 拍<span aria-hidden="true"> · </span>
        <strong>读 {totalBeats / beatsPerRead} 次</strong>
        <span aria-hidden="true"> · </span>每次 {beatsPerRead} 拍
      </p>
      {trail}
    </div>
  ) : (
    trail
  );
}
