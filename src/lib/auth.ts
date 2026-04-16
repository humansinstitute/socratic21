import { finalizeEvent, generateSecretKey, getPublicKey, nip19, nip44 } from "nostr-tools";
import * as nip46 from "nostr-tools/nip46";
import type { AuthMethod, SessionIdentity } from "./types";

const SESSION_KEY = "perth-ai-local-session";
const NIP98_KIND = 27235;

let memoryBunkerSigner: any = null;

declare global {
  interface Window {
    nostr?: {
      getPublicKey: () => Promise<string>;
      signEvent: (event: {
        kind: number;
        created_at: number;
        tags: string[][];
        content: string;
        pubkey?: string;
      }) => Promise<unknown>;
      nip44?: {
        encrypt: (pubkey: string, plaintext: string) => Promise<string>;
        decrypt: (pubkey: string, ciphertext: string) => Promise<string>;
      };
    };
  }
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

export function hexToBytes(value: string): Uint8Array {
  return Uint8Array.from((value.match(/.{1,2}/g) || []).map((byte) => parseInt(byte, 16)));
}

export function decodeNsec(input: string): Uint8Array {
  const decoded = nip19.decode(String(input || "").trim());
  if (decoded.type !== "nsec" || !(decoded.data instanceof Uint8Array)) {
    throw new Error("Invalid nsec key.");
  }
  return decoded.data;
}

export function decodeNpub(input: string): string {
  const decoded = nip19.decode(String(input || "").trim());
  if (decoded.type !== "npub" || typeof decoded.data !== "string") {
    throw new Error("Invalid npub key.");
  }
  return decoded.data;
}

function normalizeSecret(secret: Uint8Array | string): Uint8Array {
  if (secret instanceof Uint8Array) return secret;
  return hexToBytes(secret);
}

export function createLocalIdentity(): SessionIdentity {
  const secret = generateSecretKey();
  const pubkey = getPublicKey(secret);
  return {
    method: "ephemeral",
    nsec: nip19.nsecEncode(secret),
    npub: nip19.npubEncode(pubkey),
    pubkey,
    secretHex: bytesToHex(secret),
  };
}

function identityFromSecret(secret: Uint8Array, method: AuthMethod): SessionIdentity {
  const pubkey = getPublicKey(secret);
  return {
    method,
    nsec: nip19.nsecEncode(secret),
    npub: nip19.npubEncode(pubkey),
    pubkey,
    secretHex: bytesToHex(secret),
  };
}

export function identityFromNsec(nsec: string): SessionIdentity {
  return identityFromSecret(decodeNsec(nsec), "secret");
}

export async function identityFromExtension(): Promise<SessionIdentity> {
  const pubkey = await getExtensionPublicKey();
  return {
    method: "extension",
    npub: nip19.npubEncode(pubkey),
    pubkey,
  };
}

export async function identityFromBunker(bunkerUri: string): Promise<SessionIdentity> {
  const signer = await withBunkerSigner(bunkerUri);
  const pubkey = await signer.getPublicKey();
  return {
    method: "bunker",
    npub: nip19.npubEncode(pubkey),
    pubkey,
    bunkerUri: bunkerUri.trim(),
  };
}

export function saveSession(session: SessionIdentity) {
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

export function loadSession(): SessionIdentity | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SessionIdentity>;
    if (!parsed?.method || !parsed?.pubkey || !parsed?.npub) return null;
    if ((parsed.method === "secret" || parsed.method === "ephemeral") && parsed.nsec) {
      return identityFromSecret(decodeNsec(parsed.nsec), parsed.method);
    }
    if (parsed.method === "extension") {
      return {
        method: "extension",
        pubkey: parsed.pubkey,
        npub: parsed.npub,
      };
    }
    if (parsed.method === "bunker" && parsed.bunkerUri) {
      return {
        method: "bunker",
        pubkey: parsed.pubkey,
        npub: parsed.npub,
        bunkerUri: parsed.bunkerUri,
      };
    }
    return null;
  } catch {
    return null;
  }
}

