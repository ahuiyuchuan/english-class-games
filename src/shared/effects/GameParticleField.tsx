/**
 * 离线游戏通用的 Canvas 2D 能量场。它只绘制装饰，不发声、不推进课堂，
 * 不推断学生行为；外部传入的 pulseKey 是唯一的教学拍击来源。
 * @author ahui
 */
import { useEffect, useRef, useState } from 'react';
import './game-effects.css';

/**
 * 合并用户开关、页面可见性与系统减少动态效果设置。
 * 环境变化立即通知使用者；卸载时解除两个订阅，不安装任何播放计时器。
 * @param requested 本次会话是否允许动态装饰。
 * @returns 当前允许运动时为 true；服务端或不可见页面为 false。
 */
export function useGameMotion(requested: boolean): boolean {
  const [allowed, setAllowed] = useState(() =>
    typeof document === 'undefined'
      ? false
      : !document.hidden &&
        !(
          typeof window.matchMedia === 'function' &&
          window.matchMedia('(prefers-reduced-motion: reduce)').matches
        ),
  );

  useEffect(() => {
    const preference =
      typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-reduced-motion: reduce)')
        : undefined;
    const update = () => setAllowed(!document.hidden && !preference?.matches);
    update();
    document.addEventListener('visibilitychange', update);
    preference?.addEventListener('change', update);
    return () => {
      document.removeEventListener('visibilitychange', update);
      preference?.removeEventListener('change', update);
    };
  }, []);

  return requested && allowed;
}

/** 通用能量场参数；父级负责定位和尺寸，教学内容应位于画布上方。 */
export interface GameParticleFieldProps {
  /** false 保留静态星场，释放 rAF/指针监听；仅尺寸变化时重绘一帧。 */
  active: boolean;
  /** 仅在真实事件发生时改变；不可传入逐帧时间。undefined 不触发爆发。 */
  pulseKey?: string | number;
  /** 粒子密度，范围 0～1；越界自动钳制，缺省 1。 */
  intensity?: number;
  /** 是否允许指针轻推附近星尘；只改变装饰，不消耗或拦截输入事件。 */
  interactive?: boolean;
  /** 用于布局的附加类名，不影响能量场的生命周期。 */
  className?: string;
}

/** 连线星尘的归一化位置使缩放无需重建所有运动状态。 */
interface Star {
  x: number;
  y: number;
  depth: number;
  phase: number;
}

/** 爆发粒子只存活不到一秒，速度单位为 CSS 像素/秒。 */
interface Spark {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  duration: number;
  color: string;
  size: number;
}

/** 单枚冲击环不推进课件，仅响应 pulseKey。 */
interface Shockwave {
  life: number;
  color: string;
}

/**
 * 有界的星尘、流星、连线与击拍爆发。桌面最多 72 枚星尘、96 枚短命
 * 火花、4 个冲击环、2 道流星；相邻候选连线检查为 O(n)，不作全量两两遍历。
 * 渲染预算最高 45 FPS、DPR 1.5、约 220 万物理像素，避免投影教室抢占声音调度。
 */
