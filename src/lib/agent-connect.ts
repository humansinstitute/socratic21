import { nip19 } from "nostr-tools";
import { env } from "../env";

function trimUrl(value: string) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function withPath(base: string, path: string) {
  const root = trimUrl(base);
  return root ? `${root}${path}` : "";
}

function appPubkeyHexFromNpub(appNpub: string) {
  if (!appNpub) return null;
  try {
    const decoded = nip19.decode(String(appNpub).trim());
    return decoded.type === "npub" ? decoded.data : null;
  } catch {
    return null;
  }
}

export function buildSuperBasedConnectionToken() {
  const payload = {
    type: "superbased_connection",
    version: 2,
    direct_https_url: trimUrl(env.towerUrl),
    workspace_owner_npub: String(env.workspaceOwnerNpub || "").trim(),
    app_npub: String(env.appNpub || "").trim(),
  };
  return btoa(JSON.stringify(payload));
}

export function buildAgentConnectPackage(windowOrigin = "") {
  const connectionToken = env.connectionToken || buildSuperBasedConnectionToken();
  return {
    kind: "socratic_agent_connect",
    version: 1,
    generated_at: new Date().toISOString(),
    llms_url: withPath(windowOrigin, "/llms.txt"),
    site_url: trimUrl(windowOrigin),
    service: {
      direct_https_url: trimUrl(env.towerUrl),
      openapi_url: withPath(env.towerUrl, "/openapi.json"),
      docs_url: withPath(env.towerUrl, "/docs"),
      health_url: withPath(env.towerUrl, "/health"),
    },
    workspace: {
      name: env.workspaceName,
      slug: env.workspaceSlug,
      owner_npub: env.workspaceOwnerNpub,
    },
    app: {
      app_name: env.appName,
      app_npub: env.appNpub,
      app_pubkey: appPubkeyHexFromNpub(env.appNpub),
      record_families: {
        workspace_profile: `${env.appNpub}:workspace_profile`,
        event: `${env.appNpub}:event`,
        topic: `${env.appNpub}:topic`,
        comment: `${env.appNpub}:comment`,
        profile: `${env.appNpub}:profile`,
      },
    },
    groups: {
      public_group_id: env.publicGroupId,
      public_group_npub: env.publicGroupNpub,
    },
    connection_token: connectionToken,
  };
}

export function buildAgentInstructionText(windowOrigin = "") {
  const pkg = buildAgentConnectPackage(windowOrigin);
  return [
    `# ${env.workspaceName} agent connect`,
    "",
    "Use this workspace configuration when connecting an agent that needs to read or write Perth AI records in SuperBased.",
    "",
    "## Connect",
    `- Site URL: ${pkg.site_url || "(not available)"}`,
    `- Backend URL: ${pkg.service.direct_https_url}`,
    `- OpenAPI: ${pkg.service.openapi_url}`,
    `- Docs: ${pkg.service.docs_url}`,
    `- Health: ${pkg.service.health_url}`,
    `- Connection token: ${pkg.connection_token}`,
    "",
    "## Workspace identities",
    `- Workspace name: ${pkg.workspace.name}`,
    `- Workspace slug: ${pkg.workspace.slug}`,
    `- Workspace owner npub: ${pkg.workspace.owner_npub}`,
    `- App npub: ${pkg.app.app_npub}`,
    `- Public group id: ${pkg.groups.public_group_id}`,
    `- Public group npub: ${pkg.groups.public_group_npub}`,
    "",
    "## Record families",
    `- workspace_profile: ${pkg.app.record_families.workspace_profile}`,
    `- event: ${pkg.app.record_families.event}`,
    `- topic: ${pkg.app.record_families.topic}`,
    `- comment: ${pkg.app.record_families.comment}`,
    `- profile: ${pkg.app.record_families.profile}`,
    "",
    "## Agent workflow",
    "1. Import the connection token into the target agent or parse it manually.",
    "2. Use the backend URL for SuperBased/Tower v4 API requests.",
    "3. Scope record sync and fetches with owner_npub set to the workspace owner npub.",
    "4. If the agent needs admin powers, first grant its npub membership in the workspace_admin group from the Admin Access panel.",
    "5. After admin membership is granted, the agent must refresh wrapped group keys and decrypt its admin group key before attempting protected writes.",
    "6. For public-facing records, keep record_family_hash aligned with the app namespace shown above.",
    "",
    "## Write semantics",
    "- Records are append-only and versioned.",
    "- Record IDs in this app use stable prefixes like `event:<uuid>`, `topic:<uuid>`, `comment:<uuid>`, `profile:<author_npub>`, and `workspace_profile:<workspace_owner_npub>`.",
    "- Public posting paths use the public group. Admin editing paths use the workspace_admin group.",
    "",
    "## Example record families",
    JSON.stringify(pkg.app.record_families, null, 2),
    "",
    "## Agent connect package",
    JSON.stringify(pkg, null, 2),
  ].join("\n");
}
