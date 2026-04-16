import { SimplePool, nip19 } from "nostr-tools";
import type { CachedProfile } from "./types";

const KIND_METADATA = 0;
const PROFILE_FETCH_TIMEOUT_MS = 2_500;
const DEFAULT_PROFILE_RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.primal.net",
  "wss://purplepag.es",
];

function decodeNpub(npub: string): string | null {
  try {
    const decoded = nip19.decode(String(npub || "").trim());
    return decoded.type === "npub" && typeof decoded.data === "string" ? decoded.data : null;
  } catch {
    return null;
  }
}

function parseMetadata(content: string) {
  try {
    const parsed = JSON.parse(content);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function fetchNostrProfilesByNpub(npubs: string[]): Promise<CachedProfile[]> {
  const unique = [...new Set(npubs.map((value) => String(value || "").trim()).filter(Boolean))];
  if (!unique.length) return [];

  const pubkeys = unique
    .map((npub) => ({ npub, pubkey: decodeNpub(npub) }))
    .filter((entry): entry is { npub: string; pubkey: string } => Boolean(entry.pubkey));
  if (!pubkeys.length) return [];

  const pool = new SimplePool();

  try {
    const events = await pool.querySync(
      DEFAULT_PROFILE_RELAYS,
      {
        kinds: [KIND_METADATA],
        authors: pubkeys.map((entry) => entry.pubkey),
      },
      { maxWait: PROFILE_FETCH_TIMEOUT_MS },
    );

    const latestByPubkey = new Map<string, (typeof events)[number]>();
    for (const event of events) {
      const current = latestByPubkey.get(event.pubkey);
      if (!current || current.created_at < event.created_at) {
        latestByPubkey.set(event.pubkey, event);
      }
    }

    const fetchedAt = new Date().toISOString();
    return pubkeys.flatMap(({ npub, pubkey }) => {
      const event = latestByPubkey.get(pubkey);
      if (!event) return [];
      const metadata = parseMetadata(event.content);
      if (!metadata) return [];
      return [{
        npub,
        display_name: String(metadata.display_name || metadata.name || metadata.username || "").trim(),
        avatar_url: String(metadata.picture || metadata.image || "").trim(),
        bio: String(metadata.about || metadata.bio || "").trim(),
        updated_at: fetchedAt,
        fetched_at: fetchedAt,
      }];
    });
  } finally {
    pool.destroy();
  }
}
