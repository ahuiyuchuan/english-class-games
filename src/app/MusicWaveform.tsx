/** 校准波形只表达振幅，敲击建议只来自教师点击，不把峰值冒充音乐拍点。 @author ahui */
import { useEffect, useRef, useState } from 'react';
import type { AudioAsset } from '../platform/types';
import { Button } from '../shared/ui';

/** 仅用户展开时解码，限64MB；结果过期或页面卸载即丢弃并关闭解码上下文。 */
export function MusicWaveform({
  asset,
  resolveAsset,
  cursor,
  onCursor,
  firstBeatMs,
  bpm,
  onTapBpm,
}: {
  asset?: AudioAsset;
  resolveAsset: (asset: AudioAsset) => Promise<ArrayBuffer>;
  cursor: number;
  onCursor: (milliseconds: number) => void;
  firstBeatMs: number;
  bpm: number;
  onTapBpm: (bpm: number) => void;
}) {
  const [peaks, setPeaks] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [tapResult, setTapResult] = useState<{ bpm: number; count: number; stable: boolean }>();
  const taps = useRef<number[]>([]);
  const epoch = useRef(0);
  const context = useRef<AudioContext>();
  useEffect(() => {
    setPeaks([]);
    setBusy(false);
    taps.current = [];
    setTapResult(undefined);
    setError('');
    const cancel = () => {
      epoch.current++;
      void context.current?.close().catch(() => undefined);
      context.current = undefined;
      setBusy(false);
    };
    const hidden = () => {
      if (document.hidden) cancel();
    };
    document.addEventListener('visibilitychange', hidden);
    return () => {
      document.removeEventListener('visibilitychange', hidden);
      cancel();
    };
  }, [asset?.assetId]);
  const load = async () => {
    if (busy) {
      epoch.current++;
      void context.current?.close();
      context.current = undefined;
      setBusy(false);
      return;
    }
    if (!asset) return;
    const current = ++epoch.current;
    setBusy(true);
    setError('');
    try {
      if (asset.durationMs * 48 * 8 > 64_000_000)
        throw new Error('此音乐超过波形解码预算，可继续用数值和试听校准。');
      const bytes = await resolveAsset(asset);
      if (current !== epoch.current) return;
      const audio = new AudioContext();
      context.current = audio;
      const buffer = await audio.decodeAudioData(bytes);
      if (current !== epoch.current) return;
      const data = buffer.getChannelData(0),
        bins = 600;
      const values = Array.from({ length: bins }, (_, bin) => {
        const from = Math.floor((bin * data.length) / bins),
          to = Math.floor(((bin + 1) * data.length) / bins);
        let peak = 0;
        for (let i = from; i < to; i++) peak = Math.max(peak, Math.abs(data[i]));
        return peak;
      });
      setPeaks(values);
    } catch (cause) {
      if (current === epoch.current)
        setError(cause instanceof Error ? cause.message : '波形读取失败。');
    } finally {
      if (current === epoch.current) {
        setBusy(false);
        void context.current?.close();
        context.current = undefined;
      }
    }
  };
  const duration = asset?.durationMs ?? 1;
  const grid =
    Number.isFinite(bpm) && bpm > 0 ? Math.min(500, Math.ceil(duration / (60000 / bpm))) : 0;
  return (
    <section className="stack-sm" aria-label="可视音乐校准">
      <div className="row">
        <Button disabled={!asset} onClick={() => void load()}>
          {busy ? '取消波形读取' : peaks.length ? '重新读取波形' : '显示音乐波形'}
        </Button>
        <Button
          onClick={() => {
            const now = performance.now();
            taps.current =
              taps.current.length && now - taps.current.at(-1)! < 2500
                ? [...taps.current, now].slice(-9)
                : [now];
            const intervals = taps.current
              .slice(1)
              .map((time, index) => time - taps.current[index]);
            if (intervals.length < 3) {
              setTapResult(undefined);
              return;
            }
            const sorted = [...intervals].sort((a, b) => a - b),
              median = sorted[Math.floor(sorted.length / 2)];
            setTapResult({
              bpm: Math.round(60000 / median),
              count: intervals.length,
              stable: intervals.every((value) => Math.abs(value - median) / median < 0.15),
            });
          }}
        >
          跟随音乐敲击测速（至少4次）
        </Button>
      </div>
      {tapResult && (
        <p>
          {tapResult.count} 个敲击间隔：约 {tapResult.bpm} BPM。
          {tapResult.stable
            ? '请试听核实是否存在半速／倍速歧义。'
            : '间隔不稳定，请重新敲击；不能据此认定恒定节奏。'}
          <Button
            disabled={!tapResult.stable || tapResult.bpm < 50 || tapResult.bpm > 180}
            onClick={() => onTapBpm(tapResult.bpm)}
          >
            采用敲击候选
          </Button>
        </p>
      )}
      {peaks.length > 0 && (
        <svg
          viewBox="0 0 600 110"
          role="img"
          aria-label="音乐振幅波形，点击定位；也可用下方时间滑块"
          style={{ width: '100%', height: 110, cursor: 'crosshair' }}
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            onCursor(
              Math.max(
                0,
                Math.min(duration - 1, ((event.clientX - rect.left) / rect.width) * duration),
              ),
            );
          }}
        >
          <rect width="600" height="110" fill="var(--background)" />
          {peaks.map((peak, index) => (
            <line
              key={index}
              x1={index}
              x2={index}
              y1={45 - peak * 35}
              y2={45 + peak * 35}
              stroke="var(--ambient-cyan)"
            />
          ))}
          {Array.from(
            { length: grid },
            (_, i) => ((firstBeatMs + (i * 60000) / bpm) / duration) * 600,
          )
            .filter((x) => x >= 0 && x <= 600)
            .map((x, i) => (
              <line
                key={i}
                x1={x}
                x2={x}
                y1="4"
                y2="82"
                stroke="var(--text-muted)"
                opacity={i % 4 === 0 ? 0.6 : 0.2}
              />
            ))}
          <line
            x1={(cursor / duration) * 600}
            x2={(cursor / duration) * 600}
            y1="0"
            y2="85"
            stroke="var(--game-pink)"
            strokeWidth="2"
          />
          {[0, 0.25, 0.5, 0.75, 1].map((fraction) => (
            <text
              key={fraction}
              x={fraction * 590}
              y="103"
              textAnchor={fraction === 1 ? 'end' : 'start'}
              fill="var(--text-muted)"
              fontSize="11"
            >
              {((duration * fraction) / 1000).toFixed(1)}秒
            </text>
          ))}
        </svg>
      )}
      <label>
        定位 {(cursor / 1000).toFixed(3)} 秒（{Math.round(cursor)} 毫秒）
        <input
          aria-label="音乐校准定位"
          type="range"
          min="0"
          max={Math.max(0, duration - 1)}
          step="1"
          value={cursor}
          onChange={(event) => onCursor(Number(event.target.value))}
          style={{ width: '100%' }}
        />
      </label>
      <small>
        波形是振幅，不是自动检测的拍点。弱起、前奏、变速音乐须人工核验；不能稳定校准时使用普通伴奏。
      </small>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
