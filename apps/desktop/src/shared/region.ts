// Recording region (settings `record.region`): a rectangle of one display, in that display's physical pixels
// (DIP × scaleFactor), picked by dragging on the region overlay. The recorder crops the display stream to it at
// capture time, and the cursor log is normalized to it, so the take's screen file and cursor.jsonl agree.
// Pure helpers shared by main (overlay, cursor log) and the renderer (preview frame, crop).

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** settings `record.region`. x/y/width/height in display pixels, relative to the display's top-left. */
export interface Region extends Rect {
  displayId: string;
}

/** A display as main reports it: bounds in DIP screen coordinates. */
export interface DisplayInfo {
  id: string;
  bounds: Rect;
  scaleFactor: number;
}

/** Smallest region side (display pixels); smaller drags are treated as clicks. */
export const MIN_REGION_PX = 32;

const even = (v: number) => Math.max(0, Math.floor(v / 2) * 2);
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Validates an untrusted `record.region` value (settings file, IPC); null when absent or malformed. */
export function parseRegion(v: unknown): Region | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.displayId !== 'string' || o.displayId === '') return null;
  if (!num(o.x) || !num(o.y) || !num(o.width) || !num(o.height)) return null;
  if (o.x < 0 || o.y < 0 || o.width < MIN_REGION_PX || o.height < MIN_REGION_PX) return null;
  return { displayId: o.displayId, x: Math.round(o.x), y: Math.round(o.y), width: Math.round(o.width), height: Math.round(o.height) };
}

/** Display size in physical pixels. */
export function displayPixels(d: DisplayInfo): { width: number; height: number } {
  const s = d.scaleFactor > 0 ? d.scaleFactor : 1;
  return { width: Math.round(d.bounds.width * s), height: Math.round(d.bounds.height * s) };
}

/** The rectangle spanned by a drag from a to b (any direction), clamped to 0..limit. DIP, display-relative. */
export function dragRect(a: { x: number; y: number }, b: { x: number; y: number }, limit: { width: number; height: number }): Rect {
  const cx = (v: number) => Math.min(Math.max(v, 0), limit.width);
  const cy = (v: number) => Math.min(Math.max(v, 0), limit.height);
  const x1 = cx(Math.min(a.x, b.x));
  const y1 = cy(Math.min(a.y, b.y));
  const x2 = cx(Math.max(a.x, b.x));
  const y2 = cy(Math.max(a.y, b.y));
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

/**
 * A DIP rectangle (display-relative, from the overlay) → region in display pixels. Origin and size are even
 * (4:2:0 encoders need even dimensions) and the result stays inside the display. Null when it is too small.
 */
export function regionFromDip(rect: Rect, d: DisplayInfo): Region | null {
  if (![rect.x, rect.y, rect.width, rect.height].every(num)) return null;
  const s = d.scaleFactor > 0 ? d.scaleFactor : 1;
  const px = displayPixels(d);
  const x = even(Math.min(Math.max(rect.x * s, 0), px.width));
  const y = even(Math.min(Math.max(rect.y * s, 0), px.height));
  const width = even(Math.min(rect.width * s + (rect.x * s - x), px.width - x));
  const height = even(Math.min(rect.height * s + (rect.y * s - y), px.height - y));
  if (width < MIN_REGION_PX || height < MIN_REGION_PX) return null;
  return { displayId: d.id, x, y, width, height };
}

/** The region clipped to its display (a display may have shrunk since it was picked); null when nothing usable is left. */
export function fitRegion(r: Region, d: DisplayInfo): Region | null {
  if (r.displayId !== d.id) return null;
  const px = displayPixels(d);
  const x = even(Math.min(r.x, px.width));
  const y = even(Math.min(r.y, px.height));
  const width = even(Math.min(r.width, px.width - x));
  const height = even(Math.min(r.height, px.height - y));
  if (width < MIN_REGION_PX || height < MIN_REGION_PX) return null;
  return { displayId: r.displayId, x, y, width, height };
}

/** Whether the region is (practically) the whole display, i.e. no crop is needed. */
export function isWholeDisplay(r: Region, d: DisplayInfo): boolean {
  const px = displayPixels(d);
  return r.x <= 1 && r.y <= 1 && r.width >= px.width - 2 && r.height >= px.height - 2;
}

/** Where to crop a captured frame: source rect as fractions of the frame, output size in pixels (even). */
export interface StreamCrop {
  fx: number;
  fy: number;
  fw: number;
  fh: number;
  width: number;
  height: number;
}

/**
 * Crop for a capture stream of the region's display whose frames are streamW × streamH (the stream may be
 * scaled relative to the display's pixels). Null when the region does not apply.
 */
export function streamCrop(r: Region, d: DisplayInfo, streamW: number, streamH: number): StreamCrop | null {
  const fit = fitRegion(r, d);
  if (!fit || !(streamW > 0) || !(streamH > 0)) return null;
  const px = displayPixels(d);
  const fx = fit.x / px.width;
  const fy = fit.y / px.height;
  const fw = fit.width / px.width;
  const fh = fit.height / px.height;
  const width = even(fw * streamW);
  const height = even(fh * streamH);
  if (width < 2 || height < 2) return null;
  return { fx, fy, fw, fh, width, height };
}

/** The region in DIP screen coordinates (what screen.getCursorScreenPoint() reports), for the cursor log. */
export function regionScreenBounds(r: Region, d: DisplayInfo): Rect {
  const s = d.scaleFactor > 0 ? d.scaleFactor : 1;
  return { x: d.bounds.x + r.x / s, y: d.bounds.y + r.y / s, width: r.width / s, height: r.height / s };
}

/** The region as percentages of its display (left/top/width/height), for the frame on the preview. */
export function regionPercent(r: Region, d: DisplayInfo): { left: number; top: number; width: number; height: number } {
  const px = displayPixels(d);
  const p = (v: number, of: number) => Math.round((v / (of || 1)) * 10000) / 100;
  return { left: p(r.x, px.width), top: p(r.y, px.height), width: p(r.width, px.width), height: p(r.height, px.height) };
}
