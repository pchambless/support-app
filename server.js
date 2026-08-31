import express from 'express';
import Handlebars from 'handlebars';
import { resolveLayout, buildHtmxDiv, wrapHtml, callWorkflow } from 'app-engine';

// No login/session flow - support has no login screen (JSON allowlist is
// authorization, not authentication; for a single trusted user, network-level
// trust is the honest answer for now). See memory/project_app_template_epic.md.
const config = {
  schema: 'support',
  layoutTemplateName: 'wf_layout',
  navCssClass: 'appbar-nav',
  loginPath: '/agile-board'
};

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/health', (req, res) => res.send('ok'));

app.get('/', (req, res) => res.redirect('/agile-board'));

app.get('/agile-board', async (req, res) => {
  try {
    const pageRows = await callWorkflow('server-query', {
      query: `SELECT p.id AS page_id, p.context_key, p.form_template, p.page_title,
                     pc.comp_name, pc.slot_name, pc.actions, ht.name AS template_name
              FROM support.pages p
              JOIN support.page_components pc ON pc.page_id = p.id
              JOIN support.html_templates ht ON ht.id = pc.html_template_id
              WHERE p.page_name = 'agile-board'`,
      params: {},
      source: 'server'
    });

    if (!Array.isArray(pageRows) || pageRows.length === 0) {
      return res.status(404).send('agile-board page has no components');
    }

    const shellStyledHtml = await callWorkflow('server-query', {
      query: `SELECT app_engine.f_html_styled('support', 'grid-form-page') as html`,
      params: {},
      source: 'server'
    });
    let pageHtml = Array.isArray(shellStyledHtml) ? shellStyledHtml[0]?.html : '';

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

    let layoutHtml = await resolveLayout([], config);
    layoutHtml = layoutHtml.replace('{{slot:page}}', pageHtml);

    // hideCrud stays hardcoded true for now: /api/dml doesn't exist yet (no
    // write path built), so an Add New button would just 404.
    const { page_id, context_key, form_template, page_title } = pageRows[0];
    const pageMetaScript = `<script>window.__pageContext = { pageId: ${page_id}, contextKey: ${JSON.stringify(context_key || 'id')}, form: ${JSON.stringify(form_template || '')}, hideCrud: true };</script>`;
    res.send(wrapHtml(page_title || 'Support', pageMetaScript + layoutHtml, config));
  } catch (err) {
    console.error('[agile-board] render failed', err);
    res.status(500).send(`Render failed: ${err.message}`);
  }
});

// Real hydration: fetch the template's own hydrate SQL, run it with whatever
// context params htmx sent, compile the (possibly css-wrapped) handlebars
// markup against the rows. No hydrate-guide involved - that workflow is still
// hardcoded to studio.tf_template_router, not schema-aware, so this goes
// straight at app_engine/support instead of routing through it.
app.post('/api/hydrate', async (req, res) => {
  const { template_name, page_id, page_title, ...contextParams } = req.body || {};
  if (!template_name) return res.status(400).type('text').send('template_name required');

  try {
    const tmplResult = await callWorkflow('server-query', {
      query: `SELECT hydrate FROM support.html_templates WHERE name = :template_name`,
      params: { template_name },
      source: 'server'
    });
    const hydrateSql = Array.isArray(tmplResult) ? tmplResult[0]?.hydrate : null;

    const styledResult = await callWorkflow('server-query', {
      query: `SELECT app_engine.f_html_styled('support', :template_name) as html`,
      params: { template_name },
      source: 'server'
    });
    const styledHtml = Array.isArray(styledResult) ? styledResult[0]?.html : null;

    if (!styledHtml) {
      return res.type('html').send(`<div class="hydrate-pending" style="padding:12px;color:#888;">No template named ${template_name}.</div>`);
    }

    if (!hydrateSql) {
      // Static template, no data to pull - just render it as-is.
      return res.type('html').send(Handlebars.compile(styledHtml)({}));
    }

    const hydrateParams = { id: 58, status: 'All', ...contextParams };
    const rows = await callWorkflow('server-query', {
      query: hydrateSql,
      params: hydrateParams,
      source: 'server'
    });
    const dataArr = Array.isArray(rows) ? rows : [];

    const html = Handlebars.compile(styledHtml)({ data: dataArr });
    res.type('html').send(html);
  } catch (err) {
    console.error('[hydrate] failed', err);
    res.status(500).type('text').send('Hydration failed: ' + err.message);
  }
});

const PORT = process.env.PORT || 3002;
app.listen(PORT, () => console.log(`support-app listening on ${PORT}`));
