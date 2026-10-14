/**
 * @mediator/native-host — Host Manifest & Reversible Windows Registration (S19)
 *
 * Requirements:
 * - Generates Native Messaging host manifest JSON adhering to Chromium spec.
 * - Current-user registration only (HKCU\Software\Google\Chrome\NativeMessagingHosts).
 * - Never modifies machine-wide settings (HKLM) silently.
 * - Explicit install and uninstall behavior.
 * - Real executable absolute path required. Never registers a .bat file.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import {
  ErrorCode,
  makeMediatorError,
  type MediatorError,
  type Result,
  ok,
  err,
} from '@mediator/shared-contracts';
import { EXTENSION_ID_REGEX } from './originValidator.js';

export const HOST_NAME = 'com.mediator.native_host';
export const HOST_DESCRIPTION = 'Mediator Native Messaging Host';

export interface NativeHostManifest {
  readonly name: string;
  readonly description: string;
  readonly path: string;
  readonly type: 'stdio';
  readonly allowed_origins: readonly string[];
}

export interface RegistrationOptions {
  readonly manifestDir?: string | undefined;
  readonly executablePath: string;
  readonly allowedExtensionIds: readonly string[];
  readonly hostName?: string | undefined;
}

/**
 * Generate the Native Messaging host manifest object.
 * Validates that the executable is NOT a batch script (.bat / .cmd).
 */
export function generateHostManifest(
  options: RegistrationOptions,
): Result<NativeHostManifest, MediatorError> {
  const hostName = options.hostName ?? HOST_NAME;
  const exePath = path.resolve(options.executablePath);

  // Invariant: Never use a .bat or .cmd wrapper as production native host
  const ext = path.extname(exePath).toLowerCase();
  if (ext === '.bat' || ext === '.cmd') {
    return err(
      makeMediatorError(
        ErrorCode.NATIVE_HOST_NOT_INSTALLED,
        `Prohibited executable extension '${ext}'. Native messaging host must be a real compiled binary (.exe), not a script wrapper.`,
      ),
    );
  }

  if (options.allowedExtensionIds.length === 0) {
    return err(
      makeMediatorError(
        ErrorCode.IPC_ORIGIN_REJECTED,
        'At least one authorized extension ID must be provided in allowed_origins',
      ),
    );
  }

  const allowedOrigins: string[] = [];
  for (const rawId of options.allowedExtensionIds) {
    const id = rawId.trim().toLowerCase();
    if (!EXTENSION_ID_REGEX.test(id)) {
      return err(
        makeMediatorError(
          ErrorCode.IPC_ORIGIN_REJECTED,
          `Invalid extension ID format: '${rawId}'. Must be a 32-character string.`,
        ),
      );
    }
    allowedOrigins.push(`chrome-extension://${id}/`);
  }

  const manifest: NativeHostManifest = {
    name: hostName,
    description: HOST_DESCRIPTION,
    path: exePath,
    type: 'stdio',
    allowed_origins: allowedOrigins,
  };

  return ok(manifest);
}

/**
 * Write the host manifest JSON file to the target directory.
 */
export function writeManifestFile(
  manifest: NativeHostManifest,
  targetDirectory: string,
): string {
  fs.mkdirSync(targetDirectory, { recursive: true });
  const manifestPath = path.join(targetDirectory, `${manifest.name}.json`);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  return manifestPath;
}

/**
 * Generate PowerShell commands to register Native Messaging host in HKCU for Chrome and Edge.
 * Current-user only, reversible.
 */
export function generateInstallRegistryScript(manifestFilePath: string): string {
  const resolvedManifestPath = path.resolve(manifestFilePath).replace(/\\/g, '\\\\');
  return [
    `# Mediator Native Host Current-User Registration`,
    `$manifestPath = "${resolvedManifestPath}"`,
    `$chromeKey = "HKCU:\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}"`,
    `$edgeKey = "HKCU:\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${HOST_NAME}"`,
    `New-Item -Path $chromeKey -Force | Out-Null`,
    `Set-ItemProperty -Path $chromeKey -Name "(Default)" -Value $manifestPath`,
    `New-Item -Path $edgeKey -Force | Out-Null`,
    `Set-ItemProperty -Path $edgeKey -Name "(Default)" -Value $manifestPath`,
    `Write-Host "Mediator Native Host successfully registered in HKCU."`,
  ].join('\n');
}

/**
 * Generate PowerShell commands to remove Native Messaging host from HKCU.
 */
export function generateUninstallRegistryScript(): string {
  return [
    `# Mediator Native Host Current-User Unregistration`,
    `$chromeKey = "HKCU:\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}"`,
    `$edgeKey = "HKCU:\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${HOST_NAME}"`,
    `if (Test-Path $chromeKey) { Remove-Item -Path $chromeKey -Recurse -Force }`,
    `if (Test-Path $edgeKey) { Remove-Item -Path $edgeKey -Recurse -Force }`,
    `Write-Host "Mediator Native Host unregistered from HKCU."`,
  ].join('\n');
}
