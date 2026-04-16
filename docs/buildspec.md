# Build Spec: Perf AI

**Status:** Draft for implementation
**Date:** 2026-04-14
**Repo:** `/Users/mini/code/socratic21`

## 1. Overview

This document defines the v1 build specification for a new web app called **Perf AI**.

Perf AI is a public-facing Socratic seminar app inspired heavily by Flight Deck. It reuses the same core operational model:

- Bun + TypeScript
- Vite frontend
- Alpine.js UI state
- Dexie local persistence
- local-first writes
- SuperBased / Tower as the durable backend
- Nostr identities for users
- browser-side hydration from synced records

The app differs from Flight Deck in product shape and trust model:

- it is public-by-default for reading
- it has one workspace per deployment
- it focuses on seminar events, topics, and comments
- published content is intended to be publicly visible
- it ships a shared public group key in the frontend in obfuscated form
- it uses a one-time bootstrap CLI to provision Tower workspace state

The first deployment is for the workspace:

- **Name:** `Perf AI`
- **Slug:** `perf-ai`

This app is intended to be hosted as a static or mostly-static frontend on CapRover. Runtime app state must not depend on a custom app server database. All durable state belongs in SuperBased records and storage.

## 2. Product Goal

Perf AI manages a public Socratic seminar workspace.

Users should be able to:

- visit the website and browse public content without logging in
- view the workspace home page
- view upcoming and past events
- drill into an event page
- view topics attached to that event
- view comments on published topics

Logged-in users should be able to:

- create a Nostr identity in-browser if they do not already have one
- maintain a basic public profile
- submit topics for an event
- comment on published topics

Admins should be able to:

- bootstrap the workspace
- create and edit events
- review draft topics
- publish, hide, archive, or delete topics
- order topics within an event
- moderate comments
- upload images into topic descriptions

## 3. Scope

### 3.1 In Scope For V1

- single deployed workspace
- public browsing
- login-required posting
- profile creation and editing
- event CRUD for admin
- topic submission and moderation
- comment creation and moderation
- markdown descriptions for topics
- admin-only image uploads in markdown
- SuperBased sync
- Dexie hydration
- deep-linkable public routes
- bootstrap CLI for workspace and key generation

### 3.2 Explicitly Out Of Scope For V1

- multi-workspace frontend chooser
- voting and ranking
- topic reuse across events
- direct comments on events
- webhooks
- custom relay multiplexing
- server-owned durable database
- link preview cards
- full-text search
- notification system
- collaborative rich text editing

## 4. High-Level Product Model

Perf AI is a single-workspace app.

Hierarchy:

- workspace
- events
- topics
- comments

Relationships:

- one workspace has many events
- one event has many topics
- one topic has many comments
- comments attach only to topics in v1
- a topic belongs to exactly one event in v1

Public behavior:

- all published events are public
- all published topics are public
- all visible comments are public
- commenter identity is public

Private behavior:

- topic drafts submitted by non-admins are visible to admins only until published
- admin/private operational records may exist but are not part of the public web surface

## 5. Architectural Direction

Perf AI should copy the proven structural patterns from Flight Deck where appropriate, but not its product surface.

### 5.1 Frontend Stack

- Bun
- TypeScript
- Vite
- Alpine.js
- Dexie
- `nostr-tools`
- markdown renderer reused or adapted from Flight Deck

### 5.2 Runtime Model

The app should remain local-first:

1. UI writes to Dexie immediately.
2. Dexie stores local domain rows and pending writes.
3. Sync worker flushes encrypted records to SuperBased / Tower.
4. Synced records re-materialize into Dexie.
5. UI renders from Dexie-backed state.

The app should avoid any design where the UI depends on a custom server for canonical state.

### 5.3 Deployment Model

- CapRover-hosted frontend
- optional thin stateless helper layer later if strictly needed
- no custom app database
- no webhook dependency
- no callback dependency

## 6. Relationship To Flight Deck And Tower

Perf AI should take heavy implementation inspiration from Flight Deck for:

- auth flow
- local identity generation
- workspace bootstrap pattern
- group key handling
- SuperBased sync transport
- pending write model
- Dexie storage strategy
- markdown image storage flow
- profile handling patterns

Tower remains the backend authority for:

- workspace creation
- workspace group creation
- group membership and wrapped group keys
- storage upload/download authorization
- record sync transport and policy enforcement

Important Tower model reminder:

- `workspace_owner_npub` is a generated workspace identity
- `creator_npub` is the human admin operator

