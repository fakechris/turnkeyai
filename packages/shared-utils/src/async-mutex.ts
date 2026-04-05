export class KeyedAsyncMutex<K = string> {
  private readonly queues = new Map<K, Promise<void>>();

  async run<T>(key: K, work: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    let releaseCurrent: (() => void) | undefined;
    const current = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    const tail = previous.then(() => current);
    this.queues.set(key, tail);
    await previous;

    try {
      return await work();
    } finally {
      releaseCurrent?.();
      if (this.queues.get(key) === tail) {
        this.queues.delete(key);
      }
    }
  }
}

export class AsyncMutex {
  private readonly keyed = new KeyedAsyncMutex<string>();

  async run<T>(work: () => Promise<T>): Promise<T> {
    return this.keyed.run("__default__", work);
  }
}
