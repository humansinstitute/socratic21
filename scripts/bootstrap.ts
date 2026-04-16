import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import readline from "node:readline";
import { stdin as input, stdout as output } from "node:process";
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  nip19,
  nip44,
} from "nostr-tools";

type BootstrapOptions = {
  adminNsec: string | null;
  towerUrl: string;
  workspaceName: string;
  workspaceSlug: string;
  publicGroupName: string;
  outputPath: string;
  force: boolean;
};

type Identity = {
  secret: Uint8Array;
  secretHex: string;
  nsec: string;
  pubkey: string;
  npub: string;
};

type MemberKey = {
  member_npub: string;
  wrapped_group_nsec: string;
  wrapped_by_npub: string;
};

type WorkspaceCreateResponse = {
  workspace_owner_npub: string;
  creator_npub: string;
  default_group_id: string;
  default_group_npub: string;
  admin_group_id: string;
  admin_group_npub: string;
  private_group_id: string;
  private_group_npub: string;
  wrapped_workspace_nsec: string;
  wrapped_by_npub: string;
};

type GroupCreateResponse = {
  group_id: string;
  group_npub: string;
  owner_npub: string;
  name: string;
  group_kind: string;
};

const DEFAULT_TOWER_URL = "https://sb4.otherstuff.ai";
const DEFAULT_WORKSPACE_NAME = "Perth AI";
const DEFAULT_WORKSPACE_SLUG = "perth-ai";
const DEFAULT_PUBLIC_GROUP_NAME = "Public";
const DEFAULT_OUTPUT_PATH = ".env";
const NIP98_KIND = 27235;

