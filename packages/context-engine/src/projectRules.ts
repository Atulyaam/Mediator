/**
 * @mediator/context-engine — Project Rules & Conventions (S11)
 *
 * Requirements:
 * - Read project-local Mediator rules (.mediator/rules.md) only when location
 *   and content pass workspace and context-security checks.
 * - Keep user-approved rules separate from AI-proposed rules.
 * - AI output must not silently promote a suggested rule into an authoritative
 *   security policy or user-approved rule.
 * - Never let project memory override hard-deny rules, workspace boundaries,
 *   or security invariants.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { type WorkspaceRootState } from '@mediator/shared-contracts';
import {
  checkWorkspacePermittedForFileOps,
  validateContainedPath,
} from '@mediator/workspace-boundary';
import {
  checkPathExclusion,
  MANDATORY_EXCLUSIONS,
  scanContent,
  shouldBlockContent,
} from '@mediator/context-security';
import { ContextEngineError, ContextEngineErrorCode } from './errors.js';

export type RuleAuthorType = 'user' | 'ai';
export type RuleStatus = 'approved' | 'proposed' | 'deprecated';

export interface ProjectRule {
  readonly ruleId: string;
  readonly title: string;
  readonly content: string;
  readonly authorType: RuleAuthorType;
  readonly status: RuleStatus;
  readonly scope?: string | undefined;
  readonly createdAt: number;
  readonly updatedAt: number;
}

const FORBIDDEN_RULE_OVERRIDE_PATTERNS = [
  /bypass\s+workspace/i,
  /ignore\s+workspace\s+root/i,
  /bypass\s+secret/i,
  /disable\s+secret\s+scanner/i,
  /bypass\s+policy/i,
  /run\s+arbitrary\s+shell/i,
  /auto-?execute\s+without\s+approval/i,
  /grant\s+all\s+permissions/i,
  /allow\s+.*outside\s+workspace/i,
  /access\s+.*outside\s+workspace/i,
];

/**
 * Validates that a project rule does not attempt to override core security invariants.
 */
export function validateRuleContentSafety(content: string): void {
  for (const pattern of FORBIDDEN_RULE_OVERRIDE_PATTERNS) {
    if (pattern.test(content)) {
      throw new ContextEngineError(
        ContextEngineErrorCode.RULE_VALIDATION_FAILED,
        `Project rule rejected: attempts to override immutable security invariant (${pattern})`,
        { detail: { pattern: String(pattern) } },
      );
    }
  }
}

/**
 * Load project rules from workspace-local file (e.g. .mediator/rules.md).
 */
export function loadWorkspaceRulesFile(
  rootState: WorkspaceRootState,
  relativeRulesPath = '.mediator/rules.md',
): ProjectRule[] {
  // 1. Check workspace permission
  const permitted = checkWorkspacePermittedForFileOps(rootState);
  if (!permitted.ok) {
    throw new ContextEngineError(
      ContextEngineErrorCode.UNSAFE_WORKSPACE_ROOT,
      `Cannot read rules from unconfirmed workspace: ${permitted.error.message}`,
    );
  }
  const canonicalRoot = permitted.value;

  // 2. Check secret exclusion
  const exclusion = checkPathExclusion(relativeRulesPath, MANDATORY_EXCLUSIONS);
  if (exclusion.excluded) {
    throw new ContextEngineError(
      ContextEngineErrorCode.CONTEXT_EXCLUSION_DENIED,
      `Rules path matches sensitive exclusion: ${relativeRulesPath}`,
      { detail: { relativeRulesPath } },
    );
  }

  // 3. Validate path containment within confirmed workspace root
  const fullPath = path.resolve(canonicalRoot, relativeRulesPath);
  const containment = validateContainedPath(rootState, fullPath, {
    operation: 'read',
    mustExist: true,
  });

  if (!containment.ok) {
    // If file doesn't exist, return empty array safely
    if (!fs.existsSync(fullPath)) {
      return [];
    }
    throw new ContextEngineError(
      ContextEngineErrorCode.UNSAFE_WORKSPACE_ROOT,
      `Rules path failed workspace containment: ${containment.error.message}`,
      { detail: { containmentError: containment.error } },
    );
  }

  // 4. Read and scan content for secrets
  let rawContent: string;
  try {
    rawContent = fs.readFileSync(fullPath, 'utf8');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ContextEngineError(
      ContextEngineErrorCode.FILE_UNAVAILABLE,
      `Failed to read rules file: ${msg}`,
      { detail: { fullPath, error: msg } },
    );
  }

  const scan = scanContent(rawContent);
  if (!scan.ok || shouldBlockContent(scan.value)) {
    throw new ContextEngineError(
      ContextEngineErrorCode.CONTEXT_EXCLUSION_DENIED,
      'Project rules file contains secrets and cannot be loaded into memory',
      { detail: { findingsCount: scan.ok ? scan.value.findings.length : 1 } },
    );
  }

  validateRuleContentSafety(rawContent);

  // 5. Parse markdown sections or bullet rules
  return parseRulesMarkdown(rawContent, 'user', 'approved');
}

