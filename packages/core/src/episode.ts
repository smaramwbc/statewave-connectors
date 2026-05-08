export interface SourcePointer {
  type: string;
  id: string;
  url?: string;
}

export interface StatewaveEpisode {
  subject: string;
  kind: string;
  text: string;
  occurred_at: string;
  source: SourcePointer;
  metadata?: Record<string, unknown>;
  idempotency_key: string;
}
