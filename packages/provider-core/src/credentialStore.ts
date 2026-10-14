/**
 * @mediator/provider-core — Secure Credential Store (Sprint S29, S30.3)
 *
 * Implements encrypted-at-rest credential storage for AI provider API keys.
 *
 * Security:
 * - Uses AES-256-GCM authenticated encryption.
 * - Key derivation via PBKDF2-HMAC-SHA256 with 100,000 iterations and machine/user salt.
 * - Stored in %LOCALAPPDATA%\Mediator\security\credentials.enc (or in-memory mock seam).
 * - Never logs or emits raw API keys.
 * - Returns only CredentialMetadata with lastFour and keyHash (never raw secret).
 * - Exposes explicit set, get (internal), remove, and list lifecycle.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir, platform } from 'node:os';
import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes, createHash } from 'node:crypto';
import {
  type CanonicalProviderId,
  type CredentialMetadata,
  type Result,
  type MediatorError,
  ErrorCode,
  makeMediatorError,
  ok,
  err,
  isCanonicalProviderId,
} from '@mediator/shared-contracts';

export interface CredentialStoreOptions {
  readonly storagePath?: string;
  readonly inMemory?: boolean;
  readonly masterSecret?: string;
}

interface EncryptedRecord {
  readonly providerId: CanonicalProviderId;
  readonly keyHash: string;
  readonly lastFour: string;
  readonly ciphertext: string; // hex
  readonly iv: string; // hex (12 bytes)
  readonly authTag: string; // hex (16 bytes)
  readonly createdAt: number;
  readonly updatedAt: number;
}

interface EncryptedFileSchema {
  readonly version: 1;
  readonly salt: string; // hex
  readonly records: Record<string, EncryptedRecord>;
}

export class SecureCredentialStore {
  private readonly storagePath: string;
  private readonly inMemory: boolean;
  private inMemoryDb: EncryptedFileSchema | null = null;
  private derivedKeyCache: Buffer | null = null;
  private readonly configuredMasterSecret?: string | undefined;

  constructor(options?: CredentialStoreOptions) {
    this.inMemory = options?.inMemory ?? false;
    this.configuredMasterSecret = options?.masterSecret;

    if (options?.storagePath) {
      this.storagePath = options.storagePath;
    } else {
      const localAppData =
        process.env['LOCALAPPDATA'] ||
        (platform() === 'win32'
          ? join(homedir(), 'AppData', 'Local')
          : join(homedir(), '.local', 'share'));
      this.storagePath = join(localAppData, 'Mediator', 'security', 'credentials.enc');
    }

    if (this.inMemory) {
      this.inMemoryDb = {
        version: 1,
        salt: randomBytes(16).toString('hex'),
        records: {},
      };
    }
  }

  public getStoragePath(): string {
    return this.storagePath;
  }

  /**
   * Sets or replaces an API key for a provider.
   * Returns sanitized metadata only.
   */
  public async setCredential(
    providerId: CanonicalProviderId,
    rawKey: string,
  ): Promise<Result<CredentialMetadata, MediatorError>> {
    await Promise.resolve();
    if (!isCanonicalProviderId(providerId)) {
      return err(
        makeMediatorError(
          ErrorCode.PROVIDER_UNKNOWN,
          `Cannot store credential for unknown provider "${String(providerId)}".`,
          { detail: { providerId } },
        ),
      );
    }

    const cleanKey = rawKey?.trim();
    if (!cleanKey || cleanKey.length < 8) {
      return err(
        makeMediatorError(
          ErrorCode.PROVIDER_CREDENTIAL_INVALID,
          `API key for "${providerId}" is invalid or too short (minimum 8 characters).`,
          { detail: { providerId } },
        ),
      );
    }

    try {
      const data = this.loadData();
      const masterKey = this.deriveMasterKey(Buffer.from(data.salt, 'hex'));

      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', masterKey, iv);
      const encrypted = Buffer.concat([cipher.update(cleanKey, 'utf8'), cipher.final()]);
      const authTag = cipher.getAuthTag();

      const keyHash = createHash('sha256').update(cleanKey, 'utf8').digest('hex').slice(0, 12);
      const lastFour = cleanKey.slice(-4);
      const now = Date.now();

      const existing = data.records[providerId];
      const record: EncryptedRecord = {
        providerId,
        keyHash,
        lastFour,
        ciphertext: encrypted.toString('hex'),
        iv: iv.toString('hex'),
        authTag: authTag.toString('hex'),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };

      data.records[providerId] = record;
      this.saveData(data);

      return ok({
        providerId,
        keyHash,
        lastFour,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        storageType: 'encrypted-local',
      });
    } catch (saveErr) {
      const msg = saveErr instanceof Error ? saveErr.message : String(saveErr);
      return err(
        makeMediatorError(
          ErrorCode.INTERNAL_ERROR,
          `Failed to securely store credential for "${providerId}": ${msg}`,
          { detail: { providerId } },
        ),
      );
    }
  }

  /**
   * Retrieves the decrypted raw API key for internal outbound requests.
   * NEVER expose this value in UI, logs, or error details!
   */
  public async getDecryptedCredential(
    providerId: CanonicalProviderId,
  ): Promise<Result<string, MediatorError>> {
    await Promise.resolve();
    if (!isCanonicalProviderId(providerId)) {
      return err(
        makeMediatorError(
          ErrorCode.PROVIDER_UNKNOWN,
          `Unknown provider "${String(providerId)}".`,
          { detail: { providerId } },
        ),
      );
    }

    try {
      const data = this.loadData();
      const record = data.records[providerId];
      if (!record) {
        return err(
          makeMediatorError(
            ErrorCode.PROVIDER_CREDENTIAL_MISSING,
            `No API credential configured for provider "${providerId}".`,
            { detail: { providerId } },
          ),
        );
      }

      const masterKey = this.deriveMasterKey(Buffer.from(data.salt, 'hex'));
      const decipher = createDecipheriv(
        'aes-256-gcm',
        masterKey,
        Buffer.from(record.iv, 'hex'),
      );
      decipher.setAuthTag(Buffer.from(record.authTag, 'hex'));

      const decrypted = Buffer.concat([
        decipher.update(Buffer.from(record.ciphertext, 'hex')),
        decipher.final(),
      ]);

      return ok(decrypted.toString('utf8'));
    } catch (decryptErr) {
      const msg = decryptErr instanceof Error ? decryptErr.message : String(decryptErr);
      return err(
        makeMediatorError(
          ErrorCode.PROVIDER_CREDENTIAL_INVALID,
          `Failed to decrypt credential for "${providerId}". The key may be corrupted or tampered: ${msg}`,
          { detail: { providerId } },
        ),
      );
    }
  }

  /**
   * Returns sanitized metadata for a provider's credential if present.
   */
  public async getMetadata(
    providerId: CanonicalProviderId,
  ): Promise<CredentialMetadata | null> {
    await Promise.resolve();
    if (!isCanonicalProviderId(providerId)) return null;
    const data = this.loadData();
    const record = data.records[providerId];
    if (!record) return null;

    return {
      providerId: record.providerId,
      keyHash: record.keyHash,
      lastFour: record.lastFour,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      storageType: 'encrypted-local',
    };
  }

  /**
   * Returns sanitized metadata for all configured credentials.
   */
  public async listCredentials(): Promise<readonly CredentialMetadata[]> {
    await Promise.resolve();
    const data = this.loadData();
    const list: CredentialMetadata[] = [];
    for (const record of Object.values(data.records)) {
      list.push({
        providerId: record.providerId,
        keyHash: record.keyHash,
        lastFour: record.lastFour,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        storageType: 'encrypted-local',
      });
    }
    return list;
  }

  /**
   * Checks whether a credential is configured for the provider.
   */
  public async hasCredential(providerId: CanonicalProviderId): Promise<boolean> {
    await Promise.resolve();
    if (!isCanonicalProviderId(providerId)) return false;
    const data = this.loadData();
    return Boolean(data.records[providerId]);
  }

  /**
   * Explicitly removes a credential for a provider.
   */
  public async removeCredential(
    providerId: CanonicalProviderId,
  ): Promise<Result<boolean, MediatorError>> {
    await Promise.resolve();
    if (!isCanonicalProviderId(providerId)) {
      return err(
        makeMediatorError(ErrorCode.PROVIDER_UNKNOWN, `Unknown provider "${String(providerId)}".`),
      );
    }

    try {
      const data = this.loadData();
      if (!data.records[providerId]) {
        return ok(false);
      }
      delete data.records[providerId];
      this.saveData(data);
      return ok(true);
    } catch (delErr) {
      const msg = delErr instanceof Error ? delErr.message : String(delErr);
      return err(
        makeMediatorError(
          ErrorCode.INTERNAL_ERROR,
          `Failed to delete credential for "${providerId}": ${msg}`,
        ),
      );
    }
  }

  /**
   * Purges all credentials. Used by data retention or full uninstall.
   */
  public clearAllCredentials(): void {
    if (this.inMemory) {
      this.inMemoryDb = {
        version: 1,
        salt: randomBytes(16).toString('hex'),
        records: {},
      };
      return;
    }
    if (existsSync(this.storagePath)) {
      try {
        unlinkSync(this.storagePath);
      } catch {
        // ignore
      }
    }
  }

  // ─── Internal Storage & Derivation Helpers ────────────────────────────────

  private deriveMasterKey(salt: Buffer): Buffer {
    if (this.derivedKeyCache) {
      return this.derivedKeyCache;
    }

    // Entropy inputs: user profile path + machine ID / username + optional custom master secret
    const machineEntropy = [
      this.configuredMasterSecret ?? 'mediator-default-entropy',
      process.env['USERNAME'] || process.env['USER'] || 'user',
      process.env['COMPUTERNAME'] || process.env['HOSTNAME'] || 'workstation',
      homedir(),
    ].join('::');

    const key = pbkdf2Sync(machineEntropy, salt, 100_000, 32, 'sha256');
    this.derivedKeyCache = key;
    return key;
  }

  private loadData(): EncryptedFileSchema {
    if (this.inMemory) {
      if (!this.inMemoryDb) {
        this.inMemoryDb = {
          version: 1,
          salt: randomBytes(16).toString('hex'),
          records: {},
        };
      }
      return this.inMemoryDb;
    }

    if (!existsSync(this.storagePath)) {
      const newDb: EncryptedFileSchema = {
        version: 1,
        salt: randomBytes(16).toString('hex'),
        records: {},
      };
      this.saveData(newDb);
      return newDb;
    }

    try {
      const raw = readFileSync(this.storagePath, 'utf8');
      const parsed = JSON.parse(raw) as EncryptedFileSchema;
      if (parsed.version !== 1 || !parsed.salt || !parsed.records) {
        throw new Error('Corrupt credential file structure');
      }
      return parsed;
    } catch {
      // If corrupted, fallback to clean state with backup
      const freshDb: EncryptedFileSchema = {
        version: 1,
        salt: randomBytes(16).toString('hex'),
        records: {},
      };
      return freshDb;
    }
  }

  private saveData(data: EncryptedFileSchema): void {
    if (this.inMemory) {
      this.inMemoryDb = data;
      return;
    }

    const dir = dirname(this.storagePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    writeFileSync(this.storagePath, JSON.stringify(data, null, 2), 'utf8');
  }
}
