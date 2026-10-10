/**
 * @mediator/context-security — Path Exclusions (S06)
 *
 * Defines mandatory sensitive path exclusion lists.
 *
 * Security invariant: An excluded path must remain excluded even if the AI
 * explicitly requests that file. Exclusions are enforced BEFORE reading
 * file content — do not read a file merely to check if it contains secrets.
 *
 * Exclusion matching uses glob-style patterns and is case-insensitive where
 * appropriate for Windows file systems.
 *
 * NOTE: Exclusions only block files from entering AI-bound context packets.
 * They do NOT override S04/S05 workspace containment security enforcement.
 * Security enforcement (S04/S05) applies to ALL file operations including
 * the exclusion checking infrastructure itself.
 */

import * as path from 'path';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface ExclusionRule {
  /** Unique stable identifier */
  readonly id: string;
  /** Human-readable description (safe to log) */
  readonly description: string;
  /**
   * Glob pattern(s) for matching.
   * Patterns are matched case-insensitively.
   * `**` matches any number of path segments.
   * `*` matches within a single path segment.
   */
  readonly patterns: readonly string[];
  /** Whether this exclusion can be overridden by user .mediatorignore patterns */
  readonly mandatory: boolean;
}

export interface ExclusionResult {
  /** Whether the path is excluded */
  readonly excluded: boolean;
  /** The rule that caused the exclusion (if excluded) */
  readonly ruleId?: string | undefined;
  /** Human-readable reason (safe to display, no secrets) */
  readonly reason?: string | undefined;
}

// ─── Mandatory default exclusion registry ─────────────────────────────────

/**
 * Built-in exclusions that apply to all Mediator workspaces.
 * These are MANDATORY and cannot be removed by user configuration.
 * Adding to this list via .mediatorignore is supported; removing is not.
 */
