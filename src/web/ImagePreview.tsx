import React, { useEffect, useRef } from 'react';
import Icon from './Icon';

export default function ImagePreview({ src, name, onClose }: { src: string; name: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  const close = () => { dialog.current?.close(); onClose(); };
  return <dialog ref={dialog} className="image-preview-dialog" aria-label={name} onCancel={event => { event.preventDefault(); close(); }} onClick={event => { if (event.target === event.currentTarget) close(); }}>
    <div className="image-preview-toolbar"><span>{name}</span><a className="button small image-download" href={src} download={name} aria-label={`Download ${name}`}>Download</a><button type="button" className="icon-button" aria-label="Close image" onClick={close}><Icon name="close"/></button></div>
    <img src={src} alt={name}/>
  </dialog>;
}
