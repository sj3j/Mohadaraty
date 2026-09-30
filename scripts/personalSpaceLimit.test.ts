import assert from 'node:assert/strict';
import { FREE_PERSONAL_SPACE_FILE_LIMIT } from '../src/lib/localDb';
import { hasSubscriptionAccess } from '../shared/subscriptionAccess';

function calculateBatchImport(
  totalUserFiles: number,
  isSubscribed: boolean,
  selectedFilesCount: number
) {
  const availableSlots = isSubscribed
    ? Infinity
    : Math.max(0, FREE_PERSONAL_SPACE_FILE_LIMIT - totalUserFiles);

  const importCount = Math.min(selectedFilesCount, availableSlots);
  const hasExceededLimit = !isSubscribed && selectedFilesCount > availableSlots;

  return {
    availableSlots,
    importCount,
    hasExceededLimit,
  };
}

function runTests() {
  console.log('--- Personal Space PDF Limit Unit Tests ---');

  // Test 1: Quota constant check
  {
    assert.equal(FREE_PERSONAL_SPACE_FILE_LIMIT, 6);
    console.log('  PASS  FREE_PERSONAL_SPACE_FILE_LIMIT is strictly 6');
  }

  // Test 2: Free user with 0 files
  {
    const res = calculateBatchImport(0, false, 3);
    assert.equal(res.availableSlots, 6);
    assert.equal(res.importCount, 3);
    assert.equal(res.hasExceededLimit, false);
    console.log('  PASS  Free user with 0 files can upload 3 files cleanly');
  }

  // Test 3: Free user with 4 files attempting to upload 4 files (exceeding limit)
  {
    const res = calculateBatchImport(4, false, 4);
    assert.equal(res.availableSlots, 2);
    assert.equal(res.importCount, 2);
    assert.equal(res.hasExceededLimit, true);
    console.log('  PASS  Free user with 4 files uploads 2 and flags quota exceeded');
  }

  // Test 4: Free user at limit (6 files)
  {
    const res = calculateBatchImport(6, false, 1);
    assert.equal(res.availableSlots, 0);
    assert.equal(res.importCount, 0);
    assert.equal(res.hasExceededLimit, true);
    console.log('  PASS  Free user with 6 files is blocked from importing');
  }

  // Test 5: Grandfathered free user with > 6 files (e.g. 9 files)
  {
    const res = calculateBatchImport(9, false, 2);
    assert.equal(res.availableSlots, 0);
    assert.equal(res.importCount, 0);
    assert.equal(res.hasExceededLimit, true);
    console.log('  PASS  Free user with 9 files (grandfathered) cannot upload more');
  }

  // Test 6: Subscribed user (unlimited uploads)
  {
    const mockSubscriber = {
      isSubscribed: true,
      subscriptionEnd: new Date(Date.now() + 86400000),
    };
    const isSub = hasSubscriptionAccess(mockSubscriber);
    assert.equal(isSub, true);

    const res = calculateBatchImport(25, isSub, 10);
    assert.equal(res.availableSlots, Infinity);
    assert.equal(res.importCount, 10);
    assert.equal(res.hasExceededLimit, false);
    console.log('  PASS  Subscribed user with 25 files can upload 10 more without limits');
  }

  // Test 7: Admin / Staff user (unlimited uploads without paid subscription)
  {
    const mockAdmin = { role: 'admin' };
    const isAdminSub = hasSubscriptionAccess(mockAdmin);
    assert.equal(isAdminSub, true);

    const res = calculateBatchImport(100, isAdminSub, 5);
    assert.equal(res.availableSlots, Infinity);
    assert.equal(res.importCount, 5);
    assert.equal(res.hasExceededLimit, false);
    console.log('  PASS  Admin user has unlimited personal space uploads');
  }

  console.log('\nAll Personal Space PDF limit tests passed!');
}

runTests();
