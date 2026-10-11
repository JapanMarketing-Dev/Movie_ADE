// Renders site/{index,download,privacy}.html (English) and site/ja/* (Japanese) from tools/site/content.mjs.
// Usage: node tools/site/build.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { en, ja, REPO, SITE } from './content.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'site');

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// Inline `code` in body copy.
const md = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>');
const icon = (id, cls = '') => `<svg class="icon${cls ? ' ' + cls : ''}" aria-hidden="true"><use href="#${id}"/></svg>`;

const SPRITE = `<svg class="sprite" aria-hidden="true">
  <symbol id="i-github" viewBox="0 0 16 16"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></symbol>
  <symbol id="i-download" viewBox="0 0 24 24"><path d="M12 3v12M7 10l5 5 5-5M5 21h14"/></symbol>
  <symbol id="i-book" viewBox="0 0 24 24"><path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2V5z"/><path d="M4 21a2 2 0 0 1 2-2h13v2H6"/></symbol>
  <symbol id="i-check" viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></symbol>
  <symbol id="i-terminal" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3M13 15h4"/></symbol>
  <symbol id="i-swap" viewBox="0 0 24 24"><path d="M4 8h14l-4-4M20 16H6l4 4"/></symbol>
  <symbol id="i-refresh" viewBox="0 0 24 24"><path d="M20 11a8 8 0 0 0-14.6-4.5L4 8M4 4v4h4M4 13a8 8 0 0 0 14.6 4.5L20 16M20 20v-4h-4"/></symbol>
  <symbol id="i-code" viewBox="0 0 24 24"><path d="M8 7l-5 5 5 5M16 7l5 5-5 5M14 4l-4 16"/></symbol>
  <symbol id="i-undo" viewBox="0 0 24 24"><path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/></symbol>
  <symbol id="i-lock" viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></symbol>
  <symbol id="i-gift" viewBox="0 0 24 24"><rect x="3" y="8" width="18" height="5" rx="1"/><path d="M5 13v8h14v-8M12 8v13M12 8S10.5 3 8 3.8C5.7 4.6 7.5 8 12 8zM12 8s1.5-5 4-4.2C18.3 4.6 16.5 8 12 8z"/></symbol>
  <symbol id="i-shield" viewBox="0 0 24 24"><path d="M12 3l8 3v6c0 4.5-3.4 8.1-8 9-4.6-.9-8-4.5-8-9V6l8-3z"/><path d="M8.5 12l2.5 2.5 4.5-5"/></symbol>
  <symbol id="i-monitor" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></symbol>
  <symbol id="i-film" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M7 3v18M17 3v18M3 8h4M3 16h4M17 8h4M17 16h4"/></symbol>
  <symbol id="i-text" viewBox="0 0 24 24"><path d="M4 6V4h16v2M12 4v16M9 20h6"/></symbol>
  <symbol id="i-bolt" viewBox="0 0 24 24"><path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z"/></symbol>
  <symbol id="i-image" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-9 9"/></symbol>
  <symbol id="i-music" viewBox="0 0 24 24"><path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/></symbol>
  <symbol id="i-json" viewBox="0 0 24 24"><path d="M8 3H7a2 2 0 0 0-2 2v4a2 2 0 0 1-2 2 2 2 0 0 1 2 2v4a2 2 0 0 0 2 2h1M16 3h1a2 2 0 0 1 2 2v4a2 2 0 0 0 2 2 2 2 0 0 0-2 2v4a2 2 0 0 1-2 2h-1"/></symbol>
  <symbol id="i-mic" viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/></symbol>
</svg>`;

const MARK = `<svg class="brand-mark" viewBox="0 0 32 32" aria-hidden="true"><rect x="1" y="1" width="30" height="30" rx="9" fill="#ff4a3d"/><path d="M11 9.5l12 6.5-12 6.5z" fill="#fff"/><path d="M6 23.5L26 8.5" stroke="#07070a" stroke-width="2.6" stroke-linecap="round"/></svg>`;

