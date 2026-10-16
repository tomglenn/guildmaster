import React, { useEffect, useState } from 'react';
import type { Project } from '../domain/types';

type ProjectBody = Pick<Project, 'name' | 'aliases' | 'instructions' | 'repositories'>;
export default function ProjectConfig({ project, hidden, disabled, onSave }: {
  project: Project; hidden: boolean; disabled?: boolean; onSave: (id: string | null, body: ProjectBody) => Promise<Project>;
}) {
  const values = (value: Project) => ({ name: value.name, aliases: value.aliases.join(', '), instructions: value.instructions });
  const [draft, setDraft] = useState(() => ({ ...values(project), baseline: values(project) }));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const registeredAliases = project.aliases.join(', ');
  useEffect(() => {
    // Refresh untouched fields while retaining drafts through tab changes and background updates.
    setDraft(previous => ({
      name: previous.name === previous.baseline.name ? project.name : previous.name,
      aliases: previous.aliases === previous.baseline.aliases ? registeredAliases : previous.aliases,
      instructions: previous.instructions === previous.baseline.instructions ? project.instructions : previous.instructions,
      baseline: { name: project.name, aliases: registeredAliases, instructions: project.instructions },
    }));
  }, [project.name, registeredAliases, project.instructions]);
  const parsedAliases = draft.aliases.split(',').map(alias => alias.trim()).filter(Boolean);
  const changed = draft.name.trim() !== project.name || JSON.stringify(parsedAliases) !== JSON.stringify(project.aliases) || draft.instructions.trim() !== project.instructions;
  const edit = (field: 'name' | 'aliases' | 'instructions', text: string) => {
    setDraft(previous => ({ ...previous, [field]: text })); setSaved(false); setError('');
  };
  return <form className="project-config-editor" hidden={hidden} onSubmit={async event => {
    event.preventDefault();
    if (disabled || saving || !changed) return;
    setSaving(true); setSaved(false); setError('');
    try {
      const result = await onSave(project.id, {
        name: draft.name.trim(), aliases: parsedAliases, repositories: project.repositories, instructions: draft.instructions.trim(),
      });
      setDraft({ ...values(result), baseline: values(result) }); setSaved(true);
    } catch (cause) { setError((cause as Error).message); }
    finally { setSaving(false); }
  }}>
    <label className="field">Project name
      <input required maxLength={100} value={draft.name} readOnly={disabled || saving} onChange={event => edit('name', event.target.value)} placeholder="Project name"/>
    </label>
    <label className="field"><span className="field-label">Aliases <span className="optional">optional</span></span>
      <input value={draft.aliases} readOnly={disabled || saving} onChange={event => edit('aliases', event.target.value)} placeholder="Short names or abbreviations"/>
      <small>Separate names with commas. Guildmaster recognizes these names in conversation.</small>
    </label>
    <label className="field">Project instructions
      <textarea rows={12} maxLength={20000} value={draft.instructions} readOnly={disabled || saving}
        onChange={event => edit('instructions', event.target.value)}
        placeholder="Development commands, repository relationships, and conventions…"/>
      <small>Used by new quests. Existing quests retain the instructions they started with.</small>
    </label>
    {error && <div className="inline-error" role="alert">{error}</div>}
    <div className="project-editor-actions">
      <button className="button primary" type="submit" disabled={disabled || saving || !changed}>{saving ? 'Saving…' : 'Save changes'}</button>
      <span className="project-save-status" role="status">{saved ? 'Saved' : ''}</span>
    </div>
  </form>;
}
