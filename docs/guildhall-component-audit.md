# Guildhall component audit

## Scope

Audited the visible frontend in `src/web/`, the shared stylesheet, the safe Marked-to-React renderer, the supplied image inventory, and the theme's existing material integration. This is a coverage map, not a claim that every backend/authentication state was exercised live.

The foundation is now **one irregular vellum manuscript on the walnut desk**, with a dark leather sidebar. `Workspace`'s route/material names remain useful hooks, but no longer select unrelated physical environments. Only the content-sized quest-notice inset uses walnut inside the manuscript.

## Visible components and treatment

| Source / family | Visible states audited | Shared design treatment |
| --- | --- | --- |
| `App.tsx`, `Workspace.tsx` | Main routes, startup, connection banners, empty/current/archived boards, review/cancel/delete actions | Stable manuscript artwork and scrolling; header rules; content-sized walnut notice inset; unchanged routing/actions |
| Sidebar in `App.tsx` | Brand, selected/hovered navigation, counts, recent quests, connected/connecting/offline indicator, settings tooltip | Dark leather, restrained brass fitting, gold edge selection and clear focus; dark tooltip |
| `Transcript.tsx` | User/assistant/system messages, saved and partial streaming messages, metadata, inline questions | Same assistant crest for saved/streaming, dark ink, modest user insets, smaller timestamps |
| `Markdown.ts` and code renderer | H1–H6, paragraphs, strong/emphasis/deletion, links, nested/ordered/task lists, quotations, rules, tables, inline/fenced code, image links, partial fences | Dedicated rich-content sheet; dark technical inserts; ledger rules/annotations; copy feedback and safe token highlighting |
| `Composer.tsx`, `useComposerDraft` | Available/paused/sending/reading/stopping/error, attachments, draft persistence, answer mode | Recessed writing tray, leather send/stop fitting, keyboard keycaps, quiet model/context rail, accessible error annotation |
| `ConversationImages.tsx`, `ImagePreview.tsx` | Attached thumbnails, full image modal, remove attachment | Small mounted-image edges, paper toolbar/dialog; existing native modal behavior retained |
| `ModelPicker.tsx` | Trigger, search, grouped/selected/empty choices, arrow keys, Escape | Paper index popover, ink dividers, explicit keyboard outline; existing top-layer placement retained |
| `ConversationActivity.tsx` | Delegation rows, tool summary, compact/expanded history, failed/completed/running marks, output disclosure | Marginal ink rule, serif action label, untextured charcoal output, warm status ink |
| `WorkingIndicator.tsx`, `LatestResultShortcut.tsx`, `ContextUsage.tsx` | Delayed progress labels, latest-result jump, context help | Marginal status line, small paper bookmark button, readable compact metadata; reduced motion preserved |
| `Agents.tsx` | Assignment overview, agent transcript, resume/recovery, info/activity, empty/loading/error | Ruled assignment register; shared manuscript transcript, crest, status and technical output |
| `QuestInfo.tsx`, `ActivityFeed.tsx` | Activity/details drawer, timeline, paths, capabilities, workspace/project associations | Smaller paper object with a narrow binding edge, ink timeline and quiet metadata; inert background/focus/Escape unchanged |
| `QuestAcceptButton.tsx`, `ConfirmDialog.tsx` | Approval, already-accepted, loading, confirmation/cancellation/permanent deletion | Leather committed action, restrained approval ink, explicit danger intent; native modal focus behavior retained |
| `Projects.tsx`, `ProjectConfig.tsx` | Directory, repository list/editor, configuration, alias/instructions helper text, archive dialog | Compact paper-inset records, circular icons, actual description/path/count/update metadata, visible Open affordance; shared writing fields/buttons/dialogs |
| `Schedules.tsx` | Directory, enabled/paused, next date, overview, dated history, completed/failed runs, editor/custom days/timezone, action menu/discard/delete | Timezone-aware date groups and compact paper-inset rows in Guildhall, direct functional Run now, enabled/disabled labels; original order retained in other themes |
| `BoardControls.tsx`, `SearchControl.tsx`, `Breadcrumbs.tsx` | Search open/clear, selected project filter, filter popover, breadcrumb truncation | Writing-field search, paper index menu, ink breadcrumb links, consistent toolbar buttons |
| `ProviderSettings.tsx` | Provider cards, default model, add/remove, API key, OAuth/device code/manual/select/error/loading/import | Same paper objects, recessed fields, credential code inserts, status annotations; no real auth performed |
| `ConnectionsSettings.tsx` | Empty/connected/sign-in-required services, add/import/reconnect/disconnect, consent/feedback | Register records and paper dialog; radio selection and destructive confirmations; no external Slack calls |
| `StorageSettings.tsx` | Retention select/custom number, helper text, saved/error, deletion confirmation | Recessed native fields, ink explanations, explicit danger confirmation |
| `AppearanceSettings.tsx`, `appearance.ts` | Four themes, preview, radios, text size, reduced motion, persistence/cross-tab | Miniature material preview and visible selected/focused radio, shared fields; preferences unchanged |
| `FolderField.tsx` | Portal folder browser, location/search, hidden checkbox, directories, loading/empty/error/select/cancel | Paper folder index, shared inputs/checks, monospaced paths and consistent modal toolbar/footer |
| `GuildmasterHistory.tsx` | History index, read-only transcript, loading/error/retry | Paper side folio, ruled history records and shared transcript rich content; no new trigger added |
| `Icon.tsx` | Existing functional SVG icon family | Existing iconography retained; no image-generation or icon library dependency added |

