"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const express = require("express");
const multer = require("multer");
const authRequired = require("../middleware/authRequired");
const tenantContext = require("../middleware/tenantContext");
const { pool } = require("../config/database");

const router = express.Router();
const fileSystem = fs.promises;
const ASSET_ROOT = path.resolve(
  process.env.GOODFLEET_MANAGED_ASSET_DIR ||
    "/var/lib/goodbase/goodfleet-managed-assets"
);
const MAX_ASSET_BYTES = 10 * 1024 * 1024;
const EMPLOYEE_ROLES = new Set(["owner", "admin", "manager", "staff", "mechanic"]);
const MANAGER_ROLES = new Set(["owner", "admin", "manager"]);
const CATEGORIES = new Set([
  "damage_evidence",
  "damage_document",
  "maintenance_attachment",
  "inspection_attachment",
  "customer_document",
  "branding_asset",
  "vehicle_image",
  "expense_receipt",
]);
const ENTITY_TYPES = new Set(["damage_report", "maintenance", "inspection", "customer", "workspace", "vehicle", "expense"]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { files: 1, fileSize: MAX_ASSET_BYTES, fields: 10 },
});

function clean(value, maximum = 1000) {
  return String(value ?? "").trim().slice(0, maximum);
}

function fail(response, status, code, message) {
  return response.status(status).json({ success: false, code, message });
}

function role(request) {
  const organizationRole = clean(
    request.tenantContext.organization?.membershipRole,
    40
  ).toLowerCase();
  if (EMPLOYEE_ROLES.has(organizationRole)) return organizationRole;
  const membership = (request.apps || []).find(app =>
    clean(app?.membershipStatus, 40).toLowerCase() === "active" &&
    (clean(app?.id, 80).toLowerCase() === "goodfleet" ||
      clean(app?.domain, 160).toLowerCase() === "fleet.goodos.app")
  );
  return clean(membership?.role, 40).toLowerCase();
}

function requireEmployee(request, response, next) {
  if (!EMPLOYEE_ROLES.has(role(request))) {
    return fail(response, 403, "EMPLOYEE_ACCESS_REQUIRED", "GoodFleet employee access is required.");
  }
  return next();
}

function receiveAsset(request, response, next) {
  upload.single("file")(request, response, error => {
    if (!error) return next();
    if (error.code === "LIMIT_FILE_SIZE") {
      return fail(response, 413, "ASSET_TOO_LARGE", "Files must be 10 MB or smaller.");
    }
    return fail(response, 400, "ASSET_UPLOAD_FAILED", error.message || "File upload failed.");
  });
}

function detectFile(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { contentType: "image/jpeg", extension: "jpg" };
  }
  if (buffer.subarray(0, 8).equals(Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]))) {
    return { contentType: "image/png", extension: "png" };
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return { contentType: "image/webp", extension: "webp" };
  }
  if (buffer.subarray(0, 4).toString("ascii") === "%PDF") {
    return { contentType: "application/pdf", extension: "pdf" };
  }
  return null;
}

function safePath(fileName) {
  const normalized = path.basename(String(fileName || ""));
  if (!normalized || normalized !== fileName) return null;
  const resolved = path.resolve(ASSET_ROOT, normalized);
  return resolved.startsWith(`${ASSET_ROOT}${path.sep}`) ? resolved : null;
}

function payload(row) {
  return {
    id: row.id,
    category: row.category,
    entityType: row.entity_type,
    entityId: row.entity_id,
    originalName: row.original_name,
    contentType: row.content_type,
    sizeBytes: Number(row.size_bytes),
    checksumSha256: row.checksum_sha256,
    uploadedBy: row.uploaded_by,
    createdAt: row.created_at,
    url: `/api/fleet/v1/assets/${row.id}/content`,
  };
}

async function audit(client, request, action, row) {
  await client.query(
    `INSERT INTO fleet_audit_events
      (organization_id,actor_id,action,entity_type,entity_id,after_json,request_id,ip_address)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)`,
    [
      request.tenantContext.organizationId,
      request.user.id,
      action,
      row.entity_type,
      row.entity_id,
      JSON.stringify({
        assetId: row.id,
        category: row.category,
        originalName: row.original_name,
        contentType: row.content_type,
        sizeBytes: Number(row.size_bytes),
        checksumSha256: row.checksum_sha256,
      }),
      request.id || request.get("X-Request-ID") || null,
      request.ip || null,
    ]
  );
}

router.use(authRequired, tenantContext, requireEmployee);

