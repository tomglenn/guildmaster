# Guildhall — cohesive study workspace

Choose **Settings → Appearance → Guildhall**. It remains opt-in and browser-persisted, with cross-tab synchronization, text-size preferences and reduced-motion support. System, Light and Dark remain available. No backend contracts, business logic, runtime dependencies or original asset files were changed.

## Composition and architecture

`Workspace.tsx` provides one main layout and a typed `material` choice, mapped from the existing view in `App.tsx`. CSS uses `data-workspace` instead of copying screen implementations. Its decorative manuscript grid is `aria-hidden`, noninteractive and hidden in other themes. The existing scroll-capture marker gives sticky headers an opaque backing only while their page scrolls.

| Workspace | Physical identity | Treatment |
| --- | --- | --- |
| Guildmaster, quest conversations, settings | Manuscript | Existing nine-region main parchment; stable corner scale, repeated edges/centre, content scrolling within the sheet. Dark HTML text, subtle user insets, no assistant bubbles, lower-page composer. |
| Quest board | Manuscript containing the supplied wooden board | `wooden-board.png` provides the actual framed board, with fixed-scale corner fittings and independent repeating interior grain. Content-sized, two-column pinned notices on desktop, one column narrow. Fixed 20px pins, small wax status medallions and close contact shadows match the mockup. |
| Projects, repositories and editors | Guild register on the shared manuscript | Fine ink rules, compact register entries rather than pinned scraps. Visible monospaced repository paths, subdued identifiers and shared recessed writing fields. |
| Schedules, editor and history | Practical planner on the shared manuscript | Fine ink divisions, a visible next-planned date, restrained calendar icons, dated run-history rows and labelled statuses. No wax or torn-edge notices. |

The desk is visible at all desktop sizes; wide layouts reserve modest margins rather than an enormous scenic gutter. Below 650px it falls back to a plain warm structural background and compact shared navigation. The sidebar is 210px on wide desktops and 180px at ≤1099px, with 9px perimeter fittings (7px narrow). Compact brand/crest, nav labels, recent work and thin gold selection outlines follow the supplied mockups.

All primary workspaces use the same nine-region sheet, retaining the desk/side-navigation composition when navigating. The board's wood is an inset, not an alternative full-page material; Projects and Schedules are different record layouts on the same manuscript.

- `guildhall.css` owns material/ink/status tokens, spacing, sheet/sidebar composition, record treatments, notice art and responsive/forced-colour fallbacks.
- `guildhall-components.css` provides reusable writing fields, native checks/radios, primary/secondary/destructive/icon controls, composer, menus/popovers/tooltips, paper dialogs, settings, agent activity and technical output.
- `guildhall-rich-content.css` owns the complete supported Markdown treatment, ledger tables, annotations, and dark technical inserts.
- `guildhall-mockup.css` refines shared proportions, navigation, serif conversation prose and persistent search.
- `guildhall-records.css` provides paper-inset project records and compact date-grouped planner rows, with real Open/Run now actions and narrow-layout wrapping.

Serif headings and manuscript conversation prose establish the book-like character of the mockups; controls/technical metadata use the system UI face; code/paths/logs retain monospace. Technical surfaces are opaque and untextured. Illustrated leather buttons are reserved for primary actions and New conversation. Destructive confirmations have explicit presentation intent without changing their callbacks. The composer is a recessed writing tray with semantic keyboard hints.

See [the component audit](guildhall-component-audit.md) for every visible component family, unsupported/absent UI capabilities, and validation boundaries.

## Rich content and security

`Markdown.ts` continues to tokenize with Marked and construct safe React elements. It never injects HTML. Raw HTML remains literal, executable URL schemes are rejected, quest file links are preserved, and remote Markdown images remain opt-in links.

`CodeBlock.ts` adds a language label (default `text`), keyboard-focusable horizontal scrolling and copy controls with polite success/failure feedback. Copying uses the original code text, not highlighted markup. Dependency-free lexical highlighting covers JS/TS, Python, shell, JSON and diff; unsupported languages and blocks over 100,000 characters stay literal. It is not a semantic parser. Unfinished streaming code retains the same safe/lossless path. No line numbers or interactive untrusted HTML were added.