const AGENTS = ['Claude Code', 'Codex', 'Gemini CLI', 'OpenCode', 'Cursor', 'GitHub Copilot', 'Your own CLI'];

function head(t, { title, description, path }) {
  const url = SITE + path;
  const enUrl = SITE + path.replace(/^\/ja/, '');
  const jaUrl = (SITE + '/ja' + path.replace(/^\/ja/, '')).replace(/\/$/, '');
  return `<!doctype html>
<html lang="${t.lang}" class="no-js">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(description)}">
  <meta name="color-scheme" content="dark">
  <meta name="theme-color" content="#07070a">
  <link rel="canonical" href="${url}">
  <link rel="alternate" hreflang="en" href="${enUrl}">
  <link rel="alternate" hreflang="ja" href="${jaUrl}">
  <link rel="alternate" hreflang="x-default" href="${enUrl}">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="Solocut">
  <meta property="og:title" content="${esc(title)}">
  <meta property="og:description" content="${esc(description)}">
  <meta property="og:url" content="${url}">
  <meta property="og:image" content="${SITE}/assets/og.png">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:image" content="${SITE}/assets/og.png">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="/style.css">
  <script type="module" src="/js/app.js"></script>
  <script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'SoftwareApplication', name: 'Solocut', applicationCategory: 'MultimediaApplication', operatingSystem: 'macOS, Windows, Linux', offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' }, license: 'https://opensource.org/licenses/MIT', url: SITE, description })}</script>
</head>`;
}

function header(t, page) {
  const p = t.root;
  const anchor = (id) => (page === 'home' ? `#${id}` : `${t.home}#${id}`);
  const otherHref = page === 'home' ? t.otherHome : t.otherRoot + page;
  return `<body data-page="${page}" data-lang="${t.lang}">
${SPRITE}
<a class="skip" href="#main">${esc(t.skip)}</a>
<header class="site-header">
  <div class="wrap">
    <a class="brand" href="${t.home}">${MARK}<span>Solocut</span></a>
    <nav class="site-nav" aria-label="Main">
      <a href="${anchor('how')}">${esc(t.nav.how)}</a>
      <a href="${anchor('templates')}">${esc(t.nav.templates)}</a>
      <a href="${anchor('checks')}">${esc(t.nav.checks)}</a>
      <a href="${anchor('faq')}">${esc(t.nav.faq)}</a>
    </nav>
    <div class="header-actions">
      <a class="lang-switch" href="${otherHref}" hreflang="${t.other}" lang="${t.other}">${esc(t.otherLabel)}</a>
      <a class="btn btn-sm btn-ghost" href="${REPO}" target="_blank" rel="noopener noreferrer">${icon('i-github', 'icon-fill')}<span class="btn-label-hide">GitHub</span></a>
      <a class="btn btn-sm btn-primary" href="${p}download">${icon('i-download')}<span class="btn-label-hide">${esc(t.nav.download)}</span></a>
    </div>
  </div>
</header>`;
}

function footer(t) {
  return `<footer class="site-footer">
  <div class="wrap">
    <a class="brand" href="${t.home}">${MARK}<span>Solocut</span></a>
    <span>${esc(t.footer.made)}</span>
    <nav aria-label="Footer">
      <a href="${t.root}download">${esc(t.nav.download)}</a>
      <a href="${REPO}/tree/main/docs" target="_blank" rel="noopener noreferrer">${esc(t.nav.docs)}</a>
      <a href="${t.root}privacy">${esc(t.footer.privacy)}</a>
      <a href="${REPO}/blob/main/LICENSE" target="_blank" rel="noopener noreferrer">${esc(t.footer.license)}</a>
      <a href="${REPO}" target="_blank" rel="noopener noreferrer">GitHub</a>
    </nav>
  </div>
</footer>
</body>
</html>
`;
}

