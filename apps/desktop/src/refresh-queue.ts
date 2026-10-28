export function createRefreshQueue(
  run: (force: boolean) => Promise<void>,
  interval = 500,
) {
  let pending = false;
  let forced = false;
  let running = false;
  let disposed = false;
  let lastStarted = -Infinity;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let waiters: { resolve: () => void; reject: (error: unknown) => void }[] = [];

  function schedule(immediate = false) {
    if (disposed || running || timer !== undefined || !pending) return;
    const delay = immediate ? 0 : Math.max(0, interval - (Date.now() - lastStarted));
    if (delay) timer = setTimeout(() => { timer = undefined; void start(); }, delay);
    else void start();
  }

  async function start() {
    if (disposed || running || !pending) return;
    const force = forced;
    const currentWaiters = waiters;
    pending = false; forced = false; waiters = [];
    running = true; lastStarted = Date.now();
    try {
      await run(force);
      for (const waiter of currentWaiters) waiter.resolve();
    } catch (error) {
      for (const waiter of currentWaiters) waiter.reject(error);
    } finally {
      running = false;
      schedule();
    }
  }

  return {
    notify(force = false) {
      if (disposed) return;
      pending = true; forced ||= force;
      schedule();
    },
    request() {
      if (disposed) return Promise.resolve();
      pending = true; forced = true;
      const result = new Promise<void>((resolve, reject) => waiters.push({ resolve, reject }));
      if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
      schedule(true);
      return result;
    },
    dispose() {
      disposed = true; pending = false;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      for (const waiter of waiters) waiter.resolve();
      waiters = [];
    },
  };
}
