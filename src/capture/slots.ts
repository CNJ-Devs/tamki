/** Abortable FIFO slots. Limits are read when a slot becomes available. */
export class Slots {
  private active = 0;
  private waiting: (() => void)[] = [];
  constructor(private limit: () => number) {}
  acquire(signal: AbortSignal): Promise<() => void> {
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.waiting = this.waiting.filter((entry) => entry !== attempt);
        reject(signal.reason);
        this.drain();
      };
      const attempt = () => {
        if (signal.aborted) return abort();
        if (this.active >= this.limit()) return;
        this.waiting = this.waiting.filter((entry) => entry !== attempt);
        signal.removeEventListener("abort", abort);
        this.active++;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          this.active--;
          this.drain();
        });
      };
      this.waiting.push(attempt);
      signal.addEventListener("abort", abort, { once: true });
      this.drain();
    });
  }
  private drain() {
    for (const attempt of [...this.waiting]) {
      if (this.active >= this.limit()) break;
      attempt();
    }
  }
}
