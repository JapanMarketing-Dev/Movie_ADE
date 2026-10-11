// Folder names of new videos in the master folder: `<YYYY-MM-DD>-<slug or HHMM>`. Pure (main creates the folder,
// Home shows the name it will get).

export const SLUG_MAX = 40;

/** A title as a folder-name part: keeps Japanese, drops characters no file system accepts, spaces → '-'. May be ''. */
export function folderSlug(title: string, max = SLUG_MAX): string {
  const clean = (s: string) => s.replace(/-{2,}/g, '-').replace(/^[-.\s]+|[-.\s]+$/g, '');
  const s = clean(
    title
      .normalize('NFKC')
      .replace(/[\\/:*?"<>|\x00-\x1f\x7f]/g, ' ')
      .trim()
      .replace(/\s+/g, '-'),
  );
  // cut by code points so a surrogate pair (emoji) is never split
  return clean(Array.from(s).slice(0, max).join(''));
}

const pad = (n: number) => String(n).padStart(2, '0');

/** `<YYYY-MM-DD>-<slug>`, or `<YYYY-MM-DD>-<HHMM>` without a usable title (local time). */
export function videoFolderName(title: string, now: Date = new Date()): string {
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  return `${date}-${folderSlug(title) || `${pad(now.getHours())}${pad(now.getMinutes())}`}`;
}
