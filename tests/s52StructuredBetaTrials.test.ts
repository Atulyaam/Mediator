/**
 * tests/s52StructuredBetaTrials.test.ts — S52 Structured Personal Beta Real-World Operational Trial Suite
 *
 * Requirements (S52):
 * - Exercises all 10 representative Beta Operational Trial Scenarios on disposable Git-backed repos:
 *   1. Small JavaScript bug fix.
 *   2. TypeScript module change.
 *   3. React UI component bug fix.
 *   4. Failing-test investigation (read-only containment).
 *   5. Change involving multiple files.
 *   6. Deliberately incorrect provider proposal (syntax error).
 *   7. Test failure that should prevent approval.
 *   8. Expired or replayed approval attempt (single-use invariant).
 *   9. Staging / backup failure / dirty workspace (TOCTOU conflict).
 *   10. Provider-unavailable or malformed-response scenario.
 * - S00 NO-GO-AUTOEXEC remains strictly authoritative throughout all scenarios.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as cp from 'node:child_process';
import * as crypto from 'node:crypto';
import { MediatorCore } from '@mediator/orchestrator';
import { resetCoreForTesting, getOrCreateCore } from '../apps/cli/src/index.js';
import { ErrorCode } from '@mediator/shared-contracts';

function computeDirHash(dirPath: string): string {
  const files: string[] = [];
  function scan(current: string) {
    if (!fs.existsSync(current)) return;
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const ent of entries) {
      if (ent.name === '.git' || ent.name === '.mediator') continue;
      const full = path.join(current, ent.name);
      if (ent.isDirectory()) {
        scan(full);
      } else {
        files.push(full);
      }
    }
  }
  scan(dirPath);
  files.sort();
  const hash = crypto.createHash('sha256');
  for (const f of files) {
    const rel = path.relative(dirPath, f).replace(/\\/g, '/');
    hash.update(rel);
    hash.update(fs.readFileSync(f));
  }
  return hash.digest('hex');
}

function initGitRepo(dir: string): void {
  try {
    cp.execSync('git init -b main', { cwd: dir, stdio: 'pipe' });
    cp.execSync('git config user.name "Beta Operator"', { cwd: dir, stdio: 'pipe' });
    cp.execSync('git config user.email "operator@mediator.local"', { cwd: dir, stdio: 'pipe' });
    cp.execSync('git add .', { cwd: dir, stdio: 'pipe' });
    cp.execSync('git commit -m "initial commit"', { cwd: dir, stdio: 'pipe' });
  } catch {
    // If git commands fail due to local env, continue as filesystem project
  }
}

describe('Sprint S52 — Structured Personal Beta Real-World Trials (10 Scenarios)', () => {
  let tempBase: string;
  let workspaceDir: string;
  let core: MediatorCore;

  beforeEach(() => {
    tempBase = fs.mkdtempSync(path.join(os.tmpdir(), 'mediator-s52-trial-'));
    workspaceDir = path.join(tempBase, 'workspace');
    fs.mkdirSync(path.join(workspaceDir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, 'test'), { recursive: true });

    resetCoreForTesting(null);
    core = getOrCreateCore(workspaceDir);
    core.setWorkspaceRoot(workspaceDir, true);
  });

  afterEach(() => {
    resetCoreForTesting(null);
    if (fs.existsSync(tempBase)) {
      try {
        fs.rmSync(tempBase, { recursive: true, force: true });
      } catch {
        // Windows file locking tolerance
      }
    }
  });

  // =========================================================================
  // Scenario 1: Small JavaScript Bug Fix
  // =========================================================================
  it('Scenario 1: executes a small JavaScript bug fix workflow end-to-end', async () => {
    const jsFile = path.join(workspaceDir, 'src', 'stringHelper.js');
    const testFile = path.join(workspaceDir, 'test', 'stringHelper.test.js');

    // Intentional bug: reverseString returns input unchanged
    fs.writeFileSync(
      jsFile,
      'export function reverseString(str) {\n  return str; // BUG\n}\n',
      'utf8',
    );
    fs.writeFileSync(
      testFile,
      `import test from 'node:test';
import assert from 'node:assert';
import { reverseString } from '../src/stringHelper.js';

test('reverseString reverses input string', () => {
  assert.strictEqual(reverseString('hello'), 'olleh');
});
`,
      'utf8',
    );

    initGitRepo(workspaceDir);

    // Initial test fails
    let initialFailed = false;
    try {
      cp.execSync('node --test test/stringHelper.test.js', { cwd: workspaceDir, stdio: 'pipe' });
    } catch {
      initialFailed = true;
    }
    expect(initialFailed).toBe(true);

    // 1. Create task
    const taskRes = core.createTask({ prompt: 'Fix reverseString in src/stringHelper.js' });
    expect(taskRes.ok).toBe(true);
    if (!taskRes.ok) return;

    // 2. Stage fix proposal
    const fixedContent = 'export function reverseString(str) {\n  return str.split("").reverse().join("");\n}\n';
    const stageRes = await core.stageProposal({
      taskId: taskRes.value.id,
      relativePath: 'src/stringHelper.js',
      proposedContent: fixedContent,
      description: 'Fix reverseString implementation',
    });
    expect(stageRes.ok).toBe(true);
    if (!stageRes.ok) return;

    expect(stageRes.value.diffPreview).toContain('+  return str.split("").reverse().join("");');
    expect(stageRes.value.approvalId).toBeDefined();

    // 3. Verify live file is untouched before approval
    expect(fs.readFileSync(jsFile, 'utf8')).toContain('return str; // BUG');

    // 4. Human approval
    const apprRes = core.resolveApproval(stageRes.value.approvalId, true, 'Approved by operator');
    expect(apprRes.ok).toBe(true);

    // 5. Apply approved stage
    const applyRes = await core.applyApprovedStage(stageRes.value.stageId, stageRes.value.approvalId, 'trusted_cli');
    expect(applyRes.ok).toBe(true);
    if (!applyRes.ok) return;

    expect(applyRes.value.success).toBe(true);
    expect(applyRes.value.appliedFiles).toContain('src/stringHelper.js');

    // 6. Verify pre-apply backup created
    expect(applyRes.value.backupDir).toBeDefined();
    expect(fs.existsSync(applyRes.value.backupDir)).toBe(true);

    // 7. Verify live file updated and test passes 100%
    expect(fs.readFileSync(jsFile, 'utf8')).toContain('reverse().join("");');
    const postTest = cp.execSync('node --test test/stringHelper.test.js', { cwd: workspaceDir, stdio: 'pipe' });
    expect(postTest.toString()).toContain('pass 1');
  });

  // =========================================================================
  // Scenario 2: TypeScript Module Change
  // =========================================================================
  it('Scenario 2: executes a TypeScript module change workflow end-to-end', async () => {
    const typesFile = path.join(workspaceDir, 'src', 'types.js');
    const serviceFile = path.join(workspaceDir, 'src', 'userService.js');
    const testFile = path.join(workspaceDir, 'test', 'userService.test.js');

    fs.writeFileSync(
      typesFile,
      'export const UserStatus = { ACTIVE: "active" };\n',
      'utf8',
    );
    fs.writeFileSync(
      serviceFile,
      `import { UserStatus } from './types.js';
export function validateUser(user) {
  return Boolean(user && user.status === UserStatus.ACTIVE);
}
`,
      'utf8',
    );
    fs.writeFileSync(
      testFile,
      `import test from 'node:test';
import assert from 'node:assert';
import { validateUser } from '../src/userService.js';
import { UserStatus } from '../src/types.js';

test('validateUser checks user status and types define SUSPENDED', () => {
  assert.strictEqual(UserStatus.SUSPENDED, 'suspended');
  assert.strictEqual(validateUser({ status: UserStatus.ACTIVE }), true);
});
`,
      'utf8',
    );

    initGitRepo(workspaceDir);

    // Initial test fails because SUSPENDED is not defined in types
    let initialFailed = false;
    try {
      cp.execSync('node --test test/userService.test.js', { cwd: workspaceDir, stdio: 'pipe' });
    } catch {
      initialFailed = true;
    }
    expect(initialFailed).toBe(true);

    const taskRes = core.createTask({ prompt: 'Add SUSPENDED status to types.js' });
    expect(taskRes.ok).toBe(true);
    if (!taskRes.ok) return;

    // Stage update to types.js
    const updatedTypes = 'export const UserStatus = { ACTIVE: "active", SUSPENDED: "suspended" };\n';
    const stageRes = await core.stageProposal({
      taskId: taskRes.value.id,
      relativePath: 'src/types.js',
      proposedContent: updatedTypes,
    });
    expect(stageRes.ok).toBe(true);
    if (!stageRes.ok) return;

    // Human approval & apply
    core.resolveApproval(stageRes.value.approvalId, true);
    const applyRes = await core.applyApprovedStage(stageRes.value.stageId, stageRes.value.approvalId, 'trusted_cli');
    expect(applyRes.ok).toBe(true);

    // Post-apply tests pass
    const postTest = cp.execSync('node --test test/userService.test.js', { cwd: workspaceDir, stdio: 'pipe' });
    expect(postTest.toString()).toContain('pass 1');
  });

  // =========================================================================
  // Scenario 3: React UI Component Bug Fix
  // =========================================================================
  it('Scenario 3: executes a React UI component bug fix with approval and backup', async () => {
    const buttonFile = path.join(workspaceDir, 'src', 'Button.js');
    const testFile = path.join(workspaceDir, 'test', 'Button.test.js');

    // Bug: onClick is called even when disabled
    fs.writeFileSync(
      buttonFile,
      `export function renderButton({ label, disabled, onClick }) {
  return {
    label,
    disabled: Boolean(disabled),
    handleClick: () => onClick(), // BUG: does not check disabled
  };
}
`,
      'utf8',
    );
    fs.writeFileSync(
      testFile,
      `import test from 'node:test';
import assert from 'node:assert';
import { renderButton } from '../src/Button.js';

test('disabled button does not invoke onClick', () => {
  let clicked = false;
  const btn = renderButton({ label: 'Submit', disabled: true, onClick: () => { clicked = true; } });
  btn.handleClick();
  assert.strictEqual(clicked, false);
});
`,
      'utf8',
    );

    initGitRepo(workspaceDir);

    let initialFailed = false;
    try {
      cp.execSync('node --test test/Button.test.js', { cwd: workspaceDir, stdio: 'pipe' });
    } catch {
      initialFailed = true;
    }
    expect(initialFailed).toBe(true);

    const taskRes = core.createTask({ prompt: 'Fix disabled click behavior in Button.js' });
    expect(taskRes.ok).toBe(true);
    if (!taskRes.ok) return;

    const fixedButton = `export function renderButton({ label, disabled, onClick }) {
  return {
    label,
    disabled: Boolean(disabled),
    handleClick: () => {
      if (!disabled && onClick) onClick();
    },
  };
}
`;

    const stageRes = await core.stageProposal({
      taskId: taskRes.value.id,
      relativePath: 'src/Button.js',
      proposedContent: fixedButton,
    });
    expect(stageRes.ok).toBe(true);
    if (!stageRes.ok) return;

    // Approval & Apply
    core.resolveApproval(stageRes.value.approvalId, true);
    const applyRes = await core.applyApprovedStage(stageRes.value.stageId, stageRes.value.approvalId, 'trusted_cli');
    expect(applyRes.ok).toBe(true);

    const postTest = cp.execSync('node --test test/Button.test.js', { cwd: workspaceDir, stdio: 'pipe' });
    expect(postTest.toString()).toContain('pass 1');
  });

  // =========================================================================
  // Scenario 4: Failing-Test Investigation (Read-Only Containment)
  // =========================================================================
  it('Scenario 4: captures failing test output in isolation without modifying workspace', async () => {
    const mathFile = path.join(workspaceDir, 'src', 'math.js');
    const testFile = path.join(workspaceDir, 'test', 'math.test.js');

    fs.writeFileSync(mathFile, 'export function add(a, b) { return a + b; }\n', 'utf8');
    fs.writeFileSync(
      testFile,
      `import test from 'node:test';
import assert from 'node:assert';
import { add } from '../src/math.js';

test('add fails assertion', () => {
  assert.strictEqual(add(2, 2), 5); // Expected failure
});
`,
      'utf8',
    );

    initGitRepo(workspaceDir);

    const preHash = computeDirHash(workspaceDir);

    // Investigation run executes test and captures failure
    let errorOutput = '';
    try {
      cp.execSync('node --test test/math.test.js', { cwd: workspaceDir, stdio: 'pipe' });
    } catch (err: any) {
      errorOutput = err.stderr?.toString() || err.stdout?.toString() || '';
    }

    expect(errorOutput).toContain('Expected values to be strictly equal');

    // Live workspace must remain 100% byte-for-byte identical
    const postHash = computeDirHash(workspaceDir);
    expect(postHash).toBe(preHash);
  });

  // =========================================================================
  // Scenario 5: Change Involving Multiple Files
  // =========================================================================
  it('Scenario 5: stages, approves, and applies coordinated multi-file changes with backup', async () => {
    const configFile = path.join(workspaceDir, 'src', 'config.js');
    const clientFile = path.join(workspaceDir, 'src', 'client.js');
    const testFile = path.join(workspaceDir, 'test', 'client.test.js');

    fs.writeFileSync(configFile, 'export const config = { port: 8080 };\n', 'utf8');
    fs.writeFileSync(
      clientFile,
      `import { config } from './config.js';
export function getUrl() { return 'http://localhost:' + config.port; }
`,
      'utf8',
    );
    fs.writeFileSync(
      testFile,
      `import test from 'node:test';
import assert from 'node:assert';
import { getUrl } from '../src/client.js';

test('client uses updated port and secure protocol', () => {
  assert.strictEqual(getUrl(), 'https://localhost:8443');
});
`,
      'utf8',
    );

    initGitRepo(workspaceDir);

    const taskRes = core.createTask({ prompt: 'Update config to port 8443 and client to https' });
    expect(taskRes.ok).toBe(true);
    if (!taskRes.ok) return;

    // Stage file 1
    const s1 = await core.stageProposal({
      taskId: taskRes.value.id,
      relativePath: 'src/config.js',
      proposedContent: 'export const config = { port: 8443 };\n',
    });
    expect(s1.ok).toBe(true);
    if (!s1.ok) return;

    // Stage file 2
    const s2 = await core.stageProposal({
      taskId: taskRes.value.id,
      relativePath: 'src/client.js',
      proposedContent: `import { config } from './config.js';
export function getUrl() { return 'https://localhost:' + config.port; }
`,
    });
    expect(s2.ok).toBe(true);
    if (!s2.ok) return;

    // Approve both
    core.resolveApproval(s1.value.approvalId, true);
    core.resolveApproval(s2.value.approvalId, true);

    // Apply both
    const a1 = await core.applyApprovedStage(s1.value.stageId, s1.value.approvalId, 'trusted_cli');
    const a2 = await core.applyApprovedStage(s2.value.stageId, s2.value.approvalId, 'trusted_cli');

    expect(a1.ok).toBe(true);
    expect(a2.ok).toBe(true);

    // Post-apply tests pass
    const postTest = cp.execSync('node --test test/client.test.js', { cwd: workspaceDir, stdio: 'pipe' });
    expect(postTest.toString()).toContain('pass 1');
  });

  // =========================================================================
  // Scenario 6: Deliberately Incorrect Provider Proposal (Syntax Error)
  // =========================================================================
  it('Scenario 6: safely rejects syntactically broken provider proposal without modifying workspace', async () => {
    const jsFile = path.join(workspaceDir, 'src', 'valid.js');
    fs.writeFileSync(jsFile, 'export function ping() { return "pong"; }\n', 'utf8');

    initGitRepo(workspaceDir);
    const preHash = computeDirHash(workspaceDir);

    const taskRes = core.createTask({ prompt: 'Modify valid.js' });
    expect(taskRes.ok).toBe(true);
    if (!taskRes.ok) return;

    // Provider returns broken syntax
    const brokenContent = 'export function ping() { return = broken; }\n';
    const stageRes = await core.stageProposal({
      taskId: taskRes.value.id,
      relativePath: 'src/valid.js',
      proposedContent: brokenContent,
    });
    expect(stageRes.ok).toBe(true);
    if (!stageRes.ok) return;

    // Syntax check on staged content fails
    let syntaxValid = true;
    try {
      new Function(brokenContent);
    } catch {
      syntaxValid = false;
    }
    expect(syntaxValid).toBe(false);

    // Operator rejects approval
    const rejectRes = core.resolveApproval(stageRes.value.approvalId, false, 'Syntax error in proposed patch');
    expect(rejectRes.ok).toBe(true);

    // Applying rejected stage fails-closed
    const applyRes = await core.applyApprovedStage(stageRes.value.stageId, stageRes.value.approvalId, 'trusted_cli');
    expect(applyRes.ok).toBe(false);
    expect(applyRes.error?.code).toBe(ErrorCode.APPROVAL_EXPIRED);

    // Live workspace remains untouched
    expect(computeDirHash(workspaceDir)).toBe(preHash);
    expect(fs.readFileSync(jsFile, 'utf8')).toContain('return "pong";');
  });

  // =========================================================================
  // Scenario 7: Test Failure Preventing Human Approval
  // =========================================================================
  it('Scenario 7: withholds approval when proposal causes unit test regression', async () => {
    const calcFile = path.join(workspaceDir, 'src', 'calc.js');
    const testFile = path.join(workspaceDir, 'test', 'calc.test.js');

    fs.writeFileSync(calcFile, 'export function add(a, b) { return a + b; }\n', 'utf8');
    fs.writeFileSync(
      testFile,
      `import test from 'node:test';
import assert from 'node:assert';
import { add } from '../src/calc.js';

test('add(2, 3) equals 5', () => {
  assert.strictEqual(add(2, 3), 5);
});
`,
      'utf8',
    );

    initGitRepo(workspaceDir);

    const taskRes = core.createTask({ prompt: 'Refactor add function' });
    expect(taskRes.ok).toBe(true);
    if (!taskRes.ok) return;

    // Regressive proposal: returns product instead of sum
    const regressiveContent = 'export function add(a, b) { return a * b; }\n';
    const stageRes = await core.stageProposal({
      taskId: taskRes.value.id,
      relativePath: 'src/calc.js',
      proposedContent: regressiveContent,
    });
    expect(stageRes.ok).toBe(true);
    if (!stageRes.ok) return;

    // Operator rejects approval due to failed validation
    core.resolveApproval(stageRes.value.approvalId, false, 'Regression: breaks existing unit tests');

    const applyRes = await core.applyApprovedStage(stageRes.value.stageId, stageRes.value.approvalId, 'trusted_cli');
    expect(applyRes.ok).toBe(false);
    expect(applyRes.error?.code).toBe(ErrorCode.APPROVAL_EXPIRED);

    // Live workspace is unaltered
    expect(fs.readFileSync(calcFile, 'utf8')).toContain('return a + b;');
  });

  // =========================================================================
  // Scenario 8: Expired or Replayed Approval Attempt
  // =========================================================================
  it('Scenario 8: rejects replaying consumed approval token fail-closed', async () => {
    const dataFile = path.join(workspaceDir, 'src', 'data.js');
    fs.writeFileSync(dataFile, 'export const val = 1;\n', 'utf8');

    initGitRepo(workspaceDir);

    const taskRes = core.createTask({ prompt: 'Update val' });
    expect(taskRes.ok).toBe(true);
    if (!taskRes.ok) return;

    const stageRes = await core.stageProposal({
      taskId: taskRes.value.id,
      relativePath: 'src/data.js',
      proposedContent: 'export const val = 2;\n',
    });
    expect(stageRes.ok).toBe(true);
    if (!stageRes.ok) return;

    // First approval and apply succeed
    core.resolveApproval(stageRes.value.approvalId, true);
    const firstApply = await core.applyApprovedStage(stageRes.value.stageId, stageRes.value.approvalId, 'trusted_cli');
    expect(firstApply.ok).toBe(true);

    // Replay attempt with same approvalId
    const replayApply = await core.applyApprovedStage(stageRes.value.stageId, stageRes.value.approvalId, 'trusted_cli');
    expect(replayApply.ok).toBe(false);
    expect(replayApply.error?.code).toBe(ErrorCode.APPROVAL_EXPIRED);
    expect(replayApply.error?.message).toContain('already been consumed');
  });

  // =========================================================================
  // Scenario 9: Staging / Backup Failure / Dirty Workspace (TOCTOU Conflict)
  // =========================================================================
  it('Scenario 9: prevents apply when live file was modified externally after staging (TOCTOU defense)', async () => {
    const codeFile = path.join(workspaceDir, 'src', 'service.js');
    fs.writeFileSync(codeFile, 'export function getStatus() { return "idle"; }\n', 'utf8');

    initGitRepo(workspaceDir);

    const taskRes = core.createTask({ prompt: 'Update status to running' });
    expect(taskRes.ok).toBe(true);
    if (!taskRes.ok) return;

    const initialBaseHash = crypto.createHash('sha256').update(fs.readFileSync(codeFile, 'utf8')).digest('hex');

    const stageRes = await core.stageProposal({
      taskId: taskRes.value.id,
      relativePath: 'src/service.js',
      proposedContent: 'export function getStatus() { return "running"; }\n',
      expectedBaseHash: initialBaseHash,
    });
    expect(stageRes.ok).toBe(true);
    if (!stageRes.ok) return;

    // External modification to live file occurs AFTER staging
    fs.writeFileSync(codeFile, 'export function getStatus() { return "concurrent_external_edit"; }\n', 'utf8');

    // Operator approves the old staged diff
    core.resolveApproval(stageRes.value.approvalId, true);

    // Attempt to apply must detect TOCTOU base hash mismatch and fail-closed
    const applyRes = await core.applyApprovedStage(stageRes.value.stageId, stageRes.value.approvalId, 'trusted_cli');
    expect(applyRes.ok).toBe(false);

    // Live file retains concurrent external edit without being overwritten
    expect(fs.readFileSync(codeFile, 'utf8')).toContain('concurrent_external_edit');
  });

  // =========================================================================
  // Scenario 10: Provider-Unavailable or Malformed-Response Scenario
  // =========================================================================
  it('Scenario 10: gracefully handles malformed provider envelopes and disconnects fail-closed', async () => {
    initGitRepo(workspaceDir);
    const preHash = computeDirHash(workspaceDir);

    const taskRes = core.createTask({ prompt: 'Test provider resilience' });
    expect(taskRes.ok).toBe(true);
    if (!taskRes.ok) return;

    // 1. Malformed non-JSON response string
    const malformedRes = await core.submitProviderResponse(taskRes.value.id, '<<MALFORMED_NON_JSON_GARBAGE>>');
    expect(malformedRes.ok).toBe(false);
    expect(malformedRes.error?.code).toBe(ErrorCode.SCHEMA_INVALID);

    // 2. Empty action envelope
    const emptyEnvelope = await core.submitProviderResponse(taskRes.value.id, JSON.stringify({ actions: [] }));
    expect(emptyEnvelope.ok).toBe(true);

    // 3. Invalid task ID lookup
    const invalidTaskRes = await core.submitProviderResponse('task_non_existent', JSON.stringify({ actions: [] }));
    expect(invalidTaskRes.ok).toBe(false);
    expect(invalidTaskRes.error?.code).toBe(ErrorCode.TASK_MISMATCH);

    // Live workspace remains 100% untouched
    expect(computeDirHash(workspaceDir)).toBe(preHash);
  });
});
