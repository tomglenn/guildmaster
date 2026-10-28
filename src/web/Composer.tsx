import { ComposerFire } from './Halloween';
import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import Icon from './Icon';
import ImagePreview from './ImagePreview';
import useComposerDraft, { composerDrafts } from './useComposerDraft';
import { IMAGE_TYPES, MAX_IMAGE_BYTES, MAX_IMAGES, type ImageUpload } from '../domain/images';

const appliedSuggestions = new WeakSet<object>();

export default function Composer({ draftKey, onSend, disabled, placeholder, footer, active = true, answerLabel, focusIfIdle = false, suggestion, onStop, stopDisabled, stopLabel = 'Stop response' }: {
  draftKey: string;
  onSend: (text: string, images?: ImageUpload[]) => Promise<void>; disabled?: boolean; placeholder: string; footer?: React.ReactNode;
  onStop?: () => Promise<void>; stopDisabled?: boolean; stopLabel?: string;
  suggestion?: { text: string; sequence: number };
  active?: boolean; answerLabel?: string; focusIfIdle?: boolean;
}) {
  const { text, setText, images, setImages, ready, sending } = useComposerDraft(draftKey);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState('');
  const [previewId, setPreviewId] = useState<string>();
  const preview = images.find(image => image.id === previewId);
  const [readingImages, setReadingImages] = useState(false);
  const reading = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const hintId = useId();
  useEffect(() => {
    if (!suggestion || !ready || appliedSuggestions.has(suggestion)) return;
    appliedSuggestions.add(suggestion);
    setText(suggestion.text);
    setError('');
    const frame = requestAnimationFrame(() => { input.current?.focus(); input.current?.setSelectionRange(suggestion.text.length, suggestion.text.length); });
    return () => cancelAnimationFrame(frame);
  }, [suggestion, ready, setText]);
  useEffect(() => {
    if (!active) return;
    const focused = document.activeElement;
    if (focusIfIdle && focused && focused !== document.body) return;
    input.current?.focus({ preventScroll: true });
  }, [active, focusIfIdle]);
  useLayoutEffect(() => {
    const element = input.current;
    if (!element || !active) return;
    const resize = () => {
      element.style.height = '0px';
      element.style.height = `${Math.min(180, Math.max(36, element.scrollHeight))}px`;
      element.style.overflowY = element.scrollHeight > 180 ? 'auto' : 'hidden';
    };
    resize(); let width = element.clientWidth;
    const observer = new ResizeObserver(() => { if (width !== element.clientWidth) { width = element.clientWidth; resize(); } });
    observer.observe(element); return () => observer.disconnect();
  }, [text, active]);
  async function addImages(files: File[]) {
    if (!files.length || !ready || sending || reading.current) return;
    setError('');
    if (images.length + files.length > MAX_IMAGES) { setError(`Attach up to ${MAX_IMAGES} images per message.`); return; }
    reading.current = true; setReadingImages(true);
    try {
      const added = await Promise.all(files.map(async file => {
        if (!(IMAGE_TYPES as readonly string[]).includes(file.type)) throw new Error('Choose PNG, JPEG, WebP, or GIF images.');
        if (!file.size || file.size > MAX_IMAGE_BYTES) throw new Error('Each image must be no larger than 5 MB.');
        const url = await new Promise<string>((resolve,reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error('Could not read the image. Try attaching it again.')); reader.readAsDataURL(file); });
        const preview = new Image(); preview.src = url;
        try { await preview.decode(); } catch { throw new Error('This image could not be opened. Try another image.'); }
        return { id: crypto.randomUUID(), name: file.name || 'Pasted image', mimeType: file.type as ImageUpload['mimeType'], data: url.slice(url.indexOf(',') + 1) };
      }));
      setImages(previous => [...previous,...added]);
    } catch (cause) { setError((cause as Error).message); }
    finally { reading.current = false; setReadingImages(false); }
  }
  async function submit() {
    if (!ready || disabled || sending || reading.current) return;
    const submission = composerDrafts.beginSend(draftKey);
    if (!submission) return;
    setError('');
    try {
      await onSend(submission.content.text.trim(), submission.content.images.map(({ id, ...image }) => image));
      composerDrafts.finishSend(draftKey, submission, true);
    } catch (err) {
      composerDrafts.finishSend(draftKey, submission, false);
      setError((err as Error).message);
    }
    finally {
      if (document.activeElement === document.body || form.current?.contains(document.activeElement)) input.current?.focus({ preventScroll: true });
    }
  }
  return <div className={`composer-wrap ${disabled ? 'composer-unavailable' : ''} ${answerLabel ? 'composer-answer' : ''} ${onStop ? 'composer-stoppable' : ''}`}>
    <form className="composer" ref={form} onDragOver={event => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); }} onDrop={event => { if (!event.dataTransfer.files.length) return; event.preventDefault(); void addImages(Array.from(event.dataTransfer.files)); }} onPaste={event => {
      const files = Array.from(event.clipboardData.files);
      if (!files.length) return;
      event.preventDefault();
      const pastedText = event.clipboardData.getData('text/plain');
      if (pastedText && !sending) { const start = input.current?.selectionStart ?? text.length, end = input.current?.selectionEnd ?? start; setText(previous => previous.slice(0,start) + pastedText + previous.slice(end)); }
      void addImages(files);
    }} onSubmit={event => { event.preventDefault(); void submit(); }}>
      {images.length > 0 && <div className="composer-images" aria-label="Attached images">{images.map(image => <div className="composer-image" key={image.id}><button className="composer-image-preview" type="button" aria-label={`View ${image.name}`} title="View full image" onClick={() => setPreviewId(image.id)}><img src={`data:${image.mimeType};base64,${image.data}`} alt={image.name}/></button><button className="icon-button" type="button" disabled={sending} aria-label={`Remove ${image.name}`} title={`Remove ${image.name}`} onClick={() => { setImages(previous => previous.filter(item => item.id !== image.id)); setError(''); }}><Icon name="close" size={14}/></button></div>)}</div>}
      <input ref={fileInput} type="file" accept={IMAGE_TYPES.join(',')} multiple hidden aria-label="Choose images" onChange={event => { void addImages(Array.from(event.target.files ?? [])); event.target.value = ''; }}/>
      <button type="button" className="icon-button attach-image-button" aria-label="Attach images" title="Attach images, or paste or drop them here" disabled={!ready || sending || readingImages || images.length >= MAX_IMAGES} onClick={() => fileInput.current?.click()}><Icon name="image" size={19}/></button>
      <textarea ref={input} aria-label={answerLabel || (disabled ? 'Draft message — sending unavailable' : 'Message')} aria-describedby={hintId} placeholder={ready ? placeholder : 'Loading draft…'} value={text} rows={1} readOnly={sending || !ready} onChange={event => { setText(event.target.value); setError(''); }} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); void submit(); } }}/>
      {onStop ? <button className="send-button stop-button" type="button" disabled={stopDisabled || stopping} aria-label={stopLabel} title={stopLabel} onClick={async () => {
        if (stopping) return;
        setStopping(true); setError('');
        try { await onStop(); } catch (cause) { setError((cause as Error).message); } finally { setStopping(false); }
      }}>{stopping ? <span className="spinner"/> : <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>}</button> : <button className="send-button" type="submit" disabled={!ready || disabled || sending || readingImages || (!text.trim() && !images.length)} aria-label={answerLabel ? 'Send answer' : 'Send message'} title={disabled ? 'Sending is currently unavailable' : answerLabel ? 'Send answer (Enter)' : 'Send message (Enter)'}><ComposerFire/>{sending || readingImages ? <span className="spinner"/> : <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 19V5m-6 6 6-6 6 6"/></svg>}</button>}
    </form>
    {preview && <ImagePreview src={`data:${preview.mimeType};base64,${preview.data}`} name={preview.name} onClose={() => setPreviewId(undefined)}/>}
    {error && <div className="inline-error composer-error" role="alert"><span>{error}</span><button type="button" className="icon-button" aria-label="Dismiss message error" title="Dismiss" onClick={() => { setError(''); input.current?.focus({ preventScroll: true }); }}><Icon name="close" size={16}/></button></div>}
    <div className="composer-meta" id={hintId}>{footer && <div className="composer-hint">{footer}</div>}<p className={disabled ? 'sr-only' : 'composer-shortcut'}>{disabled ? 'Drafting is available · Sending is paused' : 'Enter to send · Shift + Enter for a new line'}</p></div>
  </div>;
}
