/**
 * Video tour links on listings (YouTube, Vimeo, TikTok, Instagram, Facebook, Loom, Dailymotion, Streamable).
 * Only these hosts are accepted, so we never fetch or embed arbitrary URLs. Keep in sync with app/src/lib/videoLinks.ts.
 */
export type VideoProvider = 'youtube' | 'vimeo' | 'tiktok' | 'instagram' | 'facebook' | 'loom' | 'dailymotion' | 'streamable';
export type VideoLink = { provider: VideoProvider; id: string | null; url: string; embedUrl: string | null; thumbnail: string | null };
export const PROVIDER_NAMES: Record<VideoProvider, string> = {
  youtube: 'YouTube', vimeo: 'Vimeo', tiktok: 'TikTok', instagram: 'Instagram', facebook: 'Facebook', loom: 'Loom', dailymotion: 'Dailymotion', streamable: 'Streamable',
};

export function parseVideoLink(raw: string): VideoLink | null {
  let u: URL;
  try { u = new URL(raw.trim().replace(/^(?!https?:\/\/)/i, 'https://')); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const host = u.hostname.toLowerCase().replace(/^(www|m|mobile)\./, '');
  const seg = u.pathname.split('/').filter(Boolean);
  const ok = (provider: VideoProvider, id: string | null, url: string, embedUrl: string | null, thumbnail: string | null = null): VideoLink => ({ provider, id, url, embedUrl, thumbnail });

  if (host === 'youtube.com' || host === 'youtu.be' || host === 'youtube-nocookie.com' || host === 'music.youtube.com') {
    let id: string | null = null;
    if (host === 'youtu.be') id = seg[0] ?? null;
    else if (seg[0] === 'watch') id = u.searchParams.get('v');
    else if (['shorts', 'embed', 'live', 'v'].includes(seg[0])) id = seg[1] ?? null;
    if (!id || !/^[\w-]{11}$/.test(id)) return null;
    return ok('youtube', id, `https://www.youtube.com/watch?v=${id}`, `https://www.youtube-nocookie.com/embed/${id}?playsinline=1&rel=0`, `https://i.ytimg.com/vi/${id}/hqdefault.jpg`);
  }
  if (host === 'vimeo.com' || host === 'player.vimeo.com') {
    const id = seg.find((s) => /^\d{5,}$/.test(s));
    return id ? ok('vimeo', id, `https://vimeo.com/${id}`, `https://player.vimeo.com/video/${id}`) : null;
  }
  if (host === 'tiktok.com' || host === 'vm.tiktok.com' || host === 'vt.tiktok.com') {
    const i = seg.indexOf('video');
    const id = i >= 0 && /^\d+$/.test(seg[i + 1] ?? '') ? seg[i + 1] : null;
    if (id) return ok('tiktok', id, `https://www.tiktok.com/${seg.slice(0, i + 2).join('/')}`, `https://www.tiktok.com/embed/v2/${id}`);
    return host !== 'tiktok.com' && seg[0] ? ok('tiktok', null, `https://${host}/${seg[0]}/`, null) : null; // short link: open in TikTok
  }
  if (host === 'instagram.com') {
    if (!['reel', 'reels', 'p', 'tv'].includes(seg[0]) || !seg[1]) return null;
    const kind = seg[0] === 'reels' ? 'reel' : seg[0];
    return ok('instagram', seg[1], `https://www.instagram.com/${kind}/${seg[1]}/`, `https://www.instagram.com/${kind}/${seg[1]}/embed`);
  }
  if (host === 'facebook.com' || host === 'fb.watch' || host === 'web.facebook.com') {
    const isVideo = host === 'fb.watch' || seg.includes('videos') || seg[0] === 'watch' || seg[0] === 'reel' || seg[0] === 'share';
    if (!isVideo) return null;
    const url = `https://${host === 'web.facebook.com' ? 'www.facebook.com' : host === 'facebook.com' ? 'www.facebook.com' : host}${u.pathname}${u.search}`;
    return ok('facebook', null, url, `https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(url)}&show_text=false`);
  }
  if (host === 'loom.com') {
    const id = (seg[0] === 'share' || seg[0] === 'embed') && /^[\da-f]{32}$/i.test(seg[1] ?? '') ? seg[1] : null;
    return id ? ok('loom', id, `https://www.loom.com/share/${id}`, `https://www.loom.com/embed/${id}`) : null;
  }
  if (host === 'dailymotion.com' || host === 'dai.ly') {
    const id = host === 'dai.ly' ? seg[0] : seg[0] === 'video' ? seg[1] : null;
    return id && /^[\w]+$/.test(id) ? ok('dailymotion', id, `https://www.dailymotion.com/video/${id}`, `https://www.dailymotion.com/embed/video/${id}`, `https://www.dailymotion.com/thumbnail/video/${id}`) : null;
  }
  if (host === 'streamable.com') {
    const id = seg[0] === 'e' ? seg[1] : seg[0];
    return id && /^\w+$/.test(id) ? ok('streamable', id, `https://streamable.com/${id}`, `https://streamable.com/e/${id}`) : null;
  }
  return null;
}

// ── Preview (title + thumbnail) via each host's public oEmbed endpoint, cached in memory ──
const OEMBED: Partial<Record<VideoProvider, (url: string) => string>> = {
  youtube: (url) => `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`,
  vimeo: (url) => `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(url)}`,
  tiktok: (url) => `https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`,
  loom: (url) => `https://www.loom.com/v1/oembed?url=${encodeURIComponent(url)}`,
  dailymotion: (url) => `https://www.dailymotion.com/services/oembed?format=json&url=${encodeURIComponent(url)}`,
  streamable: (url) => `https://api.streamable.com/oembed.json?url=${encodeURIComponent(url)}`,
};
export type VideoPreview = VideoLink & { providerName: string; title: string | null; author: string | null };
const cache = new Map<string, { at: number; value: VideoPreview }>();
const TTL = 12 * 3600_000;

export async function videoPreview(raw: string): Promise<VideoPreview | null> {
  const link = parseVideoLink(raw);
  if (!link) return null;
  const hit = cache.get(link.url);
  if (hit && Date.now() - hit.at < TTL) return hit.value;
  const value: VideoPreview = { ...link, providerName: PROVIDER_NAMES[link.provider], title: null, author: null };
  const endpoint = OEMBED[link.provider];
  if (endpoint) {
    try {
      const res = await fetch(endpoint(link.url), { signal: AbortSignal.timeout(5000), headers: { Accept: 'application/json' } });
      if (res.ok) {
        const j: any = await res.json();
        value.title = typeof j.title === 'string' ? j.title.slice(0, 200) : null;
        value.author = typeof j.author_name === 'string' ? j.author_name.slice(0, 100) : null;
        if (!value.thumbnail && typeof j.thumbnail_url === 'string' && /^https:\/\//.test(j.thumbnail_url)) value.thumbnail = j.thumbnail_url;
      }
    } catch { /* preview without a title */ }
  }
  if (cache.size > 2000) cache.delete(cache.keys().next().value!);
  cache.set(link.url, { at: Date.now(), value });
  return value;
}
