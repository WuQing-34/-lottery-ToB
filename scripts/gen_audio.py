# -*- coding: utf-8 -*-
"""
抽奖音效生成器（纯 Python 合成，无第三方依赖）

为什么不用爱给网的原始音频：
  爱给网对当前机器 IP 做了 banIp403 拦截（含 m.aigei.com 移动版与 CDN），
  所有请求都只返回滑块验证页，直连爬取无法拿到音频文件。
  因此这里用数学合成的方式生成一套"转盘 + 中奖"音效，
  音色、节奏均可控，且无版权风险。

如需换成爱给网下载的音频：
  把文件放到 public/audio/custom.mp3（或 .wav / .ogg），
  前端会自动优先加载它，无需改代码。

输出：
  public/audio/tick.wav   转盘转动时的"咔哒"声（每经过一个格子响一次）
  public/audio/win.wav    中奖庆祝音效（上行音阶 + 和弦 + 镲片）
  public/audio/fail.wav   无法抽奖/库存不足的提示音
  public/audio/click.wav  按钮点击声
"""

import math
import os
import random
import struct
import wave

SR = 44100
random.seed(20261110)

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'public', 'audio')


def write_wav(path, samples, peak=0.88):
    """samples: list[float] -1..1"""
    mx = max(1e-9, max(abs(s) for s in samples))
    scale = peak / mx
    frames = bytearray()
    for s in samples:
        v = int(max(-1.0, min(1.0, s * scale)) * 32767)
        frames += struct.pack('<h', v)
    with wave.open(path, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(bytes(frames))
    print('  -> %-16s %6.1f KB  %5.2fs' % (os.path.basename(path), len(frames) / 1024.0,
                                          len(samples) / float(SR)))


def blank(dur):
    return [0.0] * int(dur * SR)


def add(buf, start, samples, gain=1.0):
    i0 = int(start * SR)
    for i, s in enumerate(samples):
        j = i0 + i
        if 0 <= j < len(buf):
            buf[j] += s * gain


def bell(freq, dur, decay=3.0, amp=1.0, harmonics=5):
    """钟琴/铃铛音色：多个泛音叠加，指数衰减"""
    n = int(dur * SR)
    out = [0.0] * n
    for k in range(1, harmonics + 1):
        f = freq * k * (1.0 + 0.0007 * k * k)  # 轻微非谐波，金属感
        if f > SR / 2.2:
            break
        a = amp / (k ** 1.35)
        d = decay * (1.0 + 0.85 * (k - 1))
        for i in range(n):
            t = i / float(SR)
            out[i] += a * math.sin(2 * math.pi * f * t) * math.exp(-d * t)
    return out


def noise_burst(dur, decay=6.0, bright=1.0):
    n = int(dur * SR)
    out = [0.0] * n
    prev = 0.0
    for i in range(n):
        t = i / float(SR)
        w = random.uniform(-1, 1)
        # 一阶差分提升高频，bright 越大越"沙"
        d = w - prev
        prev = w
        out[i] = (d * bright + w * 0.35) * math.exp(-decay * t)
    return out


def sweep_noise(dur, decay=2.0):
    """上升的"嗖"声：噪声 + 逐渐升高的共振"""
    n = int(dur * SR)
    out = [0.0] * n
    phase = 0.0
    for i in range(n):
        t = i / float(SR)
        p = t / dur
        f = 400 + 2600 * (p ** 2)
        phase += 2 * math.pi * f / SR
        ring = math.sin(phase)
        out[i] = (random.uniform(-1, 1) * 0.55 + ring * 0.5) * (p ** 0.6) * math.exp(-decay * (1 - p))
    # 尾部淡出
    fade = int(0.03 * SR)
    for i in range(fade):
        out[n - fade + i] *= (fade - i) / float(fade)
    return out


# ---------------------------------------------------------------- 转盘咔哒声
def make_tick():
    buf = blank(0.11)
    add(buf, 0.0, noise_burst(0.06, decay=90, bright=1.4), 0.55)
    add(buf, 0.0, bell(1760, 0.09, decay=70, amp=0.55, harmonics=3))
    add(buf, 0.0, bell(880, 0.10, decay=45, amp=0.40, harmonics=4))
    add(buf, 0.0, bell(190, 0.10, decay=38, amp=0.35, harmonics=2))
    return buf


# ---------------------------------------------------------------- 中奖音效
def make_win():
    total = 2.9
    buf = blank(total)

    # 1) 起手"嗖"
    add(buf, 0.0, sweep_noise(0.45, decay=2.8), 0.42)

    # 2) 上行琶音 C5 E5 G5 C6
    notes = [523.25, 659.25, 783.99, 1046.50]
    for idx, f in enumerate(notes):
        add(buf, 0.28 + idx * 0.115, bell(f, 0.75, decay=4.2, amp=0.62), 0.62)

    # 3) 主和弦（大调三和弦 + 高八度），带轻微颤音
    chord = [523.25, 659.25, 783.99, 1046.50, 1318.51]
    start = 0.28 + 3 * 0.115
    for idx, f in enumerate(chord):
        tone = bell(f, total - start - 0.05, decay=1.55, amp=0.85 / (1 + 0.35 * idx))
        for i in range(len(tone)):
            t = i / float(SR)
            tone[i] *= 1.0 + 0.06 * math.sin(2 * math.pi * 5.5 * t)  # 颤音
        add(buf, start, tone, 0.5)

    # 4) 镲片 + 闪亮的高频颗粒
    add(buf, start, noise_burst(total - start, decay=2.2, bright=1.6), 0.20)
    for k in range(14):
        add(buf, start + 0.03 + k * 0.085, bell(2100 + random.uniform(-300, 900), 0.20,
                                                decay=24, amp=0.18, harmonics=2), 0.25)

    # 5) 结尾柔和收尾
    fade = int(0.22 * SR)
    for i in range(fade):
        buf[len(buf) - fade + i] *= (fade - i) / float(fade)
    return buf


# ---------------------------------------------------------------- 失败提示
def make_fail():
    buf = blank(0.75)
    for idx, f in enumerate([392.0, 311.13]):
        n = int(0.34 * SR)
        tone = [0.0] * n
        for i in range(n):
            t = i / float(SR)
            env = math.exp(-5.0 * t) * min(1.0, t / 0.008)
            tone[i] = env * (math.sin(2 * math.pi * f * t) * 0.7
                             + math.sin(2 * math.pi * f * 2 * t) * 0.18
                             + math.sin(2 * math.pi * f * 3 * t) * 0.07)
        add(buf, idx * 0.22, tone, 0.5)
    return buf


# ---------------------------------------------------------------- 按钮点击
def make_click():
    buf = blank(0.09)
    add(buf, 0.0, noise_burst(0.03, decay=120, bright=1.2), 0.5)
    add(buf, 0.0, bell(1320, 0.07, decay=80, amp=0.4, harmonics=2))
    return buf


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    print('生成音效 →', os.path.abspath(OUT_DIR))
    write_wav(os.path.join(OUT_DIR, 'tick.wav'), make_tick(), peak=0.80)
    write_wav(os.path.join(OUT_DIR, 'win.wav'), make_win(), peak=0.92)
    write_wav(os.path.join(OUT_DIR, 'fail.wav'), make_fail(), peak=0.70)
    write_wav(os.path.join(OUT_DIR, 'click.wav'), make_click(), peak=0.70)
    print('完成。')


if __name__ == '__main__':
    main()
