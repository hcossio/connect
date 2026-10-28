// The meeting summary as a document: the same HTML is shown in the admin
// page and printed to PDF by the Chromium the shared browser uses.
const preview = require('./preview');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmtDay = (d) => new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const chip = (text) => `<span class="chip">${esc(text)}</span>`;
const ISO = /^\d{4}-\d{2}-\d{2}$/;

// "2026-10-30" and "2026-10-30/2026-10-31" become date chips; words stay words.
function due(v, L) {
  if (!v) return esc(L.no_date);
  const parts = v.split('/').map((x) => x.trim());
  if (parts.every((x) => ISO.test(x))) return parts.map((x) => chip(fmtDay(`${x}T12:00:00Z`))).join(' – ');
  return esc(v);
}

const STYLE = `
  * { box-sizing: border-box; }
  html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { margin: 0; background: #fff; color: #1f1f1f; font: 15px/1.6 "Inter", "Liberation Sans", Arial, sans-serif; }
  .doc { max-width: 760px; margin: 0 auto; padding: 40px 32px 56px; }
  h1, h2 { font-family: "Source Serif 4", "Liberation Serif", Georgia, serif; font-weight: 400; color: #111; }
  h1 { font-size: 34px; line-height: 1.18; margin: 0 0 14px; }
  h2 { font-size: 24px; line-height: 1.25; margin: 34px 0 10px; break-after: avoid; }
  p { margin: 0 0 10px; }
  .byline { display: flex; align-items: center; gap: 8px; color: #666; font-size: 13px; margin-bottom: 26px; }
  .chip { display: inline-block; background: #f1f1ef; border-radius: 6px; padding: 1px 8px; font-size: 12.5px; color: #333; white-space: nowrap; }
  ul, ol { margin: 6px 0 12px; padding-left: 24px; }
  li { margin: 4px 0; break-inside: avoid; }
  li::marker { color: #555; }
  ul.checks { list-style: none; padding-left: 4px; }
  ul.checks li { display: flex; gap: 10px; }
  ul.checks li::before { content: ""; flex: none; width: 13px; height: 13px; margin-top: 5px; border: 1px solid #bbb; border-radius: 3px; }
  table { width: 100%; table-layout: fixed; border-collapse: collapse; margin: 12px 0 8px; font-size: 13.5px; }
  th { text-align: left; font-weight: 400; color: #555; background: #f6f6f4; }
  th, td { border: 1px solid #e3e3e0; padding: 7px 10px; vertical-align: top; }
  tr { break-inside: avoid; }
  col.c-task { width: 42%; } col.c-owner { width: 17%; } col.c-due { width: 25%; } col.c-status { width: 16%; }
  td .chip { white-space: normal; }
  td .chip { margin: 1px 0; }
  .muted { color: #888; }
  @media print { .doc { padding: 0 2px; max-width: none; } }
`;

