/** 本地声音、内置模板与数据维护页。默认偏好只影响新课，恢复需先完整备份。 @author ahui */
import { MusicImportButton } from '../shared/ui/MusicImportButton';
import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as Tabs from '@radix-ui/react-tabs';
import { ArrowClockwise, Database, DownloadSimple, SpeakerHigh } from '@phosphor-icons/react';
import * as native from '../platform/native';
import type { AssetMap, AudioAsset } from '../platform/types';
import type { TeacherPreferences } from '../platform/repository';
import {
  desktopAvailable,
  getGamePreferences,
  listAssets,
  withGamePreferences,
} from '../platform/repository';
import { getGames } from '../platform/games';
import { getGameViews } from './game-views';
import templates from '../../resources/slogan-templates.json';
import { previewAudio, stopPreview } from '../platform/audio-preview';
import {
  Badge,
  Button,
  Check,
  Field,
  InputField,
  Modal,
  Notice,
  errorMessage,
  useFeedback,
} from '../shared/ui';
import { useDiscardGuard } from '../shared/ui/useDiscardGuard';

/** 系统能力不能在浏览器伪造，所有失败保留页面输入并给出可重试动作。 */
export function SettingsPage({
  preferences,
  onPreferences,
  assets,
  onAssets,
  onRegisterLeaveGuard,
}: {
  preferences: TeacherPreferences;
  onPreferences: (preferences: TeacherPreferences) => Promise<void>;
  assets: AssetMap;
  onAssets: (assets: AssetMap) => void;
  /** 宿主导航与原生关窗共用此检查，设置分区切换保留表单，不调用离开检查。 */
  onRegisterLeaveGuard?: (guard: (() => Promise<boolean>) | null) => void;
}) {
  const [tab, setTab] = useState('voices');
  const preferenceGames = getGames().filter((game) => getGameViews(game.id)?.PreferencesEditor);
  const [selectedGame, setSelectedGame] = useState(preferenceGames[0]?.id ?? '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [drafts, setDrafts] = useState<Record<string, boolean>>({});
  // 同一事件循环里的第二次点击也必须被拦截，不能只依赖下一帧的按钮禁用。
  const operation = useRef(false);
  const canLeave = useDiscardGuard({
    dirty: Object.values(drafts).some(Boolean),
    busy: !!busy,
    subject: '新课制作默认',
  });
  useEffect(() => {
    onRegisterLeaveGuard?.(() => (operation.current ? Promise.resolve(false) : canLeave()));
    return () => onRegisterLeaveGuard?.(null);
  }, [canLeave, onRegisterLeaveGuard]);
  const [assetKind, setAssetKind] = useState('music');
  const [resource, setResource] = useState<{
    asset: AudioAsset;
    usage: Awaited<ReturnType<typeof native.resourceUsage>>;
  }>();
  const [selectedCopies, setSelectedCopies] = useState<Set<string>>(() => new Set());
  const [backupResult, setBackupResult] = useState<native.ExportResult>();
  const [language, setLanguage] = useState('all');
  const [purpose, setPurpose] = useState('all');
  const voices = useQuery({
    queryKey: ['voices'],
    queryFn: native.listVoices,
    enabled: desktopAvailable,
  });
  const location = useQuery({
    queryKey: ['dataLocation'],
    queryFn: native.getDataLocation,
    enabled: desktopAvailable,
  });
  const resources = useQuery({
    queryKey: ['assets'],
    queryFn: listAssets,
    enabled: desktopAvailable && tab === 'resources',
  });
  const copies = useQuery({
    queryKey: ['exportCopies'],
    queryFn: native.listExportCopies,
    enabled: desktopAvailable && tab === 'data',
  });
  // 桌面查询是当前已登记素材的依据；清缓存后不再显示父级旧 override 中的条目。
  const visibleAssets = (resources.data ?? Object.values(assets)).filter(
    (asset) => assetKind === 'all' || asset.kind === assetKind,
  );
  const selectedFiles = copies.data?.files.filter((file) => selectedCopies.has(file.path)) ?? [];
  const selectedBytes = selectedFiles.reduce((sum, file) => sum + file.byteLength, 0);
  useEffect(() => {
    stopPreview();
    return stopPreview;
  }, [tab]);
  const { confirm, notify } = useFeedback();
  const queryClient = useQueryClient();
  const run = async (
    label: string,
    action: () => Promise<void>,
    options: { propagateError?: boolean } = {},
  ) => {
    if (operation.current) {
      if (options.propagateError) throw new Error('设置操作尚未完成，请稍后重试。');
      return;
    }
    operation.current = true;
    setBusy(label);
    setError('');
    try {
      await action();
    } catch (cause) {
      setError(errorMessage(cause));
      // 默认表单必须区分保存成功与失败，不能因公共错误反馈吞异常而清除未保存状态。
      if (options.propagateError) throw cause;
    } finally {
      operation.current = false;
      setBusy('');
    }
  };

  return (
    <div className="page stack">
      <div className="page-heading">
        <div>
          <h1>资源与设置</h1>
          <p>检查实际可用的声音，维护素材与完整备份。</p>
        </div>
      </div>
      <Tabs.Root value={tab} onValueChange={setTab}>
        <Tabs.List className="tabs-list" aria-label="设置分区">
          <Tabs.Trigger value="voices" className="tab">
            语音与制作默认
          </Tabs.Trigger>
          <Tabs.Trigger value="resources" className="tab">
            音乐与口号
          </Tabs.Trigger>
          <Tabs.Trigger value="data" className="tab">
            数据与备份
          </Tabs.Trigger>
        </Tabs.List>
        <Tabs.Content value="voices" forceMount hidden={tab !== 'voices'}>
          <div className="panel stack">
            <div className="row spread">
              <h2>内置离线配音与系统音色</h2>
              <Button
                busy={voices.isFetching}
                onClick={() => {
                  void voices.refetch();
                }}
              >
                <ArrowClockwise size={18} aria-hidden="true" />
                刷新实际音色
              </Button>
            </div>
            <Notice>
              安装包自带中英神经配音，无需安装系统语音包。也可选用本机已有的 Windows
              音色；所有声音在本机制作，不上传教学内容。
            </Notice>
            {preferenceGames.length > 1 && (
              <Field label="设置适用游戏">
                <select
                  className="input"
                  value={selectedGame}
                  onChange={(event) => setSelectedGame(event.target.value)}
                >
                  {preferenceGames.map((game) => (
                    <option key={game.id} value={game.id}>
                      {game.name}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            {preferenceGames.map((game) => {
              const PreferencesEditor = getGameViews(game.id)?.PreferencesEditor;
              if (!PreferencesEditor) return null;
              return (
                <div key={game.id} hidden={selectedGame !== game.id}>
                  <PreferencesEditor
                    active={tab === 'voices' && selectedGame === game.id}
                    value={getGamePreferences(preferences, game.id)}
                    voices={voices.data ?? []}
                    busy={!!busy}
                    onDraftChange={(dirty) =>
                      setDrafts((previous) =>
                        previous[game.id] === dirty ? previous : { ...previous, [game.id]: dirty },
                      )
                    }
                    onSave={(value) =>
                      run(
                        '保存默认',
                        async () => {
                          await onPreferences(withGamePreferences(preferences, game.id, value));
                          notify(`${game.name}新课默认已保存，仅用于之后创建的课件。`);
                        },
                        { propagateError: true },
                      )
                    }
                  />
                </div>
              );
            })}
            {voices.error && <Notice tone="error">{errorMessage(voices.error)}</Notice>}
          </div>
        </Tabs.Content>
        <Tabs.Content value="resources">
          <div className="stack">
            <div className="panel stack">
              <div className="row spread">
                <h2>本地声音素材</h2>
                <MusicImportButton
                  label="导入背景音乐"
                  disabled={!!busy || !desktopAvailable}
                  onImported={async (asset) => {
                    onAssets({ [asset.assetId]: asset });
                    await resources.refetch();
                  }}
                />
              </div>
              <Notice>
                素材按实际类型区分。移出资源库只释放该资源的收藏，不删除课件仍在使用的声音；音乐不参与自动节拍分析。
              </Notice>
              <Field label="声音类型">
                <select
                  className="input"
                  aria-label="声音类型筛选"
                  value={assetKind}
                  onChange={(event) => setAssetKind(event.target.value)}
                >
                  <option value="music">背景音乐</option>
                  <option value="recording">导入录音</option>
                  <option value="speech">合成配音</option>
                  <option value="all">全部声音</option>
                </select>
              </Field>
              {resources.error && <Notice tone="error">{errorMessage(resources.error)}</Notice>}
              {visibleAssets.length ? (
                visibleAssets.map((asset) => (
                  <div className="row spread" key={asset.assetId}>
                    <div className="grow">
                      <strong>{asset.name ?? '本地声音'}</strong>
                      <p className="caption">
                        {(asset.durationMs / 1000).toFixed(1)} 秒 ·{' '}
                        {(asset.byteLength / 1_000_000).toFixed(2)} MB
                      </p>
                    </div>
                    <Button
                      onClick={() => {
                        void previewAudio(asset).catch((cause) => setError(errorMessage(cause)));
                      }}
                    >
                      <SpeakerHigh size={18} aria-hidden="true" />
                      试听
                    </Button>
                    <Button
                      disabled={!!busy || !desktopAvailable}
                      onClick={() => {
                        void run('查看引用', async () => {
                          const usage = await native.resourceUsage(asset.assetId);
                          setResource({ asset, usage });
                        });
                      }}
                    >
                      查看引用与管理
                    </Button>
                  </div>
                ))
              ) : (
                <p className="muted">当前类型没有声音素材，可导入音乐或切换其他类型查看。</p>
              )}
            </div>
            <div className="panel stack">
              <h2>内置口号模板</h2>
              <div className="row">
                <select
                  aria-label="口号语言筛选"
                  className="input"
                  style={{ width: 160 }}
                  value={language}
                  onChange={(event) => setLanguage(event.target.value)}
                >
                  <option value="all">全部语言</option>
                  <option value="zh-CN">中文</option>
                  <option value="en-US">英文</option>
                </select>
                <select
                  aria-label="口号用途筛选"
                  className="input"
                  style={{ width: 160 }}
                  value={purpose}
                  onChange={(event) => setPurpose(event.target.value)}
                >
                  <option value="all">全部用途</option>
                  <option value="opening">开场</option>
                  <option value="transition">转场</option>
                  <option value="closing">收尾</option>
                </select>
              </div>
              {templates.templates
                .filter(
                  (template) =>
                    (language === 'all' || template.language === language) &&
                    (purpose === 'all' || template.purpose === purpose),
                )
                .map((template) => (
                  <div className="stack-sm property-group" key={template.id}>
                    <div className="row">
                      <Badge>
                        {template.purpose === 'opening'
                          ? '开场'
                          : template.purpose === 'closing'
                            ? '收尾'
                            : '转场'}
                      </Badge>
                      <small>{template.id} · 只读模板</small>
                    </div>
                    <p>{template.text}</p>
                  </div>
                ))}
              <small>内置模板只读；在课件编辑器中修改的是本课口号。</small>
            </div>
          </div>
        </Tabs.Content>
        <Tabs.Content value="data">
          <div className="panel stack">
            <div className="row">
              <Database size={24} aria-hidden="true" />
              <h2>本地资料与备份</h2>
            </div>
            <InputField
              label="数据位置"
              value={
                location.data ??
                (desktopAvailable ? '正在读取…' : '浏览器开发预览使用独立 IndexedDB')
              }
              readOnly
            />
            <Notice>
              完整备份包含数据库与全部已登记素材，包括尚未使用的资源库音乐。单课可编辑包用于换机备课，二者不能混用。恢复会替换当前资料，恢复前会自动保存当前完整备份。
            </Notice>
            <div className="row">
              <Button
                variant="primary"
                busy={busy === '导出备份'}
                disabled={!!busy || !desktopAvailable}
                onClick={() => {
                  void run('导出备份', async () => {
                    const result = await native.exportBackup();
                    setBackupResult(result);
                    await copies.refetch();
                    notify(
                      result.completed
                        ? '完整备份已导出，下方可打开成品位置。'
                        : '本机备份副本已完成，尚未另存到所选位置。',
                    );
                  });
                }}
              >
                <DownloadSimple size={18} aria-hidden="true" />
                导出完整备份
              </Button>
              <Button
                busy={busy === '恢复备份'}
                disabled={!!busy || !desktopAvailable}
                onClick={() => {
                  void run('恢复备份', async () => {
                    const file = await native.selectFile('backup');
                    if (!file) return;
                    if (
                      !(await confirm({
                        title: '恢复完整备份',
                        message: `使用「${file.name}」替换当前全部本地资料。系统将停止写入任务、备份当前资料并验证所选备份；失败保留原数据，成功后重新载入并结束旧编辑会话。`,
                        danger: true,
                        confirmLabel: '备份当前并恢复',
                      }))
                    )
                      return;
                    await native.restoreBackup(file.token);
                    // 新库已使用新的代次；旧编辑、撤销及任务回调不能继续向新库写入。
                    // 清查询并重新载入同时重建原生IPC适配，不在原页面绕过代次校验。
                    stopPreview();
                    queryClient.clear();
                    window.location.reload();
                  });
                }}
              >
                选择备份恢复
              </Button>
            </div>
            {backupResult && (
              <div className="property-group stack-sm" role="status">
                <h3>{backupResult.completed ? '完整备份已导出' : '完整备份已保存在本机'}</h3>
                <p style={{ overflowWrap: 'anywhere' }}>
                  {backupResult.completed ? backupResult.path : backupResult.localCopy}
                </p>
                {!backupResult.completed && backupResult.path && (
                  <small style={{ overflowWrap: 'anywhere' }}>
                    未完成的目标：{backupResult.path}
                  </small>
                )}
                <small>{(backupResult.byteLength / 1_000_000).toFixed(2)} MB</small>
                <Button
                  disabled={!!busy}
                  onClick={() => {
                    void run('打开备份位置', () =>
                      // 目标复制失败仍可能返回所选路径；只能打开实际完成的本机副本。
                      native.openExport(
                        backupResult.completed ? backupResult.path : backupResult.localCopy,
                        true,
                      ),
                    );
                  }}
                >
                  打开文件夹
                </Button>
              </div>
            )}
            {location.error && <Notice tone="error">{errorMessage(location.error)}</Notice>}
            <div className="property-group" />
            <div className="row spread">
              <h3>本机导出副本</h3>
              <Button
                disabled={!!busy || !desktopAvailable}
                busy={copies.isFetching}
                onClick={() => {
                  void copies.refetch();
                }}
              >
                刷新副本列表
              </Button>
            </div>
            <p className="muted">
              只管理软件保留的本机成品副本，不影响课件素材和已经复制到 U 盘的文件。
            </p>
            {copies.error && <Notice tone="error">{errorMessage(copies.error)}</Notice>}
            {copies.isPending && desktopAvailable ? (
              <p className="muted">正在读取本机副本…</p>
            ) : copies.data?.count ? (
              <div className="stack-sm">
                <p>
                  共 {copies.data.count} 份 · {(copies.data.byteLength / 1_000_000).toFixed(2)} MB
                </p>
                <Check
                  label="选择当前全部副本"
                  disabled={!!busy}
                  checked={selectedFiles.length === copies.data.files.length}
                  onChange={(event) =>
                    setSelectedCopies(
                      new Set(
                        event.target.checked ? copies.data!.files.map((file) => file.path) : [],
                      ),
                    )
                  }
                />
                {copies.data.files.map((file) => (
                  <div className="row spread" key={file.path}>
                    <div className="grow" style={{ overflowWrap: 'anywhere' }}>
                      <Check
                        label={file.name}
                        disabled={!!busy}
                        checked={selectedCopies.has(file.path)}
                        onChange={(event) =>
                          setSelectedCopies((previous) => {
                            const next = new Set(previous);
                            if (event.target.checked) next.add(file.path);
                            else next.delete(file.path);
                            return next;
                          })
                        }
                      />
                      <small>{(file.byteLength / 1_000_000).toFixed(2)} MB</small>
                    </div>
                    <Button
                      disabled={!!busy}
                      onClick={() => {
                        void run('打开副本位置', () => native.openExport(file.path, true));
                      }}
                    >
                      打开位置
                    </Button>
                  </div>
                ))}
                <p aria-live="polite">
                  已选 {selectedFiles.length} 份 · {(selectedBytes / 1_000_000).toFixed(2)} MB
                </p>
                <Button
                  disabled={!!busy || selectedFiles.length === 0}
                  busy={busy === '清理导出副本'}
                  onClick={() => {
                    void run('清理导出副本', async () => {
                      // 固定教师本次选择；刷新或异步状态变化不能扩大清理范围。
                      const paths = selectedFiles.map((file) => file.path);
                      if (
                        !(await confirm({
                          title: '清理所选本机导出副本',
                          message: `删除已选的 ${paths.length} 份本机副本，共 ${(selectedBytes / 1_000_000).toFixed(2)} MB。课件素材和 U 盘等外部文件不受影响。`,
                          confirmLabel: '清理所选副本',
                          danger: true,
                        }))
                      )
                        return;
                      const result = await native.clearExportCopies(paths);
                      setSelectedCopies(new Set());
                      setBackupResult(undefined);
                      await copies.refetch();
                      notify(
                        `已清理 ${result.count} 份本机副本，释放 ${(result.byteLength / 1_000_000).toFixed(2)} MB。`,
                      );
                    });
                  }}
                >
                  清理所选副本
                </Button>
              </div>
            ) : (
              <p className="muted">当前没有本机导出副本。</p>
            )}
            <div className="property-group" />
            <h3>无引用素材清理</h3>
            <p className="muted">
              只清理不被课件修订、运行、任务或固定快照引用的声音。已导出课堂文件不受影响。
            </p>
            <Button
              busy={busy === '清理缓存'}
              disabled={!!busy || !desktopAvailable}
              onClick={() => {
                void run('清理缓存', async () => {
                  if (
                    !(await confirm({
                      title: '清理无引用素材',
                      message: '检查后删除无引用素材，已引用声音和导出文件会保留。',
                    }))
                  )
                    return;
                  const count = await native.cleanCache();
                  await queryClient.invalidateQueries({ queryKey: ['assets'] });
                  await resources.refetch();
                  notify(`清理完成，共移除 ${count} 项。`);
                });
              }}
            >
              检查并清理
            </Button>
          </div>
        </Tabs.Content>
      </Tabs.Root>
      <Modal
        open={!!resource}
        onOpenChange={(open) => {
          if (!open && !busy) setResource(undefined);
        }}
        title="声音素材引用与管理"
        description="先查看实际使用范围，再决定是否移出资源库。课件仍有引用时，其声音继续保留。"
        footer={
          <>
            <Button disabled={!!busy} onClick={() => setResource(undefined)}>
              关闭
            </Button>
            {resource?.usage.inLibrary && (
              <Button
                variant="danger"
                busy={busy === '移出资源库'}
                disabled={!!busy}
                onClick={() => {
                  void run('移出资源库', async () => {
                    await native.deleteResource(resource.asset.assetId);
                    setResource({
                      ...resource,
                      usage: await native.resourceUsage(resource.asset.assetId),
                    });
                    notify('已移出资源库；课件引用保留，无引用声音可在数据分区清理。');
                  });
                }}
              >
                移出资源库
              </Button>
            )}
          </>
        }
      >
        {resource && (
          <div className="stack-sm">
            <strong style={{ overflowWrap: 'anywhere' }}>
              {resource.asset.name ?? '本地声音'}
            </strong>
            <Badge>{resource.usage.inLibrary ? '资源库已收藏' : '未在资源库收藏'}</Badge>
            {resource.usage.lessons.length ? (
              <>
                <p>以下 {resource.usage.lessons.length} 份课件保留修订仍在使用：</p>
                <ul>
                  {resource.usage.lessons.map((lesson) => (
                    <li key={lesson.id}>{lesson.name}</li>
                  ))}
                </ul>
              </>
            ) : (
              <p>当前没有课件引用；正在运行的会话或制作任务也可能暂时保留该素材。</p>
            )}
            {!resource.usage.inLibrary && <p>此素材没有独立的资源库收藏，无需重复移除。</p>}
          </div>
        )}
      </Modal>
      {error && (
        <Notice tone="error" role="alert">
          {error}
        </Notice>
      )}
    </div>
  );
}
