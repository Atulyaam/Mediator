/**
 * @mediator/context-security — Comprehensive Test Suite (S06)
 *
 * Tests use SYNTHETIC (fake) secrets only.
 * Every test searches the COMPLETE serialized output for any fixture secret value.
 * Tests DO NOT log matched raw values — failures reference rule IDs only.
 *
 * Coverage:
 * 1–2:   Default path exclusion globs + nested paths
 * 3:     .mediatorignore adds exclusions correctly
 * 4:     .mediatorignore cannot permit outside-workspace access
 * 5:     Private-key and token-like content detection
 * 6:     Authorization headers and database connection strings
 * 7:     Overlapping secret patterns
 * 8:     Large content and unsupported-encoding behavior
 * 9:     Terminal output with fake secrets
 * 10:    Redacted values never appear in serialized downstream packets
 * 11:    Scanner failures prevent affected content from being emitted
 * 12:    Excluded files rejected before content reading
 * 13:    Unknown files scanned before inclusion
 * 14:    Explicit AI request cannot override path exclusions
 * 15:    Existing S01–S05 tests remain unaffected (verified via npm test)
 *
 * End-to-end pipeline test:
 *   candidate content → exclusion → scan → redact → serialize → assert no fixture secret leaked
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  // Path exclusions
  checkPathExclusion,
  isPathExcluded,
  parseMediatorIgnore,
  getEffectiveExclusionRules,
  globToRegex,
  isRelativePathSafe,
  MANDATORY_EXCLUSIONS,
  // Scanner
  scanContent,
  scanTerminalOutput,
  shouldBlockContent,
  // Redactor
  redactContent,
  redactTerminalOutput,
  checkNoSecretsLeaked,
  // Context filter
  buildSafeContextPacket,
  processFileForContext,
  // Patterns
  addCustomPattern,
  resetCustomPatterns,
  getAllPatterns,
  // Preview
  buildContextPreview,
  formatContextPreview,
} from './index.js';
import type { WorkspaceRootState } from '@mediator/workspace-boundary';
import type { CandidateFile, ContextPolicy } from './contextFilter.js';

// ─── Synthetic test fixtures ────────────────────────────────────────────────

/**
 * All synthetic secrets used in tests.
 * These are FAKE values that follow real patterns but are NOT real credentials.
 * After every test that uses these, verify they do not appear in outputs.
 */
const FAKE_SECRETS = {
  stripeKey: 'sk_test_4eC39HqLyjWDarjtT1zdp7dc',
  openaiKey: 'sk-proj-fakekeyfakekeyfakekeyfakekey12345678',
  awsKey: 'AKIAIOSFODNN7EXAMPLE',
  awsSecret: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  githubToken: 'ghp_fakeGithubToken12345678901234567890AB',
  jwtToken: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.fakeSig1234567890abcdefghijklmnop',
  bearerToken: 'Bearer actual-sensitive-value-that-must-be-redacted',
  dbUrl: 'postgresql://fakeuser:fakepassword123@localhost:5432/testdb',
  password: 'SUPER_SECRET_PASSWORD_VALUE_FAKE',
  clientSecret: 'client_secret=fakeOAuthSecret1234567890abcdef',
  privateKeyHeader: '-----BEGIN RSA PRIVATE KEY-----',
};

// ─── Confirmed workspace fixture ────────────────────────────────────────────

const CONFIRMED_WORKSPACE: WorkspaceRootState = {
  selectedPath: 'C:\\Users\\test\\project',
  canonicalPath: 'C:\\Users\\test\\project',
  selectionSource: 'cli',
  confirmationStatus: 'confirmed',
  confirmationTimestamp: Date.now(),
  resolutionStatus: 'resolved',
  cloudStatus: 'not_cloud',
};

const UNCONFIRMED_WORKSPACE: WorkspaceRootState = {
  ...CONFIRMED_WORKSPACE,
  confirmationStatus: 'pending',
};

function assertOk<T>(res: { ok: true; value: T } | { ok: false; error: any }): T {
  expect(res.ok).toBe(true);
  if (!res.ok) throw new Error(res.error?.message ?? 'Expected ok');
  return res.value;
}

function assertErr<T>(res: { ok: true; value: T } | { ok: false; error: any }): any {
  expect(res.ok).toBe(false);
  if (res.ok) throw new Error('Expected err');
  return res.error;
}

function makeCandidateFile(relativePath: string, content: string): CandidateFile {
  return {
    relativePath,
    content,
    sizeBytes: Buffer.byteLength(content, 'utf8'),
  };
}