function html(m) {
  const s = m.summary;
  const L = s.labels || {};
  const lab = (k, d) => L[k] || d;
  const overview = s.overview?.length ? s.overview : [s.summary].filter(Boolean);
  const attended = s.attended?.length ? s.attended : m.names || [];
  const sections = s.sections?.length ? s.sections
    : s.decisions?.length ? [{ heading: 'Decisions', style: 'bullets', points: s.decisions.map((d) => ({ text: d })) }] : [];
  const point = (p, sep) => `<li>${p.lead ? `<b>${esc(p.lead.replace(/[.:]\s*$/, ''))}${/[?!]$/.test(p.lead) ? '' : sep}</b> ` : ''}${esc(p.text)}</li>`;
  const out = [
    `<h1>${esc(s.title || `Meeting in ${m.room}`)}</h1>`,
    `<div class="byline">${chip(fmtDay(m.startedAt))}${m.host ? ` · ${chip(`@${m.host}`)}` : ''}</div>`,
    `<h2>${esc(lab('summary', 'Summary'))}</h2>`,
    ...overview.map((p) => `<p>${esc(p)}</p>`),
  ];
  if (attended.length || s.absent?.length) {
    out.push(`<h2>${esc(lab('participants', 'Participants'))}</h2><ul>`);
    if (attended.length) out.push(`<li><b>${esc(lab('attended', 'Attended'))}:</b> ${esc(attended.join(', '))}</li>`);
    if (s.absent?.length) out.push(`<li><b>${esc(lab('absent', 'Did not attend'))}:</b> ${esc(s.absent.join(', '))}</li>`);
    out.push('</ul>');
  }
  for (const x of sections) {
    const tag = x.style === 'numbered' ? 'ol' : 'ul';
    out.push(`<h2>${esc(x.heading)}</h2>`, x.intro ? `<p>${esc(x.intro)}</p>` : '', x.points?.length ? `<${tag}>${x.points.map((p) => point(p, tag === 'ol' ? '.' : ':')).join('')}</${tag}>` : '');
  }
  if (s.tasks?.length) {
    out.push(`<h2>${esc(lab('next_steps', 'Next steps'))}</h2>`, s.nextStepsIntro ? `<p>${esc(s.nextStepsIntro)}</p>` : '');
    out.push(`<table><colgroup><col class="c-task"><col class="c-owner"><col class="c-due"><col class="c-status"></colgroup><thead><tr><th>${esc(lab('task', 'Task'))}</th><th>${esc(lab('owner', 'Owner'))}</th><th>${esc(lab('due', 'Due'))}</th><th>${esc(lab('status', 'Status'))}</th></tr></thead><tbody>`);
    for (const t of s.tasks) {
      out.push(`<tr><td>${esc(t.title)}</td><td>${t.owner ? esc(t.owner) : esc(lab('unassigned', 'Unassigned'))}</td><td>${due(t.due, { no_date: lab('no_date', 'No date') })}</td><td>${chip(lab('pending', 'Pending'))}</td></tr>`);
    }
    out.push('</tbody></table>');
  }
  if (s.followUp?.questions?.length) {
    out.push(`<h2>${esc(s.followUp.heading)}</h2>`, s.followUp.intro ? `<p>${esc(s.followUp.intro)}</p>` : '');
    out.push(`<ul class="checks">${s.followUp.questions.map((q) => `<li><span>${esc(q)}</span></li>`).join('')}</ul>`);
  }
  return `<!doctype html><html lang="${esc(guessLang(s))}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(s.title || m.room)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600&family=Source+Serif+4:opsz,wght@8..60,400&display=swap" rel="stylesheet">
<style>${STYLE}</style></head><body><main class="doc">${out.filter(Boolean).join('\n')}</main></body></html>`;
}

function guessLang(s) {
  const L = s.labels || {};
  return /resumen|participantes|próximos/i.test(`${L.summary} ${L.participants} ${L.next_steps}`) ? 'es' : 'en';
}

function fileName(m) {
  const day = new Date(m.startedAt).toISOString().slice(0, 10);
  const base = (m.summary?.title || m.room).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
  return `${base || 'meeting'}-${day}.pdf`;
}

/** The summary as a PDF, or null when this server has no Chromium. */
async function pdf(m) {
  const launch = preview.chromium();
  if (!launch) return null;
  const browser = await launch;
  const page = await browser.newPage();
  try {
    await page.setContent(html(m), { waitUntil: 'networkidle', timeout: 15_000 }).catch(() => {});
    const title = esc(m.summary.title || m.room);
    return await page.pdf({
      format: 'Letter',
      printBackground: true,
      margin: { top: '0.8in', bottom: '0.8in', left: '0.85in', right: '0.85in' },
      displayHeaderFooter: true,
      headerTemplate: `<div style="font:7.5px Arial,sans-serif;color:#999;width:100%;padding:0 0.5in">${title}</div>`,
      footerTemplate: '<div style="font:7.5px Arial,sans-serif;color:#999;width:100%;padding:0 0.5in;text-align:right">Page <span class="pageNumber"></span> of <span class="totalPages"></span></div>',
    });
  } finally {
    page.close().catch(() => {});
  }
}

module.exports = { html, pdf, fileName };
