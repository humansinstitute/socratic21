import Dexie, { type Table } from "dexie";
import type {
  CommentRecord,
  EventRecord,
  PendingWrite,
  ProfileRecord,
  WorkspaceProfile,
  TopicRecord,
  CachedProfile,
} from "./types";

class PerthAiDb extends Dexie {
  workspace_profiles!: Table<WorkspaceProfile, string>;
  events!: Table<EventRecord, string>;
  topics!: Table<TopicRecord, string>;
  comments!: Table<CommentRecord, string>;
  profiles!: Table<ProfileRecord, string>;
  profile_cache!: Table<CachedProfile, string>;
  pending_writes!: Table<PendingWrite, number>;

  constructor() {
    super("perth-ai");
    this.version(1).stores({
      workspace_profiles: "record_id, slug, updated_at",
      events: "record_id, slug, state, starts_at, sort_order, updated_at",
      topics: "record_id, event_id, slug, state, sort_order, updated_at",
      comments: "record_id, topic_id, state, updated_at",
      profiles: "record_id, author_npub, updated_at",
      pending_writes: "++id, family, record_id, created_at",
    });

    this.version(2).stores({
      workspace_profiles: "record_id, slug, updated_at",
      events: "record_id, slug, state, starts_at, sort_order, updated_at",
      topics: "record_id, event_id, slug, state, sort_order, updated_at",
      comments: "record_id, topic_id, state, updated_at",
      profiles: "record_id, author_npub, updated_at",
      profile_cache: "npub, updated_at",
      pending_writes: "++id, family, record_id, created_at",
    });
  }
}

export const db = new PerthAiDb();