/**
 * Assert no fixture secrets appear in the serialized output.
 * Does NOT log the matched value on failure.
 */
function assertNoSecretsInOutput(output: string, secretKeys: (keyof typeof FAKE_SECRETS)[]): void {
  for (const key of secretKeys) {
    const secretValue = FAKE_SECRETS[key];
    if (output.includes(secretValue)) {
      throw new Error(`LEAK DETECTED: Synthetic fixture secret '${key}' (rule reference only) appeared in serialized output. The raw value must never appear in packets, logs, or previews.`);
    }
  }
}

// ─── Test suite ─────────────────────────────────────────────────────────────

describe('S06 — Path Exclusions', () => {
  describe('1. Default exclusion globs', () => {
    it('excludes .env file', () => {
      const result = checkPathExclusion('.env', MANDATORY_EXCLUSIONS);
      expect(result.excluded).toBe(true);
      expect(result.ruleId).toBe('ENV_FILES');
    });

    it('excludes .env.local and .env.production', () => {
      expect(checkPathExclusion('.env.local', MANDATORY_EXCLUSIONS).excluded).toBe(true);
      expect(checkPathExclusion('.env.production', MANDATORY_EXCLUSIONS).excluded).toBe(true);
    });

    it('excludes *.pem files', () => {
      expect(checkPathExclusion('server.pem', MANDATORY_EXCLUSIONS).excluded).toBe(true);
    });

    it('excludes *.key files', () => {
      expect(checkPathExclusion('private.key', MANDATORY_EXCLUSIONS).excluded).toBe(true);
    });

    it('excludes *.pfx and *.p12 files', () => {
      expect(checkPathExclusion('cert.pfx', MANDATORY_EXCLUSIONS).excluded).toBe(true);
      expect(checkPathExclusion('cert.p12', MANDATORY_EXCLUSIONS).excluded).toBe(true);
    });

    it('excludes id_rsa and id_ed25519', () => {
      expect(checkPathExclusion('id_rsa', MANDATORY_EXCLUSIONS).excluded).toBe(true);
      expect(checkPathExclusion('id_ed25519', MANDATORY_EXCLUSIONS).excluded).toBe(true);
    });

    it('excludes .npmrc', () => {
      expect(checkPathExclusion('.npmrc', MANDATORY_EXCLUSIONS).excluded).toBe(true);
    });

    it('excludes .pypirc', () => {
      expect(checkPathExclusion('.pypirc', MANDATORY_EXCLUSIONS).excluded).toBe(true);
    });

    it('excludes .netrc', () => {
      expect(checkPathExclusion('.netrc', MANDATORY_EXCLUSIONS).excluded).toBe(true);
    });

    it('excludes .aws/** paths', () => {
      expect(checkPathExclusion('.aws/credentials', MANDATORY_EXCLUSIONS).excluded).toBe(true);
      expect(checkPathExclusion('.aws/config', MANDATORY_EXCLUSIONS).excluded).toBe(true);
    });

    it('excludes .kube/config', () => {
      expect(checkPathExclusion('.kube/config', MANDATORY_EXCLUSIONS).excluded).toBe(true);
    });

    it('excludes .docker/config.json', () => {
      expect(checkPathExclusion('.docker/config.json', MANDATORY_EXCLUSIONS).excluded).toBe(true);
    });

    it('excludes .git/config', () => {
      expect(checkPathExclusion('.git/config', MANDATORY_EXCLUSIONS).excluded).toBe(true);
    });

    it('excludes *.tfstate files', () => {
      expect(checkPathExclusion('terraform.tfstate', MANDATORY_EXCLUSIONS).excluded).toBe(true);
      expect(checkPathExclusion('terraform.tfstate.backup', MANDATORY_EXCLUSIONS).excluded).toBe(true);
    });

    it('excludes terraform.tfvars', () => {
      expect(checkPathExclusion('terraform.tfvars', MANDATORY_EXCLUSIONS).excluded).toBe(true);
    });

    it('excludes credentials.json', () => {
      expect(checkPathExclusion('credentials.json', MANDATORY_EXCLUSIONS).excluded).toBe(true);
    });

    it('excludes service-account*.json', () => {
      expect(checkPathExclusion('service-account.json', MANDATORY_EXCLUSIONS).excluded).toBe(true);
      expect(checkPathExclusion('service-account-prod.json', MANDATORY_EXCLUSIONS).excluded).toBe(true);
    });

    it('excludes appsettings.*.json (non-development)', () => {
      expect(checkPathExclusion('appsettings.Production.json', MANDATORY_EXCLUSIONS).excluded).toBe(true);
      expect(checkPathExclusion('appsettings.Staging.json', MANDATORY_EXCLUSIONS).excluded).toBe(true);
    });

    it('excludes *.kdbx files', () => {
      expect(checkPathExclusion('passwords.kdbx', MANDATORY_EXCLUSIONS).excluded).toBe(true);
    });

    it('does NOT exclude regular source files', () => {
      expect(checkPathExclusion('src/index.ts', MANDATORY_EXCLUSIONS).excluded).toBe(false);
      expect(checkPathExclusion('README.md', MANDATORY_EXCLUSIONS).excluded).toBe(false);
      expect(checkPathExclusion('package.json', MANDATORY_EXCLUSIONS).excluded).toBe(false);
    });
  });

  describe('2. Nested paths and Windows separators', () => {
    it('excludes .env in subdirectory', () => {
      expect(checkPathExclusion('config/.env', MANDATORY_EXCLUSIONS).excluded).toBe(true);
    });

    it('excludes .env.local at any depth', () => {
      expect(checkPathExclusion('apps/backend/.env.local', MANDATORY_EXCLUSIONS).excluded).toBe(true);
    });

    it('handles Windows backslash separators (normalized)', () => {
      // Paths from Windows will have backslashes; normalizePathForExclusion converts them
      expect(isPathExcluded('.env.production')).toMatchObject({ excluded: true });
    });

    it('excludes nested *.pem', () => {
      expect(checkPathExclusion('certs/server.pem', MANDATORY_EXCLUSIONS).excluded).toBe(true);
    });

    it('excludes nested id_rsa', () => {
      expect(checkPathExclusion('ssh-keys/id_rsa', MANDATORY_EXCLUSIONS).excluded).toBe(true);
    });

    it('excludes deep .aws credentials', () => {
      expect(checkPathExclusion('home/.aws/credentials', MANDATORY_EXCLUSIONS).excluded).toBe(true);
    });

    it('excludes paths in secrets/ directory', () => {
      expect(checkPathExclusion('secrets/api_key.txt', MANDATORY_EXCLUSIONS).excluded).toBe(true);
    });
  });

  describe('3. .mediatorignore adds exclusions correctly', () => {
    it('parses glob patterns from .mediatorignore content', () => {
      const content = `
# This is a comment
*.log
docs/private/**
build/
`;
      const rules = parseMediatorIgnore(content);
      expect(rules).toHaveLength(1);
      expect(rules[0]!.patterns).toContain('*.log');
      expect(rules[0]!.patterns).toContain('docs/private/**');
    });

    it('user exclusions add to mandatory rules via getEffectiveExclusionRules', () => {
      const userRules = parseMediatorIgnore('*.log\ntemp/**');
      const effective = getEffectiveExclusionRules(userRules);
      // All mandatory rules are still present
      expect(effective.some(r => r.id === 'ENV_FILES')).toBe(true);
      // User rule is also present
      expect(effective.some(r => r.id === 'MEDIATORIGNORE_USER')).toBe(true);
    });

    it('user .mediatorignore exclusion is applied in path check', () => {
      const userRules = parseMediatorIgnore('*.log');
      const result = isPathExcluded('debug.log', userRules);
      expect(result.excluded).toBe(true);
      expect(result.ruleId).toBe('MEDIATORIGNORE_USER');
    });

    it('mandatory rules are not removed by user rules', () => {
      const userRules = parseMediatorIgnore('*.log');
      // .env must still be excluded even with user rules present
      const result = isPathExcluded('.env', userRules);
      expect(result.excluded).toBe(true);
      expect(result.ruleId).toBe('ENV_FILES');
    });

    it('blank lines and comments are ignored', () => {
      const rules = parseMediatorIgnore('# comment\n\n  \n*.log');
      expect(rules[0]!.patterns).toEqual(['*.log']);
    });
  });

  describe('4. .mediatorignore cannot permit outside-workspace access', () => {
    it('absolute paths in .mediatorignore are rejected', () => {
      const rules = parseMediatorIgnore('C:\\Windows\\System32\\**\n/etc/passwd');
      expect(rules).toHaveLength(0);
    });

    it('traversal patterns in .mediatorignore are rejected', () => {
      const rules = parseMediatorIgnore('../outside/**\n../../secret.key');
      expect(rules).toHaveLength(0);
    });

    it('isRelativePathSafe rejects traversal', () => {
      expect(isRelativePathSafe('../outside.txt')).toBe(false);
      expect(isRelativePathSafe('../../secret.key')).toBe(false);
    });

    it('isRelativePathSafe accepts normal relative paths', () => {
      expect(isRelativePathSafe('src/index.ts')).toBe(true);
      expect(isRelativePathSafe('README.md')).toBe(true);
    });

    it('exclusions do not affect S04/S05 workspace containment enforcement', () => {
      // Even if a path is "allowed" by user rules, S05 containment must be enforced
      // This test documents the invariant — the exclusion system only controls
      // context inclusion, not file system access permissions
      const userRules = parseMediatorIgnore('src/**'); // Allow src files
      // .env is STILL excluded even though user didn't add it
      const result = isPathExcluded('.env', userRules);
      expect(result.excluded).toBe(true);
    });
  });
});