This means the workspace is not created directly under the admin's npub as the transport identity. Instead, a workspace identity is generated, and the admin is recorded as creator/operator.

## 7. Workspace And Group Model

### 7.1 Generated Identities

Bootstrap generates:

- app identity keypair
- workspace identity keypair
- Tower system group identities
- app-specific public group identity

### 7.2 Groups

Tower system groups:

- `default_group`
- `admin_group`
- `private_group`

App-specific extra group:

- `public_group`

### 7.3 Intended Use Of Each Group

`default_group`

- created because Tower workspace bootstrap expects a default shared group
- available for ordinary shared workspace surfaces if needed internally
- not shipped publicly in the frontend

`admin_group`

- used for admin authority and admin-only management surfaces
- used for admin-only records if needed

`private_group`

- used for private/admin-only operational records
- may hold private draft or internal content later if required

`public_group`

- created after workspace bootstrap
- owned by the workspace
- used for all public web content delivery
- obfuscated `nsec` shipped to the frontend
- used for published events, published topics, public comments, and public profile visibility where applicable

### 7.4 Why `public_group` Exists Separately

The app must not ship Tower's `default_group` secret in the frontend. Instead, it creates a dedicated `Public` group whose key is intended to be exposed in obfuscated form for public delivery. This keeps the public-read/write surface conceptually separate from Tower bootstrap defaults.

## 8. Identity And Auth Model

### 8.1 Anonymous Readers

Anonymous users can:

- browse the website
- view workspace profile
- view events
- view published topics
- view visible comments

Anonymous users cannot:

- post topics
- post comments
- edit profiles
- upload images
- access admin surfaces

### 8.2 Logged-In Users

Posting requires login.

Supported v1 identity paths:

- generated local Nostr identity in-browser
- existing Nostr login path if reused from Flight Deck later

At minimum, the app must support local browser-generated Nostr accounts.

### 8.3 User Profile Model

Each posting user has a public profile with:

- `display_name`
- `avatar_url`
- `bio`
- timestamps

Profiles are public records in this workspace context.

### 8.4 Public Identity Rules

If a user posts:

- their identity is public
- their profile is public
- comments are publicly attributable

This is a public forum model, not a private collaboration model.

## 9. Record Authorship And Signing Model

Perf AI should follow the same broad transport pattern as Flight Deck.

That means:

- app/workspace transport and SuperBased auth follow the established Flight Deck model
- records store explicit authorship fields
- UI displays authorship from record payloads
- transport identity and displayed author are not required to be the same field

For v1, each content record should store enough metadata to answer:

- who owns the record namespace
- who authored the content
- what group(s) can decrypt it
- which group reference authorizes non-owner writes

### 9.1 Record Delivery Pattern

Published public content should be delivered to:

- `public_group`
- owner/admin path

This keeps public visibility while retaining an owner/admin recovery and moderation path.

### 9.2 Topic Draft Pattern

For non-admin topic drafts:

- do not deliver them to `public_group`
- deliver them to admin/owner paths only
- make them visible to admins only until publication

### 9.3 Comment Pattern

For public comments on published topics:

- deliver to `public_group`
- deliver to owner/admin path

### 9.4 Explicit Author Fields

Every topic and comment record should include explicit author metadata such as:

- `author_npub`
- `author_method` if needed
- optional cached author display fields for convenience

The UI should treat these as the canonical displayed author fields, not infer authorship from transport-layer signer details alone.

## 10. Public Group Key Exposure Model

The app must not ship the `default_group` secret.

Instead:

- bootstrap creates a dedicated `Public` group
- the app embeds the `public_group` `nsec` in obfuscated form in frontend config
- the browser decodes it at runtime
- that key is used to decrypt public records delivered to `public_group`

### 10.1 Security Position

This key is not a true secret in the traditional sense once it is embedded in the public website.

That is acceptable because:

- the content is intentionally public
- the group exists to support public delivery and app-level convenience
- the owner/admin path still exists for canonical moderation and recovery

The obfuscation is not a security boundary. It is simply to avoid making the secret obvious at first glance in page source or config.

### 10.2 Obfuscation Requirement

The app should encode the shipped `public_group` `nsec` in a non-obvious reversible form.

A simple reversible encoding is sufficient, for example:

- base58
- base64 JSON envelope
- another deterministic reversible encoding

The chosen approach should be simple, documented, and easy to rotate.

## 11. Data Model

### 11.1 Workspace

There is one workspace per deployment.

Workspace fields:

