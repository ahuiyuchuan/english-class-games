/** 本地许可和源码获取，不查询网络、不接触教学素材。 @author ahui */
import { useState } from 'react';
import license from '../../LICENSE?raw';
import { THIRD_PARTY_ATTRIBUTION } from './attribution';
import './software-license.css';

/**
 * 点击后才分配源码Blob；下载启动后释放URL，不把整个源码反复解码到课堂内存。
 * @param encoded 当前构建或HTML内嵌的源码ZIP Base64，不接受外部URL。
 * @param name 固定下载名，不用教师内容构造文件路径。
 */
export function downloadSource(encoded: string, name = 'portable-source.zip'): void {
  const raw = atob(encoded);
  const bytes = Uint8Array.from(raw, (character) => character.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  // 下载异步取得Blob，不能在click返回时立即撤销。
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** 仅在开始页折叠显示；展开后才挂载长许可，保持课堂内容优先。 */
export function SoftwareLicense({ source }: { source?: { url: string; sha256: string } }) {
  const [open, setOpen] = useState(false);
  const embedded = document.getElementById('ecg-source');
  return (
    <details className="software-license" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>许可与源码</summary>
      {open && (
        <div className="stack-sm">
          <p>
            播放器代码 GPL-3.0-only，Copyright (c) 2026
            ahui。允许商业使用、收费及合规再分发，不提供担保。
          </p>
          <p>教学内容、录音、BGM和生成音频保留各自权利；播放器代码按其软件许可分发。</p>
          {(source || embedded) && (
            <>
              {source ? (
                <a className="button ecg-button" href={source.url} download="portable-source.zip">
                  下载播放器对应源码
                </a>
              ) : (
                <button
                  type="button"
                  className="button ecg-button"
                  onClick={() => downloadSource(embedded!.textContent!.trim())}
                >
                  下载播放器对应源码
                </button>
              )}
              <p className="muted source-digest">
                源码ZIP SHA-256：{source?.sha256 ?? embedded?.dataset.sha256}
              </p>
            </>
          )}
          <details>
            <summary>GNU GPL v3 完整许可</summary>
            <pre className="about-notices">{license}</pre>
          </details>
          <details>
            <summary>第三方来源与许可</summary>
            <pre className="about-notices">{THIRD_PARTY_ATTRIBUTION}</pre>
          </details>
        </div>
      )}
    </details>
  );
}
