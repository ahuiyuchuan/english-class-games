/** 产品身份、手动项目入口与离线许可／源码；页面打开不发起联网请求。 @author ahui */
import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  ArrowSquareOut,
  ChatCircleText,
  DownloadSimple,
  FolderOpen,
  GithubLogo,
} from '@phosphor-icons/react';
import { desktopAvailable } from '../platform/repository';
import { Badge, Button, Notice, errorMessage } from '../shared/ui';
import { SoftwareLicense } from '../shared/SoftwareLicense';
import { sourceUrl, sourceInfo } from '../portable/source';
import { version } from '../../package.json';
import { checkForUpdates, UPDATE_SOURCES } from '../platform/updates';

/** 目的标识与原生白名单一致；浏览器预览只打开同样的固定地址。 */
const PROJECT_LINKS = [
  { id: 'repository', label: 'GitHub 仓库', suffix: '', icon: GithubLogo },
  { id: 'issues', label: '问题反馈', suffix: '/issues', icon: ChatCircleText },
  { id: 'releases', label: '发行版本', suffix: '/releases', icon: DownloadSimple },
] as const;

/** 完整源码与产品版本绑定；不以仓库主页或GitHub自动源码快照代替。 */
const SOURCE_LINK = {
  id: 'source',
  suffix: `/releases/download/v${version}/English-Class-Games-v${version}-Source.zip`,
} as const;

