import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const PAGE_SIZE_16K = 16384n;

/**
 * Parses the ELF program headers of a binary to verify 16 KB page alignment
 * for PT_LOAD segments.
 */
export function checkElfAlignment(filePath) {
  const buf = readFileSync(filePath);
  if (buf.length < 0x40 || buf.readUInt32BE(0) !== 0x7f454c46) {
    return { error: 'Not a valid ELF binary' };
  }

  const is64 = buf[4] === 2;
  const isLE = buf[5] === 1;

  if (!isLE) {
    return { error: 'Big-endian ELF binaries are unsupported' };
  }

  if (!is64) {
    // 32-bit binaries (armeabi-v7a, x86) are not required to be 16 KB aligned by Android
    return { is64: false, compliant: true, segments: [] };
  }

  const phoff = Number(buf.readBigUInt64LE(0x20));
  const phentsize = buf.readUInt16LE(0x36);
  const phnum = buf.readUInt16LE(0x38);

  const segments = [];
  let compliant = true;

  for (let i = 0; i < phnum; i++) {
    const off = phoff + i * phentsize;
    if (off + phentsize > buf.length) {
      return { error: 'Corrupt ELF program header table' };
    }

    const p_type = buf.readUInt32LE(off);
    if (p_type === 1) { // PT_LOAD segment
      const p_offset = buf.readBigUInt64LE(off + 0x08);
      const p_vaddr = buf.readBigUInt64LE(off + 0x10);
      const p_align = buf.readBigUInt64LE(off + 0x30);

      const isAligned = p_align >= PAGE_SIZE_16K;
      const offsetsConsistent = (p_vaddr % p_align) === (p_offset % p_align);

      if (!isAligned || !offsetsConsistent) {
        compliant = false;
      }

      segments.push({
        p_align: Number(p_align),
        p_align_hex: '0x' + p_align.toString(16),
        isAligned,
        offsetsConsistent,
      });
    }
  }

  return { is64: true, compliant, segments };
}

function findSoFiles(dir) {
  const results = [];
  if (!existsSync(dir)) return results;

  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      results.push(...findSoFiles(full));
    } else if (entry.endsWith('.so')) {
      results.push(full);
    }
  }
  return results;
}

export function verifyAllNativeLibraries(searchDirs) {
  const root = process.cwd();
  const dirs = Array.isArray(searchDirs) ? searchDirs : [searchDirs];
  const targetDirs = dirs.map(d => (d.startsWith(root) ? d : join(root, d)));

  let foundSoFiles = [];
  for (const dir of targetDirs) {
    if (existsSync(dir)) {
      foundSoFiles = findSoFiles(dir);
      if (foundSoFiles.length > 0) break;
    }
  }

  if (foundSoFiles.length === 0) {
    throw new Error(
      `16 KB verification: No native libraries (.so) found in candidate directories:\n  ${targetDirs.join('\n  ')}\nBuild the release APK or AAB first.`
    );
  }

  const failures = [];
  let checked64Bit = 0;

  for (const soPath of foundSoFiles) {
    const rel = relative(root, soPath).replace(/\\/g, '/');
    const is64BitAbi = rel.includes('arm64-v8a') || rel.includes('x86_64');

    const result = checkElfAlignment(soPath);
    if (result.error) {
      failures.push({ path: rel, reason: result.error });
      continue;
    }

    if (result.is64) {
      checked64Bit++;
      if (!result.compliant) {
        failures.push({
          path: rel,
          reason: 'LOAD segment alignment < 16384 (16 KB) or inconsistent offsets',
          segments: result.segments,
        });
      }
    } else if (is64BitAbi) {
      failures.push({
        path: rel,
        reason: 'Binary located in 64-bit ABI directory but is 32-bit ELF',
      });
    }
  }

  if (failures.length > 0) {
    console.error('\n❌ 16 KB Page Size Verification FAILED for the following libraries:');
    for (const fail of failures) {
      console.error(`  - ${fail.path}: ${fail.reason}`);
      if (fail.segments) {
        console.error('    Segments:', JSON.stringify(fail.segments));
      }
    }
    throw new Error(`16 KB page size verification failed: ${failures.length} native library(ies) non-compliant.`);
  }

  console.log(`verify-16kb-alignment: ${checked64Bit} 64-bit native libraries inspected and verified for 16 KB page size compliance.`);
  return { checked64Bit, total: foundSoFiles.length };
}

// Direct execution from CLI
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));
if (isMain || process.argv[1]?.endsWith('verify16KbPageAlignment.mjs')) {
  const candidateDirs = [
    'android/app/build/intermediates/merged_native_libs/release/mergeReleaseNativeLibs/out/lib',
    'android/app/build/intermediates/stripped_native_libs/release/stripReleaseDebugSymbols/out/lib',
  ];
  try {
    verifyAllNativeLibraries(candidateDirs);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