- `name`
- `slug`
- `description`
- `hero_image_url` or equivalent
- optional branding fields
- `workspace_owner_npub`
- `creator_npub`
- timestamps

Workspace metadata should be split carefully between:

- Tower canonical workspace data
- app-level workspace profile/settings records

The public page may render app-level profile data layered on top of Tower bootstrap metadata.

### 11.2 Event

Event fields:

- `record_id`
- `workspace_owner_npub`
- `slug`
- `title`
- `summary`
- `description`
- `starts_at`
- `ends_at`
- `timezone`
- `venue_name`
- `venue_address`
- `external_url` such as Meetup
- `hero_image_url`
- `state`
- `sort_order` if needed
- `author_npub`
- timestamps

Event states:

- `draft`
- `published`
- `hidden`
- `archived`
- `deleted`

Behavior:

- published events show publicly
- hidden and draft do not
- archived events remain viewable if desired in archive listings

### 11.3 Topic

Topic fields:

- `record_id`
- `workspace_owner_npub`
- `event_id`
- `slug`
- `title`
- `description_markdown`
- `description_html` if cached locally
- `state`
- `sort_order`
- `author_npub`
- timestamps

Topic states:

- `draft`
- `published`
- `hidden`
- `archived`
- `deleted`

Rules:

- user-submitted topics begin as `draft`
- non-admin drafts are admin-visible only
- admin can publish and order them
- one topic belongs to one event in v1

### 11.4 Comment

Comment fields:

- `record_id`
- `workspace_owner_npub`
- `topic_id`
- `parent_comment_id` nullable if threading is later desired
- `body_markdown`
- `state`
- `author_npub`
- timestamps

Comment states:

- `visible`
- `hidden`
- `deleted`

V1 behavior:

- comments are flat unless threading falls out cheaply from the reused comment structure
- admins can hide or delete comments

### 11.5 Profile

Profile fields:

- `record_id`
- `workspace_owner_npub`
- `author_npub`
- `display_name`
- `avatar_url`
- `bio`
- timestamps

Profiles should be public and queryable for rendering authorship.

## 12. Record Families

Default v1 record families:

- `workspace_profile`
- `event`
- `topic`
- `comment`
- `profile`

These names should be used consistently across:

- translators
- Dexie tables
- sync logic
- record family hash construction

If Flight Deck naming patterns require a namespace prefix, keep the same pattern and swap in this app's `APP_NPUB`.

## 13. Routing And URLs

The app must support real public deep links.

V1 routes:

- `/`
- `/events/:eventSlug`
- `/events/:eventSlug/topics/:topicSlug`
- `/login`
- `/profile`
- `/admin`
- `/admin/events/:eventSlug`
- `/admin/topics`

### 13.1 Public Route Behavior

`/`

- public workspace home
- hero area
- upcoming event summary
- event list or archive

`/events/:eventSlug`

- event details
- published topics list in admin-defined order

`/events/:eventSlug/topics/:topicSlug`

- topic detail page
- rendered markdown
- public comments
- comment form only if logged in

### 13.2 Slugs

Initial workspace slug:

- `perf-ai`

Event and topic records must each have stable slugs.

Slug rules:

- lowercase
- hyphenated
- unique within the appropriate parent scope

In v1:

- event slug unique per workspace
- topic slug unique per event

## 14. UI Direction

The app should not look like Flight Deck even if it reuses backend and state-management ideas.

It should feel like a public event and discussion site rather than an operator dashboard.

### 14.1 Public Surface

The home page should show:

- brand/hero area
- workspace name and summary
- upcoming event emphasis
- event archive access
- clear call-to-action for joining or logging in to contribute

The supplied imagery should be used as the seed visual direction for the first implementation.

### 14.2 Admin Surface

Admin views can be simpler and more utilitarian.

Need screens for:

- workspace bootstrap state
- event create/edit
- topic moderation queue
- topic ordering
- comment moderation
- profile review if needed later

### 14.3 Topic Editing

Topic descriptions use markdown.

Requirements:

- markdown preview
- admin-only image paste/upload
- image insertion by paste into description editor
- non-admin attempts to upload images should be blocked clearly

### 14.4 Link Previews

Not required for v1.

The markdown rendering pipeline should be written so link previews can be layered in later without breaking stored content.

## 15. Bootstrap CLI

The repository must include a CLI bootstrap flow.

This is a core v1 requirement, not an optional dev helper.

### 15.1 Bootstrap Responsibilities

The CLI should:

