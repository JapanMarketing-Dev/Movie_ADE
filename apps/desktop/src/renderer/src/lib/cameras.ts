// Camera selection on the Record screen: several cameras can be recorded at once; one of them is「メイン（自分）」,
// the camera that shows the person. It is recorded first (camera-1) and marked role 'main' in take.json, so the
// edit pipeline frames the person from it.

/** The main camera among the selected ones: the chosen one when still selected, else the first selected. */
export function mainCamera(selected: readonly string[], mainId: string | null | undefined): string | null {
  if (mainId && selected.includes(mainId)) return mainId;
  return selected[0] ?? null;
}

/** Selected cameras in recording order: main first, the rest in selection order, duplicates removed. */
export function recordingOrder(selected: readonly string[], mainId: string | null | undefined): string[] {
  const uniq = [...new Set(selected)];
  const main = mainCamera(uniq, mainId);
  return main ? [main, ...uniq.filter((x) => x !== main)] : uniq;
}

/** Toggles a camera in the selection (keeps order). */
export function toggleCamera(selected: readonly string[], id: string): string[] {
  return selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id];
}

/** Drops cameras that were unplugged; available = the deviceIds enumerateDevices() reports now. */
export function keepAvailable(selected: readonly string[], available: readonly string[]): string[] {
  const set = new Set(available);
  return selected.filter((x) => set.has(x));
}