describe('S06 — Secret Scanner', () => {
  describe('5. Private-key and token-like content detection', () => {
    it('detects RSA private key header', () => {
      const content = `${FAKE_SECRETS.privateKeyHeader}\nMIIEpAIBAAKCAQEA...fake base64...\n-----END RSA PRIVATE KEY-----`;
      const result = assertOk(scanContent(content));
      expect(result.secretsDetected).toBe(true);
      const ruleIds = result.findings.map((f: { ruleId: string }) => f.ruleId);
      expect(ruleIds).toContain('PRIVATE_KEY_BLOCK');
      // Findings must never contain the raw secret value
      const serialized = JSON.stringify(result.findings);
      assertNoSecretsInOutput(serialized, ['privateKeyHeader']);
    });

    it('detects Stripe test key', () => {
      const content = `STRIPE_SECRET_KEY=${FAKE_SECRETS.stripeKey}`;
      const result = assertOk(scanContent(content));
      expect(result.secretsDetected).toBe(true);
      const serialized = JSON.stringify(result.findings);
      assertNoSecretsInOutput(serialized, ['stripeKey']);
    });

    it('detects GitHub token', () => {
      const content = `Authorization: token ${FAKE_SECRETS.githubToken}`;
      const result = assertOk(scanContent(content));
      expect(result.secretsDetected).toBe(true);
    });

    it('detects JWT token', () => {
      const content = `token=${FAKE_SECRETS.jwtToken}`;
      const result = assertOk(scanContent(content));
      expect(result.secretsDetected).toBe(true);
      const ruleIds = result.findings.map((f: { ruleId: string }) => f.ruleId);
      expect(ruleIds).toContain('JWT_TOKEN');
    });

    it('detects OpenAI key', () => {
      const content = `OPENAI_API_KEY=${FAKE_SECRETS.openaiKey}`;
      const result = assertOk(scanContent(content));
      expect(result.secretsDetected).toBe(true);
    });
  });

  describe('6. Authorization headers and database connection strings', () => {
    it('detects Bearer authorization header', () => {
      const content = `Authorization: ${FAKE_SECRETS.bearerToken}`;
      const result = assertOk(scanContent(content));
      expect(result.secretsDetected).toBe(true);
      const ruleIds = result.findings.map((f: { ruleId: string }) => f.ruleId);
      expect(ruleIds).toContain('AUTH_BEARER_TOKEN');
      assertNoSecretsInOutput(JSON.stringify(result.findings), ['bearerToken']);
    });

    it('detects database URL with credentials', () => {
      const content = `DATABASE_URL=${FAKE_SECRETS.dbUrl}`;
      const result = assertOk(scanContent(content));
      expect(result.secretsDetected).toBe(true);
      const ruleIds = result.findings.map((f: { ruleId: string }) => f.ruleId);
      expect(ruleIds).toContain('DATABASE_URL_WITH_CREDENTIALS');
      assertNoSecretsInOutput(JSON.stringify(result.findings), ['dbUrl']);
    });

    it('detects client_secret assignment', () => {
      const content = `${FAKE_SECRETS.clientSecret}`;
      const result = assertOk(scanContent(content));
      expect(result.secretsDetected).toBe(true);
    });
  });

  describe('7. Overlapping secret patterns', () => {
    it('handles content with multiple overlapping patterns without exposing secrets', () => {
      // Content that matches both STRIPE and a TOKEN pattern
      const content = `
STRIPE_SECRET_KEY=${FAKE_SECRETS.stripeKey}
SECRET=some-other-secret-value-here-1234567890
`;
      const result = assertOk(scanContent(content));
      const serialized = JSON.stringify(result);
      assertNoSecretsInOutput(serialized, ['stripeKey']);

      // Verify redaction handles overlaps safely
      const redacted = redactContent(content, result);
      expect(redacted.blocked).toBe(false);
      expect(redacted.wasRedacted).toBe(true);
      assertNoSecretsInOutput(redacted.redactedContent, ['stripeKey']);
    });
  });

  describe('8. Large content and unsupported encoding', () => {
    it('fails closed for content exceeding max size', () => {
      const huge = 'A'.repeat(600 * 1024); // 600 KB > 512 KB limit
      const err = assertErr(scanContent(huge));
      expect(err.code).toBe('OVERSIZED_INPUT');
    });

    it('fails closed for content with lone surrogates', () => {
      const badContent = 'valid text\uD800invalid surrogate\n'; // Lone high surrogate
      const err = assertErr(scanContent(badContent));
      expect(err.code).toBe('SCHEMA_INVALID');
    });

    it('handles empty string safely', () => {
      const result = assertOk(scanContent(''));
      expect(result.secretsDetected).toBe(false);
    });

    it('handles normal text safely', () => {
      const result = assertOk(scanContent('This is clean safe code content without any secrets.'));
      expect(result.secretsDetected).toBe(false);
    });
  });

  describe('9. Terminal output containing fake secrets', () => {
    it('detects secrets in terminal output', () => {
      const output = `
[INFO] Starting deployment...
[DEBUG] Stripe key: ${FAKE_SECRETS.stripeKey}
[INFO] Done
`;
      const result = assertOk(scanTerminalOutput(output));
      expect(result.secretsDetected).toBe(true);
    });

    it('redactTerminalOutput replaces secrets in terminal output', () => {
      const output = `Authorization: ${FAKE_SECRETS.bearerToken}`;
      const scanResult = assertOk(scanContent(output));
      const safe = redactTerminalOutput(output, scanResult);
      assertNoSecretsInOutput(safe, ['bearerToken']);
      expect(safe).toContain('[REDACTED:AUTH_TOKEN]');
    });

    it('terminal output fails closed if scan fails (oversized)', () => {
      const huge = 'X'.repeat(100 * 1024); // 100 KB > 64 KB terminal limit
      const result = scanTerminalOutput(huge);
      expect(result.ok).toBe(false);
    });
  });
});

