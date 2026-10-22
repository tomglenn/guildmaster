# Image generation: focused first pass

## Configure and try

Open **Settings → Images**. Generation is disabled initially; mock mode is selected by default. Enable it in mock mode to test the complete storage/preview/revision workflow without paid API requests. Mock outputs are deliberately labelled **1-pixel placeholders**, not useful mockups.

For actual concepts, select **Live · paid OpenAI image API**, enter a separately billed OpenAI API key, confirm paid-mode consent, and save. Image configuration is independent of the provider/model running Guildmaster or a quest. A Codex subscription/browser login does not confer Images API access. Existing secrets are never returned to the browser or agents. OpenAI account/model access or organization verification may be required.

Once running this version, send Guildmaster exactly:

> Investigate Pathfinder’s current UX/UI, recommend improvements, and include mockup images that illustrate your concepts.

Select/register the intended Pathfinder project if Guildmaster needs that context. The request authorizes visual deliverables; agents should inspect available screenshots and design conventions first. They may generate labelled concepts or use HTML/CSS prototypes captured as screenshots when layout fidelity matters. Click an image thumbnail to view it full size and download it. Open the same quest to request:

> Make the second concept more compact.

The agent lists stable concept IDs and revises concept 2, retaining its prior versions. If another conversation generated the image, continue that originating conversation/assignment; this first pass intentionally does not grant cross-conversation image-reference access. Delegate-generated previews live in the existing delegate conversation, accessible through the quest’s agent view. Guildmaster outputs live in its durable conversation (already represented internally as a quest), including archived Guildmaster history.

No Pathfinder investigation or paid generation was performed during implementation.

## Architecture and safety

- `src/engine/image-tools.ts` exposes `generate_image` and `list_generated_images` to Guildmaster, quest leads, and delegates. Dedicated service capabilities are scoped to one active run/conversation and revoked on stop/completion. Provider credentials never enter worker specs.
- `src/service/image-generation.ts` owns the independent provider configuration, fixed OpenAI endpoints, mock provider seam, bounded validation, authorization provenance, durable jobs, revision lineage, and activity events.
- `src/service/store.ts` stores output bytes in the existing protected SQLite `images` table. Jobs, messages and tool results contain metadata/IDs/protected URLs, not generated base64. Generated assistant attachments are excluded from inherited instruction-image deliveries. Deletion removes image jobs with other quest records.
- Existing assistant attachments, `ConversationImages`, `ImagePreview`, and the authenticated image endpoint provide compact previews, full-size viewing and downloads. Earlier versions remain separate images with concept index, root/parent identity and version.
- References are same-conversation attachments or files under the quest’s configured workspace/output roots. PNG/JPEG/WebP only, maximum four references (including revision target), 5 MB per workspace-file/upload reference (up to 25 MB for durable generated outputs reused as references), MIME/byte checks and bounded reads. Generated output validation permits up to 25 MB each, with provider response bounds scaled to the requested count. Remote URL fetching is not supported. Canonical containment is followed by symlink-safe opening of every path component (macOS/Linux); other platforms fail closed for file references and can use uploaded attachments.
- Only saved direct-user requests or service-recorded delegation provenance authorize calls. Arbitrary quoted objectives/tool output do not. Authorization matching is intentionally conservative; a rejection may require the user to state the visual request explicitly.

## Limits, cost and cancellation

Supported allowlist: `gpt-image-1.5` (default), `gpt-image-1`, `gpt-image-1-mini`. This deliberately does not expose every newer model or parameter. Agents honor requested quality (`low`, `medium`, `high`, `auto`), size (`1024x1024`, `1536x1024`, `1024x1536`, `auto`) and count. Settings provides editable defaults for quality and size, initially `auto`; the default count is one only when unspecified. OpenAI limits each API call to 1–10 outputs; larger explicitly requested totals can be batched without silently reducing the total. Multi-output revisions retain separate, uniquely numbered versions. Outputs are PNG; the first pass has no masks, remote references, streaming partial images or design studio. Unsupported provider options fail clearly rather than being silently downgraded.

