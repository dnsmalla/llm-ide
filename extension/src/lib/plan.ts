// Phase 4 client types — mirror what the server returns from
// /kb/generate-plan, /kb/analyze-risks, /kb/code-sync, and /kb/plan/:id.
// Keep in sync with savePlan/getPlan in kb/db.mjs.

export type TaskStatus = 'planned' | 'in_progress' | 'done' | 'blocked';
export type RiskLevel = 'low' | 'med' | 'high';

export interface CodeRef {
  ref: string;
  title: string;
  bodyExcerpt?: string;
  rank?: number;
}

export interface PlanTask {
  id: string;
  planId?: string;
  position: number;
  milestone: string | null;
  title: string;
  description: string | null;
  owner: string | null;
  due: string | null;
  estimateDays: number | null;
  dependsOn: string[];
  status: TaskStatus;
  risk: RiskLevel | null;
  riskReason: string | null;
  files: CodeRef[];
  meta?: Record<string, unknown>;
}

export interface Plan {
  id: string;
  meetingId: string | null;
  title: string;
  goal: string | null;
  language: string | null;
  meta?: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
  tasks: PlanTask[];
}

export interface PlanSummary {
  id: string;
  title: string;
  meetingId: string | null;
  createdAt: string;
  updatedAt: string;
  taskCount: number;
}
