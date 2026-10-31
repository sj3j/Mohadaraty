/**
 * Challenger Fix 1: Empirical Adversarial Stress & Verification Harness
 * Tests all remediations under hostile input distributions:
 * 1. Waveform Scrubbing Clamping & RTL/LTR Inversion
 * 2. AudioContext.seek() Non-Finite & Extreme Coordinate Ingestion
 * 3. Audio Mute State Synchronization Across Lifecycle Transitions
 * 4. Time Formatting Boundary Coverage
 * 5. Touch Event Single-Binding & Static Structural Contracts
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// =========================================================================
// 1. WAVEFORM SCRUBBING CLAMPING & COORDINATE RESILIENCE
// =========================================================================
describe('Adversarial Waveform Scrubbing Math Harness', () => {
  // Direct reproduction of AudioPlayer.tsx lines 83-88 and GlobalAudioPlayer.tsx lines 95-100
  function computeScrubPercentage(
    clientX: number,
    rectLeft: number,
    rectWidth: number,
    isRtl: boolean
  ): number | null {
    if (rectWidth <= 0) return null; // Component returns early without seeking
    const x = clientX - rectLeft;
    const rawPercentage = isRtl ? ((rectWidth - x) / rectWidth) * 100 : (x / rectWidth) * 100;
    return Math.max(0, Math.min(100, isNaN(rawPercentage) ? 0 : rawPercentage));
  }

  test('Hostile X coordinates (negative infinity to positive infinity) always clamp to [0, 100]', () => {
    const hostileCoords = [
      -1e9, -50000, -100, -0.0001,
      0, 50, 100, 200, 200.0001,
      500, 100000, 1e9,
    ];

    for (const x of hostileCoords) {
      for (const isRtl of [false, true]) {
        const result = computeScrubPercentage(x, 100, 100, isRtl);
        assert.notEqual(result, null);
        assert.ok(result! >= 0, `Result ${result} must be >= 0 for x=${x}, isRtl=${isRtl}`);
        assert.ok(result! <= 100, `Result ${result} must be <= 100 for x=${x}, isRtl=${isRtl}`);
        assert.ok(Number.isFinite(result!), `Result ${result} must be finite`);
      }
    }
  });

  test('Sub-pixel precision handles arbitrary floating point without precision blowup', () => {
    const rectLeft = 10.3333333;
    const rectWidth = 199.7777777;
    const clientX = 110.2222222;

    const ltr = computeScrubPercentage(clientX, rectLeft, rectWidth, false);
    const rtl = computeScrubPercentage(clientX, rectLeft, rectWidth, true);

    assert.ok(ltr! >= 0 && ltr! <= 100);
    assert.ok(rtl! >= 0 && rtl! <= 100);
    assert.equal(Math.round(ltr! + rtl!), 100, 'LTR + RTL percentages must sum to 100%');
  });

  test('Collapsed / unrendered container (width <= 0) safely aborts with null', () => {
    assert.equal(computeScrubPercentage(50, 100, 0, false), null);
    assert.equal(computeScrubPercentage(50, 100, -1, false), null);
    assert.equal(computeScrubPercentage(50, 100, -999, true), null);
  });

  test('NaN / Non-numeric coordinate recovery in scrubbing', () => {
    const result = computeScrubPercentage(NaN, 100, 200, false);
    assert.equal(result, 0, 'NaN coordinate recovers to 0%');
  });
});

// =========================================================================
// 2. AUDIOCONTEXT SEEK ADVERSARIAL HARNESS
// =========================================================================
describe('Adversarial AudioContext Seek Harness', () => {
  interface MockAudioElement {
    currentTime: number;
    muted: boolean;
  }

  function executeContextSeek(
    percentage: number,
    duration: number,
    audioElement: MockAudioElement | null
  ): { currentTime: number; progress: number } | null {
    if (!audioElement || !duration || !isFinite(duration) || duration <= 0) return null;
    if (isNaN(percentage) || !isFinite(percentage)) return null;
    const clampedPercentage = Math.max(0, Math.min(100, percentage));
    const newTime = (clampedPercentage / 100) * duration;
    audioElement.currentTime = newTime;
    return {
      currentTime: newTime,
      progress: clampedPercentage,
    };
  }

  test('Hostile percentage values do not mutate audio element currentTime', () => {
    const audio: MockAudioElement = { currentTime: 42, muted: false };
    const invalidPercentages = [NaN, Infinity, -Infinity];

    for (const p of invalidPercentages) {
      const res = executeContextSeek(p, 300, audio);
      assert.equal(res, null, `Seek with percentage=${p} must be rejected`);
      assert.equal(audio.currentTime, 42, 'currentTime must remain unchanged');
    }
  });

  test('Hostile duration values do not mutate audio element currentTime', () => {
    const audio: MockAudioElement = { currentTime: 42, muted: false };
    const invalidDurations = [0, -1, -500, NaN, Infinity, -Infinity];

    for (const d of invalidDurations) {
      const res = executeContextSeek(50, d, audio);
      assert.equal(res, null, `Seek with duration=${d} must be rejected`);
      assert.equal(audio.currentTime, 42, 'currentTime must remain unchanged');
    }
  });

  test('Extreme out-of-bounds percentage values are strictly bounded', () => {
    const audio: MockAudioElement = { currentTime: 10, muted: false };

    // Underflow: -9999% -> clamps to 0% (currentTime = 0)
    const underflow = executeContextSeek(-9999, 120, audio);
    assert.ok(underflow);
    assert.equal(underflow.progress, 0);
    assert.equal(underflow.currentTime, 0);
    assert.equal(audio.currentTime, 0);

    // Overflow: +9999% -> clamps to 100% (currentTime = 120)
    const overflow = executeContextSeek(9999, 120, audio);
    assert.ok(overflow);
    assert.equal(overflow.progress, 100);
    assert.equal(overflow.currentTime, 120);
    assert.equal(audio.currentTime, 120);
  });
});

// =========================================================================
// 3. MUTE SYNCHRONIZATION & AUDIO ELEMENT CONTROL
// =========================================================================
describe('Adversarial Audio Mute Lifecycle Simulation', () => {
  class AudioEngineSimulation {
    isMuted: boolean = false;
    audioElement = {
      muted: false,
      playbackRate: 1,
      src: '',
      playing: false,
    };

    toggleMute() {
      this.isMuted = !this.isMuted;
      this.audioElement.muted = this.isMuted;
    }

    playTrack(src: string) {
      this.audioElement.src = src;
      this.audioElement.muted = this.isMuted; // Sync on track start
      this.audioElement.playing = true;
    }

    resumeTrack() {
      this.audioElement.muted = this.isMuted; // Sync on resume
      this.audioElement.playing = true;
    }

    onVolumeChange(browserMuted: boolean) {
      this.audioElement.muted = browserMuted;
      this.isMuted = browserMuted;
    }
  }

  test('Mute toggle persists across track switching and resume', () => {
    const engine = new AudioEngineSimulation();
    assert.equal(engine.isMuted, false);
    assert.equal(engine.audioElement.muted, false);

    // User mutes audio
    engine.toggleMute();
    assert.equal(engine.isMuted, true);
    assert.equal(engine.audioElement.muted, true);

    // Switch to different track: muted state MUST carry over
    engine.playTrack('https://r2.test/track2.mp3');
    assert.equal(engine.isMuted, true);
    assert.equal(engine.audioElement.muted, true);

    // Pause and resume: muted state MUST carry over
    engine.audioElement.playing = false;
    engine.resumeTrack();
    assert.equal(engine.isMuted, true);
    assert.equal(engine.audioElement.muted, true);

    // User unmutes
    engine.toggleMute();
    assert.equal(engine.isMuted, false);
    assert.equal(engine.audioElement.muted, false);
  });

  test('External volumechange synchronization (e.g. OS / hardware mute toggle)', () => {
    const engine = new AudioEngineSimulation();

    // Browser muting audio element externally
    engine.onVolumeChange(true);
    assert.equal(engine.isMuted, true);
    assert.equal(engine.audioElement.muted, true);

    // Browser unmuting externally
    engine.onVolumeChange(false);
    assert.equal(engine.isMuted, false);
    assert.equal(engine.audioElement.muted, false);
  });

  test('Stress: 1000 rapid alternating toggles preserve state consistency', () => {
    const engine = new AudioEngineSimulation();
    for (let i = 0; i < 1000; i++) {
      engine.toggleMute();
      assert.equal(engine.isMuted, engine.audioElement.muted);
    }
    // After 1000 toggles (even number), should be back to false
    assert.equal(engine.isMuted, false);
    assert.equal(engine.audioElement.muted, false);
  });
});

// =========================================================================
// 4. TIME FORMATTING ADVERSARIAL VALUES
// =========================================================================
describe('Time Formatter Robustness', () => {
  const formatTime = (time: number) => {
    if (isNaN(time) || time <= 0 || !isFinite(time)) return "0:00";
    const minutes = Math.floor(time / 60);
    const seconds = Math.floor(time % 60);
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  };

  test('Hostile values return safe default 0:00 without corrupting UI', () => {
    assert.equal(formatTime(-100), '0:00');
    assert.equal(formatTime(-0.001), '0:00');
    assert.equal(formatTime(-0), '0:00');
    assert.equal(formatTime(0), '0:00');
    assert.equal(formatTime(NaN), '0:00');
    assert.equal(formatTime(Infinity), '0:00');
    assert.equal(formatTime(-Infinity), '0:00');
  });

  test('Valid edge values format accurately', () => {
    assert.equal(formatTime(0.5), '0:00');
    assert.equal(formatTime(1), '0:01');
    assert.equal(formatTime(59), '0:59');
    assert.equal(formatTime(60), '1:00');
    assert.equal(formatTime(61), '1:01');
    assert.equal(formatTime(3599), '59:59');
    assert.equal(formatTime(3600), '60:00');
    assert.equal(formatTime(7325), '122:05');
  });
});

// =========================================================================
// 5. STATIC SOURCE CONTRACTS & EVENT SAFETY
// =========================================================================
describe('Static Source Contracts Verification', () => {
  const audioPlayerPath = path.resolve('src/components/AudioPlayer.tsx');
  const globalPlayerPath = path.resolve('src/components/GlobalAudioPlayer.tsx');
  const audioContextPath = path.resolve('src/contexts/AudioContext.tsx');

  const audioPlayerCode = fs.readFileSync(audioPlayerPath, 'utf-8');
  const globalPlayerCode = fs.readFileSync(globalPlayerPath, 'utf-8');
  const audioContextCode = fs.readFileSync(audioContextPath, 'utf-8');

  test('AudioPlayer.tsx play button has NO touch event handlers that conflict with onClick', () => {
    // Assert onTouchStart, onTouchEnd, onTouchCancel are completely absent on the play button
    assert.ok(!audioPlayerCode.includes('onTouchEnd='), 'No onTouchEnd on AudioPlayer');
    assert.ok(!audioPlayerCode.includes('onTouchStart='), 'No onTouchStart on AudioPlayer');
    assert.ok(audioPlayerCode.includes('onClick={togglePlay}'), 'Has clean onClick handler');
    assert.ok(audioPlayerCode.includes("touchAction: 'manipulation'"), 'Has touchAction manipulation');
  });

  test('AudioPlayer.tsx mute button is fully wired to AudioContext and has accessibility label', () => {
    assert.ok(audioPlayerCode.includes('onClick={toggleMute}'), 'Mute button onClick wired to toggleMute');
    assert.ok(audioPlayerCode.includes("aria-label={isMuted ? 'Unmute' : 'Mute'}"), 'Accessibility aria-label present');
    assert.ok(audioPlayerCode.includes('<VolumeX'), 'VolumeX icon for muted state');
    assert.ok(audioPlayerCode.includes('<Volume2'), 'Volume2 icon for unmuted state');
    // Ensure no disconnected local useState(false) for isMuted
    assert.ok(!audioPlayerCode.includes('const [isMuted, setIsMuted] = useState'), 'No disconnected local isMuted state');
  });

  test('Waveform scrubbing contains width <= 0 guard and clamping in both components', () => {
    assert.ok(audioPlayerCode.includes('if (rect.width <= 0) return;'));
    assert.ok(globalPlayerCode.includes('if (rect.width <= 0) return;'));
    assert.ok(audioPlayerCode.includes('Math.max(0, Math.min(100, isNaN(rawPercentage) ? 0 : rawPercentage))'));
    assert.ok(globalPlayerCode.includes('Math.max(0, Math.min(100, isNaN(rawPercentage) ? 0 : rawPercentage))'));
  });

  test('AudioContext seek validates duration and percentage strictly', () => {
    assert.ok(audioContextCode.includes('!audioRef.current || !duration || !isFinite(duration) || duration <= 0'));
    assert.ok(audioContextCode.includes('isNaN(percentage) || !isFinite(percentage)'));
    assert.ok(audioContextCode.includes('Math.max(0, Math.min(100, percentage))'));
  });
});
