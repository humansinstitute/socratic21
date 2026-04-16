export const env = {
  appName: String(import.meta.env.VITE_APP_NAME || "Perth AI").trim(),
  workspaceName: String(import.meta.env.VITE_WORKSPACE_NAME || "Perth AI").trim(),
  workspaceSlug: String(import.meta.env.VITE_WORKSPACE_SLUG || "perth-ai").trim(),
  towerUrl: String(import.meta.env.VITE_TOWER_URL || import.meta.env.VITE_DEFAULT_SUPERBASED_URL || "").trim().replace(/\/+$/, ""),
  appNpub: String(import.meta.env.VITE_APP_NPUB || "").trim(),
  workspaceOwnerNpub: String(import.meta.env.VITE_WORKSPACE_OWNER_NPUB || "").trim(),
  workspaceOwnerNsec: String(import.meta.env.WORKSPACE_OWNER_NSEC || "").trim(),
  publicGroupId: String(import.meta.env.VITE_PUBLIC_GROUP_ID || "").trim(),
  publicGroupNpub: String(import.meta.env.VITE_PUBLIC_GROUP_NPUB || "").trim(),
  publicGroupNsecB64: String(import.meta.env.VITE_PUBLIC_GROUP_NSEC_B64 || "").trim(),
  connectionToken: String(import.meta.env.VITE_SUPERBASED_CONNECTION_TOKEN || "").trim(),
};

if (!env.towerUrl) throw new Error("Missing VITE_TOWER_URL or VITE_DEFAULT_SUPERBASED_URL");
if (!env.appNpub) throw new Error("Missing VITE_APP_NPUB");
if (!env.workspaceOwnerNpub) throw new Error("Missing VITE_WORKSPACE_OWNER_NPUB");
if (!env.publicGroupId || !env.publicGroupNpub || !env.publicGroupNsecB64) {
  throw new Error("Missing public group environment variables");
}
