/**
 * Dual-element player with crossfade + persistent ambient (lo-fi) position.
 *
 *   elA/elB → gainA/gainB → compressor (limiter) → masterGain → speakers
 *
 * Only one element is "foreground"; the other is the crossfade tail / next up.
 * play() calls are serialized so overlapping track changes never hard-cut.
 */

export interface PlayRequest {
  src: string;
  trackId: string;
  position?: number;
  loop?: boolean;
  /** 0 = hard cut, 1–4 = typical fade seconds */
  fadeSec?: number;
}

export class PartyPlayer {
  readonly elA: HTMLAudioElement;
  readonly elB: HTMLAudioElement;

  private ctx: AudioContext;
  private gainA: GainNode;
  private gainB: GainNode;
  private master: GainNode;
  private compressor: DynamicsCompressorNode;
  private analyser: AnalyserNode;
  private freqData: Uint8Array<ArrayBuffer>;

  private active: 'A' | 'B' = 'A';
  private currentId: string | null = null;
  private volume = 1;
  private ambientPos = 0;
  private ambientId = 'ambient-lofi';
  /** monotonically increasing token — stale fades never steal the mix */
  private playGen = 0;
  private playChain: Promise<void> = Promise.resolve();

  onEnded: ((trackId: string) => void) | null = null;
  onTime: ((trackId: string, position: number) => void) | null = null;

  constructor() {
    this.elA = document.createElement('audio');
    this.elB = document.createElement('audio');
    for (const el of [this.elA, this.elB]) {
      el.preload = 'auto';
      el.crossOrigin = 'anonymous';
      el.style.display = 'none';
      document.body.appendChild(el);
    }

    const Ctx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    this.ctx = new Ctx();

    const srcA = this.ctx.createMediaElementSource(this.elA);
    const srcB = this.ctx.createMediaElementSource(this.elB);
    this.gainA = this.ctx.createGain();
    this.gainB = this.ctx.createGain();
    this.gainA.gain.value = 0;
    this.gainB.gain.value = 0;

    this.compressor = this.ctx.createDynamicsCompressor();
    this.compressor.threshold.value = -12;
    this.compressor.knee.value = 6;
    this.compressor.ratio.value = 12;
    this.compressor.attack.value = 0.003;
    this.compressor.release.value = 0.25;

    this.master = this.ctx.createGain();
    this.master.gain.value = 1;

    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 256;
    this.analyser.smoothingTimeConstant = 0.75;
    this.freqData = new Uint8Array(new ArrayBuffer(this.analyser.frequencyBinCount));

    srcA.connect(this.gainA);
    srcB.connect(this.gainB);
    this.gainA.connect(this.compressor);
    this.gainB.connect(this.compressor);
    this.compressor.connect(this.master);
    this.master.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);

    // Chrome требует жест для старта AudioContext — цепляемся на первый тап/клик
    const kick = () => {
      void this.resumeContext();
      window.removeEventListener('pointerdown', kick);
      window.removeEventListener('touchend', kick);
      window.removeEventListener('click', kick);
    };
    window.addEventListener('pointerdown', kick, { once: true });
    window.addEventListener('touchend', kick, { once: true });
    window.addEventListener('click', kick, { once: true });

