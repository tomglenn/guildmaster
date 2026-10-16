import React from 'react';
import Icon from './Icon';

type Crumb = { label: string; onClick: () => void };

export default function Breadcrumbs({ items, current, disabled = false }: { items: Crumb[]; current: string; disabled?: boolean }) {
  return <nav className="breadcrumbs" aria-label="Breadcrumb"><ol>{items.map((item, index) => <li key={index}>
    {index > 0 && <Icon name="right" size={12}/>}
    <button type="button" disabled={disabled} title={item.label} onClick={item.onClick}>{item.label}</button>
  </li>)}<li className="breadcrumb-current" aria-current="page"><Icon name="right" size={12}/><span title={current}>{current}</span></li></ol></nav>;
}