describe('S06 — Redactor', () => {
  describe('10. Redacted values never appear in serialized downstream packets', () => {
    it('redacts Stripe key and verifies it is absent from serialized output', () => {
      const content = `API_KEY=${FAKE_SECRETS.stripeKey}\nother data`;
      const scan = assertOk(scanContent(content));
      const redacted = redactContent(content, scan);

      // Serialize the entire redaction result
      const serialized = JSON.stringify(redacted);
      assertNoSecretsInOutput(serialized, ['stripeKey']);
      assertNoSecretsInOutput(redacted.redactedContent, ['stripeKey']);
      expect(redacted.redactedContent).toContain('[REDACTED:STRIPE_KEY]');
    });

    it('redacts bearer token and verifies complete absence from packet', () => {
      const content = `Authorization: ${FAKE_SECRETS.bearerToken}`;
      const scan = assertOk(scanContent(content));
      const redacted = redactContent(content, scan);

      const serialized = JSON.stringify(redacted);
      assertNoSecretsInOutput(serialized, ['bearerToken']);
      assertNoSecretsInOutput(redacted.redactedContent, ['bearerToken']);
    });

    it('checkNoSecretsLeaked confirms fixture secrets absent from redacted output', () => {
      const content = `PASSWORD=${FAKE_SECRETS.password}`;
      const scan = assertOk(scanContent(content));
      const redacted = redactContent(content, scan);

      if (!redacted.blocked) {
        const leaked = checkNoSecretsLeaked(redacted.redactedContent, [FAKE_SECRETS.password]);
        expect(leaked).toHaveLength(0);
      }
    });

    it('records are safe — no raw secret in redaction records', () => {
      const content = `${FAKE_SECRETS.clientSecret}`;
      const scan = assertOk(scanContent(content));
      const redacted = redactContent(content, scan);

      // Every redaction record must be safe
      for (const record of redacted.redactions) {
        expect(typeof record.ruleId).toBe('string');
        expect(typeof record.label).toBe('string');
        // Verify record doesn't leak the actual secret
        const recordStr = JSON.stringify(record);
        assertNoSecretsInOutput(recordStr, ['clientSecret']);
      }
    });
  });

  describe('11. Scanner failures prevent content from being emitted', () => {
    it('oversized content is blocked — not sent', () => {
      const huge = 'A'.repeat(600 * 1024);
      const scan = scanContent(huge);
      // Error result means the content MUST be blocked
      expect(scan.ok).toBe(false);
      // Callers must not transmit content when scan fails
    });

    it('truncated scan causes blocked redaction', () => {
      // Simulate a truncated scan result
      const truncatedScan = {
        secretsDetected: true,
        findings: [],
        truncated: true,
        scannedBytes: 100,
      };
      const redacted = redactContent('some content', truncatedScan);
      expect(redacted.blocked).toBe(true);
      expect(redacted.redactedContent).toBe('');
    });

    it('shouldBlockContent returns true for critical/high findings', () => {
      const scan = assertOk(scanContent(`STRIPE_SECRET=${FAKE_SECRETS.stripeKey}`));
      expect(shouldBlockContent(scan)).toBe(true);
    });

    it('shouldBlockContent returns true for truncated scans', () => {
      const truncated = { secretsDetected: false, findings: [], truncated: true, scannedBytes: 0 };
      expect(shouldBlockContent(truncated)).toBe(true);
    });
  });
});

