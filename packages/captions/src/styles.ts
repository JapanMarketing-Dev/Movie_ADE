import type { Caption } from '@solocut/core';

export interface CaptionStyle {
  id: string;
  label: { ja: string; en: string };
  font: string;
  /** Font size as a fraction of the canvas short side. */
  size: number;
  bold: boolean;
  /** Font weight (100–900) applied with \b<weight>; overrides `bold` when set (Noto Sans JP ships 400/700/900). */
  weight?: number;
  /** Text color (#RRGGBB or #RRGGBBAA). With karaoke: the not-yet-spoken color. */
  color: string;
  /** Karaoke: color of spoken words. */
  highlight: string;
  outline: string;
  /** Outline width as a fraction of the font size. */
  outlineWidth: number;
  /** Shadow depth as a fraction of the font size. */
  shadow: number;
  /** Opaque box behind the text (ASS BorderStyle 3) in this color. */
  box?: string;
  /** Word-by-word highlight with ASS \k. */
  karaoke: boolean;
  emphasis: { color: string; scale: number; box: string };
  position: Caption['position'];
  maxCharsPerLine: { ja: number; en: number };
  maxLines: number;
  /** Letter spacing in pixels at 1080 short side. */
  spacing?: number;
}

/** Built-in caption styles. Fonts are OFL fonts bundled with the app (docs/06). */
export const CAPTION_STYLES: Record<string, CaptionStyle> = {
  'tiktok-bold': {
    id: 'tiktok-bold',
    label: { ja: 'ショート向け（太字・黄色ハイライト）', en: 'Shorts bold (yellow highlight)' },
    font: 'Noto Sans JP',
    size: 0.075,
    bold: true,
    weight: 900,
    color: '#FFFFFF',
    highlight: '#FFE600',
    outline: '#000000',
    outlineWidth: 0.14,
    shadow: 0.04,
    karaoke: true,
    emphasis: { color: '#FF3B30', scale: 1.2, box: '#FFE600' },
    position: { anchor: 'bottom', y: 0.7 },
    maxCharsPerLine: { ja: 11, en: 20 },
    maxLines: 2,
  },
  'youtube-clean': {
    id: 'youtube-clean',
    label: { ja: 'YouTube 標準（白・細い縁）', en: 'YouTube clean' },
    font: 'Noto Sans JP',
    size: 0.05,
    bold: true,
    weight: 700,
    color: '#FFFFFF',
    highlight: '#FFFFFF',
    outline: '#000000',
    outlineWidth: 0.08,
    shadow: 0.03,
    karaoke: false,
    emphasis: { color: '#FFD60A', scale: 1.1, box: '#FFD60A' },
    position: { anchor: 'bottom', y: 0.92 },
    maxCharsPerLine: { ja: 22, en: 40 },
    maxLines: 2,
  },
  boxed: {
    id: 'boxed',
    label: { ja: '帯付き（読みやすさ優先）', en: 'Boxed' },
    font: 'Noto Sans JP',
    size: 0.05,
    bold: false,
    color: '#FFFFFF',
    highlight: '#FFFFFF',
    outline: '#000000',
    outlineWidth: 0.25,
    shadow: 0,
    box: '#000000B0',
    karaoke: false,
    emphasis: { color: '#4CD964', scale: 1.1, box: '#4CD964' },
    position: { anchor: 'bottom', y: 0.9 },
    maxCharsPerLine: { ja: 20, en: 38 },
    maxLines: 2,
  },
};
