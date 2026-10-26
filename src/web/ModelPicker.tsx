import React, { useEffect, useId, useRef, useState } from 'react';
import Icon from './Icon';

type Model = { id: string; name: string };
const providerName = (id: string) => ({ 'openai':'OpenAI', 'openai-codex':'OpenAI Codex', 'anthropic':'Anthropic', 'google':'Google' }[id] || id.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' '));

export default function ModelPicker({ models, value, disabled, onChange, label='Guildmaster', variant='composer', emptyOption, note='Applies to your next message' }: {
  models: Model[]; value: string; disabled?: boolean; onChange: (id: string) => void;
  label?: string; variant?: 'composer'|'settings'; emptyOption?: string; note?: string;
}) {
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [position, setPosition] = useState<{ left:number; top?:number; bottom?:number; maxHeight:number }>({ left:16, bottom:16, maxHeight:400 });
  const place = () => {
    const rect = button.current?.getBoundingClientRect();
    if (!rect) return;
    const width = Math.min(380, window.innerWidth - 32);
    const above = rect.top > window.innerHeight - rect.bottom;
    const height = Math.max(100, Math.min(420, (above ? rect.top : window.innerHeight - rect.bottom) - 24));
    setPosition({ left: Math.max(16, Math.min(rect.left, window.innerWidth - width - 16)), ...(above ? { bottom:window.innerHeight - rect.top + 8 } : { top:rect.bottom + 8 }), maxHeight:height });
  };
  useEffect(() => { if (open) { search.current?.focus(); window.addEventListener('resize', place); return () => window.removeEventListener('resize', place); } }, [open]);
  useEffect(() => { if (disabled) popup.current?.hidePopover(); }, [disabled]);
  const close = () => { popup.current?.hidePopover(); button.current?.focus({ preventScroll:true }); };
  const matches = models.filter(model => `${model.name} ${model.id}`.toLowerCase().includes(query.trim().toLowerCase()));
  const groups = new Map<string, Model[]>();
  for (const model of matches) { const provider = model.id.includes('/') ? model.id.split('/')[0] : 'Models'; groups.set(provider, [...(groups.get(provider) || []),model]); }
  const selected=models.find(model=>model.id===value);
  const selectedName=selected?.name || value || emptyOption || 'Choose a model';
  return <>
    <button ref={button} className={`gm-model-trigger ${variant==='settings'?'settings-model-trigger':''}`} type="button" aria-label={`${label} model: ${selectedName}`} aria-haspopup="dialog" aria-expanded={open} aria-controls={id} disabled={disabled} onClick={() => { if (open) close(); else { setQuery(''); place(); popup.current?.showPopover(); } }}>{variant==='composer'&&<Icon name="brain" size={16}/>}<span className="model-trigger-label"><span>{selectedName}</span>{variant==='settings'&&value&&<small>{providerName(value.split('/')[0])}{!selected?' · Unavailable':''}</small>}</span><Icon name="down" size={12}/></button>
    <div ref={popup} id={id} className="model-picker-popover" popover="auto" role="dialog" aria-label={`Choose ${label} model`} style={position} onToggle={event => setOpen((event.nativeEvent as ToggleEvent).newState === 'open')} onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); close(); }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        const choices = Array.from(popup.current?.querySelectorAll<HTMLButtonElement>('.model-picker-option') || []);
        if (!choices.length) return;
        event.preventDefault();
        const index = choices.indexOf(document.activeElement as HTMLButtonElement);
        choices[index < 0 ? event.key === 'ArrowDown' ? 0 : choices.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length].focus();
      }
    }}>
      <div className="model-picker-search"><Icon name="search" size={16}/><input ref={search} value={query} onChange={event => setQuery(event.target.value)} placeholder="Find a model…" aria-label="Search models" autoComplete="off"/></div>
      <div className="model-picker-options">{emptyOption&&!query.trim()&&<button type="button" className={`model-picker-option ${!value?'selected':''}`} aria-pressed={!value} onClick={()=>{onChange('');close();}}><span>{emptyOption}</span>{!value&&<Icon name="check" size={15}/>}</button>}{groups.size ? Array.from(groups).map(([provider, choices]) => <section key={provider} aria-label={providerName(provider)}><h3>{providerName(provider)}</h3>{choices.map(model => <button className={`model-picker-option ${model.id === value ? 'selected' : ''}`} key={model.id} type="button" aria-pressed={model.id === value} onClick={() => { onChange(model.id); close(); }}><span>{model.name}</span>{model.id === value && <Icon name="check" size={15}/>}</button>)}</section>) : <p className="model-picker-empty">No models match your search.</p>}</div>
      <p className="model-picker-note">{note}</p>
    </div>
  </>;
}