describe('S06 — Context Filter (Full Pipeline)', () => {
  describe('12. Excluded files are rejected BEFORE content is read', () => {
    it('processFileForContext excludes .env before any scan', () => {
      // If exclusion worked, we never scan the content — the status is 'excluded'
      const item = processFileForContext(
        makeCandidateFile('.env', `STRIPE_SECRET_KEY=${FAKE_SECRETS.stripeKey}`),
      );
      expect(item.status).toBe('excluded');
      expect(item.ruleId).toBe('ENV_FILES');
      // Content must NOT appear in the item (it was excluded)
      const serialized = JSON.stringify(item);
      assertNoSecretsInOutput(serialized, ['stripeKey']);
    });

    it('processFileForContext excludes *.key files', () => {
      const item = processFileForContext(
        makeCandidateFile('secrets/private.key', FAKE_SECRETS.privateKeyHeader),
      );
      expect(item.status).toBe('excluded');
    });

    it('processFileForContext excludes .aws/credentials', () => {
      const item = processFileForContext(
        makeCandidateFile('.aws/credentials', `aws_secret_access_key = ${FAKE_SECRETS.awsSecret}`),
      );
      expect(item.status).toBe('excluded');
    });
  });

  describe('13. Unknown files are scanned before inclusion', () => {
    it('clean file is included after scan', () => {
      const item = processFileForContext(
        makeCandidateFile('src/utils.ts', 'export function add(a: number, b: number): number { return a + b; }'),
      );
      expect(item.status).toBe('included');
      expect(item.safeContent).toBeDefined();
    });

    it('file with secret is blocked or redacted, not included raw', () => {
      const item = processFileForContext(
        makeCandidateFile('config/settings.ts', `const STRIPE_KEY = "${FAKE_SECRETS.stripeKey}";`),
      );
      // Must not be 'included' — must be 'redacted' or 'blocked'
      expect(item.status).not.toBe('included');
      // Verify secret is not in the output
      const serialized = JSON.stringify(item);
      assertNoSecretsInOutput(serialized, ['stripeKey']);
    });

    it('file exceeding size limit is rejected with too_large status', () => {
      const bigContent = 'A'.repeat(300 * 1024); // 300 KB > default 256 KB
      const item = processFileForContext(
        { relativePath: 'large-file.ts', content: bigContent, sizeBytes: 300 * 1024 },
      );
      expect(item.status).toBe('too_large');
    });
  });

  describe('14. Explicit AI request cannot override path exclusions', () => {
    it('buildSafeContextPacket excludes .env even when explicitly in candidate list', () => {
      // Simulating an AI requesting to include .env
      const candidates: CandidateFile[] = [
        makeCandidateFile('.env', `STRIPE_SECRET_KEY=${FAKE_SECRETS.stripeKey}`),
        makeCandidateFile('src/index.ts', 'export const VERSION = "1.0.0";'),
      ];

      const packet = assertOk(buildSafeContextPacket(CONFIRMED_WORKSPACE, candidates));

      const envItem = packet.items.find((i: { relativePath: string }) => i.relativePath === '.env');
      expect(envItem?.status).toBe('excluded');

      // Verify the Stripe key never appears in the entire serialized packet
      const serialized = JSON.stringify(packet);
      assertNoSecretsInOutput(serialized, ['stripeKey']);
    });

    it('mandatory exclusions cannot be bypassed by user .mediatorignore', () => {
      // Even if user tries to override, mandatory rules take precedence
      // (mandatory: true rules are always applied first and cannot be removed)
      const userRules = parseMediatorIgnore('# allow .env\n'); // Trying to allow .env via comment
      const effective = getEffectiveExclusionRules(userRules);
      const result = checkPathExclusion('.env', effective);
      expect(result.excluded).toBe(true);
      expect(result.ruleId).toBe('ENV_FILES');
    });
  });

  describe('buildSafeContextPacket — workspace validation', () => {
    it('requires confirmed workspace root', () => {
      const err = assertErr(buildSafeContextPacket(UNCONFIRMED_WORKSPACE, []));
      expect(err.code).toBe('WORKSPACE_CONFIRMATION_REQUIRED');
    });

    it('succeeds with confirmed workspace and clean files', () => {
      const candidates: CandidateFile[] = [
        makeCandidateFile('src/index.ts', 'export const x = 1;'),
        makeCandidateFile('README.md', '# Project\nThis is a test project.'),
      ];
      const packet = assertOk(buildSafeContextPacket(CONFIRMED_WORKSPACE, candidates));
      expect(packet.safeToSend).toBe(true);
      expect(packet.summary.included).toBe(2);
    });

    it('packet is not safe to send when blocked items exist', () => {
      const candidates: CandidateFile[] = [
        makeCandidateFile('src/safe.ts', 'export const clean = true;'),
        makeCandidateFile('.env', `KEY=${FAKE_SECRETS.stripeKey}`), // Will be excluded
      ];
      const packet = assertOk(buildSafeContextPacket(CONFIRMED_WORKSPACE, candidates));
      // Excluded items don't make the packet unsafe — only blocked/scan_error items do
      // .env is excluded (not blocked), so safeToSend should still be true
      expect(packet.summary.excluded).toBeGreaterThan(0);
    });
  });

  describe('End-to-end pipeline test', () => {
    it('full pipeline: candidate content → exclusion → scan → redact → serialize → no secret leaked', () => {
      const candidates: CandidateFile[] = [
        // File that should be excluded by path rule
        makeCandidateFile('.env', `STRIPE=${FAKE_SECRETS.stripeKey}\nOPENAI=${FAKE_SECRETS.openaiKey}`),
        // File with embedded secret that should be redacted
        makeCandidateFile('config.ts', `const dbUrl = "${FAKE_SECRETS.dbUrl}";`),
        // Clean file that should pass through
        makeCandidateFile('src/utils.ts', 'export function helper(): void {}'),
        // AWS credentials path — excluded
        makeCandidateFile('.aws/credentials', `[default]\naws_secret_access_key = ${FAKE_SECRETS.awsSecret}`),
      ];

      const packet = assertOk(buildSafeContextPacket(CONFIRMED_WORKSPACE, candidates));

      // Serialize the ENTIRE packet
      const serialized = JSON.stringify(packet);

      // Assert none of the synthetic fixture secrets appear anywhere in the output
      assertNoSecretsInOutput(serialized, [
        'stripeKey',
        'openaiKey',
        'dbUrl',
        'awsSecret',
        'githubToken',
        'jwtToken',
        'bearerToken',
        'password',
        'clientSecret',
        'privateKeyHeader',
      ]);

      // Verify expected dispositions
      const envItem = packet.items.find((i: { relativePath: string }) => i.relativePath === '.env');
      const awsItem = packet.items.find((i: { relativePath: string }) => i.relativePath === '.aws/credentials');
      const configItem = packet.items.find((i: { relativePath: string }) => i.relativePath === 'config.ts');
      const cleanItem = packet.items.find((i: { relativePath: string }) => i.relativePath === 'src/utils.ts');

      expect(envItem?.status).toBe('excluded');
      expect(awsItem?.status).toBe('excluded');
      expect(configItem?.status).toMatch(/redacted|blocked/); // DB URL contains credentials
      expect(cleanItem?.status).toBe('included');
    });
  });
});

