/**
 * @mediator/context-engine — Known Issues & Failed Attempts Memory (S11)
 *
 * Requirements:
 * - Bounded views of known issues and previous unsuccessful attempts.
 * - Prevents redundant work and loops by surfacing what failed previously.
 */

export type IssueStatus = 'unresolved' | 'resolved' | 'blocked';

export interface KnownIssue {
  readonly issueId: string;
  readonly title: string;
  readonly description: string;
  readonly attemptedFixes: readonly string[];
  readonly status: IssueStatus;
  readonly relatedTaskId?: string | undefined;
  readonly errorSignatures?: readonly string[] | undefined;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface RecordIssueParams {
  readonly issueId?: string | undefined;
  readonly title: string;
  readonly description: string;
  readonly attemptedFixes?: readonly string[] | undefined;
  readonly status?: IssueStatus | undefined;
  readonly relatedTaskId?: string | undefined;
  readonly errorSignatures?: readonly string[] | undefined;
}

export class KnownIssuesManager {
  private readonly issues = new Map<string, KnownIssue>();

  constructor(initialIssues: KnownIssue[] = []) {
    for (const issue of initialIssues) {
      this.issues.set(issue.issueId, issue);
    }
  }

  public recordIssue(params: RecordIssueParams): KnownIssue {
    const id =
      params.issueId ||
      `ISSUE-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
    const now = Date.now();
    const existing = this.issues.get(id);

    const record: KnownIssue = {
      issueId: id,
      title: params.title.trim(),
      description: params.description.trim(),
      attemptedFixes: params.attemptedFixes ?? existing?.attemptedFixes ?? [],
      status: params.status ?? 'unresolved',
      relatedTaskId: params.relatedTaskId ?? existing?.relatedTaskId,
      errorSignatures: params.errorSignatures ?? existing?.errorSignatures,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    this.issues.set(id, record);
    return record;
  }

  public addAttemptedFix(issueId: string, fixDescription: string): KnownIssue | undefined {
    const issue = this.issues.get(issueId);
    if (!issue) return undefined;

    const updated: KnownIssue = {
      ...issue,
      attemptedFixes: [...issue.attemptedFixes, fixDescription.trim()],
      updatedAt: Date.now(),
    };

    this.issues.set(issueId, updated);
    return updated;
  }

  public resolveIssue(issueId: string): boolean {
    const issue = this.issues.get(issueId);
    if (!issue) return false;

    this.issues.set(issueId, {
      ...issue,
      status: 'resolved',
      updatedAt: Date.now(),
    });
    return true;
  }

  public listIssues(status?: IssueStatus): KnownIssue[] {
    let list = Array.from(this.issues.values());
    if (status) {
      list = list.filter((i) => i.status === status);
    }
    return list.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  public getUnresolvedForContext(limit = 5): KnownIssue[] {
    return Array.from(this.issues.values())
      .filter((i) => i.status === 'unresolved' || i.status === 'blocked')
      .slice(0, limit);
  }

  public clear(): void {
    this.issues.clear();
  }
}
