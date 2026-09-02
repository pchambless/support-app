import express from 'express';
import Handlebars from 'handlebars';
import { resolveLayout, buildHtmxDiv, buildSelectWidget, wrapHtml, callWorkflow } from 'app-engine';

// No login/session flow - support has no login screen (JSON allowlist is
// authorization, not authentication; for a single trusted user, network-level
// trust is the honest answer for now). See memory/project_app_template_epic.md.
//
// App dropdown + status/priority filters all now go through the generic
// page_components.actions declarative path (setVals + refresh), same as
// every other app_engine app - no bespoke client JS needed here. See
// app-engine's buildHtmxDiv/buildSelectWidget (dynamic js: hx-vals reading
// window.contextStore) and actionHandlers.js's setVals+refresh short-circuit.

const config = {
  schema: 'support',
  layoutTemplateName: 'app_layout',
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
                     pc.comp_name, pc.slot_name, pc.actions, ht.name AS template_name,
                     ht.title AS template_title, ht.platform
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
      const slotToken = `{{slot:${row.slot_name}}}`;
      if (!pageHtml.includes(slotToken)) continue;

      const isSelect = row.platform === 'dropdown' || row.platform === 'select';
      const widget = isSelect
        ? buildSelectWidget({
            comp_name: row.comp_name,
            template_name: row.template_name,
            template_title: row.template_title,
            actions: row.actions || {}
          })
        : buildHtmxDiv({
            comp_name: row.comp_name,
            template_name: row.template_name,
            page_id: row.page_id,
            actions: row.actions || {}
          });
      pageHtml = pageHtml.replace(slotToken, widget);
    }
    // No context-btn/crud-button components built yet for this page - strip
    // remaining unresolved shell tokens rather than leave literal {{slot:x}}.
    pageHtml = pageHtml
      .replace(/\{\{slot:dropdown-\d\}\}/g, '')
      .replace('{{slot:context-btn}}', '');

    let layoutHtml = await resolveLayout([], config);
    layoutHtml = layoutHtml.replace('{{slot:page}}', pageHtml);

    const { page_id, context_key, form_template, page_title } = pageRows[0];
    const pageMetaScript = `<script>window.__pageContext = { pageId: ${page_id}, contextKey: ${JSON.stringify(context_key || 'id')}, form: ${JSON.stringify(form_template || '')}, hideCrud: false };</script>`;
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

    let dataArr;
    if (contextParams.mode === 'INSERT') {
      // New record: render the form against one blank row rather than
      // running the hydrate SQL, which would otherwise fall back to the
      // default id (58) and populate the "new" form with an existing row.
      dataArr = [{}];
    } else {
      const hydrateParams = { id: 58, status: 'All', priority: 'All', ...contextParams };
      const rows = await callWorkflow('server-query', {
        query: hydrateSql,
        params: hydrateParams,
        source: 'server'
      });
      dataArr = Array.isArray(rows) ? rows : [];
    }

    const html = Handlebars.compile(styledHtml)({ data: dataArr });
    res.type('html').send(html);
  } catch (err) {
    console.error('[hydrate] failed', err);
    res.status(500).type('text').send('Hydration failed: ' + err.message);
  }
});

// Real write path: app-engine-actions (new, generic n8n workflow wrapping
// app_engine.dml()) - part of the app-engine workflow set, not a whatsfresh
// workflow. Field is named record_id, not id - a form field literally named
// "id" collides with HTMLFormElement's own named-control shadowing of
// form.id, which broke formActions.js's form.id === "inline_form_element"
// check (real bug, found live: it silently let the browser's native GET
// submission through instead of calling /api/dml at all).
app.post('/api/dml', async (req, res) => {
  const { page_id, mode, record_id, ...fields } = req.body || {};
  if (!page_id || !mode) {
    return res.json({ success: false, error: 'page_id and mode required' });
  }
  try {
    const result = await callWorkflow('app-engine-actions', {
      schema: 'support',
      page_id: Number(page_id),
      mode,
      data: fields,
      pk_val: record_id ? Number(record_id) : null,
      user: 'paul'
    });
    res.json(result);
  } catch (err) {
    console.error('[dml] failed', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

const PORT = process.env.PORT || 3002;
app.listen(PORT, () => console.log(`support-app listening on ${PORT}`));
