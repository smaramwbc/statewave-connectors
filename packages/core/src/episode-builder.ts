import type { SourcePointer, StatewaveEpisode } from "./episode.js";
import { ConnectorError } from "./errors.js";
import { idempotencyKey } from "./idempotency.js";

export interface EpisodeBuilderInput {
  subject?: string;
  kind: string;
  text: string;
  occurred_at?: string | Date;
  source: SourcePointer;
  metadata?: Record<string, unknown>;
  idempotency_key?: string;
  idempotency_parts?: ReadonlyArray<string | number | undefined | null>;
}

export class EpisodeBuilder {
  private readonly defaults: Partial<EpisodeBuilderInput>;

  constructor(defaults: Partial<EpisodeBuilderInput> = {}) {
    this.defaults = defaults;
  }

  build(input: EpisodeBuilderInput): StatewaveEpisode {
    const subject = input.subject ?? this.defaults.subject;
    const source = input.source ?? this.defaults.source;
    const merged = {
      kind: input.kind ?? this.defaults.kind,
      text: input.text ?? this.defaults.text,
      occurred_at: input.occurred_at ?? this.defaults.occurred_at,
      idempotency_key: input.idempotency_key ?? this.defaults.idempotency_key,
      idempotency_parts: input.idempotency_parts ?? this.defaults.idempotency_parts,
      metadata: { ...(this.defaults.metadata ?? {}), ...(input.metadata ?? {}) },
    };

    if (!subject) {
      throw new ConnectorError("subject is required", { code: "mapping_failed" });
    }
    if (!merged.kind) {
      throw new ConnectorError("kind is required", { code: "mapping_failed" });
    }
    if (!source?.type || !source?.id) {
      throw new ConnectorError("source.type and source.id are required", { code: "mapping_failed" });
    }

    const occurred = merged.occurred_at
      ? new Date(merged.occurred_at).toISOString()
      : new Date().toISOString();

    let key = merged.idempotency_key;
    if (!key) {
      const parts = merged.idempotency_parts ?? [source.type, source.id, merged.kind, occurred];
      key = idempotencyKey(parts);
    }

    return {
      subject,
      kind: merged.kind,
      text: merged.text ?? "",
      occurred_at: occurred,
      source,
      metadata: Object.keys(merged.metadata).length > 0 ? merged.metadata : undefined,
      idempotency_key: key,
    };
  }
}