export function clearSession() {
  localStorage.removeItem(SESSION_KEY);
  memoryBunkerSigner = null;
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function buildHttpAuthEvent(url: string, method: string, payloadHash: string | null) {
  return {
    kind: NIP98_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ["u", url],
      ["method", method.toUpperCase()],
      ...(payloadHash ? [["payload", payloadHash]] : []),
    ],
    content: "",
  };
}

export async function waitForExtensionSigner(timeoutMs = 2500, intervalMs = 150) {
  if (hasExtensionSigner()) return true;
  if (typeof window === "undefined") return false;

  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    if (hasExtensionSigner()) return true;
  }

  return hasExtensionSigner();
}

export function hasExtensionSigner() {
  return typeof window !== "undefined" && Boolean(window.nostr?.getPublicKey && window.nostr?.signEvent);
}

export function hasExtensionNip44() {
  return typeof window !== "undefined" && Boolean(window.nostr?.nip44?.encrypt && window.nostr?.nip44?.decrypt);
}

export async function getExtensionPublicKey(): Promise<string> {
  if (!hasExtensionSigner()) {
    throw new Error("No NIP-07 browser extension found.");
  }
  return window.nostr!.getPublicKey();
}

async function signEventWithExtension(event: {
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
  pubkey?: string;
}) {
  if (!hasExtensionSigner()) {
    throw new Error("No NIP-07 browser extension found.");
  }
  return window.nostr!.signEvent(event);
}

async function withBunkerSigner(bunkerUri?: string | null) {
  if (memoryBunkerSigner) return memoryBunkerSigner;
  const value = String(bunkerUri || "").trim();
  if (!value) {
    throw new Error("No bunker connection available.");
  }
  const pointer = await nip46.parseBunkerInput(value);
  if (!pointer) {
    throw new Error("Unable to parse bunker details.");
  }
  const clientSecret = generateSecretKey();
  const signer = new nip46.BunkerSigner(clientSecret, pointer);
  await signer.connect();
  memoryBunkerSigner = signer;
  return signer;
}

async function withPersonalSigner(session: SessionIdentity) {
  if (session.method === "extension") {
    const available = await waitForExtensionSigner(900, 120);
    if (!available) throw new Error("No NIP-07 browser extension found.");
    if (!hasExtensionNip44()) {
      throw new Error("NIP-07 signer does not expose NIP-44 encryption.");
    }
    const currentPubkey = await getExtensionPublicKey();
    if (currentPubkey !== session.pubkey) {
      throw new Error("NIP-07 signer pubkey changed since login. Sign in again.");
    }
    return {
      encrypt: async (peerPubkeyHex: string, plaintext: string) => window.nostr!.nip44.encrypt(peerPubkeyHex, plaintext),
      decrypt: async (peerPubkeyHex: string, ciphertext: string) => window.nostr!.nip44.decrypt(peerPubkeyHex, ciphertext),
    };
  }

  if ((session.method === "secret" || session.method === "ephemeral") && session.nsec) {
    const secret = decodeNsec(session.nsec);
    return {
      encrypt: async (peerPubkeyHex: string, plaintext: string) => nip44.encrypt(plaintext, nip44.getConversationKey(secret, peerPubkeyHex)),
      decrypt: async (peerPubkeyHex: string, ciphertext: string) => nip44.decrypt(ciphertext, nip44.getConversationKey(secret, peerPubkeyHex)),
    };
  }

  if (session.method === "bunker") {
    const signer = await withBunkerSigner(session.bunkerUri);
    const anySigner = signer as any;
    if (anySigner?.nip44?.encrypt && anySigner?.nip44?.decrypt) {
      return {
        encrypt: async (peerPubkeyHex: string, plaintext: string) => anySigner.nip44.encrypt(peerPubkeyHex, plaintext),
        decrypt: async (peerPubkeyHex: string, ciphertext: string) => anySigner.nip44.decrypt(peerPubkeyHex, ciphertext),
      };
    }
    if (typeof anySigner?.nip44Encrypt === "function" && typeof anySigner?.nip44Decrypt === "function") {
      return {
        encrypt: async (peerPubkeyHex: string, plaintext: string) => anySigner.nip44Encrypt(peerPubkeyHex, plaintext),
        decrypt: async (peerPubkeyHex: string, ciphertext: string) => anySigner.nip44Decrypt(peerPubkeyHex, ciphertext),
      };
    }
    throw new Error("Bunker signer does not expose NIP-44 encryption.");
  }

  throw new Error("No usable signer available.");
}

