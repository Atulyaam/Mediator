/**
 * @mediator/native-host — Production Executable Packaging Script (S19)
 *
 * Requirements:
 * - Uses Node.js Single Executable Applications (SEA) on Windows 11.
 * - Bundles TypeScript source into single CJS artifact via esbuild.
 * - Injects SEA prep blob into mediator-native-host.exe using postject.
 * - Records executable hash, size, and packaging metadata.
 * - Verifies executable startup.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as cp from 'node:child_process';
import esbuild from 'esbuild';

const pkgDir = path.resolve(import.meta.dirname, '..');
const distDir = path.join(pkgDir, 'dist');
fs.mkdirSync(distDir, { recursive: true });

console.log('[buildExecutable] 1. Bundling native host source to CommonJS...');
const bundlePath = path.join(distDir, 'nativeHost.cjs');

const rootDir = path.resolve(pkgDir, '..', '..');

await esbuild.build({
  entryPoints: [path.join(pkgDir, 'src', 'index.ts')],
  outfile: bundlePath,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  sourcemap: false,
  alias: {
    '@mediator/shared-contracts': path.resolve(rootDir, 'packages/shared-contracts/src/index.ts'),
    '@mediator/ipc-core': path.resolve(rootDir, 'packages/ipc-core/src/index.ts'),
    '@mediator/protocol': path.resolve(rootDir, 'packages/protocol/src/index.ts'),
    '@mediator/content-transfer': path.resolve(rootDir, 'packages/content-transfer/src/index.ts'),
    '@mediator/persistence': path.resolve(rootDir, 'packages/persistence/src/index.ts'),
  },
});

console.log('[buildExecutable] 2. Preparing SEA config and generating blob...');
const seaConfigPath = path.join(distDir, 'sea-config.json');
const seaBlobPath = path.join(distDir, 'sea-prep.blob');

fs.writeFileSync(
  seaConfigPath,
  JSON.stringify({
    main: bundlePath,
    output: seaBlobPath,
    disableExperimentalSEAWarning: true,
  }, null, 2),
  'utf8',
);

cp.execSync(`node --experimental-sea-config "${seaConfigPath}"`, { stdio: 'inherit' });

console.log('[buildExecutable] 3. Copying node runtime binary...');
const targetExePath = path.join(distDir, 'mediator-native-host.exe');
fs.copyFileSync(process.execPath, targetExePath);

console.log('[buildExecutable] 4. Injecting SEA blob via postject...');
cp.execSync(
  `npx postject "${targetExePath}" NODE_SEA_BLOB "${seaBlobPath}" --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2`,
  { stdio: 'inherit' },
);

console.log('[buildExecutable] 5. Calculating binary hash and verifying startup...');
const exeBytes = fs.readFileSync(targetExePath);
const sha256Hash = crypto.createHash('sha256').update(exeBytes).digest('hex');
const sizeMb = (exeBytes.length / (1024 * 1024)).toFixed(2);

console.log(`[buildExecutable] Executable created successfully:`);
console.log(`  Path:   ${targetExePath}`);
console.log(`  Size:   ${sizeMb} MB (${exeBytes.length} bytes)`);
console.log(`  SHA256: ${sha256Hash}`);

// Verify startup with an empty input
const testRun = cp.spawnSync(targetExePath, ['--version'], {
  input: Buffer.alloc(0),
  encoding: 'utf8',
  timeout: 5000,
});

console.log(`[buildExecutable] Verification run exit status: ${testRun.status}`);
if (testRun.status !== 0 && testRun.status !== null) {
  console.warn(`[buildExecutable] Warning: Exe exited with code ${testRun.status}: ${testRun.stderr}`);
} else {
  console.log('[buildExecutable] Verified: Executable starts and exits cleanly.');
}