    for (const el of [this.elA, this.elB]) {
      el.addEventListener('ended', () => {
        if (this.elOf(this.active) !== el) return;
        const id = this.currentId;
        // ambient: wrap at end of the ~2h file
        if (id === this.ambientId) {
          this.ambientPos = 0;
          el.currentTime = 0;
          void el.play().catch(() => {});
          return;
        }
        if (id) this.onEnded?.(id);
      });
      el.addEventListener('timeupdate', () => {
        if (this.elOf(this.active) !== el) return;
        const id = this.currentId;
        if (!id) return;
        if (id === this.ambientId) {
          this.ambientPos = el.currentTime;
        }
        this.onTime?.(id, el.currentTime);
      });
    }
  }

  private elOf(side: 'A' | 'B') {
    return side === 'A' ? this.elA : this.elB;
  }

  private gainOf(side: 'A' | 'B') {
    return side === 'A' ? this.gainA : this.gainB;
  }

  async resumeContext() {
    if (this.ctx.state === 'suspended') {
      try {
        await this.ctx.resume();
      } catch {
        /* needs gesture */
      }
    }
  }

  setVolume(v: number) {
    this.volume = Math.min(1, Math.max(0, v));
    const t = this.ctx.currentTime;
    try {
      this.master.gain.cancelScheduledValues(t);
      this.master.gain.setValueAtTime(this.volume, t);
    } catch {
      this.master.gain.value = this.volume;
    }
  }

  getVolume() {
    return this.volume;
  }

  /** 0..1 loudness for the cover aura — cheap RMS over the spectrum. */
  getLevel(): number {
    try {
      this.analyser.getByteFrequencyData(this.freqData);
      let sum = 0;
      const n = this.freqData.length;
      for (let i = 0; i < n; i++) {
        const v = this.freqData[i] / 255;
        sum += v * v;
      }
      return Math.min(1, Math.sqrt(sum / n) * 1.65);
    } catch {
      return 0;
    }
  }

  /** Saved ambient (lo-fi) playback position — survives guest-track interruptions. */
  getAmbientPosition() {
    return this.ambientPos;
  }

  setAmbientPosition(pos: number) {
    this.ambientPos = Math.max(0, pos);
  }

  pause() {
    this.elOf(this.active).pause();
  }

  async resume() {
    await this.resumeContext();
    await this.elOf(this.active).play().catch(() => {});
  }

  seek(position: number) {
    try {
      this.elOf(this.active).currentTime = position;
    } catch {
      /* ignore */
    }
  }

  get currentTrackId() {
    return this.currentId;
  }

  get isPaused() {
    return this.elOf(this.active).paused;
  }

  private waitReady(el: HTMLAudioElement): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (el.readyState >= 1) {
        resolve();
        return;
      }
      const onReady = () => {
        cleanup();
        resolve();
      };
      const onErr = () => {
        cleanup();
        reject(new Error('audio load failed'));
      };
      const cleanup = () => {
        el.removeEventListener('loadedmetadata', onReady);
        el.removeEventListener('error', onErr);
      };
      el.addEventListener('loadedmetadata', onReady);
      el.addEventListener('error', onErr);
    });
  }

  private sameSrc(el: HTMLAudioElement, src: string): boolean {
    try {
      return el.src === new URL(src, location.href).href;
    } catch {
      return el.src === src;
    }
  }

  /**
   * Play a track. Crossfades from whatever is currently sounding.
   * For ambient, falls back to the saved position when `position` is 0/omitted.
   */
  play(req: PlayRequest): Promise<void> {
    const run = this.playChain.then(() => this.playInner(req));
    this.playChain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private async playInner(req: PlayRequest): Promise<void> {
    await this.resumeContext();

    const isAmbient = req.trackId === this.ambientId || req.loop === true;
    const fade = Math.max(0, req.fadeSec ?? 2.4);
    const gen = ++this.playGen;

    const curEl = this.elOf(this.active);
    // ambient already playing this file → keep going (preserve position)
    if (
      isAmbient &&
      this.currentId === req.trackId &&
      !curEl.paused &&
      curEl.currentTime > 0 &&
      this.sameSrc(curEl, req.src)
    ) {
      return;
    }

    const nextSide = this.active === 'A' ? 'B' : 'A';
    const nextEl = this.elOf(nextSide);
    const nextGain = this.gainOf(nextSide);
    const prevEl = curEl;
    const prevGain = this.gainOf(this.active);
    const prevId = this.currentId;

    let start = req.position ?? 0;
    if (isAmbient && (req.position === undefined || req.position <= 0)) {
      start = this.ambientPos;
    }

    nextEl.loop = Boolean(req.loop);
    if (!this.sameSrc(nextEl, req.src)) {
      nextEl.src = req.src;
    }

    try {
      await this.waitReady(nextEl);
      if (start > 0) {
        const dur = nextEl.duration;
        if (Number.isFinite(dur) && dur > 0 && start >= dur - 0.5) {
          start = 0;
          if (isAmbient) this.ambientPos = 0;
        }
        nextEl.currentTime = start;
      }
    } catch {
      /* still try to play */
    }

    // If a newer play() queued up while we loaded, let it win.
    if (gen !== this.playGen) return;

    await nextEl.play().catch(() => {});
    if (gen !== this.playGen) return;

    const t = this.ctx.currentTime;
    const prevAudible =
      prevId !== null &&
      prevEl !== nextEl &&
      (!prevEl.paused || prevGain.gain.value > 0.02);

    if (prevAudible && fade > 0) {
      // Ensure we start the fade-out from full level when the previous
      // track is actually sounding (gain may sit at 0 after a hard cut).
      const prevStart = prevEl.paused ? 0 : Math.max(prevGain.gain.value, 0.001);
      const nextStart = 0;

      try {
        prevGain.gain.cancelScheduledValues(t);
        prevGain.gain.setValueAtTime(prevStart, t);
        prevGain.gain.linearRampToValueAtTime(0, t + fade);

        nextGain.gain.cancelScheduledValues(t);
        nextGain.gain.setValueAtTime(nextStart, t);
        nextGain.gain.linearRampToValueAtTime(1, t + fade);
      } catch {
        prevGain.gain.value = 0;
        nextGain.gain.value = 1;
      }

      const fadeMs = fade * 1000;
      const fadeGen = gen;
      window.setTimeout(() => {
        if (this.playGen !== fadeGen) return;
        if (prevEl !== this.elOf(this.active)) {
          prevEl.pause();
          try {
            prevGain.gain.value = 0;
          } catch {
            /* ignore */
          }
        }
      }, fadeMs);
    } else {
      try {
        prevGain.gain.cancelScheduledValues(t);
        prevGain.gain.setValueAtTime(0, t);
        nextGain.gain.cancelScheduledValues(t);
        nextGain.gain.setValueAtTime(1, t);
      } catch {
        prevGain.gain.value = 0;
        nextGain.gain.value = 1;
      }
      if (prevEl !== nextEl) prevEl.pause();
    }

    this.active = nextSide;
    this.currentId = req.trackId;
  }

  stop() {
    this.playGen += 1;
    this.elA.pause();
    this.elB.pause();
    const t = this.ctx.currentTime;
    try {
      this.gainA.gain.cancelScheduledValues(t);
      this.gainB.gain.cancelScheduledValues(t);
      this.gainA.gain.setValueAtTime(0, t);
      this.gainB.gain.setValueAtTime(0, t);
    } catch {
      this.gainA.gain.value = 0;
      this.gainB.gain.value = 0;
    }
    this.currentId = null;
  }
}
