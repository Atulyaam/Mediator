/**
 * @mediator/executor-contract — WSL2 Sandbox Provisioner & Readiness Evaluator (Sprint S41)
 *
 * Requirements:
 * - Read-only discovery of host WSL2 installation, distributions, kernel, and systemd.
 * - Detects that default distributions (e.g. Ubuntu) expose Windows ambient authority
 *   via automount (/mnt/c) and interop (cmd.exe), rendering them unsafe as sandboxes.
 * - Formulates the authoritative configuration for dedicated "MediatorSandbox":
 *   * [automount] enabled=false (no /mnt/c host drive access)
 *   * [interop] enabled=false, appendWindowsPath=false (no Windows .exe execution)
 *   * Unprivileged user "mediator-runner" (UID 1500, no sudo)
 *   * Default-deny network rules (iptables/nftables)
 * - Fails closed: Never automatically downloads, installs, or modifies distributions
 *   without explicit user authorization.
 */

import { execSync } from 'node:child_process';

export interface WslDistroInfo {
  readonly name: string;
  readonly isDefault: boolean;
  readonly state: string;
  readonly version: number;
}

export interface WslHostDiscoveryReport {
  readonly isWslInstalled: boolean;
  readonly wslVersion: string;
  readonly kernelVersion?: string | undefined;
  readonly distributions: readonly WslDistroInfo[];
  readonly isDedicatedDistroPresent: boolean;
  readonly dedicatedDistroName: string;
  readonly defaultDistroHasAutomount: boolean;
  readonly defaultDistroHasInterop: boolean;
  readonly defaultDistroSystemd: boolean;
  readonly missingPrerequisites: readonly string[];
  readonly requiredUserActions: readonly string[];
}

export interface WslSandboxConfigTemplate {
  readonly distroName: string;
  readonly userName: string;
  readonly uid: number;
  readonly wslConfContent: string;
  readonly iptablesDropScript: string;
  readonly provisionPowerShellSnippet: string;
}

export const CANONICAL_MEDIATOR_SANDBOX_NAME = 'MediatorSandbox';
export const CANONICAL_SANDBOX_USER = 'mediator-runner';
export const CANONICAL_SANDBOX_UID = 1500;

export const CANONICAL_WSL_CONF_TEMPLATE = `[boot]
systemd=true

[automount]
enabled=false
mountFsTab=false

[interop]
enabled=false
appendWindowsPath=false

[user]
default=${CANONICAL_SANDBOX_USER}
`;

export const CANONICAL_NETWORK_DEFAULT_DENY_SCRIPT = `#!/bin/sh
# Mediator S41 — Network Default-Deny Policy for Dedicated Sandbox
# Flush existing filter rules
iptables -F OUTPUT 2>/dev/null || true
# Allow loopback interface for local inter-process pipes
iptables -A OUTPUT -o lo -j ACCEPT 2>/dev/null || true
# Drop all external and private-network outbound connections
iptables -A OUTPUT -j DROP 2>/dev/null || true
`;

export class WslSandboxProvisioner {
  private readonly dedicatedDistroName: string;

  public constructor(dedicatedDistroName: string = CANONICAL_MEDIATOR_SANDBOX_NAME) {
    this.dedicatedDistroName = dedicatedDistroName;
  }

