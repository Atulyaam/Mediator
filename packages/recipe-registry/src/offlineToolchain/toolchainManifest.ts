/**
 * @mediator/recipe-registry — Offline Toolchain Bundle Manifest (S46)
 *
 * Requirements:
 * - Machine-readable manifest for offline dependency/toolchain bundles.
 * - Strict schema validation with Zod.
 * - Cryptographic SHA-256 checksums per file and overall root hash.
 * - Strict boundary controls: relative paths only, no traversal, no escapes.
 */

import { z } from 'zod';

export const ToolchainFileRecordSchema = z.object({
  relativePath: z
    .string()
    .min(1)
    .max(512)
    .regex(/^(?!.*\.\.)[a-zA-Z0-9_\-./@]+$/, 'Path must be relative, clean and free of traversal operators'),
  sizeBytes: z.number().int().nonnegative().max(100 * 1024 * 1024), // 100MB max per file
  sha256: z.string().length(64).regex(/^[a-f0-9]{64}$/, 'Must be valid 64-char lowercase hex SHA-256'),
});

export type ToolchainFileRecord = z.infer<typeof ToolchainFileRecordSchema>;

export const ToolchainBundleManifestSchema = z.object({
  manifestVersion: z.literal('1.0.0'),
  bundleId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9_\-.:]+$/),
  projectType: z.enum(['node', 'python']),
  createdAt: z.number().int().positive(),
  totalSizeBytes: z.number().int().nonnegative().max(500 * 1024 * 1024), // 500MB max bundle
  fileCount: z.number().int().nonnegative().max(20_000), // 20k files max
  rootHash: z.string().length(64).regex(/^[a-f0-9]{64}$/),
  toolchainVersion: z.string().max(64).optional(),
  files: z.array(ToolchainFileRecordSchema),
  metadata: z.record(z.string()).optional(),
});

export type ToolchainBundleManifest = z.infer<typeof ToolchainBundleManifestSchema>;