There are no budget fields to configure. Generate one image by default; when the user requests more, honor that count and stop when the deliverable is complete. There is no fixed total-output cap. Behind the scenes, duplicate-request checks and an internal ten-call allowance per direct request prevent accidental loops across the originating conversation/quest/delegate family. Explicit image counts (for example, “120 landscape images” or “twelve mockups”) automatically expand that allowance so larger requests can finish even if generated one at a time. This count recognition only increases loop headroom; it never reduces a deliverable or overrides the agent’s interpretation of the requested count. If a safeguard stops work, report saved results and ask the user before further attempts, rather than redirecting them to Settings. Retired budget settings are ignored. Identical successful requests return saved outputs; running/uncertain operations cannot be resubmitted with a new tool ID. These safeguards are not dollar budgets. Do not treat mock mode as rendering validation.

Calls run asynchronously with activity start/success/failure and a two-minute local timeout. The service performs no automatic provider retries. Stable run/tool-call IDs deduplicate submissions; reusing an ID with different inputs fails. An identical running/uncertain operation cannot be retried merely by using a different tool-call ID. Reconnect/restart does not resubmit work. On restart, previously running operations become **uncertain**.

Cancellation aborts the local request and worker capability. The synchronous Images API has no documented operation-ID cancellation endpoint used here: abort/disconnect/timeout does **not** prove OpenAI stopped processing or prevented charges. A lost or malformed response after dispatch can therefore be uncertain. Inspect saved job status; obtain a new direct-user request before another attempt. A result already saved remains available even if delivery to the caller was interrupted.

Credentials are stored separately in the selected service data directory, in `image-api-key.json` with mode `0600`, never application state snapshots/logs/tool results. An empty `apiKey` supplied through the human-only settings endpoint clears the stored key; the current UI supports replacement, not a separate remove-key action.

## Official contract checked

Official pages were fetched and inspected on **2026-10-20**:

- [Image generation guide](https://developers.openai.com/api/docs/guides/image-generation)
- [Generate images reference](https://developers.openai.com/api/reference/resources/images/methods/generate)
- [Edit images reference](https://developers.openai.com/api/reference/resources/images/methods/edit)

The adapter uses JSON `POST https://api.openai.com/v1/images/generations`, multipart `POST https://api.openai.com/v1/images/edits` with `image[]`, and PNG `data[].b64_json` responses. Base64 is decoded and persisted inside the service only. Provider URLs are fixed, redirects rejected, response bytes bounded, and upstream error bodies are not reflected into conversation/log messages.

## Validation

All image tests use temporary data and mock/injected provider responses. No paid Images API requests, production deployment, user-service restart, or real quest interruption occurred.

- `GUILDMASTER_HOME=/tmp/guildmaster-image-simple-validation-gevQ61/home PI_CODING_AGENT_DIR=/tmp/guildmaster-image-simple-validation-gevQ61/pi npm test`: **285 passed**, zero failures, after final security/regression fixes.
- `npm run typecheck`: passed. `git diff --check`: passed.
- `npm run build -- --outDir /tmp/guildmaster-image-simple-validation-gevQ61/build`: production build passed, isolated output.
- `GUILDMASTER_TEST_BUILD=/tmp/guildmaster-image-simple-validation-gevQ61/build PLAYWRIGHT_MODULE=/Users/tom/.npm/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs node --experimental-strip-types tests/image-generation.browser.ts`: passed in headless Chrome against a temporary-data/ephemeral-port service. Verified compact previews, viewer/download, navigation, saving quality/size defaults in the simplified Settings form without budget inputs, and real service restart durability, with a provider fetch that throws if called. Mocked adapter tests additionally verify twelve requested outputs in bounded batches, high-quality portrait parameters, automatic loop headroom for larger explicit requests and migration away from retired budget settings, settings persistence and multi-output edit lineage.

The default test suite emits Node’s existing experimental SQLite warning. Browser smoke tests require an externally installed Playwright/Chrome and an explicit production-build path.