Nonvisual draft/transcript/hooks (`composer-drafts`, `transcript-data`, `useStoredTab`, `useLiveToolCalls`) retain their business logic.

## Controls and content not implemented by this application

- There is **no command palette, toast notification subsystem, draggable/resizable panel, range-slider UI, or custom toggle-switch component** in this frontend. Do not claim they were implemented or tested. Native checkboxes/radios/selects are the actual controls, themed without removing their semantics; a range accent token is present defensively.
- There are no third-party rendered widget components. React/React DOM supply the UI; Marked tokenizes Markdown and `entities` decodes prose. Agent text remains React text, never injected HTML.
- Raw HTML (including `<details>`, `<summary>` and `<img>`) remains literal. Native collapsible UI exists for tool details, schedule menus, advanced forms and inspector sections. Enabling untrusted HTML is not part of this redesign.
- Markdown images remain explicit opt-in links for privacy. User attachments have real thumbnail/preview components.
- No code line numbers were previously supported; none are claimed. Syntax colouring is a safe limited lexical aid, with literal fallback—not a compiler or full IDE grammar.
- Browser-native file pickers, provider/Slack consent pages, native validation bubbles and OS scrollbars cannot be fully repainted by this app. Their in-app launchers/fields are themed, but native behavior is retained for accessibility.

## Shared implementation responsibilities

- `guildhall.css`: palette/material tokens, desk/sidebar/manuscript composition, record layouts, pinned quest notices, responsive and decorative forced-colour fallbacks.
- `guildhall-components.css`: controls and states, composer, tabs/breadcrumbs, overlays/menus/tooltips, forms/checks/radios, agent/tool/quest metadata, settings and recovery patterns.
- `guildhall-rich-content.css`: supported rich content and code inserts, syntax colours, copy UI, table overflow and content focus/selection.
- `guildhall-mockup.css`: supplied-mockup proportions, brand/compass, serif conversation, persistent search, board toolbar and responsive control wrapping.
- `guildhall-records.css`: compact project records and date-grouped schedule rows, with native action menus preserved.
- `ConfirmDialog` has explicit presentation intent; this does not change what its callbacks do.

## Validation boundaries

Browser checks use real production components with fictional intercepted APIs, never the live service. The screenshot/interaction script records actual coverage; unit tests protect rendering security, prose/code fidelity, drafts, statuses, project/schedule behavior and preferences. Visual captures and keyboard checks are not a full screen-reader/WCAG certification, nor exhaustive coverage of every provider login/error and quest-state combination. See `guildhall-theme.md` for exact commands and results.
