// Fictional browser-only fixtures. No external services or credentials.
export const richMarkdown = [
  '# Field notes from the guild',
  'A **clear decision**, an *annotation*, and ~~superseded instructions~~. Inline `src/web/App.tsx` stays quiet in prose.',
  '## Implementation record',
  '### Repository evidence',
  '#### Verification',
  '##### Supporting notes',
  '###### Small print',
  '> Keep the ledger legible.\n>\n> This annotation includes a [source](https://example.com/record).',
  '1. Inspect the repository.\n   - Preserve unrelated changes.\n     - Check the nested detail.\n2. Validate the implementation.',
  '- [x] Preserve keyboard access\n- [ ] Review the rendered result',
  '---',
  '| Record | State | Evidence |\n| :--- | :---: | ---: |\n| Typecheck | Passed | `tsc --noEmit` |\n| Review | Pending | Human decision |',
  '```typescript\n// Warm, readable syntax on a quiet dark insert.\nconst project = { name: "Guildmaster", ready: true };\nfunction report(count: number) {\n  return `${project.name}: ${count}`;\n}\nconsole.log(report(42));\n```',
  '```text\n' + 'a-long-unbroken-diagnostic-value-'.repeat(12) + '\n```',
  '```diff\n--- a/theme.css\n+++ b/theme.css\n@@ -1,2 +1,2 @@\n-background: leather;\n+background: vellum;\n color: ink;\n```',
  '```bash\n# Preserve the exact command, including entities and quotes.\nprintf "%s\\n" "<guild> & ledger"\nnpm run typecheck\n```',
  '```unknown-language\nliteral <script>alert("never HTML")</script> &amp; output\n```',
  'A long URL: https://example.com/repositories/guildmaster/technical-records/very-long-path-without-spaces/verification-and-evidence/commit/12345678901234567890',
  '![Architecture diagram — open only by choice](https://example.com/diagram.png)',
  '<details><summary>Untrusted raw HTML remains literal</summary>Not an interactive HTML panel.</details>',
  '## End of field notes',
].join('\n\n');

export const providerSettings = {
  providers: [
    { id: 'test', name: 'Fixture provider', configured: true, authMethods: ['api_key'] },
    { id: 'sample', name: 'Example provider', configured: false, authMethods: ['api_key'] },
  ],
  models: [{ id: 'test/model', name: 'Test model', provider: 'test' }],
  defaultModel: 'test/model', canImportPi: true,
};

export const folderListing = {
  path: '/workspace', parentPath: '/', homePath: '/workspace', isRepository: false, truncated: false,
  directories: [
    { name: 'guildmaster', path: '/workspace/guildmaster', isRepository: true },
    { name: 'records', path: '/workspace/records', isRepository: false },
  ],
};