export function GameParticleField({
  active,
  pulseKey,
  intensity = 1,
  interactive = true,
  className = '',
}: GameParticleFieldProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const burstRef = useRef<(() => void) | null>(null);
  const drawnFrames = useRef(0);
  const elapsedRef = useRef(0);
  // 保存最后一帧的绘制闭包，暂停缩放可重投影相同星场而不重启动画。
  const redrawRef = useRef<(() => void) | null>(null);
  const lowQuality = useRef(false);
  const lastPulse = useRef<string | number | undefined>(undefined);
  const animated = useGameMotion(active);
  const density = Number.isFinite(intensity) ? Math.min(1, Math.max(0, intensity)) : 1;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // 暂停保留最后一张真实画面；不能通过清空/重置星场造成停顿时闪烁。
    // 初次静态挂载仍需绘制一次，编辑预览因此拥有完整且可离线显示的星场。
    if (!animated && drawnFrames.current > 0) {
      const redraw = () => redrawRef.current?.();
      const observer =
        typeof ResizeObserver === 'function' ? new ResizeObserver(redraw) : undefined;
      observer?.observe(canvas);
      window.addEventListener('resize', redraw);
      return () => {
        observer?.disconnect();
        window.removeEventListener('resize', redraw);
      };
    }
    const context = canvas.getContext('2d', { alpha: true });
    if (!context) return; // CSS 环轨、透视网格与拍位仍可独立表达真实状态。
    const palette = getComputedStyle(canvas);
    const cyan = palette.getPropertyValue('--ambient-cyan').trim() || '#55ddf5';
    const violet = palette.getPropertyValue('--ambient-violet').trim() || '#a58aff';
    const pink = palette.getPropertyValue('--ambient-pink').trim() || '#f48acb';
    const colors = [cyan, violet, pink];
    let width = 1;
    let height = 1;
    let pixelRatio = 1;
    let frame = 0;
    let lastFrame = 0;
    let elapsed = elapsedRef.current;
    let pointer = { x: -1, y: -1 };
    let bounds = canvas.getBoundingClientRect();
    const starCount = Math.round(
      ((bounds.width < 1000 ? 42 : 58) + 14 * density) * (lowQuality.current ? 0.5 : 1),
    );
    // 稳定初始分布便于编辑预览与截图复核；运动本身仍读取真实 rAF 时间。
    const stars: Star[] = Array.from({ length: starCount }, (_, index) => ({
      x: (index * 0.61803398875 + 0.037) % 1,
      y: (index * 0.41421356237 + 0.081) % 1,
      depth: 0.3 + ((index * 17) % 70) / 100,
      phase: index * 2.399963,
    }));
    let sparks: Spark[] = [];
    let shockwaves: Shockwave[] = [];

    /** 只在初始化及实际尺寸变化时测量布局，逐帧与指针回调不读取布局。 */
    const resize = () => {
      bounds = canvas.getBoundingClientRect();
      width = Math.max(1, bounds.width);
      height = Math.max(1, bounds.height);
      // 不设置固定下限：8K/超宽屏也必须遵守物理像素预算，不能因保底DPR突破上限。
      pixelRatio = Math.min(
        window.devicePixelRatio || 1,
        1.5,
        Math.sqrt(2_200_000 / (width * height)),
      );
      // 向下取整避免两个维度分别四舍五入后又略微超过总像素预算。
      canvas.width = Math.max(1, Math.floor(width * pixelRatio));
      canvas.height = Math.max(1, Math.floor(height * pixelRatio));
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    };

    /** 透明度只作用于装饰层，不能覆盖或闪白中心教学文字。 */
    const draw = (delta: number) => {
      context.clearRect(0, 0, width, height);
      const positions = stars.map((star) => {
        const driftX = animated ? Math.sin(elapsed * 0.11 + star.phase) * 24 * star.depth : 0;
        const driftY = animated ? Math.cos(elapsed * 0.13 + star.phase) * 35 * star.depth : 0;
        const x = star.x * width + driftX;
        const y = star.y * height + driftY;
        const distance = Math.hypot(x - pointer.x, y - pointer.y);
        const push = pointer.x >= 0 && distance < 150 ? (150 - distance) * 0.16 : 0;
        const direction = Math.atan2(y - pointer.y, x - pointer.x);
        return { x: x + Math.cos(direction) * push, y: y + Math.sin(direction) * push };
      });
      context.lineWidth = 0.8;
      // 每枚仅检查一个固定间隔的候选，且总线条封顶，防止大屏变成密集网罩。
      let links = 0;
      for (
        let index = 0;
        index < positions.length && links < (lowQuality.current ? 8 : 22);
        index += 1
      ) {
        const current = positions[index];
        const next = positions[(index + 7) % positions.length];
        const distance = Math.hypot(current.x - next.x, current.y - next.y);
        if (distance > Math.min(width * 0.18, 210)) continue;
        context.globalAlpha = (1 - distance / 230) * 0.22;
        context.strokeStyle = colors[index % colors.length];
        context.beginPath();
        context.moveTo(current.x, current.y);
        context.lineTo(next.x, next.y);
        context.stroke();
        links += 1;
      }
      for (let index = 0; index < stars.length; index += 1) {
        const star = stars[index];
        const point = positions[index];
        const radius = 0.9 + star.depth * 2.2;
        const shimmer = 0.65 + Math.sin(elapsed * 1.1 + star.phase) * 0.18;
        context.globalAlpha = shimmer * (0.4 + star.depth * 0.5);
        context.fillStyle = colors[index % colors.length];
        context.beginPath();
        context.arc(point.x, point.y, radius * 3.2, 0, Math.PI * 2);
        context.globalAlpha *= 0.07;
        context.fill();
        context.globalAlpha = shimmer;
        context.beginPath();
        context.arc(point.x, point.y, radius, 0, Math.PI * 2);
        context.fill();
        if (index % 11 === 0) {
          context.globalAlpha = 0.38;
          context.strokeStyle = colors[index % colors.length];
          context.beginPath();
          context.moveTo(point.x - radius * 3, point.y);
          context.lineTo(point.x + radius * 3, point.y);
          context.moveTo(point.x, point.y - radius * 3);
          context.lineTo(point.x, point.y + radius * 3);
          context.stroke();
        }
      }

      // 两道错相流星沿屏幕侧边飞过，避开中心教学区；静态时不画拖尾。
      if (animated && !lowQuality.current) {
        for (let index = 0; index < 2; index += 1) {
          const travel = (elapsed * 0.07 + index * 0.57) % 1;
          const x = (index === 0 ? 0.04 : 0.74) * width + travel * width * 0.17;
          const y = -120 + travel * (height + 240);
          const gradient = context.createLinearGradient(x - 45, y - 110, x, y);
          gradient.addColorStop(0, 'transparent');
          gradient.addColorStop(1, colors[index]);
          context.globalAlpha = 0.62;
          context.strokeStyle = gradient;
          context.lineWidth = 1.5;
          context.beginPath();
          context.moveTo(x - 45, y - 110);
          context.lineTo(x, y);
          context.stroke();
        }
      }

      for (const spark of sparks) {
        const remaining = 1 - spark.life / spark.duration;
        context.globalAlpha = Math.max(0, remaining * remaining);
        context.strokeStyle = spark.color;
        context.fillStyle = spark.color;
        context.lineWidth = spark.size;
        context.beginPath();
        context.moveTo(spark.x - spark.vx * 0.035, spark.y - spark.vy * 0.035);
        context.lineTo(spark.x, spark.y);
        context.stroke();
        context.beginPath();
        context.arc(spark.x, spark.y, spark.size * 1.2, 0, Math.PI * 2);
        context.fill();
        spark.x += spark.vx * delta;
        spark.y += spark.vy * delta;
        spark.vy += 80 * delta;
        spark.life += delta;
      }
      sparks = sparks.filter((spark) => spark.life < spark.duration);
      for (const wave of shockwaves) {
        const progress = Math.min(1, wave.life / 0.85);
        context.globalAlpha = (1 - progress) * 0.7;
        context.strokeStyle = wave.color;
        context.lineWidth = 2 * (1 - progress) + 0.5;
        context.beginPath();
        context.ellipse(
          width * 0.5,
          height * 0.73,
          30 + progress * Math.min(width * 0.42, 460),
          10 + progress * Math.min(height * 0.15, 105),
          0,
          0,
          Math.PI * 2,
        );
        context.stroke();
        wave.life += delta;
      }
      shockwaves = shockwaves.filter((wave) => wave.life < 0.85);
      context.globalAlpha = 1;
      drawnFrames.current += 1;
      // 真实绘制计数供浏览器回归核验；不触发 React 重渲染或变更教学状态。
      canvas.dataset.frame = String(drawnFrames.current);
    };

    resize();
    draw(0);
    redrawRef.current = () => {
      const next = canvas.getBoundingClientRect();
      if (
        next.width === width &&
        next.height === height &&
        pixelRatio ===
          Math.min(window.devicePixelRatio || 1, 1.5, Math.sqrt(2_200_000 / (width * height)))
      )
        return;
      resize();
      draw(0);
    };
    const observer =
      typeof ResizeObserver === 'function'
        ? new ResizeObserver(() => redrawRef.current?.())
        : undefined;
    observer?.observe(canvas);
    const resizeFrame = () => redrawRef.current?.();
    window.addEventListener('resize', resizeFrame);
    if (!animated)
      return () => {
        observer?.disconnect();
        window.removeEventListener('resize', resizeFrame);
      };

    /** 外部真实拍击映射为有限爆发，不创建 setInterval 或衍生节拍。 */
    burstRef.current = () => {
      const amount = Math.round((15 + density * 9) * (lowQuality.current ? 0.5 : 1));
      const color = colors[shockwaves.length % colors.length];
      for (let index = 0; index < amount; index += 1) {
        const angle = (index / amount) * Math.PI * 2 - Math.PI * 0.5;
        const speed = 80 + ((index * 37) % 180);
        sparks.push({
          x: width * 0.5,
          y: height * 0.73,
          vx: Math.cos(angle) * speed * 1.3,
          vy: Math.sin(angle) * speed * 0.7 - 60,
          life: 0,
          duration: 0.58 + (index % 4) * 0.1,
          color: colors[index % colors.length],
          size: 1.3 + (index % 3) * 0.5,
        });
      }
      sparks = sparks.slice(-96);
      shockwaves = [...shockwaves, { life: 0, color }].slice(-4);
    };
    const onPointer = (event: PointerEvent) => {
      pointer = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
    };
    const clearPointer = () => {
      pointer = { x: -1, y: -1 };
    };
    const onPointerOut = (event: PointerEvent) => {
      // pointerout 会从内部文字和按钮冒泡；只有离开窗口才撤销作用力，避免跨控件跳变。
      if (event.relatedTarget === null) clearPointer();
    };
    let expensiveFrames = 0;
    canvas.dataset.quality = lowQuality.current ? 'low' : 'full';
    const tick = (now: number) => {
      // 45 FPS 足以保持粒子流畅；跳帧不会影响真实教学时钟。
      if (!lastFrame || now - lastFrame >= 1000 / 45) {
        const delta = lastFrame ? Math.min(0.05, (now - lastFrame) / 1000) : 0;
        elapsed += delta;
        elapsedRef.current = elapsed;
        lastFrame = now;
        const began = performance.now();
        draw(delta);
        // 只测本组件绘制成本；持续超预算才单向降级，避免负载抖动反复增减粒子。
        expensiveFrames = performance.now() - began > 8 ? expensiveFrames + 1 : 0;
        if (!lowQuality.current && expensiveFrames >= 8) {
          lowQuality.current = true;
          stars.splice(Math.ceil(stars.length / 2));
          canvas.dataset.quality = 'low';
        }
      }
      frame = requestAnimationFrame(tick);
    };
    if (interactive) {
      window.addEventListener('pointermove', onPointer, { passive: true });
      window.addEventListener('pointerout', onPointerOut);
    }
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener('resize', resizeFrame);
      window.removeEventListener('pointermove', onPointer);
      window.removeEventListener('pointerout', onPointerOut);
      burstRef.current = null;
      // 暂停不积压未完成爆发；静态最后帧保持，缩放时只重投影环境星场。
      sparks = [];
      shockwaves = [];
    };
  }, [animated, density, interactive]);

  useEffect(() => {
    const changed = pulseKey !== lastPulse.current;
    lastPulse.current = pulseKey;
    if (animated && changed && pulseKey !== undefined) burstRef.current?.();
  }, [animated, pulseKey]);

  return (
    <canvas
      ref={canvasRef}
      className={`ecg-game-particle-field ecg-particle-canvas ${className}`.trim()}
      data-engine="canvas2d"
      data-running={animated}
      aria-hidden="true"
    />
  );
}