export async function createNip98AuthHeader(
  session: SessionIdentity,
  url: string,
  method: string,
  body: unknown,
): Promise<string> {
  let payloadHash: string | null = null;
  if (body !== null && body !== undefined && ["POST", "PUT", "PATCH"].includes(method.toUpperCase())) {
    payloadHash = await sha256Hex(typeof body === "string" ? body : JSON.stringify(body));
  }

  const event = buildHttpAuthEvent(url, method, payloadHash);

  if ((session.method === "secret" || session.method === "ephemeral") && session.nsec) {
    const signedEvent = finalizeEvent(event, decodeNsec(session.nsec));
    return `Nostr ${btoa(JSON.stringify(signedEvent))}`;
  }

  if (session.method === "extension") {
    const available = await waitForExtensionSigner();
    if (!available) {
      throw new Error("No NIP-07 browser extension found.");
    }
    const pubkey = await getExtensionPublicKey();
    if (pubkey !== session.pubkey) {
      throw new Error("NIP-07 signer pubkey changed since login. Sign in again.");
    }
    const signedEvent = await signEventWithExtension({ ...event, pubkey });
    return `Nostr ${btoa(JSON.stringify(signedEvent))}`;
  }

  if (session.method === "bunker") {
    const signer = await withBunkerSigner(session.bunkerUri);
    const signedEvent = await signer.signEvent(event);
    return `Nostr ${btoa(JSON.stringify(signedEvent))}`;
  }

  throw new Error(`Unsupported NIP-98 auth method: ${session.method}`);
}

export async function createNip98AuthHeaderForSecret(
  url: string,
  method: string,
  body: unknown,
  secret: Uint8Array | string,
): Promise<string> {
  let payloadHash: string | null = null;
  if (body !== null && body !== undefined && ["POST", "PUT", "PATCH"].includes(method.toUpperCase())) {
    payloadHash = await sha256Hex(typeof body === "string" ? body : JSON.stringify(body));
  }

  const event = finalizeEvent(buildHttpAuthEvent(url, method, payloadHash), normalizeSecret(secret));
  return `Nostr ${btoa(JSON.stringify(event))}`;
}

export async function personalEncryptForNpub(session: SessionIdentity, npub: string, plaintext: string): Promise<string> {
  const signer = await withPersonalSigner(session);
  return signer.encrypt(decodeNpub(npub), plaintext);
}

export async function personalDecryptFromNpub(session: SessionIdentity, npub: string, ciphertext: string): Promise<string> {
  const signer = await withPersonalSigner(session);
  return signer.decrypt(decodeNpub(npub), ciphertext);
}

export function localEncryptForNpub(secret: Uint8Array, npub: string, plaintext: string): string {
  return nip44.encrypt(plaintext, nip44.getConversationKey(secret, decodeNpub(npub)));
}

export function localDecryptFromNpub(secret: Uint8Array, npub: string, ciphertext: string): string {
  return nip44.decrypt(ciphertext, nip44.getConversationKey(secret, decodeNpub(npub)));
}

export function decodeBase64Utf8(value: string): string {
  return atob(String(value || "").trim());
}

export function methodLabel(method: AuthMethod): string {
  if (method === "ephemeral") return "Local account";
  if (method === "secret") return "Imported nsec";
  if (method === "extension") return "Browser extension";
  return "Bunker";
}
