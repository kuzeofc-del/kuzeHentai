/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Episode } from '../types';

/**
 * Extracts the playback URL from any episode object (supporting legacy fields when reading old backups)
 */
export function getEpisodeUrl(ep: any): string {
  if (!ep) return '';
  if (typeof ep === 'string') return ep.trim();
  return String(
    ep.mp4Url || ep.telegramUrl || ep.url || ep.videoUrl || ep.link || ep.embedUrl || ep.streamUrl || ''
  ).trim();
}

/**
 * Produces a clean Episode object for Firestore/storage containing ONLY mp4Url (no duplicate URL keys)
 */
export function cleanEpisodeForStorage(ep: any, fallbackIndex = 0): Episode {
  const number = Number(ep?.number || ep?.epNumber || ep?.episode || ep?.cap || (fallbackIndex + 1)) || (fallbackIndex + 1);
  const mp4Url = getEpisodeUrl(ep);
  const epTitle = ep?.title || ep?.name || undefined;
  const epCover = ep?.coverImage || ep?.image || ep?.cover || undefined;
  const epThumb = ep?.thumbnail || ep?.thumb || epCover || undefined;

  const clean: Episode = {
    number,
    mp4Url,
    isNew: Boolean(ep?.isNew),
  };

  if (epTitle) clean.title = String(epTitle);
  if (epCover) clean.coverImage = String(epCover);
  if (epThumb) clean.thumbnail = String(epThumb);
  if (ep?.addedToRecentAt) clean.addedToRecentAt = String(ep.addedToRecentAt);
  if (typeof ep?.orderIndex === 'number') clean.orderIndex = ep.orderIndex;

  return clean;
}

/**
 * Normalizes any episode data structure (Array or Firestore Object Map) into a clean, typed Episode[] array
 * containing solely mp4Url as the video link field.
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
          });
        }
      } else if (typeof ep === 'object') {
        result.push(cleanEpisodeForStorage(ep, idx));
      }
    });
  } else if (typeof eps === 'object') {
    Object.keys(eps).forEach((key, idx) => {
      const val = eps[key];
      if (!val) return;
      const number = (typeof val === 'object' && val && (Number(val.number) || Number(val.epNumber)))
        ? (Number(val.number) || Number(val.epNumber))
        : (Number(key) || idx + 1);

      if (typeof val === 'string') {
        const link = val.trim();
        if (link) {
          result.push({
            number,
            mp4Url: link,
            isNew: false,
          });
        }
      } else if (typeof val === 'object') {
        result.push(cleanEpisodeForStorage({ ...val, number }, idx));
      }
    });
  }

  return result.sort((a, b) => a.number - b.number);
}
