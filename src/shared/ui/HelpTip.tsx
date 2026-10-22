/** 设置说明：鼠标、键盘及触屏共用，浮层不参与教学时钟。 @author ahui */
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Question } from '@phosphor-icons/react';
import './help-tip.css';

/**
 * 标签外的独立说明按钮；不得嵌入包裹输入控件的 label。
 * 浮层留在当前模态／全屏根节点中，避免被模态隐藏或在全屏时消失。
 * 点击固定后再次点击、点击外部或 Esc 关闭；滚动关闭，避免说明与字段错位。
 */
export function HelpTip({ label, children }: { label: string; children: string }) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const tip = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [position, setPosition] = useState({ left: 8, top: 8 });
  const cancelClose = () => clearTimeout(timer.current);
  const close = () => {
    cancelClose();
    setOpen(false);
    setPinned(false);
  };
  const leave = () => {
    cancelClose();
    // 短暂跨越按钮与说明之间的空隙时仍可阅读，鼠标离开不留下常驻层。
    if (!pinned && document.activeElement !== trigger.current)
      timer.current = setTimeout(() => setOpen(false), 160);
  };
  useLayoutEffect(() => {
    if (!open || !trigger.current || !tip.current) return;
    const anchor = trigger.current.getBoundingClientRect();
    const box = tip.current.getBoundingClientRect();
    // 模态带 transform 时 fixed 的包含块变成模态本身；同时在其裁剪边界内避让。
    const parent = tip.current.offsetParent;
    const bounds = parent instanceof HTMLElement ? parent.getBoundingClientRect() : null;
    const leftEdge = Math.max(0, bounds?.left ?? 0);
    const rightEdge = Math.min(window.innerWidth, bounds?.right ?? window.innerWidth);
    const topEdge = Math.max(0, bounds?.top ?? 0);
    const bottomEdge = Math.min(window.innerHeight, bounds?.bottom ?? window.innerHeight);
    setPosition({
      left:
        Math.max(leftEdge + 8, Math.min(anchor.left, rightEdge - box.width - 8)) -
        (bounds?.left ?? 0),
      top:
        (anchor.bottom + 8 + box.height <= bottomEdge - 8
          ? anchor.bottom + 8
          : Math.max(topEdge + 8, anchor.top - box.height - 8)) - (bounds?.top ?? 0),
    });
  }, [open, children]);
  useEffect(() => {
    if (!open) return;
    const dismiss = () => {
      clearTimeout(timer.current);
      setOpen(false);
      setPinned(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      dismiss();
    };
    const outside = (event: PointerEvent) => {
      if (
        !trigger.current?.contains(event.target as Node) &&
        !tip.current?.contains(event.target as Node)
      )
        dismiss();
    };
    // capture 比 Radix 的 Escape 处理更早：先收起说明，第二次 Esc 才关闭设置。
    window.addEventListener('keydown', key, true);
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('resize', dismiss);
    window.addEventListener('scroll', dismiss, true);
    window.addEventListener('blur', dismiss);
    return () => {
      window.removeEventListener('keydown', key, true);
      document.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('scroll', dismiss, true);
      window.removeEventListener('blur', dismiss);
      clearTimeout(timer.current);
    };
  }, [open]);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="setting-help"
        aria-label={`${label}说明`}
        aria-describedby={open ? id : undefined}
        aria-expanded={open}
        onMouseEnter={() => {
          cancelClose();
          setOpen(true);
        }}
        onMouseLeave={leave}
        onFocus={() => {
          cancelClose();
          setOpen(true);
        }}
        onBlur={() => {
          // 浏览器先完成 Tab 的焦点交接再移除 portal；同步卸载会使模态焦点陷阱
          // 在交接中观察到 body，并把焦点拉回面板开头。重获焦点和卸载仍会取消任务。
          cancelClose();
          timer.current = setTimeout(close, 0);
        }}
        onClick={() => {
          cancelClose();
          if (pinned) close();
          else {
            setOpen(true);
            setPinned(true);
          }
        }}
      >
        <Question size={19} aria-hidden="true" />
      </button>
      {open &&
        createPortal(
          <div
            ref={tip}
            id={id}
            role="tooltip"
            className="setting-help-tip"
            style={position}
            onMouseEnter={cancelClose}
            onMouseLeave={leave}
          >
            <strong>{label}</strong>
            <span>{children}</span>
          </div>,
          trigger.current?.closest('[role="dialog"]') ??
            document.fullscreenElement ??
            document.body,
        )}
    </>
  );
}