function mock(t) {
  const m = t.mock;
  const segs = {
    0: [[2, 26, ''], [28, 6, 'cut'], [35, 30, ''], [66, 5, 'cut'], [72, 26, '']],
    1: [[2, 26, 'cam'], [28, 6, 'cut'], [35, 30, 'cam'], [66, 5, 'cut'], [72, 26, 'cam']],
    2: [[4, 10, 'cap'], [16, 10, 'cap'], [37, 12, 'cap'], [51, 12, 'cap'], [74, 11, 'cap'], [87, 9, 'cap']],
  };
  const row = (i) => {
    const label = esc(m.tracks[i]);
    if (i === 3) return `<div class="tl-row"><span>${label}</span><div class="tl-track"><div class="wave"></div></div></div>`;
    const s = segs[i].map(([l, w, c]) => `<i class="seg${c ? ' ' + c : ''}"${c === 'cut' ? ' data-cut' : ''} style="left:${l}%;width:${w}%"></i>`).join('');
    return `<div class="tl-row"><span>${label}</span><div class="tl-track">${s}${i === 0 ? '<div class="playhead"></div>' : ''}</div></div>`;
  };
  const checks = [['00:12:04', 'ok', '0.94'], ['00:18:22', 'ok', '0.91'], ['00:41:07', 'warn', '0.62'], ['00:52:15', 'ok', '0.97']]
    .map(([tc, s, v]) => `<div class="chk${s === 'warn' ? ' warn' : ''}" data-s="${v}"><span class="fn">${tc}</span></div>`).join('');
  const lines = m.lines.map(([c, l]) => `<div${c ? ` class="${c}"` : ''}>${esc(l)}</div>`).join('');
  return `<div class="mock reveal" aria-hidden="true">
  <div class="mock-bar"><i></i><i></i><i></i><span>${esc(m.title)}</span></div>
  <div class="mock-body">
    <div class="mock-preview">
      <div class="phone">
        <svg class="person" viewBox="0 0 120 150"><circle cx="60" cy="52" r="30" fill="#5d6687"/><path d="M8 150c4-38 26-58 52-58s48 20 52 58z" fill="#454d6b"/></svg>
        <div class="safe"></div>
        <div class="mosaic"></div><span class="tag">${esc(m.mosaicTag)}</span>
        <div class="cap" data-cap>${m.caption.map((w) => `<span>${esc(w)}</span>`).join(t.lang === 'en' ? ' ' : '')}</div>
      </div>
    </div>
    <div class="mock-tl">
      <div class="tl-head"><span>timeline.json</span><span>1080×1920 · 30fps</span></div>
      ${[0, 1, 2, 3].map(row).join('\n      ')}
      <div class="checks">${checks}</div>
    </div>
    <div class="mock-term">
      <div class="term-tabs"><span class="on">claude</span><span>codex</span><span>gemini</span></div>
      <div class="term-lines" data-term>${lines}</div>
    </div>
  </div>
</div>`;
}

