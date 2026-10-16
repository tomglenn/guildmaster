export const MAX_IMAGES = 4;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;
export type ImageMimeType = typeof IMAGE_TYPES[number];
export interface ImageUpload { name: string; mimeType: ImageMimeType; data: string }
export interface ImageAttachment { id: string; name: string; mimeType: ImageMimeType; size: number }
export interface ModelImage { type: 'image'; mimeType: string; data: string }