/**
 * Parses markdown text into ProjectRule items.
 */
export function parseRulesMarkdown(
  markdown: string,
  authorType: RuleAuthorType = 'user',
  status: RuleStatus = 'approved',
): ProjectRule[] {
  const rules: ProjectRule[] = [];
  const lines = markdown.split(/\r?\n/);
  let currentTitle = '';
  let currentContent: string[] = [];
  let ruleIndex = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#')) {
      if (currentTitle && currentContent.length > 0) {
        const text = currentContent.join('\n').trim();
        validateRuleContentSafety(text);
        ruleIndex++;
        rules.push({
          ruleId: `rule-${ruleIndex}-${Date.now()}`,
          title: currentTitle,
          content: text,
          authorType,
          status,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      }
      currentTitle = trimmed.replace(/^#+\s*/, '');
      currentContent = [];
    } else if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
      if (!currentTitle) {
        // Standalone bullet rule
        const text = trimmed.slice(2).trim();
        validateRuleContentSafety(text);
        ruleIndex++;
        rules.push({
          ruleId: `rule-${ruleIndex}-${Date.now()}`,
          title: text.slice(0, 40),
          content: text,
          authorType,
          status,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      } else {
        currentContent.push(line);
      }
    } else if (trimmed.length > 0) {
      currentContent.push(line);
    }
  }

  if (currentTitle && currentContent.length > 0) {
    const text = currentContent.join('\n').trim();
    validateRuleContentSafety(text);
    ruleIndex++;
    rules.push({
      ruleId: `rule-${ruleIndex}-${Date.now()}`,
      title: currentTitle,
      content: text,
      authorType,
      status,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  }

  return rules;
}

/**
 * Propose an AI-suggested rule. Stays strictly 'proposed' and 'ai' until user approves.
 */
export function proposeRuleByAI(params: {
  title: string;
  content: string;
  scope?: string | undefined;
}): ProjectRule {
  validateRuleContentSafety(params.content);
  return {
    ruleId: `ai-rule-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
    title: params.title.trim(),
    content: params.content.trim(),
    authorType: 'ai',
    status: 'proposed',
    scope: params.scope,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

/**
 * User-explicit approval of a proposed rule.
 */
export function approveRule(rule: ProjectRule, userConfirmed: boolean): ProjectRule {
  if (!userConfirmed) {
    throw new ContextEngineError(
      ContextEngineErrorCode.RULE_VALIDATION_FAILED,
      'Rule cannot be approved without explicit user confirmation',
    );
  }
  validateRuleContentSafety(rule.content);
  return {
    ...rule,
    status: 'approved',
    updatedAt: Date.now(),
  };
}
