/**
 * 制作原修订的只读教学内容；不接收编辑回调，不把旧声音候选合并到当前草稿。
 * @author ahui
 */
import type { AssetMap } from '../../platform/types';
import { Button } from '../../shared/ui';
import type { WordBeatLesson } from './model';
import { audioMatches, getVoiceSettings } from './rules';

/**
 * 展示原词序、义项、轮数和真实声音状态；试听由平台统一占用单一音频会话。
 * @param props 固定修订与素材副本；onListen只接收已经匹配的素材标识。
 * @returns 无可编辑字段的分段内容，空段落仍明确展示。
 */
export function WordBeatReadOnlyResult({
  lesson,
  assets,
  onListen,
}: {
  lesson: WordBeatLesson;
  assets: AssetMap;
  onListen: (assetId: string) => void;
}) {
  return (
    <div className="stack">
      {lesson.gameData.segments.map((segment) => (
        <section className="stack-sm" key={segment.id}>
          <h3>
            {segment.name} · {segment.entries.length} 条
          </h3>
          {!segment.entries.length && <p className="muted">空段落，不参与课堂编排。</p>}
          <ol className="readonly-entries">
            {segment.entries.map((entry) => {
              const voice = getVoiceSettings(lesson, 'en-US', entry.voiceOverrides);
              const matched = audioMatches(entry.audio, entry.english, voice.voiceId, voice.rate);
              const assetId = entry.audio?.assetId;
              const ready = matched && !!assetId && !!assets[assetId];
              const teacher = lesson.gameData.soundMode === 'teacher';
              return (
                <li className="panel panel-compact stack-sm" key={entry.id}>
                  <strong>{entry.english || '英文尚未填写'}</strong>
                  <p>{entry.meaning || '仅练英文'}</p>
                  <div className="row spread">
                    <small>
                      {entry.priority ? '重点 · ' : ''}
                      {entry.rounds.value} 轮 ·{' '}
                      {lesson.gameData.soundMode === 'chorus'
                        ? '学生自主齐读'
                        : teacher
                          ? '教师示范'
                          : ready
                            ? '声音已准备'
                            : entry.audio
                              ? '声音需修复或更新'
                              : '声音待制作'}
                    </small>
                    {lesson.gameData.soundMode === 'voiced' && ready && (
                      <Button
                        onClick={() => onListen(assetId!)}
                        aria-label={`试听 ${entry.english}`}
                      >
                        试听
                      </Button>
                    )}
                  </div>
                  {entry.source && <small>材料来源：{entry.source.name}</small>}
                </li>
              );
            })}
          </ol>
        </section>
      ))}
    </div>
  );
}