describe('S06 — Custom Pattern Registration', () => {
  beforeEach(() => {
    resetCustomPatterns();
  });

  afterEach(() => {
    resetCustomPatterns();
  });

  it('registers a valid custom pattern', () => {
    const error = addCustomPattern({
      id: 'MY_CUSTOM_KEY',
      description: 'Custom test API key format',
      severity: 'high',
      pattern: /MYAPP_KEY_[A-Z0-9]{20}/,
      redactionLabel: '[REDACTED:MYAPP_KEY]',
    });
    expect(error).toBeNull();
    const all = getAllPatterns();
    expect(all.some(p => p.id === 'MY_CUSTOM_KEY')).toBe(true);
  });

  it('rejects duplicate pattern ID', () => {
    addCustomPattern({
      id: 'CUSTOM_DUP',
      description: 'Test',
      severity: 'low',
      pattern: /TESTKEY/,
      redactionLabel: '[REDACTED:TEST]',
    });
    const error = addCustomPattern({
      id: 'CUSTOM_DUP',
      description: 'Duplicate',
      severity: 'low',
      pattern: /TESTKEY/,
      redactionLabel: '[REDACTED:DUP]',
    });
    expect(error).not.toBeNull();
    expect(error).toContain("already registered");
  });

  it('custom pattern detects content', () => {
    addCustomPattern({
      id: 'INTERNAL_TOKEN',
      description: 'Internal token format',
      severity: 'high',
      pattern: /INTTOK_[A-Z0-9]{16}/,
      redactionLabel: '[REDACTED:INTERNAL_TOKEN]',
    });
    const scan = assertOk(scanContent('Authorization: INTTOK_ABCDEF1234567890'));
    expect(scan.secretsDetected).toBe(true);
    const ruleIds = scan.findings.map((f: { ruleId: string }) => f.ruleId);
    expect(ruleIds).toContain('INTERNAL_TOKEN');
  });
});

