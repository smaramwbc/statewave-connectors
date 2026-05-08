import { promises as fs } from "node:fs";
import * as path from "node:path";

export interface SourceState {
  cursor?: string;
  last_synced_at?: string;
  metadata?: Record<string, unknown>;
}

export interface SourceStateStore {
  get(key: string): Promise<SourceState | undefined>;
  set(key: string, state: SourceState): Promise<void>;
  delete(key: string): Promise<void>;
}

export class MemorySourceStateStore implements SourceStateStore {
  private readonly map = new Map<string, SourceState>();
  async get(key: string): Promise<SourceState | undefined> {
    return this.map.get(key);
  }
  async set(key: string, state: SourceState): Promise<void> {
    this.map.set(key, state);
  }
  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }
}

export class FileSourceStateStore implements SourceStateStore {
  constructor(private readonly filePath: string) {}

  private async readAll(): Promise<Record<string, SourceState>> {
    try {
      const buf = await fs.readFile(this.filePath, "utf8");
      return JSON.parse(buf) as Record<string, SourceState>;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw err;
    }
  }

  private async writeAll(data: Record<string, SourceState>): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(data, null, 2), "utf8");
  }

  async get(key: string): Promise<SourceState | undefined> {
    const all = await this.readAll();
    return all[key];
  }

  async set(key: string, state: SourceState): Promise<void> {
    const all = await this.readAll();
    all[key] = state;
    await this.writeAll(all);
  }

  async delete(key: string): Promise<void> {
    const all = await this.readAll();
    delete all[key];
    await this.writeAll(all);
  }
}
