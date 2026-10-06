import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import type { Database } from './db.js';
import { walkFiles } from '../tools/search.js';
import { GitManager } from '../git/gitManager.js';
import { nowIso, uid } from '../shared/ids.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('checkpoints');

export interface Checkpoint {
  id: string;
  projectId: string;
  sessionId?: string;
  label: string;
  createdAt: string;
  gitCommit?: string;
  fileCount: number;
  bytes: number;
  snapshotDir: string;
  truncated: boolean;
}

const MAX_FILES = 3000;
const MAX_BYTES = 80 * 1024 * 1024;

/**
 * File-level restore points. Git commit hashes are recorded when available,
 * but the snapshot itself never depends on Git, so uncommitted work is safe.
 */
export class CheckpointManager {
  constructor(
    private db: Database,
    private storageRoot: string
  ) {}

  async create(options: { projectId: string; sessionId?: string; workspaceRoot: string; label: string }): Promise<Checkpoint> {
    const id = uid('ckpt');
    const snapshotDir = path.join(this.storageRoot, options.projectId, id);
    await fs.mkdir(snapshotDir, { recursive: true });

    const files = await walkFiles(options.workspaceRoot, { maxFiles: MAX_FILES + 1 });
    const truncated = files.length > MAX_FILES;
    let bytes = 0;
    let count = 0;

    for (const abs of files.slice(0, MAX_FILES)) {
      let stat;
      try {
        stat = await fs.stat(abs);
      } catch {
        continue;
      }
      if (bytes + stat.size > MAX_BYTES) break;
      const rel = path.relative(options.workspaceRoot, abs);
      const target = path.join(snapshotDir, rel);
      await fs.mkdir(path.dirname(target), { recursive: true });
      try {
        await fs.copyFile(abs, target);
        bytes += stat.size;
        count++;
      } catch {
        /* skip unreadable files */
      }
    }

    const gm = new GitManager(options.workspaceRoot);
    let gitCommit: string | undefined;
    if (gm.isRepo()) {
      const head = await gm.revParseHead();
      if (head.ok) gitCommit = head.stdout.trim();
    }

    const checkpoint: Checkpoint = {
      id,
      projectId: options.projectId,
      sessionId: options.sessionId,
      label: options.label,
      createdAt: nowIso(),
      gitCommit,
      fileCount: count,
      bytes,
      snapshotDir,
      truncated
    };
    this.db.upsert('checkpoints', {
      id,
      parent: options.projectId,
      updatedAt: checkpoint.createdAt,
      data: checkpoint as unknown as Record<string, unknown>
    });
    log.info('Checkpoint created', { id, files: count, bytes });
    return checkpoint;
  }

  list(projectId: string): Checkpoint[] {
    return this.db
      .all('checkpoints', projectId)
      .map((r) => r.data as unknown as Checkpoint)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(id: string): Checkpoint | undefined {
    return this.db.get('checkpoints', id)?.data as unknown as Checkpoint | undefined;
  }

  /** Restores snapshot files over the workspace. Files created after the checkpoint are reported, not deleted. */
  async restore(id: string, workspaceRoot: string): Promise<{ restored: number; extraFiles: string[] }> {
    const checkpoint = this.get(id);
    if (!checkpoint) throw new Error(`Checkpoint ${id} not found.`);
    if (!fssync.existsSync(checkpoint.snapshotDir)) throw new Error('Checkpoint snapshot is missing on disk.');

    const snapshotFiles = await walkFiles(checkpoint.snapshotDir, { maxFiles: MAX_FILES });
    let restored = 0;
    const known = new Set<string>();
    for (const abs of snapshotFiles) {
      const rel = path.relative(checkpoint.snapshotDir, abs);
      known.add(rel.split(path.sep).join('/'));
      const target = path.join(workspaceRoot, rel);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(abs, target);
      restored++;
    }

    const current = await walkFiles(workspaceRoot, { maxFiles: MAX_FILES });
    const extraFiles = current
      .map((abs) => path.relative(workspaceRoot, abs).split(path.sep).join('/'))
      .filter((rel) => !known.has(rel));

    log.info('Checkpoint restored', { id, restored, extra: extraFiles.length });
    return { restored, extraFiles };
  }

  async delete(id: string): Promise<void> {
    const checkpoint = this.get(id);
    if (checkpoint && fssync.existsSync(checkpoint.snapshotDir)) {
      await fs.rm(checkpoint.snapshotDir, { recursive: true, force: true });
    }
    this.db.remove('checkpoints', id);
  }
}
