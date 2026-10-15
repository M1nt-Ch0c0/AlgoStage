/**
 * Narrow ask drawer: pick how to bring the selection marker into view.
 * A marker taller than the space above the drawer aligns to the start so
 * its top stays reachable. Otherwise "nearest" keeps it visible and does
 * not scroll when it already is.
 */
export function chooseAskScrollBlock(
  markerHeight: number,
  availableHeight: number,
): ScrollLogicalPosition {
  return markerHeight > availableHeight ? "start" : "nearest";
}
