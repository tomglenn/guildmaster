import React, { useEffect, useId, useRef, useState } from 'react';
import Icon from './Icon';
import SearchControl from './SearchControl';
import type { Project } from '../domain/types';

export type HistoryFilters = { outcome: string; closedDate: string; onOutcome: (value: string) => void; onClosedDate: (value: string) => void };
const closedDates = [{ value: 'all', label: 'Any time' }, { value: '7', label: 'Last 7 days' }, { value: '30', label: 'Last 30 days' }, { value: '90', label: 'Last 90 days' }];
export function HistoryFilterFields({ filters }: { filters: HistoryFilters }) {
  return <div className="board-filter-fields">
    <label>Outcome<select value={filters.outcome} onChange={event => filters.onOutcome(event.target.value)}><option value="all">All outcomes</option><option>Accepted</option><option>Closed</option></select></label>
    <label>Closed date<select value={filters.closedDate} onChange={event => filters.onClosedDate(event.target.value)}>{closedDates.map(choice => <option key={choice.value} value={choice.value}>{choice.label}</option>)}</select></label>
  </div>;
}

export default function BoardControls({ search, onSearch, projectFilter, onProjectFilter, projects, historyFilters, searchLabel = 'Search quests', searchPlaceholder = 'Find a quest…', filterLabel = 'Filter quests' }: {
  searchLabel?: string; searchPlaceholder?: string; filterLabel?: string; historyFilters?: HistoryFilters;
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
    filterContainer.current?.querySelector<HTMLSelectElement>('.board-filter-popover select')?.focus();
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
        <div className="board-filter-fields"><label>Project<select value={projectFilter} onChange={event => onProjectFilter(event.target.value)}>
          {!choices.some(choice => choice.id === projectFilter) && <option value={projectFilter}>Unavailable project</option>}
          {choices.map(choice => <option key={choice.id} value={choice.id}>{choice.name}</option>)}
        </select></label></div>
        {historyFilters && <HistoryFilterFields filters={historyFilters}/>}
      </div>}
    </div>
    {projectFilter !== 'all' && <span className="board-active-filter"><span title={selectedName}>{selectedName}</span>
      <button className="icon-button" aria-label="Clear project filter" onClick={() => onProjectFilter('all')}><Icon name="close" size={14}/></button>
    </span>}
    {historyFilters && historyFilters.outcome !== 'all' && <span className="board-active-filter"><span>Outcome: {historyFilters.outcome}</span>
      <button className="icon-button" aria-label="Clear outcome filter" onClick={() => historyFilters.onOutcome('all')}><Icon name="close" size={14}/></button>
    </span>}
    {historyFilters && historyFilters.closedDate !== 'all' && <span className="board-active-filter"><span>Closed: {closedDates.find(choice => choice.value === historyFilters.closedDate)?.label || historyFilters.closedDate}</span>
      <button className="icon-button" aria-label="Clear closed date filter" onClick={() => historyFilters.onClosedDate('all')}><Icon name="close" size={14}/></button>
    </span>}
  </div>;
}
