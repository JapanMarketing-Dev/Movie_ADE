// solocut.app: reveal on scroll, hero animation, and the download page.
// Downloads come from R2 (DOWNLOAD_BASE). Until the first release, latest.json does not exist and the page says so.
export const DOWNLOAD_BASE = 'https://downloads.solocut.app/';

const root = document.documentElement;
root.classList.remove('no-js');
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

// Reveal sections as they scroll in.
const reveals = document.querySelectorAll('.reveal');
if (reduced || !('IntersectionObserver' in window)) {
  reveals.forEach((el) => el.classList.add('in'));
} else {
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
  }, { rootMargin: '0px 0px -8% 0px' });
  reveals.forEach((el) => io.observe(el));
}

// Hero: words light up like a TikTok caption, terminal lines appear one by one, cut segments fold away.
function hero() {
  const cap = document.querySelector('[data-cap]');
  const term = document.querySelector('[data-term]');
  if (!cap || !term || reduced) return;
  const words = [...cap.querySelectorAll('span')];
  let w = 0;
  setInterval(() => { words.forEach((s, i) => s.classList.toggle('on', i === w)); w = (w + 1) % (words.length + 1); }, 420);

  const lines = [...term.children];
  const cuts = [...document.querySelectorAll('[data-cut]')];
  const caret = document.createElement('span');
  caret.className = 'caret';
  const run = () => {
    lines.forEach((l) => { l.hidden = true; });
    cuts.forEach((c) => c.classList.remove('gone'));
    let i = 0;
    const step = () => {
      if (i < lines.length) {
        lines[i].hidden = false;
        lines[i].append(caret);
        if (lines[i].textContent.includes('19')) cuts.forEach((c) => c.classList.add('gone'));
        i += 1;
        setTimeout(step, lines[i - 1].textContent.startsWith('$') ? 900 : 550);
      } else {
        setTimeout(run, 4200);
      }
    };
    step();
  };
  run();
}
hero();

// Download page.
const OS_OF = () => {
  const p = (navigator.userAgentData?.platform || navigator.platform || navigator.userAgent).toLowerCase();
  if (p.includes('mac')) return 'mac';
  if (p.includes('win')) return 'win';
  if (p.includes('linux') || p.includes('x11')) return 'linux';
  return null;
};

async function downloads() {
  const main = document.querySelector('[data-dl-labels]');
  if (!main) return;
  const labels = JSON.parse(main.dataset.dlLabels);
  const os = OS_OF();
  const mine = os && document.querySelector(`.dl-card[data-os="${os}"]`);
  if (mine) { mine.classList.add('is-you'); mine.querySelector('.you').hidden = false; }

  let latest;
  try {
    const res = await fetch(new URL('latest.json', DOWNLOAD_BASE), { cache: 'no-store' });
    if (!res.ok) return;
    latest = await res.json();
  } catch { return; }
  if (!latest || !Array.isArray(latest.files)) return;

  const notice = document.querySelector('[data-dl-notice]');
  const lang = document.body.dataset.lang;
  if (notice) notice.textContent = lang === 'ja' ? `最新版 ${latest.version}（${latest.date}）` : `Latest version ${latest.version} (${latest.date}).`;
  for (const btn of document.querySelectorAll('[data-dl]')) {
    // Prefer the installer for the visitor's CPU; fall back to the first installer for that OS.
    const files = latest.files.filter((f) => f.os === btn.dataset.dl && f.kind === 'installer');
    if (!files.length) continue;
    const f = files.find((x) => x.arch === 'arm64' && /arm|aarch/i.test(navigator.userAgent)) || files[0];
    btn.href = new URL(f.path, DOWNLOAD_BASE).href;
    btn.removeAttribute('aria-disabled');
    btn.querySelector('[data-dl-label]').textContent = labels.get;
  }
}
downloads();
