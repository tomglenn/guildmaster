import React, { useEffect, useRef, useState } from 'react';
import Icon from './Icon';

export default function SearchControl({ value, onChange, label, placeholder }: {
  value: string; onChange: (value: string) => void; label: string; placeholder: string;
}) {
  const [open, setOpen] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (open) input.current?.focus(); }, [open]);
  const close = () => { onChange(''); setOpen(false); requestAnimationFrame(() => button.current?.focus()); };
  return open || value ? <div className="header-search">
    <Icon name="search" size={16}/>
    <input ref={input} aria-label={label} placeholder={placeholder} value={value}
      onChange={event => onChange(event.target.value)}
      onBlur={() => { if (!value) setOpen(false); }}
      onKeyDown={event => { if (event.key === 'Escape' && !value) close(); }}/>
    <button className="icon-button" aria-label="Clear and close search" onMouseDown={event => event.preventDefault()} onClick={close}>
      <Icon name="close" size={14}/>
    </button>
  </div> : <button ref={button} className="button small" onClick={() => setOpen(true)}><Icon name="search" size={16}/>Search</button>;
}
