/** `?lab=1` keeps the off-path experiments reachable (Canvas, games, Inspect, filters, the old menu). */
export function labEnabled(search: string = typeof location === 'undefined' ? '' : location.search): boolean {
  return new URLSearchParams(search).get('lab') === '1';
}
