import type { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { badRequest } from '../../lib/errors';
import { deleteFromBunny, listBunny, uploadToBunny } from '../../lib/bunny';
import { audit } from './shared';

/**
 * Admin → Files & images: upload images and files to the public CDN and copy their links (for emails, the website,
 * announcements…). Stored in the public Bunny zone under `admin-media/`; the listing comes straight from storage.
 * Full admins only (not on the manager allow-list).
 */
const FOLDER = 'admin-media';
const MAX = 25 * 1024 * 1024;
// Things a browser can't run: no HTML, SVG or scripts on our CDN.
const TYPES: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif', ico: 'image/x-icon',
  pdf: 'application/pdf', mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  csv: 'text/csv', txt: 'text/plain', zip: 'application/zip',
};
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX, files: 10 } });
const extOf = (name: string) => name.split('.').pop()?.toLowerCase() ?? '';
/** Stored as "<uuid>-<name>": show the name without the id. */
const displayName = (stored: string) => stored.replace(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-/i, '');
const kindOf = (name: string) => { const t = TYPES[extOf(name)] ?? ''; return t.startsWith('image') ? 'image' : t.startsWith('video') ? 'video' : t.startsWith('audio') ? 'audio' : 'file'; };

export function mountMedia(r: Router) {
  r.get('/media', async (_req, res) => {
    const files = (await listBunny(FOLDER)).filter((f) => !f.isDirectory)
      .map((f) => ({ ...f, name: displayName(f.name), kind: kindOf(f.name), ext: extOf(f.name) }));
    res.json({ files, totalBytes: files.reduce((t, f) => t + f.size, 0), maxBytes: MAX, accepted: Object.keys(TYPES) });
  });

  r.post('/media', upload.array('files', 10), async (req, res) => {
    const files = (req.files as Express.Multer.File[]) ?? [];
    if (!files.length) throw badRequest('Choose at least one file');
    for (const f of files) if (!TYPES[extOf(f.originalname)]) throw badRequest(`${f.originalname}: this file type isn't allowed (allowed: ${Object.keys(TYPES).join(', ')})`, 'BAD_FILE_TYPE');
    const out = await Promise.all(files.map(async (f) => {
      const { url, path } = await uploadToBunny(f.buffer, FOLDER, f.originalname, false, TYPES[extOf(f.originalname)]);
      return { name: f.originalname, url, path, size: f.size, kind: kindOf(f.originalname), ext: extOf(f.originalname), createdAt: new Date().toISOString() };
    }));
    await audit(req, 'media.upload', 'media', null, { files: out.map((f) => ({ name: f.name, url: f.url, size: f.size })) });
    res.status(201).json({ files: out });
  });

  r.delete('/media', async (req, res) => {
    const { path } = z.object({ path: z.string().regex(/^admin-media\/[^/]+$/, 'Not an admin upload') }).parse(req.query);
    await deleteFromBunny(path);
    await audit(req, 'media.delete', 'media', null, { path });
    res.status(204).end();
  });
}
