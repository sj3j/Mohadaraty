/**
 * Automated Verification for iOS Publishing Readiness
 *
 * Checks:
 * 1. PrivacyInfo.xcprivacy is registered in project.pbxproj (BuildFile, FileReference, Resources phase).
 * 2. Info.plist contains required Camera & Photo Library usage descriptions.
 * 3. AppDelegate.swift forwards APNs remote notification callbacks to Capacitor.
 * 4. LoginScreen.tsx guards Google Sign-In with !IS_IOS_BUILD for Apple Guideline 4.8 compliance.
 */
import fs from 'fs';

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

console.log('\n--- iOS Publishing Readiness Automated Audit ---\n');

// 1. project.pbxproj checks
const pbxproj = fs.readFileSync('ios/App/App.xcodeproj/project.pbxproj', 'utf8');
check(
  'project.pbxproj references PrivacyInfo.xcprivacy in PBXFileReference',
  pbxproj.includes('/* PrivacyInfo.xcprivacy */ = {isa = PBXFileReference;'),
);
check(
  'project.pbxproj references PrivacyInfo.xcprivacy in PBXBuildFile',
  pbxproj.includes('/* PrivacyInfo.xcprivacy in Resources */ = {isa = PBXBuildFile;'),
);
check(
  'project.pbxproj includes PrivacyInfo.xcprivacy in Resources build phase',
  pbxproj.includes('/* PrivacyInfo.xcprivacy in Resources */,') &&
    pbxproj.includes('/* Resources */ = {') &&
    pbxproj.includes('isa = PBXResourcesBuildPhase;'),
);

// 2. Info.plist checks
const infoPlist = fs.readFileSync('ios/App/App/Info.plist', 'utf8');
check(
  'Info.plist declares NSCameraUsageDescription',
  infoPlist.includes('<key>NSCameraUsageDescription</key>'),
);
check(
  'Info.plist declares NSPhotoLibraryUsageDescription',
  infoPlist.includes('<key>NSPhotoLibraryUsageDescription</key>'),
);
check(
  'Info.plist declares NSPhotoLibraryAddUsageDescription',
  infoPlist.includes('<key>NSPhotoLibraryAddUsageDescription</key>'),
);
check(
  'Info.plist declares ITSAppUsesNonExemptEncryption is false',
  infoPlist.includes('<key>ITSAppUsesNonExemptEncryption</key>') &&
    infoPlist.includes('<false/>'),
);

// 3. AppDelegate.swift APNs delegates
const appDelegate = fs.readFileSync('ios/App/App/AppDelegate.swift', 'utf8');
check(
  'AppDelegate.swift handles didRegisterForRemoteNotificationsWithDeviceToken',
  appDelegate.includes('didRegisterForRemoteNotificationsWithDeviceToken') &&
    appDelegate.includes('capacitorDidRegisterForRemoteNotifications'),
);
check(
  'AppDelegate.swift handles didFailToRegisterForRemoteNotificationsWithError',
  appDelegate.includes('didFailToRegisterForRemoteNotificationsWithError') &&
    appDelegate.includes('capacitorDidFailToRegisterForRemoteNotifications'),
);

// 4. LoginScreen.tsx Guideline 4.8 compliance
const loginSrc = fs.readFileSync('src/components/LoginScreen.tsx', 'utf8');
check(
  'LoginScreen.tsx imports IS_IOS_BUILD',
  loginSrc.includes('import { IS_IOS_BUILD } from') || loginSrc.includes('IS_IOS_BUILD'),
);
check(
  'LoginScreen.tsx conditionally hides Google Sign-In with !IS_IOS_BUILD',
  loginSrc.includes('!IS_IOS_BUILD &&'),
);

console.log(`\nAudit Results: ${passed} passed, ${failed} failed.\n`);
if (failed > 0) {
  process.exit(1);
}
