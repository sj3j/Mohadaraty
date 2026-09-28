/**
 * Unified telemetry helper for boot and auth lifecycle stages.
 * 
 * Emits a standard User Timing mark (for DevTools / Profiler) AND logs
 * directly to console.info so the timing is immediately visible in mobile
 * debug overlays (vConsole) on physical devices.
 */
export function logPerfMark(name: string): void {
  try {
    if (typeof performance !== 'undefined') {
      if (typeof performance.mark === 'function') {
        performance.mark(name);
      }
      const now = typeof performance.now === 'function' ? performance.now().toFixed(1) : '0';
      console.info(`[PERF] ${name} @${now}ms`);
    } else {
      console.info(`[PERF] ${name} @${Date.now()}ms`);
    }
  } catch {
    // Non-critical telemetry, ignore in restricted contexts
  }
}
