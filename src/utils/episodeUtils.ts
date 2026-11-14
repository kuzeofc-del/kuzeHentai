/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Episode } from '../types';

/**
 * Normalizes any episode data structure (Array or Firestore Object Map) into a clean, typed Episode[] array
 */
export function normalizeEpisodesList(eps: any): Episode[] {
  if (!eps) return [];

  // If episodes is serialized as a JSON string (e.g. from database.json or Firestore), parse it safely
  if (typeof eps === 'string') {
    const trimmed = eps.trim();
    if ((trimmed.startsWith('[') && trimmed.endsWith(']')) || (trimmed.startsWith('{') && trimmed.endsWith('}'))) {
      try {
        eps = JSON.parse(trimmed);
      } catch {
        eps = trimmed ? [trimmed] : [];
      }
    } else if (trimmed) {
      eps = [trimmed];
    } else {
      return [];
    }
  }

  const result: Episode[] = [];

  if (Array.isArray(eps)) {
    eps.forEach((ep, idx) => {
      if (!ep) return;
      if (typeof ep === 'string') {
        const link = ep.trim();
        if (link) {
          result.push({
            number: idx + 1,
            mp4Url: link,
            telegramUrl: link,
            url: link,
            videoUrl: link,
            link: link
          });
        }
      } else if (typeof ep === 'object') {
        const number = Number(ep.number || ep.epNumber || ep.episode || ep.cap || (idx + 1)) || (idx + 1);
        const link = String(
          ep.mp4Url || ep.telegramUrl || ep.url || ep.videoUrl || ep.link || ep.embedUrl || ep.streamUrl || ''
        ).trim();
        const epTitle = ep.title || ep.name || undefined;
        const epCover = ep.coverImage || ep.image || ep.cover || undefined;
        const epThumb = ep.thumbnail || ep.thumb || epCover || undefined;
        result.push({
          number,
          mp4Url: link,
          telegramUrl: link,
          url: link,
          videoUrl: link,
          link: link,
          isNew: Boolean(ep.isNew),
          ...(epTitle ? { title: String(epTitle) } : {}),
          ...(epCover ? { coverImage: String(epCover) } : {}),
          ...(epThumb ? { thumbnail: String(epThumb) } : {}),
          ...(ep.addedToRecentAt ? { addedToRecentAt: String(ep.addedToRecentAt) } : {})
        });
      }
    });
  } else if (typeof eps === 'object') {
    Object.keys(eps).forEach(key => {
      const val = eps[key];
      const number = (typeof val === 'object' && val && (Number(val.number) || Number(val.epNumber))) ? (Number(val.number) || Number(val.epNumber)) : (Number(key) || 1);
      let link = '';
      let title = '';
      let isNew = false;
      let coverImage: string | undefined = undefined;
      let thumbnail: string | undefined = undefined;
      let addedToRecentAt: string | undefined = undefined;

      if (typeof val === 'string') {
        link = val.trim();
      } else if (typeof val === 'object') {
        link = String(val.mp4Url || val.telegramUrl || val.url || val.videoUrl || val.link || '').trim();
        if (val.title) title = String(val.title);
        if (val.name) title = String(val.name);
        if (val.isNew) isNew = true;
        if (val.coverImage || val.image || val.cover) coverImage = String(val.coverImage || val.image || val.cover);
        if (val.thumbnail || val.thumb || coverImage) thumbnail = String(val.thumbnail || val.thumb || coverImage);
        if (val.addedToRecentAt) addedToRecentAt = String(val.addedToRecentAt);
      }

      result.push({
        number,
        mp4Url: link,
        telegramUrl: link,
        url: link,
        videoUrl: link,
        link: link,
        isNew: Boolean(isNew),
        ...(title ? { title } : {}),
        ...(coverImage ? { coverImage } : {}),
        ...(thumbnail ? { thumbnail } : {}),
        ...(addedToRecentAt ? { addedToRecentAt } : {})
      });
    });
  }

  return result.sort((a, b) => a.number - b.number);
}
