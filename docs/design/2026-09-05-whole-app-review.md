Review complete. Verdict first: the shell spends most of every screen on chrome and repeated identity text, three routes are the same empty form, and the two settings-style pages duplicate each other. The redesign's problem is structural, not cosmetic, so the direction below reorganizes the app around three jobs, run a simulation, review a session, configure the stack, and gives each page one state model and one action convention.

## 1. Diagnosis

**The home page has nothing to do.** In overview-desktop.png the four metric cards read Live, 2, 3, Owner. Two of those are not operational numbers, "Live" repeats in the Service status list directly beneath, and "Owner" repeats the sidebar footer. Below that, "Open simulations" in the header, the three scenario rows, and the Simulations nav item are three routes to one place on one screen. There is no recent activity, so an operator cannot resume anything from Home. On overview-laptop.png the status and provider panels fall below the fold entirely, so the only content left above the fold is the scenario list.

**Decisions, Usage and Replays are one workflow split into three near-identical dead ends.** decisions-desktop.png and usage-desktop.png are pixel-identical except the icon and one verb, because both render the same component from `apps/stavka/src/components/operations.tsx:195`. Both require a hand-typed session ID with no placeholder, and "Faction" is a free-text input when only OPFOR and BLUFOR are valid. The empty state tells the user to go to Simulations and come back. Replays imports the same export format and renders the same dashboard from a native file input styled as a black "CHOOSE FILE" button, with a "Return to simulator" button as the most prominent control on the page. Session IDs are deterministic from scenario configuration in `apps/stavka/src/scenario-identity.ts:58`, so the ID box is unnecessary friction.

**Identity and environment are repeated up to four times per screen.** The organization name appears in the sidebar box, the header right, the Overview "Workspace role" card and the Providers owner card. On providers-desktop.png the same person and organization also appear as Owner and Organization rows inside every account card. On mobile this costs the most: in overview-mobile.png the header wraps "Andrii — local development" onto two lines, then the page repeats "Overview" as an H1 directly under the breadcrumb that already says "Overview".

**Type is too small almost everywhere.** `apps/stavka/src/styles.css` sets nav group labels at 9px at 42% opacity, the sidebar footer at 9px, metric notes and decision metadata at 10px, brand sub-label and map credit at 8px, and most descriptive text at 11px. Body is nominally 14px but real content rarely uses it. The dark rail's inactive items sit at 57% opacity, which is borderline for AA contrast, and the 9px labels are unreadable regardless of ratio.

**Loading states masquerade as failures.** system-desktop.png shows four large "Unknown" values with a plain "Loading inference metadata…" line above them. system-laptop.png shows Commander "Live" next to three "Unknown" cards. models-laptop.png, models-mobile.png, access-laptop.png and access-mobile.png are empty pages with one sentence of loading text. There are no skeletons, and each page places its loading text differently.

**Status vocabulary is inconsistent and sometimes inverted.** Badges say live, healthy, Disabled, Active, active, owner, operator, OPFOR rule. Casing varies within one panel. "Kill switch: Disabled" in a neutral badge reads as a problem when it is the healthy state. Session IDs, doctrine, mode, and tick counts are rendered as badges in the replay dashboard, so state and data look the same.

**System and Models overlap, and Providers hides its main content.** When loaded, System renders the same alias table as Models plus four cards, so two nav items show one dataset. Providers leads with an "Authorization owner" profile card that is not about providers, then puts the only real content for a new user, the CLI connection steps, behind a collapsed native disclosure at the bottom. Data that would help, such as connected date and revision, exists on the wire but is not shown.

**The laptop tier is a shrunken desktop, not a layout.** At 935 the sidebar only narrows from 224 to 200px, leaving roughly 735px of content. simulations-laptop.png shows the Units table clipping its Position column, the tab row wrapping onto two lines, and the speed controls wrapping under Resume. Nothing collapses to an icon rail, so every page pays for a fully labeled sidebar it does not need at that width.