H1–H6, emphasis/deletion, ordered/nested/task lists, blockquotes, horizontal rules, inline code and links receive coherent ink styling. Tables have semantic column headers and labelled, keyboard-focusable scroll regions. Other themes retain their palettes and layouts, with functional code-copy controls added intentionally.

`Transcript.tsx` uses a small **compass SVG** in a dark medallion, matching the mockup without adding a bitmap dependency. The same compass marks the compact brand. The existing `g.` wordmark and functional navigation icons are retained. Decorative crests remain hidden outside Guildhall and in forced colours.

`guildhall-mockup.css` refines mockup-specific proportions, serif prose, compact navigation, always-visible header search and board controls. Search remains collapsible in other themes; clearing Guildhall search retains input focus. New quest opens the real Guildmaster composer without overwriting any unsent draft—quest creation still uses the existing conversation flow.

Projects display actual repository descriptions, paths/counts and update dates, not invented branch data. Planner groups use each schedule's timezone: Past due, Today, Tomorrow, Upcoming and Disabled as applicable. Grouping is Guildhall-only; other themes retain the original schedule order. The existing project Current/Archived tabs and schedule project filter remain functional rather than adding mockup-only controls. Mermaid fences remain literal code, not automatically rendered diagrams.

## Asset inventory and reproducible processing

Originals in `~/downloads/gm-assets` are read only. Runtime copies are in `public/themes/guildhall/`. The builder decodes actual alpha, reports dimensions/samples, optimizes WebP copies and never writes into the source directory.

| Source | Original dimensions | Runtime adaptation |
| --- | --- | --- |
| `vellum.png` | 1254 × 1254, opaque | 768² WebP, 71,582 bytes; retained optional quiet texture (main routes now use shared manuscript) |
| `leather.png` | 1254 × 1254, opaque | 768², 168,006 bytes; sidebar |
| `desk-background.png` | 1536 × 1024, opaque | Full scene 322,038 bytes; also crop `(400,280,860,500)` rotated 90°, mirrored in both axes into `walnut.webp`, 1000 × 1720, 303,240 bytes |
| `parchment-main.png` | 1536 × 1024, genuine alpha | Nine `main-*.webp` crops, 482,000 bytes; proportional corners and mirrored repeating strips/centre |
| `quest-card-main.png` | 1586 × 992, genuine alpha | 768 × 480, 86,254 bytes; own quiet centre, no rectangular backing; nine-sliced 120px source / 36px displayed corners |
| `brass-pin.png` | 1254², alpha | Crop `(351,352,552,543)`, ignoring alpha <32 export specks with a 4px gutter; 96 × 94, 6,040 bytes; displayed independently at 20px |
| `wax-seal.png` | 1254², alpha | 128², 5,804 bytes; displayed at 30px on quest notices only |
| `wooden-board.png` | 1774 × 887, opaque | 1536 × 768 WebP, 261,078 bytes; nine-sliced frame with 34px desktop corners (26px narrow). Independent interior crop inset 190px horizontally/160px vertically, 1024px wide WebP, 110,562 bytes |
| `brass-frame.png` | 1536 × 1024, alpha | Crop `(24,56,1488,900)`, 1024 × 619, 51,266 bytes; slim sidebar fittings only |
| `action-button.png` | 2172 × 724, alpha | Crop `(45,100,2075,510)`, 768 × 189, 62,510 bytes; nine-sliced primary control |
| `parchment-frame-1.png` | 1254², hollow frame | Earlier filled 768² adaptation retained, 100,016 bytes, no longer used by theme |
| `parchment-frame-2.png` | 1254², hollow frame | Earlier filled 768² adaptation retained, 109,238 bytes, no longer used by theme |
| `quest-card-frame.png` | 1536 × 1024, alpha | Inspected, not shipped; replaced by the supplied complete card |

