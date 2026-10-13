export interface StreakActivityEligibility {
  profileUid: string | null | undefined;
  authenticatedUid: string | null | undefined;
  isAuthReady: boolean;
  isOnline: boolean;
  isVisible: boolean;
}

export function canAttemptStreakActivity(input: StreakActivityEligibility): boolean {
  return Boolean(
    input.isAuthReady
    && input.isOnline
    && input.isVisible
    && input.profileUid
    && input.authenticatedUid
    && input.profileUid === input.authenticatedUid,
  );
}

export interface SingleFlight {
  run<T>(task: () => Promise<T>): Promise<T>;
  isRunning(): boolean;
}

export function createSingleFlight(): SingleFlight {
  let activeRequest: Promise<unknown> | null = null;

  return {
    run<T>(task: () => Promise<T>): Promise<T> {
      if (activeRequest) return activeRequest as Promise<T>;

      const request = task();
      activeRequest = request;
      const clear = () => {
        if (activeRequest === request) activeRequest = null;
      };
      request.then(clear, clear);
      return request;
    },
    isRunning(): boolean {
      return activeRequest !== null;
    },
  };
}