## 2. Design direction

**Information architecture.** Three groups, seven entries, in this order: Run holds Simulations. Review holds Sessions. Configure holds Models, Providers, Access, Health. Sessions replaces Decisions, Usage and Replays as one page with a source picker and tabs. Health is the renamed System page with the alias table removed. Existing routes stay as aliases that open the consolidated page on the right tab, so tests, deep links and the Simulations "Inspect session" buttons keep working.

**Shell.** Replace the hand-rolled sidebar and header with Kumo Sidebar, Breadcrumbs, Tooltip and Button from direct imports, on the default Kumo surface rather than the custom dark rail, which removes most of the bespoke CSS and the contrast problem at once. The sidebar shows the brand mark, the three groups, and one footer row with avatar, name, role and sign out. Delete the workspace label box and the environment footer line. The header becomes a title bar: menu trigger on small widths, page title, optional context such as a session ID, and page actions on the right. Routes no longer render their own H1. Breadcrumbs appear only for nested routes such as a loaded session. Environment shows once, as a small neutral badge in the title bar, reading "Local" in development and nothing in production. The viewport stays bounded, the main pane is the single scroll container, and only Simulations at the widest tier gets independent panes.

**Typography and spacing.**

| Role                                     | Size and weight |
| ---------------------------------------- | --------------- |
| Page title                               | 18 / 600        |
| Section title                            | 14 / 600        |
| Body, table cells, form values           | 14 / 400        |
| Helper, table header, badge, timestamp   | 12 / 400 to 500 |
| Minimum anywhere, including map overlays | 12              |

Use an 8px grid. Page padding is 24, 20 and 16 across the three tiers, panel padding 16, section gap 16, table rows 40px with 44px on touch. One container level only: no LayerCard inside a panel inside a pane. Tables run full-bleed inside their panel. Drop letter-spaced uppercase eyebrows except table headers. Remove the decorative icons from panel headings and metric cards.

**Status and action conventions.** Badges are for state only. Faction, doctrine, seed, session ID, tick count and timestamps are plain text. One vocabulary, always title case:

| Meaning                                 | Label                                                 | Variant                          |
| --------------------------------------- | ----------------------------------------------------- | -------------------------------- |
| Service serving and fully configured    | Live                                                  | success                          |
| Serving with incomplete config          | Degraded                                              | warning                          |
| Unreachable or not usable               | Unavailable                                           | error                            |
| Inference gateway mode record or replay | Record mode, Replay mode                              | warning                          |
| Kill switch                             | Off, On                                               | neutral, error                   |
| Provider account                        | Active, Inactive                                      | success, neutral                 |
| Commander decisions in a running sim    | Model decisions, Rule decisions, Not connected, Error | success, warning, neutral, error |
| Model test                              | Passed at time, Failed, Not tested                    | success, error, neutral          |
| Simulation run state                    | Running, Paused, Offline                              | success, neutral, neutral        |

Every health row carries a "Checked at" time. Every page has at most one primary button, placed in the title bar. Refresh is an icon button with tooltip and a last-updated timestamp beside it. Navigation is a Kumo Link, never a button, and back navigation is the breadcrumb. Candor about model versus rule decisions lives in the status label plus a one-line tooltip, not repeated prose.

**State model.** Each region shows exactly one of loading, empty, error or content. Loading uses Kumo Loader or skeleton rows that preserve table headers, and never renders "Unknown" as a value. Empty uses Kumo Empty with one action. Errors use Kumo Banner placed where the failed content would be, with a page-level banner only when everything failed.

**Responsive strategy.**

| Tier           | Sidebar                        | Content                                                                                                           |
| -------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| 1200 and wider | Expanded, 240px                | Up to two columns; Simulations uses split panes                                                                   |
| 900 to 1199    | Icon rail, 56px, with tooltips | Single column; tables keep columns and scroll inside their panel                                                  |
| Under 900      | Drawer via Kumo Sidebar        | Stacked sections; tables hide tertiary columns with TanStack column visibility; sticky control bar on Simulations |