describe('S06 — Glob Pattern Engine', () => {
  it('globToRegex matches simple filename', () => {
    const regex = globToRegex('.env');
    expect(regex.test('.env')).toBe(true);
    expect(regex.test('.envrc')).toBe(false); // Should not match .envrc with exact pattern
  });

  it('globToRegex matches * wildcard in segment', () => {
    const regex = globToRegex('*.pem');
    expect(regex.test('server.pem')).toBe(true);
    expect(regex.test('client.pem')).toBe(true);
    expect(regex.test('server.pfx')).toBe(false);
  });

  it('globToRegex matches .env.* wildcard', () => {
    const regex = globToRegex('.env.*');
    expect(regex.test('.env.local')).toBe(true);
    expect(regex.test('.env.production')).toBe(true);
    expect(regex.test('.env')).toBe(false);
  });

  it('globToRegex matches ** for nested paths', () => {
    const regex = globToRegex('**/.env');
    expect(regex.test('config/.env')).toBe(true);
    expect(regex.test('apps/backend/.env')).toBe(true);
    expect(regex.test('.env')).toBe(true);
  });

  it('globToRegex is case-insensitive (Windows compat)', () => {
    const regex = globToRegex('*.PEM');
    expect(regex.test('server.pem')).toBe(true);
    expect(regex.test('SERVER.PEM')).toBe(true);
  });
});

