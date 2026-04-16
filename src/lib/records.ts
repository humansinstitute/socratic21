import { env } from "../env";
import { decodeBase64Utf8, decodeNsec, identityFromNsec, localDecryptFromNpub, localEncryptForNpub, personalDecryptFromNpub } from "./auth";
import type {
  CommentRecord,
  EventRecord,
  GroupSecret,
  ProfileRecord,
  RecordResponse,
  SessionIdentity,
  SyncRecord,
  TopicRecord,
  WorkspaceProfile,
} from "./types";

type FamilyName = "workspace_profile" | "event" | "topic" | "comment" | "profile";

type AccessibleGroups = {
  byId: Map<string, GroupSecret>;
  byNpub: Map<string, GroupSecret>;
};

export const PUBLIC_GROUP_SECRET: GroupSecret = {
  groupId: env.publicGroupId,
  groupNpub: env.publicGroupNpub,
  nsec: decodeBase64Utf8(env.publicGroupNsecB64),
  secret: decodeNsec(decodeBase64Utf8(env.publicGroupNsecB64)),
  epoch: 1,
  name: "Public",
};

export function buildAccessibleGroups(groups: GroupSecret[]): AccessibleGroups {
  const byId = new Map<string, GroupSecret>();
  const byNpub = new Map<string, GroupSecret>();
  for (const group of groups) {
    if (group.groupId) byId.set(group.groupId, group);
    byNpub.set(group.groupNpub, group);
  }
  return { byId, byNpub };
}

function parsePayloadJson(raw: string): unknown {
  return JSON.parse(raw);
}

function parseEnvelope(raw: string): { encrypted_by_npub: string; ciphertext: string } | null {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.encrypted_by_npub === "string" && typeof parsed.ciphertext === "string") {
      return parsed;
    }
  } catch {
    return null;
  }
  return null;
}

export function recordFamilyHash(name: FamilyName): string {
  return `${env.appNpub}:${name}`;
}

export function makeRecordId(prefix: string) {
  return `${prefix}:${crypto.randomUUID()}`;
}

export function profileRecordId(authorNpub: string) {
  return `profile:${authorNpub}`;
}

export function workspaceProfileRecordId() {
  return `workspace_profile:${env.workspaceOwnerNpub}`;
}

export function slugify(value: string) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "item";
}

function buildOwnerPayload(sender: SessionIdentity, ownerNpub: string, payload: unknown) {
  if (!sender.nsec) throw new Error("Signer secret is required to build owner payload.");
  return {
    ciphertext: JSON.stringify({
      encrypted_by_npub: sender.npub,
      ciphertext: localEncryptForNpub(decodeNsec(sender.nsec), ownerNpub, JSON.stringify(payload)),
    }),
  };
}

type PayloadGroup = {
  groupId: string;
  groupNpub: string;
  groupSecret: Uint8Array;
  epoch: number;
  write: boolean;
};

function buildGroupPayloads(sender: SessionIdentity, groups: PayloadGroup[], payload: unknown) {
  if (!sender.nsec) throw new Error("Signer secret is required to build group payloads.");
  const plaintext = JSON.stringify(payload);
  return groups.map((group) => ({
    group_id: group.groupId,
    group_epoch: group.epoch,
    group_npub: group.groupNpub,
    ciphertext: JSON.stringify({
      encrypted_by_npub: sender.npub,
      ciphertext: localEncryptForNpub(group.groupSecret, sender.npub, plaintext),
    }),
    write: group.write,
  }));
}

export function buildRecordEnvelope(
  family: FamilyName,
  data: Record<string, unknown>,
  options: {
    recordId: string;
    sender: SessionIdentity;
    ownerNpub?: string;
    previousVersion?: number;
    version?: number;
    writeGroupId: string;
    payloadGroups: PayloadGroup[];
  },
): SyncRecord {
  const payload = {
    app_namespace: env.appNpub,
    collection_space: family,
    schema_version: 1,
    record_id: options.recordId,
    data,
  };

  return {
    record_id: options.recordId,
    owner_npub: options.ownerNpub || env.workspaceOwnerNpub,
    record_family_hash: recordFamilyHash(family),
    version: options.version ?? (options.previousVersion ?? 0) + 1,
    previous_version: options.previousVersion ?? 0,
    signature_npub: options.sender.npub,
    write_group_id: options.writeGroupId,
    owner_payload: buildOwnerPayload(options.sender, options.ownerNpub || env.workspaceOwnerNpub, payload),
    group_payloads: buildGroupPayloads(options.sender, options.payloadGroups, payload),
    updated_at: new Date().toISOString(),
  } as SyncRecord;
}

