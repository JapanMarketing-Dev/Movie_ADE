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
  const LABEL = {
    mac: { arm64: lang === 'ja' ? 'Apple シリコン' : 'Apple silicon', x64: 'Intel' },
    win: { x64: 'x64', arm64: 'ARM64' },
    linux: { AppImage: 'AppImage', deb: '.deb' },
  };
  const isArm = /arm|aarch/i.test(navigator.userAgent) || (navigator.userAgentData?.architecture === 'arm');
  for (const btn of document.querySelectorAll('[data-dl]')) {
    const os = btn.dataset.dl;
    const files = latest.files.filter((f) => f.os === os && f.kind === 'installer');
    if (!files.length) continue;
    // Mac browsers report "Intel" even on Apple silicon, so default to arm64 on mac and show Intel as the alternative.
    const primary = os === 'mac' ? (files.find((f) => f.arch === 'arm64') || files[0])
      : os === 'win' ? (files.find((f) => f.arch === (isArm ? 'arm64' : 'x64')) || files[0])
      : (files.find((f) => f.name.endsWith('.AppImage')) || files[0]);
    const label = (f) => os === 'linux' ? LABEL.linux[f.name.endsWith('.deb') ? 'deb' : 'AppImage'] : LABEL[os][f.arch] || f.arch;
    btn.href = new URL(primary.path, DOWNLOAD_BASE).href;
    btn.removeAttribute('aria-disabled');
    btn.querySelector('[data-dl-label]').textContent = `${labels.get} (${label(primary)})`;
    const alt = document.querySelector(`[data-dl-alt="${os}"]`);
    if (alt) {
      const others = files.filter((f) => f !== primary);
      alt.replaceChildren(...others.flatMap((f, i) => {
        const a = document.createElement('a');
        a.href = new URL(f.path, DOWNLOAD_BASE).href;
        a.textContent = label(f);
        return i ? [document.createTextNode(' · '), a] : [document.createTextNode(lang === 'ja' ? 'ほかの形式: ' : 'Also: '), a];
      }));
    }
  }
}
downloads();

// Demo: five scenes that play in turn. Click a tab to jump; hover pauses. Reduced motion shows each scene's end state.
function demoPlayer() {
  const root = document.querySelector('[data-demo]');
  if (!root) return;
  const tabs = [...root.querySelectorAll('[data-demo-tab]')];
  const scenes = [...root.querySelectorAll('[data-scene]')];
  const caption = root.querySelector('[data-demo-caption]');
  const caps = JSON.parse(caption.dataset.caps);
  const DUR = 7000;
  let i = 0; let timer = 0; let recTimer = 0; let typeTimer = 0;
  root.style.setProperty('--dur', `${DUR / 1000}s`);

  const startRec = (scene) => {
    const el = scene.querySelector('[data-rec-time]');
    if (!el) return;
    let s = 12 * 60 + 41;
    const tick = () => { s += 1; el.textContent = `00:${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
    tick(); recTimer = setInterval(tick, reduced ? 1e9 : 1000);
  };
  const startType = (scene) => {
    const el = scene.querySelector('[data-type]');
    if (!el) return;
    const text = el.dataset.type;
    if (reduced) { el.textContent = text; return; }
    let n = 0; el.textContent = '';
    typeTimer = setInterval(() => { n += 1; el.textContent = text.slice(0, n); if (n >= text.length) clearInterval(typeTimer); }, 1600 / text.length);
  };
  const show = (n) => {
    clearInterval(recTimer); clearInterval(typeTimer);
    i = (n + scenes.length) % scenes.length;
    scenes.forEach((s, k) => { s.classList.remove('on'); if (k === i) { void s.offsetWidth; s.classList.add('on'); } });
    tabs.forEach((t, k) => { t.setAttribute('aria-selected', String(k === i)); const b = t.querySelector('.dt-bar'); if (b) { b.style.animation = 'none'; void b.offsetWidth; b.style.animation = ''; } });
    caption.textContent = caps[i];
    startRec(scenes[i]); startType(scenes[i]);
  };
  const schedule = () => { clearTimeout(timer); if (!reduced && !root.classList.contains('demo-paused')) timer = setTimeout(() => { show(i + 1); schedule(); }, DUR); };
  tabs.forEach((t, k) => t.addEventListener('click', () => { show(k); schedule(); }));
  root.addEventListener('mouseenter', () => { root.classList.add('demo-paused'); clearTimeout(timer); });
  root.addEventListener('mouseleave', () => { root.classList.remove('demo-paused'); schedule(); });
  if (reduced) root.classList.add('demo-paused');
  show(0); schedule();
}
demoPlayer();
