import React, { useEffect, useId, useRef, useState } from 'react';
import Icon from './Icon';
import SearchControl from './SearchControl';
import type { Project } from '../domain/types';

export default function BoardControls({ search, onSearch, projectFilter, onProjectFilter, projects, searchLabel = 'Search quests', searchPlaceholder = 'Find a quest…', filterLabel = 'Filter quests by project' }: {
  searchLabel?: string; searchPlaceholder?: string; filterLabel?: string;
  search: string; onSearch: (value: string) => void;
  projectFilter: string; onProjectFilter: (value: string) => void; projects: Project[];
}) {
  const [filterOpen, setFilterOpen] = useState(false);
  const filterButton = useRef<HTMLButtonElement>(null);
  const filterContainer = useRef<HTMLDivElement>(null);
  const popupId = useId();
  const choices = [{ id: 'all', name: 'All projects' }, { id: 'unassigned', name: 'No saved project' }, ...projects.map(project => ({ id: project.id, name: project.archivedAt ? `${project.name} (archived)` : project.name }))];
  const selectedName = choices.find(choice => choice.id === projectFilter)?.name || 'Unavailable project';
  useEffect(() => {
    if (!filterOpen) return;
    (filterContainer.current?.querySelector<HTMLButtonElement>('[aria-pressed="true"]') ?? filterContainer.current?.querySelector<HTMLButtonElement>('.board-filter-options button'))?.focus();
    const outside = (event: PointerEvent) => {
      if (!filterContainer.current?.contains(event.target as Node)) setFilterOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setFilterOpen(false); filterButton.current?.focus(); }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [filterOpen]);
  return <div className="board-controls">
    <SearchControl value={search} onChange={onSearch} label={searchLabel} placeholder={searchPlaceholder}/>
    <div className="board-filter" ref={filterContainer} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFilterOpen(false); }}>
      <button ref={filterButton} className="button small" aria-expanded={filterOpen} aria-controls={popupId}
        onClick={() => setFilterOpen(open => !open)}><Icon name="filter" size={16}/>Filter</button>
      {filterOpen && <div id={popupId} className="board-filter-popover" role="dialog" aria-label={filterLabel}>
        <h2>Project</h2>
        <div className="board-filter-options">{choices.map(choice => <button key={choice.id} aria-pressed={projectFilter === choice.id}
          onClick={() => { onProjectFilter(choice.id); setFilterOpen(false); filterButton.current?.focus(); }}>
          <span>{choice.name}</span>{projectFilter === choice.id && <Icon name="check" size={15}/>}
        </button>)}</div>
      </div>}
    </div>
    {projectFilter !== 'all' && <span className="board-active-filter"><span title={selectedName}>{selectedName}</span>
      <button className="icon-button" aria-label="Clear project filter" onClick={() => onProjectFilter('all')}><Icon name="close" size={14}/></button>
    </span>}
  </div>;
}
