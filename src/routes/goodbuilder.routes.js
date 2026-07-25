"use strict";

const express = require("express");
const database = require("../config/database");
const authRequired = require("../middleware/authRequired");
const { logAudit } = require("../services/audit.service");

const router = express.Router();
const SITE_STATUSES = new Set(["draft", "published", "archived"]);
const PAGE_STATUSES = new Set(["draft", "published", "scheduled", "archived"]);
const TEMPLATE_TYPES = new Set([
  "page", "section", "container", "global-widget", "header", "footer", "single",
  "archive", "search", "404", "popup", "loop", "product", "product-archive",
  "cart", "checkout", "account",
]);
const REVISION_SOURCES = new Set(["autosave", "manual", "publish", "restore", "import"]);
const DEFAULT_SETTINGS = {
  schemaVersion: 1,
  breakpoints: { desktop: 1200, tablet: 1024, mobile: 767 },
  tokens: { colors: {}, typography: {}, spacing: {}, shadows: {} },
};
const EMPTY_DOCUMENT = { schemaVersion: 1, root: [] };

function clean(value, max = 500) {
  return String(value ?? "").trim().replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, max);
}

function slug(value, fallback = "untitled") {
  const normalized = clean(value, 120)
    .toLowerCase()
    .replace(/^\/+|\/+$/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return normalized || fallback;
}

function jsonObject(value, fallback = {}) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : fallback;
}

function jsonArray(value) {
  return Array.isArray(value) ? value : [];
}

function documentValue(value) {
  const document = jsonObject(value, EMPTY_DOCUMENT);
  const encoded = JSON.stringify(document);
  if (Buffer.byteLength(encoded, "utf8") > 2_000_000) return null;
  return document;
}

