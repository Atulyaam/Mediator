/**
 * @mediator/context-security — Secret Patterns (S06)
 *
 * Defines recognizable secret patterns for content-level scanning.
 *
 * IMPORTANT LIMITATION: Pattern matching cannot identify every possible secret.
 * Unknown or obfuscated secrets will not be detected. This is a best-effort
 * defence layer, NOT a guarantee of complete secret detection.
 *
 * Design principles:
 * - Never log, emit, or store matched secret values.
 * - Return structured findings with rule metadata only.
 * - Allow extensible user-defined pattern registration with validation.
 */

export type SecretSeverity = 'critical' | 'high' | 'medium' | 'low';

/**
 * A single scannable pattern rule.
 * The `pattern` regex must NOT use capturing groups on the secret itself —
 * matched secret content is never stored in findings.
 */
export interface SecretPatternRule {
  /** Unique stable identifier, e.g. 'PRIVATE_KEY_BLOCK' */
  readonly id: string;
  /** Human-readable description (safe to include in logs/findings) */
  readonly description: string;
  /** Severity level */
  readonly severity: SecretSeverity;
  /**
   * Regex to detect secret-bearing content.
   * Must be anchored appropriately and avoid catastrophic backtracking.
   * Do NOT embed raw matched values in error messages when triggered.
   */
  readonly pattern: RegExp;
  /**
   * A safe placeholder label used in redacted output.
   * Example: '[REDACTED:PRIVATE_KEY]'
   */
  readonly redactionLabel: string;
  /**
   * Whether this rule is enabled by default.
   * User-defined rules default to true.
   */
  readonly enabled: boolean;
}

// ─── Built-in default pattern registry ────────────────────────────────────

/**
 * Default secret-detection patterns.
 *
 * DETECTION LIMITATION: These patterns cover common high-signal formats.
 * Context-specific tokens, obfuscated or custom formats will NOT be detected.
 */
