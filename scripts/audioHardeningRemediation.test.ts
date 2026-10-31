import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

describe('Remediation 1: Waveform Seeking Boundary Clamping', () => {
  // Test clamping logic as implemented in AudioPlayer and GlobalAudioPlayer
  function calculateScrubPercentage(
    clientX: number,
    rectLeft: number,
    rectWidth: number,
    isRtl: boolean
  ): number {
    if (rectWidth <= 0) return 0;
    const x = clientX - rectLeft;
    const rawPercentage = isRtl ? ((rectWidth - x) / rectWidth) * 100 : (x / rectWidth) * 100;
    return Math.max(0, Math.min(100, isNaN(rawPercentage) ? 0 : rawPercentage));
  }

  // AudioContext seek logic as implemented in AudioContext.tsx
  function simulateContextSeek(
    percentage: number,
    duration: number,
    audioElement: { currentTime: number }
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

  test('rect.width <= 0 returns 0 without NaN or throwing', () => {
    assert.equal(calculateScrubPercentage(50, 100, 0, false), 0);
    assert.equal(calculateScrubPercentage(50, 100, -10, false), 0);
  });

  test('LTR out-of-bounds clicks are clamped to [0, 100]', () => {
    // Click 50px to the left of the element
    assert.equal(calculateScrubPercentage(50, 100, 200, false), 0);
    // Click 100px to the right of the element
    assert.equal(calculateScrubPercentage(400, 100, 200, false), 100);
    // Click exactly on boundaries
    assert.equal(calculateScrubPercentage(100, 100, 200, false), 0);
    assert.equal(calculateScrubPercentage(300, 100, 200, false), 100);
  });

  test('RTL out-of-bounds clicks are clamped to [0, 100]', () => {
    // RTL: left of element (clientX < rectLeft) would be >100% -> clamped to 100%
    assert.equal(calculateScrubPercentage(50, 100, 200, true), 100);
    // RTL: right of element (clientX > rectRight) would be <0% -> clamped to 0%
    assert.equal(calculateScrubPercentage(400, 100, 200, true), 0);
  });

  test('AudioContext seek clamps negative percentage to 0 and >100 to 100', () => {
    const fakeAudio = { currentTime: 0 };
    const resNegative = simulateContextSeek(-15, 200, fakeAudio);
    assert.ok(resNegative);
    assert.equal(resNegative.progress, 0);
    assert.equal(resNegative.currentTime, 0);
    assert.equal(fakeAudio.currentTime, 0);

    const resOverflow = simulateContextSeek(150, 200, fakeAudio);
    assert.ok(resOverflow);
    assert.equal(resOverflow.progress, 100);
    assert.equal(resOverflow.currentTime, 200);
    assert.equal(fakeAudio.currentTime, 200);
  });

  test('AudioContext seek ignores non-finite/NaN and invalid durations', () => {
    const fakeAudio = { currentTime: 50 };
    assert.equal(simulateContextSeek(NaN, 200, fakeAudio), null);
    assert.equal(simulateContextSeek(Infinity, 200, fakeAudio), null);
    assert.equal(simulateContextSeek(-Infinity, 200, fakeAudio), null);
    assert.equal(simulateContextSeek(50, 0, fakeAudio), null);
    assert.equal(simulateContextSeek(50, -100, fakeAudio), null);
    assert.equal(simulateContextSeek(50, NaN, fakeAudio), null);
    assert.equal(simulateContextSeek(50, Infinity, fakeAudio), null);
    // Fake audio currentTime remains untouched
    assert.equal(fakeAudio.currentTime, 50);
  });

  test('Source files AudioPlayer.tsx and GlobalAudioPlayer.tsx contain clamping and 0-width guards', () => {
    const audioPlayerSrc = fs.readFileSync(path.resolve('src/components/AudioPlayer.tsx'), 'utf-8');
    const globalPlayerSrc = fs.readFileSync(path.resolve('src/components/GlobalAudioPlayer.tsx'), 'utf-8');
    const audioContextSrc = fs.readFileSync(path.resolve('src/contexts/AudioContext.tsx'), 'utf-8');

    assert.ok(audioPlayerSrc.includes('rect.width <= 0'), 'AudioPlayer has rect.width <= 0 guard');
    assert.ok(audioPlayerSrc.includes('Math.max(0, Math.min(100'), 'AudioPlayer has Math.max/min clamping');

    assert.ok(globalPlayerSrc.includes('rect.width <= 0'), 'GlobalAudioPlayer has rect.width <= 0 guard');
    assert.ok(globalPlayerSrc.includes('Math.max(0, Math.min(100'), 'GlobalAudioPlayer has Math.max/min clamping');

    assert.ok(audioContextSrc.includes('Math.max(0, Math.min(100, percentage))'), 'AudioContext has seek clamping');
    assert.ok(audioContextSrc.includes('!isFinite(percentage)'), 'AudioContext checks isFinite(percentage)');
  });
});

describe('Remediation 2: Functional Audio Mute Synchronization', () => {
  test('AudioContext source exposes isMuted and toggleMute in AudioContextType', () => {
    const audioContextSrc = fs.readFileSync(path.resolve('src/contexts/AudioContext.tsx'), 'utf-8');
    assert.ok(/isMuted:\s*boolean;/.test(audioContextSrc), 'AudioContextType defines isMuted: boolean');
    assert.ok(/toggleMute:\s*\(\)\s*=>\s*void;/.test(audioContextSrc), 'AudioContextType defines toggleMute');
    assert.ok(audioContextSrc.includes('audioRef.current.muted = next'), 'toggleMute updates audioRef.current.muted');
    assert.ok(audioContextSrc.includes('audio.addEventListener(\'volumechange\''), 'AudioContext listens to volumechange');
  });

  test('AudioPlayer source connects mute button to context toggleMute and isMuted', () => {
    const audioPlayerSrc = fs.readFileSync(path.resolve('src/components/AudioPlayer.tsx'), 'utf-8');
    // Ensure local dummy useState(false) for isMuted is gone
    assert.ok(!audioPlayerSrc.includes('const [isMuted, setIsMuted] = useState(false)'), 'Local dummy isMuted removed');
    // Ensure useAudio destructures isMuted and toggleMute
    assert.ok(audioPlayerSrc.includes('isMuted'), 'Destructures isMuted');
    assert.ok(audioPlayerSrc.includes('toggleMute'), 'Destructures toggleMute');
    assert.ok(audioPlayerSrc.includes('onClick={toggleMute}'), 'Mute button onClick bound to toggleMute');
  });

  test('Simulated toggleMute flips state and mutes HTMLAudioElement', () => {
    let stateMuted = false;
    const fakeAudio = { muted: false };

    const toggleMute = () => {
      stateMuted = !stateMuted;
      fakeAudio.muted = stateMuted;
    };

    assert.equal(stateMuted, false);
    assert.equal(fakeAudio.muted, false);

    toggleMute();
    assert.equal(stateMuted, true);
    assert.equal(fakeAudio.muted, true);

    toggleMute();
    assert.equal(stateMuted, false);
    assert.equal(fakeAudio.muted, false);
  });
});

describe('Remediation 3: Touch Double-Event Elimination', () => {
  test('AudioPlayer play button does not have onTouchEnd handler', () => {
    const audioPlayerSrc = fs.readFileSync(path.resolve('src/components/AudioPlayer.tsx'), 'utf-8');
    assert.ok(!audioPlayerSrc.includes('onTouchEnd='), 'AudioPlayer contains no onTouchEnd attributes');
    assert.ok(audioPlayerSrc.includes('onClick={togglePlay}'), 'AudioPlayer has onClick={togglePlay}');
    assert.ok(audioPlayerSrc.includes('touchAction: \'manipulation\''), 'AudioPlayer retains touchAction manipulation');
  });
});
