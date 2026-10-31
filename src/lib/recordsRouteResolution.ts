import { Lecture, RecordItem } from '../types';
import { subjectSlugOf } from './subjectDisplay';

export interface RouteResolution {
  currentTab: string;
  sanitizedPath: string;
  sanitizedSearch: string;
  openedLectureId?: string | null;
  highlightedRecordId?: string | null;
  redirected: boolean;
}

/**
 * Parses pathname and search parameters for legacy records routes.
 */
export function parseRecordsRoute(
  pathname: string,
  search: string
): { isLegacyRecordRoute: boolean; recordId: string | null; cleanPath: string; cleanSearch: string } {
  const normPath = pathname.replace(/\/+$/, '') || '/';
  const searchParams = new URLSearchParams(search);

  const isRecordsTab = searchParams.get('tab') === 'records' || searchParams.get('tab') === 'recordings';
  const isRecordsPath = normPath === '/records';
  const isRecordsSubpath = /^\/records?\/([^\/?#]+)/i.test(normPath);

  let recordId: string | null = null;
  if (searchParams.has('recordId')) {
    recordId = searchParams.get('recordId');
  } else if (searchParams.has('record')) {
    recordId = searchParams.get('record');
  } else if (isRecordsSubpath) {
    const match = normPath.match(/^\/records?\/([^\/?#]+)/i);
    if (match) recordId = decodeURIComponent(match[1]);
  }

  const isLegacyRecordRoute = isRecordsTab || isRecordsPath || isRecordsSubpath || Boolean(recordId);

  // Sanitize path: /records or /records/:id becomes /
  let cleanPath = pathname;
  if (isRecordsPath || isRecordsSubpath) {
    cleanPath = '/';
  }

  // Sanitize search: delete tab=records, recordId, record
  const cleanParams = new URLSearchParams(search);
  if (isRecordsTab) {
    cleanParams.delete('tab');
  }
  cleanParams.delete('recordId');
  cleanParams.delete('record');

  const cleanSearch = cleanParams.toString() ? `?${cleanParams.toString()}` : '';

  return {
    isLegacyRecordRoute,
    recordId,
    cleanPath,
    cleanSearch,
  };
}

/**
 * Evaluates a route for legacy records redirection, sanitizing the URL and resolving
 * the matching lecture to open in the attachments view.
 */
export function resolveRecordsRoute(
  pathname: string,
  search: string,
  lectures: Lecture[] = [],
  records: RecordItem[] = []
): RouteResolution {
  const parsed = parseRecordsRoute(pathname, search);

  if (!parsed.isLegacyRecordRoute) {
    return {
      currentTab: 'home',
      sanitizedPath: pathname,
      sanitizedSearch: search,
      openedLectureId: null,
      highlightedRecordId: null,
      redirected: false,
    };
  }

  let openedLectureId: string | null = null;

  if (parsed.recordId) {
    // 1. Check if the record is present in loaded records
    const record = records.find((r) => r.id === parsed.recordId);
    if (record) {
      if (record.lectureId) {
        openedLectureId = record.lectureId;
      } else {
        const matched = lectures.find((l) => {
          const stageMatches = !record.stageId || !l.stageId || record.stageId === l.stageId;
          const subjectMatches =
            (record.subjectId && l.subjectId && record.subjectId === l.subjectId) ||
            (record.category && l.category && record.category === l.category) ||
            (subjectSlugOf(record) && subjectSlugOf(l) && subjectSlugOf(record) === subjectSlugOf(l));
          const typeMatches = !record.type || !l.type || record.type === l.type;
          const numMatches =
            record.number != null && l.number != null && Number(record.number) === Number(l.number);
          return stageMatches && subjectMatches && typeMatches && numMatches;
        });
        if (matched) {
          openedLectureId = matched.id;
        }
      }
    } else {
      // Direct lookup: if ID happens to match a lecture ID directly
      const directLec = lectures.find((l) => l.id === parsed.recordId);
      if (directLec) {
        openedLectureId = directLec.id;
      }
    }
  }

  return {
    currentTab: 'lectures',
    sanitizedPath: parsed.cleanPath,
    sanitizedSearch: parsed.cleanSearch,
    openedLectureId,
    highlightedRecordId: parsed.recordId,
    redirected: true,
  };
}