- generate app identity
- generate workspace identity
- generate Tower bootstrap group identities
- generate extra `Public` group identity
- write local app config into `.env`
- create the Tower workspace under the supplied admin authority
- create the extra `Public` group after workspace bootstrap
- optionally print a concise summary of generated IDs

### 15.2 Admin Auth Input Modes

The CLI must support all of:

- `--admin-nsec`
- `ADMIN_NSEC` environment variable
- secure interactive prompt

Precedence:

1. `--admin-nsec`
2. `ADMIN_NSEC`
3. prompt

### 15.3 Secret Handling Rules

The bootstrap CLI must:

- never write the admin `nsec` into the app `.env`
- never echo the admin `nsec` in normal logs
- avoid persisting it anywhere except process memory
- treat it as bootstrap-only authority

### 15.4 `.env` Output

The app `.env` should contain generated app/workspace/public-group configuration, but not the admin `nsec`.

Expected values include fields like:

- `VITE_DEFAULT_SUPERBASED_URL`
- app `nsec` / `npub` as needed
- workspace owner `npub`
- workspace slug
- obfuscated public group secret
- public group `npub`
- default/admin/private/public group ids or npubs as needed

Exact names can be finalized during implementation, but the split must remain:

- public runtime config safe for frontend use
- build-time or bootstrap-only values kept local

### 15.5 Bootstrap Steps

Recommended sequence:

1. collect admin auth
2. generate identities
3. call Tower `createWorkspace`
4. create extra `Public` group owned by the workspace
5. write `.env`
6. print summary

### 15.6 Idempotency

The CLI should be intentionally conservative.

It should not accidentally create many workspaces.

Preferred behavior:

- fail loudly if `.env` already exists with workspace bootstrap values unless `--force` is used
- optionally support a dry-run mode later
- avoid reusing remote identities unless explicitly requested

## 16. Sync And Dexie Model

### 16.1 Core Principle

All state should live in SuperBased records and then be hydrated into Dexie.

The app should not keep canonical runtime state anywhere else.

### 16.2 Dexie Tables

Initial Dexie tables should minimally include:

- `workspace_profile`
- `events`
- `topics`
- `comments`
- `profiles`
- `pending_writes`
- `sync_state`
- `storage_image_cache`

Optional additional tables if useful:

- `route_cache`
- `view_projections`
- `read_cursors`

### 16.3 Pending Writes

UI actions should:

1. write local rows
2. enqueue pending write envelopes
3. let sync flush remotely

This should mirror Flight Deck's local-first model.

### 16.4 Worker

If practical, sync orchestration should live in a real worker boundary or a clearly isolated sync manager copied from Flight Deck's current direction.

V1 does not require a perfect worker refactor before shipping, but the implementation should avoid turning the app into one giant Alpine store.

## 17. Storage And Images

### 17.1 Upload Policy

Topic description image uploads are:

- admin-only in v1

Non-admin behavior:

- image paste/upload should be blocked
- UI should show a clear message explaining that images are admin-only for now

### 17.2 Storage Ownership

Uploads should use the Tower/SuperBased storage flow already established by Flight Deck patterns.

The uploaded object should remain accessible according to the same group/owner rules as the content it belongs to.

### 17.3 Markdown Rendering

Topic descriptions should support:

- markdown text
- links
- embedded uploaded images

Rendering can reuse or adapt Flight Deck markdown helpers.

## 18. Admin Capabilities

Admin needs:

- create event
- edit event
- hide/archive/delete event
- create topic directly
- review submitted draft topics
- publish/hide/archive/delete topics
- reorder topics within an event
- hide/delete comments
- edit workspace public profile

Admin authority should derive from:

- creator identity
- Tower admin group membership

Do not rely on client-only gating.

## 19. Moderation And Visibility Rules

### 19.1 Events

- only published events are public
- drafts/hidden events are admin-only

### 19.2 Topics

- non-admin submitted topics begin as draft
- drafts are admin-visible only
- published topics become public
- hidden topics disappear from public views
- archived topics remain available in archive contexts if desired

### 19.3 Comments

- comments on published topics are public by default
- hidden comments remain in owner/admin path but are not publicly rendered
- deleted comments may remain as tombstones or disappear completely from UI depending on implementation simplicity

## 20. Public Workspace Content

The workspace home page should be driven by records, not by hardcoded page copy after bootstrap.

Initial workspace public content should support:

- workspace title
- short description
- hero image
- optional external links

The Meetup event details and supplied poster image can inform the initial visual/content direction, but the first event itself will be created manually by the admin as a test rather than auto-seeded.