router.get("/", async (request, response, next) => {
  try {
    const entityType = clean(request.query.entityType, 40);
    const entityId = clean(request.query.entityId, 200);
    if (!ENTITY_TYPES.has(entityType) || !entityId) {
      return fail(response, 400, "ASSET_SCOPE_REQUIRED", "Choose a supported record before listing files.");
    }
    const result = await pool.query(
      `SELECT *
         FROM fleet_managed_assets
        WHERE organization_id=$1 AND entity_type=$2 AND entity_id=$3
        ORDER BY created_at DESC`,
      [request.tenantContext.organizationId, entityType, entityId]
    );
    return response.json({ success: true, data: result.rows.map(payload) });
  } catch (error) {
    return next(error);
  }
});

router.post("/", receiveAsset, async (request, response, next) => {
  const client = await pool.connect();
  let finalPath = null;
  try {
    if (!request.file?.buffer) {
      return fail(response, 400, "ASSET_REQUIRED", "Choose an image or PDF to upload.");
    }
    const detected = detectFile(request.file.buffer);
    if (!detected) {
      return fail(response, 415, "INVALID_ASSET_TYPE", "Use a JPEG, PNG, WebP, or PDF file.");
    }
    const category = clean(request.body?.category, 60);
    const entityType = clean(request.body?.entityType, 40);
    const entityId = clean(request.body?.entityId, 200);
    if (!CATEGORIES.has(category) || !ENTITY_TYPES.has(entityType) || !entityId) {
      return fail(response, 400, "INVALID_ASSET_SCOPE", "Choose a supported file category and record.");
    }

    await fileSystem.mkdir(ASSET_ROOT, { recursive: true, mode: 0o750 });
    const storedName = `${request.tenantContext.organizationId}-${crypto.randomUUID()}.${detected.extension}`;
    finalPath = safePath(storedName);
    const temporaryPath = `${finalPath}.uploading`;
    await fileSystem.writeFile(temporaryPath, request.file.buffer, { mode: 0o640, flag: "wx" });
    await fileSystem.rename(temporaryPath, finalPath);
    const checksum = crypto.createHash("sha256").update(request.file.buffer).digest("hex");

    await client.query("BEGIN");
    const saved = await client.query(
      `INSERT INTO fleet_managed_assets
        (organization_id,category,entity_type,entity_id,original_name,stored_name,
         content_type,size_bytes,checksum_sha256,uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING *`,
      [
        request.tenantContext.organizationId,
        category,
        entityType,
        entityId,
        clean(request.file.originalname, 255) || `upload.${detected.extension}`,
        storedName,
        detected.contentType,
        request.file.buffer.length,
        checksum,
        request.user.id,
      ]
    );
    await audit(client, request, "asset.uploaded", saved.rows[0]);
    await client.query("COMMIT");
    return response.status(201).json({ success: true, data: payload(saved.rows[0]) });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    if (finalPath) await fileSystem.unlink(finalPath).catch(() => {});
    return next(error);
  } finally {
    client.release();
  }
});

router.get("/:assetId/content", async (request, response, next) => {
  try {
    const result = await pool.query(
      `SELECT *
         FROM fleet_managed_assets
        WHERE organization_id=$1 AND id=$2
        LIMIT 1`,
      [request.tenantContext.organizationId, request.params.assetId]
    );
    const asset = result.rows[0];
    if (!asset) return fail(response, 404, "ASSET_NOT_FOUND", "File not found.");
    const assetPath = safePath(asset.stored_name);
    if (!assetPath) return fail(response, 404, "ASSET_NOT_FOUND", "File not found.");
    await fileSystem.access(assetPath, fs.constants.R_OK);
    response.setHeader("Content-Type", asset.content_type);
    response.setHeader("Content-Length", String(asset.size_bytes));
    response.setHeader("Content-Disposition", `inline; filename="${String(asset.original_name).replace(/["\r\n]/g, "_")}"`);
    response.setHeader("Cache-Control", "private, no-store");
    return response.sendFile(assetPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return fail(response, 404, "ASSET_NOT_FOUND", "File not found.");
    }
    return next(error);
  }
});

router.delete("/:assetId", async (request, response, next) => {
  const client = await pool.connect();
  try {
    if (!MANAGER_ROLES.has(role(request))) {
      return fail(response, 403, "MANAGEMENT_ACCESS_REQUIRED", "Management access is required to remove files.");
    }
    await client.query("BEGIN");
    const removed = await client.query(
      `DELETE FROM fleet_managed_assets
        WHERE organization_id=$1 AND id=$2
        RETURNING *`,
      [request.tenantContext.organizationId, request.params.assetId]
    );
    if (!removed.rowCount) {
      await client.query("ROLLBACK");
      return fail(response, 404, "ASSET_NOT_FOUND", "File not found.");
    }
    await audit(client, request, "asset.deleted", removed.rows[0]);
    await client.query("COMMIT");
    const assetPath = safePath(removed.rows[0].stored_name);
    if (assetPath) await fileSystem.unlink(assetPath).catch(() => {});
    return response.json({ success: true, data: { deleted: true } });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    return next(error);
  } finally {
    client.release();
  }
});

module.exports = router;
