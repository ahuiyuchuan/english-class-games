/**
 * Shared music importer for editor and resources. Only onImported selects an asset;
 * enabling BGM remains the caller's existing explicit switch.
 * @author ahui
 */
import { useEffect, useRef, useState } from 'react';
import * as native from '../../platform/native';
import {
  beginMusicImport,
  cancelActiveMusicImport,
  type MusicOperation,
} from '../../platform/music-import';
import type { AudioAsset } from '../../platform/types';
import { Button, Modal, Notice, errorMessage } from './index';

export function MusicImportButton({
  label,
  disabled,
  onImported,
}: {
  label: string;
  disabled?: boolean;
  onImported: (asset: AudioAsset) => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState('');
  const [error, setError] = useState('');
  const [result, setResult] = useState('');
  const [inspection, setInspection] = useState<native.MusicInspection>();
  const [track, setTrack] = useState('');
  const [file, setFile] = useState<native.SelectedFile>();
  const operation = useRef<MusicOperation>();
  const mounted = useRef(true);
  const apply = useRef(onImported);
  apply.current = onImported;
  const choose = useRef<(value: number | null | undefined) => void>();

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      choose.current?.(undefined);
      if (operation.current) void cancelActiveMusicImport().catch(() => undefined);
    };
  }, []);

  /** Resolve track selection before draining, otherwise cancel would wait on the dialog itself. */
  const cancel = async () => {
    if (operation.current?.committing) return;
    choose.current?.(undefined);
    setStage('正在取消…');
    try {
      await cancelActiveMusicImport();
    } catch (cause) {
      if (mounted.current) setError(errorMessage(cause));
    }
  };

  const start = async () => {
    const active = beginMusicImport();
    if (!active) {
      setResult('正在导入或关闭窗口，请等待当前操作完成。');
      return;
    }
    operation.current = active;
    setBusy(true);
    setOpen(true);
    setError('');
    setResult('');
    setInspection(undefined);
    setFile(undefined);
    setStage('请选择本地音频或视频…');
    let published = false;
    try {
      const selected = await native.selectFile('music');
      if (!selected || active.cancelled || !mounted.current) {
        active.cancelled = true;
        return;
      }
      setFile(selected);
      setStage('正在检查文件和音轨…');
      const info = await native.inspectMusic(selected.token);
      if (active.cancelled || !mounted.current) return;
      setInspection(info);
      setTrack(info.selectedTrack === null ? '' : String(info.selectedTrack));
      setStage('等待确认');
      const selectedTrack = await new Promise<number | null | undefined>((resolve) => {
        choose.current = resolve;
        active.cancelWait = () => resolve(undefined);
      });
      choose.current = undefined;
      if (selectedTrack === undefined || active.cancelled || !mounted.current) {
        active.cancelled = true;
        return;
      }
      setStage(info.video ? '正在提取音轨并校验，原视频保持不变…' : '正在校验音频…');
      await native.prepareMusic(selected.token, active.id, selectedTrack);
      if (active.cancelled || !mounted.current) return;
      active.committing = true;
      setStage('正在保存音乐…');
      const asset = await native.commitMusic(active.id);
      published = true;
      if (mounted.current) {
        await apply.current(asset);
        setResult('音乐已导入，可试听或在课件中选择启用。');
        setOpen(false);
      }
    } catch (cause) {
      if (mounted.current && !active.cancelled) {
        setError(errorMessage(cause));
        setStage(
          published
            ? '导入失败：音乐已入库，但页面未更新，请重新打开资源页。'
            : '导入失败，未添加新的音乐',
        );
      }
    } finally {
      // Cancel again after late prepare completion, covering an IPC cancellation
      // that arrived before the native command registered its operation ID.
      await native.cancelMusic(active.id).catch(() => undefined);
      active.finish();
      operation.current = undefined;
      if (mounted.current) {
        setBusy(false);
        if (active.cancelled) {
          setResult('已取消，未添加音乐。');
          setOpen(false);
        }
        setStage((value) => (value.startsWith('导入失败') ? value : ''));
      }
    }
  };

  return (
    <div className="music-import-control">
      <Button disabled={disabled || busy} onClick={() => void start()}>
        {label}
      </Button>
      {/* Keep one parent layout item and reserve a status row: cancellation must
          not become a third child in the caller's spread toolbar. */}
      <span role="status" className="music-import-status muted" aria-live="polite">
        {result}
      </span>
      <Modal
        open={open}
        onOpenChange={(value) => {
          if (!value) {
            if (operation.current) void cancel();
            else setOpen(false);
          }
        }}
        title="导入背景音乐"
        description="支持MP3、WAV及普通MP4中的AAC-LC音轨。视频音轨可能含人声和音效；这里不分离纯音乐。所有处理均在本机完成。"
        footer={
          <>
            <Button
              disabled={operation.current?.committing}
              onClick={() => {
                if (operation.current) void cancel();
                else setOpen(false);
              }}
            >
              {operation.current ? '取消导入' : '关闭'}
            </Button>
            {stage === '等待确认' && (
              <Button
                variant="primary"
                disabled={
                  inspection?.video &&
                  !inspection.tracks.some((item) => String(item.id) === track && item.supported)
                }
                onClick={() => {
                  setStage('正在准备…');
                  choose.current?.(inspection?.video ? Number(track) : null);
                }}
              >
                {inspection?.video ? '提取并导入' : '导入音乐'}
              </Button>
            )}
          </>
        }
      >
        {file && <p>{file.name}</p>}
        {stage && (
          <p role="status" aria-live="polite">
            {stage}
          </p>
        )}
        {error && <Notice tone="error">{error}</Notice>}
        {inspection?.video && stage === '等待确认' && (
          <label className="field">
            选择音轨
            <select
              className="input"
              aria-label="选择音轨"
              value={track}
              onChange={(event) => setTrack(event.target.value)}
            >
              <option value="">请选择一条音轨</option>
              {inspection.tracks.map((item) => (
                <option key={item.id} value={item.id} disabled={!item.supported}>
                  音轨 {item.id + 1} · {item.language} · {item.codec}
                  {item.default ? ' · 默认标记' : ''}
                </option>
              ))}
            </select>
            <span className="muted">
              单音轨或唯一默认轨已预选；其余情况需手动选择，不混合音轨。
            </span>
          </label>
        )}
        <p className="muted">
          视频≤500MB，音轨≤10分钟，输出≤50MB。保持完整内容与原采样率；超限会拒绝，不会截断。
        </p>
      </Modal>
    </div>
  );
}