The mockup refinement adds 371,640 bytes of board artwork. Total stored artwork is 2,139,634 bytes (~2.04 MiB), including retained unused legacy frame/desk-crop copies. Images are shared by all instances, never duplicated per card. Other themes do not request Guildhall artwork.

### Asset limits

- Board frame corners stay fixed-scale while rails extend and matching interior grain repeats. Repetition can be recognized on very tall boards; the original artwork is not repainted. The older mirrored `walnut.webp` desk crop remains stored but no longer backs the quest board.
- Main-sheet repetition retains grain/corner scale but minor joins/repeated nicks can remain. Cards preserve fixed-scale corners; their central grain and straight edge sections still stretch with extremely tall/narrow content.
- Card/pin sources are slightly translucent (centre alpha ~252/255), intentionally preserved. Near-invisible pin export specks are excluded from runtime bounds so they cannot shrink the visible tack.
- No image provenance/licence manifest was supplied. Do not infer redistribution rights from the repository's code licence.

## Validation and reproduction

```sh
npm run build
npm run typecheck
node --experimental-strip-types --test tests/appearance.test.ts tests/transcript.test.ts tests/composer-drafts.test.ts tests/markdown.test.ts tests/projects.test.ts tests/schedules.test.ts tests/schedules-http.test.ts
```

All **68 targeted tests**, build and typecheck passed during this integration. Optional asset/browser utilities use the already available Playwright `1.59.0-alpha-1771104257000` and Chromium headless shell 1248; they install nothing:

```sh
export PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs
export BROWSER_EXECUTABLE=/absolute/path/to/chromium
node scripts/build-guildhall-assets.mjs ~/downloads/gm-assets
npm run build
node scripts/check-guildhall.mjs
```

The browser script serves `dist` on an ephemeral local port with fictional APIs; it never sends live model requests or mutates real quests/projects/schedules. Checks cover:

- All four real workspace components at **1440 × 900, 1280 × 800, 1024 × 768**, with screenshot captures and overflow checks; all four also captured at 768/390/320px with larger text, including minimum usable search widths and record-action bounds.
- Material routing and active navigation; shared manuscript on every route; no pins on register/planner records; content-sized supplied wooden-board inset with fixed-scale fittings.
- Persistent quest search/filtering/clear-focus and the New quest entry point's preservation of existing drafts.
- Supplied asset alpha, fixed-size pins, taller card stress, manuscript corner size under a layout-stressed long transcript, technical surfaces without texture.
- Draft preservation, fixture sending, keyboard card activation, theme switching/reload, project/repository/folder editor opening/cancellation, schedule editor/history/menu opening/cancellation and completed/failed run labels.
- Model search empty/selected/keyboard states, image attachment/preview/removal, quest inspector inert background/Escape, agent assignment/tool-output views, paper provider/connection dialogs and explicit destructive confirmation styling.
- Partial-stream crest/code, stop control, failed-run recovery and pending-question/answer presentation, without performing real actions.
- Real clipboard copying and failure feedback; code/diff token accents, entity/newline fidelity, image privacy, and internal code/table scrolling at 1024/390/320px.
- Sticky board header and filter popover while scrolled; header-control contrast at desktop and 768/390/320px.
- Larger conversation text, reduced motion, forced colours and a 720 × 475 CSS viewport approximating 200% desktop zoom.
- No browser page errors; no fantasy-art requests or visible decorative crest/sheet in Light mode.

Screenshots and logs are in ignored `.guildmaster/guildhall-validation/`. Actual board/manuscript/register/planner renders, agent/tool output, rich content at desktop/narrow widths, settings, provider/deletion dialogs and editor/history captures were visually inspected. `scripts/guildhall-fixtures.mjs` holds only fictional content/settings/folder data for these checks.

Limits: Chromium only, not Safari/Firefox or physical browser-zoom certification. No live-service actions, real mobile keyboard, screen-reader session, exhaustive contrast audit or complete backend integration suite was performed. Existing native/API functionality is preserved, not reimplemented.
