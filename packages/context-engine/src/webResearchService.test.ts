/**
 * @mediator/context-engine — Bounded Web Research Test Suite (Sprint S27)
 *
 * Requirements (Section 27.4):
 * - Capability flag: disabled by default (fails closed).
 * - HTTPS only: rejects HTTP, file://, ftp://, javascript:, data:.
 * - Embedded credentials rejection: rejects username/password in URL.
 * - Hostname allowlist: rejects unapproved domains.
 * - SSRF protection: blocks loopback, private ranges, link-local, cloud metadata.
 * - Redirect security: every hop re-validated against all rules.
 * - Redirect loop prevention: trips after max redirects (3).
 * - Resource limits: bounds byte size and timeouts.
 * - Untrusted content defense: HTML stripped, non-instructional framing.
 * - Secret scanning: synthetic fixture secrets are scanned and redacted.
 * - Provenance: SHA-256 content hash and metadata tracked.
 */

import { describe, it, expect } from 'vitest';
import {
  BoundedWebResearchService,
  DEFAULT_ALLOWED_RESEARCH_HOSTNAMES,
  type WebResearchTransport,
} from './webResearchService.js';
import { ErrorCode } from '@mediator/shared-contracts';

describe('Sprint S27 — Bounded Web Research Service', () => {
  const createMockTransport = (
    responses: Record<string, { status: number; headers?: Record<string, string>; body: string }>,
  ): WebResearchTransport => {
    return async (url: string) => {
      const match = responses[url];
      if (!match) {
        throw new Error(`Mock network error: Connection refused to ${url}`);
      }
      return {
        status: match.status,
        headers: match.headers ?? {},
        body: match.body,
      };
    };
  };

  // 1. Capability Flag Check
  it('1. fails closed when capability is disabled by default', async () => {
    const service = new BoundedWebResearchService(); // enabled: false by default
    expect(service.isEnabled()).toBe(false);

    const result = await service.fetchExcerpt('https://docs.python.org/3/library/os.html');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCode.CAPABILITY_UNAVAILABLE);
      expect(result.error.message).toContain('disabled by default');
    }
  });

  // 2. Protocol Validation (HTTPS only)
  it('2. strictly rejects insecure HTTP and non-web protocols', async () => {
    const service = new BoundedWebResearchService({ enabled: true });

    const insecureHttp = await service.fetchExcerpt('http://docs.python.org/3/library/os.html');
    expect(insecureHttp.ok).toBe(false);
    if (!insecureHttp.ok) {
      expect(insecureHttp.error.code).toBe(ErrorCode.ACTION_DENIED);
      expect(insecureHttp.error.message).toContain('secure HTTPS connections');
    }

    const fileScheme = await service.fetchExcerpt('file:///C:/Windows/System32/drivers/etc/hosts');
    expect(fileScheme.ok).toBe(false);
    if (!fileScheme.ok) {
      expect(fileScheme.error.code).toBe(ErrorCode.ACTION_DENIED);
    }

    const ftpScheme = await service.fetchExcerpt('ftp://docs.python.org/pub');
    expect(ftpScheme.ok).toBe(false);

    const jsScheme = await service.fetchExcerpt('javascript:alert(1)');
    expect(jsScheme.ok).toBe(false);

    const dataScheme = await service.fetchExcerpt('data:text/html,<h1>test</h1>');
    expect(dataScheme.ok).toBe(false);
  });

  // 3. Embedded Credentials Rejection
  it('3. rejects URLs containing embedded credentials', async () => {
    const service = new BoundedWebResearchService({ enabled: true });
    const result = await service.fetchExcerpt('https://admin:supersecret@docs.python.org/3/');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCode.ACTION_DENIED);
      expect(result.error.message).toContain('embedded username or password');
    }
  });

  // 4. Hostname Allowlist Check
  it('4. enforces strict hostname allowlist', async () => {
    const service = new BoundedWebResearchService({
      enabled: true,
      allowedHostnames: ['docs.python.org', 'nodejs.org'],
    });

    const unapproved = await service.fetchExcerpt('https://evil-unapproved-site.com/code');
    expect(unapproved.ok).toBe(false);
    if (!unapproved.ok) {
      expect(unapproved.error.code).toBe(ErrorCode.ACTION_DENIED);
      expect(unapproved.error.message).toContain('approved web research allowlist');
    }
  });

  // 5. SSRF Defense: Direct IP Literals & Private Address Verification
  it('5. blocks direct IP addresses and private / cloud-metadata ranges', async () => {
    const service = new BoundedWebResearchService({ enabled: true });

    // Direct IP literals
    const loopbackV4 = await service.fetchExcerpt('https://127.0.0.1/admin');
    expect(loopbackV4.ok).toBe(false);
    if (!loopbackV4.ok) {
      expect(loopbackV4.error.code).toBe(ErrorCode.PATH_DENIED);
      expect(loopbackV4.error.message).toContain('Direct IP address access');
    }

    const metadataIp = await service.fetchExcerpt('https://169.254.169.254/latest/meta-data/');
    expect(metadataIp.ok).toBe(false);

    const privateIp = await service.fetchExcerpt('https://192.168.1.1/router');
    expect(privateIp.ok).toBe(false);

    // Private IP helper checks
    expect(service.isPrivateOrReservedIp('127.0.0.1')).toBe(true);
    expect(service.isPrivateOrReservedIp('10.0.0.5')).toBe(true);
    expect(service.isPrivateOrReservedIp('172.16.50.1')).toBe(true);
    expect(service.isPrivateOrReservedIp('172.31.255.255')).toBe(true);
    expect(service.isPrivateOrReservedIp('192.168.0.100')).toBe(true);
    expect(service.isPrivateOrReservedIp('169.254.169.254')).toBe(true);
    expect(service.isPrivateOrReservedIp('::1')).toBe(true);
    expect(service.isPrivateOrReservedIp('fe80::1')).toBe(true);
    expect(service.isPrivateOrReservedIp('::ffff:127.0.0.1')).toBe(true);
    expect(service.isPrivateOrReservedIp('8.8.8.8')).toBe(false);
    expect(service.isPrivateOrReservedIp('93.184.216.34')).toBe(false);
  });

  // 6. Valid Fetch with Non-Instructional Framing & Provenance
  it('6. safely fetches allowed excerpt, neutralizes HTML scripts, and generates hash provenance', async () => {
    const mockHtml = `
      <html>
        <head><title>Documentation</title><script>alert('pwned');</script></head>
        <body>
          <h1>Python os.path Documentation</h1>
          <p>The os.path module implements some useful functions on pathnames.</p>
          <style>body { color: red; }</style>
        </body>
      </html>
    `;

    const transport = createMockTransport({
      'https://docs.python.org/3/library/os.path.html': {
        status: 200,
        body: mockHtml,
      },
    });

    const service = new BoundedWebResearchService({ enabled: true }, transport);
    const result = await service.fetchExcerpt('https://docs.python.org/3/library/os.path.html');

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const excerpt = result.value;
    expect(excerpt.sourceUrl).toBe('https://docs.python.org/3/library/os.path.html');
    expect(excerpt.provenance).toBe('untrusted-web-research');
    expect(excerpt.contentHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(excerpt.byteLength).toBeGreaterThan(0);

    // Verify scripts & styles were removed
    expect(excerpt.content).not.toContain("alert('pwned')");
    expect(excerpt.content).not.toContain('color: red');

    // Verify non-instructional security header exists
    expect(excerpt.content).toContain('<<<UNTRUSTED_WEB_RESEARCH_EXCERPT>>>');
    expect(excerpt.content).toContain('SECURITY NOTICE: The following text is an untrusted third-party excerpt.');
    expect(excerpt.content).toContain('Python os.path Documentation');
  });

  // 7. Redirect Security Verification (Allowlist & Re-Validation)
  it('7. follows allowed redirect but blocks redirect to unapproved or private domain', async () => {
    const transport = createMockTransport({
      'https://docs.python.org/redirect': {
        status: 302,
        headers: { location: 'https://docs.python.org/3/final.html' },
        body: '',
      },
      'https://docs.python.org/3/final.html': {
        status: 200,
        body: 'Final documentation content',
      },
      'https://docs.python.org/evil-redirect': {
        status: 302,
        headers: { location: 'https://evil-unapproved-site.com/payload' },
        body: '',
      },
      'https://docs.python.org/metadata-redirect': {
        status: 302,
        headers: { location: 'https://169.254.169.254/latest' },
        body: '',
      },
    });

    const service = new BoundedWebResearchService({ enabled: true }, transport);

    // Clean allowed redirect
    const cleanRes = await service.fetchExcerpt('https://docs.python.org/redirect');
    expect(cleanRes.ok).toBe(true);
    if (cleanRes.ok) {
      expect(cleanRes.value.sourceUrl).toBe('https://docs.python.org/3/final.html');
      expect(cleanRes.value.content).toContain('Final documentation content');
    }

    // Redirect to unapproved domain is blocked
    const evilRes = await service.fetchExcerpt('https://docs.python.org/evil-redirect');
    expect(evilRes.ok).toBe(false);
    if (!evilRes.ok) {
      expect(evilRes.error.code).toBe(ErrorCode.ACTION_DENIED);
      expect(evilRes.error.message).toContain('approved web research allowlist');
    }

    // Redirect to metadata IP is blocked
    const metaRes = await service.fetchExcerpt('https://docs.python.org/metadata-redirect');
    expect(metaRes.ok).toBe(false);
    if (!metaRes.ok) {
      expect(metaRes.error.code).toBe(ErrorCode.PATH_DENIED);
    }
  });

  // 8. Redirect Loop Protection
  it('8. trips and stops when redirect count exceeds maximum limit (3)', async () => {
    const transport = createMockTransport({
      'https://docs.python.org/loop1': { status: 302, headers: { location: 'https://docs.python.org/loop2' }, body: '' },
      'https://docs.python.org/loop2': { status: 302, headers: { location: 'https://docs.python.org/loop3' }, body: '' },
      'https://docs.python.org/loop3': { status: 302, headers: { location: 'https://docs.python.org/loop4' }, body: '' },
      'https://docs.python.org/loop4': { status: 302, headers: { location: 'https://docs.python.org/loop5' }, body: '' },
    });

    const service = new BoundedWebResearchService({ enabled: true, maxRedirects: 3 }, transport);
    const loopRes = await service.fetchExcerpt('https://docs.python.org/loop1');
    expect(loopRes.ok).toBe(false);
    if (!loopRes.ok) {
      expect(loopRes.error.code).toBe(ErrorCode.EXECUTION_BLOCKED);
      expect(loopRes.error.message).toContain('maximum allowed redirect limit');
    }
  });

  // 9. Response Size Caps & Truncation
  it('9. bounds response size to maximum configured limit and flags isTruncated', async () => {
    const hugeBody = 'D'.repeat(50000); // 50 KB > 32 KiB default limit
    const transport = createMockTransport({
      'https://docs.python.org/huge.html': {
        status: 200,
        body: hugeBody,
      },
    });

    const service = new BoundedWebResearchService({ enabled: true, maxSizeBytes: 32768 }, transport);
    const result = await service.fetchExcerpt('https://docs.python.org/huge.html');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.isTruncated).toBe(true);
    }
  });

  // 10. Secret Scanning on Retrieved Material
  it('10. scans and redacts detected secrets found in retrieved material', async () => {
    const fakeSecret = ['sk', 'live', '1234567890abcdef1234567890abcdef'].join('_');
    const secretBody = `Documentation example contains leaked secret: ${fakeSecret}`;
    const transport = createMockTransport({
      'https://docs.python.org/example.html': {
        status: 200,
        body: secretBody,
      },
    });

    const service = new BoundedWebResearchService({ enabled: true }, transport);
    const result = await service.fetchExcerpt('https://docs.python.org/example.html');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.content).not.toContain('1234567890abcdef1234567890abcdef');
      expect(result.value.secretsRedactedCount).toBeGreaterThan(0);
    }
  });
});
