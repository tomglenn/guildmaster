import useStoredTab from './useStoredTab';
import Breadcrumbs from './Breadcrumbs';
import React, { useEffect, useRef, useState } from 'react';
import type { Project, ProjectRepository } from '../domain/types';
import FolderField from './FolderField';
import Icon from './Icon';
import ProjectConfig from './ProjectConfig';
import SearchControl from './SearchControl';

type ProjectBody = Pick<Project, 'name' | 'aliases' | 'instructions' | 'repositories'>;
type Editor = 'new' | 'repository';
const newRepository = (): ProjectRepository => ({ id: crypto.randomUUID(), name: '', path: '' });
const route = (): { id: string; fromDirectory?: boolean } | undefined => window.history.state?.guildmasterProject;

export default function Projects({ projects, onSave, onGuildmaster, onAction }: {
  projects: Project[];
  onSave: (id: string | null, body: ProjectBody) => Promise<Project>;
  onGuildmaster: () => void;
  onAction: (id: string, action: 'archive' | 'restore') => Promise<Project>;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(() => route()?.id ?? null);
  const [tab, setTab] = useStoredTab(`guildmaster:project-tab:${selectedId ?? 'directory'}`, ['repositories', 'config'], 'repositories');
  const [search, setSearch] = useState('');
  const [scope, setScope] = useStoredTab('guildmaster:projects-tab', ['current', 'archived'], 'current');
  const [editor, setEditor] = useState<Editor>();
  const [name, setName] = useState('');
  const [repository, setRepository] = useState<ProjectRepository>(newRepository);
  const [repositoryId, setRepositoryId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const archiveDialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const current = projects.find(project => project.id === selectedId);
  useEffect(() => {
    const pop = () => { setSelectedId(route()?.id ?? null); setEditor(undefined); setError(''); };
    window.addEventListener('popstate', pop);
    return () => window.removeEventListener('popstate', pop);
  }, []);
  useEffect(() => { if (content.current) content.current.scrollTop = 0; }, [selectedId, tab, editor]);
  const open = (project: Project) => {
    window.history.pushState({ ...history.state, guildmasterProject: { id: project.id, fromDirectory: true } }, '');
    setSelectedId(project.id); setEditor(undefined); setError('');
  };
  const directory = () => {
    if (route()?.fromDirectory) window.history.back();
    else { const state = { ...history.state }; delete state.guildmasterProject; history.replaceState(state, ''); setSelectedId(null); }
    setEditor(undefined); setError('');
  };
  const start = (next: Editor, repo?: ProjectRepository) => {
    setError(''); setName(current?.name ?? '');
    setRepository(repo ? { ...repo } : newRepository());
    setRepositoryId(repo?.id ?? null); setEditor(next);
  };
  const closeEditor = () => { setEditor(undefined); setError(''); requestAnimationFrame(() => heading.current?.focus({ preventScroll: true })); };
  const save = async (remove = false) => {
    if (busy) return;
    setBusy(true); setError('');
    try {
      if (editor !== 'new' && !current) throw new Error('This project is no longer available. Return to Projects.');
      // Only replace the section being edited. Background registry updates remain intact.
      let body: ProjectBody = current
        ? { name: current.name, aliases: current.aliases, instructions: current.instructions, repositories: current.repositories }
        : { name: name.trim(), aliases: [], instructions: '', repositories: [repository] };
      if (editor === 'repository') {
        if (repositoryId && !current!.repositories.some(repo => repo.id === repositoryId)) throw new Error('This repository was removed while you were editing. Cancel to refresh the project.');
        body = { ...body, repositories: remove
          ? current!.repositories.filter(repo => repo.id !== repositoryId)
          : repositoryId ? current!.repositories.map(repo => repo.id === repositoryId ? repository : repo) : [...current!.repositories, repository] };
      }
      const saved = await onSave(editor === 'new' ? null : current!.id, body);
      if (editor === 'new') {
        window.history.pushState({ ...history.state, guildmasterProject: { id: saved.id, fromDirectory: true } }, '');
        setSelectedId(saved.id); setScope('current');
      }
      closeEditor();
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  };
  const archiveAction = async (action: 'archive' | 'restore') => {
    if (!current || busy) return;
    setBusy(true); setError('');
    try {
      await onAction(current.id, action);
      if (action === 'archive') {
        const state = { ...history.state }; delete state.guildmasterProject; history.replaceState(state, '');
        setSelectedId(null); setEditor(undefined); setScope('current');
      }
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  };
  const repositoryFields = <div className="project-repository-fields">
    <label className="field">Repository name<input required maxLength={100} value={repository.name}
      onChange={event => setRepository({ ...repository, name: event.target.value })} placeholder="Frontend app" autoFocus={editor === 'repository'}/></label>
    <FolderField label="Local folder" required disabled={busy} value={repository.path}
      onChange={path => setRepository({ ...repository, path })}
      onPick={path => setRepository({ ...repository, path, name: repository.name.trim() || path.split('/').filter(Boolean).pop() || 'Repository' })}/>
    {editor !== 'new' && <label className="field"><span className="field-label">Description <span className="optional">optional</span></span>
      <textarea rows={2} maxLength={2000} value={repository.description ?? ''} onChange={event => setRepository({ ...repository, description: event.target.value })} placeholder="What lives in this repository?"/></label>}
  </div>;

  const query = search.trim().toLocaleLowerCase();
  const matchedProjects = projects.filter(project => [project.name, ...project.aliases,
    ...project.repositories.flatMap(repo => [repo.name, repo.path, repo.description ?? '']),
  ].some(value => value.toLocaleLowerCase().includes(query)));

  const filteredProjects = matchedProjects.filter(project => scope === 'archived' ? !!project.archivedAt : !project.archivedAt);

  if (!current && !editor && !selectedId) return <div className="projects-page settings-page page-scroll">
    <div className="page-header-sticky">
    <div className="page-heading"><div><h1>Projects</h1></div>
      <div className="project-directory-actions"><SearchControl value={search} onChange={setSearch} label="Search projects" placeholder="Find a project…"/>
        <button className="button small" onClick={() => start('new')}><Icon name="plus" size={15}/>Add project</button></div></div>
    <div className="detail-tabs project-directory-tabs" aria-label="Project status">
      <button className={scope === 'current' ? 'selected' : ''} aria-pressed={scope === 'current'} onClick={() => setScope('current')}><Icon name="grid" size={15}/>Current<span>{matchedProjects.filter(project => !project.archivedAt).length}</span></button>
      <button className={scope === 'archived' ? 'selected' : ''} aria-pressed={scope === 'archived'} onClick={() => setScope('archived')}><Icon name="archive" size={15}/>Archived<span>{matchedProjects.filter(project => !!project.archivedAt).length}</span></button>
    </div>
    </div>
    {error && <div className="inline-error" role="alert">{error}</div>}
    {filteredProjects.length ? <div className="quest-grid project-directory" aria-label="Registered projects">{filteredProjects.map(project => <button className="quest-card project-directory-card" key={project.id} aria-label={`Open project ${project.name}`} onClick={() => open(project)}>
      <div className="quest-card-top"><span className="quest-monogram"><Icon name={project.archivedAt ? 'archive' : 'folder'} size={22}/></span>
        <span className="project-repository-count">{project.repositories.length} {project.repositories.length === 1 ? 'repository' : 'repositories'}</span></div>
      <h2>{project.name}</h2>
      <ul className="project-repository-preview">{project.repositories.slice(0, 3).map(repo => <li key={repo.id}>
        <div><Icon name="branch" size={13}/><span title={repo.name}>{repo.name}</span></div>
        {project.repositories.length === 1 && repo.description && <p>{repo.description}</p>}
      </li>)}</ul>
      <div className="project-repository-card-footer">{project.repositories.length > 3 && <span className="project-more-repositories">+{project.repositories.length - 3} more</span>}<span className="quest-open-icon"><Icon name="right" size={15}/></span></div>
    </button>)}</div> : projects.length || search || scope === 'archived' ? <div className="tab-empty"><Icon name={scope === 'archived' ? 'archive' : 'search'} size={28}/><h3>{search ? 'No projects match your search' : scope === 'archived' ? 'No archived projects' : 'No current projects'}</h3><p>{search ? 'Try a project name, alias, or repository.' : scope === 'archived' ? 'Archived projects stay here until you restore them.' : 'Open Archived to restore a project, or register a new one with Guildmaster.'}</p></div> : <div className="tab-empty"><Icon name="folder" size={30}/><h3>Give Guildmaster a project</h3>
      <p>Tell Guildmaster its name and where its repositories live.</p><button className="button small" onClick={onGuildmaster}>Register with Guildmaster</button></div>}
  </div>;

  const title = editor === 'new' ? 'Add project'
    : editor === 'repository' ? repositoryId ? current?.repositories.find(repo => repo.id === repositoryId)?.name ?? 'Repository' : 'Add repository' : current?.name ?? 'Project unavailable';
  return <div className="project-detail-view">
    <dialog className="project-archive-dialog" ref={archiveDialog} aria-labelledby="project-archive-title" aria-describedby="project-archive-description">
      <h2 id="project-archive-title">Archive {current?.name}?</h2>
      <p id="project-archive-description">This project will move to Archived. Existing quests and repository folders are kept. You can restore it later.</p>
      <div className="project-editor-actions">
        <button className="button" autoFocus onClick={() => archiveDialog.current?.close()}>Cancel</button>
        <button className="button" onClick={() => { archiveDialog.current?.close(); void archiveAction('archive'); }}>Archive project</button>
      </div>
    </dialog>
    <div className="quest-header">
      <Breadcrumbs current={editor === 'repository' ? 'Repository' : 'Project'} disabled={busy} items={[
        { label: 'Projects', onClick: editor === 'new' ? closeEditor : directory },
        ...(editor === 'repository' && current ? [
          { label: current.name, onClick: closeEditor },
        ] : []),
      ]}/>
      <div className="quest-title-row"><div><h1 ref={heading} tabIndex={-1}>{title}</h1>
        {!editor && current?.aliases.length ? <p className="project-detail-aliases">Also known as {current.aliases.join(', ')}</p> : null}
        {editor === 'new' && <p className="project-detail-aliases">Start with one repository. Add more repositories and instructions afterwards.</p>}
        {current?.archivedAt && <div className="quest-subline"><span className="archived-label"><Icon name="archive" size={14}/>Archived</span></div>}
      </div>{current && (!editor || current.archivedAt) && <div className="quest-actions">
        {!current.archivedAt && <button className="button small" onClick={() => start('repository')}><Icon name="plus" size={15}/>Add repository</button>}
        <button className="button small" disabled={busy} onClick={() => current.archivedAt ? void archiveAction('restore') : archiveDialog.current?.showModal()}><Icon name={current.archivedAt ? 'retry' : 'archive'} size={15}/>{current.archivedAt ? 'Restore project' : 'Archive project'}</button>
      </div>}</div>
    </div>
    {!editor && current && <div className="detail-tabs" aria-label="Project views">
      <button className={tab === 'repositories' ? 'selected' : ''} aria-pressed={tab === 'repositories'} onClick={() => setTab('repositories')}><Icon name="folder" size={15}/>Repositories<span>{current.repositories.length}</span></button>
      <button className={tab === 'config' ? 'selected' : ''} aria-pressed={tab === 'config'} onClick={() => setTab('config')}><Icon name="settings" size={15}/>Configuration</button>
    </div>}
    <div className="project-detail-scroll page-scroll" ref={content}>
      {error && <div className="inline-error" role="alert">{error}</div>}
      {editor ? <form className="project-focus-editor" onSubmit={event => { event.preventDefault(); void save(); }}>
        <fieldset disabled={busy || !!current?.archivedAt}>
          {(editor === 'new') && <label className="field">Project name<input autoFocus required maxLength={100} value={name} onChange={event => setName(event.target.value)} placeholder="Project name"/></label>}
          {(editor === 'new' || editor === 'repository') && repositoryFields}
          <div className="project-editor-actions"><button className="button primary" type="submit">{busy ? 'Saving…' : editor === 'new' ? 'Create project' : 'Save changes'}</button>
            <button className="button" type="button" onClick={closeEditor}>Cancel</button>
            {editor === 'repository' && repositoryId && <button className="button project-remove-repository" type="button" disabled={current!.repositories.length <= 1}
              title={current!.repositories.length <= 1 ? 'A project needs at least one repository.' : undefined} onClick={() => void save(true)}>Remove repository</button>}
          </div>
        </fieldset>
      </form> : !current ? <div className="tab-empty"><h3>This project is no longer available</h3><button className="button small" onClick={directory}>Back to Projects</button></div>
        : tab === 'repositories' ? <><div className="quest-grid project-repository-grid" aria-label="Project repositories">{current.repositories.map(repo => <button className="quest-card project-repository-card" key={repo.id} aria-label={`Configure ${repo.name}`} onClick={() => start('repository', repo)}>
          <div className="quest-card-top"><span className="quest-monogram"><Icon name="folder" size={22}/></span></div>
          <h2>{repo.name}</h2>{repo.description && <p>{repo.description}</p>}
          <div className="project-repository-card-footer"><code title={repo.path}>{repo.path}</code><span className="quest-open-icon"><Icon name="right" size={15}/></span></div>
        </button>)}</div></> : null}
      {current && <ProjectConfig key={current.id} project={current} hidden={!!editor || tab !== 'config'} disabled={!!current.archivedAt} onSave={onSave}/>}
    </div>
  </div>;
}