export const MANDATORY_EXCLUSIONS: readonly ExclusionRule[] = [
  // ── Environment files ────────────────────────────────────────────────
  {
    id: 'ENV_FILES',
    description: 'Environment variable files (.env, .env.*, .env.local, etc.)',
    patterns: ['.env', '.env.*', '**/.env', '**/.env.*'],
    mandatory: true,
  },

  // ── Cryptographic key material ──────────────────────────────────────
  {
    id: 'PEM_KEYS',
    description: 'PEM certificate and key files',
    patterns: ['*.pem', '**/*.pem'],
    mandatory: true,
  },
  {
    id: 'KEY_FILES',
    description: 'Private key files (.key, .pfx, .p12)',
    patterns: ['*.key', '**/*.key', '*.pfx', '**/*.pfx', '*.p12', '**/*.p12'],
    mandatory: true,
  },
  {
    id: 'SSH_KEYS',
    description: 'SSH private key files',
    patterns: [
      'id_rsa', '**/id_rsa',
      'id_ed25519', '**/id_ed25519',
      'id_ecdsa', '**/id_ecdsa',
      'id_dsa', '**/id_dsa',
      '.ssh/**', '**/.ssh/**',
    ],
    mandatory: true,
  },

  // ── Package manager credentials ──────────────────────────────────────
  {
    id: 'NPM_RC',
    description: 'npm authentication configuration',
    patterns: ['.npmrc', '**/.npmrc'],
    mandatory: true,
  },
  {
    id: 'PYPI_RC',
    description: 'PyPI authentication configuration',
    patterns: ['.pypirc', '**/.pypirc'],
    mandatory: true,
  },
  {
    id: 'NETRC',
    description: 'netrc credential file',
    patterns: ['.netrc', '**/.netrc', '_netrc', '**/_netrc'],
    mandatory: true,
  },

  // ── Cloud provider credential files ─────────────────────────────────
  {
    id: 'AWS_CREDENTIALS',
    description: 'AWS credential directory and config files',
    patterns: ['.aws/**', '**/.aws/**', '.aws/credentials', '**/.aws/credentials'],
    mandatory: true,
  },
  {
    id: 'KUBE_CONFIG',
    description: 'Kubernetes configuration with cluster credentials',
    patterns: ['.kube/config', '**/.kube/config', '.kube/**', '**/.kube/**'],
    mandatory: true,
  },
  {
    id: 'DOCKER_CONFIG',
    description: 'Docker registry auth configuration',
    patterns: ['.docker/config.json', '**/.docker/config.json', '.docker/**', '**/.docker/**'],
    mandatory: true,
  },
  {
    id: 'GIT_CONFIG',
    description: 'Git configuration which may contain credentials or tokens',
    patterns: ['.git/config', '**/.git/config'],
    mandatory: true,
  },

  // ── Infrastructure secrets ──────────────────────────────────────────
  {
    id: 'TERRAFORM_STATE',
    description: 'Terraform state files containing resource secrets',
    patterns: [
      '*.tfstate', '**/*.tfstate',
      '*.tfstate.*', '**/*.tfstate.*',
      'terraform.tfvars', '**/terraform.tfvars',
      '*.tfvars', '**/*.tfvars',
    ],
    mandatory: true,
  },

  // ── Service account / credential JSON ───────────────────────────────
  {
    id: 'SERVICE_ACCOUNT_JSON',
    description: 'Google Cloud / Firebase service account JSON files',
    patterns: [
      'credentials.json', '**/credentials.json',
      'service-account*.json', '**/service-account*.json',
      'service_account*.json', '**/service_account*.json',
      '*-service-account.json', '**/*-service-account.json',
    ],
    mandatory: true,
  },

  // ── Application settings (may embed connection strings) ──────────────
  {
    id: 'APP_SETTINGS_SECRETS',
    description: 'ASP.NET appsettings files for non-development environments',
    patterns: [
      'appsettings.Production.json', '**/appsettings.Production.json',
      'appsettings.Staging.json', '**/appsettings.Staging.json',
      'appsettings.*.json', '**/appsettings.*.json',
    ],
    mandatory: true,
  },

  // ── Password databases ───────────────────────────────────────────────
  {
    id: 'KEEPASS_DB',
    description: 'KeePass password database files',
    patterns: ['*.kdbx', '**/*.kdbx'],
    mandatory: true,
  },

  // ── Browser profiles (contain cookies, saved passwords, tokens) ──────
  {
    id: 'BROWSER_PROFILES',
    description: 'Browser profile directories with saved credentials',
    patterns: [
      '**/Chrome/User Data/**',
      '**/Chromium/User Data/**',
      '**/Firefox/Profiles/**',
      '**/BraveSoftware/**',
      '**/Microsoft/Edge/User Data/**',
      '**/AppData/Local/Google/**',
      '**/AppData/Roaming/Mozilla/**',
    ],
    mandatory: true,
  },

  // ── OS credential stores and token caches ────────────────────────────
  {
    id: 'OS_CREDENTIAL_STORES',
    description: 'OS-level credential caches and token stores',
    patterns: [
      '**/.config/gcloud/**',        // GCP application default credentials
      '**/.azure/**',                // Azure CLI credentials
      '**/azure-credentials.json',
      '**/.local/share/keyrings/**', // Linux keyring
      '**/Library/Keychains/**',     // macOS keychain
      '**/AppData/Roaming/npm/**',   // npm token cache on Windows
      '**/tokens.json',
      '**/token_cache.json',
      '**/*_token_cache*',
    ],
    mandatory: true,
  },

  // ── Known credential directory names ────────────────────────────────
  {
    id: 'SECRETS_DIRECTORIES',
    description: 'Directories named secrets, credentials, or private',
    patterns: [
      'secrets/**', '**/secrets/**',
      'credentials/**', '**/credentials/**',
      '.secrets/**', '**/.secrets/**',
    ],
    mandatory: true,
  },
];

// ─── Glob matching implementation ─────────────────────────────────────────

/**
 * Convert a glob pattern to a RegExp for matching.
 * Supports: `**` (any depth), `*` (within segment), `?` (any char), literals.
 * Matching is always case-insensitive (for Windows compat).
 */
