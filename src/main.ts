import Alpine from "alpinejs";
import { marked } from "marked";
import "./styles.css";
import { env } from "./env";
import {
  createNip98AuthHeaderForSecret,
  createLocalIdentity,
  decodeNsec,
  decodeNpub,
  hasExtensionSigner,
  identityFromBunker,
  identityFromExtension,
  identityFromNsec,
  loadSession,
  methodLabel,
  personalEncryptForNpub,
  personalDecryptFromNpub,
  saveSession,
  clearSession,
  waitForExtensionSigner,
} from "./lib/auth";
import { db } from "./lib/db";
import { addGroupMember, completeStorageObject, fetchFamilyRecords, getMemberGroups, getWrappedGroupKeys, prepareStorageObject, syncSingleRecord, uploadStorageObject, type AuthContext } from "./lib/api";
import { buildAgentConnectPackage, buildAgentInstructionText } from "./lib/agent-connect";
import { fetchNostrProfilesByNpub } from "./lib/nostr";
import {
  PUBLIC_GROUP_SECRET,
  buildAccessibleGroups,
  buildRecordEnvelope,
  decryptRecordPayload,
  excerpt,
  inboundComment,
  inboundEvent,
  inboundProfile,
  inboundTopic,
  inboundWorkspaceProfile,
  makeRecordId,
  profileRecordId,
  publicSignerIdentity,
  recordFamilyHash,
  slugify,
  workspaceProfileRecordId,
} from "./lib/records";
import type { AppRoute, CachedProfile, CommentRecord, EventRecord, GroupListEntry, GroupSecret, ProfileRecord, SessionIdentity, TopicRecord, WorkspaceProfile, WrappedGroupKey } from "./lib/types";

marked.setOptions({
  breaks: true,
  gfm: true,
});

const SESSION_REFRESH_MS = 30_000;
const PROFILE_CACHE_KEY = "perth-ai-profile-cache";
const PROFILE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

function parseRoute(pathname = window.location.pathname): AppRoute {
  const parts = pathname.replace(/\/+$/, "").split("/").filter(Boolean);
  if (parts.length === 0) return { name: "home" };
  if (parts[0] === "login") return { name: "login" };
  if (parts[0] === "profile") return { name: "profile" };
  if (parts[0] === "admin") return { name: "admin" };
  if (parts[0] === "events" && parts[1] && !parts[2]) return { name: "event", eventSlug: parts[1] };
  if (parts[0] === "events" && parts[1] && parts[2] === "topics" && parts[3]) {
    return { name: "topic", eventSlug: parts[1], topicSlug: parts[3] };
  }
  return { name: "home" };
}

function formatDateInput(value: string) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const tzOffset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - tzOffset).toISOString().slice(0, 16);
}

function fromDateInput(value: string) {
  if (!value) return "";
  return new Date(value).toISOString();
}

function sortByUpdated<T extends { updated_at: string }>(rows: T[]) {
  return [...rows].sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
}

function enhanceMarkdownMedia(html: string) {
  if (typeof document === "undefined" || !html.includes("<img")) return html;

  const template = document.createElement("template");
  template.innerHTML = html;

  for (const original of template.content.querySelectorAll("img")) {
    if (original.closest(".markdown-media")) continue;
    const src = original.getAttribute("src");
    if (!src) continue;

    const wrapper = document.createElement("span");
    wrapper.className = "markdown-media";

    const background = document.createElement("span");
    background.className = "markdown-media-bg";

    const backgroundImage = document.createElement("img");
    backgroundImage.src = src;
    backgroundImage.alt = "";
    backgroundImage.setAttribute("aria-hidden", "true");

    const foreground = document.createElement("img");
    foreground.className = "markdown-media-img";
    foreground.src = src;
    foreground.alt = original.getAttribute("alt") || "";
    foreground.loading = "lazy";
    foreground.decoding = "async";

    const title = original.getAttribute("title");
    if (title) foreground.title = title;

    background.append(backgroundImage);
    wrapper.append(background, foreground);

    if (original.parentElement?.tagName === "P" && original.parentElement.childNodes.length === 1) {
      original.parentElement.replaceWith(wrapper);
    } else {
      original.replaceWith(wrapper);
    }
  }

  return template.innerHTML;
}

