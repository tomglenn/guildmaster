import { AppError } from '../domain/types.ts';
import { IMAGE_TYPES, MAX_IMAGES, MAX_IMAGE_BYTES, type ImageUpload } from '../domain/images.ts';

export function validateImages(value: unknown): ImageUpload[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_IMAGES) throw new AppError(`Attach up to ${MAX_IMAGES} images per message.`);
  return value.map(image => {
    if (!image || !IMAGE_TYPES.includes(image.mimeType) || typeof image.data !== 'string' || !image.data.length || image.data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || image.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data)) throw new AppError('Attach PNG, JPEG, WebP, or GIF images up to 5 MB each.');
    const bytes = Buffer.from(image.data, 'base64');
    const valid = image.mimeType === 'image/png' ? bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
      : image.mimeType === 'image/jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      : image.mimeType === 'image/webp' ? bytes.toString('ascii',0,4) === 'RIFF' && bytes.toString('ascii',8,12) === 'WEBP'
      : ['GIF87a','GIF89a'].includes(bytes.toString('ascii',0,6));
    if (!valid || bytes.length > MAX_IMAGE_BYTES || bytes.toString('base64') !== image.data) throw new AppError('The image format or size is invalid. Attach PNG, JPEG, WebP, or GIF images up to 5 MB each.');
    return { mimeType: image.mimeType, data: image.data, name: typeof image.name === 'string' && image.name.trim() ? image.name.trim().slice(0,200) : 'Image' };
  });
}

export function imageMessage(value: unknown, images: ImageUpload[], label = 'Message') {
  if ((value === undefined || value === '') && images.length) return 'Please review the attached image' + (images.length > 1 ? 's.' : '.');
  if (typeof value !== 'string' || !value.trim() || value.length > 40000) throw new AppError(`${label} must contain 1–40000 characters.`);
  return value.trim();
}
