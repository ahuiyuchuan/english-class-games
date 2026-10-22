/** 备课页面共用的可访问组件，Radix 负责浮层焦点和键盘生命周期。 @author ahui */
import { HelpTip } from './HelpTip';
import * as Dialog from '@radix-ui/react-dialog';
import { CircleNotch, Info, X } from '@phosphor-icons/react';
import {
  Children,
  cloneElement,
  createContext,
  isValidElement,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import type {
  ButtonHTMLAttributes,
  HTMLAttributes,
  InputHTMLAttributes,
  KeyboardEvent,
  ReactNode,
} from 'react';

/** 保留调用方已有说明，新增的提示及错误也必须进入辅助技术的描述关系。 */
function describeWith(...values: (string | undefined | false)[]): string | undefined {
  const ids = values.flatMap((value) => (value ? value.split(/\s+/u).filter(Boolean) : []));
  return [...new Set(ids)].join(' ') || undefined;
}

/** 按钮的处理中与禁用分离，避免重复提交；隐藏装饰图标由调用方提供 aria-hidden。 */
export function Button({
  variant = 'secondary',
  busy = false,
  className = '',
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'text' | 'danger';
  busy?: boolean;
}) {
  return (
    <button
      type="button"
      {...props}
      disabled={props.disabled || busy}
      aria-busy={busy || undefined}
      className={`button button-${variant} ${className}`}
    >
      {busy && <CircleNotch size={18} className="spin" aria-hidden="true" />}
      {children}
    </button>
  );
}

/** 所有字段均有独立标签；错误关联到输入而非仅靠颜色标记。 */
export function Field({
  label,
  hint,
  help,
  error,
  children,
  htmlFor,
}: {
  label: string;
  hint?: string;
  help?: string;
  error?: string;
  children: ReactNode;
  /** 自定义控件可指定目标；直接放置原生输入时自动使用其现有或生成的标识。 */
  htmlFor?: string;
}) {
  const id = useId();
  let controlId = htmlFor;
  const content = Children.map(children, (child) => {
    if (
      controlId ||
      !isValidElement<HTMLAttributes<HTMLElement>>(child) ||
      !['input', 'select', 'textarea'].includes(String(child.type))
    )
      return child;
    controlId = child.props.id ?? id;
    return cloneElement(child, {
      id: controlId,
      'aria-invalid': error ? true : child.props['aria-invalid'],
      'aria-describedby': describeWith(
        child.props['aria-describedby'],
        hint && `${id}-hint`,
        error && `${id}-error`,
      ),
    });
  });
  return (
    <div className="field">
      {help ? (
        <div className="setting-label">
          <label className="field-label" htmlFor={controlId}>
            {label}
          </label>
          <HelpTip label={label}>{help}</HelpTip>
        </div>
      ) : (
        <label className="field-label" htmlFor={controlId}>
          {label}
        </label>
      )}
      {content}
      {hint && <small id={`${id}-hint`}>{hint}</small>}
      {error && (
        <span id={`${id}-error`} className="error-text">
          {error}
        </span>
      )}
    </div>
  );
}

/**
 * 单行 Enter 结束当前字段编辑，使调用方的失焦校验和撤销分组正常完成。
 * 中文输入法选词和调用方已接管的按键不触发提交；不代替整页保存或多行换行。
 * @param event 当前单行输入的键盘事件，仅处理未取消且非输入法组合中的 Enter。
 */
export function commitSingleLineOnEnter(event: KeyboardEvent<HTMLInputElement>): void {
  if (event.defaultPrevented || event.key !== 'Enter' || event.nativeEvent.isComposing) return;
  event.preventDefault();
  event.currentTarget.blur();
}

/** 常用文本/数字字段，保留原始 onChange 字符串，单行 Enter 统一结束本字段编辑。 */
export function InputField({
  label,
  hint,
  help,
  error,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  hint?: string;
  help?: string;
  error?: string;
}) {
  const generatedId = useId();
  const id = props.id ?? generatedId;
  return (
    <div className="field">
      {help ? (
        <div className="setting-label">
          <label htmlFor={id} className="field-label">
            {label}
          </label>
          <HelpTip label={label}>{help}</HelpTip>
        </div>
      ) : (
        <label htmlFor={id} className="field-label">
          {label}
        </label>
      )}
      <input
        id={id}
        {...props}
        onKeyDown={(event) => {
          props.onKeyDown?.(event);
          commitSingleLineOnEnter(event);
        }}
        className={`input ${props.className ?? ''}`}
        aria-invalid={error ? true : props['aria-invalid']}
        aria-describedby={describeWith(
          props['aria-describedby'],
          hint && `${generatedId}-hint`,
          error && `${generatedId}-error`,
        )}
      />
      {hint && <small id={`${generatedId}-hint`}>{hint}</small>}
      {error && (
        <small id={`${generatedId}-error`} className="error-text">
          {error}
        </small>
      )}
    </div>
  );
}

/** 复选项完整标签可点击，触控布局由公共样式扩大有效区域。 */
export function Check({
  label,
  help,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: string; help?: string }) {
  const control = (
    <label className="check">
      <input type="checkbox" {...props} />
      <span>{label}</span>
    </label>
  );
  return help ? (
    <div className="setting-label">
      {control}
      <HelpTip label={label}>{help}</HelpTip>
    </div>
  ) : (
    control
  );
}

export function Badge({
  children,
  tone = '',
}: {
  children: ReactNode;
  tone?: '' | 'ai' | 'success' | 'warning' | 'error';
}) {
  return <span className={`badge ${tone ? `badge-${tone}` : ''}`}>{children}</span>;
}

/** 错误默认向辅助技术即时播报；显式角色优先，普通说明不抢占读屏或键盘焦点。 */
export function Notice({
  children,
  tone = '',
  role,
}: {
  children: ReactNode;
  tone?: '' | 'ai' | 'warning' | 'error';
  role?: 'alert' | 'status';
}) {
  return (
    <div
      className={`notice ${tone ? `notice-${tone}` : ''}`}
      role={role ?? (tone === 'error' ? 'alert' : undefined)}
    >
      <Info size={20} aria-hidden="true" style={{ flexShrink: 0 }} />
      <div>{children}</div>
    </div>
  );
}

/**
 * Portal 可先于父内容插入 DOM，故用组件树层级而非插入顺序决定遮挡关系。
 * 每层预留遮罩和内容两个位置；全局安全确认使用固定保留层，不累计全局计数。
 */
const ModalLayerContext = createContext(100);
const GLOBAL_CONFIRMATION_LAYER = 300;

/**
 * Radix 管理焦点限制与 Esc；无 Dialog.Trigger 时显式记住原焦点并在关闭后恢复。
 * 危险确认通过 data-modal-safe-action 指定取消按钮，否则默认聚焦安全的关闭动作。
 */
export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  small = false,
  drawer = false,
  wide = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  small?: boolean;
  drawer?: boolean;
  /** 数据密集校对使用宽表单，内部仍按实际容器宽度切换布局。 */
  wide?: boolean;
}) {
  const layer = useContext(ModalLayerContext);
  const descriptionId = useId();
  const returnFocus = useRef<HTMLElement | null>(null);
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <ModalLayerContext.Provider value={layer + 2}>
        <Dialog.Portal>
          <Dialog.Overlay className="overlay" style={{ zIndex: layer }} />
          <Dialog.Content
            className={`dialog ${wide ? 'dialog-wide' : ''} ${small ? 'dialog-small' : ''} ${drawer ? 'drawer' : ''}`}
            aria-describedby={description ? descriptionId : undefined}
            style={{ zIndex: layer + 1 }}
            onOpenAutoFocus={(event) => {
              returnFocus.current =
                document.activeElement instanceof HTMLElement ? document.activeElement : null;
              const safeAction = (event.currentTarget as HTMLElement).querySelector<HTMLElement>(
                '[data-modal-safe-action]',
              );
              if (safeAction) {
                event.preventDefault();
                safeAction.focus();
              }
            }}
            onCloseAutoFocus={(event) => {
              if (returnFocus.current?.isConnected) {
                event.preventDefault();
                returnFocus.current.focus();
              }
            }}
          >
            <div className="dialog-header row spread">
              <Dialog.Title asChild>
                <h2>{title}</h2>
              </Dialog.Title>
              <Dialog.Close asChild>
                <Button className="icon-button" variant="text" aria-label="关闭对话框">
                  <X size={20} aria-hidden="true" />
                </Button>
              </Dialog.Close>
            </div>
            {description && (
              <Dialog.Description
                id={descriptionId}
                className="muted"
                style={{ padding: '0 24px 12px' }}
              >
                {description}
              </Dialog.Description>
            )}
            {children != null && <div className="dialog-body">{children}</div>}
            {footer && <div className="dialog-footer">{footer}</div>}
          </Dialog.Content>
        </Dialog.Portal>
      </ModalLayerContext.Provider>
    </Dialog.Root>
  );
}

interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  /** 未保存表单使用“继续编辑”，其他确认默认保持“取消”。 */
  cancelLabel?: string;
  danger?: boolean;
}
interface Feedback {
  notify: (message: string) => void;
  confirm: (options: ConfirmOptions) => Promise<boolean>;
}
const FeedbackContext = createContext<Feedback | null>(null);

/** 成功通知短暂展示，失败应由页面持续显示。确认 promise 在关闭时一律返回 false。 */
export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState('');
  const [confirmation, setConfirmation] = useState<ConfirmOptions | null>(null);
  const resolver = useRef<((confirmed: boolean) => void) | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      // 路由或资料恢复卸载 Provider 时，未决确认按取消处理，不能挂起调用方。
      mounted.current = false;
      clearTimeout(timer.current);
      resolver.current?.(false);
      resolver.current = null;
    };
  }, []);
  const notify = useCallback((text: string) => {
    if (!mounted.current) return;
    clearTimeout(timer.current);
    setMessage(text);
    timer.current = setTimeout(() => setMessage(''), 4000);
  }, []);
  const confirm = useCallback(
    (options: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        if (!mounted.current) {
          resolve(false);
          return;
        }
        resolver.current?.(false);
        resolver.current = resolve;
        setConfirmation(options);
      }),
    [],
  );
  const finish = (result: boolean) => {
    resolver.current?.(result);
    resolver.current = null;
    setConfirmation(null);
  };
  return (
    <FeedbackContext.Provider value={{ notify, confirm }}>
      {children}
      {message && (
        <div role="status" className="toast">
          {message}
        </div>
      )}
      <ModalLayerContext.Provider value={GLOBAL_CONFIRMATION_LAYER}>
        <Modal
          open={!!confirmation}
          onOpenChange={(open) => {
            if (!open) finish(false);
          }}
          title={confirmation?.title ?? '确认操作'}
          description={confirmation?.message}
          small
          footer={
            <>
              <Button data-modal-safe-action onClick={() => finish(false)}>
                {confirmation?.cancelLabel ?? '取消'}
              </Button>
              <Button
                variant={confirmation?.danger ? 'danger' : 'primary'}
                onClick={() => finish(true)}
              >
                {confirmation?.confirmLabel ?? '确认'}
              </Button>
            </>
          }
        >
          {null}
        </Modal>
      </ModalLayerContext.Provider>
    </FeedbackContext.Provider>
  );
}

/** 反馈必须在共享 Provider 内使用，避免静默丢失确认或提示。 */
export function useFeedback(): Feedback {
  const context = useContext(FeedbackContext);
  if (!context) throw new Error('反馈组件需要 FeedbackProvider。');
  return context;
}

/** 统一将本地服务、校验及未知异常转换为教师可阅读的消息。 */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && 'message' in error) return String(error.message);
  return typeof error === 'string' ? error : '操作未完成，请重试。';
}
