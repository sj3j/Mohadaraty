import assert from 'node:assert/strict';
import fs from 'node:fs';

const iosProject = fs.readFileSync('ios/App/App.xcodeproj/project.pbxproj', 'utf8');
const codemagic = fs.readFileSync('codemagic.yaml', 'utf8');
const macProject = fs.readFileSync('macos/MohadaratyMac.xcodeproj/project.pbxproj', 'utf8');

assert.match(iosProject, /TARGETED_DEVICE_FAMILY = "1,2";/);
assert.match(iosProject, /SDKROOT = iphoneos;/);
for (const workflow of ['ios-mac-qa:', 'ios-preview:', 'ios-release:']) {
  assert.ok(codemagic.includes(workflow), `existing workflow missing: ${workflow}`);
}
assert.match(codemagic, /macos-qa:/);
assert.match(macProject, /productType = "com\.apple\.product-type\.application";/);
assert.match(macProject, /MACOSX_DEPLOYMENT_TARGET = 13\.0;/);
assert.ok(!iosProject.includes('MohadaratyMac'), 'Mac target leaked into iOS project');
console.log('macOS/iOS isolation audit passed.');

