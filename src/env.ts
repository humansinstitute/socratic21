declare global {
  interface Window {
    __APP_CONFIG__?: Record<string, string | undefined>;
  }
}

function runtimeConfigValue(...keys: string[]) {
  if (typeof window === "undefined" || !window.__APP_CONFIG__) return "";
  for (const key of keys) {
    const value = String(window.__APP_CONFIG__[key] || "").trim();
    if (value) return value;
  }
  return "";
}

function buildConfigValue(...keys: string[]) {
  for (const key of keys) {
    const value = String(import.meta.env[key] || "").trim();
    if (value) return value;
  }
  return "";
}

function configValue(runtimeKeys: string[], buildKeys = runtimeKeys) {
  return runtimeConfigValue(...runtimeKeys) || buildConfigValue(...buildKeys);
}

export const env = {
  appName: configValue(["VITE_APP_NAME", "APP_NAME"]) || "Perth AI",
  workspaceName: configValue(["VITE_WORKSPACE_NAME", "WORKSPACE_NAME"]) || "Perth AI",
  workspaceSlug: configValue(["VITE_WORKSPACE_SLUG", "WORKSPACE_SLUG"]) || "perth-ai",
  meetupUrl: configValue(["VITE_MEETUP_URL", "MEETUP_URL"]) || "https://www.meetup.com/perth-ai-agents/",
  towerUrl: configValue(["VITE_TOWER_URL", "VITE_DEFAULT_SUPERBASED_URL", "TOWER_URL"]).replace(/\/+$/, ""),
  appNpub: configValue(["VITE_APP_NPUB", "APP_NPUB"]),
  workspaceOwnerNpub: configValue(["VITE_WORKSPACE_OWNER_NPUB", "WORKSPACE_OWNER_NPUB"]),
  workspaceOwnerNsec: configValue(["WORKSPACE_OWNER_NSEC"]),
  publicGroupId: configValue(["VITE_PUBLIC_GROUP_ID", "PUBLIC_GROUP_ID"]),
  publicGroupNpub: configValue(["VITE_PUBLIC_GROUP_NPUB", "PUBLIC_GROUP_NPUB"]),
  publicGroupNsecB64: configValue(["VITE_PUBLIC_GROUP_NSEC_B64", "PUBLIC_GROUP_NSEC_B64"]),
  connectionToken: configValue(["VITE_SUPERBASED_CONNECTION_TOKEN"]),
};

if (!env.towerUrl) throw new Error("Missing VITE_TOWER_URL or VITE_DEFAULT_SUPERBASED_URL");
if (!env.appNpub) throw new Error("Missing VITE_APP_NPUB");
if (!env.workspaceOwnerNpub) throw new Error("Missing VITE_WORKSPACE_OWNER_NPUB");
if (!env.publicGroupId || !env.publicGroupNpub || !env.publicGroupNsecB64) {
  throw new Error("Missing public group environment variables");
}