## 3. Page-by-page changes

**Home** replaces Overview.

- Section one is "Start a simulation": the three scenarios as a compact table with name, one-line description and a Run link that carries the existing search params. The title bar primary is "New simulation" and opens Simulations with defaults. Remove the metric cards and the "Review a recorded session" panel.
- Section two is "Recent sessions": rows keyed by scenario identity and faction, each opening the session route. Backend limit: Commander has no session index, and its export list endpoint is scoped to one session and is not proxied by the app. Store recents client-side from scenario identities the user opened until a server index exists, and label the list as this browser's history.
- Section three is a readiness strip with one row each for Commander, Inference gateway, Providers and Last model test. The last row reads "Not tested" until a Models probe succeeds, then shows time and model. That replaces the caveat paragraph with a true, actionable signal using only the existing probe endpoint.

**Sessions** replaces Decisions, Usage and Replays.

- Source picker with two options. "From Commander" is a form of Scenario, Seed, Doctrine, Time scale, Mode and Faction selects that computes the session ID with the existing identity helper and shows it as copyable text, with a small "Paste an ID instead" toggle for the raw field. "From export file" is a Kumo Button that triggers a hidden file input with the 5 MiB limit as helper text, replacing the native control.
- After load, a summary bar shows ID, faction, doctrine, mode and exported time as text, then Kumo Tabs: Timeline, State, Usage. The `/decisions` route opens Timeline, `/usage` opens Usage, `/replays` preselects the file source, and `/sessions/$sessionId` loads directly.
- In the existing dashboards, turn badge-as-data into text, drop the uppercase figcaptions, and rename "Current commander session usage" to "Session usage" since the page is historical.
- Backend limit: nothing new is required for any of this. If the team later wants persisted exports listed per session, proxy the Commander exports list through `apps/stavka/src/server.ts` under the same Access gate.

**Models.**

- One table: Tier, Provider account, Resolved model, Status, Action. Provider account maps the seat to the connected account label so "claude" becomes "Claude · production". Status shows Not tested, Passed with time, or Failed with the message, and an expandable row shows response text and token counts instead of stuffing them under the button.
- Loading renders skeleton rows under real headers. The footer note shrinks to one sentence.
- Backend limit: Commander's health response includes per-alias readiness flags, but the client schema in `packages/protocol/src/operations.ts:14` drops them. Decoding that field is an additive protocol change and would let the table show Commander readiness beside inference resolution.

**Providers.**

- Remove the owner card; profile lives in the sidebar footer and Access. Replace cards with a table: Label, Provider, Auth method in human terms, Connected date, Updated date, Status. The created and updated timestamps already exist in the account payload.
- When zero accounts exist, the CLI setup steps are the page content as an Empty state with Kumo Code and ClipboardText. When accounts exist, the steps sit in a Kumo Collapsible titled "Connect another account". Credentials stay CLI-provisioned; do not add in-browser credential entry. The app exposes delete and update routes, but adding mutation buttons is a product decision, not part of this direction.

**Access.**

- Table columns Name, Email, Role, Joined, all present in the memberships payload. Highlight the current user's row. One sentence states how membership is granted, worded from the actual backend rule. Loading shows skeleton rows, empty shows a Kumo Empty.

**Health** replaces System.

- Rows, not cards: Commander service with Live, Degraded or Unavailable and protocol version as helper text; Inference gateway with Live, Record mode or Replay mode; Container with status and relative last-change time from the existing field; Kill switch with Off or On. Each row shows a Checked at time and its own error state.
- Remove the alias table and link "3 aliases" to Models. Refresh is an icon button in the title bar. Loading never shows Unknown.

## 4. Prioritized implementation checklist

Must-fix, in order:

