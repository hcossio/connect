// Turns the mic into 16 kHz mono frames of 100 ms for the transcript. The
// audio context runs at the device's own rate, so this averages each output
// sample over its slice of input samples (a simple low-pass and downsample).
class Capture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.step = sampleRate / 16000;
    this.frame = new Float32Array(1600);
    this.n = 0;
    this.acc = 0;
    this.count = 0;
    this.pos = 0;
  }
  process([input]) {
    const ch = input[0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.acc += ch[i];
      this.count++;
      this.pos++;
      if (this.pos < this.step) continue;
      this.pos -= this.step;
      this.frame[this.n++] = this.acc / this.count;
      this.acc = 0;
      this.count = 0;
      if (this.n === this.frame.length) {
        this.port.postMessage(this.frame, [this.frame.buffer]);
        this.frame = new Float32Array(1600);
        this.n = 0;
      }
    }
    return true;
  }
}
registerProcessor('capture', Capture);