export async function decryptRecordPayload(record: RecordResponse, accessibleGroups: AccessibleGroups, ownerSession?: SessionIdentity | null) {
  const ownerCiphertext = record.owner_payload?.ciphertext;
  if (ownerSession && ownerCiphertext) {
    const envelope = parseEnvelope(ownerCiphertext);
    if (envelope?.encrypted_by_npub) {
      try {
        const decrypted = await personalDecryptFromNpub(ownerSession, envelope.encrypted_by_npub, envelope.ciphertext);
        return parsePayloadJson(decrypted);
      } catch {
        // continue to group path
      }
    }
  }

  for (const payload of record.group_payloads || []) {
    const group = (payload.group_id && accessibleGroups.byId.get(payload.group_id)) || accessibleGroups.byNpub.get(payload.group_npub);
    if (!group) continue;
    const envelope = parseEnvelope(payload.ciphertext);
    if (!envelope) continue;
    try {
      const decrypted = localDecryptFromNpub(group.secret, envelope.encrypted_by_npub, envelope.ciphertext);
      return parsePayloadJson(decrypted);
    } catch {
      // try next group
    }
  }

  throw new Error(`Unable to decrypt ${record.record_id}`);
}

export function inboundWorkspaceProfile(record: RecordResponse, payload: any): WorkspaceProfile {
  const data = payload.data ?? payload;
  return {
    record_id: record.record_id,
    title: String(data.title || env.workspaceName || "Perth AI"),
    summary: String(data.summary || ""),
    description: String(data.description || ""),
    hero_image_url: String(data.hero_image_url || ""),
    slug: String(data.slug || env.workspaceSlug),
    state: data.state === "draft" ? "draft" : "published",
    author_npub: String(data.author_npub || record.signature_npub),
    version: record.version,
    updated_at: record.updated_at,
  };
}

export function inboundEvent(record: RecordResponse, payload: any): EventRecord {
  const data = payload.data ?? payload;
  return {
    record_id: record.record_id,
    slug: String(data.slug || ""),
    title: String(data.title || ""),
    summary: String(data.summary || ""),
    description: String(data.description || ""),
    starts_at: String(data.starts_at || ""),
    ends_at: String(data.ends_at || ""),
    timezone: String(data.timezone || "Australia/Perth"),
    venue_name: String(data.venue_name || ""),
    venue_address: String(data.venue_address || ""),
    external_url: String(data.external_url || ""),
    hero_image_url: String(data.hero_image_url || ""),
    state: normalizeEventState(data.state),
    sort_order: Number(data.sort_order || 0),
    author_npub: String(data.author_npub || record.signature_npub),
    version: record.version,
    updated_at: record.updated_at,
  };
}

export function inboundTopic(record: RecordResponse, payload: any): TopicRecord {
  const data = payload.data ?? payload;
  const body = String(data.description_markdown || "");
  return {
    record_id: record.record_id,
    event_id: String(data.event_id || ""),
    slug: String(data.slug || ""),
    title: String(data.title || ""),
    description_markdown: body,
    description_excerpt: String(data.description_excerpt || excerpt(body)),
    state: normalizeEventState(data.state),
    sort_order: Number(data.sort_order || 0),
    author_npub: String(data.author_npub || record.signature_npub),
    version: record.version,
    updated_at: record.updated_at,
  };
}

export function inboundComment(record: RecordResponse, payload: any): CommentRecord {
  const data = payload.data ?? payload;
  return {
    record_id: record.record_id,
    topic_id: String(data.topic_id || ""),
    body_markdown: String(data.body_markdown || ""),
    state: normalizeCommentState(data.state),
    author_npub: String(data.author_npub || record.signature_npub),
    version: record.version,
    updated_at: record.updated_at,
  };
}

export function inboundProfile(record: RecordResponse, payload: any): ProfileRecord {
  const data = payload.data ?? payload;
  return {
    record_id: record.record_id,
    author_npub: String(data.author_npub || record.signature_npub),
    display_name: String(data.display_name || ""),
    avatar_url: String(data.avatar_url || ""),
    bio: String(data.bio || ""),
    version: record.version,
    updated_at: record.updated_at,
  };
}

export function normalizeEventState(state: unknown): EventRecord["state"] {
  const value = String(state || "");
  if (value === "published" || value === "hidden" || value === "archived" || value === "deleted") return value;
  return "draft";
}

export function normalizeCommentState(state: unknown): CommentRecord["state"] {
  const value = String(state || "");
  if (value === "hidden" || value === "deleted") return value;
  return "visible";
}

export function excerpt(markdown: string, limit = 160) {
  const collapsed = String(markdown || "").replace(/[#*_`>\n]/g, " ").replace(/\s+/g, " ").trim();
  if (collapsed.length <= limit) return collapsed;
  return `${collapsed.slice(0, limit - 1).trim()}…`;
}

export function publicSignerIdentity(): SessionIdentity {
  return identityFromNsec(PUBLIC_GROUP_SECRET.nsec);
}
