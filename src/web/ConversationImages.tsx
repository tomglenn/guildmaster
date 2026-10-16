import React, { useState } from 'react';
import type { ImageAttachment } from '../domain/images';
import ImagePreview from './ImagePreview';

export default function ConversationImages({ questId, images }: { questId: string; images: ImageAttachment[] }) {
  const [selected, setSelected] = useState<ImageAttachment>();
  const url = (image: ImageAttachment) => `/api/quests/${encodeURIComponent(questId)}/images/${encodeURIComponent(image.id)}`;
  return <><div className="message-images">{images.map(image => <button className="message-image" key={image.id} type="button" aria-label={`View ${image.name}`} title="View full image" onClick={() => setSelected(image)}><img src={url(image)} alt={image.name} loading="lazy"/></button>)}</div>{selected && <ImagePreview src={url(selected)} name={selected.name} onClose={() => setSelected(undefined)}/>}</>;
}