/** 桌面打开固定源码收据目录；完整源码单独下载，课堂源码仍可离线取得。 */
export function AboutPage() {
  const opening = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [linkBusy, setLinkBusy] = useState('');
  const [linkError, setLinkError] = useState('');
  const linkOpening = useRef(false);
  const checking = useRef<AbortController | null>(null);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [updateMessage, setUpdateMessage] = useState('');
  const [updateError, setUpdateError] = useState('');
  // 离页取消请求；迟到的结果及finally不能更新已卸载页面。
  useEffect(() => () => checking.current?.abort(), []);

  /** 同步锁覆盖快速连点；只读取公开正式版，不下载或执行远端内容。 */
  const checkUpdate = async () => {
    if (checking.current) return;
    const controller = new AbortController();
    checking.current = controller;
    setUpdateBusy(true);
    setUpdateMessage('');
    setUpdateError('');
    try {
      const result = await checkForUpdates(version, controller.signal);
      if (controller.signal.aborted) return;
      setUpdateMessage(
        result.latest === null
          ? 'GitHub 暂无可读取的公开正式发行信息，请到发行版本页面查看。'
          : result.available
            ? `发现新版本 V${result.latest}，当前为 V${version}。请到“发行版本”下载安装。`
            : `GitHub 正式版为 V${result.latest}，当前为 V${version}，未发现更高版本。`,
      );
    } catch (cause) {
      if (!controller.signal.aborted) setUpdateError(errorMessage(cause));
    } finally {
      if (checking.current === controller) {
        checking.current = null;
        if (!controller.signal.aborted) setUpdateBusy(false);
      }
    }
  };

  /** 桌面只接收目的枚举；浏览器新窗口清除opener，失败提供可复制地址。 */
  const openLink = async (link: (typeof PROJECT_LINKS)[number] | typeof SOURCE_LINK) => {
    if (linkOpening.current) return;
    linkOpening.current = true;
    setLinkBusy(link.id);
    setLinkError('');
    if (link.id === 'source') setError('');
    try {
      if (desktopAvailable) await invoke('open_project_link', { destination: link.id });
      else {
        const opened = window.open(`${UPDATE_SOURCES.github.repository}${link.suffix}`, '_blank');
        if (!opened) throw new Error('浏览器阻止了新窗口，请允许弹出窗口后重试。');
        opened.opener = null;
      }
    } catch (cause) {
      if (link.id === 'source') setError(errorMessage(cause));
      else setLinkError(errorMessage(cause));
    } finally {
      linkOpening.current = false;
      setLinkBusy('');
    }
  };
  const openSource = async () => {
    if (opening.current) return;
    opening.current = true;
    setBusy(true);
    setError('');
    try {
      await invoke('open_source_directory');
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      opening.current = false;
      setBusy(false);
    }
  };
  return (
    <div className="page stack about-page">
      <div className="page-heading">
        <div>
          <h1>关于</h1>
          <p>为真实课堂准备，让英语教学更有节奏。</p>
        </div>
      </div>
      <section className="panel stack">
        <div className="row about-identity">
          <img src="/app-icon.svg" width="80" height="80" alt="" />
          <div className="stack-sm">
            <h2>English Class Games</h2>
            <div className="row">
              <Badge>V{version}</Badge>
              <span className="muted">作者 ahui</span>
            </div>
          </div>
        </div>
        <p>智能备课 · 轻松开口。整理词表、编排活动、制作配音，把课堂打包成可离线使用的HTML。</p>
        <div className="row" role="group" aria-label="GitHub 项目入口">
          <Button busy={updateBusy} disabled={updateBusy} onClick={() => void checkUpdate()}>
            <DownloadSimple size={20} aria-hidden="true" />
            {updateBusy ? '正在检查更新…' : '检查更新'}
          </Button>
          {PROJECT_LINKS.map((link) => {
            const Icon = link.icon;
            return (
              <Button
                key={link.id}
                busy={linkBusy === link.id}
                disabled={!!linkBusy}
                onClick={() => void openLink(link)}
              >
                <Icon size={20} aria-hidden="true" />
                {link.label}
                <ArrowSquareOut size={16} aria-hidden="true" />
              </Button>
            );
          })}
        </div>
        {(updateBusy || updateMessage) && (
          <Notice role="status">{updateBusy ? '正在连接 GitHub 版本服务…' : updateMessage}</Notice>
        )}
        {updateError && (
          <Notice tone="error" role="alert">
            {updateError}
          </Notice>
        )}
        {linkError && (
          <Notice tone="error" role="alert">
            {linkError}
          </Notice>
        )}
        <p className="muted">
          检查更新仅在点击后联网读取 GitHub 最新正式版，不上传教学资料，不自动下载安装。
        </p>
        <p className="muted">
          项目入口在默认浏览器打开，需要联网。许可正文与HTML播放器源码可离线获取。
        </p>
        <p className="about-address">{UPDATE_SOURCES.github.repository}</p>
      </section>
      <section className="panel stack-sm">
        <h2>软件许可与对应源码</h2>
        <p>自有代码：GNU GPL v3（GPL-3.0-only），Copyright (c) 2026 ahui。</p>
        <p>
          允许商业使用、收费、修改和合规再分发。分发软件时须保留许可并提供对应源码；教学内容及第三方素材保留各自权利。此前合法授予的MIT权利不追溯撤销。
        </p>
        <div className="row">
          <Button
            busy={linkBusy === 'source'}
            disabled={!!linkBusy}
            onClick={() => void openLink(SOURCE_LINK)}
          >
            <DownloadSimple size={20} aria-hidden="true" />
            下载本版本完整源码
            <ArrowSquareOut size={16} aria-hidden="true" />
          </Button>
          {desktopAvailable && (
            <Button busy={busy} onClick={() => void openSource()}>
              <FolderOpen size={20} aria-hidden="true" />
              查看源码版本与校验说明
            </Button>
          )}
        </div>
        {error && (
          <Notice tone="error" role="alert">
            {error}
          </Notice>
        )}
        <p className="muted">
          完整桌面源码在同版本发行页单独提供，下载需联网、无需账号。安装器内保留精确版本、地址和SHA256；通过U盘等物理介质转交安装包时，请同时携带本版本Source.zip。导出HTML仍内嵌播放器源码，不影响断网备课和上课。
        </p>
        <SoftwareLicense source={{ url: sourceUrl, sha256: sourceInfo.sha256 }} />
      </section>
      <section className="panel stack-sm">
        <h2>本地备课，离线课堂</h2>
        <p>智能辅助使用本地词库、规则、模板及离线配音，教学内容由教师确认。不需要账号或API密钥。</p>
        <p className="muted">
          反馈问题时请描述操作步骤；分享截图或课件前移除不需要公开的教学及个人信息。
        </p>
      </section>
    </div>
  );
}
