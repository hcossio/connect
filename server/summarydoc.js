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
  .byline { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; color: #666; font-size: 13px; margin-bottom: 26px; }
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
  col.c-what { width: 34%; } col.c-check { width: 49%; }
  .beta { display: inline-block; margin: 0 0 12px; padding: 2px 10px; border: 1px solid #d9d4c7; border-radius: 999px; background: #faf7ef; color: #7a6a3a; font-size: 12px; }
  ol.agenda > li { margin: 0 0 14px; padding-left: 4px; }
  ol.agenda > li::marker { font-weight: 600; color: #111; }
  .item-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 12px; }
  .item-meta { color: #666; font-size: 13px; }
  ol.agenda p { margin: 4px 0; }
  ol.agenda ul { margin: 4px 0 0; }
  .muted { color: #888; }
  @media print { .doc { padding: 0 2px; max-width: none; } }
`;

// The meeting's day, or first and last day when a joined meeting spans several.
function days(m) {
  const first = fmtDay(m.startedAt);
  const last = fmtDay(m.endedAt || m.startedAt);
  return m.mergedFrom?.length > 1 && last !== first ? `${chip(first)} – ${chip(last)}` : chip(first);
}

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
    `<div class="byline">${days(m)}${m.host ? ` · ${chip(`@${m.host}`)}` : ''}${m.mergedFrom?.length > 1 ? ` · ${chip(lab('joined', '') || `Joined from ${m.mergedFrom.length} calls`)}` : ''}</div>`,
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
  return page(s.title || m.room, guessLang(s), out);
}

function page(title, lang, out) {
  return `<!doctype html><html lang="${esc(lang)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600&family=Source+Serif+4:opsz,wght@8..60,400&display=swap" rel="stylesheet">
<style>${STYLE}</style></head><body><main class="doc">${out.filter(Boolean).join('\n')}</main></body></html>`;
}

function guessLang(s) {
  const L = s.labels || {};
  return /resumen|participantes|próximos/i.test(`${L.summary} ${L.participants} ${L.next_steps}`) ? 'es' : 'en';
}

function fileName(m, title = m.summary?.title) {
  const day = new Date(m.startedAt).toISOString().slice(0, 10);
  const base = (title || m.room).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
  return `${base || 'meeting'}-${day}.pdf`;
}

/** A document as a Letter PDF, or null when this server has no Chromium. */
async function print(doc, title) {
  const launch = preview.chromium();
  if (!launch) return null;
  const browser = await launch;
  const tab = await browser.newPage();
  try {
    await tab.setContent(doc, { waitUntil: 'networkidle', timeout: 15_000 }).catch(() => {});
    return await tab.pdf({
      format: 'Letter',
      printBackground: true,
      margin: { top: '0.8in', bottom: '0.8in', left: '0.85in', right: '0.85in' },
      displayHeaderFooter: true,
      headerTemplate: `<div style="font:7.5px Arial,sans-serif;color:#999;width:100%;padding:0 0.5in">${esc(title)}</div>`,
      footerTemplate: '<div style="font:7.5px Arial,sans-serif;color:#999;width:100%;padding:0 0.5in;text-align:right">Page <span class="pageNumber"></span> of <span class="totalPages"></span></div>',
    });
  } finally {
    tab.close().catch(() => {});
  }
}

/** The summary as a PDF, or null when this server has no Chromium. */
const pdf = (m) => print(html(m), m.summary.title || m.room);

// ---------- Beta: the next meeting's agenda ----------
function agendaHtml(m) {
  const a = m.agenda;
  const s = m.summary;
  const L = a.labels || {};
  const lab = (k, d) => L[k] || d;
  const min = (n) => `${n} ${lab('min', 'min')}`;
  const byline = [`${esc(lab('based_on', 'Based on'))} ${chip(`${s.title || m.room} · ${fmtDay(m.startedAt)}`)}`];
  if (a.suggestedDate) byline.push(`${esc(lab('when', 'When'))} ${due(a.suggestedDate, {})}`);
  if (a.minutes) byline.push(`${esc(lab('length', 'Length'))} ${chip(min(a.minutes))}`);
  const out = [
    `<p class="beta">${esc(lab('beta', 'Beta'))}</p>`,
    `<h1>${esc(a.title || `${lab('agenda', 'Agenda')} · ${s.title || m.room}`)}</h1>`,
    `<div class="byline">${byline.map((b) => `<span>${b}</span>`).join('<span>·</span>')}</div>`,
  ];
  if (a.purpose) out.push(`<h2>${esc(lab('purpose', 'Purpose'))}</h2><p>${esc(a.purpose)}</p>`);
  if (a.recap) out.push(`<h2>${esc(lab('recap', 'Where we left off'))}</h2><p>${esc(a.recap)}</p>`);
  if (a.items?.length) {
    out.push(`<h2>${esc(lab('items', 'Agenda items'))}</h2><ol class="agenda">`);
    for (const x of a.items) {
      const meta = [x.minutes ? chip(min(x.minutes)) : '', x.lead ? `${esc(lab('leads', 'Leads'))}: ${esc(x.lead)}` : ''].filter(Boolean).join(' · ');
      out.push(`<li><div class="item-head"><b>${esc(x.heading)}</b>${meta ? `<span class="item-meta">${meta}</span>` : ''}</div>`
        + (x.goal ? `<p><b>${esc(lab('goal', 'Goal'))}:</b> ${esc(x.goal)}</p>` : '')
        + (x.points?.length ? `<ul>${x.points.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>` : '') + '</li>');
    }
    out.push('</ol>');
  }
  // The task list comes straight from the minuta, so nothing in it is made up.
  if (s.tasks?.length) {
    out.push(`<h2>${esc(lab('review', 'Pending tasks to review'))}</h2>`);
    out.push(`<table><colgroup><col class="c-task"><col class="c-owner"><col class="c-due"><col class="c-status"></colgroup><thead><tr><th>${esc(lab('task', 'Task'))}</th><th>${esc(lab('owner', 'Owner'))}</th><th>${esc(lab('due', 'Due'))}</th><th>${esc(lab('status', 'Status at the meeting'))}</th></tr></thead><tbody>`);
    for (const t of s.tasks) out.push(`<tr><td>${esc(t.title)}</td><td>${t.owner ? esc(t.owner) : esc(lab('unassigned', 'Unassigned'))}</td><td>${due(t.due, { no_date: lab('no_date', 'No date') })}</td><td></td></tr>`);
    out.push('</tbody></table>');
  }
  if (a.deliverables?.length) {
    out.push(`<h2>${esc(lab('deliverables', 'Deliverables to bring'))}</h2>`);
    out.push(`<table><colgroup><col class="c-what"><col class="c-owner"><col class="c-check"></colgroup><thead><tr><th>${esc(lab('deliverables', 'Deliverable'))}</th><th>${esc(lab('owner', 'Owner'))}</th><th>${esc(lab('check', 'What to check'))}</th></tr></thead><tbody>`);
    for (const d of a.deliverables) out.push(`<tr><td>${esc(d.what)}</td><td>${d.owner ? esc(d.owner) : esc(lab('unassigned', 'Unassigned'))}</td><td>${esc(d.check)}</td></tr>`);
    out.push('</tbody></table>');
  }
  const questions = a.openQuestions?.length ? a.openQuestions : s.followUp?.questions || [];
  if (questions.length) out.push(`<h2>${esc(lab('open_questions', 'Open questions to settle'))}</h2><ul class="checks">${questions.map((q) => `<li><span>${esc(q)}</span></li>`).join('')}</ul>`);
  if (a.prepare?.length) out.push(`<h2>${esc(lab('prepare', 'Before the meeting'))}</h2><ul>${a.prepare.map((p) => `<li>${p.who ? `<b>${esc(p.who)}:</b> ` : ''}${esc(p.what)}</li>`).join('')}</ul>`);
  return page(a.title || s.title || m.room, guessLang(s), out);
}

const agendaPdf = (m) => print(agendaHtml(m), m.agenda.title || m.room);
const agendaFileName = (m) => fileName(m, m.agenda.title || `Agenda ${m.summary?.title || ''}`);

module.exports = { html, pdf, fileName, agendaHtml, agendaPdf, agendaFileName };