function usage() {
  return `
Perth AI bootstrap

Usage:
  bun run bootstrap -- [options]

Options:
  --admin-nsec <nsec>         Admin nsec used for Tower bootstrap
  --tower-url <url>           Tower base URL (default: ${DEFAULT_TOWER_URL})
  --workspace-name <name>     Workspace display name (default: ${DEFAULT_WORKSPACE_NAME})
  --workspace-slug <slug>     Workspace slug (default: ${DEFAULT_WORKSPACE_SLUG})
  --public-group-name <name>  Public group name (default: ${DEFAULT_PUBLIC_GROUP_NAME})
  --output <path>             Output env file path (default: ${DEFAULT_OUTPUT_PATH})
  --force                     Overwrite existing env file
  --help                      Show this help

Admin secret precedence:
  1. --admin-nsec
  2. ADMIN_NSEC env var
  3. interactive prompt
`.trim();
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function decodeNsec(value: string): Uint8Array {
  const decoded = nip19.decode(String(value || "").trim());
  if (decoded.type !== "nsec" || !(decoded.data instanceof Uint8Array)) {
    throw new Error("Invalid nsec");
  }
  return decoded.data;
}

function decodeNpub(value: string): string {
  const decoded = nip19.decode(String(value || "").trim());
  if (decoded.type !== "npub" || typeof decoded.data !== "string") {
    throw new Error("Invalid npub");
  }
  return decoded.data;
}

function normalizeUrl(url: string): string {
  const trimmed = String(url || "").trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

function slugify(value: string): string {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "workspace";
}

function envLine(key: string, value: string): string {
  return `${key}=${shellEscapeEnv(value)}`;
}

function shellEscapeEnv(value: string): string {
  if (value === "") return '""';
  if (!/[^\w@%+=:,./-]/.test(value)) return value;
  return JSON.stringify(value);
}

function encodeBase64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

function buildConnectionToken(input: {
  directHttpsUrl: string;
  workspaceOwnerNpub: string;
  appNpub: string;
}) {
  const payload = {
    type: "superbased_connection",
    version: 2,
    direct_https_url: input.directHttpsUrl,
    workspace_owner_npub: input.workspaceOwnerNpub,
    app_npub: input.appNpub,
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
}

function generateIdentity(): Identity {
  const secret = generateSecretKey();
  const pubkey = getPublicKey(secret);
  return {
    secret,
    secretHex: bytesToHex(secret),
    nsec: nip19.nsecEncode(secret),
    pubkey,
    npub: nip19.npubEncode(pubkey),
  };
}

function buildUnsignedHttpAuthEvent(url: string, method: string, payloadHash: string | null) {
  const tags: string[][] = [
    ["u", url],
    ["method", method.toUpperCase()],
  ];
  if (payloadHash) tags.push(["payload", payloadHash]);
  return {
    kind: NIP98_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: "",
  };
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function createNip98AuthHeaderForSecret(
  url: string,
  method: string,
  body: unknown,
  secret: Uint8Array,
): string {
  let payloadHash: string | null = null;
  if (body !== null && body !== undefined && ["POST", "PUT", "PATCH"].includes(method.toUpperCase())) {
    payloadHash = sha256Hex(typeof body === "string" ? body : JSON.stringify(body));
  }
  const event = finalizeEvent(buildUnsignedHttpAuthEvent(url, method, payloadHash), secret);
  return `Nostr ${Buffer.from(JSON.stringify(event), "utf8").toString("base64")}`;
}

function localEncryptForNpub(secret: Uint8Array, npub: string, plaintext: string): string {
  return nip44.encrypt(plaintext, nip44.getConversationKey(secret, decodeNpub(npub)));
}

function personalEncryptForNpub(secret: Uint8Array, npub: string, plaintext: string): string {
  return localEncryptForNpub(secret, npub, plaintext);
}

async function buildWrappedMemberKeys(
  groupIdentity: Identity,
  memberNpubs: string[],
  wrappedByNpub: string,
  wrappedBySecret: Uint8Array,
): Promise<MemberKey[]> {
  const uniqueMembers = [...new Set(memberNpubs.map((value) => String(value || "").trim()).filter(Boolean))];
  return Promise.all(
    uniqueMembers.map(async (member_npub) => ({
      member_npub,
      wrapped_group_nsec: personalEncryptForNpub(wrappedBySecret, member_npub, groupIdentity.nsec),
      wrapped_by_npub: wrappedByNpub,
    })),
  );
}

async function promptHidden(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!input.isTTY || !output.isTTY) {
      reject(new Error("Interactive prompt requires a TTY"));
      return;
    }

    const rl = readline.createInterface({ input, output, terminal: true });
    const onData = (char: Buffer) => {
      const value = char.toString("utf8");
      if (value === "\n" || value === "\r" || value === "\u0004") {
        output.write("\n");
        return;
      }
      readline.cursorTo(output, 0);
      output.write(`${question}${"*".repeat(rl.line.length)}`);
    };

    input.on("data", onData);
    rl.question(question, (answer) => {
      input.off("data", onData);
      rl.close();
      resolve(answer.trim());
    });
    rl.on("SIGINT", () => {
      input.off("data", onData);
      rl.close();
      reject(new Error("Prompt cancelled"));
    });
  });
}

async function resolveAdminNsec(cliValue: string | null): Promise<string> {
  if (cliValue && cliValue.trim()) return cliValue.trim();
  if (process.env.ADMIN_NSEC && process.env.ADMIN_NSEC.trim()) return process.env.ADMIN_NSEC.trim();
  return promptHidden("Admin nsec: ");
}

function parseArgs(argv: string[]): BootstrapOptions {
  let adminNsec: string | null = null;
  let towerUrl = DEFAULT_TOWER_URL;
  let workspaceName = DEFAULT_WORKSPACE_NAME;
  let workspaceSlug = DEFAULT_WORKSPACE_SLUG;
  let publicGroupName = DEFAULT_PUBLIC_GROUP_NAME;
  let outputPath = DEFAULT_OUTPUT_PATH;
  let force = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help") {
      console.log(usage());
      process.exit(0);
    }
    if (arg === "--force") {
      force = true;
      continue;
    }
    const next = argv[index + 1];
    if (arg === "--admin-nsec") {
      adminNsec = next ?? "";
      index += 1;
      continue;
    }
    if (arg === "--tower-url") {
      towerUrl = next ?? "";
      index += 1;
      continue;
    }
    if (arg === "--workspace-name") {
      workspaceName = next ?? "";
      index += 1;
      continue;
    }
    if (arg === "--workspace-slug") {
      workspaceSlug = next ?? "";
      index += 1;
      continue;
    }
    if (arg === "--public-group-name") {
      publicGroupName = next ?? "";
      index += 1;
      continue;
    }
    if (arg === "--output") {
      outputPath = next ?? "";
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return {
    adminNsec,
    towerUrl: normalizeUrl(towerUrl),
    workspaceName: String(workspaceName || "").trim() || DEFAULT_WORKSPACE_NAME,
    workspaceSlug: slugify(workspaceSlug || workspaceName || DEFAULT_WORKSPACE_SLUG),
    publicGroupName: String(publicGroupName || "").trim() || DEFAULT_PUBLIC_GROUP_NAME,
    outputPath: String(outputPath || "").trim() || DEFAULT_OUTPUT_PATH,
    force,
  };
}

async function signedJsonFetch<TResponse>(
  baseUrl: string,
  path: string,
  method: string,
  body: unknown,
  signerSecret: Uint8Array,
): Promise<TResponse> {
  const url = `${baseUrl}${path}`;
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: createNip98AuthHeaderForSecret(url, method, body, signerSecret),
      "Content-Type": "application/json",
    },
    body: body == null ? undefined : JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`${response.status} ${method} ${url}${text ? `: ${text}` : ""}`);
  }

  return response.json() as Promise<TResponse>;
}

