import express from 'express';
import { resolveLayout, buildHtmxDiv, callWorkflow } from 'app-engine';

// No login/session flow - support has no login screen (JSON allowlist is
// authorization, not authentication; for a single trusted user, network-level
// trust is the honest answer for now). See memory/project_app_template_epic.md.
const config = {
  schema: 'support',
  layoutTemplateName: 'wf_layout',
  navCssClass: 'appbar-nav'
};

const SHELL_CSS_CLASSES = ['themes', 'base', 'layout', 'header', 'content', 'dropdown-container', 'grid-form-layout', 'grid-picker', 'page-grid'];

const app = express();
app.use(express.json());

app.get('/health', (req, res) => res.send('ok'));

// TODO not wired yet: real row-data hydration needs a schema-aware hydrate-guide
// (currently hardcoded to studio.tf_template_router) or a direct app_engine query
// path. Stubbed so htmx's load-trigger POST gets a clean response instead of a 404.
app.post('/api/hydrate', (req, res) => {
  res.type('html').send('<div class="hydrate-pending" style="padding:12px;color:#888;">Live data hydration not wired up yet.</div>');
});

app.get('/', (req, res) => res.redirect('/agile-board'));

app.get('/agile-board', async (req, res) => {
  try {
    const pageRows = await callWorkflow('server-query', {
      query: `SELECT p.id AS page_id, pt.html AS shell_html, pc.comp_name, pc.slot_name, pc.actions, ht.name AS template_name
              FROM support.pages p
              JOIN support.html_templates pt ON pt.id = p.template_id
              JOIN support.page_components pc ON pc.page_id = p.id
              JOIN support.html_templates ht ON ht.id = pc.html_template_id
              WHERE p.page_name = 'agile-board'`,
      params: {},
      source: 'server'
    });

    if (!Array.isArray(pageRows) || pageRows.length === 0) {
      return res.status(404).send('agile-board page has no components');
    }

    const cssResults = await Promise.all(
      SHELL_CSS_CLASSES.map(cls =>
        callWorkflow('server-query', {
          query: `SELECT app_engine.f_css('support', '${cls}') as css`,
          params: {},
          source: 'server'
        })
      )
    );
    const shellCss = cssResults
      .map(r => (Array.isArray(r) && r[0]?.css) ? r[0].css : '')
      .filter(Boolean)
      .join('\n');

    // Inner content shell (grid-form-page): fill its {{slot:grid}} etc first.
    let pageHtml = pageRows[0].shell_html;
    for (const row of pageRows) {
      if (row.slot_name !== 'grid') continue;
      const div = buildHtmxDiv({
        comp_name: row.comp_name,
        template_name: row.template_name,
        page_id: row.page_id,
        actions: row.actions || {}
      });
      pageHtml = pageHtml.replace('{{slot:grid}}', div);
    }
    // No dropdown/context-btn/crud-button components built yet for this page -
    // strip the unresolved shell tokens rather than leave literal {{slot:x}} text.
    pageHtml = pageHtml
      .replace(/\{\{slot:dropdown-\d\}\}/g, '')
      .replace('{{slot:context-btn}}', '');

    // Outer layout (wf_layout): resolveLayout injects nav into {{slot:appbar}}.
    let layoutHtml = await resolveLayout([], config);
    layoutHtml = layoutHtml.replace('{{slot:page}}', pageHtml);

    res.type('html').send(`<style>\n${shellCss}\n</style>\n${layoutHtml}`);
  } catch (err) {
    console.error('[agile-board] render failed', err);
    res.status(500).send(`Render failed: ${err.message}`);
  }
});

const PORT = process.env.PORT || 3002;
app.listen(PORT, () => console.log(`support-app listening on ${PORT}`));