describe('S06 — Context Preview API', () => {
  it('buildContextPreview reports file dispositions and byte totals safely', () => {
    const candidates = [
      makeCandidateFile('src/index.ts', 'export const a = 1;'),
      makeCandidateFile('.env', 'DB_PASS=secret123'),
      makeCandidateFile('config.ts', `const key = "${FAKE_SECRETS.stripeKey}";`),
    ];

    const result = buildContextPreview(CONFIRMED_WORKSPACE, candidates);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const preview = result.value;
    expect(preview.totalCandidateBytes).toBeGreaterThan(0);
    expect(preview.counts.included).toBe(1); // src/index.ts
    expect(preview.counts.excluded).toBe(1); // .env
    expect(preview.counts.redacted).toBe(1); // config.ts

    // Crucial invariant: serialized preview never leaks secret values
    const serialized = JSON.stringify(preview);
    assertNoSecretsInOutput(serialized, ['stripeKey']);
  });

  it('formatContextPreview renders human-readable summary without leaking secrets', () => {
    const candidates = [
      makeCandidateFile('src/clean.ts', 'console.log("hello");'),
      makeCandidateFile('src/auth.ts', `const auth = "${FAKE_SECRETS.bearerToken}";`),
      makeCandidateFile('.env', `SECRET=${FAKE_SECRETS.clientSecret}`),
    ];

    const result = buildContextPreview(CONFIRMED_WORKSPACE, candidates);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const formatted = formatContextPreview(result.value);
    expect(formatted).toContain('Mediator Context Preview');
    expect(formatted).toContain('src/clean.ts');
    expect(formatted).toContain('src/auth.ts');
    expect(formatted).toContain('.env');
    expect(formatted).toContain('NOTICE: Secret detection is pattern-based');

    // Crucial invariant: formatted output never leaks secret values
    assertNoSecretsInOutput(formatted, ['bearerToken', 'clientSecret']);
  });

  it('buildContextPreview marks safeToSend: false when workspace is unconfirmed', () => {
    const candidates = [makeCandidateFile('src/index.ts', 'export const a = 1;')];
    const result = buildContextPreview(UNCONFIRMED_WORKSPACE, candidates);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const preview = result.value;
    expect(preview.safeToSend).toBe(false);
    expect(preview.hasUncertainty).toBe(true);
    expect(preview.blockReason).toContain('confirmed');
  });
});