function sitePayload(row) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    domain: row.primary_domain,
    status: row.status,
    settings: row.settings_json,
    publishedAt: row.published_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function pagePayload(row) {
  return {
    id: row.id,
    siteId: row.site_id,
    title: row.title,
    slug: row.slug,
    status: row.status,
    isHome: row.is_home,
    position: row.position,
    document: row.document_json,
    seo: row.seo_json,
    scheduledFor: row.scheduled_for,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function templatePayload(row) {
  return {
    id: row.id,
    siteId: row.site_id,
    name: row.name,
    slug: row.slug,
    type: row.template_type,
    document: row.document_json,
    conditions: row.conditions_json,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function ownedSite(siteId, userId, client = database) {
  const result = await client.query(
    "SELECT * FROM goodbuilder_sites WHERE id=$1 AND owner_user_id=$2",
    [siteId, userId]
  );
  return result.rows[0] || null;
}

async function ownedPage(pageId, userId, client = database) {
  const result = await client.query(
    `SELECT p.* FROM goodbuilder_pages p
     JOIN goodbuilder_sites s ON s.id=p.site_id
     WHERE p.id=$1 AND p.owner_user_id=$2 AND s.owner_user_id=$2 AND p.deleted_at IS NULL`,
    [pageId, userId]
  );
  return result.rows[0] || null;
}

async function audit(req, action, entityType, entityId, metadata = {}) {
  await logAudit({
    userId: req.user.id,
    appId: "goodbuilder",
    action,
    entityType,
    entityId,
    ipAddress: req.ip,
    metadata,
  }).catch(() => {});
}

router.get("/public/:siteSlug/:pageSlug?", async (req, res, next) => {
  try {
    const siteSlug = slug(req.params.siteSlug, "");
    const pageSlug = slug(req.params.pageSlug || "home", "home");
    if (!siteSlug) return res.status(404).json({ success: false, message: "Site not found." });
    const result = await database.query(
      `SELECT published_snapshot_json, published_at FROM goodbuilder_sites
       WHERE slug=$1 AND status='published' AND published_snapshot_json IS NOT NULL`,
      [siteSlug]
    );
    const site = result.rows[0];
    if (!site) return res.status(404).json({ success: false, message: "Site not found." });
    const snapshot = site.published_snapshot_json;
    const pages = Array.isArray(snapshot?.pages) ? snapshot.pages : [];
    const page = pages.find(item => item.slug === pageSlug || (pageSlug === "home" && item.isHome));
    if (!page) return res.status(404).json({ success: false, message: "Page not found." });
    res.set("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
    return res.json({ success: true, site: snapshot.site, page, publishedAt: site.published_at });
  } catch (error) {
    return next(error);
  }
});

router.use(authRequired);
router.use((req, res, next) => {
  const origin = clean(req.get("Origin"), 300);
  const expected = process.env.GOODBUILDER_ORIGIN || "https://builder.goodos.app";
  const developmentOrigin = process.env.NODE_ENV !== "production" && /^https?:\/\/localhost(?::\d+)?$/.test(origin);
  if (origin && origin !== expected && !developmentOrigin) {
    return res.status(403).json({ success: false, code: "GOODBUILDER_ORIGIN_DENIED", message: "Request origin is not allowed." });
  }
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && req.get("X-Requested-With") !== "GoodBuilder") {
    return res.status(403).json({ success: false, code: "GOODBUILDER_REQUEST_HEADER_REQUIRED", message: "Required request header is missing." });
  }
  return next();
});

router.get("/bootstrap", async (req, res, next) => {
  const client = await database.pool.connect();
  try {
    await client.query("BEGIN");
    let sites = await client.query(
      "SELECT * FROM goodbuilder_sites WHERE owner_user_id=$1 AND status<>'archived' ORDER BY updated_at DESC",
      [req.user.id]
    );
    if (!sites.rows.length) {
      const siteSlug = `site-${String(req.user.id).replace(/-/g, "").slice(0, 12)}`;
      const created = await client.query(
        `INSERT INTO goodbuilder_sites(owner_user_id,name,slug,settings_json)
         VALUES($1,$2,$3,$4::jsonb) RETURNING *`,
        [req.user.id, "My GoodBuilder Site", siteSlug, JSON.stringify(DEFAULT_SETTINGS)]
      );
      await client.query(
        `INSERT INTO goodbuilder_pages(site_id,owner_user_id,title,slug,status,is_home,position,document_json)
         VALUES($1,$2,'Home','home','draft',TRUE,0,$3::jsonb)`,
        [created.rows[0].id, req.user.id, JSON.stringify(EMPTY_DOCUMENT)]
      );
      sites = { rows: [created.rows[0]] };
    }
    const siteIds = sites.rows.map(site => site.id);
    const [pages, templates] = await Promise.all([
      client.query(
        `SELECT * FROM goodbuilder_pages
         WHERE owner_user_id=$1 AND site_id=ANY($2::uuid[]) AND deleted_at IS NULL
         ORDER BY site_id,position,created_at`,
        [req.user.id, siteIds]
      ),
      client.query(
        `SELECT * FROM goodbuilder_templates
         WHERE owner_user_id=$1 AND site_id=ANY($2::uuid[])
         ORDER BY site_id,template_type,name`,
        [req.user.id, siteIds]
      ),
    ]);
    await client.query("COMMIT");
    return res.json({
      success: true,
      user: req.user,
      sites: sites.rows.map(sitePayload),
      pages: pages.rows.map(pagePayload),
      templates: templates.rows.map(templatePayload),
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    return next(error);
  } finally {
    client.release();
  }
});

router.post("/sites", async (req, res, next) => {
  try {
    const name = clean(req.body?.name, 120);
    const siteSlug = slug(req.body?.slug || name, "");
    if (name.length < 2 || !siteSlug) {
      return res.status(400).json({ success: false, message: "Site name and slug are required." });
    }
    const settings = jsonObject(req.body?.settings, DEFAULT_SETTINGS);
    const result = await database.query(
      `INSERT INTO goodbuilder_sites(owner_user_id,name,slug,settings_json)
       VALUES($1,$2,$3,$4::jsonb) RETURNING *`,
      [req.user.id, name, siteSlug, JSON.stringify(settings)]
    );
    await audit(req, "goodbuilder.site.create", "site", result.rows[0].id, { slug: siteSlug });
    return res.status(201).json({ success: true, site: sitePayload(result.rows[0]) });
  } catch (error) {
    if (error.code === "23505") return res.status(409).json({ success: false, message: "That site address is already in use." });
    return next(error);
  }
});

router.patch("/sites/:siteId", async (req, res, next) => {
  try {
    const current = await ownedSite(req.params.siteId, req.user.id);
    if (!current) return res.status(404).json({ success: false, message: "Site not found." });
    const name = req.body?.name === undefined ? current.name : clean(req.body.name, 120);
    const siteSlug = req.body?.slug === undefined ? current.slug : slug(req.body.slug, "");
    const domain = req.body?.domain === undefined ? current.primary_domain : clean(req.body.domain, 255) || null;
    const status = req.body?.status === undefined ? current.status : clean(req.body.status, 20);
    const settings = req.body?.settings === undefined ? current.settings_json : jsonObject(req.body.settings, current.settings_json);
    if (name.length < 2 || !siteSlug || !SITE_STATUSES.has(status)) {
      return res.status(400).json({ success: false, message: "Site settings are invalid." });
    }
    const result = await database.query(
      `UPDATE goodbuilder_sites SET name=$3,slug=$4,primary_domain=$5,status=$6,settings_json=$7::jsonb,updated_at=NOW()
       WHERE id=$1 AND owner_user_id=$2 RETURNING *`,
      [current.id, req.user.id, name, siteSlug, domain, status, JSON.stringify(settings)]
    );
    await audit(req, "goodbuilder.site.update", "site", current.id);
    return res.json({ success: true, site: sitePayload(result.rows[0]) });
  } catch (error) {
    if (error.code === "23505") return res.status(409).json({ success: false, message: "That site address is already in use." });
    return next(error);
  }
});

router.post("/pages", async (req, res, next) => {
  try {
    const site = await ownedSite(req.body?.siteId, req.user.id);
    if (!site) return res.status(404).json({ success: false, message: "Site not found." });
    const title = clean(req.body?.title, 180);
    const pageSlug = slug(req.body?.slug || title, "");
    const status = clean(req.body?.status || "draft", 20);
    const document = documentValue(req.body?.document || EMPTY_DOCUMENT);
    const seo = jsonObject(req.body?.seo, {});
    if (title.length < 1 || !pageSlug || !PAGE_STATUSES.has(status) || !document) {
      return res.status(400).json({ success: false, message: "Page content is invalid or too large." });
    }
    const result = await database.query(
      `INSERT INTO goodbuilder_pages(
         site_id,owner_user_id,title,slug,status,is_home,position,document_json,seo_json
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb) RETURNING *`,
      [
        site.id, req.user.id, title, pageSlug, status, req.body?.isHome === true,
        Number.isInteger(req.body?.position) ? req.body.position : 0,
        JSON.stringify(document), JSON.stringify(seo),
      ]
    );
    await audit(req, "goodbuilder.page.create", "page", result.rows[0].id, { siteId: site.id });
    return res.status(201).json({ success: true, page: pagePayload(result.rows[0]) });
  } catch (error) {
    if (error.code === "23505") return res.status(409).json({ success: false, message: "That page address is already in use." });
    return next(error);
  }
});

router.patch("/pages/:pageId", async (req, res, next) => {
  try {
    const current = await ownedPage(req.params.pageId, req.user.id);
    if (!current) return res.status(404).json({ success: false, message: "Page not found." });
    const title = req.body?.title === undefined ? current.title : clean(req.body.title, 180);
    const pageSlug = req.body?.slug === undefined ? current.slug : slug(req.body.slug, "");
    const status = req.body?.status === undefined ? current.status : clean(req.body.status, 20);
    const document = req.body?.document === undefined ? current.document_json : documentValue(req.body.document);
    const seo = req.body?.seo === undefined ? current.seo_json : jsonObject(req.body.seo, current.seo_json);
    const isHome = req.body?.isHome === undefined ? current.is_home : req.body.isHome === true;
    const position = Number.isInteger(req.body?.position) ? req.body.position : current.position;
    const scheduledFor = req.body?.scheduledFor === undefined ? current.scheduled_for : req.body.scheduledFor || null;
    if (title.length < 1 || !pageSlug || !PAGE_STATUSES.has(status) || !document) {
      return res.status(400).json({ success: false, message: "Page content is invalid or too large." });
    }
    const result = await database.query(
      `UPDATE goodbuilder_pages SET
         title=$3,slug=$4,status=$5,is_home=$6,position=$7,document_json=$8::jsonb,
         seo_json=$9::jsonb,scheduled_for=$10,updated_at=NOW()
       WHERE id=$1 AND owner_user_id=$2 AND deleted_at IS NULL RETURNING *`,
      [
        current.id, req.user.id, title, pageSlug, status, isHome, position,
        JSON.stringify(document), JSON.stringify(seo), scheduledFor,
      ]
    );
    await audit(req, "goodbuilder.page.update", "page", current.id, { siteId: current.site_id });
    return res.json({ success: true, page: pagePayload(result.rows[0]) });
  } catch (error) {
    if (error.code === "23505") return res.status(409).json({ success: false, message: "That page address is already in use." });
    return next(error);
  }
});

router.delete("/pages/:pageId", async (req, res, next) => {
  try {
    const page = await ownedPage(req.params.pageId, req.user.id);
    if (!page) return res.status(404).json({ success: false, message: "Page not found." });
    if (page.is_home) return res.status(409).json({ success: false, message: "Choose another homepage before deleting this page." });
    await database.query(
      "UPDATE goodbuilder_pages SET deleted_at=NOW(),updated_at=NOW() WHERE id=$1 AND owner_user_id=$2",
      [page.id, req.user.id]
    );
    await audit(req, "goodbuilder.page.delete", "page", page.id, { siteId: page.site_id });
    return res.json({ success: true });
  } catch (error) {
    return next(error);
  }
});

router.get("/pages/:pageId/revisions", async (req, res, next) => {
  try {
    const page = await ownedPage(req.params.pageId, req.user.id);
    if (!page) return res.status(404).json({ success: false, message: "Page not found." });
    const result = await database.query(
      `SELECT id,title,change_summary,source,created_at
       FROM goodbuilder_revisions WHERE page_id=$1 AND owner_user_id=$2
       ORDER BY created_at DESC LIMIT 100`,
      [page.id, req.user.id]
    );
    return res.json({
      success: true,
      revisions: result.rows.map(row => ({
        id: row.id,
        title: row.title,
        summary: row.change_summary,
        source: row.source,
        createdAt: row.created_at,
      })),
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/pages/:pageId/revisions", async (req, res, next) => {
  try {
    const page = await ownedPage(req.params.pageId, req.user.id);
    if (!page) return res.status(404).json({ success: false, message: "Page not found." });
    const source = REVISION_SOURCES.has(req.body?.source) ? req.body.source : "manual";
    const summary = clean(req.body?.summary, 240) || null;
    const result = await database.query(
      `INSERT INTO goodbuilder_revisions(
         page_id,site_id,owner_user_id,title,document_json,seo_json,change_summary,source
       ) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8) RETURNING id,created_at`,
      [
        page.id, page.site_id, req.user.id, page.title, JSON.stringify(page.document_json),
        JSON.stringify(page.seo_json), summary, source,
      ]
    );
    return res.status(201).json({
      success: true,
      revision: { id: result.rows[0].id, source, summary, createdAt: result.rows[0].created_at },
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/pages/:pageId/revisions/:revisionId/restore", async (req, res, next) => {
  const client = await database.pool.connect();
  try {
    await client.query("BEGIN");
    const page = await ownedPage(req.params.pageId, req.user.id, client);
    if (!page) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, message: "Page not found." });
    }
    const revision = await client.query(
      `SELECT * FROM goodbuilder_revisions
       WHERE id=$1 AND page_id=$2 AND owner_user_id=$3`,
      [req.params.revisionId, page.id, req.user.id]
    );
    if (!revision.rows[0]) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, message: "Revision not found." });
    }
    await client.query(
      `INSERT INTO goodbuilder_revisions(
         page_id,site_id,owner_user_id,title,document_json,seo_json,change_summary,source
       ) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,'Before revision restore','restore')`,
      [page.id, page.site_id, req.user.id, page.title, JSON.stringify(page.document_json), JSON.stringify(page.seo_json)]
    );
    const updated = await client.query(
      `UPDATE goodbuilder_pages SET
         title=$3,document_json=$4::jsonb,seo_json=$5::jsonb,updated_at=NOW()
       WHERE id=$1 AND owner_user_id=$2 RETURNING *`,
      [
        page.id, req.user.id, revision.rows[0].title,
        JSON.stringify(revision.rows[0].document_json), JSON.stringify(revision.rows[0].seo_json),
      ]
    );
    await client.query("COMMIT");
    await audit(req, "goodbuilder.revision.restore", "page", page.id, { revisionId: req.params.revisionId });
    return res.json({ success: true, page: pagePayload(updated.rows[0]) });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    return next(error);
  } finally {
    client.release();
  }
});

router.post("/sites/:siteId/publish", async (req, res, next) => {
  const client = await database.pool.connect();
  try {
    await client.query("BEGIN");
    const site = await ownedSite(req.params.siteId, req.user.id, client);
    if (!site) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, message: "Site not found." });
    }
    const [pages, templates] = await Promise.all([
      client.query(
        `SELECT * FROM goodbuilder_pages
         WHERE site_id=$1 AND owner_user_id=$2 AND deleted_at IS NULL
         ORDER BY position,created_at`,
        [site.id, req.user.id]
      ),
      client.query(
        `SELECT * FROM goodbuilder_templates
         WHERE site_id=$1 AND owner_user_id=$2 ORDER BY template_type,name`,
        [site.id, req.user.id]
      ),
    ]);
    const publishablePages = pages.rows.filter(page => page.status === "published");
    if (!publishablePages.length) {
      await client.query("ROLLBACK");
      return res.status(409).json({ success: false, message: "Add a page before publishing this site." });
    }
    for (const page of publishablePages) {
      await client.query(
        `INSERT INTO goodbuilder_revisions(
           page_id,site_id,owner_user_id,title,document_json,seo_json,change_summary,source
         ) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,'Published site snapshot','publish')`,
        [
          page.id, site.id, req.user.id, page.title,
          JSON.stringify(page.document_json), JSON.stringify(page.seo_json),
        ]
      );
    }
    const snapshot = {
      schemaVersion: 1,
      site: sitePayload(site),
      pages: publishablePages.map(pagePayload),
      templates: templates.rows.map(templatePayload),
      publishedAt: new Date().toISOString(),
    };
    const publication = await client.query(
      `INSERT INTO goodbuilder_publications(site_id,owner_user_id,snapshot_json,page_count)
       VALUES($1,$2,$3::jsonb,$4) RETURNING id,created_at`,
      [site.id, req.user.id, JSON.stringify(snapshot), publishablePages.length]
    );
    const result = await client.query(
      `UPDATE goodbuilder_sites SET
         status='published',published_snapshot_json=$3::jsonb,published_at=NOW(),updated_at=NOW()
       WHERE id=$1 AND owner_user_id=$2 RETURNING *`,
      [site.id, req.user.id, JSON.stringify(snapshot)]
    );
    await client.query("COMMIT");
    await audit(req, "goodbuilder.site.publish", "site", site.id, { pageCount: publishablePages.length });
    return res.json({
      success: true,
      site: sitePayload(result.rows[0]),
      publication: {
        id: publication.rows[0].id,
        pageCount: publishablePages.length,
        publishedAt: publication.rows[0].created_at,
      },
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    return next(error);
  } finally {
    client.release();
  }
});

router.post("/templates", async (req, res, next) => {
  try {
    const site = await ownedSite(req.body?.siteId, req.user.id);
    if (!site) return res.status(404).json({ success: false, message: "Site not found." });
    const name = clean(req.body?.name, 180);
    const templateSlug = slug(req.body?.slug || name, "");
    const type = clean(req.body?.type || "section", 40);
    const document = documentValue(req.body?.document || EMPTY_DOCUMENT);
    const conditions = jsonArray(req.body?.conditions);
    if (!name || !templateSlug || !TEMPLATE_TYPES.has(type) || !document) {
      return res.status(400).json({ success: false, message: "Template content is invalid or too large." });
    }
    const result = await database.query(
      `INSERT INTO goodbuilder_templates(
         site_id,owner_user_id,name,slug,template_type,document_json,conditions_json
       ) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb) RETURNING *`,
      [
        site.id, req.user.id, name, templateSlug, type,
        JSON.stringify(document), JSON.stringify(conditions),
      ]
    );
    await audit(req, "goodbuilder.template.create", "template", result.rows[0].id, { siteId: site.id, type });
    return res.status(201).json({ success: true, template: templatePayload(result.rows[0]) });
  } catch (error) {
    if (error.code === "23505") return res.status(409).json({ success: false, message: "That template name is already in use." });
    return next(error);
  }
});

module.exports = router;