export function globToRegex(glob: string): RegExp {
  // Normalize path separators in the glob to forward slashes
  const normalizedGlob = glob.replace(/\\/g, '/');

  // Escape regex special chars except * and ?
  let regexStr = normalizedGlob
    .replace(/[.+^${}()|[\]]/g, '\\$&')
    .replace(/\*\*/g, '___DOUBLESTAR___') // Temporarily replace **
    .replace(/\*/g, '[^/]*')               // * = any chars within a segment
    .replace(/\?/g, '[^/]')                // ? = any single char within segment
    .replace(/___DOUBLESTAR___\//g, '(?:.+/)?')  // **/ = any depth prefix
    .replace(/___DOUBLESTAR___/g, '.*');          // ** = any chars including /

  // Anchor: pattern must match the full relative path OR just the filename
  // We match if the end of the path matches (for relative patterns without leading **)
  if (!normalizedGlob.startsWith('*') && !normalizedGlob.startsWith('/')) {
    // Allow matching at any depth by optionally prepending path
    regexStr = `(?:.*\\/)?${regexStr}`;
  }

  return new RegExp(`^${regexStr}$`, 'i');
}

/**
 * Normalize a file path for exclusion checking:
 * - Convert backslashes to forward slashes
 * - Remove leading slash/drive prefix to get a relative form for pattern matching
 */
export function normalizePathForExclusion(filePath: string): string {
  // Normalize separators
  let normalized = filePath.replace(/\\/g, '/');
  // Remove leading drive letter (C:/) or leading slash for pattern matching
  normalized = normalized.replace(/^[A-Za-z]:\//, '');
  normalized = normalized.replace(/^\//, '');
  return normalized;
}

/**
 * Check whether a given relative path (within workspace) matches any
 * exclusion rule in the provided list.
 *
 * @param relativePath - Path relative to workspace root (forward slashes)
 * @param rules - Exclusion rules to check against
 */
export function checkPathExclusion(
  relativePath: string,
  rules: readonly ExclusionRule[],
): ExclusionResult {
  const normalized = normalizePathForExclusion(relativePath);
  // Also check just the filename component for simple filename patterns
  const filename = normalized.includes('/') ? normalized.split('/').pop()! : normalized;

  for (const rule of rules) {
    for (const pattern of rule.patterns) {
      const regex = globToRegex(pattern);
      if (regex.test(normalized) || regex.test(filename)) {
        return {
          excluded: true,
          ruleId: rule.id,
          reason: rule.description,
        };
      }
    }
  }

  return { excluded: false };
}

// ─── .mediatorignore support ──────────────────────────────────────────────

/**
 * Parse a .mediatorignore file content into additional exclusion rules.
 *
 * Format: one glob pattern per line, # comments, blank lines ignored.
 *
 * Security constraints:
 * - .mediatorignore can ONLY ADD additional context exclusions.
 * - It CANNOT grant filesystem access beyond S04/S05 workspace boundary.
 * - It CANNOT override mandatory exclusion rules.
 * - Patterns that would include mandatory excluded paths are silently ignored.
 *
 * @param content - Raw text content of .mediatorignore
 * @returns Array of user-defined exclusion rules
 */
export function parseMediatorIgnore(content: string): ExclusionRule[] {
  const lines = content.split(/\r?\n/);
  const patterns: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    // Skip blank lines and comments
    if (!trimmed || trimmed.startsWith('#')) continue;
    // Skip patterns that look like absolute paths — cannot grant outside access
    if (/^[A-Za-z]:[\\/]/.test(trimmed) || trimmed.startsWith('/')) continue;
    // Skip patterns containing ..  — traversal disallowed
    if (trimmed.includes('..')) continue;

    patterns.push(trimmed);
  }

  if (patterns.length === 0) return [];

  return [
    {
      id: 'MEDIATORIGNORE_USER',
      description: 'User-defined exclusion from .mediatorignore',
      patterns,
      mandatory: false,
    },
  ];
}

/**
 * Get the effective exclusion rule set for a context operation.
 * Combines mandatory exclusions with optional user-defined patterns.
 *
 * @param userRules - Additional rules from .mediatorignore (may be empty)
 */
export function getEffectiveExclusionRules(
  userRules: readonly ExclusionRule[] = [],
): readonly ExclusionRule[] {
  return [...MANDATORY_EXCLUSIONS, ...userRules];
}

/**
 * Convenience: check a path against the full effective exclusion set.
 *
 * @param relativePath - Path relative to workspace root
 * @param userRules - Additional rules from .mediatorignore
 */
export function isPathExcluded(
  relativePath: string,
  userRules: readonly ExclusionRule[] = [],
): ExclusionResult {
  return checkPathExclusion(relativePath, getEffectiveExclusionRules(userRules));
}

/**
 * Validate that a path segment does not escape the workspace root.
 * Used internally to guard .mediatorignore pattern application.
 * Returns true if the path is safe to process (no traversal).
 */
export function isRelativePathSafe(relativePath: string): boolean {
  // Reject any attempt at directory traversal
  const normalized = path.normalize(relativePath.replace(/\\/g, '/'));
  return !normalized.startsWith('..') && !path.isAbsolute(normalized);
}