  /**
   * Perform non-destructive read-only inspection of the host WSL2 subsystem.
   */
  public discoverHostWsl(): WslHostDiscoveryReport {
    let isWslInstalled = false;
    const wslVersion = 'WSL2';
    let kernelVersion: string | undefined;
    const distros: WslDistroInfo[] = [];

    try {
      const listOutput = execSync('wsl.exe -l -v', {
        encoding: 'utf16le',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 15000,
      });

      isWslInstalled = true;
      const lines = listOutput.split(/\r?\n/).filter((l) => l.trim().length > 0);

      // Parse distributions table: NAME STATE VERSION
      for (const line of lines.slice(1)) {
        const clean = line.replace(/\0/g, '').trim();
        const isDefault = clean.startsWith('*');
        const parts = clean.replace(/^\*/, '').trim().split(/\s+/);
        if (parts.length >= 3) {
          const name = parts[0]!;
          const state = parts[1]!;
          const ver = parseInt(parts[2]!, 10) || 2;
          distros.push({ name, isDefault, state, version: ver });
        }
      }
    } catch {
      isWslInstalled = false;
    }

    // Probe kernel version from default distro if available
    let defaultDistroHasAutomount = true;
    let defaultDistroHasInterop = true;
    let defaultDistroSystemd = false;

    if (isWslInstalled && distros.length > 0) {
      const defaultDistro = distros.find((d) => d.isDefault) ?? distros[0];
      if (defaultDistro) {
        try {
          kernelVersion = execSync(`wsl.exe -d ${defaultDistro.name} -e uname -r`, {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: 30000,
          }).replace(/\0/g, '').trim();
        } catch {
          try {
            kernelVersion = execSync('wsl.exe -e uname -r', {
              encoding: 'utf8',
              stdio: ['ignore', 'pipe', 'pipe'],
              timeout: 30000,
            }).replace(/\0/g, '').trim();
          } catch {
            // non-fatal probe failure
          }
        }

        try {
          const mountCheck = execSync(`wsl.exe -d ${defaultDistro.name} -e mount`, {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: 15000,
          }).replace(/\0/g, '');
          defaultDistroHasAutomount = mountCheck.includes('drvfs') || mountCheck.includes('/mnt/c');
        } catch {
          defaultDistroHasAutomount = true;
        }

        try {
          const interopCheck = execSync(`wsl.exe -d ${defaultDistro.name} -e which cmd.exe`, {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: 15000,
          }).replace(/\0/g, '');
          defaultDistroHasInterop = interopCheck.includes('cmd.exe');
        } catch {
          defaultDistroHasInterop = false;
        }

        try {
          const wslConf = execSync(`wsl.exe -d ${defaultDistro.name} -e cat /etc/wsl.conf`, {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: 15000,
          }).replace(/\0/g, '');
          defaultDistroSystemd = wslConf.includes('systemd=true');
        } catch {
          defaultDistroSystemd = false;
        }
      }
    }

    const isDedicatedDistroPresent = distros.some((d) => d.name === this.dedicatedDistroName);
    const missingPrerequisites: string[] = [];
    const requiredUserActions: string[] = [];

    if (!isWslInstalled) {
      missingPrerequisites.push('WSL2 is not installed or not enabled on host system');
      requiredUserActions.push('Install WSL2 via "wsl --install" in an elevated PowerShell session.');
    }

    if (!isDedicatedDistroPresent) {
      missingPrerequisites.push(`Dedicated distribution "${this.dedicatedDistroName}" is not yet provisioned`);
      requiredUserActions.push(
        `Review and authorize creation of dedicated "${this.dedicatedDistroName}" distro with automount=false and interop=false.`,
      );
    }

    if (defaultDistroHasAutomount) {
      missingPrerequisites.push('Default Ubuntu distribution mounts host drives at /mnt/c (unsafe for untrusted code)');
    }

    if (defaultDistroHasInterop) {
      missingPrerequisites.push('Default Ubuntu distribution allows executing Windows binaries (unsafe for untrusted code)');
    }

    return {
      isWslInstalled,
      wslVersion,
      kernelVersion,
      distributions: distros,
      isDedicatedDistroPresent,
      dedicatedDistroName: this.dedicatedDistroName,
      defaultDistroHasAutomount,
      defaultDistroHasInterop,
      defaultDistroSystemd,
      missingPrerequisites,
      requiredUserActions,
    };
  }

  /**
   * Return the authoritative template and configuration for provisioning MediatorSandbox.
   */
  public getSandboxConfigTemplate(): WslSandboxConfigTemplate {
    const psSnippet = [
      `# Step 1: Export rootfs or prepare minimal base archive`,
      `# Step 2: Import as dedicated isolated distribution`,
      `wsl --import ${this.dedicatedDistroName} "$env:LOCALAPPDATA\\Mediator\\wsl" "$rootfsTar" --version 2`,
      `# Step 3: Write hardened /etc/wsl.conf to disable automount and interop`,
      `# Step 4: Add non-root execution user "${CANONICAL_SANDBOX_USER}" (UID ${CANONICAL_SANDBOX_UID})`,
      `# Step 5: Restart distribution via: wsl --terminate ${this.dedicatedDistroName}`,
    ].join('\r\n');

    return {
      distroName: this.dedicatedDistroName,
      userName: CANONICAL_SANDBOX_USER,
      uid: CANONICAL_SANDBOX_UID,
      wslConfContent: CANONICAL_WSL_CONF_TEMPLATE,
      iptablesDropScript: CANONICAL_NETWORK_DEFAULT_DENY_SCRIPT,
      provisionPowerShellSnippet: psSnippet,
    };
  }
}