async function createWorkspace(
  towerUrl: string,
  adminIdentity: Identity,
  workspaceIdentity: Identity,
  defaultGroupIdentity: Identity,
  adminGroupIdentity: Identity,
  privateGroupIdentity: Identity,
  workspaceName: string,
): Promise<WorkspaceCreateResponse> {
  const wrappedWorkspaceNsec = personalEncryptForNpub(
    adminIdentity.secret,
    adminIdentity.npub,
    workspaceIdentity.nsec,
  );

  const body = {
    workspace_owner_npub: workspaceIdentity.npub,
    name: workspaceName,
    description: "",
    wrapped_workspace_nsec: wrappedWorkspaceNsec,
    wrapped_by_npub: adminIdentity.npub,
    default_group_npub: defaultGroupIdentity.npub,
    default_group_name: `${workspaceName} Shared`,
    default_group_member_keys: await buildWrappedMemberKeys(
      defaultGroupIdentity,
      [adminIdentity.npub],
      adminIdentity.npub,
      adminIdentity.secret,
    ),
    admin_group_npub: adminGroupIdentity.npub,
    admin_group_name: "Workspace Admins",
    admin_group_member_keys: await buildWrappedMemberKeys(
      adminGroupIdentity,
      [adminIdentity.npub],
      adminIdentity.npub,
      adminIdentity.secret,
    ),
    private_group_npub: privateGroupIdentity.npub,
    private_group_name: "Private",
    private_group_member_keys: await buildWrappedMemberKeys(
      privateGroupIdentity,
      [adminIdentity.npub],
      adminIdentity.npub,
      adminIdentity.secret,
    ),
  };

  return signedJsonFetch<WorkspaceCreateResponse>(
    towerUrl,
    "/api/v4/workspaces",
    "POST",
    body,
    adminIdentity.secret,
  );
}

async function createPublicGroup(
  towerUrl: string,
  adminIdentity: Identity,
  workspaceOwnerNpub: string,
  publicGroupIdentity: Identity,
  publicGroupName: string,
): Promise<GroupCreateResponse> {
  const body = {
    owner_npub: workspaceOwnerNpub,
    name: publicGroupName,
    group_npub: publicGroupIdentity.npub,
    member_keys: await buildWrappedMemberKeys(
      publicGroupIdentity,
      [adminIdentity.npub, publicGroupIdentity.npub],
      adminIdentity.npub,
      adminIdentity.secret,
    ),
  };

  return signedJsonFetch<GroupCreateResponse>(
    towerUrl,
    "/api/v4/groups",
    "POST",
    body,
    adminIdentity.secret,
  );
}

