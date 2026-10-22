export interface StreakActivityEligibility {
  profileUid: string | null | undefined;
  authenticatedUid: string | null | undefined;
  isAuthReady: boolean;
  safeIsAuthReady?: boolean;
  isOnline: boolean;
  isVisible: boolean;
}

export function canAttemptStreakActivity(input: StreakActivityEligibility): boolean {
  const ready = input.safeIsAuthReady ?? input.isAuthReady;
  return Boolean(
    ready
    && input.isOnline
    && input.isVisible
    && input.profileUid
    && input.authenticatedUid
    && input.profileUid === input.authenticatedUid,
  );
}

export interface SingleFlight {
  run<T>(task: (signal?: AbortSignal) => Promise<T>, timeoutMs?: number): Promise<T>;
  isRunning(): boolean;
  reset(): void;
}

export function createSingleFlight(): SingleFlight {
  let activeRequest: Promise<unknown> | null = null;

  return {
    run<T>(task: (signal?: AbortSignal) => Promise<T>, timeoutMs = 12000): Promise<T> {
      if (activeRequest) return activeRequest as Promise<T>;

      const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      let timer: ReturnType<typeof setTimeout> | null = null;
      if (controller && timeoutMs > 0) {
        timer = setTimeout(() => {
          controller.abort(new Error('single_flight_timeout'));
        }, timeoutMs);
      }

      const request = task(controller?.signal);
      activeRequest = request;

      const clear = () => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        if (activeRequest === request) activeRequest = null;
      };

      request.then(clear, clear);

      // Failsafe timer: even if the task promise stalls and never settles,
      // unblock the singleFlight lock so subsequent app resumes can retry.
      if (timeoutMs > 0) {
        setTimeout(() => {
          if (activeRequest === request) activeRequest = null;
        }, timeoutMs + 1000);
      }

      return request;
    },
    isRunning(): boolean {
      return activeRequest !== null;
    },
    reset(): void {
      activeRequest = null;
    },
  };
}

