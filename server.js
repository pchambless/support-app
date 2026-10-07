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

// Every grid + inline-form page (agile-board, feedback) renders the same way: the page's
// components come from support.pages/page_components, composed into the grid-form-page shell.
// One function, one route per page_name (task 477 added /feedback as the second caller).
async function renderGridFormPage(pageName, res) {
  try {
    const pageRows = await callWorkflow('server-query', {
      query: `SELECT p.id AS page_id, p.context_key, p.form_template, p.page_title,
                     pc.comp_name, pc.slot_name, pc.actions, ht.name AS template_name,
                     ht.title AS template_title, ht.platform
              FROM support.pages p
              JOIN support.page_components pc ON pc.page_id = p.id
              JOIN support.html_templates ht ON ht.id = pc.html_template_id
              WHERE p.page_name = :page_name`,
      params: { page_name: pageName },
      source: 'server'
    });

    if (!Array.isArray(pageRows) || pageRows.length === 0) {
      return res.status(404).send(`${pageName} page has no components`);
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
    // Lets the inline-form submit handler (formActions.js) refresh just the
    // grid instead of reloading the whole page - any page with a platform:
    // grid component gets this for free, no per-page wiring needed.
    const gridComponentId = pageRows.find(r => r.platform === 'grid')?.comp_name || null;
    const pageMetaScript = `<script>window.__pageContext = { pageId: ${page_id}, contextKey: ${JSON.stringify(context_key || 'id')}, form: ${JSON.stringify(form_template || '')}, hideCrud: false, gridComponentId: ${JSON.stringify(gridComponentId)} };</script>`;
    res.send(wrapHtml(page_title || 'Support', pageMetaScript + layoutHtml, config));
  } catch (err) {
    console.error(`[${pageName}] render failed`, err);
    res.status(500).send(`Render failed: ${err.message}`);
  }
}

app.get('/agile-board', (req, res) => renderGridFormPage('agile-board', res));
app.get('/feedback', (req, res) => renderGridFormPage('feedback', res));

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
      const hydrateParams = { id: 58, app_id: 58, status: 'All', priority: 'All', ...contextParams };
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

// Deploy Steps (task 403, Sprint 404): the driver page. 'deploy' is the
// standing URL prefix for every deployment-area page (Paul, 2026-09-07).
// Two stacked components, ordered by page_components.ordr: the steps
// overview (all deployment.deploy_steps rows + latest signoff, read-only)
// and the active step's own widget below it - today just Compare
// (compare_grid). Superseded the old standalone /compare page/component/nav
// entry, all soft-deleted same session.
app.get('/deploy-steps', async (req, res) => {
  try {
    const pageRows = await callWorkflow('server-query', {
      query: `SELECT p.id AS page_id, p.page_title,
                     pc.comp_name, pc.slot_name, pc.actions, pc.ordr, ht.name AS template_name, ht.platform
              FROM support.pages p
              JOIN support.page_components pc ON pc.page_id = p.id
              JOIN support.html_templates ht ON ht.id = pc.html_template_id
              WHERE p.page_name = 'deploy-steps'
              ORDER BY pc.ordr`,
      params: {},
      source: 'server'
    });

    if (!Array.isArray(pageRows) || pageRows.length === 0) {
      return res.status(404).send('deploy-steps page has no components');
    }

    const pageHtml = pageRows.map(row => buildHtmxDiv({
      comp_name: row.comp_name,
      template_name: row.template_name,
      page_id: row.page_id,
      actions: row.actions || {}
    })).join('\n');

    let layoutHtml = await resolveLayout([], config);
    layoutHtml = layoutHtml.replace('{{slot:page}}', pageHtml);

    const pageMetaScript = `<script>window.__pageContext = { pageId: ${pageRows[0].page_id}, contextKey: 'id', form: '', hideCrud: true, gridComponentId: null };</script>`;
    res.send(wrapHtml(pageRows[0].page_title || 'Deploy Steps', pageMetaScript + layoutHtml, config));
  } catch (err) {
    console.error('[deploy-steps] render failed', err);
    res.status(500).send(`Render failed: ${err.message}`);
  }
});

// Deploy Dashboard: placeholder (task 403 follow-on). Content deliberately
// not decided yet - Paul, 2026-09-07: "not sure what would be pertinent",
// settling with use rather than guessing. Route exists so the nav entry
// resolves to something real instead of a 404.
app.get('/deploy-dashboard', async (req, res) => {
  const pageHtml = `<div class="table page-grid"><p>Deploy Dashboard - not built yet. Will show release status, last signoffs, dev/prod gap counts, and infra version drift once decided.</p></div>`;
  let layoutHtml = await resolveLayout([], config);
  layoutHtml = layoutHtml.replace('{{slot:page}}', pageHtml);
  res.send(wrapHtml('Deploy Dashboard', layoutHtml, config));
});

// Refresh button backend: runs deployment.f_refresh_compare() (f_scan() +
// f_capture_env_fingerprints('prod')) before the grid re-hydrates off
// vw_object_fingerprints - that view is a snapshot and lies if stale (the
// dead-f_scan incident, handoff #50), so every read of it here is preceded
// by a real scan, never a raw read.
app.post('/api/refresh-compare', async (req, res) => {
  try {
    const result = await callWorkflow('refresh-compare', {});
    const row = Array.isArray(result) ? result[0] : result;
    res.json({ success: true, ...row });
  } catch (err) {
    console.error('[refresh-compare] failed', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Signoff button backend: records human approval against the current
// pending release + the compare step, snapshotting the approved diff counts
// into result (deployment.step_signoffs.result is designed to hold exactly
// this). Goes through server-query like every other DB write here - support-app
// never opens a direct DB connection, only n8n webhooks (Guide: "wf-server
// stays thin", same rule for support-app).
app.post('/api/signoff', async (req, res) => {
  // req.body.step_id arrives as a string - it came off a data-* attribute
  // (always text) via contextStore, not a real form input.
  const step_id = parseInt(req.body?.step_id, 10);
  if (!Number.isInteger(step_id)) return res.json({ success: false, error: 'step_id required' });
  try {
    const rows = await callWorkflow('server-query', {
      query: `WITH gap AS (
                SELECT jsonb_build_object(
                  'differs', count(*) FILTER (WHERE dev_fp IS DISTINCT FROM prod_fp),
                  'missing_on_prod', count(*) FILTER (WHERE prod_fp IS NULL AND dev_fp IS NOT NULL),
                  'extra_on_prod', count(*) FILTER (WHERE dev_fp IS NULL AND prod_fp IS NOT NULL),
                  'snapshotted_at', now()
                ) AS result
                FROM deployment.vw_object_fingerprints
              )
              INSERT INTO deployment.step_signoffs (release_id, step_id, env_id, signed_by, result)
              SELECT
                (SELECT id FROM deployment.releases WHERE status = 'pending' ORDER BY id DESC LIMIT 1),
                :step_id,
                (SELECT id FROM deployment.environments WHERE name = 'prod'),
                'paul',
                gap.result
              FROM gap
              RETURNING id, signed_at, result`,
      params: { step_id },
      source: 'server'
    });
    const row = Array.isArray(rows) ? rows[0] : rows;
    if (!row) return res.json({ success: false, error: 'signoff insert returned no row' });
    res.json({ success: true, ...row });
  } catch (err) {
    console.error('[signoff] failed', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Reversible per Paul (2026-09-07): soft-deletes rather than hard-deletes,
// so the audit trail keeps who signed AND who revoked. Revokes the latest
// live signoff for this step+release - if two people were both approving
// in the same window this takes the most recent, which is an accepted
// simplification for a single-trusted-user app (no login yet).
app.post('/api/signoff/revoke', async (req, res) => {
  const step_id = parseInt(req.body?.step_id, 10);
  if (!Number.isInteger(step_id)) return res.json({ success: false, error: 'step_id required' });
  try {
    const rows = await callWorkflow('server-query', {
      query: `UPDATE deployment.step_signoffs
              SET deleted_at = now(), deleted_by = 'paul'
              WHERE id = (
                SELECT ss.id
                FROM deployment.step_signoffs ss
                WHERE ss.step_id = :step_id
                  AND ss.release_id = (SELECT id FROM deployment.releases WHERE status = 'pending' ORDER BY id DESC LIMIT 1)
                  AND ss.deleted_at IS NULL
                ORDER BY ss.signed_at DESC
                LIMIT 1
              )
              RETURNING id`,
      params: { step_id },
      source: 'server'
    });
    // server-query returns [{}] (one empty object), not [], when 0 rows match -
    // check row.id specifically, not row's truthiness (Guide 23: never read
    // empty output as success).
    const row = Array.isArray(rows) ? rows[0] : rows;
    if (!row?.id) return res.json({ success: false, error: 'No active signoff to revoke' });
    res.json({ success: true, revoked_id: row.id });
  } catch (err) {
    console.error('[signoff/revoke] failed', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

const PORT = process.env.PORT || 3002;
app.listen(PORT, () => console.log(`support-app listening on ${PORT}`));