function home(t) {
  const flow = t.how.steps.map(([h, p]) => `<li><h3>${esc(h)}</h3><p>${md(p)}</p></li>`).join('\n        ');
  const bullets = (arr) => `<ul class="bullets">${arr.map((b) => `<li>${icon('i-check')}<span>${md(b)}</span></li>`).join('')}</ul>`;
  const feats = (arr) => arr.map(([ic, h, p]) => `<li class="feat">${icon(ic)}<h3>${esc(h)}</h3><p>${md(p)}</p></li>`).join('\n        ');
  const tracks = t.rec.tracks.map(([n, c], i) => {
    const inner = c
      ? (i === 2 ? `<i style="left:22%;width:70%;background:${c}"></i>` : `<i style="left:4%;width:92%;background:${c}"></i>`)
      : '<div class="wavebar"></div>';
    return `<div class="trk"><span>${esc(n)}</span><div class="bar">${inner}</div></div>`;
  }).join('');
  const frames = t.checks.frames.map(([s, h, p]) => `<div class="frame ${s}"><div class="img"></div><div class="meta"><b>${esc(h)}</b>${esc(p)}</div></div>`).join('');
  const libs = t.libs.items.map(([n, d, w]) => `<div class="lib"><b>${esc(n)}</b><span>${esc(d)}</span>${w ? `<br><em>${esc(w)}</em>` : ''}</div>`).join('');
  const faq = t.faq.items.map(([q, a]) => `<details><summary>${esc(q)}</summary><p>${md(a)}</p></details>`).join('\n        ');
  const tplYaml = `<span class="k">id</span>: tiktok-talk
<span class="k">canvas</span>: { width: 1080, height: 1920, fps: 30 }
<span class="k">layouts</span>: [camera-full, screen-top-camera-bottom]
<span class="k">cut</span>:
  <span class="k">silence</span>: { minMs: 300, padMs: 80 }
  <span class="k">fillers</span>: [<span class="s">${t.lang === 'ja' ? 'えー, えっと, あのー' : 'um, uh, like'}</span>]
  <span class="k">retakes</span>: keep-last
<span class="k">captions</span>: { style: tiktok-bold, highlight: word, safeArea: tiktok }
<span class="k">audio</span>: { loudness: -14, truePeak: -1 }
<span class="k">checks</span>: [cut-boundaries, caption-safe-area, pii-on-screen]
<span class="k">pipeline</span>:
  [ingest, sync, transcribe, rough-cut, captions,
   layout, preview, check, review, final]`;

  return `${head(t, { title: t.title, description: t.description, path: t.home })}
${header(t, 'home')}
<main id="main">
  <section class="hero">
    <div class="wrap hero-inner">
      <div class="hero-copy">
        <p class="eyebrow"><span class="dot"></span>${esc(t.eyebrow)}</p>
        <h1>${t.h1}</h1>
        <p class="lede">${md(t.lede)}</p>
        <div class="hero-actions">
          <a class="btn btn-lg btn-primary" href="${REPO}" target="_blank" rel="noopener noreferrer">${icon('i-github', 'icon-fill')}${esc(t.ctaPrimary)}</a>
          <a class="btn btn-lg btn-ghost" href="${REPO}/tree/main/docs" target="_blank" rel="noopener noreferrer">${icon('i-book')}${esc(t.ctaSecondary)}</a>
        </div>
        <p class="hero-meta">${esc(t.heroMeta)}</p>
      </div>
      ${mock(t)}
    </div>
  </section>

  <section class="works" aria-label="${esc(t.works)}">
    <div class="wrap works-row"><strong>${esc(t.works)}</strong>${AGENTS.map((a) => `<span>${esc(t.lang === 'ja' && a === 'Your own CLI' ? '独自のCLI' : a)}</span>`).join('')}</div>
  </section>

  <section class="section" id="how">
    <div class="wrap">
      <div class="section-head reveal"><p class="kicker">${esc(t.how.kicker)}</p><h2>${esc(t.how.h2)}</h2><p>${md(t.how.p)}</p></div>
      <ol class="flow reveal">
        ${flow}
      </ol>
    </div>
  </section>

  <section class="section" id="record">
    <div class="wrap split">
      <div class="reveal"><p class="kicker">${esc(t.rec.kicker)}</p><h2>${esc(t.rec.h2)}</h2><p class="lede" style="font-size:17px">${md(t.rec.p)}</p>${bullets(t.rec.bullets)}</div>
      <div class="card reveal"><div class="tracks">${tracks}</div><p class="sync-note">${esc(t.rec.sync)}</p></div>
    </div>
  </section>

  <section class="section" id="templates">
    <div class="wrap split rev">
      <div class="reveal"><p class="kicker">${esc(t.tpl.kicker)}</p><h2>${esc(t.tpl.h2)}</h2><p class="lede" style="font-size:17px">${md(t.tpl.p)}</p>${bullets(t.tpl.bullets)}</div>
      <div class="card reveal"><pre class="code"><span class="c"># templates/tiktok-talk/template.yaml</span>
${tplYaml}</pre></div>
    </div>
  </section>

  <section class="section" id="terminal">
    <div class="wrap">
      <div class="section-head reveal"><p class="kicker">${esc(t.term.kicker)}</p><h2>${esc(t.term.h2)}</h2><p>${md(t.term.p)}</p></div>
      <ul class="feat-grid reveal">
        ${feats(t.term.feats)}
      </ul>
    </div>
  </section>

  <section class="section" id="checks">
    <div class="wrap">
      <div class="section-head reveal"><p class="kicker">${esc(t.checks.kicker)}</p><h2>${esc(t.checks.h2)}</h2><p>${md(t.checks.p)}</p></div>
      <div class="frames reveal">${frames}</div>
      <div class="reveal">${bullets(t.checks.bullets)}</div>
    </div>
  </section>

  <section class="section" id="mosaic">
    <div class="wrap split">
      <div class="reveal"><p class="kicker">${esc(t.mosaic.kicker)}</p><h2>${esc(t.mosaic.h2)}</h2><p class="lede" style="font-size:17px">${md(t.mosaic.p)}</p></div>
      <div class="card reveal"><pre class="code"><span class="c">// timeline.json</span>
<span class="k">"masks"</span>: [{
  <span class="k">"kind"</span>: <span class="s">"pixelate"</span>,
  <span class="k">"reason"</span>: <span class="s">"pii:email"</span>,
  <span class="k">"source"</span>: <span class="s">"t1.screen"</span>,
  <span class="k">"track"</span>: [
    { <span class="k">"frame"</span>: 120, <span class="k">"box"</span>: [412, 88, 260, 28] },
    { <span class="k">"frame"</span>: 180, <span class="k">"box"</span>: [412, 40, 260, 28] }
  ],
  <span class="k">"confidence"</span>: 0.93
}]</pre></div>
    </div>
  </section>

  <section class="section" id="feedback">
    <div class="wrap split rev">
      <div class="reveal"><p class="kicker">${esc(t.fb.kicker)}</p><h2>${esc(t.fb.h2)}</h2><p class="lede" style="font-size:17px">${md(t.fb.p)}</p></div>
      <div class="fb reveal" aria-hidden="true">
        <span class="bubble">${icon('i-mic')}${esc(t.fb.bubble)}</span>
        <span class="tc">00:00:41:07</span>
        <svg class="pen" viewBox="0 0 400 250" preserveAspectRatio="none"><path d="M120 196c-30-14-22-40 30-46 70-8 150-6 168 14 14 18-30 34-110 36-50 2-90-2-110-10"/></svg>
        <span class="fbcap">${esc(t.fb.cap)}</span>
      </div>
    </div>
  </section>

  <section class="section" id="benchmark">
    <div class="wrap split">
      <div class="reveal"><p class="kicker">${esc(t.bench.kicker)}</p><h2>${esc(t.bench.h2)}</h2><p class="lede" style="font-size:17px">${md(t.bench.p)}</p></div>
      <div class="card reveal">
        <p class="bench-url">youtube.com/watch?v=…</p>
        <dl class="bench">${t.bench.rows.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>
        <p class="bench-apply">${icon('i-check')}${esc(t.bench.apply)}</p>
      </div>
    </div>
  </section>

  <section class="section" id="libraries">
    <div class="wrap">
      <div class="section-head reveal"><p class="kicker">${esc(t.libs.kicker)}</p><h2>${esc(t.libs.h2)}</h2><p>${md(t.libs.p)}</p></div>
      <div class="libs reveal">${libs}</div>
    </div>
  </section>

  <section class="section" id="why">
    <div class="wrap">
      <div class="section-head reveal"><p class="kicker">${esc(t.why.kicker)}</p><h2>${esc(t.why.h2)}</h2></div>
      <ul class="feat-grid reveal" style="margin-bottom:14px">
        ${feats(t.extras)}
      </ul>
      <ul class="feat-grid reveal">
        ${feats(t.why.feats)}
      </ul>
    </div>
  </section>

  <section class="section" id="faq">
    <div class="wrap">
      <div class="section-head"><h2>${esc(t.faq.h2)}</h2></div>
      <div class="faq">
        ${faq}
      </div>
    </div>
  </section>

  <section class="cta">
    <div class="wrap">
      <h2>${esc(t.cta.h2)}</h2>
      <p>${esc(t.cta.p)}</p>
      <div class="hero-actions">
        <a class="btn btn-lg btn-primary" href="${REPO}" target="_blank" rel="noopener noreferrer">${icon('i-github', 'icon-fill')}${esc(t.ctaPrimary)}</a>
        <a class="btn btn-lg btn-ghost" href="${t.root}download">${icon('i-download')}${esc(t.nav.download)}</a>
      </div>
    </div>
  </section>
</main>
${footer(t)}`;
}

