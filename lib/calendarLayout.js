/**
 * lib/calendarLayout.js — Pure layout helpers for timed calendar events.
 * Kept separate from CalDAV/ICS parsing so client components stay light.
 */

/**
 * Layout overlapping timed events into columns.
 * @param {Array<{ startAt: string|Date, endAt: string|Date, allDay?: boolean }>} events
 * @returns {Array<{ event: any, column: number, columnCount: number }>}
 */
export function layoutOverlappingEvents(events) {
  const timed = events
    .filter((e) => !e.allDay)
    .map((e) => ({
      event: e,
      start: new Date(e.startAt).getTime(),
      end: new Date(e.endAt).getTime(),
    }))
    .filter(
      (e) => Number.isFinite(e.start) && Number.isFinite(e.end) && e.end > e.start,
    )
    .sort((a, b) => a.start - b.start || a.end - b.end);

  /** @type {Array<{ end: number }>} */
  const columns = [];
  /** @type {Array<{ event: any, column: number, start: number, end: number }>} */
  const placed = [];

  for (const item of timed) {
    let column = columns.findIndex((col) => col.end <= item.start);
    if (column === -1) {
      column = columns.length;
      columns.push({ end: item.end });
    } else {
      columns[column].end = item.end;
    }
    placed.push({ ...item, column });
  }

  const results = [];
  let cluster = [];
  let clusterEnd = -Infinity;

  const flush = () => {
    if (!cluster.length) return;
    const columnCount = Math.max(...cluster.map((c) => c.column)) + 1;
    for (const item of cluster) {
      results.push({
        event: item.event,
        column: item.column,
        columnCount,
      });
    }
    cluster = [];
    clusterEnd = -Infinity;
  };

  for (const item of placed) {
    if (cluster.length && item.start >= clusterEnd) flush();
    cluster.push(item);
    clusterEnd = Math.max(clusterEnd, item.end);
  }
  flush();

  return results;
}