function buildEnvContent(input: {
  towerUrl: string;
  workspaceName: string;
  workspaceSlug: string;
  appIdentity: Identity;
  workspaceIdentity: Identity;
  defaultGroupIdentity: Identity;
  adminGroupIdentity: Identity;
  privateGroupIdentity: Identity;
  publicGroupIdentity: Identity;
  workspaceResponse: WorkspaceCreateResponse;
  publicGroupResponse: GroupCreateResponse;
}) {
  const connectionToken = buildConnectionToken({
    directHttpsUrl: input.towerUrl,
    workspaceOwnerNpub: input.workspaceResponse.workspace_owner_npub,
    appNpub: input.appIdentity.npub,
  });

  const lines = [
    "# Generated by scripts/bootstrap.ts",
    envLine("TOWER_URL", input.towerUrl),
    envLine("WORKSPACE_NAME", input.workspaceName),
    envLine("WORKSPACE_SLUG", input.workspaceSlug),
    envLine("VITE_APP_NAME", input.workspaceName),
    envLine("VITE_WORKSPACE_NAME", input.workspaceName),
    envLine("VITE_WORKSPACE_SLUG", input.workspaceSlug),
    envLine("VITE_DEFAULT_SUPERBASED_URL", input.towerUrl),
    envLine("VITE_TOWER_URL", input.towerUrl),
    envLine("VITE_APP_NPUB", input.appIdentity.npub),
    envLine("VITE_WORKSPACE_OWNER_NPUB", input.workspaceResponse.workspace_owner_npub),
    envLine("VITE_PUBLIC_GROUP_ID", input.publicGroupResponse.group_id),
    envLine("VITE_PUBLIC_GROUP_NPUB", input.publicGroupResponse.group_npub),
    envLine("VITE_PUBLIC_GROUP_NSEC_B64", encodeBase64(input.publicGroupIdentity.nsec)),
    envLine("VITE_SUPERBASED_CONNECTION_TOKEN", connectionToken),
    "",
    envLine("APP_NSEC", input.appIdentity.nsec),
    envLine("APP_NPUB", input.appIdentity.npub),
    envLine("WORKSPACE_OWNER_NSEC", input.workspaceIdentity.nsec),
    envLine("WORKSPACE_OWNER_NPUB", input.workspaceResponse.workspace_owner_npub),
    envLine("DEFAULT_GROUP_ID", input.workspaceResponse.default_group_id),
    envLine("DEFAULT_GROUP_NPUB", input.workspaceResponse.default_group_npub),
    envLine("DEFAULT_GROUP_NSEC", input.defaultGroupIdentity.nsec),
    envLine("ADMIN_GROUP_ID", input.workspaceResponse.admin_group_id),
    envLine("ADMIN_GROUP_NPUB", input.workspaceResponse.admin_group_npub),
    envLine("ADMIN_GROUP_NSEC", input.adminGroupIdentity.nsec),
    envLine("PRIVATE_GROUP_ID", input.workspaceResponse.private_group_id),
    envLine("PRIVATE_GROUP_NPUB", input.workspaceResponse.private_group_npub),
    envLine("PRIVATE_GROUP_NSEC", input.privateGroupIdentity.nsec),
    envLine("PUBLIC_GROUP_ID", input.publicGroupResponse.group_id),
    envLine("PUBLIC_GROUP_NPUB", input.publicGroupResponse.group_npub),
    envLine("PUBLIC_GROUP_NSEC", input.publicGroupIdentity.nsec),
    "",
  ];

  return lines.join("\n");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const adminNsec = await resolveAdminNsec(options.adminNsec);
  const adminSecret = decodeNsec(adminNsec);
  const adminIdentity: Identity = {
    secret: adminSecret,
    secretHex: bytesToHex(adminSecret),
    nsec: adminNsec,
    pubkey: getPublicKey(adminSecret),
    npub: nip19.npubEncode(getPublicKey(adminSecret)),
  };

  const outputFile = Bun.file(options.outputPath);
  if (await outputFile.exists() && !options.force) {
    throw new Error(`${options.outputPath} already exists. Re-run with --force to overwrite.`);
  }

  const appIdentity = generateIdentity();
  const workspaceIdentity = generateIdentity();
  const defaultGroupIdentity = generateIdentity();
  const adminGroupIdentity = generateIdentity();
  const privateGroupIdentity = generateIdentity();
  const publicGroupIdentity = generateIdentity();

  console.log(`Bootstrapping workspace "${options.workspaceName}" at ${options.towerUrl}`);
  console.log(`Admin npub: ${adminIdentity.npub}`);

  const workspaceResponse = await createWorkspace(
    options.towerUrl,
    adminIdentity,
    workspaceIdentity,
    defaultGroupIdentity,
    adminGroupIdentity,
    privateGroupIdentity,
    options.workspaceName,
  );
  console.log(`Created workspace ${workspaceResponse.workspace_owner_npub}`);

  const publicGroupResponse = await createPublicGroup(
    options.towerUrl,
    adminIdentity,
    workspaceResponse.workspace_owner_npub,
    publicGroupIdentity,
    options.publicGroupName,
  );
  console.log(`Created public group ${publicGroupResponse.group_id} (${publicGroupResponse.group_npub})`);

  const envContent = buildEnvContent({
    towerUrl: options.towerUrl,
    workspaceName: options.workspaceName,
    workspaceSlug: options.workspaceSlug,
    appIdentity,
    workspaceIdentity,
    defaultGroupIdentity,
    adminGroupIdentity,
    privateGroupIdentity,
    publicGroupIdentity,
    workspaceResponse,
    publicGroupResponse,
  });

  await Bun.write(options.outputPath, envContent);

  console.log(`Wrote ${options.outputPath}`);
  console.log("");
  console.log("Summary");
  console.log(`  Workspace owner npub: ${workspaceResponse.workspace_owner_npub}`);
  console.log(`  App npub:             ${appIdentity.npub}`);
  console.log(`  Public group id:      ${publicGroupResponse.group_id}`);
  console.log(`  Public group npub:    ${publicGroupResponse.group_npub}`);
  console.log(`  Workspace slug:       ${options.workspaceSlug}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