## 21. Config And Environment

The app should expect:

- `.env` for local generated values
- `.env` gitignored
- build-friendly `VITE_*` variables for frontend runtime config

Categories of config:

- frontend-safe values
- bootstrap-only secrets
- admin-only bootstrap input

The build must document which values are safe to expose and which are not.

## 22. Implementation Plan

Recommended implementation phases:

### Phase 1: Scaffolding

- initialize Bun + Vite + TypeScript app
- add Alpine, Dexie, nostr-tools
- establish directory structure
- add env handling
- add docs and README scaffolding

### Phase 2: Bootstrap CLI

- implement admin auth input modes
- generate identities
- write `.env`
- create Tower workspace
- create `Public` group
- verify remote bootstrap result

### Phase 3: Core Sync Foundation

- port/adapt auth helpers
- port/adapt group key handling
- port/adapt workspace/app identity helpers
- establish Dexie schema
- establish pending writes and sync base

### Phase 4: Domain Model

- add workspace profile record family
- add event translator/model
- add topic translator/model
- add comment translator/model
- add profile translator/model

### Phase 5: Public Pages

- home route
- event route
- topic route
- public rendering and loading states

### Phase 6: Login And Profiles

- local account generation
- session handling
- profile editor

### Phase 7: Admin Tools

- event editor
- topic moderation queue
- topic ordering
- comment moderation
- admin-only image uploads

### Phase 8: Testing And Hardening

- unit tests
- route tests
- sync tests
- bootstrap CLI tests where practical
- manual bootstrap verification

## 23. Acceptance Criteria

The implementation is acceptable for v1 when all of the following are true:

### Bootstrap

- a CLI can create the workspace using an admin `nsec`
- the CLI supports flag, env var, and interactive prompt input modes
- the CLI creates Tower workspace state plus the extra `Public` group
- the CLI writes generated app config into `.env`
- the admin `nsec` is never written into app config

### Public Site

- anonymous users can browse the workspace home
- anonymous users can open event pages
- anonymous users can open published topic pages
- anonymous users can read visible comments

### Authenticated User Flow

- a new user can create a local Nostr identity in-browser
- the user can create or edit their profile
- the user can submit a topic draft
- the user can comment on a published topic

### Admin Flow

- admin can create and edit events
- admin can publish submitted topics
- admin can reorder topics
- admin can hide/delete comments
- admin can upload images into topic markdown

### Data And Sync

- all canonical data is stored in SuperBased/Tower-backed records
- the browser hydrates state into Dexie
- refreshing the page restores state from sync
- published records are readable publicly via the app's public-group model

## 24. Testing Strategy

### 24.1 Unit Tests

Need tests for:

- slug generation
- record translator correctness
- state transitions
- public-group obfuscation encode/decode
- profile validation

### 24.2 Integration Tests

Need tests for:

- bootstrap payload generation
- pending write to outbound record translation
- topic moderation transitions
- comment visibility rules

### 24.3 Manual Verification

Need a manual checklist for:

- first bootstrap
- first admin login
- first public event creation
- first user signup
- first topic submission
- first topic publication
- first public comment
- admin image upload into topic markdown

## 25. Risks And Notes

### 25.1 Public Group Secret Exposure

This is intentional, but it must be documented clearly.

The public group secret is an application convenience for public content, not a hard security boundary.

### 25.2 Transport/Auth Complexity

Flight Deck's signing and workspace key model is subtle. Reuse should be careful and deliberate rather than partial copy-paste.

### 25.3 Separation Of Public And Admin Surfaces

The product will stay manageable only if public content flows and admin moderation flows are kept distinct in both UI and data visibility.

### 25.4 Future Multi-Workspace Direction

Even though v1 is single-workspace per deployment, this app should not paint itself into a corner.

Keep naming and route conventions compatible with a future where:

- multiple workspaces may exist
- workspace slugs become part of public route structure

That future is not required in v1, but obvious extensibility should be preserved.

## 26. Final Summary

Perf AI is a public seminar workspace app built on the same local-first + SuperBased/Tower backbone as Flight Deck, but with a different product shape.

The key design choices are:

- one workspace per deployment
- public reading without login
- posting only when logged in
- generated Nostr identities for users
- public records delivered via a dedicated shipped `Public` group
- owner/admin path retained for canonical moderation and recovery
- Tower workspace bootstrap performed by a CLI using the admin `nsec`
- all durable state stored in SuperBased and hydrated into Dexie

This document is the implementation baseline for scaffolding and building the app.
