/**
 * @mediator/recipe-registry — Offline Toolchain & Dependency Bundle Service (S46)
 *
 * Requirements:
 * - Controlled preparation, integrity verification, and safe import of offline dependencies.
 * - Strict filesystem security: zero path traversal, no symlink escapes, no ADS/DOS device names.
 * - Secret sanitization: verifies zero credentials or tokens in bundle before sealing.
 * - Bounded constraints: file counts, bundle byte sizes, extraction depth.
 * - Interrupted import resistance: partial imports never become trusted.
 * - Fail-closed offline dependency checks: missing packages report clear remediation without attempting network.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import {
  ErrorCode,
  type Result,
  makeMediatorError,
  ok,
  err,
} from '@mediator/shared-contracts';
import { scanContent } from '@mediator/context-security';
import {
  type ToolchainBundleManifest,
  type ToolchainFileRecord,
  ToolchainBundleManifestSchema,
} from './toolchainManifest.js';

export interface CreateBundleOptions {
  readonly bundleId?: string | undefined;
  readonly projectType: 'node' | 'python';
  readonly toolchainVersion?: string | undefined;
  readonly maxSizeBytes?: number | undefined;
  readonly maxFileCount?: number | undefined;
  readonly metadata?: Record<string, string> | undefined;
}

export interface BundleVerificationResult {
  readonly valid: boolean;
  readonly error?: string | undefined;
  readonly fileCount: number;
  readonly totalSizeBytes: number;
  readonly rootHash: string;
}

export interface BundleImportResult {
  readonly success: boolean;
  readonly importedFileCount: number;
  readonly targetDir: string;
  readonly rootHash: string;
  readonly error?: string | undefined;
}

export interface DependencyCheckResult {
  readonly satisfied: boolean;
  readonly projectType: 'node' | 'python';
  readonly missingPackages: readonly string[];
  readonly remediation: string;
  readonly errorCode?: string | undefined;
}

const DOS_DEVICE_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

export class OfflineBundleService {
  private readonly defaultMaxSizeBytes = 100 * 1024 * 1024; // 100 MB
  private readonly defaultMaxFileCount = 5_000;
  private readonly defaultMaxDepth = 12;

  /**
   * Safely creates a validated bundle manifest from an offline package/toolchain directory.
   */
  public async createBundle(
    sourceDir: string,
    options: CreateBundleOptions,
  ): Promise<Result<ToolchainBundleManifest>> {
    await Promise.resolve();
    try {
      if (!fs.existsSync(sourceDir)) {
        return err(
          makeMediatorError(
            ErrorCode.WORKSPACE_NOT_FOUND,
            `Source directory for bundle creation does not exist: ${sourceDir}`,
          ),
        );
      }

      const maxBytes = options.maxSizeBytes ?? this.defaultMaxSizeBytes;
      const maxFiles = options.maxFileCount ?? this.defaultMaxFileCount;

      const fileRecords: ToolchainFileRecord[] = [];
      let totalSizeBytes = 0;

      // Recursive scan with boundary checks
      const scanDir = (currentDir: string, depth: number): Result<void> => {
        if (depth > this.defaultMaxDepth) {
          return err(
            makeMediatorError(
              ErrorCode.BUNDLE_PATH_TRAVERSAL,
              `Directory nesting exceeds maximum permitted depth (${this.defaultMaxDepth})`,
            ),
          );
        }

        const entries = fs.readdirSync(currentDir, { withFileTypes: true });
        for (const entry of entries) {
          const entryName = entry.name;

          // Reject reserved device names
          const baseUpper = entryName.toUpperCase().split('.')[0] ?? '';
          if (DOS_DEVICE_NAMES.has(baseUpper)) {
            return err(
              makeMediatorError(
                ErrorCode.PATH_RESERVED_DEVICE,
                `Forbidden reserved device name in bundle source: ${entryName}`,
              ),
            );
          }

          // Reject alternate data streams
          if (entryName.includes(':')) {
            return err(
              makeMediatorError(
                ErrorCode.PATH_ALTERNATE_DATA_STREAM,
                `Forbidden alternate data stream in bundle source: ${entryName}`,
              ),
            );
          }

          const fullPath = path.join(currentDir, entryName);
          const relPath = path.relative(sourceDir, fullPath).replace(/\\/g, '/');

          // Check symlink traversal
          if (entry.isSymbolicLink()) {
            const target = fs.realpathSync(fullPath);
            const relTarget = path.relative(sourceDir, target);
            if (relTarget.startsWith('..') || path.isAbsolute(relTarget)) {
              return err(
                makeMediatorError(
                  ErrorCode.BUNDLE_PATH_TRAVERSAL,
                  `Symlink escape detected in bundle source: ${relPath} -> ${target}`,
                ),
              );
            }
          }

          if (entry.isDirectory()) {
            const subRes = scanDir(fullPath, depth + 1);
            if (!subRes.ok) return subRes;
          } else if (entry.isFile()) {
            const stat = fs.statSync(fullPath);
            totalSizeBytes += stat.size;

            if (totalSizeBytes > maxBytes) {
              return err(
                makeMediatorError(
                  ErrorCode.BUNDLE_OVERSIZED,
                  `Bundle exceeds maximum size limit of ${maxBytes} bytes`,
                ),
              );
            }

            if (fileRecords.length + 1 > maxFiles) {
              return err(
                makeMediatorError(
                  ErrorCode.BUNDLE_OVERSIZED,
                  `Bundle exceeds maximum file count limit of ${maxFiles} files`,
                ),
              );
            }

            // Read content, scan for secrets, compute hash
            const content = fs.readFileSync(fullPath);
            const contentStr = content.toString('utf8');
            const secretScan = scanContent(contentStr);
            if (!secretScan.ok) {
              return err(secretScan.error);
            }
            if (secretScan.value.findings.length > 0) {
              return err(
                makeMediatorError(
                  ErrorCode.SECRET_DETECTED,
                  `Secret detected in bundle file ${relPath}: ${secretScan.value.findings[0]?.ruleId}`,
                ),
              );
            }

            const sha256 = crypto.createHash('sha256').update(content).digest('hex');
            fileRecords.push({
              relativePath: relPath,
              sizeBytes: stat.size,
              sha256,
            });
          }
        }
        return ok(undefined);
      };

      const scanResult = scanDir(sourceDir, 0);
      if (!scanResult.ok) {
        return scanResult;
      }

      // Sort files deterministically by relative path
      fileRecords.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

      // Compute root hash over all sorted records
      const hashHasher = crypto.createHash('sha256');
      for (const rec of fileRecords) {
        hashHasher.update(`${rec.relativePath}:${rec.sizeBytes}:${rec.sha256}\n`);
      }
      const rootHash = hashHasher.digest('hex');

      const manifest: ToolchainBundleManifest = {
        manifestVersion: '1.0.0',
        bundleId: options.bundleId ?? `bundle-${options.projectType}-${Date.now()}`,
        projectType: options.projectType,
        createdAt: Date.now(),
        totalSizeBytes,
        fileCount: fileRecords.length,
        rootHash,
        toolchainVersion: options.toolchainVersion,
        files: fileRecords,
        metadata: options.metadata,
      };

      // Validate manifest against Zod schema
      const parseResult = ToolchainBundleManifestSchema.safeParse(manifest);
      if (!parseResult.success) {
        return err(
          makeMediatorError(
            ErrorCode.BUNDLE_MANIFEST_INVALID,
            `Constructed manifest schema validation failed: ${parseResult.error.message}`,
          ),
        );
      }

      return ok(manifest);
    } catch (error) {
      return err(
        makeMediatorError(
          ErrorCode.INTERNAL_ERROR,
          `Failed to create offline bundle: ${String(error)}`,
        ),
      );
    }
  }

  /**
   * Verifies an offline bundle against its manifest.
   */
  public async verifyBundle(
    bundleDir: string,
    manifest: ToolchainBundleManifest,
  ): Promise<BundleVerificationResult> {
    await Promise.resolve();
    try {
      const parsed = ToolchainBundleManifestSchema.safeParse(manifest);
      if (!parsed.success) {
        return {
          valid: false,
          error: `Invalid manifest: ${parsed.error.message}`,
          fileCount: 0,
          totalSizeBytes: 0,
          rootHash: '',
        };
      }

      if (!fs.existsSync(bundleDir)) {
        return {
          valid: false,
          error: `Bundle directory does not exist: ${bundleDir}`,
          fileCount: 0,
          totalSizeBytes: 0,
          rootHash: manifest.rootHash,
        };
      }

      let totalSizeBytes = 0;
      const sortedRecords = [...manifest.files].sort((a, b) =>
        a.relativePath.localeCompare(b.relativePath),
      );
      const hashHasher = crypto.createHash('sha256');

      for (const rec of sortedRecords) {
        // Prevent path traversal
        if (rec.relativePath.includes('..') || path.isAbsolute(rec.relativePath)) {
          return {
            valid: false,
            error: `Path traversal detected in manifest: ${rec.relativePath}`,
            fileCount: 0,
            totalSizeBytes: 0,
            rootHash: manifest.rootHash,
          };
        }

        const filePath = path.join(bundleDir, rec.relativePath);
        if (!fs.existsSync(filePath)) {
          return {
            valid: false,
            error: `Missing required bundle file: ${rec.relativePath}`,
            fileCount: 0,
            totalSizeBytes: 0,
            rootHash: manifest.rootHash,
          };
        }

        const stat = fs.statSync(filePath);
        if (stat.size !== rec.sizeBytes) {
          return {
            valid: false,
            error: `Size mismatch for ${rec.relativePath}: expected ${rec.sizeBytes}, got ${stat.size}`,
            fileCount: 0,
            totalSizeBytes: 0,
            rootHash: manifest.rootHash,
          };
        }

        const content = fs.readFileSync(filePath);
        const actualSha256 = crypto.createHash('sha256').update(content).digest('hex');
        if (actualSha256 !== rec.sha256) {
          return {
            valid: false,
            error: `SHA-256 hash mismatch for ${rec.relativePath}: expected ${rec.sha256}, got ${actualSha256}`,
            fileCount: 0,
            totalSizeBytes: 0,
            rootHash: manifest.rootHash,
          };
        }

        totalSizeBytes += stat.size;
        hashHasher.update(`${rec.relativePath}:${rec.sizeBytes}:${rec.sha256}\n`);
      }

      const computedRootHash = hashHasher.digest('hex');
      if (computedRootHash !== manifest.rootHash) {
        return {
          valid: false,
          error: `Root hash mismatch: expected ${manifest.rootHash}, computed ${computedRootHash}`,
          fileCount: manifest.files.length,
          totalSizeBytes,
          rootHash: computedRootHash,
        };
      }

      return {
        valid: true,
        fileCount: manifest.files.length,
        totalSizeBytes,
        rootHash: computedRootHash,
      };
    } catch (err) {
      return {
        valid: false,
        error: `Bundle verification exception: ${String(err)}`,
        fileCount: 0,
        totalSizeBytes: 0,
        rootHash: manifest.rootHash,
      };
    }
  }

  /**
   * Safely imports a verified bundle into target directory with interrupted-import protection.
   */
  public async importBundle(
    sourceDir: string,
    targetDir: string,
    manifest: ToolchainBundleManifest,
  ): Promise<BundleImportResult> {
    const verification = await this.verifyBundle(sourceDir, manifest);
    if (!verification.valid) {
      return {
        success: false,
        importedFileCount: 0,
        targetDir,
        rootHash: manifest.rootHash,
        error: `Verification before import failed: ${verification.error}`,
      };
    }

    // Prepare temporary staging dir to ensure atomic / uncorrupted import
    const stagingDir = path.join(targetDir, `.import-staging-${Date.now()}`);
    try {
      fs.mkdirSync(stagingDir, { recursive: true });

      for (const rec of manifest.files) {
        const srcFile = path.join(sourceDir, rec.relativePath);
        const dstFile = path.join(stagingDir, rec.relativePath);
        fs.mkdirSync(path.dirname(dstFile), { recursive: true });
        fs.copyFileSync(srcFile, dstFile);
      }

      // Re-verify staging directory
      const stagingVerify = await this.verifyBundle(stagingDir, manifest);
      if (!stagingVerify.valid) {
        fs.rmSync(stagingDir, { recursive: true, force: true });
        return {
          success: false,
          importedFileCount: 0,
          targetDir,
          rootHash: manifest.rootHash,
          error: `Verification of staged import failed: ${stagingVerify.error}`,
        };
      }

      // Move files from stagingDir to targetDir
      for (const rec of manifest.files) {
        const stagedFile = path.join(stagingDir, rec.relativePath);
        const finalFile = path.join(targetDir, rec.relativePath);
        fs.mkdirSync(path.dirname(finalFile), { recursive: true });
        fs.copyFileSync(stagedFile, finalFile);
      }

      // Cleanup staging dir
      fs.rmSync(stagingDir, { recursive: true, force: true });

      return {
        success: true,
        importedFileCount: manifest.files.length,
        targetDir,
        rootHash: manifest.rootHash,
      };
    } catch (err) {
      if (fs.existsSync(stagingDir)) {
        fs.rmSync(stagingDir, { recursive: true, force: true });
      }
      return {
        success: false,
        importedFileCount: 0,
        targetDir,
        rootHash: manifest.rootHash,
        error: `Import failed: ${String(err)}`,
      };
    }
  }

  /**
   * Statically checks whether dependencies for a project are present offline.
   * If missing, fails closed with clear diagnostic instructions without attempting network access.
   */
  public async checkProjectDependencies(
    projectRoot: string,
    projectType: 'node' | 'python',
  ): Promise<DependencyCheckResult> {
    await Promise.resolve();
    if (projectType === 'node') {
      const packageJsonPath = path.join(projectRoot, 'package.json');
      const nodeModulesPath = path.join(projectRoot, 'node_modules');

      if (!fs.existsSync(packageJsonPath)) {
        return {
          satisfied: false,
          projectType: 'node',
          missingPackages: ['package.json'],
          remediation: 'Place a valid package.json in the workspace root.',
          errorCode: ErrorCode.RECIPE_DEPENDENCY_MISSING,
        };
      }

      let packageJson: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> } = {};
      try {
        packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as {
          dependencies?: Record<string, string>;
          devDependencies?: Record<string, string>;
        };
      } catch {
        return {
          satisfied: false,
          projectType: 'node',
          missingPackages: ['malformed package.json'],
          remediation: 'Ensure package.json is valid JSON.',
          errorCode: ErrorCode.RECIPE_DEPENDENCY_MISSING,
        };
      }

      const allDeps = Object.keys({
        ...(packageJson.dependencies ?? {}),
        ...(packageJson.devDependencies ?? {}),
      });

      if (allDeps.length === 0) {
        return {
          satisfied: true,
          projectType: 'node',
          missingPackages: [],
          remediation: 'No dependencies required.',
        };
      }

      if (!fs.existsSync(nodeModulesPath)) {
        return {
          satisfied: false,
          projectType: 'node',
          missingPackages: allDeps,
          remediation:
            'Project has dependencies declared in package.json but node_modules is missing. Prepare offline toolchain bundle via Mediator offlineBundleService or run offline preparation outside the execution sandbox.',
          errorCode: ErrorCode.OFFLINE_DEPENDENCY_MISSING,
        };
      }

      const missing: string[] = [];
      for (const dep of allDeps) {
        const depPath = path.join(nodeModulesPath, dep);
        if (!fs.existsSync(depPath)) {
          missing.push(dep);
        }
      }

      if (missing.length > 0) {
        return {
          satisfied: false,
          projectType: 'node',
          missingPackages: missing,
          remediation: `The following dependencies are missing from offline node_modules: ${missing.join(
            ', ',
          )}. Supply them via a verified offline bundle. Network downloads in the sandbox are strictly prohibited.`,
          errorCode: ErrorCode.OFFLINE_DEPENDENCY_MISSING,
        };
      }

      return {
        satisfied: true,
        projectType: 'node',
        missingPackages: [],
        remediation: 'All declared node dependencies are present in offline cache.',
      };
    } else if (projectType === 'python') {
      const reqPath = path.join(projectRoot, 'requirements.txt');
      if (!fs.existsSync(reqPath)) {
        // Standard library only project (e.g. unittest)
        return {
          satisfied: true,
          projectType: 'python',
          missingPackages: [],
          remediation: 'Using standard library Python toolchain.',
        };
      }

      const lines = fs
        .readFileSync(reqPath, 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'));

      if (lines.length === 0) {
        return {
          satisfied: true,
          projectType: 'python',
          missingPackages: [],
          remediation: 'No external Python dependencies declared.',
        };
      }

      // Check vendor directory or wheels cache
      const vendorDir = path.join(projectRoot, 'vendor');
      const wheelsDir = path.join(projectRoot, 'wheels');
      const hasVendor = fs.existsSync(vendorDir);
      const hasWheels = fs.existsSync(wheelsDir);

      if (!hasVendor && !hasWheels) {
        const depNames = lines.map((l) => l.split(/[=<>~]/)[0]?.trim() || l);
        return {
          satisfied: false,
          projectType: 'python',
          missingPackages: depNames,
          remediation: `requirements.txt declares dependencies (${depNames.join(
            ', ',
          )}) but neither vendor/ nor wheels/ directory is present in the workspace. Provide an offline dependency bundle before executing. Network downloads in the sandbox are strictly prohibited.`,
          errorCode: ErrorCode.OFFLINE_DEPENDENCY_MISSING,
        };
      }

      return {
        satisfied: true,
        projectType: 'python',
        missingPackages: [],
        remediation: 'Offline Python dependencies present.',
      };
    }

    return {
      satisfied: false,
      projectType,
      missingPackages: ['unsupported project type'],
      remediation: 'Unsupported project type for offline execution.',
      errorCode: ErrorCode.TOOLCHAIN_UNAVAILABLE,
    };
  }
}
