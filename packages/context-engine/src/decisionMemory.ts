/**
 * @mediator/context-engine — Architectural Decision Memory (S11)
 *
 * Requirements:
 * - Preserve architectural decisions, status, rationale, and related task/module references.
 * - Keep user-approved decisions separate from proposed ones.
 * - Provide bounded views of approved decisions for context assembly.
 */

export type DecisionStatus = 'proposed' | 'approved' | 'deprecated' | 'superseded';

export interface ArchitecturalDecision {
  readonly decisionId: string;
  readonly title: string;
  readonly rationale: string;
  readonly status: DecisionStatus;
  readonly authorType: 'user' | 'ai';
  readonly relatedTaskId?: string | undefined;
  readonly relatedModules?: readonly string[] | undefined;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface CreateDecisionParams {
  readonly decisionId?: string | undefined;
  readonly title: string;
  readonly rationale: string;
  readonly status?: DecisionStatus | undefined;
  readonly authorType?: 'user' | 'ai' | undefined;
  readonly relatedTaskId?: string | undefined;
  readonly relatedModules?: readonly string[] | undefined;
}

export class DecisionMemoryManager {
  private readonly decisions = new Map<string, ArchitecturalDecision>();

  constructor(initialDecisions: ArchitecturalDecision[] = []) {
    for (const d of initialDecisions) {
      this.decisions.set(d.decisionId, d);
    }
  }

  public recordDecision(params: CreateDecisionParams): ArchitecturalDecision {
    const id =
      params.decisionId ||
      `ADR-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
    const now = Date.now();
    const existing = this.decisions.get(id);

    const record: ArchitecturalDecision = {
      decisionId: id,
      title: params.title.trim(),
      rationale: params.rationale.trim(),
      status: params.status ?? 'approved',
      authorType: params.authorType ?? 'user',
      relatedTaskId: params.relatedTaskId,
      relatedModules: params.relatedModules,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    this.decisions.set(id, record);
    return record;
  }

  public getDecision(decisionId: string): ArchitecturalDecision | undefined {
    return this.decisions.get(decisionId);
  }

  public listDecisions(filter?: {
    status?: DecisionStatus;
    relatedTaskId?: string;
  }): ArchitecturalDecision[] {
    let list = Array.from(this.decisions.values());
    if (filter?.status) {
      list = list.filter((d) => d.status === filter.status);
    }
    if (filter?.relatedTaskId) {
      list = list.filter((d) => d.relatedTaskId === filter.relatedTaskId);
    }
    return list.sort((a, b) => b.createdAt - a.createdAt);
  }

  public getApprovedDecisionsForContext(limit = 10): ArchitecturalDecision[] {
    return Array.from(this.decisions.values())
      .filter((d) => d.status === 'approved')
      .slice(0, limit);
  }

  public deleteDecision(decisionId: string): boolean {
    return this.decisions.delete(decisionId);
  }

  public clear(): void {
    this.decisions.clear();
  }
}
