/**
 * Reactor — canvas renderer for the arc-reactor core.
 * Five interchangeable visual styles, all audio/state reactive.
 */

const TAU = Math.PI * 2;
const lerp = (a, b, t) => a + (b - a) * t;

export class Reactor {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: true });
    this.style = 'torus';
    this.state = 'idle';
    this.level = 0;
    this.targetLevel = 0;
    this.reactive = true;
    this.particlesOn = true;
    this.t = 0;
    this.lastFrame = performance.now();
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.colors = { acc: [95, 243, 255], acc2: [255, 181, 69] };
    this.particles = Array.from({ length: 46 }, () => this.spawnParticle());
    this.readColors();
    this.resize();
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas);
    this.loop = this.loop.bind(this);
    requestAnimationFrame(this.loop);
  }

  spawnParticle(initial = false) {
    return {
      a: Math.random() * TAU,
      r: 0.55 + Math.random() * 0.75,
      speed: (Math.random() * 0.25 + 0.05) * (Math.random() > 0.5 ? 1 : -1),
      size: Math.random() * 1.6 + 0.4,
      alpha: initial ? Math.random() * 0.6 + 0.2 : 0,
      fade: Math.random() * 0.004 + 0.0015,
    };
  }

  readColors() {
    const cs = getComputedStyle(document.documentElement);
    const parse = (v, fallback) => {
      const nums = (v || '').match(/\d+(\.\d+)?/g);
      return nums && nums.length >= 3 ? nums.slice(0, 3).map(Number) : fallback;
    };
    this.colors.acc = parse(cs.getPropertyValue('--acc-rgb'), [95, 243, 255]);
    this.colors.acc2 = parse(cs.getPropertyValue('--acc2-rgb'), [255, 181, 69]);
  }

  setStyle(style) {
    this.style = style;
  }

  setState(state) {
    this.state = state;
  }

  setLevel(v) {
    this.targetLevel = Math.max(0, Math.min(1, v || 0));
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(rect.width, 1);
    const h = Math.max(rect.height, 1);
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.w = w;
    this.h = h;
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  rgba(c, a = 1) {
    return `rgba(${c[0]},${c[1]},${c[2]},${a})`;
  }

  loop(now) {
    const dt = Math.min((now - this.lastFrame) / 1000, 0.05);
    this.lastFrame = now;
    this.t += dt;

    const speed = this.state === 'thinking' ? 2.6 : this.state === 'listening' ? 1.5 : this.state === 'speaking' ? 1.15 : 0.75;
    this.anim = (this.anim || 0) + dt * speed;
    this.level = lerp(this.level, this.reactive ? this.targetLevel : 0, 0.16);

    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.w, this.h);
    this.drawParticles(ctx);

    const R = Math.min(this.w, this.h) / 2;
    const cx = this.w / 2;
    const cy = this.h / 2;

    // ambient bloom
    const bloom = ctx.createRadialGradient(cx, cy, R * 0.05, cx, cy, R * 1.05);
    bloom.addColorStop(0, this.rgba(this.colors.acc, 0.2 + this.level * 0.22));
    bloom.addColorStop(0.45, this.rgba(this.colors.acc, 0.05 + this.level * 0.06));
    bloom.addColorStop(1, this.rgba(this.colors.acc, 0));
    ctx.fillStyle = bloom;
    ctx.fillRect(0, 0, this.w, this.h);

    switch (this.style) {
      case 'hex': this.drawHex(ctx, cx, cy, R); break;
      case 'plasma': this.drawPlasma(ctx, cx, cy, R); break;
      case 'wave': this.drawWave(ctx, cx, cy, R); break;
      case 'minimal': this.drawMinimal(ctx, cx, cy, R); break;
      default: this.drawTorus(ctx, cx, cy, R);
    }

    this.drawHousing(ctx, cx, cy, R);
    requestAnimationFrame(this.loop);
  }

  /* ---------------------------------------------------------------- shared */

  drawParticles(ctx) {
    if (!this.particlesOn) return;
    const R = Math.min(this.w, this.h) / 2;
    const cx = this.w / 2;
    const cy = this.h / 2;
    for (const p of this.particles) {
      p.a += p.speed * 0.006;
      p.alpha = Math.min(0.85, p.alpha + p.fade * 9);
      if (p.alpha <= 0.02) Object.assign(p, this.spawnParticle());
      const x = cx + Math.cos(p.a) * R * p.r * 0.92;
      const y = cy + Math.sin(p.a) * R * p.r * 0.92;
      ctx.fillStyle = this.rgba(this.colors.acc, p.alpha * (0.35 + this.level * 0.55));
      ctx.beginPath();
      ctx.arc(x, y, p.size, 0, TAU);
      ctx.fill();
    }
  }

  drawHousing(ctx, cx, cy, R) {
    // static outer bevel + bolt notches
    ctx.save();
    ctx.translate(cx, cy);
    ctx.strokeStyle = this.rgba(this.colors.acc, 0.16);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(0, 0, R * 0.975, 0, TAU);
    ctx.stroke();

    // ticks
    const ticks = 96;
    for (let i = 0; i < ticks; i++) {
      const a = (i / ticks) * TAU + this.anim * 0.05;
      const major = i % 8 === 0;
      const r1 = R * (major ? 0.94 : 0.955);
      const r2 = R * 0.975;
      ctx.strokeStyle = this.rgba(this.colors.acc, major ? 0.42 : 0.16);
      ctx.lineWidth = major ? 1.4 : 0.7;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * r1, Math.sin(a) * r1);
      ctx.lineTo(Math.cos(a) * r2, Math.sin(a) * r2);
      ctx.stroke();
    }

    // cardinal brackets
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * TAU + Math.PI / 4;
      ctx.strokeStyle = this.rgba(this.colors.acc2, 0.35);
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(0, 0, R * 0.9, a - 0.1, a + 0.1);
      ctx.stroke();
    }
    ctx.restore();
  }

  core(ctx, cx, cy, radius, intensity = 1) {
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
    g.addColorStop(0, 'rgba(255,255,255,0.98)');
    g.addColorStop(0.28, this.rgba(this.colors.acc, 0.95 * intensity));
    g.addColorStop(0.62, this.rgba(this.colors.acc, 0.35 * intensity));
    g.addColorStop(1, this.rgba(this.colors.acc, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, TAU);
    ctx.fill();
  }

  /* ----------------------------------------------------------------- torus */

  drawTorus(ctx, cx, cy, R) {
    const lv = this.level;
    ctx.save();
    ctx.translate(cx, cy);

    // three coil rings
    const rings = [
      { r: 0.84, w: 2.2, speed: 0.55, gap: 0.85, alpha: 0.5, color: this.colors.acc },
      { r: 0.72, w: 1.5, speed: -0.9, gap: 0.5, alpha: 0.4, color: this.colors.acc2 },
      { r: 0.6, w: 3.2, speed: 0.32, gap: 1.35, alpha: 0.62, color: this.colors.acc },
    ];
    for (const ring of rings) {
      const segs = Math.round((TAU / ring.gap));
      for (let s = 0; s < segs; s++) {
        const start = s * ring.gap + this.anim * ring.speed;
        ctx.beginPath();
        ctx.strokeStyle = this.rgba(ring.color, ring.alpha * (0.6 + lv * 0.7));
        ctx.lineWidth = ring.w;
        ctx.shadowColor = this.rgba(ring.color, 0.9);
        ctx.shadowBlur = 12 + lv * 26;
        ctx.arc(0, 0, R * ring.r, start, start + ring.gap * 0.72);
        ctx.stroke();
      }
    }
    ctx.shadowBlur = 0;

    // segmented inner field ring — reactive radius
    const innerR = R * (0.4 + lv * 0.06);
    const segCount = 24;
    for (let i = 0; i < segCount; i++) {
      const a = (i / segCount) * TAU - this.anim * 0.22;
      const len = 0.09 + lv * 0.05;
      ctx.strokeStyle = this.rgba(this.colors.acc, 0.22 + lv * 0.5);
      ctx.lineWidth = 2.6;
      ctx.beginPath();
      ctx.arc(0, 0, innerR, a, a + len);
      ctx.stroke();
    }

    // spokes
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * TAU + this.anim * 0.12;
      const grad = ctx.createLinearGradient(
        Math.cos(a) * R * 0.18, Math.sin(a) * R * 0.18,
        Math.cos(a) * R * 0.52, Math.sin(a) * R * 0.52,
      );
      grad.addColorStop(0, this.rgba(this.colors.acc, 0.05));
      grad.addColorStop(0.6, this.rgba(this.colors.acc, 0.28 + lv * 0.3));
      grad.addColorStop(1, this.rgba(this.colors.acc, 0));
      ctx.strokeStyle = grad;
      ctx.lineWidth = i % 2 === 0 ? 1.6 : 0.8;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * R * 0.16, Math.sin(a) * R * 0.16);
      ctx.lineTo(Math.cos(a) * R * 0.56, Math.sin(a) * R * 0.56);
      ctx.stroke();
    }

    // core + triangular mounts
    this.core(ctx, 0, 0, R * (0.26 + lv * 0.14), 1);
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * TAU + this.anim * 0.05;
      ctx.save();
      ctx.rotate(a);
      ctx.strokeStyle = this.rgba(this.colors.acc2, 0.3 + lv * 0.3);
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(0, -R * 0.3);
      ctx.lineTo(R * 0.06, -R * 0.42);
      ctx.lineTo(-R * 0.06, -R * 0.42);
      ctx.closePath();
      ctx.stroke();
      ctx.restore();
    }

    // lens flare horizon
    const flare = ctx.createLinearGradient(-R, 0, R, 0);
    flare.addColorStop(0, 'rgba(0,0,0,0)');
    flare.addColorStop(0.5, this.rgba(this.colors.acc, 0.22 + lv * 0.3));
    flare.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = flare;
    ctx.fillRect(-R * 0.95, -0.6, R * 1.9, 1.2);
    ctx.restore();
  }

  /* ------------------------------------------------------------------ hex */

  drawHex(ctx, cx, cy, R) {
    const lv = this.level;
    const size = R * 0.1;
    const w = Math.sqrt(3) * size;
    const h = 2 * size;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.lineWidth = 1;

    for (let row = -4; row <= 4; row++) {
      for (let col = -4; col <= 4; col++) {
        const x = col * w + (row % 2 ? w / 2 : 0);
        const y = row * h * 0.75;
        const dist = Math.hypot(x, y) / R;
        if (dist > 0.88) continue;
        const pulse = Math.sin(this.anim * 2.2 - dist * 7 + lv * 3) * 0.5 + 0.5;
        const near = 1 - Math.min(dist / 0.9, 1);
        ctx.beginPath();
        for (let i = 0; i < 6; i++) {
          const a = (i / 6) * TAU + Math.PI / 6;
          const px = x + Math.cos(a) * size * 0.52;
          const py = y + Math.sin(a) * size * 0.52;
          i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
        }
        ctx.closePath();
        const alpha = 0.06 + near * 0.3 * pulse + lv * near * 0.35;
        ctx.strokeStyle = this.rgba(this.colors.acc, alpha);
        ctx.stroke();
        if (pulse > 0.86 && dist < 0.7) {
          ctx.fillStyle = this.rgba(this.colors.acc, (pulse - 0.86) * 1.4 * (0.4 + lv));
          ctx.fill();
        }
      }
    }

    // concentric rings over the array
    for (let i = 0; i < 3; i++) {
      ctx.beginPath();
      const rr = R * (0.32 + i * 0.19);
      ctx.strokeStyle = this.rgba(this.colors.acc, 0.18 - i * 0.04 + lv * 0.08);
      ctx.lineWidth = i === 0 ? 2 : 1;
      ctx.arc(0, 0, rr, this.anim * (0.3 + i * 0.12), this.anim * (0.3 + i * 0.12) + Math.PI * 1.4);
      ctx.stroke();
    }
    this.core(ctx, 0, 0, R * (0.16 + lv * 0.1));
    ctx.restore();
  }

  /* --------------------------------------------------------------- plasma */

  drawPlasma(ctx, cx, cy, R) {
    const lv = this.level;
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, R * 0.86, 0, TAU);
    ctx.clip();
    ctx.globalCompositeOperation = 'screen';

    const blobs = 7;
    for (let i = 0; i < blobs; i++) {
      const phase = (i / blobs) * TAU;
      const orbit = R * (0.18 + 0.42 * (0.5 + 0.5 * Math.sin(this.anim * 0.5 + i)));
      const x = cx + Math.cos(this.anim * (0.4 + i * 0.08) + phase) * orbit;
      const y = cy + Math.sin(this.anim * (0.33 + i * 0.06) + phase * 1.4) * orbit;
      const rad = R * (0.22 + 0.16 * Math.sin(this.anim * 0.8 + i) + lv * 0.1);
      const color = i % 3 === 0 ? this.colors.acc2 : this.colors.acc;
      const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
      g.addColorStop(0, this.rgba(color, 0.3 + lv * 0.25));
      g.addColorStop(0.5, this.rgba(color, 0.1));
      g.addColorStop(1, this.rgba(color, 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, rad, 0, TAU);
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';

    // filament rings
    for (let i = 0; i < 5; i++) {
      ctx.beginPath();
      ctx.strokeStyle = this.rgba(this.colors.acc, 0.12 + lv * 0.12);
      ctx.lineWidth = 0.8;
      const rr = R * (0.3 + i * 0.13) + Math.sin(this.anim + i) * R * 0.015;
      ctx.arc(cx, cy, rr, this.anim * 0.6 + i, this.anim * 0.6 + i + 2.2);
      ctx.stroke();
    }
    ctx.restore();

    // containment ring
    ctx.beginPath();
    ctx.strokeStyle = this.rgba(this.colors.acc, 0.4 + lv * 0.3);
    ctx.lineWidth = 1.4;
    ctx.shadowColor = this.rgba(this.colors.acc, 0.8);
    ctx.shadowBlur = 18;
    ctx.arc(cx, cy, R * 0.86, 0, TAU);
    ctx.stroke();
    ctx.shadowBlur = 0;
    this.core(ctx, cx, cy, R * (0.2 + lv * 0.16), 0.95);
  }

  /* ----------------------------------------------------------------- wave */

  drawWave(ctx, cx, cy, R) {
    const lv = this.level;
    ctx.save();
    ctx.translate(cx, cy);
    const baseR = R * 0.5;
    for (let layer = 0; layer < 3; layer++) {
      ctx.beginPath();
      const points = 180;
      for (let i = 0; i <= points; i++) {
        const a = (i / points) * TAU;
        const wobble =
          Math.sin(a * (6 + layer * 2) + this.anim * (2.2 + layer * 0.6)) * R * (0.02 + lv * 0.09) +
          Math.sin(a * 3 - this.anim * 1.4) * R * 0.016;
        const r = baseR + layer * R * 0.055 + wobble;
        const x = Math.cos(a) * r;
        const y = Math.sin(a) * r;
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      ctx.closePath();
      ctx.strokeStyle = this.rgba(layer === 1 ? this.colors.acc2 : this.colors.acc, 0.4 - layer * 0.1 + lv * 0.25);
      ctx.lineWidth = layer === 0 ? 2 : 1;
      ctx.shadowColor = this.rgba(this.colors.acc, 0.7);
      ctx.shadowBlur = 14;
      ctx.stroke();
    }
    ctx.shadowBlur = 0;

    // radial frequency bars
    const bars = 48;
    for (let i = 0; i < bars; i++) {
      const a = (i / bars) * TAU + this.anim * 0.1;
      const amp = (0.02 + Math.abs(Math.sin(i * 1.7 + this.anim * 2.4)) * (0.05 + lv * 0.22)) * R;
      ctx.strokeStyle = this.rgba(this.colors.acc, 0.3 + lv * 0.3);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * R * 0.72, Math.sin(a) * R * 0.72);
      ctx.lineTo(Math.cos(a) * (R * 0.72 + amp), Math.sin(a) * (R * 0.72 + amp));
      ctx.stroke();
    }
    this.core(ctx, 0, 0, R * (0.18 + lv * 0.12));
    ctx.restore();
  }

  /* -------------------------------------------------------------- minimal */

  drawMinimal(ctx, cx, cy, R) {
    const lv = this.level;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.strokeStyle = this.rgba(this.colors.acc, 0.5 + lv * 0.4);
    ctx.lineWidth = 1.2;
    ctx.shadowColor = this.rgba(this.colors.acc, 0.85);
    ctx.shadowBlur = 20 + lv * 30;
    ctx.beginPath();
    ctx.arc(0, 0, R * 0.62, 0, TAU);
    ctx.stroke();

    ctx.setLineDash([2, 10]);
    ctx.strokeStyle = this.rgba(this.colors.acc2, 0.4);
    ctx.beginPath();
    ctx.arc(0, 0, R * 0.74, this.anim * 0.6, this.anim * 0.6 + TAU);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.shadowBlur = 0;

    this.core(ctx, 0, 0, R * (0.16 + lv * 0.2));
    // scanning sweep
    const sweep = ctx.createLinearGradient(0, 0, R, 0);
    sweep.addColorStop(0, this.rgba(this.colors.acc, 0.3));
    sweep.addColorStop(1, this.rgba(this.colors.acc, 0));
    ctx.fillStyle = sweep;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, R * 0.62, this.anim * 1.4, this.anim * 1.4 + 0.28);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
}
