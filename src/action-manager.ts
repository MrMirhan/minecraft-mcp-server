export interface ActionResult {
  success: boolean;
  message: string;
  interrupted: boolean;
  timedout: boolean;
}

export interface ActionContext {
  signal: AbortSignal;
}

export type ActionFn = (ctx: ActionContext) => Promise<string>;

export interface CurrentActionInfo {
  label: string;
  runningForMs: number;
}

const DEFAULT_ABANDON_GRACE_MS = 5000;

interface RunningAction {
  label: string;
  startedAt: number;
  controller: AbortController;
  interrupted: boolean;
  timedOut: boolean;
  done: Promise<void>;
  resolveCaller: (result: ActionResult) => void;
}

export class ActionManager {
  private current: RunningAction | null = null;

  constructor(private readonly abandonGraceMs: number = DEFAULT_ABANDON_GRACE_MS) {}

  getCurrentAction(): CurrentActionInfo | null {
    if (!this.current) {
      return null;
    }
    return { label: this.current.label, runningForMs: Date.now() - this.current.startedAt };
  }

  async interrupt(): Promise<{ label: string } | null> {
    const running = this.current;
    if (!running) {
      return null;
    }

    running.interrupted = true;
    if (!running.controller.signal.aborted) {
      running.controller.abort(new Error(`"${running.label}" was interrupted by a new action`));
    }
    await this.waitForCleanupOrAbandon(running);
    return { label: running.label };
  }

  // A stuck fn that ignores the abort signal must not wedge every later run()/interrupt()
  // forever. If cleanup doesn't finish within the grace period, abandon it: free the manager
  // and resolve its own caller now. Promise resolution is idempotent, so if the abandoned fn
  // settles later, its call to resolveCaller (in run()) is a no-op, and current is untouched
  // because the identity check below already cleared it.
  private waitForCleanupOrAbandon(running: RunningAction): Promise<void> {
    return new Promise((resolve) => {
      const graceTimer = setTimeout(() => {
        if (this.current === running) {
          this.current = null;
        }
        running.resolveCaller({
          success: false,
          message: `"${running.label}" did not respond to interruption within ${this.abandonGraceMs}ms and was abandoned`,
          interrupted: true,
          timedout: false
        });
        resolve();
      }, this.abandonGraceMs);

      running.done.then(() => {
        clearTimeout(graceTimer);
        resolve();
      });
    });
  }

  async run(label: string, timeoutMs: number | undefined, fn: ActionFn): Promise<ActionResult> {
    if (this.current) {
      await this.interrupt();
    }

    const controller = new AbortController();
    let resolveCaller!: (result: ActionResult) => void;
    const callerPromise = new Promise<ActionResult>((resolve) => {
      resolveCaller = resolve;
    });

    const entry: RunningAction = {
      label,
      startedAt: Date.now(),
      controller,
      interrupted: false,
      timedOut: false,
      done: Promise.resolve(),
      resolveCaller
    };

    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    if (timeoutMs !== undefined) {
      timeoutHandle = setTimeout(() => {
        entry.timedOut = true;
        entry.interrupted = true;
        if (!controller.signal.aborted) {
          controller.abort(new Error(`"${label}" timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);
    }

    const context: ActionContext = { signal: controller.signal };

    const settled = (async (): Promise<ActionResult> => {
      try {
        const message = await fn(context);
        return {
          success: !entry.interrupted,
          message,
          interrupted: entry.interrupted && !entry.timedOut,
          timedout: entry.timedOut
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          success: false,
          message,
          interrupted: entry.interrupted && !entry.timedOut,
          timedout: entry.timedOut
        };
      } finally {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }
        if (this.current === entry) {
          this.current = null;
        }
      }
    })();

    entry.done = settled.then(() => undefined);
    settled.then(resolveCaller);
    this.current = entry;

    return callerPromise;
  }
}

function toAbortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('Action interrupted');
}

export function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal, onAbort: () => void): Promise<T> {
  if (signal.aborted) {
    onAbort();
    return Promise.reject(toAbortError(signal));
  }

  return new Promise<T>((resolve, reject) => {
    const onSignalAbort = (): void => {
      onAbort();
      reject(toAbortError(signal));
    };

    signal.addEventListener('abort', onSignalAbort, { once: true });

    promise.then(
      (value) => {
        signal.removeEventListener('abort', onSignalAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onSignalAbort);
        reject(error);
      }
    );
  });
}
