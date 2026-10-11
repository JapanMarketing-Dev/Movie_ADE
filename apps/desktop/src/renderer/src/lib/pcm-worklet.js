// AudioWorklet that forwards raw PCM to the main thread. Each message: { t: currentTime, frame: currentFrame,
// data: Float32Array[] } with one array per channel (128 frames per render quantum).
class PcmTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = null;
    this.n = 0;
    this.started = false;
  }
  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const ch = input.length;
    const len = input[0].length;
    if (!this.buf) {
      // batch ~ 2048 frames per message to keep postMessage overhead low
      this.buf = Array.from({ length: ch }, () => new Float32Array(2048));
      this.n = 0;
      this.startFrame = currentFrame;
    }
    for (let c = 0; c < ch && c < this.buf.length; c++) this.buf[c].set(input[c], this.n);
    this.n += len;
    if (!this.started) {
      this.started = true;
      this.port.postMessage({ first: true, t: currentTime, frame: currentFrame });
    }
    if (this.n + len > 2048) {
      const out = this.buf.map((b) => b.slice(0, this.n));
      this.port.postMessage({ data: out, frame: this.startFrame }, out.map((b) => b.buffer));
      this.buf = null;
    }
    return true;
  }
}
registerProcessor('pcm-tap', PcmTap);
