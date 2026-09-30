/**
 * Test harness for PDF gestures:
 * 1. Simulates pointer sequence and verifies if lostpointercapture / pointercancel aborts gesture (Legacy)
 * 2. Simulates unified non-capturing multi-touch tracking (Fixed)
 * 3. Tests focal-point pinch zoom math and translation bounds
 * 4. Tests double-tap detection and zoom toggling
 * 5. Tests 1-finger pan calculation when zoomed in
 *
 * Run with: npx tsx scripts/pdfGesture.test.ts
 */

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    console.log(`  PASS  ${name}`);
    passed++;
  } else {
    console.log(`  FAIL  ${name}${detail ? ' -> ' + detail : ''}`);
    failed++;
  }
}

console.log('--- PDF Mobile Gestures Test Suite ---');

// Test 1: Simulating the legacy gesture lifecycle with lostpointercapture
{
  console.log('\nTest Set 1: Legacy Pointer Capture Abortion Reproduction');
  let gestureAbortCount = 0;
  let commitCount = 0;

  const pointers = new Map<number, { x: number; y: number }>();
  let gestureState: { idA: number; idB: number; s: number } | null = null;

  function onPointerDown(e: { pointerId: number; clientX: number; clientY: number }) {
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2 && !gestureState) {
      const [idA, idB] = [...pointers.keys()];
      gestureState = { idA, idB, s: 1 };
      // In legacy code: setPointerCapture(idB) revoked idA!
      simulateLostPointerCapture(idA);
    }
  }

  function simulateLostPointerCapture(pointerId: number) {
    endPointer(pointerId);
  }

  function endPointer(pointerId: number) {
    pointers.delete(pointerId);
    if (!gestureState) return;
    if (pointerId !== gestureState.idA && pointerId !== gestureState.idB) return;
    gestureState = null;
    gestureAbortCount++;
    commitCount++;
  }

  onPointerDown({ pointerId: 1, clientX: 100, clientY: 100 });
  onPointerDown({ pointerId: 2, clientX: 200, clientY: 200 });

  check('Legacy: Gesture was aborted on lostpointercapture before move', gestureState === null);
  check('Legacy: Gesture abort count is 1', gestureAbortCount === 1);
  check('Legacy: Commit happened prematurely like a button click', commitCount === 1);
}

// Test 2: Fixed unified pointer tracking without pointer capture
{
  console.log('\nTest Set 2: Fixed Unified Multi-Pointer Tracking');
  const pointers = new Map<number, { x: number; y: number }>();
  let gestureState: { idA: number; idB: number; sBase: number; startDist: number } | null = null;
  let moveCount = 0;
  let finished = false;

  function onPointerDownFixed(e: { pointerId: number; clientX: number; clientY: number }) {
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2 && !gestureState) {
      const [idA, idB] = [...pointers.keys()];
      const a = pointers.get(idA)!;
      const b = pointers.get(idB)!;
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      gestureState = { idA, idB, sBase: 1.0, startDist: dist };
      // No setPointerCapture called -> no lostpointercapture!
    }
  }

  function onPointerMoveFixed(e: { pointerId: number; clientX: number; clientY: number }) {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (gestureState) {
      moveCount++;
    }
  }

  function onPointerUpFixed(e: { pointerId: number }) {
    pointers.delete(e.pointerId);
    if (gestureState && (e.pointerId === gestureState.idA || e.pointerId === gestureState.idB)) {
      gestureState = null;
      finished = true;
    }
  }

  onPointerDownFixed({ pointerId: 1, clientX: 100, clientY: 100 });
  onPointerDownFixed({ pointerId: 2, clientX: 200, clientY: 200 });
  check('Gesture active after two fingers placed', gestureState !== null);

  // User pinches out
  onPointerMoveFixed({ pointerId: 1, clientX: 80, clientY: 80 });
  onPointerMoveFixed({ pointerId: 2, clientX: 220, clientY: 220 });
  check('Move events tracked during multi-touch pinch', moveCount === 2);

  // Release finger
  onPointerUpFixed({ pointerId: 1 });
  check('Gesture cleanly finished on finger release', finished && gestureState === null);
}

