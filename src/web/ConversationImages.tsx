import React, { useState } from 'react';
import type { ImageAttachment } from '../domain/images';
import ImagePreview from './ImagePreview';

export function imageConceptLabel(image: ImageAttachment): string | undefined {
  if (image.conceptIndex === undefined && !image.rootImageId && !image.parentImageId && image.mock !== true) return undefined;
  return `${image.mock ? 'Mock placeholder' : 'Generated concept'}${image.conceptIndex === undefined ? '' : ` ${image.conceptIndex}`}${image.version === undefined ? '' : ` · v${image.version}`}`;
}

export default function ConversationImages({ questId, images }: { questId: string; images: ImageAttachment[] }) {
  const [selected, setSelected] = useState<ImageAttachment>();
  const url = (image: ImageAttachment) => `/api/quests/${encodeURIComponent(questId)}/images/${encodeURIComponent(image.id)}`;
  return <><div className="message-images">{images.map(image => {
    const label = imageConceptLabel(image);
    return <div className="message-image-item" key={image.id}>
      <button className="message-image" type="button" aria-label={`View ${label ? `${label}: ` : ''}${image.name}`} title={label ? `${label} — ${image.name}` : 'View full image'} onClick={() => setSelected(image)}><img src={url(image)} alt={image.name} loading="lazy"/></button>
      {label && <small className="message-image-label">{label}</small>}
    </div>;
  })}</div>{selected && <ImagePreview src={url(selected)} name={selected.name} onClose={() => setSelected(undefined)}/>}</>;
}