export const DEFAULT_SECRET_PATTERNS: readonly SecretPatternRule[] = [
  // ── Private key blocks ────────────────────────────────────────────────
  {
    id: 'PRIVATE_KEY_BLOCK',
    description: 'PEM private key block (RSA, EC, Ed25519, PKCS8, OpenSSH)',
    severity: 'critical',
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/i,
    redactionLabel: '[REDACTED:PRIVATE_KEY]',
    enabled: true,
  },
  {
    id: 'CERTIFICATE_BLOCK',
    description: 'PEM certificate — may contain private key material in combined files',
    severity: 'medium',
    pattern: /-----BEGIN CERTIFICATE-----/i,
    redactionLabel: '[REDACTED:CERTIFICATE]',
    enabled: true,
  },

  // ── Authorization headers ─────────────────────────────────────────────
  {
    id: 'AUTH_BEARER_TOKEN',
    description: 'HTTP Authorization header with bearer token',
    severity: 'critical',
    pattern: /\bAuthorization\s*:\s*Bearer\s+[A-Za-z0-9\-._~+/]+=*/i,
    redactionLabel: '[REDACTED:AUTH_TOKEN]',
    enabled: true,
  },
  {
    id: 'AUTH_BASIC',
    description: 'HTTP Basic Authorization header',
    severity: 'critical',
    pattern: /\bAuthorization\s*:\s*Basic\s+[A-Za-z0-9+/]+=*/i,
    redactionLabel: '[REDACTED:BASIC_AUTH]',
    enabled: true,
  },

  // ── Common API key formats ─────────────────────────────────────────────
  {
    id: 'STRIPE_SECRET_KEY',
    description: 'Stripe secret or restricted key (sk_live_, sk_test_, rk_live_)',
    severity: 'critical',
    pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{24,}/,
    redactionLabel: '[REDACTED:STRIPE_KEY]',
    enabled: true,
  },
  {
    id: 'STRIPE_PUBLISHABLE_KEY',
    description: 'Stripe publishable key (pk_live_, pk_test_)',
    severity: 'high',
    pattern: /\bpk_(?:live|test)_[A-Za-z0-9]{24,}/,
    redactionLabel: '[REDACTED:STRIPE_PK]',
    enabled: true,
  },
  {
    id: 'OPENAI_API_KEY',
    description: 'OpenAI API key format (sk-proj- or sk-)',
    severity: 'critical',
    pattern: /\bsk-(?:proj-)?[A-Za-z0-9]{20,}/,
    redactionLabel: '[REDACTED:OPENAI_KEY]',
    enabled: true,
  },
  {
    id: 'GITHUB_TOKEN',
    description: 'GitHub personal access token or app token',
    severity: 'critical',
    pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}/,
    redactionLabel: '[REDACTED:GITHUB_TOKEN]',
    enabled: true,
  },
  {
    id: 'GOOGLE_API_KEY',
    description: 'Google API key prefix AIza',
    severity: 'high',
    pattern: /\bAIza[A-Za-z0-9\-_]{35}/,
    redactionLabel: '[REDACTED:GOOGLE_API_KEY]',
    enabled: true,
  },

  // ── Cloud provider credentials ─────────────────────────────────────────
  {
    id: 'AWS_ACCESS_KEY',
    description: 'AWS access key ID',
    severity: 'critical',
    pattern: /\b(?:A3T[A-Z0-9]|AKIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASIA)[A-Z0-9]{16}\b/,
    redactionLabel: '[REDACTED:AWS_ACCESS_KEY]',
    enabled: true,
  },
  {
    id: 'AWS_SECRET_KEY',
    description: 'AWS secret access key (40-char base64-like value in env context)',
    severity: 'critical',
    pattern: /(?:aws_secret_access_key|AWS_SECRET_ACCESS_KEY)\s*[=:]\s*[A-Za-z0-9/+]{40}/i,
    redactionLabel: '[REDACTED:AWS_SECRET_KEY]',
    enabled: true,
  },
  {
    id: 'AZURE_CONNECTION_STRING',
    description: 'Azure storage or service bus connection string',
    severity: 'critical',
    pattern: /DefaultEndpointsProtocol=https?;AccountName=[^;]+;AccountKey=[A-Za-z0-9+/=]{40,}/i,
    redactionLabel: '[REDACTED:AZURE_CONN_STRING]',
    enabled: true,
  },
  {
    id: 'GCP_SERVICE_ACCOUNT_KEY',
    description: 'GCP service account private key JSON field',
    severity: 'critical',
    pattern: /"private_key"\s*:\s*"-----BEGIN/,
    redactionLabel: '[REDACTED:GCP_SA_KEY]',
    enabled: true,
  },

  // ── Database connection strings ────────────────────────────────────────
  {
    id: 'DATABASE_URL_WITH_CREDENTIALS',
    description: 'Database connection string with embedded username and password',
    severity: 'critical',
    pattern: /(?:postgresql|postgres|mysql|mongodb|redis|mssql):\/\/[^:@\s]+:[^@\s]+@/i,
    redactionLabel: '[REDACTED:DB_CREDENTIALS]',
    enabled: true,
  },

  // ── Env-var style credential assignments ─────────────────────────────────
  {
    id: 'PASSWORD_ASSIGNMENT',
    description: 'Variable assignment containing password/passwd/pwd/pass with non-empty value',
    severity: 'high',
    pattern: /(?:^|\b)(?:PASSWORD|PASSWD|PWD|PASS)\s*[=:]\s*(?!['"]\s*['"])["']?[^\s"']{6,}/im,
    redactionLabel: '[REDACTED:PASSWORD]',
    enabled: true,
  },
  {
    id: 'SECRET_ASSIGNMENT',
    description: 'Variable assignment containing secret/client_secret',
    severity: 'high',
    pattern: /(?:^|\b)(?:SECRET|CLIENT_SECRET|CLIENT_SECRET_KEY|API_SECRET)\s*[=:]\s*["']?[^\s"']{8,}/im,
    redactionLabel: '[REDACTED:SECRET]',
    enabled: true,
  },
  {
    id: 'TOKEN_ASSIGNMENT',
    description: 'Variable assignment containing token/access_token',
    severity: 'high',
    pattern: /(?:^|\b)(?:TOKEN|ACCESS_TOKEN|REFRESH_TOKEN|AUTH_TOKEN|SESSION_TOKEN)\s*[=:]\s*["']?[A-Za-z0-9\-._~+/=]{16,}/im,
    redactionLabel: '[REDACTED:TOKEN]',
    enabled: true,
  },
  {
    id: 'OAUTH_CLIENT_SECRET',
    description: 'OAuth client_secret assignment or JSON field',
    severity: 'critical',
    pattern: /["']?client_secret["']?\s*[=:]\s*["']?[A-Za-z0-9\-_]{16,}/i,
    redactionLabel: '[REDACTED:OAUTH_SECRET]',
    enabled: true,
  },

  // ── JWT tokens ─────────────────────────────────────────────────────────
  {
    id: 'JWT_TOKEN',
    description: 'JSON Web Token (three base64url parts separated by dots)',
    severity: 'high',
    pattern: /\beyJ[A-Za-z0-9\-_]+\.eyJ[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_.+/=]+/,
    redactionLabel: '[REDACTED:JWT]',
    enabled: true,
  },

  // ── SSH and private key material ──────────────────────────────────────
  {
    id: 'SSH_PRIVATE_KEY_LINE',
    description: 'Raw base64 SSH private key line (long high-entropy line after key header)',
    severity: 'critical',
    pattern: /^[A-Za-z0-9+/]{64,}={0,2}$/m,
    redactionLabel: '[REDACTED:KEY_MATERIAL]',
    enabled: false, // Disabled by default — high false-positive rate for base64 content
  },

  // ── Generic high-entropy detection ────────────────────────────────────
  // NOTE: Intentionally omitted from defaults — too many false positives.
  // Users may register entropy-based rules via addCustomPattern().
];

// ─── Custom pattern registry ───────────────────────────────────────────────

const _customPatterns: SecretPatternRule[] = [];

/**
 * Register a user-defined secret detection pattern.
 *
 * Requirements:
 * - `id` must be unique across default and custom patterns.
 * - `pattern` must be a valid RegExp (will throw if invalid).
 * - Custom patterns with catastrophically backtracking regexes are the
 *   caller's responsibility to validate before registering.
 *
 * Returns an error string if registration fails, null on success.
 */
export function addCustomPattern(rule: Omit<SecretPatternRule, 'enabled'>): string | null {
  const allIds = getAllPatterns().map(r => r.id);
  if (allIds.includes(rule.id)) {
    return `Pattern ID '${rule.id}' is already registered. Use a unique ID.`;
  }
  if (!(rule.pattern instanceof RegExp)) {
    return `Pattern for '${rule.id}' must be a RegExp instance.`;
  }
  _customPatterns.push({ ...rule, enabled: true });
  return null;
}

/**
 * Remove a previously registered custom pattern by ID.
 * Default patterns cannot be removed via this function.
 */
export function removeCustomPattern(id: string): boolean {
  const idx = _customPatterns.findIndex(r => r.id === id);
  if (idx === -1) return false;
  _customPatterns.splice(idx, 1);
  return true;
}

/**
 * Get all enabled patterns (defaults + custom).
 * Only enabled rules are returned.
 */
export function getAllPatterns(): SecretPatternRule[] {
  return [...DEFAULT_SECRET_PATTERNS, ..._customPatterns].filter(r => r.enabled);
}

/**
 * Reset custom patterns (useful for testing).
 * Does not affect default patterns.
 */
export function resetCustomPatterns(): void {
  _customPatterns.length = 0;
}
