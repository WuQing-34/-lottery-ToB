/* ============================================================
   大转盘 Canvas 渲染 + 旋转动画
   ============================================================ */
(function (global) {
  'use strict';

  const TAU = Math.PI * 2;
  // 两套配色：CC 红金 / LP 蓝金，两个团队的转盘一眼能区分
  const PALETTES = {
    purple: [
      { a: '#9a63e8', b: '#6a35bd', text: '#fff6ff' },
      { a: '#fff0dc', b: '#ffd9a8', text: '#7a3d00' },
      { a: '#ffd166', b: '#e9a11c', text: '#5a3600' },
      { a: '#f6efff', b: '#e6d6ff', text: '#5c2b9c' },
    ],
    red: [
      { a: '#f2564a', b: '#cf2419', text: '#fff6e2' },
      { a: '#fff4dc', b: '#ffe3b3', text: '#8f2a10' },
      { a: '#ffcf6b', b: '#f2a92b', text: '#6d3800' },
      { a: '#fff8ee', b: '#ffeccd', text: '#a83a15' },
    ],
    blue: [
      { a: '#5b95f5', b: '#2a5cd4', text: '#f4f8ff' },
      { a: '#eef5ff', b: '#d3e4ff', text: '#14417f' },
      { a: '#7fc6ff', b: '#3f9fe8', text: '#0d3557' },
      { a: '#f8fbff', b: '#e2efff', text: '#20508c' },
    ],
  };

  function mod(a, n) { return ((a % n) + n) % n; }
  function num(v, def) { const n = Number(v); return Number.isFinite(n) ? n : def; }

  /**
   * 扇区角度区间：一律等分。
   * 中奖概率由后台配置独立决定，与扇区面积无关；
   * 这里所有扇区面积相同，仅作为转盘的视觉呈现。
   */
  function ranges(segments) {
    const n = segments.length;
    if (!n) return [];
    const width = TAU / n;
    let a = -Math.PI / 2;
    return segments.map((_, i) => {
      const r = { start: a, end: a + width, width, mid: a + width / 2 };
      a += width;
      return r;
    });
  }

  class Wheel {
    constructor(canvas, opts) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.segments = [];
      this.rotation = 0;
      this.spinning = false;
      this.onTick = (opts && opts.onTick) || null;
      this.palette = (opts && opts.palette) || 'red';
      this.size = 0;
      this.dpr = Math.min(2.5, global.devicePixelRatio || 1);
      this._idleRaf = 0;
      this._spinRaf = 0;
      this._lastIndex = -1;

      this._resize = this._resize.bind(this);
      global.addEventListener('resize', this._resize);
      if (global.ResizeObserver && canvas.parentElement) {
        this._ro = new ResizeObserver(this._resize);
        this._ro.observe(canvas.parentElement);
      }
      this._resize();
      this._startIdle();
    }

    _resize() {
      const w = this.canvas.clientWidth || 520;
      this.size = w;
      this.canvas.width = Math.round(w * this.dpr);
      this.canvas.height = Math.round(w * this.dpr);
      this.draw();
    }

    setSegments(list) {
      this.segments = Array.isArray(list) ? list.slice() : [];
      this.draw();
    }

    get n() { return this.segments.length; }

    /** 指针（正上方）当前指向的扇区下标 */
    indexAt(rotation) {
      const rs = ranges(this.segments);
      if (!rs.length) return -1;
      const p = mod(-rotation, TAU);
      let acc = 0;
      for (let i = 0; i < rs.length; i += 1) {
        acc += rs[i].width;
        if (p < acc) return i;
      }
      return rs.length - 1;
    }

    _startIdle() {
      cancelAnimationFrame(this._idleRaf);
      const loop = () => {
        if (!this.spinning) this.draw();
        this._idleRaf = requestAnimationFrame(loop);
      };
      this._idleRaf = requestAnimationFrame(loop);
    }

    draw() {
      const ctx = this.ctx;
      const size = this.size;
      if (!size) return;
      const cx = size / 2;
      const cy = size / 2;
      const R = size / 2 - 4;
      const dpr = this.dpr;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, size, size);

      const n = this.n;

      // ---- 底盘光晕 ----
      const glow = ctx.createRadialGradient(cx, cy, R * 0.5, cx, cy, R);
      glow.addColorStop(0, 'rgba(255, 233, 190, 0.95)');
      glow.addColorStop(1, 'rgba(255, 205, 120, 0.28)');
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, TAU);
      ctx.fillStyle = glow;
      ctx.fill();

      if (!n) {
        ctx.fillStyle = '#b9a894';
        ctx.font = '600 15px "PingFang SC","Microsoft YaHei",sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('等待管理员配置奖品…', cx, cy);
        return;
      }

      const seg = TAU / n;
      const arcs = ranges(this.segments);
      const Rs = R - 22;
      const palette = PALETTES[this.palette] || PALETTES.red;

      // ---- 扇区 ----
      ctx.save();
      ctx.translate(cx, cy);
      for (let i = 0; i < n; i += 1) {
        const a0 = arcs[i].start + this.rotation;
        const a1 = arcs[i].end + this.rotation;
        const c = palette[i % palette.length];

        const g = ctx.createRadialGradient(0, 0, Rs * 0.12, 0, 0, Rs);
        g.addColorStop(0, c.a);
        g.addColorStop(1, c.b);

        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.arc(0, 0, Rs, a0, a1);
        ctx.closePath();
        ctx.fillStyle = g;
        ctx.fill();

        ctx.strokeStyle = 'rgba(255,255,255,0.72)';
        ctx.lineWidth = 2;
        ctx.stroke();

        // ---- 奖品文字 ----
        const mid = arcs[i].mid + this.rotation;
        const name = this.segments[i].name || '';
        const maxLen = n <= 6 ? 9 : n <= 8 ? 7 : 6;
        const label = name.length > maxLen ? name.slice(0, maxLen) + '…' : name;

        let fontSize = n <= 6 ? 23 : n <= 8 ? 20 : n <= 10 ? 18 : 16;
        const visualLen = Math.max(2, label.length);
        fontSize = Math.min(fontSize, ((Rs - 30) * 1.7) / visualLen);
        const arcFactor = Math.min(1, arcs[i].width / seg);
        fontSize = Math.max(9, fontSize * Math.max(0.55, arcFactor));

        ctx.save();
        ctx.rotate(mid);
        const flip = Math.cos(mid) < 0;
        if (flip) {
          ctx.rotate(Math.PI);
          ctx.textAlign = 'left';
        } else {
          ctx.textAlign = 'right';
        }
        ctx.textBaseline = 'middle';
        ctx.font = `700 ${fontSize}px "PingFang SC","Microsoft YaHei",sans-serif`;
        ctx.fillStyle = c.text;
        ctx.fillText(label, flip ? -(Rs - 26) : Rs - 26, 0);
        ctx.restore();
      }
      ctx.restore();

      // ---- 金色外圈 ----
      const rimW = 20;
      const rim = ctx.createLinearGradient(0, 0, size, size);
      rim.addColorStop(0, '#ffe6a8');
      rim.addColorStop(0.28, '#f6c45b');
      rim.addColorStop(0.5, '#e59a11');
      rim.addColorStop(0.72, '#ffe6a8');
      rim.addColorStop(1, '#d98908');
      ctx.beginPath();
      ctx.arc(cx, cy, R - rimW / 2 - 1, 0, TAU);
      ctx.lineWidth = rimW;
      ctx.strokeStyle = rim;
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, TAU);
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = 'rgba(180, 110, 10, 0.55)';
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cx, cy, R - rimW, 0, TAU);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
      ctx.stroke();

      // ---- 跑马灯 ----
      const lights = Math.max(16, Math.min(28, n * 3));
      const t = performance.now() / 1000;
      for (let i = 0; i < lights; i += 1) {
        const a = (i / lights) * TAU - Math.PI / 2 + this.rotation * 0.35;
        const lx = cx + Math.cos(a) * (R - rimW / 2);
        const ly = cy + Math.sin(a) * (R - rimW / 2);
        const phase = Math.sin(t * (this.spinning ? 9 : 2.2) + i * 1.1);
        const on = phase > 0;
        const r = 3.1;
        ctx.beginPath();
        ctx.arc(lx, ly, r + (on ? 1.1 : 0), 0, TAU);
        ctx.fillStyle = on ? '#fffdf3' : 'rgba(255, 246, 214, 0.45)';
        ctx.fill();
        if (on) {
          ctx.beginPath();
          ctx.arc(lx, ly, r + 3.4, 0, TAU);
          ctx.fillStyle = 'rgba(255, 240, 190, 0.28)';
          ctx.fill();
        }
      }
    }

    /**
     * 旋转到指定扇区
     * @returns {Promise<void>}
     */
    spinTo(targetIndex, opts) {
      const n = this.n;
      const o = opts || {};
      if (!n || this.spinning) return Promise.resolve();
      this.spinning = true;

      const arcs = ranges(this.segments);
      const target = arcs[targetIndex] || arcs[0];
      const jitter = (Math.random() - 0.5) * Math.min(target.width, TAU / n) * 0.5;
      const desired = mod(-Math.PI / 2 - target.mid + jitter, TAU);
      const current = mod(this.rotation, TAU);
      const delta = mod(desired - current, TAU);
      const turns = o.turns || 6;
      const total = turns * TAU + delta;
      const duration = o.duration || 5200 + Math.random() * 500;
      const start = this.rotation;
      const startTime = performance.now();
      this._lastIndex = this.indexAt(start);

      return new Promise((resolve) => {
        const frame = (now) => {
          const t = Math.min(1, (now - startTime) / duration);
          const p = 1 - Math.pow(1 - t, 3.55); // 缓出：起步快、尾段长减速
          this.rotation = start + total * p;

          const idx = this.indexAt(this.rotation);
          if (idx !== this._lastIndex) {
            this._lastIndex = idx;
            if (this.onTick) this.onTick(idx);
          }
          this.draw();

          if (t < 1) {
            this._spinRaf = requestAnimationFrame(frame);
          } else {
            // 保持连续角度（不做 mod 归一化），否则跑马灯相位会在最后一帧跳变
            this.rotation = start + total;
            this.spinning = false;
            this.draw();
            resolve();
          }
        };
        this._spinRaf = requestAnimationFrame(frame);
      });
    }
  }

  global.Wheel = Wheel;
})(window);
