export type RouteName = "home" | "event" | "topic" | "login" | "profile" | "admin";

export type AppRoute = {
  name: RouteName;
  eventSlug?: string;
  topicSlug?: string;
};

export type AuthMethod = "ephemeral" | "secret" | "extension" | "bunker";

export type SessionIdentity = {
  method: AuthMethod;
  npub: string;
  pubkey: string;
  nsec?: string;
  secretHex?: string;
  bunkerUri?: string;
};

export type GroupSecret = {
  groupId: string;
  groupNpub: string;
  nsec: string;
  secret: Uint8Array;
  epoch: number;
  name: string;
};

export type StoragePrepared = {
  object_id: string;
  content_url: string;
  upload_url?: string;
  complete_url?: string;
};

export type WorkspaceProfile = {
  record_id: string;
  title: string;
  summary: string;
  description: string;
  hero_image_url: string;
  slug: string;
  state: "published" | "draft";
  author_npub: string;
  version: number;
  updated_at: string;
};

export type EventRecord = {
  record_id: string;
  slug: string;
  title: string;
  summary: string;
  description: string;
  starts_at: string;
  ends_at: string;
  timezone: string;
  venue_name: string;
  venue_address: string;
  external_url: string;
  hero_image_url: string;
  state: "draft" | "published" | "hidden" | "archived" | "deleted";
  sort_order: number;
  author_npub: string;
  version: number;
  updated_at: string;
};

export type TopicRecord = {
  record_id: string;
  event_id: string;
  slug: string;
  title: string;
  description_markdown: string;
  description_excerpt: string;
  state: "draft" | "published" | "hidden" | "archived" | "deleted";
  sort_order: number;
  author_npub: string;
  version: number;
  updated_at: string;
};

export type CommentRecord = {
  record_id: string;
  topic_id: string;
  body_markdown: string;
  state: "visible" | "hidden" | "deleted";
  author_npub: string;
  version: number;
  updated_at: string;
};

export type ProfileRecord = {
  record_id: string;
  author_npub: string;
  display_name: string;
  avatar_url: string;
  bio: string;
  version: number;
  updated_at: string;
};

export type CachedProfile = {
  npub: string;
  display_name: string;
  avatar_url: string;
  bio?: string;
  updated_at: string;
  fetched_at?: string;
};

export type RecordResponse = {
  record_id: string;
  owner_npub: string;
  record_family_hash: string;
  version: number;
  previous_version: number;
  signature_npub: string;
  owner_payload: { ciphertext: string };
  group_payloads: {
    group_id?: string;
    group_epoch?: number;
    group_npub: string;
    ciphertext: string;
    write: boolean;
  }[];
  updated_at: string;
};

export type SyncRecord = RecordResponse & {
  write_group_id?: string;
  write_group_npub?: string;
};

export type RecordsResponse = {
  records: RecordResponse[];
  total: number;
  limit: number;
  offset: number;
  has_more: boolean;
};

export type WrappedGroupKey = {
  group_id: string;
  group_npub: string;
  epoch: number;
  name: string;
  member_npub: string;
  wrapped_group_nsec: string;
  wrapped_by_npub: string;
  approved_by_npub: string;
  key_version: number;
};

export type GroupListEntry = {
  id: string;
  group_npub: string;
  owner_npub: string;
  name: string;
  group_kind: string;
  private_member_npub: string | null;
  current_epoch: number;
  members: string[];
};

export type PendingWrite = {
  id?: number;
  family: string;
  record_id: string;
  action: string;
  created_at: string;
};
