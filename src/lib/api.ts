import { env } from "../env";
import { createNip98AuthHeader } from "./auth";
import type { GroupListEntry, RecordsResponse, RecordResponse, SessionIdentity, StoragePrepared, SyncRecord, WrappedGroupKey } from "./types";

export type AuthContext = SessionIdentity;

function normalizeBody(body: unknown): string | undefined {
  if (body === undefined || body === null) return undefined;
  return typeof body === "string" ? body : JSON.stringify(body);
}

async function signedFetch(path: string, method: string, auth: AuthContext, body?: unknown) {
  const url = `${env.towerUrl}${path}`;
  const serialized = normalizeBody(body);
  const authorization = await createNip98AuthHeader(auth, url, method, body ?? null);
  return fetch(url, {
    method,
    headers: {
      Authorization: authorization,
      ...(serialized ? { "Content-Type": "application/json" } : {}),
    },
    body: serialized,
  });
}

async function signedJson<T>(path: string, method: string, auth: AuthContext, body?: unknown): Promise<T> {
  const response = await signedFetch(path, method, auth, body);
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`${response.status} ${method} ${path}${text ? `: ${text}` : ""}`);
  }
  return response.json() as Promise<T>;
}

export async function fetchFamilyRecords(auth: AuthContext, familyHash: string): Promise<RecordResponse[]> {
  const query = new URLSearchParams({
    owner_npub: env.workspaceOwnerNpub,
    record_family_hash: familyHash,
    limit: "1000",
  });
  const data = await signedJson<RecordsResponse>(`/api/v4/records?${query.toString()}`, "GET", auth);
  return data.records || [];
}

export async function syncSingleRecord(
  auth: AuthContext,
  record: SyncRecord,
  groupWriteTokens: Record<string, string>,
) {
  const result = await signedJson<{ synced: number; rejected: { record_id: string; reason: string }[] }>(
    "/api/v4/records/sync",
    "POST",
    auth,
    {
      owner_npub: env.workspaceOwnerNpub,
      records: [record],
      group_write_tokens: groupWriteTokens,
    },
  );
  const rejected = result.rejected || [];
  if (rejected.length > 0) {
    const reason = rejected.find((entry) => entry.record_id === record.record_id)?.reason || rejected[0]?.reason || "Record rejected by sync endpoint.";
    throw new Error(`Sync rejected for ${record.record_id}: ${reason}`);
  }
  if ((result.synced || 0) < 1) {
    throw new Error(`Sync did not persist ${record.record_id}.`);
  }
  return result;
}

export async function getWrappedGroupKeys(auth: AuthContext): Promise<WrappedGroupKey[]> {
  const query = new URLSearchParams({ member_npub: auth.npub });
  const data = await signedJson<{ keys: WrappedGroupKey[] }>(`/api/v4/groups/keys?${query.toString()}`, "GET", auth);
  return data.keys || [];
}

export async function getMemberGroups(auth: AuthContext): Promise<GroupListEntry[]> {
  const query = new URLSearchParams({ npub: auth.npub });
  const data = await signedJson<{ groups: GroupListEntry[] }>(`/api/v4/groups?${query.toString()}`, "GET", auth);
  return data.groups || [];
}

export async function addGroupMember(
  auth: AuthContext,
  groupId: string,
  body: { member_npub: string; wrapped_group_nsec: string; wrapped_by_npub: string },
) {
  return signedJson(`/api/v4/groups/${groupId}/members`, "POST", auth, body);
}

export async function prepareStorageObject(auth: AuthContext, body: Record<string, unknown>): Promise<StoragePrepared> {
  return signedJson<StoragePrepared>("/api/v4/storage/prepare", "POST", auth, body);
}

export async function uploadStorageObject(auth: AuthContext, objectId: string, base64Data: string) {
  return signedJson<{ object_id: string; size_bytes: number; content_type: string }>(
    `/api/v4/storage/${objectId}`,
    "PUT",
    auth,
    { base64_data: base64Data },
  );
}

export async function completeStorageObject(auth: AuthContext, objectId: string, body: Record<string, unknown>) {
  return signedJson<{ object_id: string; content_url: string }>(
    `/api/v4/storage/${objectId}/complete`,
    "POST",
    auth,
    body,
  );
}
