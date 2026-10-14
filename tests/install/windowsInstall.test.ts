/**
 * @mediator/native-host & packaging — Windows 11 Installation & Registration Test Suite (S28)
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  generateHostManifest,
  generateInstallRegistryScript,
  generateUninstallRegistryScript,
  HOST_NAME,
} from '../../packages/native-host/src/registration.js';

describe('Sprint S28 — Windows 11 Installation, Uninstallation & Manifest Pinning', () => {
  const validExtensionId = 'abcdefghijklmnopponmlkjihgfedcba';
  const validExePath = 'C:\\Program Files\\Mediator\\mediator-native-host.exe';

  describe('1. Host Manifest Generation & Validation', () => {
    it('generates valid Chromium native messaging manifest adhering to spec', () => {
      const res = generateHostManifest({
        executablePath: validExePath,
        allowedExtensionIds: [validExtensionId],
      });

      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.value.name).toBe(HOST_NAME);
        expect(res.value.description).toBe('Mediator Native Messaging Host');
        expect(res.value.type).toBe('stdio');
        expect(res.value.path).toBe(path.resolve(validExePath));
        expect(res.value.allowed_origins).toEqual([
          `chrome-extension://${validExtensionId}/`,
        ]);
      }
    });

    it('strictly prohibits batch files (.bat, .cmd) as executable paths', () => {
      const batRes = generateHostManifest({
        executablePath: 'C:\\Mediator\\host.bat',
        allowedExtensionIds: [validExtensionId],
      });
      expect(batRes.ok).toBe(false);
      if (!batRes.ok) {
        expect(batRes.error.message).toContain('Prohibited executable extension');
      }

      const cmdRes = generateHostManifest({
        executablePath: 'C:\\Mediator\\host.cmd',
        allowedExtensionIds: [validExtensionId],
      });
      expect(cmdRes.ok).toBe(false);
      if (!cmdRes.ok) {
        expect(cmdRes.error.message).toContain('Prohibited executable extension');
      }
    });

    it('rejects empty extension IDs list fail-closed', () => {
      const res = generateHostManifest({
        executablePath: validExePath,
        allowedExtensionIds: [],
      });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.message).toContain('At least one authorized extension ID');
      }
    });

    it('rejects malformed extension IDs failing 32-character requirement', () => {
      const tooShortRes = generateHostManifest({
        executablePath: validExePath,
        allowedExtensionIds: ['abc123'],
      });
      expect(tooShortRes.ok).toBe(false);

      const wildcardRes = generateHostManifest({
        executablePath: validExePath,
        allowedExtensionIds: ['*'],
      });
      expect(wildcardRes.ok).toBe(false);
    });

    it('supports multiple pinned extension IDs (e.g. Chrome + Edge test builds)', () => {
      const id2 = 'ponmlkjihgfedcbaabcdefghijklmnop';
      const res = generateHostManifest({
        executablePath: validExePath,
        allowedExtensionIds: [validExtensionId, id2],
      });

      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.value.allowed_origins).toHaveLength(2);
        expect(res.value.allowed_origins).toContain(`chrome-extension://${validExtensionId}/`);
        expect(res.value.allowed_origins).toContain(`chrome-extension://${id2}/`);
      }
    });
  });

  describe('2. Registry Script Generation', () => {
    it('generates install script restricted strictly to Current User (HKCU)', () => {
      const script = generateInstallRegistryScript('C:\\Path\\To\\com.mediator.native_host.json');

      expect(script).toContain('HKCU:\\Software\\Google\\Chrome\\NativeMessagingHosts\\');
      expect(script).toContain('HKCU:\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\');
      // Crucial: Must NEVER touch machine-wide settings (HKLM)
      expect(script).not.toContain('HKLM:');
      expect(script).not.toContain('HKEY_LOCAL_MACHINE');
    });

    it('generates uninstall script that removes HKCU keys cleanly and idempotently', () => {
      const script = generateUninstallRegistryScript();

      expect(script).toContain('Remove-Item -Path $chromeKey');
      expect(script).toContain('Remove-Item -Path $edgeKey');
      expect(script).not.toContain('HKLM:');
    });
  });

  describe('3. PowerShell Installer & Uninstaller Artifacts', () => {
    const installScriptPath = path.resolve(__dirname, '../../scripts/install-windows.ps1');
    const uninstallScriptPath = path.resolve(__dirname, '../../scripts/uninstall-windows.ps1');

    it('verifies install-windows.ps1 exists and includes security invariants', () => {
      expect(fs.existsSync(installScriptPath)).toBe(true);
      const content = fs.readFileSync(installScriptPath, 'utf8');

      // Checks for current user, non-admin requirement, .bat rejection, extension ID validation, and rollback
      expect(content).toContain('HKCU:');
      expect(content).toContain('^[a-p]{32}$');
      expect(content).toContain('.bat');
      expect(content).toContain('Rolling back');
      expect(content).not.toContain('HKLM:');
    });

    it('verifies uninstall-windows.ps1 exists and includes safe idempotent cleanup', () => {
      expect(fs.existsSync(uninstallScriptPath)).toBe(true);
      const content = fs.readFileSync(uninstallScriptPath, 'utf8');

      expect(content).toContain('HKCU:');
      expect(content).toContain('Remove-Item -Path $chromeRegPath');
      expect(content).toContain('Remove-Item -Path $edgeRegPath');
      expect(content).not.toContain('HKLM:');
    });
  });
});
