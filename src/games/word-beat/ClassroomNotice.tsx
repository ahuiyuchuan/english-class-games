/** 课堂单槽反馈的主题Alert外观；不拥有保存、播放或时间轴状态。 @author ahui */
import { CheckCircle, Info, WarningCircle, X } from '@phosphor-icons/react';
import type { ReactNode } from 'react';

/** 分类由真实调用事件明确提供，禁止根据文案关键词推断成功或故障。 */
export type ClassroomNoticeTone = 'info' | 'success' | 'warning' | 'error';

/** 设置弹窗和课堂共用呈现；关闭只隐藏普通提示，故障恢复由原控制入口负责。 */
export function ClassroomNotice({
  tone,
  title,
  children,
  onDismiss,
}: {
  tone: ClassroomNoticeTone;
  title: string;
  children: ReactNode;
  onDismiss?: () => void;
}) {
  const Icon = tone === 'success' ? CheckCircle : tone === 'info' ? Info : WarningCircle;
  return (
    <div
      className="ecg-classroom-message"
      data-tone={tone}
      data-error={tone === 'error'}
      role={tone === 'error' ? 'alert' : 'status'}
      aria-atomic="true"
    >
      <Icon className="ecg-notice-icon" size={24} weight="duotone" aria-hidden="true" />
      <div className="ecg-notice-copy">
        <strong>{title}</strong>
        <div>{children}</div>
      </div>
      {onDismiss && (
        <button
          type="button"
          className="ecg-notice-dismiss"
          aria-label="关闭课堂提示"
          onClick={onDismiss}
        >
          <X size={18} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
