/** 恒速音乐的本地校准；试听只读取媒体位置，不替代课堂运行时钟。 @author ahui */
import { claimPreview } from '../platform/audio-preview';

import { useEffect, useRef, useState } from 'react';
import type { AssetMap, AudioAsset } from '../platform/types';
import type { WordBeatLesson } from '../games/word-beat/model';
import { Button, Check, InputField } from '../shared/ui';
import { MusicWaveform } from './MusicWaveform';

/** 编辑时保留原始错误输入；卸载、换素材和隐藏均停止试听并释放本地对象地址。 */
export function MusicCalibration({
  lesson,
  active,
  assets,
  edit,
  resolveAsset,
}: {
  lesson: WordBeatLesson;
  active: boolean;
  assets: AssetMap;
  edit: (change: (lesson: WordBeatLesson) => WordBeatLesson) => void;
  resolveAsset: (asset: AudioAsset) => Promise<ArrayBuffer>;
}) {
  const sync = lesson.gameData.music.sync;
  const asset = assets[lesson.gameData.music.assetId ?? ''];
  const synchronized =
    lesson.gameData.soundMode === 'chorus' && !!lesson.gameData.music.syncEnabled;
  // 隐藏参数保留供切回模式恢复，但不能阻断当前模式的试听。
  const invalidInput = Object.keys(lesson.draftInputs ?? {}).some((key) =>
    synchronized ? key.startsWith('musicSync.') : key === 'musicRate',
  );
  const [position, setPosition] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [cursor, setCursor] = useState(0);
  const media = useRef<HTMLAudioElement>();
  const url = useRef<string>();
  const frame = useRef(0);
  const generation = useRef(0);
  const release = useRef<() => void>();
  const stop = () => {
    generation.current += 1;
    release.current?.();
    release.current = undefined;
    cancelAnimationFrame(frame.current);
    media.current?.pause();
    media.current?.removeAttribute('src');
    media.current?.load();
    media.current = undefined;
    if (url.current) URL.revokeObjectURL(url.current);
    url.current = undefined;
    setPosition(null);
    setBusy(false);
  };
  useEffect(() => {
    if (!active) stop();
    const hidden = () => {
      if (document.hidden) stop();
    };
    document.addEventListener('visibilitychange', hidden);
    return () => {
      document.removeEventListener('visibilitychange', hidden);
      stop();
    };
  }, [
    asset?.assetId,
    active,
    lesson.gameData.bpm.value,
    lesson.gameData.music.playbackRate,
    lesson.gameData.music.preservePitch,
  ]);
  useEffect(() => {
    if (media.current) media.current.volume = lesson.gameData.volumes.music;
  }, [lesson.gameData.volumes.music]);
  const preview = async (startMs = 0, range = false) => {
    if (media.current || busy) {
      stop();
      return;
    }
    if (!asset) return;
    if (invalidInput) {
      setError('请先修正音乐校准和速度输入，不能用旧值试听。');
      return;
    }
    release.current = claimPreview(stop);
    const epoch = ++generation.current;
    setBusy(true);
    setError('');
    try {
      const bytes = await resolveAsset(asset);
      if (epoch !== generation.current) return;
      url.current = URL.createObjectURL(new Blob([bytes], { type: asset.mimeType }));
      const audio = new Audio(url.current);
      media.current = audio;
      audio.volume = lesson.gameData.volumes.music;
      audio.preservesPitch = lesson.gameData.music.preservePitch ?? true;
      audio.playbackRate =
        synchronized && sync
          ? lesson.gameData.bpm.value / sync.bpm
          : (lesson.gameData.music.playbackRate ?? 1);
      // 后续媒体加载也保留本次校准倍率，不回退到浏览器默认的1倍。
      audio.defaultPlaybackRate = audio.playbackRate;
      audio.currentTime = startMs / 1000;
      audio.onended = stop;
      audio.onerror = () => {
        if (epoch === generation.current) {
          stop();
          setError('音乐无法解码，请检查素材或改用受支持的音频。');
        }
      };
      await audio.play();
      if (epoch !== generation.current) return;
      setBusy(false);
      const update = () => {
        if (epoch !== generation.current) return;
        if (range && sync && audio.currentTime * 1000 >= sync.loopEndMs)
          audio.currentTime = sync.loopStartMs / 1000;
        setPosition(audio.currentTime * 1000);
        frame.current = requestAnimationFrame(update);
      };
      update();
    } catch (cause) {
      if (epoch === generation.current) {
        stop();
        setError(cause instanceof Error ? cause.message : '试听失败。');
      }
    }
  };
  const beat = position !== null && sync ? (position - sync.firstBeatMs) / (60000 / sync.bpm) : -1;
  return (
    <section className="panel panel-compact stack-sm" aria-label="音乐节拍校准">
      <div hidden={lesson.gameData.soundMode === 'chorus' && !!lesson.gameData.music.syncEnabled}>
        <InputField
          label="普通伴奏速度（倍）"
          type="number"
          min={0.75}
          max={1.25}
          step={0.05}
          value={lesson.draftInputs?.['musicRate']?.raw ?? lesson.gameData.music.playbackRate ?? 1}
          error={lesson.draftInputs?.['musicRate']?.message}
          hint="只改变普通伴奏，不改变课堂拍数。0.75～1.25倍；重新准备课堂时生效。"
          onChange={(event) => {
            stop();
            const raw = event.target.value;
            edit((document) => {
              document.draftInputs ??= {};
              const value = Number(raw);
              if (!raw.trim() || !Number.isFinite(value) || value < 0.75 || value > 1.25)
                document.draftInputs.musicRate = { raw, message: '请输入0.75～1.25倍。' };
              else {
                delete document.draftInputs.musicRate;
                document.gameData.music.playbackRate = value;
              }
              return document;
            });
          }}
        />
      </div>
      <Check
        label="音乐变速保留音高"
        help="变快或变慢时尽量保持原来的音高。速度在重新准备课堂时生效，不会改变每轮拍数或朗读次数。"
        checked={lesson.gameData.music.preservePitch ?? true}
        onChange={(event) => {
          stop();
          edit((document) => {
            document.gameData.music.preservePitch = event.target.checked;
            return document;
          });
        }}
      />
      {lesson.gameData.soundMode === 'chorus' && (
        <>
          <Check
            label="按音乐节拍运行"
            help="仅自主齐读可用。需要先校准原始音乐 BPM、第一拍和循环区间；课堂按校准后的音乐拍点运行。普通伴奏不要求对拍，也不自动跟随课堂调速。"
            checked={lesson.gameData.music.syncEnabled ?? false}
            onChange={(event) => {
              stop();
              edit((document) => {
                document.gameData.music.syncEnabled = event.target.checked;
                document.gameData.music.sync ??= {
                  bpm: document.gameData.bpm.value,
                  firstBeatMs: 0,
                  loopStartMs: 0,
                  loopEndMs: 0,
                };
                return document;
              });
            }}
          />
        </>
      )}
      <p className="muted">
        普通伴奏独立播放；对拍仅适用恒速音乐。先试听确认首拍，再设置整拍循环区间。开场及准备完成后才进入音乐首拍。
      </p>
      {!synchronized && (
        <Button disabled={!asset} onClick={() => void preview()}>
          {busy ? '取消准备' : media.current ? '停止试听' : '试听当前伴奏速度'}
        </Button>
      )}
      {!synchronized && error && <p role="alert">{error}</p>}
      {lesson.gameData.soundMode === 'chorus' && lesson.gameData.music.syncEnabled && sync && (
        <>
          {(
            [
              ['bpm', '原始音乐 BPM', 50, 180],
              ['firstBeatMs', '第一拍位置（毫秒）', 0, asset?.durationMs ?? 600000],
              ['loopStartMs', '循环开始（毫秒）', 0, asset?.durationMs ?? 600000],
              ['loopEndMs', '循环结束（毫秒）', 0, asset?.durationMs ?? 600000],
            ] as const
          ).map(([key, label, min, max]) => (
            <InputField
              key={key}
              label={label}
              help={
                {
                  bpm: '原音频未变速时的每分钟拍数。目标课堂 BPM ÷ 原始 BPM 得到播放倍率；仅适用于节奏稳定、已核对拍点的音乐。',
                  firstBeatMs:
                    '第一拍在原音频中的位置，单位毫秒；1000 毫秒＝1 秒。可在波形中选择或试听时标记，再用拍点试听核对。',
                  loopStartMs:
                    '循环从原音频的这个位置开始，单位毫秒。必须与首拍网格对齐，不改写或裁剪原素材。',
                  loopEndMs:
                    '循环到原音频的这个位置结束，单位毫秒；必须大于起点且循环包含完整拍数。尾部空白不会自动成为音乐拍点。',
                }[key]
              }
              type="number"
              min={min}
              max={max}
              step="any"
              value={lesson.draftInputs?.[`musicSync.${key}`]?.raw ?? sync[key]}
              error={lesson.draftInputs?.[`musicSync.${key}`]?.message}
              onChange={(event) => {
                stop();
                const raw = event.target.value;
                edit((document) => {
                  document.draftInputs ??= {};
                  const value = Number(raw),
                    path = `musicSync.${key}`;
                  if (!raw.trim() || !Number.isFinite(value) || value < min || value > max)
                    document.draftInputs[path] = { raw, message: `请输入 ${min}～${max} 的数值。` };
                  else {
                    delete document.draftInputs[path];
                    document.gameData.music.sync![key] = value;
                    // 原始音乐速度是校准依据，不覆盖教师的目标课堂 BPM。
                  }
                  return document;
                });
              }}
            />
          ))}
          <p>
            原始 {sync.bpm} BPM → 目标课堂 {lesson.gameData.bpm.value} BPM ={' '}
            {(lesson.gameData.bpm.value / sync.bpm).toFixed(3)} 倍。
            目标速度在全课节奏设置中修改，重新准备课堂时生效；每轮拍数与朗读次数不变。循环坐标均指原音频。
          </p>
          <MusicWaveform
            asset={asset}
            resolveAsset={resolveAsset}
            cursor={position ?? cursor}
            onCursor={(value) => {
              stop();
              setCursor(value);
            }}
            firstBeatMs={sync.firstBeatMs}
            bpm={sync.bpm}
            onTapBpm={(value) => {
              stop();
              edit((document) => {
                document.gameData.music.sync!.bpm = value;
                delete document.draftInputs?.['musicSync.bpm'];
                return document;
              });
            }}
          />
          <div className="row">
            <Button
              disabled={!asset}
              onClick={() => {
                const value = position ?? cursor;
                stop();
                edit((document) => {
                  document.gameData.music.sync!.firstBeatMs = value;
                  delete document.draftInputs?.['musicSync.firstBeatMs'];
                  return document;
                });
              }}
            >
              将当前位置标为第一拍
            </Button>
            <Button
              disabled={
                !asset ||
                !Number.isFinite(sync.bpm) ||
                sync.bpm <= 0 ||
                sync.firstBeatMs >= (asset?.durationMs ?? 0)
              }
              onClick={() => {
                stop();
                edit((document) => {
                  const grid = 60000 / sync.bpm;
                  document.gameData.music.sync!.loopStartMs = sync.firstBeatMs;
                  document.gameData.music.sync!.loopEndMs =
                    sync.firstBeatMs +
                    Math.floor(((asset?.durationMs ?? 0) - sync.firstBeatMs) / grid) * grid;
                  delete document.draftInputs?.['musicSync.loopStartMs'];
                  delete document.draftInputs?.['musicSync.loopEndMs'];
                  return document;
                });
              }}
            >
              采用从首拍到末尾的完整拍循环
            </Button>
          </div>
          <small>
            当前区间 {((sync.loopEndMs - sync.loopStartMs) / 1000).toFixed(3)} 秒 ·{' '}
            {(((sync.loopEndMs - sync.loopStartMs) * sync.bpm) / 60000).toFixed(2)}{' '}
            拍，必须为正整数拍。
          </small>
          <Button disabled={!asset} onClick={() => void preview()}>
            {busy ? '取消准备' : media.current ? '停止校准试听' : '试听并看拍点'}
          </Button>
          <Button disabled={!asset || busy} onClick={() => void preview(cursor)}>
            从定位处试听
          </Button>
          <Button
            disabled={
              !asset ||
              busy ||
              sync.loopEndMs <= sync.loopStartMs ||
              sync.loopEndMs > (asset?.durationMs ?? 0)
            }
            onClick={() => void preview(sync.loopStartMs, true)}
          >
            试听循环区间
          </Button>
          <output aria-live="off">
            {position === null
              ? '试听从音频开头开始。'
              : `音频 ${(position / 1000).toFixed(2)} 秒 · ${beat < 0 ? '尚未到首拍' : `第 ${Math.floor(beat) + 1} 拍 ${beat % 1 < 0.2 ? '●' : '○'}`}`}
          </output>
          {error && <p role="alert">{error}</p>}
        </>
      )}
    </section>
  );
}