async function fileToBase64(file: File) {
  const buffer = await file.arrayBuffer();
  let binary = "";
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function authFromIdentity(identity: SessionIdentity): AuthContext {
  return identity;
}

type StoreShape = Record<string, unknown> & {
  init: () => Promise<void>;
};

function perthAiApp(): StoreShape {
  return {
    route: parseRoute(),
    loading: false,
    saving: false,
    error: "",
    notice: "",
    accountMenuOpen: false,
    eventTab: "about" as "about" | "topics",
	    modals: {
	      submitTopic: false,
	      workspace: false,
	      event: false,
	      topic: false,
	      agentConnect: false,
	    },
    session: null as SessionIdentity | null,
    isAdmin: false,
    workspaceProfile: null as WorkspaceProfile | null,
    events: [] as EventRecord[],
    topics: [] as TopicRecord[],
    comments: [] as CommentRecord[],
    profiles: [] as ProfileRecord[],
    profileCache: {} as Record<string, CachedProfile>,
    memberGroups: [] as GroupListEntry[],
    _groupSecrets: [PUBLIC_GROUP_SECRET] as GroupSecret[],
    refreshHandle: 0 as number,
    extensionSignerAvailable: false,
	    loginForm: {
	      nsec: "",
	      bunkerUri: "",
	    },
	    adminAccessForm: {
	      npub: "",
	    },
	    meetupUrl: env.meetupUrl,
	    topicActionMenuId: "",
	    agentConnectView: "instructions" as "instructions" | "package",
	    agentConnectCopied: false,
	    agentPackageCopied: false,
    profileForm: {
      display_name: "",
      avatar_url: "",
      bio: "",
    },
    workspaceForm: {
      title: env.workspaceName,
      summary: "",
      description: "",
      hero_image_url: "",
    },
    eventFeedback: "",
    eventFeedbackTone: "idle",
    eventForm: {
      record_id: "",
      title: "",
      slug: "",
      summary: "",
      description: "",
      starts_at: "",
      ends_at: "",
      timezone: "Australia/Perth",
      venue_name: "",
      venue_address: "",
      external_url: "",
      hero_image_url: "",
      state: "draft",
    },
    topicForm: {
      record_id: "",
      event_id: "",
      slug: "",
      title: "",
      description_markdown: "",
      state: "draft",
    },
    topicSubmissionForm: {
      event_id: "",
      title: "",
      description_markdown: "",
    },
    commentDraft: {
      body: "",
    },

	    async init() {
      this.loading = true;
      this.session = loadSession();
      this.loadProfileCacheFromStorage();
      await this.loadProfileCacheFromDb();
      this.seedFormsFromSession();
      await this.refreshExtensionSignerAvailability();
	      window.addEventListener("popstate", () => {
	        this.route = parseRoute();
	        this.accountMenuOpen = false;
	        this.closeAllModals();
	        this.clearNotice();
	        this.syncRouteContextFromLocation();
	      });
      window.addEventListener("focus", () => {
        this.refreshExtensionSignerAvailability().catch(() => undefined);
      });
	      await this.reloadFromDb();
	      await this.refreshAll();
	      this.syncRouteContextFromLocation();
	      this.refreshHandle = window.setInterval(() => {
        this.refreshAll().catch((error) => {
          console.error(error);
        });
      }, SESSION_REFRESH_MS);
      this.loading = false;
    },

    async refreshExtensionSignerAvailability() {
      this.extensionSignerAvailable = hasExtensionSigner();
      if (!this.extensionSignerAvailable) {
        this.extensionSignerAvailable = await waitForExtensionSigner(900, 120);
      }
      return this.extensionSignerAvailable;
    },

    clearNotice() {
      this.notice = "";
      this.error = "";
    },

    async refreshAll() {
      this.loading = true;
      this.clearNotice();
      try {
        await this.refreshPublicFamilies();
        if (this.session) {
          await this.refreshMemberAccess();
          if (this.isAdmin) {
            await this.refreshAdminFamilies();
          }
        } else {
          this.isAdmin = false;
          this.memberGroups = [];
          this._groupSecrets = [PUBLIC_GROUP_SECRET];
        }
        await this.reloadFromDb();
        await this.refreshNostrProfiles();
        this.seedFormsFromSession();
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error);
      } finally {
        this.loading = false;
      }
    },

    async refreshPublicFamilies() {
      const publicAuth = authFromIdentity(publicSignerIdentity());
      await Promise.all([
        this.pullFamily("workspace_profile", publicAuth, false),
        this.pullFamily("event", publicAuth, false),
        this.pullFamily("topic", publicAuth, false),
        this.pullFamily("comment", publicAuth, false),
        this.pullFamily("profile", publicAuth, false),
      ]);
    },

    async refreshAdminFamilies() {
      if (!this.session) return;
      const auth = authFromIdentity(this.session);
      await Promise.all([
        this.pullFamily("workspace_profile", auth, true),
        this.pullFamily("event", auth, true),
        this.pullFamily("topic", auth, true),
        this.pullFamily("comment", auth, true),
        this.pullFamily("profile", auth, true),
      ]);
    },

    async refreshMemberAccess() {
      if (!this.session) return;
      const auth = authFromIdentity(this.session);
      const [groups, keys] = await Promise.all([
        getMemberGroups(auth),
        getWrappedGroupKeys(auth).catch(() => [] as WrappedGroupKey[]),
      ]);
      this.memberGroups = groups;
      const secrets: GroupSecret[] = [PUBLIC_GROUP_SECRET];
      for (const entry of keys) {
        try {
          const nsec = await personalDecryptFromNpub(this.session, entry.wrapped_by_npub, entry.wrapped_group_nsec);
          secrets.push({
            groupId: entry.group_id,
            groupNpub: entry.group_npub,
            nsec,
            secret: decodeNsec(nsec),
            epoch: entry.key_version || entry.epoch || 1,
            name: entry.name || "",
          });
        } catch {
          // ignore undecryptable keys
        }
      }
      this._groupSecrets = dedupeGroups(secrets);
      this.isAdmin = groups.some((group) => group.group_kind === "workspace_admin");
    },

    async pullFamily(family: "workspace_profile" | "event" | "topic" | "comment" | "profile", auth: AuthContext, includeAdmin: boolean) {
      const accessible = buildAccessibleGroups(this._groupSecrets);
      const records = await fetchFamilyRecords(auth, recordFamilyHash(family));
      for (const record of records) {
        try {
          const payload = await decryptRecordPayload(record, accessible, this.session);
          await this.materializeRecord(family, record, payload, includeAdmin);
        } catch {
          // skip inaccessible records
        }
      }
    },

    async materializeRecord(
      family: "workspace_profile" | "event" | "topic" | "comment" | "profile",
      record: any,
      payload: any,
      includeAdmin: boolean,
    ) {
      if (family === "workspace_profile") {
        const row = inboundWorkspaceProfile(record, payload);
        const existing = await db.workspace_profiles.get(row.record_id);
        if (!existing || existing.version <= row.version) await db.workspace_profiles.put(row);
        return;
      }

      if (family === "event") {
        const row = inboundEvent(record, payload);
        const existing = await db.events.get(row.record_id);
        if (!existing || existing.version <= row.version) await db.events.put(row);
        return;
      }

      if (family === "topic") {
        const row = inboundTopic(record, payload);
        const existing = await db.topics.get(row.record_id);
        if (!existing || existing.version <= row.version) await db.topics.put(row);
        return;
      }

      if (family === "comment") {
        const row = inboundComment(record, payload);
        const existing = await db.comments.get(row.record_id);
        if (!existing || existing.version <= row.version) await db.comments.put(row);
        return;
      }

      if (family === "profile") {
        const row = inboundProfile(record, payload);
        const existing = await db.profiles.get(row.record_id);
        if (!existing || existing.version <= row.version) await db.profiles.put(row);
      }
    },

    async reloadFromDb() {
      const [workspaceRows, eventRows, topicRows, commentRows, profileRows, cachedRows] = await Promise.all([
        db.workspace_profiles.toArray(),
        db.events.toArray(),
        db.topics.toArray(),
        db.comments.toArray(),
        db.profiles.toArray(),
        db.profile_cache.toArray().catch(() => [] as CachedProfile[]),
      ]);
      this.workspaceProfile = workspaceRows.sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))[0] || null;
      this.events = sortByUpdated(eventRows);
      this.topics = sortByUpdated(topicRows);
      this.comments = sortByUpdated(commentRows);
      this.profiles = sortByUpdated(profileRows);
      this.mergeCachedProfiles(cachedRows);
      await this.cacheProfiles(profileRows);
      this.hydrateFormsFromRecords();
    },

    seedFormsFromSession() {
      if (!this.session) return;
      const existing = this.profileByNpub(this.session.npub);
      this.profileForm.display_name = existing?.display_name || this.cachedProfileByNpub(this.session.npub)?.display_name || this.profileForm.display_name || "";
      this.profileForm.avatar_url = existing?.avatar_url || this.cachedProfileByNpub(this.session.npub)?.avatar_url || this.profileForm.avatar_url || "";
      this.profileForm.bio = existing?.bio || this.cachedProfileByNpub(this.session.npub)?.bio || this.profileForm.bio || "";
    },

    hydrateFormsFromRecords() {
      const workspace = this.workspaceProfile;
      this.workspaceForm.title = workspace?.title || env.workspaceName;
      this.workspaceForm.summary = workspace?.summary || "";
      this.workspaceForm.description = workspace?.description || "";
      this.workspaceForm.hero_image_url = workspace?.hero_image_url || "";
    },

	    go(path: string) {
	      window.history.pushState({}, "", path);
	      this.route = parseRoute(path);
	      this.accountMenuOpen = false;
	      this.topicActionMenuId = "";
	      this.closeAllModals();
	      this.clearNotice();
	      this.syncRouteContextFromLocation();
	    },

	    openModal(name: "submitTopic" | "workspace" | "event" | "topic" | "agentConnect") {
	      this.modals[name] = true;
	    },

	    closeModal(name: "submitTopic" | "workspace" | "event" | "topic" | "agentConnect") {
	      this.modals[name] = false;
	    },

	    closeAllModals() {
	      this.modals.submitTopic = false;
	      this.modals.workspace = false;
	      this.modals.event = false;
	      this.modals.topic = false;
	      this.modals.agentConnect = false;
	      this.topicActionMenuId = "";
	    },

	    setEventTab(tab: "about" | "topics") {
	      this.eventTab = tab;
	      if (tab === "about" && this.route.name === "event" && this.currentEvent) {
	        window.history.replaceState(window.history.state ?? {}, "", this.eventUrl(this.currentEvent));
	      }
	    },

	    topicAnchorId(topic: TopicRecord | null) {
	      return topic?.slug ? `topic-${topic.slug}` : "";
	    },

	    topicAnchorFromHash() {
	      const value = decodeURIComponent(String(window.location.hash || "").replace(/^#/, "").trim());
	      return value.startsWith("topic-") ? value : "";
	    },

	    eventUrlForTopicAnchor(topic: TopicRecord) {
	      const event = this.events.find((entry) => entry.record_id === topic.event_id);
	      const anchorId = this.topicAnchorId(topic);
	      if (!event || !anchorId) return "";
	      return `${this.eventUrl(event)}#${anchorId}`;
	    },

	    scrollToTopicAnchor(anchorId: string) {
	      if (!anchorId) return;
	      window.requestAnimationFrame(() => {
	        window.requestAnimationFrame(() => {
	          const target = document.getElementById(anchorId);
	          if (!target) return;
	          target.scrollIntoView({ block: "start", behavior: "auto" });
	        });
	      });
	    },

	    syncRouteContextFromLocation() {
	      if (this.route.name !== "event") {
	        this.eventTab = "about";
	        return;
	      }
	      const anchorId = this.topicAnchorFromHash();
	      if (!anchorId) {
	        this.eventTab = "about";
	        return;
	      }
	      this.eventTab = "topics";
	      this.scrollToTopicAnchor(anchorId);
	    },

	    toggleTopicActionMenu(recordId: string) {
	      this.topicActionMenuId = this.topicActionMenuId === recordId ? "" : recordId;
	    },

	    closeTopicActionMenu() {
	      this.topicActionMenuId = "";
	    },

    toggleAccountMenu() {
      this.accountMenuOpen = !this.accountMenuOpen;
    },

    closeAccountMenu() {
      this.accountMenuOpen = false;
    },

    currentPath() {
      return window.location.pathname;
    },

    get workspaceDisplayName() {
      return this.workspaceProfile?.title || env.workspaceName;
    },

    get workspaceTitle() {
      return this.workspaceProfile?.title || env.workspaceName;
    },

    get workspaceSummary() {
      return this.workspaceProfile?.summary || "A structured public roundtable for AI questions, provocations, and shared inquiry.";
    },

    get workspaceDescription() {
      return this.workspaceProfile?.description || "";
    },

    get workspaceDescriptionHtml() {
      return this.renderMarkdown(this.workspaceDescription || this.workspaceSummary);
    },

    get heroStyle() {
      const imageUrl = this.workspaceProfile?.hero_image_url || "/perth-ai-roundtable.png";
      return `background-image: url('${imageUrl}');`;
    },

    get allEventsSorted() {
      return [...this.events]
        .filter((event) => event.state !== "deleted")
        .sort((a, b) => {
          const aDate = a.starts_at || "";
          const bDate = b.starts_at || "";
          return aDate > bDate ? -1 : 1;
        });
    },

    get upcomingEvents() {
      const now = Date.now();
      return this.publicEvents
        .filter((event) => !event.starts_at || new Date(event.starts_at).getTime() >= now - 86_400_000)
        .sort((a, b) => {
          const aTime = a.starts_at ? new Date(a.starts_at).getTime() : Number.MAX_SAFE_INTEGER;
          const bTime = b.starts_at ? new Date(b.starts_at).getTime() : Number.MAX_SAFE_INTEGER;
          return aTime - bTime;
        });
    },

    get archivedPublicEvents() {
      const now = Date.now();
      return this.publicEvents
        .filter((event) => event.state === "archived" || (event.starts_at && new Date(event.starts_at).getTime() < now - 86_400_000))
        .sort((a, b) => {
          const aTime = a.starts_at ? new Date(a.starts_at).getTime() : 0;
          const bTime = b.starts_at ? new Date(b.starts_at).getTime() : 0;
          return bTime - aTime;
        });
    },

    get publicEvents() {
      return [...this.events]
        .filter((event) => event.state === "published" || event.state === "archived")
        .sort((a, b) => {
          const aTime = a.starts_at ? new Date(a.starts_at).getTime() : 0;
          const bTime = b.starts_at ? new Date(b.starts_at).getTime() : 0;
          return bTime - aTime;
        });
    },

    get nextPublishedEvent() {
      return this.upcomingEvents[0] || null;
    },

    get heroUpcomingEvents() {
      return this.upcomingEvents.slice(0, 3);
    },

    get currentEvent() {
      if (this.route.name !== "event" && this.route.name !== "topic") return null;
      const slug = this.route.eventSlug || "";
      return this.events.find((event) => event.slug === slug) || null;
    },

    get currentTopic() {
      if (this.route.name !== "topic") return null;
      const event = this.currentEvent;
      if (!event) return null;
      return this.topics.find((topic) => topic.event_id === event.record_id && topic.slug === this.route.topicSlug) || null;
    },

    get draftTopics() {
      return this.topics.filter((topic) => topic.state === "draft").sort((a, b) => a.sort_order - b.sort_order);
    },

    get sessionProfileName() {
      if (!this.session) return "";
      return this.profileByNpub(this.session.npub)?.display_name || this.cachedProfileByNpub(this.session.npub)?.display_name || this.shortNpub(this.session.npub);
    },

    get sessionMethodName() {
      return this.session ? methodLabel(this.session.method) : "";
    },

    get hasPublishedProfile() {
      if (!this.session) return false;
      return Boolean(this.profileByNpub(this.session.npub));
    },

    get profileEditorTitle() {
      return this.hasPublishedProfile ? "Your Profile" : "Create Your Profile";
    },

    get profileEditorCopy() {
      return this.hasPublishedProfile
        ? "Update your public profile for this workspace and the wider Nostr identity cache."
        : "Your browser key is ready. Add your public details, then publish your profile so other people can recognize you.";
    },

    get profileSaveLabel() {
      return this.hasPublishedProfile ? "Save Profile" : "Create Profile";
    },

    get avatarUrl() {
      if (!this.session) return "";
      return this.profileByNpub(this.session.npub)?.avatar_url || this.cachedProfileByNpub(this.session.npub)?.avatar_url || "";
    },

    get avatarFallback() {
      const label = this.sessionProfileName || this.workspaceDisplayName || "P";
      return String(label).trim().charAt(0).toUpperCase() || "P";
    },

    shortNpub(npub: string) {
      return npub ? `${npub.slice(0, 10)}…${npub.slice(-6)}` : "";
    },

    authorLabel(npub: string) {
      return this.profileByNpub(npub)?.display_name || this.cachedProfileByNpub(npub)?.display_name || this.shortNpub(npub);
    },

    authorAvatar(npub: string) {
      return this.profileByNpub(npub)?.avatar_url || this.cachedProfileByNpub(npub)?.avatar_url || "";
    },

    authorFallback(npub: string) {
      const label = this.authorLabel(npub) || "U";
      return String(label).trim().charAt(0).toUpperCase() || "U";
    },

    profileByNpub(npub: string) {
      return this.profiles.find((profile) => profile.author_npub === npub) || null;
    },

    cachedProfileByNpub(npub: string) {
      return this.profileCache[npub] || null;
    },

    loadProfileCacheFromStorage() {
      try {
        const raw = localStorage.getItem(PROFILE_CACHE_KEY);
        if (!raw) return;
        const parsed = JSON.parse(raw) as Record<string, CachedProfile>;
        if (!parsed || typeof parsed !== "object") return;
        this.profileCache = parsed;
      } catch {
        this.profileCache = {};
      }
    },

    async loadProfileCacheFromDb() {
      const rows = await db.profile_cache.toArray().catch(() => [] as CachedProfile[]);
      this.mergeCachedProfiles(rows);
    },

    mergeCachedProfiles(rows: CachedProfile[]) {
      if (!rows.length) return;
      const next = { ...this.profileCache };
      for (const row of rows) {
        const current = next[row.npub];
        if (!current || current.updated_at < row.updated_at) {
          next[row.npub] = row;
        }
      }
      this.profileCache = next;
      this.persistProfileCacheToStorage();
    },

    persistProfileCacheToStorage() {
      try {
        localStorage.setItem(PROFILE_CACHE_KEY, JSON.stringify(this.profileCache));
      } catch {
        // noop
      }
    },

    async cacheProfiles(rows: ProfileRecord[]) {
      if (!rows.length) return;
      const next = { ...this.profileCache };
      const cachedRows: CachedProfile[] = [];
      for (const row of rows) {
        const normalized: CachedProfile = {
          npub: row.author_npub,
          display_name: row.display_name || "",
          avatar_url: row.avatar_url || "",
          bio: row.bio || "",
          updated_at: row.updated_at,
        };
        const current = next[normalized.npub];
        if (!current || current.updated_at < normalized.updated_at) {
          next[normalized.npub] = normalized;
          cachedRows.push(normalized);
        }
      }
      this.profileCache = next;
      if (cachedRows.length) {
        await db.profile_cache.bulkPut(cachedRows);
      }
      this.persistProfileCacheToStorage();
    },

    shouldRefreshCachedProfile(npub: string) {
      const cached = this.cachedProfileByNpub(npub);
      if (!cached) return true;
      if (!cached.fetched_at) return true;
      const fetchedAt = new Date(cached.fetched_at).getTime();
      if (Number.isNaN(fetchedAt)) return true;
      return Date.now() - fetchedAt >= PROFILE_CACHE_TTL_MS;
    },

    profileNpubCandidates() {
      const values = new Set<string>();
      if (this.session?.npub) values.add(this.session.npub);
      for (const profile of this.profiles) values.add(profile.author_npub);
      for (const topic of this.topics) values.add(topic.author_npub);
      for (const comment of this.comments) values.add(comment.author_npub);
      for (const event of this.events) values.add(event.author_npub);
      return [...values].filter(Boolean);
    },

    async refreshNostrProfiles() {
      const targets = this.profileNpubCandidates().filter((npub) => this.shouldRefreshCachedProfile(npub));
      if (!targets.length) return;
      try {
        const profiles = await fetchNostrProfilesByNpub(targets);
        if (!profiles.length) return;
        this.mergeCachedProfiles(profiles);
        await db.profile_cache.bulkPut(profiles);
      } catch (error) {
        console.warn("Failed to refresh Nostr profiles", error);
      }
    },

    eventUrl(event: EventRecord) {
      return `/events/${event.slug}`;
    },

    eventImageUrl(event: EventRecord | null) {
      return event?.hero_image_url || this.workspaceProfile?.hero_image_url || "/perth-ai-roundtable.png";
    },

	    topicUrlForRecord(topic: TopicRecord) {
	      const event = this.events.find((entry) => entry.record_id === topic.event_id);
	      return event ? `/events/${event.slug}/topics/${topic.slug}` : "/";
	    },

	    openTopicFromCard(topic: TopicRecord) {
	      const returnUrl = this.eventUrlForTopicAnchor(topic);
	      if (returnUrl) {
	        window.history.replaceState(window.history.state ?? {}, "", returnUrl);
	      }
	      this.go(this.topicUrlForRecord(topic));
	    },

	    visibleTopicsForEvent(eventId: string) {
      return this.topics
        .filter((topic) => topic.event_id === eventId)
        .filter((topic) => this.isAdmin || topic.state === "published" || topic.state === "archived")
        .sort((a, b) => a.sort_order - b.sort_order || (a.updated_at > b.updated_at ? -1 : 1));
    },

    visibleCommentsForTopic(topicId: string) {
      return this.comments
        .filter((comment) => comment.topic_id === topicId)
        .filter((comment) => this.isAdmin || comment.state === "visible")
        .sort((a, b) => (a.updated_at > b.updated_at ? 1 : -1));
    },

    displayTopicState(topic: TopicRecord) {
      if (topic.state === "published") return "Published";
      if (topic.state === "draft") return this.isAdmin ? "Draft" : "Pending";
      return topic.state;
    },

    renderMarkdown(markdown: string) {
      return enhanceMarkdownMedia(marked.parse(markdown || "") as string);
    },

    excerpt(markdown: string) {
      return excerpt(markdown);
    },

    formatEventDateRange(event: EventRecord | null) {
      if (!event?.starts_at) return "Date TBC";
      const start = new Date(event.starts_at);
      const end = event.ends_at ? new Date(event.ends_at) : null;
      const startText = start.toLocaleString("en-AU", {
        month: "long",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
      if (!end) return startText;
      return `${startText} to ${end.toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" })}`;
    },

    formatTimestamp(value: string) {
      if (!value) return "";
      return new Date(value).toLocaleString("en-AU", {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
    },

    openTopicSubmission(eventId: string) {
      if (!this.session) {
        this.go("/login");
        return;
      }
      this.topicSubmissionForm.event_id = eventId;
      this.topicSubmissionForm.title = "";
      this.topicSubmissionForm.description_markdown = "";
      this.openModal("submitTopic");
    },

    openWorkspaceEditor() {
      this.openModal("workspace");
    },

    openCreateEventModal() {
      this.resetEventForm();
      this.openModal("event");
    },

    openCreateTopicModal() {
      this.resetTopicForm();
      this.openModal("topic");
    },

    async createLocalAccount() {
      this.saving = true;
      this.clearNotice();
      try {
        this.session = createLocalIdentity();
        saveSession(this.session);
        this.profileForm.display_name = "";
        this.profileForm.avatar_url = "";
        this.profileForm.bio = "";
        await this.refreshAll();
        this.notice = "Key created. Complete your profile to publish it.";
        this.go("/profile");
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error);
      } finally {
        this.saving = false;
      }
    },

    async loginWithExtension() {
      this.saving = true;
      this.clearNotice();
      try {
        this.session = await identityFromExtension();
        saveSession(this.session);
        await this.refreshAll();
        this.notice = "Logged in with browser extension.";
        this.go(this.isAdmin ? "/admin" : "/profile");
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error);
      } finally {
        this.saving = false;
      }
    },

    async loginWithNsec() {
      this.saving = true;
      this.clearNotice();
      try {
        this.session = identityFromNsec(this.loginForm.nsec);
        saveSession(this.session);
        this.loginForm.nsec = "";
        await this.refreshAll();
        this.notice = "Logged in.";
        this.go(this.isAdmin ? "/admin" : "/profile");
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error);
      } finally {
        this.saving = false;
      }
    },

    async loginWithBunker() {
      this.saving = true;
      this.clearNotice();
      try {
        this.session = await identityFromBunker(this.loginForm.bunkerUri);
        saveSession(this.session);
        this.loginForm.bunkerUri = "";
        await this.refreshAll();
        this.notice = "Logged in with bunker signer.";
        this.go(this.isAdmin ? "/admin" : "/profile");
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error);
      } finally {
        this.saving = false;
      }
    },

    logout() {
      clearSession();
      this.session = null;
      this.isAdmin = false;
      this.accountMenuOpen = false;
      this._groupSecrets = [PUBLIC_GROUP_SECRET];
      this.memberGroups = [];
      this.notice = "Logged out.";
      this.go("/");
    },

    currentAdminGroupSecret() {
      const adminGroup = this.memberGroups.find((group) => group.group_kind === "workspace_admin");
      if (!adminGroup) return null;
      return this._groupSecrets.find((group) => group.groupId === adminGroup.id) || null;
    },

    currentAdminGroupEntry() {
      return this.memberGroups.find((group) => group.group_kind === "workspace_admin") || null;
    },

    get adminMembers() {
      const group = this.currentAdminGroupEntry();
      if (!group) return [];
      return [...new Set((group.members || []).map((value) => String(value || "").trim()).filter(Boolean))].sort();
    },

    get agentInstructionText() {
      return buildAgentInstructionText(window.location.origin);
    },

	    get agentConnectPackageJson() {
	      return JSON.stringify(buildAgentConnectPackage(window.location.origin), null, 2);
	    },

	    get agentConnectModalTitle() {
	      return this.agentConnectView === "package" ? "Agent Connect Package" : "Agent Connect Instructions";
	    },

	    get agentConnectModalContent() {
	      return this.agentConnectView === "package" ? this.agentConnectPackageJson : this.agentInstructionText;
	    },

    buildWorkspaceSigner() {
      if (!env.workspaceOwnerNsec) throw new Error("Workspace owner key unavailable.");
      return identityFromNsec(env.workspaceOwnerNsec);
    },

    async saveWorkspaceProfile() {
      if (!this.isAdmin || !this.session) {
        this.error = "Admin login required.";
        return;
      }
      this.saving = true;
      try {
        const adminGroup = this.currentAdminGroupSecret();
        if (!adminGroup) throw new Error("Admin group key unavailable.");
        const existing = this.workspaceProfile;
        const signer = this.buildWorkspaceSigner();
        const record = buildRecordEnvelope("workspace_profile", {
          title: this.workspaceForm.title,
          summary: this.workspaceForm.summary,
          description: this.workspaceForm.description,
          hero_image_url: this.workspaceForm.hero_image_url,
          slug: env.workspaceSlug,
          state: "published",
          author_npub: this.session.npub,
        }, {
          recordId: existing?.record_id || workspaceProfileRecordId(),
          sender: signer,
          previousVersion: existing?.version || 0,
          writeGroupId: adminGroup.groupId,
          payloadGroups: [
            { groupId: env.publicGroupId, groupNpub: env.publicGroupNpub, groupSecret: PUBLIC_GROUP_SECRET.secret, epoch: 1, write: false },
            { groupId: adminGroup.groupId, groupNpub: adminGroup.groupNpub, groupSecret: adminGroup.secret, epoch: adminGroup.epoch, write: true },
          ],
        });
        await this.syncAsAdmin(record, adminGroup);
        await this.refreshAll();
        this.closeModal("workspace");
        this.notice = "Workspace profile saved.";
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error);
      } finally {
        this.saving = false;
      }
    },

	    async grantAdminAccess() {
      if (!this.isAdmin || !this.session) {
        this.error = "Admin login required.";
        return;
      }

      this.saving = true;
      this.clearNotice();
      try {
        const targetNpub = String(this.adminAccessForm.npub || "").trim();
        decodeNpub(targetNpub);

        const adminGroup = this.currentAdminGroupSecret();
        const adminGroupEntry = this.currentAdminGroupEntry();
        if (!adminGroup || !adminGroupEntry) throw new Error("Admin group key unavailable.");
        if (this.adminMembers.includes(targetNpub)) throw new Error("That npub already has admin access.");

        const wrapped_group_nsec = await personalEncryptForNpub(this.session, targetNpub, adminGroup.nsec);
        await addGroupMember(authFromIdentity(this.session), adminGroupEntry.id, {
          member_npub: targetNpub,
          wrapped_group_nsec,
          wrapped_by_npub: this.session.npub,
        });

        this.adminAccessForm.npub = "";
        await this.refreshMemberAccess();
        this.notice = "Admin access granted.";
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error);
      } finally {
        this.saving = false;
      }
	    },

	    openAgentConnectModal(view: "instructions" | "package") {
	      this.agentConnectView = view;
	      this.agentConnectCopied = false;
	      this.agentPackageCopied = false;
	      this.openModal("agentConnect");
	    },

    async copyAgentInstructions() {
      try {
        await navigator.clipboard.writeText(this.agentInstructionText);
        this.agentConnectCopied = true;
        window.setTimeout(() => {
          this.agentConnectCopied = false;
        }, 1800);
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error);
      }
    },

    async copyAgentPackage() {
      try {
        await navigator.clipboard.writeText(this.agentConnectPackageJson);
        this.agentPackageCopied = true;
        window.setTimeout(() => {
          this.agentPackageCopied = false;
        }, 1800);
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error);
      }
    },

    resetEventForm() {
      this.eventFeedback = "";
      this.eventFeedbackTone = "idle";
      this.eventForm = {
        record_id: "",
        title: "",
        slug: "",
        summary: "",
        description: "",
        starts_at: "",
        ends_at: "",
        timezone: "Australia/Perth",
        venue_name: "",
        venue_address: "",
        external_url: "",
        hero_image_url: "",
        state: "draft",
      };
    },

    async saveEvent() {
      if (!this.isAdmin || !this.session) {
        this.error = "Admin login required.";
        this.eventFeedback = "Admin login required.";
        this.eventFeedbackTone = "error";
        return;
      }
      this.saving = true;
      this.eventFeedback = "Saving event...";
      this.eventFeedbackTone = "progress";
      try {
        const adminGroup = this.currentAdminGroupSecret();
        if (!adminGroup) throw new Error("Admin group key unavailable.");
        const recordId = this.eventForm.record_id || makeRecordId("event");
        const existing = this.events.find((row) => row.record_id === recordId);
        const rowCount = this.events.length;
        const slug = this.eventForm.slug || slugify(this.eventForm.title);
        const record = buildRecordEnvelope("event", {
          slug,
          title: this.eventForm.title,
          summary: this.eventForm.summary,
          description: this.eventForm.description,
          starts_at: fromDateInput(this.eventForm.starts_at),
          ends_at: fromDateInput(this.eventForm.ends_at),
          timezone: this.eventForm.timezone || "Australia/Perth",
          venue_name: this.eventForm.venue_name,
          venue_address: this.eventForm.venue_address,
          external_url: this.eventForm.external_url,
          hero_image_url: this.eventForm.hero_image_url,
          state: this.eventForm.state,
          sort_order: existing?.sort_order ?? rowCount,
          author_npub: this.session.npub,
        }, {
          recordId,
          sender: this.buildWorkspaceSigner(),
          previousVersion: existing?.version || 0,
          writeGroupId: adminGroup.groupId,
          payloadGroups: [
            { groupId: env.publicGroupId, groupNpub: env.publicGroupNpub, groupSecret: PUBLIC_GROUP_SECRET.secret, epoch: 1, write: false },
            { groupId: adminGroup.groupId, groupNpub: adminGroup.groupNpub, groupSecret: adminGroup.secret, epoch: adminGroup.epoch, write: true },
          ],
        });
        await this.syncAsAdmin(record, adminGroup);
        await this.refreshAll();
        this.eventForm.record_id = recordId;
        this.eventForm.slug = slug;
        this.eventFeedback = `Event saved. ID: ${recordId}`;
        this.eventFeedbackTone = "success";
        this.closeModal("event");
        this.notice = `Event saved. ID: ${recordId}`;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.error = message;
        this.eventFeedback = message;
        this.eventFeedbackTone = "error";
      } finally {
        this.saving = false;
      }
    },

	    editEvent(recordId: string) {
	      const event = this.events.find((row) => row.record_id === recordId);
	      if (!event) return;
      this.eventFeedback = "";
      this.eventFeedbackTone = "idle";
      this.eventForm.record_id = event.record_id;
      this.eventForm.title = event.title;
      this.eventForm.slug = event.slug;
      this.eventForm.summary = event.summary;
      this.eventForm.description = event.description;
      this.eventForm.starts_at = formatDateInput(event.starts_at);
      this.eventForm.ends_at = formatDateInput(event.ends_at);
      this.eventForm.timezone = event.timezone;
      this.eventForm.venue_name = event.venue_name;
	      this.eventForm.venue_address = event.venue_address;
	      this.eventForm.external_url = event.external_url;
	      this.eventForm.hero_image_url = event.hero_image_url;
	      this.eventForm.state = event.state;
	      this.topicActionMenuId = "";
	      this.openModal("event");
	    },

	    editTopic(recordId: string) {
	      const topic = this.topics.find((row) => row.record_id === recordId);
	      if (!topic) return;
	      this.topicActionMenuId = "";
	      this.topicForm.record_id = topic.record_id;
      this.topicForm.event_id = topic.event_id;
      this.topicForm.slug = topic.slug;
      this.topicForm.title = topic.title;
      this.topicForm.description_markdown = topic.description_markdown;
      this.topicForm.state = topic.state;
	      this.openModal("topic");
	    },

    resetTopicForm() {
      this.topicForm = {
        record_id: "",
        event_id: this.events[0]?.record_id || "",
        slug: "",
        title: "",
        description_markdown: "",
        state: "draft",
      };
    },

    async saveTopic() {
      if (!this.isAdmin || !this.session) {
        this.error = "Admin login required.";
        return;
      }
      this.saving = true;
      try {
        const adminGroup = this.currentAdminGroupSecret();
        if (!adminGroup) throw new Error("Admin group key unavailable.");
        const recordId = this.topicForm.record_id || makeRecordId("topic");
        const existing = this.topics.find((row) => row.record_id === recordId);
        const siblingCount = this.topics.filter((row) => row.event_id === this.topicForm.event_id).length;
        const record = buildRecordEnvelope("topic", {
          event_id: this.topicForm.event_id,
          slug: this.topicForm.slug || slugify(this.topicForm.title),
          title: this.topicForm.title,
          description_markdown: this.topicForm.description_markdown,
          description_excerpt: excerpt(this.topicForm.description_markdown),
          state: this.topicForm.state,
          sort_order: existing?.sort_order ?? siblingCount,
          author_npub: this.session.npub,
        }, {
          recordId,
          sender: this.buildWorkspaceSigner(),
          previousVersion: existing?.version || 0,
          writeGroupId: adminGroup.groupId,
          payloadGroups: [
            { groupId: env.publicGroupId, groupNpub: env.publicGroupNpub, groupSecret: PUBLIC_GROUP_SECRET.secret, epoch: 1, write: false },
            { groupId: adminGroup.groupId, groupNpub: adminGroup.groupNpub, groupSecret: adminGroup.secret, epoch: adminGroup.epoch, write: true },
          ],
        });
        await this.syncAsAdmin(record, adminGroup);
        await this.refreshAll();
        this.resetTopicForm();
        this.closeModal("topic");
        this.notice = "Topic saved.";
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error);
      } finally {
        this.saving = false;
      }
    },

	    async setTopicState(recordId: string, state: TopicRecord["state"]) {
	      const topic = this.topics.find((row) => row.record_id === recordId);
	      if (!topic) return;
	      this.topicActionMenuId = "";
	      this.topicForm.record_id = topic.record_id;
      this.topicForm.event_id = topic.event_id;
      this.topicForm.slug = topic.slug;
      this.topicForm.title = topic.title;
      this.topicForm.description_markdown = topic.description_markdown;
      this.topicForm.state = state;
	      await this.saveTopic();
	    },

	    async setEventState(recordId: string, state: EventRecord["state"]) {
	      const event = this.events.find((row) => row.record_id === recordId);
	      if (!event) return;
	      this.eventFeedback = "";
	      this.eventFeedbackTone = "idle";
	      this.eventForm.record_id = event.record_id;
	      this.eventForm.title = event.title;
	      this.eventForm.slug = event.slug;
	      this.eventForm.summary = event.summary;
	      this.eventForm.description = event.description;
	      this.eventForm.starts_at = formatDateInput(event.starts_at);
	      this.eventForm.ends_at = formatDateInput(event.ends_at);
	      this.eventForm.timezone = event.timezone;
	      this.eventForm.venue_name = event.venue_name;
	      this.eventForm.venue_address = event.venue_address;
	      this.eventForm.external_url = event.external_url;
	      this.eventForm.hero_image_url = event.hero_image_url;
	      this.eventForm.state = state;
	      await this.saveEvent();
	    },

	    async deleteEvent(recordId: string) {
	      const event = this.events.find((row) => row.record_id === recordId);
	      if (!event) return;
	      if (!window.confirm(`Delete event \"${event.title}\"?`)) return;
	      await this.setEventState(recordId, "deleted");
	    },

	    async moveTopic(recordId: string, direction: number) {
	      if (!this.isAdmin || !this.session) return;
	      const topic = this.topics.find((row) => row.record_id === recordId);
	      if (!topic) return;
	      this.topicActionMenuId = "";
	      const siblings = this.visibleTopicsForEvent(topic.event_id);
      const index = siblings.findIndex((row) => row.record_id === recordId);
      const swap = siblings[index + direction];
      if (!swap) return;
      await this.swapTopicOrder(topic, swap);
    },

    async swapTopicOrder(first: TopicRecord, second: TopicRecord) {
      if (!this.isAdmin || !this.session) return;
      const adminGroup = this.currentAdminGroupSecret();
      if (!adminGroup) return;
      const signer = this.buildWorkspaceSigner();
      const nextFirst = buildRecordEnvelope("topic", {
        ...first,
        sort_order: second.sort_order,
      }, {
        recordId: first.record_id,
        sender: signer,
        previousVersion: first.version,
        writeGroupId: adminGroup.groupId,
        payloadGroups: [
          { groupId: env.publicGroupId, groupNpub: env.publicGroupNpub, groupSecret: PUBLIC_GROUP_SECRET.secret, epoch: 1, write: false },
          { groupId: adminGroup.groupId, groupNpub: adminGroup.groupNpub, groupSecret: adminGroup.secret, epoch: adminGroup.epoch, write: true },
        ],
      });
      const nextSecond = buildRecordEnvelope("topic", {
        ...second,
        sort_order: first.sort_order,
      }, {
        recordId: second.record_id,
        sender: signer,
        previousVersion: second.version,
        writeGroupId: adminGroup.groupId,
        payloadGroups: [
          { groupId: env.publicGroupId, groupNpub: env.publicGroupNpub, groupSecret: PUBLIC_GROUP_SECRET.secret, epoch: 1, write: false },
          { groupId: adminGroup.groupId, groupNpub: adminGroup.groupNpub, groupSecret: adminGroup.secret, epoch: adminGroup.epoch, write: true },
        ],
      });
      await this.syncAsAdmin(nextFirst, adminGroup);
      await this.syncAsAdmin(nextSecond, adminGroup);
      await this.refreshAll();
      this.notice = "Topic order updated.";
    },

    async submitTopic() {
      if (!this.session) {
        this.go("/login");
        return;
      }
      if (!this.currentEvent) return;
      this.saving = true;
      try {
        const publicSigner = publicSignerIdentity();
        const record = buildRecordEnvelope("topic", {
          event_id: this.currentEvent.record_id,
          slug: slugify(this.topicSubmissionForm.title),
          title: this.topicSubmissionForm.title,
          description_markdown: this.topicSubmissionForm.description_markdown,
          description_excerpt: excerpt(this.topicSubmissionForm.description_markdown),
          state: "draft",
          sort_order: this.topics.filter((row) => row.event_id === this.currentEvent?.record_id).length,
          author_npub: this.session.npub,
        }, {
          recordId: makeRecordId("topic"),
          sender: publicSigner,
          previousVersion: 0,
          writeGroupId: env.publicGroupId,
          payloadGroups: [
            { groupId: env.publicGroupId, groupNpub: env.publicGroupNpub, groupSecret: PUBLIC_GROUP_SECRET.secret, epoch: 1, write: true },
          ],
        });
        await this.syncAsPublic(record);
        this.topicSubmissionForm.title = "";
        this.topicSubmissionForm.description_markdown = "";
        await this.refreshAll();
        this.closeModal("submitTopic");
        this.notice = "Topic submitted for review.";
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error);
      } finally {
        this.saving = false;
      }
    },

    async submitComment() {
      if (!this.session || !this.currentTopic) {
        this.go("/login");
        return;
      }
      this.saving = true;
      try {
        const publicSigner = publicSignerIdentity();
        const record = buildRecordEnvelope("comment", {
          topic_id: this.currentTopic.record_id,
          body_markdown: this.commentDraft.body,
          state: "visible",
          author_npub: this.session.npub,
        }, {
          recordId: makeRecordId("comment"),
          sender: publicSigner,
          previousVersion: 0,
          writeGroupId: env.publicGroupId,
          payloadGroups: [
            { groupId: env.publicGroupId, groupNpub: env.publicGroupNpub, groupSecret: PUBLIC_GROUP_SECRET.secret, epoch: 1, write: true },
          ],
        });
        await this.syncAsPublic(record);
        this.commentDraft.body = "";
        await this.refreshAll();
        this.notice = "Comment posted.";
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error);
      } finally {
        this.saving = false;
      }
    },

    async saveProfile() {
      if (!this.session) {
        this.go("/login");
        return;
      }
      this.saving = true;
      try {
        const existing = this.profileByNpub(this.session.npub);
        const publicSigner = publicSignerIdentity();
        const record = buildRecordEnvelope("profile", {
          author_npub: this.session.npub,
          display_name: this.profileForm.display_name,
          avatar_url: this.profileForm.avatar_url,
          bio: this.profileForm.bio,
        }, {
          recordId: existing?.record_id || profileRecordId(this.session.npub),
          sender: publicSigner,
          previousVersion: existing?.version || 0,
          writeGroupId: env.publicGroupId,
          payloadGroups: [
            { groupId: env.publicGroupId, groupNpub: env.publicGroupNpub, groupSecret: PUBLIC_GROUP_SECRET.secret, epoch: 1, write: true },
          ],
        });
        await this.syncAsPublic(record);
        await this.refreshAll();
        this.notice = "Profile saved.";
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error);
      } finally {
        this.saving = false;
      }
    },

    async setCommentState(recordId: string, state: CommentRecord["state"]) {
      if (!this.isAdmin || !this.session) return;
      const comment = this.comments.find((row) => row.record_id === recordId);
      if (!comment) return;
      const publicSigner = publicSignerIdentity();
      const record = buildRecordEnvelope("comment", {
        topic_id: comment.topic_id,
        body_markdown: comment.body_markdown,
        state,
        author_npub: comment.author_npub,
      }, {
        recordId: comment.record_id,
        sender: publicSigner,
        previousVersion: comment.version,
        writeGroupId: env.publicGroupId,
        payloadGroups: [
          { groupId: env.publicGroupId, groupNpub: env.publicGroupNpub, groupSecret: PUBLIC_GROUP_SECRET.secret, epoch: 1, write: true },
        ],
      });
      await this.syncAsPublic(record);
      await this.refreshAll();
      this.notice = "Comment updated.";
    },

    async syncAsPublic(record: any) {
      const signer = publicSignerIdentity();
      const token = await createNip98AuthHeaderForSecret(
        `${env.towerUrl}/api/v4/records/sync`,
        "POST",
        { owner_npub: env.workspaceOwnerNpub, records: [record] },
        decodeNsec(signer.nsec),
      );
      await syncSingleRecord(authFromIdentity(signer), record, {
        [env.publicGroupId]: token,
      });
    },

    async syncAsAdmin(record: any, adminGroup: GroupSecret) {
      if (!this.session) throw new Error("Admin login required.");
      const signer = this.buildWorkspaceSigner();
      const token = await createNip98AuthHeaderForSecret(
        `${env.towerUrl}/api/v4/records/sync`,
        "POST",
        { owner_npub: env.workspaceOwnerNpub, records: [record] },
        adminGroup.secret,
      );
      await syncSingleRecord(authFromIdentity(signer), record, {
        [adminGroup.groupId]: token,
      });
    },

    async uploadTopicImage(event: Event) {
      if (!this.isAdmin || !this.session) {
        this.error = "Admin upload required.";
        return;
      }
      const input = event.target as HTMLInputElement;
      const file = input.files?.[0];
      if (!file) return;
      try {
        const prepared = await prepareStorageObject(authFromIdentity(this.session), {
          owner_npub: env.workspaceOwnerNpub,
          owner_group_id: null,
          access_group_ids: [env.publicGroupId],
          is_public: true,
          content_type: file.type || "image/png",
          file_name: file.name,
          size_bytes: file.size,
        });
        const base64Data = await fileToBase64(file);
        await uploadStorageObject(authFromIdentity(this.session), prepared.object_id, base64Data);
        const completed = await completeStorageObject(authFromIdentity(this.session), prepared.object_id, {});
        const markdown = `\n\n![${file.name}](${completed.content_url})\n\n`;
        this.topicForm.description_markdown += markdown;
        this.notice = "Image uploaded and inserted into markdown.";
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error);
      } finally {
        input.value = "";
      }
    },

    async handleTopicPaste(event: ClipboardEvent) {
      if (!this.isAdmin || !this.session) return;
      const files = [...(event.clipboardData?.files || [])];
      const image = files.find((file) => file.type.startsWith("image/"));
      if (!image) return;
      event.preventDefault();
      const syntheticTarget = document.createElement("input");
      Object.defineProperty(syntheticTarget, "files", { value: [image] });
      await this.uploadTopicImage({ target: syntheticTarget } as unknown as Event);
    },
  };
}

function dedupeGroups(groups: GroupSecret[]) {
  const byId = new Map<string, GroupSecret>();
  const byNpub = new Map<string, GroupSecret>();
  for (const group of groups) {
    if (group.groupId) byId.set(group.groupId, group);
    byNpub.set(group.groupNpub, group);
  }
  return [...new Map([...byId.entries(), ...byNpub.entries()].map(([, value]) => [value.groupNpub, value])).values()];
}

(window as any).perthAiApp = perthAiApp;
window.Alpine = Alpine;
Alpine.start();
