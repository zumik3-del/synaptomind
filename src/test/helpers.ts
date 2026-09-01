import { v7 as uuidv7 } from "uuid";
import { getDb } from "../db/container";
import { closeDb, initDb } from "../db/init";

export function createTestDb(): void {
	closeDb();
	initDb({ dbPath: ":memory:", runMigrations: true });
}

export function seedThought(overrides?: {
	id?: string;
	content?: string;
	status?: string;
	tags?: string | null;
	source?: string | null;
	project_id?: string;
	is_cluster?: number | null;
	is_profile?: number | null;
	importance?: number;
}): string {
	const db = getDb();
	const id = overrides?.id ?? uuidv7();
	const now = new Date().toISOString();
	const projectId = overrides?.project_id ?? "default";
	const isCluster = overrides?.is_cluster ?? 0;
	// Ensure project exists
	db.prepare(
		`INSERT OR IGNORE INTO projects (id, name, created_at) VALUES (?, ?, ?)`,
	).run(
		projectId,
		projectId === "default" ? "Default" : `Project ${projectId.slice(0, 8)}`,
		new Date().toISOString(),
	);
	db.prepare(`
    INSERT INTO thoughts (id, content, status, source, project_id, is_cluster, is_profile, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
		id,
		overrides?.content ?? "test thought",
		overrides?.status ?? "active",
		overrides?.source ?? "test",
		projectId,
		isCluster,
		overrides?.is_profile ?? 0,
		now,
		now,
	);
	const existing = db
		.prepare(`SELECT 1 FROM thought_importance WHERE thought_id = ?`)
		.get(id) as { 1: unknown } | undefined;
	if (!existing) {
		db.prepare(`
      INSERT INTO thought_importance (thought_id, importance, hit_count, last_decay, created_at)
      VALUES (?, ?, 0, ?, ?)
    `).run(id, overrides?.importance ?? 1.0, now, now);
	}
	// Seed tags if provided (JSON string or array)
	const tagsRaw = overrides?.tags;
	if (tagsRaw) {
		try {
			const tagNames = Array.isArray(tagsRaw) ? tagsRaw : JSON.parse(tagsRaw);
			if (Array.isArray(tagNames)) {
				for (const name of tagNames) {
					const existingTag = db
						.prepare(`SELECT id FROM tags WHERE name = ? COLLATE NOCASE`)
						.get(name) as { id: string } | undefined;
					let tagId: string;
					if (existingTag) {
						tagId = existingTag.id;
					} else {
						tagId = uuidv7();
						db.prepare(
							`INSERT INTO tags (id, name, created_at) VALUES (?, ?, ?)`,
						).run(tagId, name, now);
					}
					db.prepare(
						`INSERT OR IGNORE INTO thought_tags (thought_id, tag_id) VALUES (?, ?)`,
					).run(id, tagId);
				}
			}
		} catch {
			// ignore malformed JSON
		}
	}
	return id;
}

export function seedEdge(
	sourceId: string,
	targetId: string,
	type: string = "develops",
): string {
	const db = getDb();
	const id = uuidv7();
	const now = new Date().toISOString();
	db.prepare(`
    INSERT INTO edges (id, source_id, target_id, type, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, sourceId, targetId, type, now);
	return id;
}

export function seedEmbedding(thoughtId: string): void {
	const db = getDb();
	const embedding = new Float32Array(384);
	try {
		db.prepare("INSERT INTO vec_thoughts (id, embedding) VALUES (?, ?)").run(
			thoughtId,
			Buffer.from(
				embedding.buffer as ArrayBuffer,
				embedding.byteOffset,
				embedding.byteLength,
			),
		);
	} catch {
		// vec_thoughts may not exist in :memory: tests without vec0
	}
}
