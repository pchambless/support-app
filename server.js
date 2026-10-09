import express from 'express';
import Handlebars from 'handlebars';
import { createRenderPage, loadAppConfig, wrapHtml, callWorkflow } from 'app-engine';

// No login/session flow - support has no login screen (JSON allowlist is
// authorization, not authentication; for a single trusted user, network-level
// trust is the honest answer for now). See memory/project_app_template_epic.md.
//
// App dropdown + status/priority filters all now go through the generic
// page_components.actions declarative path (setVals + refresh), same as
// every other app_engine app - no bespoke client JS needed here. See
// app-engine's buildHtmxDiv/buildSelectWidget (dynamic js: hx-vals reading
// window.contextStore) and actionHandlers.js's setVals+refresh short-circuit.

// Config is DATA: resolved from app_engine.apps (domain support.whatsfresh.app)
// at startup via loadAppConfig, not hand-written here. Single-app process, so
// we load it once by the known domain rather than per-request-host (locally the
// host is localhost:3002, not the real domain). Set in startServer().
const APP_DOMAIN = 'support.whatsfresh.app';
let config = null;              // AppConfig, populated at startup
let renderPage, setRoutes;      // from createRenderPage(config)

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/health', (req, res) => res.send('ok'));

app.get('/', (req, res) => res.redirect('/agile-board'));

// Pages are DATA, routes are DERIVED (guidance 36 / app-engine contract):
// no per-page routes. Every GET page is served by the one generic renderPage
// from app-engine's createRenderPage, keyed off the route list loaded from
// support.vw_pages at startup. Add a page row + restart = new page, zero code.

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
      const hydrateParams = { id: 58, app_id: 58, status: 'All', priority: 'All', selected_run_id: '', ...contextParams };
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

// NOTE: deploy-steps and deploy-dashboard are now served by the generic
// renderPage (they are support.pages rows). deploy-dashboard's "not built yet"
// content moved into its page template. No per-page routes here.

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

async function startServer() {
  // 1. Resolve this app's config from app_engine.apps (DB is source of truth).
  config = await loadAppConfig(APP_DOMAIN);
  if (!config) throw new Error(`No app_engine.apps row for domain ${APP_DOMAIN}`);

  // 2. Build the generic renderer bound to this app's config.
  ({ renderPage, setRoutes } = createRenderPage(config));

  // 3. Derive the route list from the page registry (support.vw_pages). Each
  //    row -> a route the catch-all can serve. No per-page code.
  const routeRows = await callWorkflow('server-query', {
    query: `SELECT route_path AS route, page_name, page_id, group_name
              FROM support.vw_pages
             ORDER BY group_name, page_name`,
    params: {},
    source: 'server'
  });
  const routes = Array.isArray(routeRows) ? routeRows : [];
  setRoutes(routes);
  console.log(`[support-app] loaded ${routes.length} route(s): ${routes.map(r => r.route).join(', ')}`);

  // 4. One catch-all GET route -> the generic renderer. Everything above
  //    (/health, /, /api/*) is registered before this and takes precedence.
  //    NOTE: '*' is the Express 4 catch-all (support-app is on express 4.22);
  //    wf-server uses '{*path}' because it is on express 5. Do not copy the
  //    express-5 pattern here - it registers nothing in express 4 (silent 404).
  app.get('*', renderPage);

  app.listen(PORT, () => console.log(`support-app listening on ${PORT}`));
}

startServer().catch(err => {
  console.error('[support-app] startup failed:', err);
  process.exit(1);
});