// Test 3: Focal point zoom & translation calculation
{
  console.log('\nTest Set 3: Focal-Point Zoom Geometry');
  const MIN_SCALE = 0.5;
  const MAX_SCALE = 3.5;

  function calculateZoom(sBase: number, startDist: number, currentDist: number) {
    const raw = sBase * (currentDist / startDist);
    return Math.min(MAX_SCALE, Math.max(MIN_SCALE, raw));
  }

  const s0 = 1.0;
  const startDist = 100;
  const zoomInDist = 150;
  const sZoomIn = calculateZoom(s0, startDist, zoomInDist);
  check('Zoom in scales proportionally to finger distance', Math.abs(sZoomIn - 1.5) < 0.001);

  const zoomOutDist = 70;
  const sZoomOut = calculateZoom(s0, startDist, zoomOutDist);
  check('Zoom out scales down proportionally', Math.abs(sZoomOut - 0.7) < 0.001);

  // Focal point math
  const a = { x: 100, y: 150 };
  const b = { x: 300, y: 350 };
  const focal = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  check('Focal point calculates exact midpoint', focal.x === 200 && focal.y === 250);
}

// Test 4: Double-tap detection
{
  console.log('\nTest Set 4: Double-Tap Zoom Logic');
  let lastTapTime = 0;
  let lastTapPos = { x: 0, y: 0 };
  let zoomState = 1.0;

  function handleTap(time: number, x: number, y: number, fitScale: number): { isDoubleTap: boolean; targetScale: number } {
    const dt = time - lastTapTime;
    const dist = Math.hypot(x - lastTapPos.x, y - lastTapPos.y);
    lastTapTime = time;
    lastTapPos = { x, y };

    if (dt < 300 && dist < 30) {
      // Toggle between fitScale and 2.2x
      const newScale = zoomState > fitScale + 0.1 ? fitScale : 2.2;
      zoomState = newScale;
      lastTapTime = 0; // reset
      return { isDoubleTap: true, targetScale: newScale };
    }
    return { isDoubleTap: false, targetScale: zoomState };
  }

  const tap1 = handleTap(1000, 150, 200, 1.0);
  check('Single tap does not trigger double-tap zoom', !tap1.isDoubleTap && tap1.targetScale === 1.0);

  const tap2 = handleTap(1180, 152, 202, 1.0);
  check('Second rapid tap triggers double-tap zoom to 2.2x', tap2.isDoubleTap && Math.abs(tap2.targetScale - 2.2) < 0.01);

  const tap3 = handleTap(2000, 155, 200, 1.0);
  check('First tap of second pair does not zoom', !tap3.isDoubleTap && Math.abs(tap3.targetScale - 2.2) < 0.01);

  const tap4 = handleTap(2150, 155, 200, 1.0);
  check('Second tap of second pair toggles back to fitScale 1.0x', tap4.isDoubleTap && Math.abs(tap4.targetScale - 1.0) < 0.01);
}

// Test 5: 1-Finger Pan when Zoomed
{
  console.log('\nTest Set 5: 1-Finger Pan Math');
  const fitScale = 1.0;
  const currentScale = 2.2;
  const isZoomed = currentScale > fitScale + 0.05;

  check('Detects zoomed state for 1-finger panning', isZoomed === true);

  const startTouch = { x: 200, y: 300, scrollLeft: 50, scrollTop: 100 };
  const moveTouch = { x: 180, y: 260 }; // Moved -20px X, -40px Y

  const deltaX = moveTouch.x - startTouch.x;
  const deltaY = moveTouch.y - startTouch.y;

  // Content dragged left/up means scroll increases
  const targetScrollLeft = Math.max(0, startTouch.scrollLeft - deltaX);
  const targetScrollTop = Math.max(0, startTouch.scrollTop - deltaY);

  check('Pan horizontally scrolls correctly', targetScrollLeft === 70);
  check('Pan vertically scrolls correctly', targetScrollTop === 140);
}

console.log(`\nSummary: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