| Item                                                                                                     | 1440                                                                                              | 935                                                        | 390                                                                   |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------- |
| 1. Shell: Kumo Sidebar, title bar replaces breadcrumb plus H1, single identity instance, type floor 12px | Content width at least 1150px; org name appears once per screen; no computed font size under 12px | Icon rail 56px with tooltips; content width at least 850px | Title bar 52px, title on one line, drawer nav; no horizontal overflow |
| 2. Sessions consolidation with identity picker, faction select, Kumo file button, route aliases          | Load a session with zero typing; summary bar and tabs visible after load                          | Picker fits one column without wrap breaks                 | Picker fields stack; tabs scroll horizontally, never wrap             |
| 3. State model: skeletons, Empty, no Unknown while loading                                               | Health at first paint shows loaders in every row                                                  | Same                                                       | Same                                                                  |
| 4. Status vocabulary table applied app-wide                                                              | Kill switch reads Off in neutral; no lowercase badges; data never in badges                       | Same                                                       | Same                                                                  |
| 5. Home rebuilt: scenarios table, recents, readiness strip                                               | Scenarios and readiness visible without scrolling                                                 | Scenarios and readiness visible without scrolling          | Scenarios visible without scrolling                                   |
| 6. Health and Models de-duplicated                                                                       | Alias table appears on Models only                                                                | Same                                                       | Same                                                                  |
| 7. Providers table, owner card removed, human auth names, setup visible when empty                       | Zero-account state shows CLI steps without a click                                                | Same                                                       | Commands wrap within the panel                                        |
| 8. Access columns and skeleton                                                                           | Email and Joined shown                                                                            | Same                                                       | Email column hidden, shown on row expand                              |

Polish:

- Copy buttons on session IDs and CLI commands via ClipboardText.
- Relative timestamps with absolute value in a tooltip.
- Replace remaining bespoke classes in `apps/stavka/src/styles.css` with Kumo components and tokens, leaving only shell layout rules.
- Replace Button-as-tab with Kumo Tabs everywhere, which also fixes keyboard navigation.
- Mark decorative icons aria-hidden and verify nav contrast at or above 4.5:1.
- Give the Overview "Open simulations" link and similar hand-styled links proper Kumo Button or Link components.

## 5. Independent critique of Simulations for the other session

- Time scale is part of the simulation identity, so the ×1, ×10 and ×100 buttons in the control bar switch to a different Durable Object rather than changing speed, and the same setting also appears in the configuration form. Either make time scale a runtime control in the sim host, which is backend work, or remove it from the control bar and label the form field as applying to a new session.
- The primary loop, configure then load then run then read decisions, is spread across the right rail, the control bar, the tab strip and two other routes. On simulations-mobile.png the form is off-screen below the map and tables. Put configuration behind a "Scenario" button in the title bar that opens a Kumo Dialog, and keep the map, controls and tabs as the whole page.
- Commander candor is buried and repeated. Replace the two faction cards with one status chip per faction in the map header using the vocabulary above, with the explanation in a tooltip. The label must never say Model decisions unless a model response is recorded.
- The tabs already inspect the current session, so "Inspect OPFOR session" leaving the page is redundant. Make it a small "Open in Sessions" link in the tab bar.
- Remove the raw "operator" badge and the "Replay import" button from the header. The spectator banner already covers read-only, and importing an export belongs on Sessions.
- At 935 the Units table clips Position and the tabs wrap. Use Kumo Tabs, give the table internal horizontal scroll, and hide Position under 1200.
- Decision entries should show whether each came from rules or a model, since the model field is already present per item.
- At 390 make the control bar sticky at the bottom so Resume, Pause and Step stay reachable while scrolling the tables.

Summary for the supervising agent: the highest-leverage changes are the shell title bar with a Kumo Sidebar, the Sessions consolidation with an identity-based picker, and a single loading, empty and status convention. Everything above uses data the app already receives, with the three exceptions called out as backend limits: no server-side session index, the export list not being proxied, and Commander alias readiness not being decoded.
