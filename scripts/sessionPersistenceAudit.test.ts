import assert from 'node:assert/strict';
import {
  resolveAuthState,
  resolveUserDocument,
  resolveWhitelistVerification,
} from '../src/lib/sessionRestoration';

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    console.log(`  PASS  ${name}`);
    passed++;
  } else {
    console.error(`  FAIL  ${name}${detail ? ' -> ' + detail : ''}`);
    failed++;
  }
}

console.log('\n--- Session Persistence Audit: Whitelist & Account Scenarios ---');

// Scenario 1: Whitelist verification when student record is missing by email
// (e.g. Google-linked student where students doc is 's12345' and googleEmail is 'test@gmail.com')
{
  const decision = resolveWhitelistVerification({
    outcome: 'missing',
    isOnline: true,
    isTransientError: false,
    confirmedByServer: true,
  });
  check(
    'Server-confirmed missing whitelist account causes shouldSignOut: true (Kills session)',
    decision.shouldSignOut === true && decision.status === 'rejected-account',
    `got shouldSignOut: ${decision.shouldSignOut}`
  );
}

// Scenario 2: What resolveAuthState does on online launch if firebaseUser is missing but wasSignedIn && cachedProfileAvailable
{
  const decision = resolveAuthState({
    firebaseUserPresent: false,
    isOnline: true,
    wasSignedIn: true,
    cachedProfileAvailable: true,
  });
  check(
    'resolveAuthState preserves cached session when online and wasSignedIn=true',
    decision.useCachedProfile === true && decision.shouldSignOut === false,
    `status: ${decision.status}`
  );
}

// Scenario 3: What resolveAuthState does if wasSignedIn=true but cached profile is missing
{
  const decision = resolveAuthState({
    firebaseUserPresent: false,
    isOnline: true,
    wasSignedIn: true,
    cachedProfileAvailable: false,
  });
  check(
    'Missing cached profile causes clearPersistence: true (Forces login screen)',
    decision.clearPersistence === true && decision.showLogin === true,
    `status: ${decision.status}`
  );
}

// Scenario 4: User document resolution for roster user vs regular UID
{
  const rosterDecision = resolveUserDocument({
    exists: false,
    fromCache: false,
    isOnline: true,
    rosterUser: true, // uid includes '@'
    cachedProfileAvailable: true,
  });
  check(
    'Roster user (uid has @) preserves session even if userDoc missing on server',
    rosterDecision.shouldSignOut === false,
    `status: ${rosterDecision.status}`
  );

  const nonRosterPreserved = resolveUserDocument({
    exists: false,
    fromCache: false,
    isOnline: true,
    rosterUser: false, // standard Firebase UID
    cachedProfileAvailable: true,
  });
  check(
    'Non-roster user (Google/Firebase UID) preserves session when cached profile is available',
    nonRosterPreserved.shouldSignOut === false && nonRosterPreserved.status === 'cached-offline',
    `status: ${nonRosterPreserved.status}`
  );

  const nonRosterRejected = resolveUserDocument({
    exists: false,
    fromCache: false,
    isOnline: true,
    rosterUser: false,
    cachedProfileAvailable: false,
  });
  check(
    'Non-roster user with missing userDoc and no cached profile is rejected',
    nonRosterRejected.shouldSignOut === true && nonRosterRejected.status === 'rejected-account',
    `status: ${nonRosterRejected.status}`
  );
}

console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