function download(t) {
  const d = t.dl;
  const cards = d.os.map(([id, name, sub]) => `<div class="dl-card" data-os="${id}">
        <h3>${esc(name)}</h3><p>${esc(sub)}</p>
        <p class="you" hidden>${esc(d.you)}</p>
        <a class="btn btn-primary" data-dl="${id}" aria-disabled="true" href="#">${icon('i-download')}<span data-dl-label>${esc(d.soon)}</span></a>
      </div>`).join('\n      ');
  return `${head(t, { title: `${d.title} — Solocut`, description: d.description, path: `${t.root}download` })}
${header(t, 'download')}
<main id="main" data-dl-labels='${esc(JSON.stringify({ get: d.get, soon: d.soon }))}'>
  <section class="dl-hero">
    <div class="wrap">
      <h1>${esc(d.h1)}</h1>
      <p class="lede">${esc(d.p)}</p>
      <p class="notice" data-dl-notice>${esc(d.notice)}</p>
      <div class="dl-grid">
      ${cards}
      </div>
      <p class="sums" style="margin-top:24px">${esc(d.verify)}</p>
    </div>
  </section>
</main>
${footer(t)}`;
}

const PRIVACY = {
  en: { h1: 'Privacy', body: [
    'Solocut runs on your computer. Your recordings, audio, transcripts and projects stay on your machine.',
    'Transcription runs locally with whisper.cpp by default. If you choose a cloud transcription service or a cloud decision model, only the data needed for that task (audio for transcription; frame images and transcript text for checks) is sent to the provider you chose, with your own API key, after you agree.',
    'The app checks solocut.app for updates. Crash reports (stack traces and environment information, never media, transcripts or file paths) are sent to Sentry; you can turn this off in Settings.',
    'This website uses Cloudflare Web Analytics, which does not use cookies.',
  ] },
  ja: { h1: 'プライバシー', body: [
    'Solocut はお使いのコンピューターの中で動きます。収録した映像・音声、文字起こし、プロジェクトは端末の中に残ります。',
    '文字起こしは、初期設定では whisper.cpp で端末内で行います。クラウドの文字起こしや判定モデルを選んだ場合に限り、その処理に必要なデータ（文字起こしは音声、チェックはフレーム画像と文字起こし）を、あなたが選んだ事業者へ、あなたの API キーで、同意のうえで送ります。',
    'アプリは solocut.app で更新を確認します。クラッシュレポート（スタックトレースと環境の情報。映像・文字起こし・ファイルのパスは含みません）を Sentry に送ります。設定でオフにできます。',
    'このサイトは Cookie を使わない Cloudflare Web Analytics を利用しています。',
  ] },
};

function privacy(t) {
  const p = PRIVACY[t.lang];
  return `${head(t, { title: `${p.h1} — Solocut`, description: p.body[0], path: `${t.root}privacy` })}
${header(t, 'privacy')}
<main id="main">
  <section class="dl-hero"><div class="wrap" style="max-width:820px">
    <h1>${esc(p.h1)}</h1>
    ${p.body.map((b) => `<p class="lede" style="font-size:17px">${esc(b)}</p>`).join('\n    ')}
  </div></section>
</main>
${footer(t)}`;
}

function out(rel, html) {
  const file = join(ROOT, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, html);
  console.log('wrote', rel);
}

for (const [t, dir] of [[en, ''], [ja, 'ja/']]) {
  out(`${dir}index.html`, home(t));
  out(`${dir}download.html`, download(t));
  out(`${dir}privacy.html`, privacy(t));
}
