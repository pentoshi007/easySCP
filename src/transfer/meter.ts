const WINDOW_MS = 5000;

export class SpeedMeter {
  private readonly samples: { time: number; bytes: number }[] = [];
  private total = 0;

  constructor(private readonly now: () => number = () => performance.now()) {
    this.samples.push({ time: this.now(), bytes: 0 });
  }

  add(bytes: number): void {
    this.total += bytes;
  }

  get bytes(): number {
    return this.total;
  }

  sample(): number {
    const time = this.now();
    this.samples.push({ time, bytes: this.total });
    while (
      this.samples.length > 2 &&
      time - (this.samples[1] as { time: number }).time > WINDOW_MS
    ) {
      this.samples.shift();
    }
    const first = this.samples[0] as { time: number; bytes: number };
    const elapsed = time - first.time;
    return elapsed > 250 ? ((this.total - first.bytes) * 1000) / elapsed : 0;
  }
}
