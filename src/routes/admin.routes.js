const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const multer = require("multer");
const authRequired = require("../middleware/authRequired");
const database = require("../config/database");
const notificationService = require("../services/notification.service");
const jobService = require("../services/job.service");
const secretService = require("../services/secret.service");
const sslCertificatesService = require("../services/ssl-certificates.service");
const dashboardActivityService = require("../services/dashboard-activity.service");
const goodosChartsDatabaseV28 = require("../config/database");

const recentAppsService = require("../services/recent-apps.service");

const router = express.Router();

function ok(res, data = {}) {
  return res.json({ success: true, data });
}

function fail(res, message, status = 500, detail = null) {
  return res.status(status).json({ success: false, message, detail });
}

function dbQuery(sql, params = []) {
  if (typeof database.query === "function") return database.query(sql, params);
  if (database.pool && typeof database.pool.query === "function") return database.pool.query(sql, params);
  if (typeof database.getPool === "function") return database.getPool().query(sql, params);
  if (database.default && typeof database.default.query === "function") return database.default.query(sql, params);
  throw new Error("Database query function not found");
}

function currentUserId(req) {
  return req.user?.id || req.auth?.user?.id || req.session?.user?.id || null;
}

function randomId(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

function hashSecret(secret) {
  return crypto.createHash("sha256").update(secret).digest("hex");
}

async function safeCount(tableName, whereClause = "", params = []) {
  try {
    const result = await dbQuery(`SELECT COUNT(*)::int AS count FROM ${tableName} ${whereClause}`, params);
    return result.rows[0]?.count || 0;
  } catch {
    return 0;
  }
}

function formatUptime(seconds) {
  const total = Math.floor(Number(seconds) || 0);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);

  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${total} sec`;
}

async function getTables() {
  const result = await dbQuery(`
    SELECT table_name AS "tableName"
    FROM information_schema.tables
    WHERE table_schema = 'public'
    ORDER BY table_name ASC
  `);

  const tables = [];

  for (const row of result.rows) {
    tables.push({
      tableName: row.tableName,
      rowCount: await safeCount(row.tableName),
      status: "available",
    });
  }

  return tables;
}

async function getUsers() {
  const result = await dbQuery(`
    SELECT
      id,
      email,
      display_name AS "displayName",
      platform_role AS "platformRole",
      status,
      email_verified AS "emailVerified",
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    FROM users
    ORDER BY created_at DESC
    LIMIT 100
  `);

  return result.rows;
}

async function getApps() {
  const result = await dbQuery(`
    SELECT
      a.id,
      a.name,
      a.domain,
      a.status,
      COUNT(m.user_id)::int AS "memberCount"
    FROM apps a
    LEFT JOIN app_memberships m ON m.app_id = a.id AND m.status = 'active'
    GROUP BY a.id, a.name, a.domain, a.status
    ORDER BY a.name ASC
  `);

  return result.rows;
}

async function getMemberships() {
  const result = await dbQuery(`
    SELECT
      u.email,
      u.display_name AS "displayName",
      m.user_id AS "userId",
      m.app_id AS "appId",
      a.name AS "appName",
      a.domain,
      m.role,
      m.status
    FROM app_memberships m
    JOIN users u ON u.id = m.user_id
    JOIN apps a ON a.id = m.app_id
    ORDER BY a.name ASC, u.email ASC
    LIMIT 500
  `);

  return result.rows;
}

async function getApiKeys() {
  const result = await dbQuery(`
    SELECT
      id,
      name,
      type,
      key_prefix AS "keyPrefix",
      status,
      created_at AS "createdAt",
      last_used_at AS "lastUsedAt",
      revoked_at AS "revokedAt"
    FROM backend_api_keys
    ORDER BY created_at DESC
    LIMIT 100
  `);

  return result.rows;
}

async function getWebhooks() {
  const result = await dbQuery(`
    SELECT
      id,
      name,
      url,
      events,
      status,
      created_at AS "createdAt",
      last_triggered_at AS "lastTriggeredAt"
    FROM backend_webhooks
    ORDER BY created_at DESC
    LIMIT 100
  `);

  return result.rows;
}

async function getBuckets() {
  const result = await dbQuery(`
    SELECT
      b.id,
      b.name,
      b.visibility,
      b.status,
      b.created_at AS "createdAt",
      COUNT(f.id)::int AS "fileCount",
      COALESCE(SUM(f.size_bytes), 0)::bigint AS "totalBytes"
    FROM backend_storage_buckets b
    LEFT JOIN backend_storage_files f ON f.bucket_id = b.id
    GROUP BY b.id, b.name, b.visibility, b.status, b.created_at
    ORDER BY b.created_at DESC
  `);

  return result.rows;
}

async function getEvents() {
  const result = await dbQuery(`
    SELECT
      id,
      event_type AS "eventType",
      source,
      message,
      payload,
      created_at AS "createdAt"
    FROM backend_events
    ORDER BY created_at DESC
    LIMIT 100
  `);

  return result.rows;
}

async function getOverview() {
  const [
    users,
    apps,
    activeApps,
    memberships,
    activeMemberships,
    sessions,
    apiKeys,
    webhooks,
    buckets,
    events,
    tables,
    dbTime,
  ] = await Promise.all([
    safeCount("users"),
    safeCount("apps"),
    safeCount("apps", "WHERE status = $1", ["active"]),
    safeCount("app_memberships"),
    safeCount("app_memberships", "WHERE status = $1", ["active"]),
    safeCount("sessions"),
    safeCount("backend_api_keys", "WHERE status = $1", ["active"]),
    safeCount("backend_webhooks", "WHERE status = $1", ["active"]),
    safeCount("backend_storage_buckets", "WHERE status = $1", ["active"]),
    safeCount("backend_events"),
    getTables(),
    dbQuery("SELECT NOW() AS now"),
  ]);

  const memory = process.memoryUsage();

  return {
    service: "Goodbase",
    environment: process.env.NODE_ENV || "production",
    version: process.env.VERSION || "1.0.0",
    status: "operational",
    database: {
      status: "connected",
      time: dbTime.rows[0]?.now,
    },
    stats: {
      users,
      apps,
      activeApps,
      memberships,
      activeMemberships,
      sessions,
      apiKeys,
      webhooks,
      webhookDeliveries,
      buckets,
      events,
      tables: tables.length,
    },
    runtime: {
      uptimeSeconds: Math.floor(process.uptime()),
      uptimeFormatted: formatUptime(process.uptime()),
      memory,
      memoryMb: {
        rss: Math.round(memory.rss / 1024 / 1024),
        heapUsed: Math.round(memory.heapUsed / 1024 / 1024),
        heapTotal: Math.round(memory.heapTotal / 1024 / 1024),
      },
      node: process.version,
      pid: process.pid,
      platform: process.platform,
      arch: process.arch,
    },
  };
}

function tailFile(filePath, maxLines = 80) {
  try {
    if (!fs.existsSync(filePath)) return [];
    const content = fs.readFileSync(filePath, "utf8");
    return content.split("\n").filter(Boolean).slice(-maxLines);
  } catch {
    return [];
  }
}

function getPm2Logs() {
  const candidates = new Set();

  const addCandidate = (filePath) => {
    if (!filePath) return;
    candidates.add(filePath);
  };

  addCandidate(process.env.pm_out_log_path);
  addCandidate(process.env.pm_err_log_path);

  const knownFiles = [
    "/root/.pm2/logs/goodapp-backend-out.log",
    "/root/.pm2/logs/goodapp-backend-error.log",
    "/root/.pm2/logs/goodapp-backend-out-19.log",
    "/root/.pm2/logs/goodapp-backend-error-19.log",
    "/home/mgoodlo3/.pm2/logs/goodapp-backend-out.log",
    "/home/mgoodlo3/.pm2/logs/goodapp-backend-error.log",
  ];

  knownFiles.forEach(addCandidate);

  const scanDirs = [
    "/root/.pm2/logs",
    "/home/mgoodlo3/.pm2/logs",
    process.env.HOME ? path.join(process.env.HOME, ".pm2/logs") : null,
  ].filter(Boolean);

  for (const dir of scanDirs) {
    try {
      if (!fs.existsSync(dir)) continue;

      for (const file of fs.readdirSync(dir)) {
        if (
          file.toLowerCase().includes("goodapp") ||
          file.toLowerCase().includes("backend")
        ) {
          addCandidate(path.join(dir, file));
        }
      }
    } catch {
      // Ignore directories we cannot read.
    }
  }

  const logs = Array.from(candidates)
    .filter((filePath) => {
      try {
        return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
      } catch {
        return false;
      }
    })
    .map((filePath) => {
      const stat = fs.statSync(filePath);

      return {
        file: path.basename(filePath),
        path: filePath,
        size: stat.size,
        modifiedAt: stat.mtime,
        lines: tailFile(filePath, 160),
      };
    })
    .sort((a, b) => String(a.file).localeCompare(String(b.file)));

  if (logs.length) return logs;

  return [
    {
      file: "pm2-log-access",
      path: "not-found",
      size: 0,
      modifiedAt: new Date(),
      lines: [
        "No PM2 log files were readable from the backend process.",
        "The backend is online, but the console could not access /root/.pm2/logs or /home/mgoodlo3/.pm2/logs.",
        "This does not affect API/auth/database operation."
      ],
    },
  ];
}

function getBackups() {
  const backupDir = path.join(process.cwd(), "backups");

  try {
    return fs.readdirSync(backupDir).map((name) => {
      const fullPath = path.join(backupDir, name);
      const stat = fs.statSync(fullPath);

      return {
        name,
        type: stat.isDirectory() ? "directory" : "file",
        size: stat.size,
        modifiedAt: stat.mtime,
      };
    }).sort((a, b) => new Date(b.modifiedAt) - new Date(a.modifiedAt));
  } catch {
    return [];
  }
}

function getSecuritySummary() {
  return {
    cors: {
      cookieCredentials: true,
      allowedDomain: ".goodos.app",
      sameSite: process.env.AUTH_COOKIE_SAMESITE || "lax",
      secureCookie: process.env.AUTH_COOKIE_SECURE || "true",
    },
    auth: {
      cookieName: process.env.AUTH_COOKIE_NAME || "goodos_session",
      sessionDays: process.env.SESSION_DAYS || "7",
      jwtExpiresIn: process.env.JWT_EXPIRES_IN || "7d",
    },
    headers: {
      helmet: true,
      hsts: true,
      csp: true,
    },
  };
}

async function createEvent(eventType, message, payload = {}) {
  const eventId = randomId("evt");
  const createdAt = new Date();

  const eventPayload = {
    id: eventId,
    type: eventType,
    eventType,
    source: "goodapp-backend",
    message,
    createdAt: createdAt.toISOString(),
    data: payload || {},
  };

  try {
    await dbQuery(
      `
        INSERT INTO backend_events (id, event_type, source, message, payload)
        VALUES ($1, $2, $3, $4, $5::jsonb)
      `,
      [
        eventId,
        eventType,
        "goodapp-backend",
        message,
        JSON.stringify(payload || {}),
      ]
    );

    if (typeof dispatchWebhooksForEvent === "function") {
      setImmediate(() => {
        dispatchWebhooksForEvent(eventPayload).catch((error) => {
          console.warn("Webhook dispatch failed:", error.message);
        });
      });
    }

    return eventPayload;
  } catch {
    return eventPayload;
  }
}


function hashStorageToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

async function getStorageFiles() {
  const result = await dbQuery(`
    SELECT
      f.id,
      f.bucket_id AS "bucketId",
      b.name AS "bucketName",
      f.filename,
      f.original_filename AS "originalFilename",
      f.mime_type AS "mimeType",
      f.size_bytes AS "sizeBytes",
      f.storage_path AS "storagePath",
      f.status,
      f.created_at AS "createdAt",
      f.updated_at AS "updatedAt"
    FROM backend_storage_files f
    JOIN backend_storage_buckets b ON b.id = f.bucket_id
    ORDER BY f.created_at DESC
    LIMIT 500
  `);

  return result.rows;
}

async function getStorageSignedUrls() {
  const result = await dbQuery(`
    SELECT
      s.id,
      s.file_id AS "fileId",
      f.filename,
      f.original_filename AS "originalFilename",
      s.status,
      s.expires_at AS "expiresAt",
      s.max_downloads AS "maxDownloads",
      s.download_count AS "downloadCount",
      s.created_at AS "createdAt",
      s.last_used_at AS "lastUsedAt"
    FROM backend_storage_signed_urls s
    JOIN backend_storage_files f ON f.id = s.file_id
    ORDER BY s.created_at DESC
    LIMIT 500
  `);

  return result.rows;
}


const storageRoot = path.join(process.cwd(), "storage");
const storageBucketRoot = path.join(storageRoot, "buckets");
const storageTmpRoot = path.join(storageRoot, "tmp");

fs.mkdirSync(storageBucketRoot, { recursive: true });
fs.mkdirSync(storageTmpRoot, { recursive: true });

const upload = multer({
  dest: storageTmpRoot,
  limits: {
    fileSize: Number(process.env.STORAGE_MAX_UPLOAD_BYTES || 25 * 1024 * 1024),
  },
});

function safeStorageName(value, fallback = "file") {
  const cleaned = String(value || fallback)
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/_+/g, "_");

  return cleaned || fallback;
}

router.use(authRequired);

router.get("/overview", async (req, res) => {
  try {
    return ok(res, await getOverview());
  } catch (error) {
    return fail(res, "Failed to load admin overview", 500, error.message);
  }
});

router.get("/users", async (req, res) => {
  try {
    const webhookConsolePayload = await getWebhookConsolePayloadDirect();
    webhooks = webhookConsolePayload.webhooks;
    webhookDeliveries = webhookConsolePayload.webhookDeliveries;

    return ok(res, { users: await getUsers() });
  } catch (error) {
    return fail(res, "Failed to load users", 500, error.message);
  }
});

router.get("/apps", async (req, res) => {
  try {
    return ok(res, { apps: await getApps() });
  } catch (error) {
    return fail(res, "Failed to load apps", 500, error.message);
  }
});

router.get("/memberships", async (req, res) => {
  try {
    return ok(res, { memberships: await getMemberships() });
  } catch (error) {
    return fail(res, "Failed to load memberships", 500, error.message);
  }
});

router.get("/tables", async (req, res) => {
  try {
    return ok(res, { tables: await getTables() });
  } catch (error) {
    return fail(res, "Failed to load database tables", 500, error.message);
  }
});

router.get("/api-keys", async (req, res) => {
  try {
    return ok(res, { apiKeys: await getApiKeys() });
  } catch (error) {
    return fail(res, "Failed to load API keys", 500, error.message);
  }
});

router.post("/api-keys", async (req, res) => {
  try {
    const name = String(req.body?.name || "").trim();
    const type = String(req.body?.type || "read_only").trim();

    if (!name) return fail(res, "API key name is required", 400);

    const id = randomId("key");
    const secret = `gak_${type === "full_access" ? "live" : "read"}_${crypto.randomBytes(24).toString("hex")}`;
    const keyPrefix = secret.slice(0, 18);
    const keyHash = hashSecret(secret);

    await dbQuery(
      `
        INSERT INTO backend_api_keys (id, name, type, key_prefix, key_hash, status, created_by)
        VALUES ($1, $2, $3, $4, $5, 'active', $6)
      `,
      [id, name, type, keyPrefix, keyHash, currentUserId(req)]
    );

    await createEvent("api_key.created", `API key created: ${name}`, { id, name, type });

    return ok(res, {
      apiKey: {
        id,
        name,
        type,
        keyPrefix,
        status: "active",
      },
      secret,
      warning: "Copy this secret now. It will not be shown again.",
    });
  } catch (error) {
    return fail(res, "Failed to create API key", 500, error.message);
  }
});

router.post("/api-keys/:id/revoke", async (req, res) => {
  try {
    await dbQuery(
      `
        UPDATE backend_api_keys
        SET status = 'revoked', revoked_at = NOW()
        WHERE id = $1
      `,
      [req.params.id]
    );

    await createEvent("api_key.revoked", `API key revoked: ${req.params.id}`, { id: req.params.id });

    return ok(res, { revoked: true });
  } catch (error) {
    return fail(res, "Failed to revoke API key", 500, error.message);
  }
});

router.get("/webhooks", async (req, res) => {
  try {
    return ok(res, { webhooks: await getWebhooks() });
  } catch (error) {
    return fail(res, "Failed to load webhooks", 500, error.message);
  }
});

router.post("/webhooks", async (req, res) => {
  try {
    const name = String(req.body?.name || "").trim();
    const url = String(req.body?.url || "").trim();
    const events = Array.isArray(req.body?.events) && req.body.events.length ? req.body.events : ["*"];

    if (!name) return fail(res, "Webhook name is required", 400);
    if (!/^https?:\/\//i.test(url)) return fail(res, "Valid webhook URL is required", 400);

    const id = randomId("wh");
    const secret = `whsec_${crypto.randomBytes(18).toString("hex")}`;

    await dbQuery(
      `
        INSERT INTO backend_webhooks (id, name, url, events, secret, status, created_by)
        VALUES ($1, $2, $3, $4, $5, 'active', $6)
      `,
      [id, name, url, events, secret, currentUserId(req)]
    );

    await createEvent("webhook.created", `Webhook created: ${name}`, { id, name, url });

    return ok(res, {
      webhook: {
        id,
        name,
        url,
        events,
        status: "active",
      },
      secret,
    });
  } catch (error) {
    return fail(res, "Failed to create webhook", 500, error.message);
  }
});

router.post("/webhooks/:id/disable", async (req, res) => {
  try {
    await dbQuery(
      `
        UPDATE backend_webhooks
        SET status = 'disabled'
        WHERE id = $1
      `,
      [req.params.id]
    );

    await createEvent("webhook.disabled", `Webhook disabled: ${req.params.id}`, { id: req.params.id });

    return ok(res, { disabled: true });
  } catch (error) {
    return fail(res, "Failed to disable webhook", 500, error.message);
  }
});

router.get("/storage/buckets", async (req, res) => {
  try {
    return ok(res, { buckets: await getBuckets() });
  } catch (error) {
    return fail(res, "Failed to load storage buckets", 500, error.message);
  }
});

router.post("/storage/buckets", async (req, res) => {
  try {
    const name = String(req.body?.name || "").trim().toLowerCase().replace(/[^a-z0-9-_]/g, "-");
    const visibility = String(req.body?.visibility || "private").trim();

    if (!name) return fail(res, "Bucket name is required", 400);

    const id = randomId("bucket");

    await dbQuery(
      `
        INSERT INTO backend_storage_buckets (id, name, visibility, status, created_by)
        VALUES ($1, $2, $3, 'active', $4)
      `,
      [id, name, visibility, currentUserId(req)]
    );

    await createEvent("storage.bucket_created", `Storage bucket created: ${name}`, { id, name, visibility });

    return ok(res, {
      bucket: {
        id,
        name,
        visibility,
        status: "active",
      },
    });
  } catch (error) {
    return fail(res, "Failed to create storage bucket", 500, error.message);
  }
});



router.post("/storage/buckets/:bucketId/files", upload.single("file"), async (req, res) => {
  try {
    const bucketId = String(req.params.bucketId || "").trim();

    const bucketResult = await dbQuery(
      `
        SELECT
          id,
          name,
          status,
          visibility,
          max_file_size_bytes,
          allowed_mime_types,
          allowed_extensions,
          public_read_enabled,
          signed_url_ttl_seconds,
          file_versioning_enabled,
          virus_scan_required,
          encryption_mode
        FROM backend_storage_buckets
        WHERE id = $1
        LIMIT 1
      `,
      [bucketId]
    );

    const bucket = bucketResult.rows[0];

    if (!bucket) {
      if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
      return fail(res, "Bucket not found", 404);
    }

    if (bucket.status !== "active") {
      if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
      return fail(res, "Bucket is not active", 400);
    }

    if (!req.file) {
      return fail(res, "No file uploaded", 400);
    }

    const fileSize = Number(req.file.size || 0);
    const maxFileSizeBytes = Number(bucket.max_file_size_bytes || 10485760);
    const mimeType = String(req.file.mimetype || "application/octet-stream").toLowerCase();
    const extension = path.extname(String(req.file.originalname || "")).toLowerCase();

    const allowedMimeTypes = Array.isArray(bucket.allowed_mime_types)
      ? bucket.allowed_mime_types.map((item) => String(item || "").toLowerCase()).filter(Boolean)
      : [];

    const allowedExtensions = Array.isArray(bucket.allowed_extensions)
      ? bucket.allowed_extensions.map((item) => String(item || "").toLowerCase()).filter(Boolean)
      : [];

    const blockUpload = async (message, code) => {
      let removedTempFile = false;

      if (req.file?.path && fs.existsSync(req.file.path)) {
        try {
          fs.unlinkSync(req.file.path);
          removedTempFile = true;
        } catch {}
      }

      try {
        await dbQuery(
          `
            INSERT INTO backend_admin_audit_logs (
              id,
              actor,
              action,
              target_type,
              target_id,
              after_json,
              ip_address,
              user_agent
            )
            VALUES ($1, $2, 'storage.policy.violation', 'storage_bucket', $3, $4::jsonb, $5, $6)
          `,
          [
            `audit_${crypto.randomUUID().replace(/-/g, "")}`,
            req.user?.email || req.session?.user?.email || req.auth?.user?.email || "console-user",
            bucket.id,
            JSON.stringify({
              code,
              message,
              removedTempFile,
              file: {
                originalname: req.file?.originalname || null,
                mimetype: req.file?.mimetype || null,
                size: req.file?.size || 0,
                extension,
              },
              policy: {
                maxFileSizeBytes,
                allowedMimeTypes,
                allowedExtensions,
                virusScanRequired: Boolean(bucket.virus_scan_required),
              },
            }),
            req.headers["x-forwarded-for"] || req.socket?.remoteAddress || null,
            req.headers["user-agent"] || null,
          ]
        );
      } catch {}

      return fail(res, message, 400);
    };

    if (fileSize > maxFileSizeBytes) {
      return blockUpload(
        `File exceeds bucket max size. Max ${maxFileSizeBytes} bytes, received ${fileSize} bytes.`,
        "storage_policy_size_exceeded"
      );
    }

    if (allowedMimeTypes.length && !allowedMimeTypes.includes(mimeType)) {
      return blockUpload(
        `File MIME type is not allowed for this bucket: ${mimeType}`,
        "storage_policy_mime_blocked"
      );
    }

    if (allowedExtensions.length && !allowedExtensions.includes(extension)) {
      return blockUpload(
        `File extension is not allowed for this bucket: ${extension || "none"}`,
        "storage_policy_extension_blocked"
      );
    }

    if (bucket.virus_scan_required) {
      return blockUpload(
        "This bucket requires virus scanning, but no scanner is connected yet.",
        "storage_policy_virus_scan_required"
      );
    }

    const bucketFolderName = safeStorageName(bucket.name, "bucket");
    const bucketDir = path.join(storageBucketRoot, bucketFolderName);
    fs.mkdirSync(bucketDir, { recursive: true });

    const fileId = `file_${crypto.randomUUID().replace(/-/g, "")}`;
    const originalFilename = safeStorageName(req.file.originalname, "upload.bin");
    const storedFilename = `${fileId}_${originalFilename}`;
    const finalPath = path.join(bucketDir, storedFilename);

    fs.renameSync(req.file.path, finalPath);

    const createdBy =
      req.user?.id ||
      req.auth?.user?.id ||
      req.session?.user?.id ||
      null;

    await dbQuery(
      `
        INSERT INTO backend_storage_files (
          id,
          bucket_id,
          filename,
          original_filename,
          display_name,
          mime_type,
          size_bytes,
          storage_path,
          folder_path,
          status,
          created_by
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, '', 'active', $9)
      `,
      [
        fileId,
        bucket.id,
        storedFilename,
        originalFilename,
        originalFilename,
        req.file.mimetype || "application/octet-stream",
        req.file.size || 0,
        finalPath,
        createdBy,
      ]
    );

    if (typeof createEvent === "function") {
      await createEvent("storage.file_uploaded", `File uploaded: ${originalFilename}`, {
        fileId,
        bucketId: bucket.id,
        bucketName: bucket.name,
        sizeBytes: req.file.size || 0,
      });
    }

    return ok(res, {
      file: {
        id: fileId,
        bucketId: bucket.id,
        bucketName: bucket.name,
        filename: storedFilename,
        originalFilename,
        displayName: originalFilename,
        mimeType: req.file.mimetype || "application/octet-stream",
        sizeBytes: req.file.size || 0,
        status: "active",
      },
    });
  } catch (error) {
    if (req.file?.path && fs.existsSync(req.file.path)) {
      try { fs.unlinkSync(req.file.path); } catch {}
    }

    return fail(res, "Failed to upload file", 500, error.message);
  }
});

router.get("/storage/files", async (req, res) => {
  try {
    return ok(res, { files: await getStorageFiles() });
  } catch (error) {
    return fail(res, "Failed to load storage files", 500, error.message);
  }
});

router.get("/storage/signed-urls", async (req, res) => {
  try {
    return ok(res, { signedUrls: await getStorageSignedUrls() });
  } catch (error) {
    return fail(res, "Failed to load signed URLs", 500, error.message);
  }
});

router.post("/storage/files/:fileId/signed-url", async (req, res) => {
  try {
    const fileId = String(req.params.fileId || "").trim();
    const requestedMinutesRaw = Number(
      req.body?.expiresMinutes ||
      req.body?.expiresInMinutes ||
      60
    );

    const requestedMinutes = Math.max(1, Math.min(10080, requestedMinutesRaw));
    const maxDownloads = Math.max(1, Math.min(1000, Number(req.body?.maxDownloads || 1)));

    const fileResult = await dbQuery(
      `
        SELECT
          f.id,
          f.bucket_id,
          f.filename,
          f.original_filename AS "originalFilename",
          f.display_name AS "displayName",
          f.status,
          f.deleted_at,
          f.file_deleted,
          b.name AS "bucketName",
          b.signed_url_ttl_seconds,
          b.visibility AS "bucketVisibility"
        FROM backend_storage_files f
        JOIN backend_storage_buckets b ON b.id = f.bucket_id
        WHERE f.id = $1
        LIMIT 1
      `,
      [fileId]
    );

    const file = fileResult.rows[0];

    if (!file) return fail(res, "File not found", 404);

    if (file.deleted_at || file.file_deleted) {
      try {
        await dbQuery(
          `
            INSERT INTO backend_admin_audit_logs (
              id,
              actor,
              action,
              target_type,
              target_id,
              after_json,
              ip_address,
              user_agent
            )
            VALUES ($1, $2, 'storage.policy.violation', 'storage_file', $3, $4::jsonb, $5, $6)
          `,
          [
            `audit_${crypto.randomUUID().replace(/-/g, "")}`,
            req.user?.email || req.session?.user?.email || req.auth?.user?.email || "console-user",
            fileId,
            JSON.stringify({
              code: "storage_signed_url_deleted_file_blocked",
              message: "Cannot create a signed URL for a deleted file.",
            }),
            req.headers["x-forwarded-for"] || req.socket?.remoteAddress || null,
            req.headers["user-agent"] || null,
          ]
        );
      } catch {}

      return fail(res, "Cannot create a signed URL for a deleted file.", 410);
    }

    if (file.status !== "active") {
      return fail(res, "File is not active", 400);
    }

    const ttlSeconds = Number(file.signed_url_ttl_seconds || 3600);
    const maxPolicyMinutes = Math.max(1, Math.floor(ttlSeconds / 60));
    const expiresMinutes = Math.min(requestedMinutes, maxPolicyMinutes);
    const expiresAt = new Date(Date.now() + expiresMinutes * 60 * 1000);

    const id = `surl_${crypto.randomUUID().replace(/-/g, "")}`;
    const token = crypto.randomBytes(32).toString("hex");
    const tokenHash = hashStorageToken(token);

    const createdBy =
      req.user?.id ||
      req.auth?.user?.id ||
      req.session?.user?.id ||
      null;

    await dbQuery(
      `
        INSERT INTO backend_storage_signed_urls (
          id,
          file_id,
          token_hash,
          status,
          expires_at,
          max_downloads,
          created_by
        )
        VALUES ($1, $2, $3, 'active', $4, $5, $6)
      `,
      [id, file.id, tokenHash, expiresAt, maxDownloads, createdBy]
    );

    if (typeof createEvent === "function") {
      await createEvent("storage.signed_url_created", `Signed URL created for: ${file.originalFilename || file.filename}`, {
        signedUrlId: id,
        fileId: file.id,
        expiresAt,
        maxDownloads,
        requestedMinutes,
        enforcedMinutes: expiresMinutes,
      });
    }

    return ok(res, {
      signedUrl: {
        id,
        fileId: file.id,
        url: `https://base.goodos.app/storage/signed/${token}`,
        expiresAt,
        maxDownloads,
        status: "active",
        requestedMinutes,
        enforcedMinutes: expiresMinutes,
        bucketTtlSeconds: ttlSeconds,
      },
      warning: "Anyone with this URL can download the file until it expires or reaches its download limit.",
    });
  } catch (error) {
    return fail(res, "Failed to create signed URL", 500, error.message);
  }
});

router.get("/events", async (req, res) => {
  try {
    return ok(res, { events: await getEvents() });
  } catch (error) {
    return fail(res, "Failed to load backend events", 500, error.message);
  }
});

router.get("/logs", async (req, res) => {
  try {
    return ok(res, { logs: getPm2Logs() });
  } catch (error) {
    return fail(res, "Failed to load logs", 500, error.message);
  }
});

router.get("/backups", async (req, res) => {
  try {
    return ok(res, { backups: getBackups() });
  } catch (error) {
    return fail(res, "Failed to load backups", 500, error.message);
  }
});

router.get("/security", async (req, res) => {
  try {
    return ok(res, getSecuritySummary());
  } catch (error) {
    return fail(res, "Failed to load security summary", 500, error.message);
  }
});

router.get("/health", async (req, res) => {
  try {
    const dbTime = await dbQuery("SELECT NOW() AS now");
    return ok(res, {
      api: "ok",
      database: "ok",
      time: dbTime.rows[0]?.now,
      uptimeSeconds: Math.floor(process.uptime()),
    });
  } catch (error) {
    return fail(res, "Admin health check failed", 500, error.message);
  }
});

router.get("/console-data", async (req, res) => {
  try {
    const [
      overview,
      apps,
      users,
      tables,
      memberships,
      apiKeys,
      webhooks,
      webhookDeliveries,
      buckets,
      events,
    ] = await Promise.all([
      getOverview(),
      getApps(),
      getUsers(),
      getTables(),
      getMemberships(),
      getApiKeys(),
      getWebhooks(),
      getWebhookDeliveries(),
      getBuckets(),
      getEvents(),
    ]);

    return ok(res, {
      overview,
      apps,
      users,
      tables,
      memberships,
      apiKeys,
      webhooks,
      webhookDeliveries,
      buckets,
      events,
      logs: getPm2Logs(),
      backups: getBackups(),
      security: getSecuritySummary(),
    });
  } catch (error) {
    return fail(res, "Failed to load console data", 500, error.message);
  }
});


router.post("/events/test", async (req, res) => {
  try {
    await createEvent("system.test_event", "Manual console test event created.", {
      triggeredFrom: "backend-console",
      at: new Date().toISOString(),
    });

    return ok(res, { created: true });
  } catch (error) {
    return fail(res, "Failed to create test event", 500, error.message);
  }
});

router.post("/backups/create", async (req, res) => {
  try {
    const backupDir = path.join(process.cwd(), "backups", "db-snapshots");
    fs.mkdirSync(backupDir, { recursive: true });

    const tablesResult = await dbQuery(`
      SELECT table_name AS "tableName"
      FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY table_name ASC
    `);

    const backup = {
      createdAt: new Date().toISOString(),
      database: "goodos_backend",
      type: "json-snapshot",
      note: "GoodAppBackEnd console snapshot. Limited to 10000 rows per table.",
      tables: {},
    };

    for (const row of tablesResult.rows) {
      const tableName = row.tableName;
      const quotedTable = tableName.replace(/"/g, '""');
      const rows = await dbQuery(`SELECT * FROM "${quotedTable}" LIMIT 10000`);
      backup.tables[tableName] = rows.rows;
    }

    const fileName = `goodos_backend_snapshot_${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    const filePath = path.join(backupDir, fileName);

    fs.writeFileSync(filePath, JSON.stringify(backup, null, 2));

    await createEvent("backup.created", `Database snapshot created: ${fileName}`, {
      fileName,
      tableCount: Object.keys(backup.tables).length,
    });

    return ok(res, {
      backup: {
        name: fileName,
        path: filePath,
        tableCount: Object.keys(backup.tables).length,
      },
    });
  } catch (error) {
    return fail(res, "Failed to create backup snapshot", 500, error.message);
  }
});


function webhookRandomId(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

function webhookSignature(secret, rawBody) {
  if (!secret) return "";
  return "sha256=" + crypto
    .createHmac("sha256", String(secret))
    .update(rawBody)
    .digest("hex");
}

async function getWebhookDeliveries() {
  const result = await dbQuery(`
    SELECT
      d.id,
      d.webhook_id AS "webhookId",
      w.name AS "webhookName",
      d.event_id AS "eventId",
      d.event_type AS "eventType",
      d.url,
      d.response_status AS "responseStatus",
      d.status,
      d.attempt_count AS "attemptCount",
      d.error_message AS "errorMessage",
      d.next_retry_at AS "nextRetryAt",
      d.delivered_at AS "deliveredAt",
      d.created_at AS "createdAt",
      d.updated_at AS "updatedAt"
    FROM backend_webhook_deliveries d
    LEFT JOIN backend_webhooks w ON w.id = d.webhook_id
    ORDER BY d.created_at DESC
    LIMIT 250
  `);

  return result.rows;
}

function webhookEventMatches(events = [], eventType = "") {
  const normalizedEvents = Array.isArray(events)
    ? events.map((item) => String(item || "").trim()).filter(Boolean)
    : ["*"];

  if (!normalizedEvents.length) return true;
  if (normalizedEvents.includes("*")) return true;
  if (normalizedEvents.includes(eventType)) return true;

  return normalizedEvents.some((pattern) => {
    if (!pattern.endsWith(".*")) return false;
    const prefix = pattern.slice(0, -1);
    return eventType.startsWith(prefix);
  });
}

async function getActiveWebhooksForEvent(eventType) {
  const result = await dbQuery(
    `
      SELECT
        id,
        name,
        url,
        events,
        secret,
        status,
        delivery_timeout_seconds,
        max_retries,
        retry_backoff_seconds
      FROM backend_webhooks
      WHERE status = 'active'
      ORDER BY created_at ASC
    `
  );

  return result.rows.filter((webhook) => webhookEventMatches(webhook.events, eventType));
}

function getWebhookTimeoutMs(webhook) {
  return Math.min(Math.max(Number(webhook.delivery_timeout_seconds || 15), 3), 60) * 1000;
}

function getWebhookRetryDelayMs(webhook) {
  return Math.min(Math.max(Number(webhook.retry_backoff_seconds || 300), 30), 86400) * 1000;
}

function getWebhookMaxAttempts(webhook) {
  return Math.min(Math.max(Number(webhook.max_retries || 3), 0), 10);
}

async function recordWebhookCounter(webhookId, isSuccess) {
  try {
    await dbQuery(
      `
        UPDATE backend_webhooks
        SET
          success_count = success_count + $2,
          failure_count = failure_count + $3,
          last_triggered_at = NOW(),
          updated_at = NOW()
        WHERE id = $1
      `,
      [webhookId, isSuccess ? 1 : 0, isSuccess ? 0 : 1]
    );
  } catch (error) {
    console.warn("Webhook counter update failed:", error.message);
  }
}

async function sendWebhookDeliveryAttempt(deliveryId, webhook, eventPayload, rawBody, headers) {
  const timeoutMs = getWebhookTimeoutMs(webhook);
  const maxAttempts = getWebhookMaxAttempts(webhook);

  const currentDeliveryResult = await dbQuery(
    `
      SELECT attempt_count
      FROM backend_webhook_deliveries
      WHERE id = $1
      LIMIT 1
    `,
    [deliveryId]
  );

  const currentAttemptCount = Number(currentDeliveryResult.rows[0]?.attempt_count || 0);
  const nextAttemptCount = currentAttemptCount + 1;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(webhook.url, {
      method: "POST",
      headers,
      body: rawBody,
      signal: controller.signal,
    });

    const responseText = await response.text();
    const responseHeaders = Object.fromEntries(response.headers.entries());
    const isSuccess = response.status >= 200 && response.status < 300;
    const shouldRetry = !isSuccess && nextAttemptCount < maxAttempts;
    const nextRetryAt = shouldRetry ? new Date(Date.now() + getWebhookRetryDelayMs(webhook)) : null;

    await dbQuery(
      `
        UPDATE backend_webhook_deliveries
        SET
          response_status = $1,
          response_headers = $2::jsonb,
          response_body = $3,
          status = $4,
          attempt_count = attempt_count + 1,
          error_message = $5,
          next_retry_at = $6,
          delivered_at = $7,
          updated_at = NOW()
        WHERE id = $8
      `,
      [
        response.status,
        JSON.stringify(responseHeaders),
        responseText.slice(0, 10000),
        isSuccess ? "delivered" : (shouldRetry ? "retrying" : "failed"),
        isSuccess ? null : `HTTP ${response.status}`,
        nextRetryAt,
        isSuccess ? new Date() : null,
        deliveryId,
      ]
    );

    await recordWebhookCounter(webhook.id, isSuccess);

    return {
      id: deliveryId,
      status: isSuccess ? "delivered" : (shouldRetry ? "retrying" : "failed"),
      responseStatus: response.status,
      attemptCount: nextAttemptCount,
      nextRetryAt,
    };
  } catch (error) {
    const shouldRetry = nextAttemptCount < maxAttempts;
    const nextRetryAt = shouldRetry ? new Date(Date.now() + getWebhookRetryDelayMs(webhook)) : null;
    const message = error.name === "AbortError"
      ? `Request timed out after ${Math.floor(timeoutMs / 1000)} seconds`
      : error.message;

    await dbQuery(
      `
        UPDATE backend_webhook_deliveries
        SET
          status = $1,
          attempt_count = attempt_count + 1,
          error_message = $2,
          next_retry_at = $3,
          updated_at = NOW()
        WHERE id = $4
      `,
      [
        shouldRetry ? "retrying" : "failed",
        message,
        nextRetryAt,
        deliveryId,
      ]
    );

    await recordWebhookCounter(webhook.id, false);

    return {
      id: deliveryId,
      status: shouldRetry ? "retrying" : "failed",
      error: message,
      attemptCount: nextAttemptCount,
      nextRetryAt,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function deliverWebhook(webhook, eventPayload) {
  const deliveryId = webhookRandomId("whdel");
  const rawBody = JSON.stringify(eventPayload || {});
  const secret = webhook.secret || "";
  const signature = webhookSignature(secret, rawBody);

  const headers = {
    "Content-Type": "application/json",
    "User-Agent": "GoodAppBackEnd-Webhooks/1.0",
    "X-GoodOS-Event": eventPayload.type || eventPayload.eventType || "system.test",
    "X-GoodOS-Webhook-Id": webhook.id,
    "X-GoodOS-Delivery-Id": deliveryId,
  };

  if (signature) {
    headers["X-GoodOS-Signature"] = signature;
  }

  await dbQuery(
    `
      INSERT INTO backend_webhook_deliveries (
        id,
        webhook_id,
        event_id,
        event_type,
        url,
        request_headers,
        request_body,
        status,
        attempt_count
      )
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, 'pending', 0)
    `,
    [
      deliveryId,
      webhook.id,
      eventPayload.id || null,
      eventPayload.type || eventPayload.eventType || "system.test",
      webhook.url,
      JSON.stringify(headers),
      rawBody,
    ]
  );

  return sendWebhookDeliveryAttempt(deliveryId, webhook, eventPayload, rawBody, headers);
}

async function dispatchWebhooksForEvent(eventPayload) {
  const eventType = eventPayload.type || eventPayload.eventType || "system.event";
  const webhooks = await getActiveWebhooksForEvent(eventType);

  if (!webhooks.length) {
    return {
      dispatched: 0,
      eventType,
    };
  }

  const results = await Promise.allSettled(
    webhooks.map((webhook) => deliverWebhook(webhook, eventPayload))
  );

  return {
    dispatched: webhooks.length,
    eventType,
    results,
  };
}

async function processDueWebhookRetries(limit = 25) {
  const safeLimit =
    Math.min(
      Math.max(
        Number(limit || 25),
        1
      ),
      100
    );

  const workerId =
    `webhook-retry-${process.pid}-${Date.now()}`;

  const claimedResult =
    await dbQuery(
      `
        WITH candidates AS (
          SELECT delivery.id

          FROM backend_webhook_deliveries
               AS delivery

          JOIN backend_webhooks
               AS webhook
            ON webhook.id =
               delivery.webhook_id

          WHERE delivery.status IN (
                  'failed',
                  'retrying'
                )

            AND delivery.next_retry_at
                IS NOT NULL

            AND delivery.next_retry_at <=
                NOW()

            AND webhook.status =
                'active'

            AND (
              delivery.locked_until
                IS NULL

              OR delivery.locked_until <
                 NOW()
            )

          ORDER BY
            delivery.next_retry_at ASC,
            delivery.created_at ASC

          FOR UPDATE OF delivery
          SKIP LOCKED

          LIMIT $1
        )

        UPDATE backend_webhook_deliveries
               AS delivery

        SET
          locked_by =
            $2,

          locked_until =
            NOW() +
            INTERVAL '120 seconds'

        FROM candidates

        WHERE delivery.id =
              candidates.id

        RETURNING delivery.id
      `,
      [
        safeLimit,
        workerId,
      ]
    );

  const claimedIds =
    claimedResult.rows.map(
      row => row.id
    );

  if (claimedIds.length === 0) {
    return [];
  }

  const detailResult =
    await dbQuery(
      `
        SELECT
          delivery.id
            AS "deliveryId",

          delivery.request_body
            AS "requestBody",

          webhook.id
            AS "webhookId",

          webhook.name
            AS "webhookName",

          webhook.url
            AS "webhookUrl",

          webhook.events
            AS "webhookEvents",

          webhook.secret
            AS "webhookSecret",

          webhook.status
            AS "webhookStatus",

          webhook.delivery_timeout_seconds
            AS "deliveryTimeoutSeconds",

          webhook.max_retries
            AS "maxRetries",

          webhook.retry_backoff_seconds
            AS "retryBackoffSeconds"

        FROM backend_webhook_deliveries
             AS delivery

        JOIN backend_webhooks
             AS webhook
          ON webhook.id =
             delivery.webhook_id

        WHERE delivery.id =
              ANY($1::text[])

          AND delivery.locked_by =
              $2

          AND webhook.status =
              'active'

        ORDER BY
          delivery.next_retry_at ASC,
          delivery.created_at ASC
      `,
      [
        claimedIds,
        workerId,
      ]
    );

  const detailedIds =
    new Set(
      detailResult.rows.map(
        row => row.deliveryId
      )
    );

  for (const claimedId of claimedIds) {
    if (!detailedIds.has(claimedId)) {
      await dbQuery(
        `
          UPDATE backend_webhook_deliveries
          SET
            locked_by = NULL,
            locked_until = NULL
          WHERE id = $1
            AND locked_by = $2
        `,
        [
          claimedId,
          workerId,
        ]
      );
    }
  }

  const results = [];

  for (const row of detailResult.rows) {
    const eventPayload =
      row.requestBody || {};

    const rawBody =
      JSON.stringify(
        eventPayload
      );

    const webhook = {
      id:
        row.webhookId,

      name:
        row.webhookName,

      url:
        row.webhookUrl,

      events:
        row.webhookEvents || ["*"],

      secret:
        row.webhookSecret || "",

      status:
        row.webhookStatus,

      delivery_timeout_seconds:
        row.deliveryTimeoutSeconds,

      max_retries:
        row.maxRetries,

      retry_backoff_seconds:
        row.retryBackoffSeconds,
    };

    const headers = {
      "Content-Type":
        "application/json",

      "User-Agent":
        "GoodAppBackEnd-Webhooks/1.0",

      "X-GoodOS-Webhook-Id":
        webhook.id,

      "X-GoodOS-Delivery-Id":
        row.deliveryId,

      "X-GoodOS-Signature":
        webhookSignature(
          webhook.secret,
          rawBody
        ),
    };

    try {
      const delivery =
        await sendWebhookDeliveryAttempt(
          row.deliveryId,
          webhook,
          eventPayload,
          rawBody,
          headers
        );

      results.push(delivery);
    } catch (error) {
      results.push({
        id:
          row.deliveryId,

        status:
          "failed",

        error:
          error.message,
      });
    } finally {
      await dbQuery(
        `
          UPDATE backend_webhook_deliveries
          SET
            locked_by = NULL,
            locked_until = NULL
          WHERE id = $1
            AND locked_by = $2
        `,
        [
          row.deliveryId,
          workerId,
        ]
      ).catch(() => {});
    }
  }

  return results;
}
async function getWebhookConsolePayloadDirect() {
  const webhooksResult = await dbQuery(`
    SELECT
      id,
      name,
      url,
      events,
      status,
      created_at AS "createdAt",
      last_triggered_at AS "lastTriggeredAt"
    FROM backend_webhooks
    ORDER BY
      CASE WHEN status = 'active' THEN 0 ELSE 1 END,
      created_at DESC
  `);

  const deliveriesResult = await dbQuery(`
    SELECT
      d.id,
      d.webhook_id AS "webhookId",
      COALESCE(w.name, d.webhook_id) AS "webhookName",
      d.event_id AS "eventId",
      d.event_type AS "eventType",
      d.url,
      d.response_status AS "responseStatus",
      d.status,
      d.attempt_count AS "attemptCount",
      d.error_message AS "errorMessage",
      d.next_retry_at AS "nextRetryAt",
      d.delivered_at AS "deliveredAt",
      d.created_at AS "createdAt",
      d.updated_at AS "updatedAt"
    FROM backend_webhook_deliveries d
    LEFT JOIN backend_webhooks w ON w.id = d.webhook_id
    ORDER BY d.created_at DESC
    LIMIT 250
  `);

  return {
    webhooks: webhooksResult.rows,
    webhookDeliveries: deliveriesResult.rows,
  };
}

router.get("/webhook-deliveries", async (req, res) => {
  try {
    return ok(res, { deliveries: await getWebhookDeliveries() });
  } catch (error) {
    return fail(res, "Failed to load webhook deliveries", 500, error.message);
  }
});

router.post("/webhooks/:id/test", async (req, res) => {
  try {
    const result = await dbQuery(
      `
        SELECT id, name, url, events, secret, status
        FROM backend_webhooks
        WHERE id = $1
        LIMIT 1
      `,
      [req.params.id]
    );

    const webhook = result.rows[0];

    if (!webhook) return fail(res, "Webhook not found", 404);
    if (webhook.status !== "active") return fail(res, "Webhook is not active", 400);

    const eventId = webhookRandomId("evt");

    const eventPayload = {
      id: eventId,
      type: "webhook.test",
      source: "goodapp-backend",
      createdAt: new Date().toISOString(),
      data: {
        message: "GoodAppBackEnd test webhook delivery.",
        webhookId: webhook.id,
        webhookName: webhook.name,
      },
    };

    await dbQuery(
      `
        INSERT INTO backend_events (id, event_type, source, message, payload)
        VALUES ($1, $2, $3, $4, $5::jsonb)
      `,
      [
        eventId,
        "webhook.test",
        "goodapp-backend",
        `Test webhook sent to ${webhook.name}`,
        JSON.stringify(eventPayload),
      ]
    );

    const delivery = await deliverWebhook(webhook, eventPayload);

    return ok(res, { delivery });
  } catch (error) {
    return fail(res, "Failed to send test webhook", 500, error.message);
  }
});

router.post("/webhook-deliveries/:id/retry", async (req, res) => {
  try {
    const result = await dbQuery(
      `
        SELECT
          d.id AS "deliveryId",
          d.request_body AS "requestBody",
          w.id,
          w.name,
          w.url,
          w.secret,
          w.status
        FROM backend_webhook_deliveries d
        JOIN backend_webhooks w ON w.id = d.webhook_id
        WHERE d.id = $1
        LIMIT 1
      `,
      [req.params.id]
    );

    const row = result.rows[0];

    if (!row) return fail(res, "Delivery not found", 404);
    if (row.status !== "active") return fail(res, "Webhook is not active", 400);

    const delivery = await deliverWebhook(
      {
        id: row.id,
        name: row.name,
        url: row.url,
        secret: row.secret,
        status: row.status,
      },
      row.requestBody || {}
    );

    return ok(res, { retriedFrom: row.deliveryId, delivery });
  } catch (error) {
    return fail(res, "Failed to retry webhook delivery", 500, error.message);
  }
});


router.post("/webhooks/create-safe", async (req, res) => {
  try {
    const name = String(req.body?.name || "").trim();
    const url = String(req.body?.url || "").trim();
    const rawEvents = req.body?.events;

    if (!name) return fail(res, "Webhook name is required", 400);
    if (!url) return fail(res, "Webhook URL is required", 400);

    let parsedUrl;
    try {
      parsedUrl = new URL(url);
    } catch {
      return fail(res, "Webhook URL must be a valid URL", 400);
    }

    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      return fail(res, "Webhook URL must start with http:// or https://", 400);
    }

    const events = Array.isArray(rawEvents) && rawEvents.length
      ? rawEvents.map((event) => String(event).trim()).filter(Boolean)
      : ["*"];

    const id = `wh_${crypto.randomUUID().replace(/-/g, "")}`;
    const secret = `whsec_${crypto.randomBytes(24).toString("hex")}`;

    const createdBy =
      req.user?.id ||
      req.auth?.user?.id ||
      req.session?.user?.id ||
      null;

    const result = await dbQuery(
      `
        INSERT INTO backend_webhooks (
          id,
          name,
          url,
          events,
          secret,
          status,
          created_by
        )
        VALUES ($1, $2, $3, $4::text[], $5, 'active', $6)
        RETURNING
          id,
          name,
          url,
          events,
          status,
          created_at AS "createdAt",
          last_triggered_at AS "lastTriggeredAt"
      `,
      [id, name, url, events, secret, createdBy]
    );

    if (typeof createEvent === "function") {
      await createEvent("webhook.created", `Webhook created: ${name}`, {
        webhookId: id,
        name,
        url,
        events,
      });
    }

    return ok(res, {
      webhook: result.rows[0],
      secret,
      warning: "Copy this webhook secret now. It will not be shown again.",
    });
  } catch (error) {
    return fail(res, "Failed to create webhook", 500, error.message);
  }
});


router.get("/webhooks-live", async (req, res) => {
  try {
    const result = await dbQuery(`
      SELECT
        id,
        name,
        url,
        events,
        status,
        description,
        signing_algorithm AS "signingAlgorithm",
        delivery_timeout_seconds AS "deliveryTimeoutSeconds",
        max_retries AS "maxRetries",
        retry_backoff_seconds AS "retryBackoffSeconds",
        failure_count AS "failureCount",
        success_count AS "successCount",
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        last_triggered_at AS "lastTriggeredAt"
      FROM backend_webhooks
      ORDER BY
        CASE WHEN status = 'active' THEN 0 ELSE 1 END,
        created_at DESC
    `);

    return ok(res, { webhooks: result.rows });
  } catch (error) {
    return fail(res, "Failed to load live webhooks", 500, error.message);
  }
});

router.get("/webhook-deliveries-live", async (req, res) => {
  try {
    const result = await dbQuery(`
      SELECT
        d.id,
        d.webhook_id AS "webhookId",
        COALESCE(w.name, d.webhook_id) AS "webhookName",
        d.event_id AS "eventId",
        d.event_type AS "eventType",
        d.url,
        d.response_status AS "responseStatus",
        d.status,
        d.attempt_count AS "attemptCount",
        d.error_message AS "errorMessage",
        d.next_retry_at AS "nextRetryAt",
        d.delivered_at AS "deliveredAt",
        d.created_at AS "createdAt",
        d.updated_at AS "updatedAt"
      FROM backend_webhook_deliveries d
      LEFT JOIN backend_webhooks w ON w.id = d.webhook_id
      ORDER BY d.created_at DESC
      LIMIT 250
    `);

    return ok(res, { deliveries: result.rows });
  } catch (error) {
    return fail(res, "Failed to load live webhook deliveries", 500, error.message);
  }
});




router.get("/webhook-deliveries/:id/detail-safe", async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();

    if (!id) return fail(res, "Delivery id is required", 400);

    const result = await dbQuery(
      `
        SELECT
          d.id,
          d.webhook_id AS "webhookId",
          COALESCE(w.name, d.webhook_id) AS "webhookName",
          d.event_id AS "eventId",
          d.event_type AS "eventType",
          d.url,
          d.request_headers AS "requestHeaders",
          d.request_body AS "requestBody",
          d.response_status AS "responseStatus",
          d.response_headers AS "responseHeaders",
          d.response_body AS "responseBody",
          d.status,
          d.attempt_count AS "attemptCount",
          d.error_message AS "errorMessage",
          d.next_retry_at AS "nextRetryAt",
          d.delivered_at AS "deliveredAt",
          d.replayed_from_delivery_id AS "replayedFromDeliveryId",
          d.replayed_at AS "replayedAt",
          d.replayed_by AS "replayedBy",
          d.created_at AS "createdAt",
          d.updated_at AS "updatedAt"
        FROM backend_webhook_deliveries d
        LEFT JOIN backend_webhooks w ON w.id = d.webhook_id
        WHERE d.id = $1
        LIMIT 1
      `,
      [id]
    );

    const delivery = result.rows[0];

    if (!delivery) return fail(res, "Webhook delivery not found", 404);

    return ok(res, { delivery });
  } catch (error) {
    return fail(res, "Failed to load webhook delivery detail", 500, error.message);
  }
});

router.get("/webhook-test-receipts/:id/detail-safe", async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();

    if (!id) return fail(res, "Receipt id is required", 400);

    const result = await dbQuery(
      `
        SELECT
          id,
          method,
          path,
          headers,
          body,
          query,
          ip,
          created_at AS "createdAt"
        FROM backend_webhook_test_receipts
        WHERE id = $1
        LIMIT 1
      `,
      [id]
    );

    const receipt = result.rows[0];

    if (!receipt) return fail(res, "Webhook receiver receipt not found", 404);

    return ok(res, { receipt });
  } catch (error) {
    return fail(res, "Failed to load webhook receiver receipt detail", 500, error.message);
  }
});

router.get("/webhook-test-receipts-page-data", async (req, res) => {
  try {
    const result = await dbQuery(
      `
        SELECT
          id,
          method,
          path,
          headers,
          body,
          query,
          ip,
          created_at AS "createdAt"
        FROM backend_webhook_test_receipts
        ORDER BY created_at DESC
        LIMIT 250
      `
    );

    return ok(res, {
      receipts: result.rows,
      counts: {
        receipts: result.rows.length,
      },
    });
  } catch (error) {
    return fail(res, "Failed to load webhook receiver receipts", 500, error.message);
  }
});

router.get("/webhooks-page-data", async (req, res) => {
  try {
    const webhooks = await dbQuery(`
      SELECT
        id,
        name,
        url,
        events,
        status,
        description,
        signing_algorithm AS "signingAlgorithm",
        delivery_timeout_seconds AS "deliveryTimeoutSeconds",
        max_retries AS "maxRetries",
        retry_backoff_seconds AS "retryBackoffSeconds",
        failure_count AS "failureCount",
        success_count AS "successCount",
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        last_triggered_at AS "lastTriggeredAt"
      FROM backend_webhooks
      ORDER BY
        CASE WHEN status = 'active' THEN 0 ELSE 1 END,
        created_at DESC
    `);

    const deliveries = await dbQuery(`
      SELECT
        d.id,
        d.webhook_id AS "webhookId",
        COALESCE(w.name, d.webhook_id) AS "webhookName",
        d.event_id AS "eventId",
        d.event_type AS "eventType",
        d.url,
        d.response_status AS "responseStatus",
        d.status,
        d.attempt_count AS "attemptCount",
        d.error_message AS "errorMessage",
        d.delivered_at AS "deliveredAt",
        d.created_at AS "createdAt"
      FROM backend_webhook_deliveries d
      LEFT JOIN backend_webhooks w ON w.id = d.webhook_id
      ORDER BY d.created_at DESC
      LIMIT 250
    `);

    return ok(res, {
      webhooks: webhooks.rows,
      deliveries: deliveries.rows,
      counts: {
        webhooks: webhooks.rows.length,
        active: webhooks.rows.filter((row) => row.status === "active").length,
        deliveries: deliveries.rows.length,
        failed: deliveries.rows.filter((row) => row.status === "failed").length,
      },
    });
  } catch (error) {
    return fail(res, "Failed to load webhooks page data", 500, error.message);
  }
});


router.get("/api-keys-page-data", async (req, res) => {
  try {
    const result = await dbQuery(`
      SELECT
        id,
        name,
        type,
        key_prefix AS "keyPrefix",
        scopes,
        allowed_app_ids AS "allowedAppIds",
        description,
        status,
        last_used_at AS "lastUsedAt",
        revoked_at AS "revokedAt",
        created_at AS "createdAt"
      FROM backend_api_keys
      ORDER BY created_at DESC
      LIMIT 250
    `);

    const rows = result.rows;

    return ok(res, {
      apiKeys: rows,
      counts: {
        total: rows.length,
        active: rows.filter((row) => row.status === "active").length,
        revoked: rows.filter((row) => row.status !== "active").length,
        scoped: rows.filter((row) => row.type === "scoped").length,
      },
    });
  } catch (error) {
    return fail(res, "Failed to load API keys page data", 500, error.message);
  }
});


router.post("/api-keys/create-scoped", async (req, res) => {
  try {
    const name = String(req.body?.name || "").trim();
    const type = String(req.body?.type || "scoped").trim();
    const description = String(req.body?.description || "").trim();

    const scopes = Array.isArray(req.body?.scopes) && req.body.scopes.length
      ? req.body.scopes.map((item) => String(item).trim()).filter(Boolean)
      : ["read:health"];

    const allowedAppIds = Array.isArray(req.body?.allowedAppIds) && req.body.allowedAppIds.length
      ? req.body.allowedAppIds.map((item) => String(item).trim()).filter(Boolean)
      : ["*"];

    if (!name) return fail(res, "API key name is required", 400);

    const id = `key_${crypto.randomUUID().replace(/-/g, "")}`;
    const secret = `gak_${crypto.randomBytes(32).toString("hex")}`;
    const keyHash = crypto.createHash("sha256").update(secret).digest("hex");
    const keyPrefix = secret.slice(0, 18);

    const createdBy =
      req.user?.id ||
      req.auth?.user?.id ||
      req.session?.user?.id ||
      null;

    const result = await dbQuery(
      `
        INSERT INTO backend_api_keys (
          id,
          name,
          type,
          key_prefix,
          key_hash,
          scopes,
          allowed_app_ids,
          description,
          status,
          created_by
        )
        VALUES ($1, $2, $3, $4, $5, $6::text[], $7::text[], $8, 'active', $9)
        RETURNING
          id,
          name,
          type,
          key_prefix AS "keyPrefix",
          scopes,
          allowed_app_ids AS "allowedAppIds",
          description,
          status,
          created_at AS "createdAt"
      `,
      [
        id,
        name,
        type,
        keyPrefix,
        keyHash,
        scopes,
        allowedAppIds,
        description || null,
        createdBy,
      ]
    );

    return ok(res, {
      apiKey: result.rows[0],
      secret,
      warning: "Copy this key now. It will not be shown again.",
    });
  } catch (error) {
    return fail(res, "Failed to create scoped API key", 500, error.message);
  }
});


router.get("/storage-page-data", async (req, res) => {
  try {
    const bucketsResult = await dbQuery(`
      SELECT *
      FROM backend_storage_buckets
      ORDER BY created_at DESC
      LIMIT 250
    `);

    const filesResult = await dbQuery(`
      SELECT *
      FROM backend_storage_files
      ORDER BY created_at DESC
      LIMIT 250
    `);

    const signedUrlsResult = await dbQuery(`
      SELECT *
      FROM backend_storage_signed_urls
      ORDER BY created_at DESC
      LIMIT 250
    `);

    const buckets = bucketsResult.rows;
    const files = filesResult.rows;
    const signedUrls = signedUrlsResult.rows;

    return ok(res, {
      buckets,
      files,
      signedUrls,
      counts: {
        buckets: buckets.length,
        files: files.length,
        signedUrls: signedUrls.length,
        privateBuckets: buckets.filter((row) => row.visibility === "private").length,
        publicBuckets: buckets.filter((row) => row.visibility === "public").length,
      },
    });
  } catch (error) {
    return fail(res, "Failed to load storage page data", 500, error.message);
  }
});

router.post("/storage/buckets/create-safe", async (req, res) => {
  try {
    const name = String(req.body?.name || "").trim().toLowerCase().replace(/[^a-z0-9-_]/g, "-");
    const visibility = String(req.body?.visibility || "private").trim().toLowerCase();

    if (!name) return fail(res, "Bucket name is required", 400);
    if (!["private", "public"].includes(visibility)) {
      return fail(res, "Visibility must be private or public", 400);
    }

    const id = `bucket_${crypto.randomUUID().replace(/-/g, "")}`;

    const result = await dbQuery(
      `
        INSERT INTO backend_storage_buckets (
          id,
          name,
          visibility,
          status
        )
        VALUES ($1, $2, $3, 'active')
        RETURNING *
      `,
      [id, name, visibility]
    );

    return ok(res, {
      bucket: result.rows[0],
      message: "Storage bucket created.",
    });
  } catch (error) {
    if (String(error.message || "").includes("duplicate")) {
      return fail(res, "A bucket with that name already exists", 409, error.message);
    }

    return fail(res, "Failed to create storage bucket", 500, error.message);
  }
});


async function safeTableCount(tableName) {
  try {
    const exists = await dbQuery("SELECT to_regclass($1) AS table_name", [`public.${tableName}`]);
    if (!exists.rows[0]?.table_name) return 0;

    const result = await dbQuery(`SELECT COUNT(*)::int AS count FROM ${tableName}`);
    return Number(result.rows[0]?.count || 0);
  } catch (error) {
    return 0;
  }
}

async function safeDashboardApps() {
  const candidates = [
    "backend_apps",
    "backend_app_registry",
    "backend_registered_apps"
  ];

  for (const tableName of candidates) {
    try {
      const exists = await dbQuery("SELECT to_regclass($1) AS table_name", [`public.${tableName}`]);
      if (!exists.rows[0]?.table_name) continue;

      const result = await dbQuery(`
        SELECT *
        FROM ${tableName}
        ORDER BY created_at DESC NULLS LAST
        LIMIT 50
      `);

      return result.rows.map((row) => ({
        id: row.id || row.app_id || row.slug || "-",
        name: row.name || row.app_name || row.title || row.id || "-",
        domain: row.domain || row.base_url || row.url || "-",
        status: row.status || "active",
        memberCount: row.member_count || row.members || 0,
        createdAt: row.created_at || row.createdAt || null,
      }));
    } catch (error) {
      continue;
    }
  }

  return [];
}

router.get("/dashboard-page-data", async (req, res) => {
  try {
    const apps = await safeDashboardApps();

    const counts = {
      users: await safeTableCount("backend_users"),
      apps: apps.length || await safeTableCount("backend_apps"),
      memberships: await safeTableCount("backend_app_memberships"),
      sessions: await safeTableCount("backend_sessions"),
      apiKeys: await safeTableCount("backend_api_keys"),
      webhooks: await safeTableCount("backend_webhooks"),
      storageBuckets: await safeTableCount("backend_storage_buckets"),
      storageFiles: await safeTableCount("backend_storage_files"),
    };

    const memory = process.memoryUsage();

    return ok(res, {
      counts,
      apps,
      runtime: {
        environment: process.env.NODE_ENV || "production",
        version: process.env.APP_VERSION || "1.0.0",
        node: process.version,
        uptimeSeconds: Math.floor(process.uptime()),
        uptime: `${Math.floor(process.uptime() / 60)} min`,
        memoryHeapMb: Math.round(memory.heapUsed / 1024 / 1024),
        database: "connected",
      },
    });
  } catch (error) {
    return fail(res, "Failed to load dashboard page data", 500, error.message);
  }
});



function buildModuleReadiness(counts = {}) {
  const checks = [
    { module: "Auth / Users", key: "users", value: Number(counts.users || 0), required: 1, status: Number(counts.users || 0) >= 1 ? "ready" : "missing", detail: "Owner account and user records" },
    { module: "App Registry", key: "apps", value: Number(counts.apps || 0), required: 10, status: Number(counts.apps || 0) >= 10 ? "ready" : "partial", detail: "Registered GoodOS apps" },
    { module: "App Memberships", key: "memberships", value: Number(counts.memberships || 0), required: Number(counts.apps || 0), status: Number(counts.memberships || 0) >= Number(counts.apps || 0) ? "ready" : "partial", detail: "App access grants" },
    { module: "API Keys", key: "apiKeys", value: Number(counts.apiKeys || 0), required: 1, status: Number(counts.apiKeys || 0) >= 1 ? "ready" : "missing", detail: "Scoped public API keys" },
    { module: "Storage / Files", key: "buckets", value: Number(counts.buckets || 0), required: 1, status: Number(counts.buckets || 0) >= 1 ? "ready" : "missing", detail: "Storage buckets configured" },
    { module: "Storage Files", key: "files", value: Number(counts.files || 0), required: 1, status: Number(counts.files || 0) >= 1 ? "ready" : "partial", detail: "File tracking records" },
    { module: "Webhooks", key: "webhooks", value: Number(counts.webhooks || 0), required: 1, status: Number(counts.webhooks || 0) >= 1 ? "ready" : "missing", detail: "Webhook endpoints" },
    { module: "Webhook Deliveries", key: "webhookDeliveries", value: Number(counts.webhookDeliveries || 0), required: 1, status: Number(counts.webhookDeliveries || 0) >= 1 ? "ready" : "partial", detail: "Delivery logs" },
    { module: "Realtime Events", key: "realtimeEvents", value: Number(counts.realtimeEvents || 0), required: 1, status: Number(counts.realtimeEvents || 0) >= 1 ? "ready" : "partial", detail: "Realtime stream records" },
    { module: "Edge Functions", key: "edgeFunctions", value: Number(counts.edgeFunctions || 0), required: 1, status: Number(counts.edgeFunctions || 0) >= 1 ? "ready" : "missing", detail: "Function registry" },
    { module: "Function Runs", key: "functionRuns", value: Number(counts.functionRuns || 0), required: 1, status: Number(counts.functionRuns || 0) >= 1 ? "ready" : "partial", detail: "Execution logs" },
    { module: "Backups", key: "backups", value: Number(counts.backups || 0), required: 1, status: Number(counts.backups || 0) >= 1 ? "ready" : "partial", detail: "Database backups" },
    { module: "Settings", key: "settings", value: Number(counts.settings || 0), required: 40, status: Number(counts.settings || 0) >= 40 ? "ready" : "partial", detail: "Platform settings" },
    { module: "Audit Trail", key: "auditLogs", value: Number(counts.auditLogs || 0), required: 1, status: Number(counts.auditLogs || 0) >= 1 ? "ready" : "partial", detail: "Admin audit records" },
    { module: "System Logs", key: "systemLogs", value: Number(counts.systemLogs || 0), required: 1, status: Number(counts.systemLogs || 0) >= 1 ? "ready" : "partial", detail: "Operational logs" },
  ];

  const ready = checks.filter((item) => item.status === "ready").length;
  const partial = checks.filter((item) => item.status === "partial").length;
  const missing = checks.filter((item) => item.status === "missing").length;

  return {
    checks,
    score: {
      ready,
      partial,
      missing,
      total: checks.length,
      percent: Math.round((ready / checks.length) * 100),
    },
  };
}


async function safeActivityCount(tableName, whereClause = "") {
  try {
    const safeName = String(tableName || "").trim();
    if (!/^[a-zA-Z0-9_]+$/.test(safeName)) return 0;

    const exists = await dbQuery("SELECT to_regclass($1) AS table_name", [`public.${safeName}`]);
    if (!exists.rows[0]?.table_name) return 0;

    const whereSql = whereClause ? ` WHERE ${whereClause}` : "";
    const result = await dbQuery(`SELECT COUNT(*)::int AS count FROM ${safeName}${whereSql}`);
    return Number(result.rows[0]?.count || 0);
  } catch (error) {
    console.warn("[activity-center] safe count failed:", tableName, error.message);
    return 0;
  }
}

async function safeActivityRows(label, sql, params = []) {
  try {
    const result = await dbQuery(sql, params);
    return result.rows || [];
  } catch (error) {
    console.warn("[activity-center] safe rows failed:", label, error.message);
    return [];
  }
}

async function safeActivityTimeline(tableName, dateColumn = "created_at", days = 30, cumulative = false, whereClause = "") {
  try {
    const safeTable = String(tableName || "").trim();
    const safeColumn = String(dateColumn || "").trim();
    const safeDays = Math.max(7, Math.min(90, Number(days) || 30));

    if (!/^[a-zA-Z0-9_]+$/.test(safeTable) || !/^[a-zA-Z0-9_]+$/.test(safeColumn)) {
      return [];
    }

    const exists = await dbQuery("SELECT to_regclass($1) AS table_name", [`public.${safeTable}`]);
    if (!exists.rows[0]?.table_name) return [];

    const startOffset = safeDays - 1;
    const filterSql = whereClause ? ` AND (${whereClause})` : "";
    const valueExpression = cumulative
      ? "prior.total + SUM(COALESCE(daily.count, 0)) OVER (ORDER BY days.day)"
      : "COALESCE(daily.count, 0)";

    const result = await dbQuery(`
      WITH days AS (
        SELECT generate_series(
          CURRENT_DATE - $1::int,
          CURRENT_DATE,
          INTERVAL '1 day'
        )::date AS day
      ),
      daily AS (
        SELECT ${safeColumn}::date AS day, COUNT(*)::int AS count
        FROM ${safeTable}
        WHERE ${safeColumn} >= CURRENT_DATE - $1::int${filterSql}
        GROUP BY ${safeColumn}::date
      ),
      prior AS (
        SELECT COUNT(*)::int AS total
        FROM ${safeTable}
        WHERE ${safeColumn} < CURRENT_DATE - $1::int${filterSql}
      )
      SELECT
        TO_CHAR(days.day, 'YYYY-MM-DD') AS date,
        (${valueExpression})::int AS value
      FROM days
      CROSS JOIN prior
      LEFT JOIN daily ON daily.day = days.day
      ORDER BY days.day ASC
    `, [startOffset]);

    return result.rows || [];
  } catch (error) {
    console.warn(`[activity-center] ${tableName} timeline failed:`, error.message);
    return [];
  }
}

async function activityCenterCounts() {
  return {
    users: await safeActivityCount("users"),
    activeUsers: await safeActivityCount("users", "status = 'active'"),
    apps: await safeActivityCount("apps"),
    activeApps: await safeActivityCount("apps", "status = 'active'"),
    memberships: await safeActivityCount("app_memberships"),
    activeMemberships: await safeActivityCount("app_memberships", "status = 'active'"),
    sessions: await safeActivityCount("sessions", "revoked_at IS NULL AND expires_at > NOW()"),
    apiKeys: await safeActivityCount("backend_api_keys"),
    activeApiKeys: await safeActivityCount("backend_api_keys", "status = 'active'"),
    buckets: await safeActivityCount("backend_storage_buckets"),
    files: await safeActivityCount("backend_storage_files"),
    webhooks: await safeActivityCount("backend_webhooks"),
    activeWebhooks: await safeActivityCount("backend_webhooks", "status = 'active'"),
    webhookDeliveries: await safeActivityCount("backend_webhook_deliveries"),
    realtimeEvents: await safeActivityCount("backend_realtime_events"),
    edgeFunctions: await safeActivityCount("backend_edge_functions"),
    functionRuns: await safeActivityCount("backend_edge_function_runs"),
    backups: await safeActivityCount("backend_database_backups"),
    settings: await safeActivityCount("backend_platform_settings"),
    auditLogs: await safeActivityCount("backend_admin_audit_logs"),
    systemLogs: await safeActivityCount("backend_system_logs"),
    events: await safeActivityCount("backend_events"),
  };
}



function normalizeProjectSlug(value, fallback = "project") {
  return String(value || fallback)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 90) || fallback;
}

function normalizeProjectStatus(value, fallback = "active") {
  const status = String(value || fallback).trim().toLowerCase();
  if (["active", "planned", "disabled", "archived"].includes(status)) return status;
  return fallback;
}

function normalizeEnvironmentType(value, fallback = "production") {
  const type = String(value || fallback).trim().toLowerCase();
  if (["development", "staging", "production", "preview", "test"].includes(type)) return type;
  return fallback;
}

router.get("/projects-page-data", async (req, res) => {
  try {
    const organizationsResult = await dbQuery(`
      SELECT
        id,
        name,
        slug,
        plan,
        status,
        owner_user_id::text AS "ownerUserId",
        metadata_json AS "metadata",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM backend_organizations
      ORDER BY created_at ASC
      LIMIT 100
    `);

    const projectsResult = await dbQuery(`
      SELECT
        p.id,
        p.organization_id AS "organizationId",
        o.name AS "organizationName",
        p.name,
        p.slug,
        p.status,
        p.description,
        p.metadata_json AS "metadata",
        p.created_at AS "createdAt",
        p.updated_at AS "updatedAt",
        COUNT(pe.id)::int AS "environmentCount"
      FROM backend_projects p
      LEFT JOIN backend_organizations o ON o.id = p.organization_id
      LEFT JOIN backend_project_environments pe ON pe.project_id = p.id
      GROUP BY p.id, o.name
      ORDER BY p.created_at ASC
      LIMIT 100
    `);

    const environmentsResult = await dbQuery(`
      SELECT
        pe.id,
        pe.project_id AS "projectId",
        p.name AS "projectName",
        p.organization_id AS "organizationId",
        o.name AS "organizationName",
        pe.name,
        pe.slug,
        pe.type,
        pe.status,
        pe.api_base_url AS "apiBaseUrl",
        pe.metadata_json AS "metadata",
        pe.created_at AS "createdAt",
        pe.updated_at AS "updatedAt",
        (SELECT COUNT(*)::int FROM apps WHERE environment_id = pe.id) AS apps,
        (SELECT COUNT(*)::int FROM backend_api_keys WHERE environment_id = pe.id) AS "apiKeys",
        (SELECT COUNT(*)::int FROM backend_storage_buckets WHERE environment_id = pe.id) AS buckets,
        (SELECT COUNT(*)::int FROM backend_webhooks WHERE environment_id = pe.id) AS webhooks,
        (SELECT COUNT(*)::int FROM backend_edge_functions WHERE environment_id = pe.id) AS functions,
        (SELECT COUNT(*)::int FROM backend_events WHERE environment_id = pe.id) AS events
      FROM backend_project_environments pe
      JOIN backend_projects p ON p.id = pe.project_id
      JOIN backend_organizations o ON o.id = p.organization_id
      ORDER BY
        CASE pe.type
          WHEN 'production' THEN 0
          WHEN 'staging' THEN 1
          WHEN 'development' THEN 2
          ELSE 3
        END,
        pe.created_at ASC
      LIMIT 150
    `);

    const orgMembershipsResult = await dbQuery(`
      SELECT
        om.id,
        om.organization_id AS "organizationId",
        o.name AS "organizationName",
        om.user_id::text AS "userId",
        u.email,
        COALESCE(u.display_name, u.email) AS "displayName",
        om.role,
        om.status,
        om.created_at AS "createdAt",
        om.updated_at AS "updatedAt"
      FROM backend_organization_memberships om
      LEFT JOIN backend_organizations o ON o.id = om.organization_id
      LEFT JOIN users u ON u.id = om.user_id
      ORDER BY om.created_at DESC
      LIMIT 150
    `);

    const projectMembershipsResult = await dbQuery(`
      SELECT
        pm.id,
        pm.project_id AS "projectId",
        p.name AS "projectName",
        pm.user_id::text AS "userId",
        u.email,
        COALESCE(u.display_name, u.email) AS "displayName",
        pm.role,
        pm.status,
        pm.created_at AS "createdAt",
        pm.updated_at AS "updatedAt"
      FROM backend_project_memberships pm
      LEFT JOIN backend_projects p ON p.id = pm.project_id
      LEFT JOIN users u ON u.id = pm.user_id
      ORDER BY pm.created_at DESC
      LIMIT 150
    `);

    const mappingsResult = await dbQuery(`
      SELECT
        'apps' AS module,
        COUNT(*)::int AS count,
        COUNT(*) FILTER (WHERE environment_id IS NOT NULL)::int AS "scopedCount"
      FROM apps
      UNION ALL
      SELECT 'api_keys', COUNT(*)::int, COUNT(*) FILTER (WHERE environment_id IS NOT NULL)::int FROM backend_api_keys
      UNION ALL
      SELECT 'storage_buckets', COUNT(*)::int, COUNT(*) FILTER (WHERE environment_id IS NOT NULL)::int FROM backend_storage_buckets
      UNION ALL
      SELECT 'storage_files', COUNT(*)::int, COUNT(*) FILTER (WHERE environment_id IS NOT NULL)::int FROM backend_storage_files
      UNION ALL
      SELECT 'webhooks', COUNT(*)::int, COUNT(*) FILTER (WHERE environment_id IS NOT NULL)::int FROM backend_webhooks
      UNION ALL
      SELECT 'webhook_deliveries', COUNT(*)::int, COUNT(*) FILTER (WHERE environment_id IS NOT NULL)::int FROM backend_webhook_deliveries
      UNION ALL
      SELECT 'realtime_events', COUNT(*)::int, COUNT(*) FILTER (WHERE environment_id IS NOT NULL)::int FROM backend_realtime_events
      UNION ALL
      SELECT 'edge_functions', COUNT(*)::int, COUNT(*) FILTER (WHERE environment_id IS NOT NULL)::int FROM backend_edge_functions
      UNION ALL
      SELECT 'function_runs', COUNT(*)::int, COUNT(*) FILTER (WHERE environment_id IS NOT NULL)::int FROM backend_edge_function_runs
      UNION ALL
      SELECT 'backups', COUNT(*)::int, COUNT(*) FILTER (WHERE environment_id IS NOT NULL)::int FROM backend_database_backups
      UNION ALL
      SELECT 'settings', COUNT(*)::int, COUNT(*) FILTER (WHERE environment_id IS NOT NULL)::int FROM backend_platform_settings
    `);

    const organizations = organizationsResult.rows;
    const projects = projectsResult.rows;
    const environments = environmentsResult.rows;
    const moduleMappings = mappingsResult.rows;
    const generatedAt = new Date();
    const dayMilliseconds = 24 * 60 * 60 * 1000;
    const projectWindowDays = 30;
    const projectWindowEnd = new Date(generatedAt);
    projectWindowEnd.setUTCHours(23, 59, 59, 999);
    const projectWindowStart = new Date(
      projectWindowEnd.getTime() - ((projectWindowDays - 1) * dayMilliseconds)
    );
    projectWindowStart.setUTCHours(0, 0, 0, 0);
    const projectCreatedDates = projects
      .map((project) => new Date(project.createdAt))
      .filter((date) => !Number.isNaN(date.getTime()));
    const projectsWithoutDates = Math.max(0, projects.length - projectCreatedDates.length);
    const projectSeries = Array.from({ length: projectWindowDays }, (_, index) => {
      const date = new Date(projectWindowStart.getTime() + (index * dayMilliseconds));
      const cutoff = new Date(date);
      cutoff.setUTCHours(23, 59, 59, 999);

      return {
        date: date.toISOString().slice(0, 10),
        total:
          projectsWithoutDates +
          projectCreatedDates.filter((createdAt) => createdAt.getTime() <= cutoff.getTime()).length,
      };
    });
    const environmentTypes = environments.reduce(
      (summary, environment) => {
        const type = String(environment.type || "other").toLowerCase();
        if (Object.prototype.hasOwnProperty.call(summary, type)) {
          summary[type] += 1;
        } else {
          summary.other += 1;
        }
        return summary;
      },
      {
        development: 0,
        staging: 0,
        production: 0,
        other: 0,
      }
    );
    const totalScopedRecords = moduleMappings.reduce(
      (total, item) => total + Number(item.scopedCount || 0),
      0
    );
    const totalModuleRecords = moduleMappings.reduce(
      (total, item) => total + Number(item.count || 0),
      0
    );
    const recordScopePercent = totalModuleRecords
      ? Math.round((totalScopedRecords / totalModuleRecords) * 100)
      : 0;

    return ok(res, {
      organizations,
      projects,
      environments,
      orgMemberships: orgMembershipsResult.rows,
      projectMemberships: projectMembershipsResult.rows,
      moduleMappings,
      charts: {
        generatedAt: generatedAt.toISOString(),
        organizations: {
          total: organizations.length,
          active: organizations.filter((item) => item.status === "active").length,
          inactive: organizations.filter((item) => item.status !== "active").length,
        },
        projects: {
          windowDays: projectWindowDays,
          series: projectSeries,
        },
        environments: environmentTypes,
        moduleScope: {
          scopedRecords: totalScopedRecords,
          totalRecords: totalModuleRecords,
          percent: recordScopePercent,
          modules: moduleMappings.map((item) => ({
            module: item.module,
            scopedRecords: Number(item.scopedCount || 0),
            totalRecords: Number(item.count || 0),
          })),
        },
      },
      counts: {
        organizations: organizations.length,
        activeOrganizations: organizations.filter((item) => item.status === "active").length,
        projects: projects.length,
        activeProjects: projects.filter((item) => item.status === "active").length,
        environments: environments.length,
        productionEnvironments: environments.filter((item) => item.type === "production").length,
        scopedModules: moduleMappings.filter((item) => Number(item.count || 0) === Number(item.scopedCount || 0)).length,
        totalModules: moduleMappings.length,
        scopedRecords: totalScopedRecords,
        totalRecords: totalModuleRecords,
        recordScopePercent,
      },
    });
  } catch (error) {
    return fail(res, "Failed to load project control center", 500, error.message);
  }
});

router.get("/projects/:id/detail-safe", async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();

    const projectResult = await dbQuery(
      `
        SELECT
          p.id,
          p.organization_id AS "organizationId",
          o.name AS "organizationName",
          p.name,
          p.slug,
          p.status,
          p.description,
          p.metadata_json AS "metadata",
          p.created_at AS "createdAt",
          p.updated_at AS "updatedAt"
        FROM backend_projects p
        LEFT JOIN backend_organizations o ON o.id = p.organization_id
        WHERE p.id = $1
        LIMIT 1
      `,
      [id]
    );

    const project = projectResult.rows[0];
    if (!project) return fail(res, "Project not found", 404);

    const environments = await dbQuery(
      `
        SELECT
          id,
          name,
          slug,
          type,
          status,
          api_base_url AS "apiBaseUrl",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM backend_project_environments
        WHERE project_id = $1
        ORDER BY created_at ASC
      `,
      [id]
    );

    const apps = await dbQuery(
      `
        SELECT id, name, domain, status
        FROM apps
        WHERE project_id = $1
        ORDER BY name ASC
      `,
      [id]
    );

    return ok(res, {
      project,
      environments: environments.rows,
      apps: apps.rows,
    });
  } catch (error) {
    return fail(res, "Failed to load project detail", 500, error.message);
  }
});

router.post("/projects/create-safe", async (req, res) => {
  try {
    const organizationId = String(req.body?.organizationId || "org_goodos").trim();
    const name = String(req.body?.name || "").trim();
    const slug = normalizeProjectSlug(req.body?.slug || name);
    const id = normalizeProjectSlug(req.body?.id || `proj_${slug}`);
    const status = normalizeProjectStatus(req.body?.status || "active");
    const description = String(req.body?.description || "").trim();

    if (!name) return fail(res, "Project name is required", 400);

    const orgCheck = await dbQuery("SELECT id FROM backend_organizations WHERE id = $1 LIMIT 1", [organizationId]);
    if (!orgCheck.rows[0]) return fail(res, "Organization not found", 404);

    const result = await dbQuery(
      `
        INSERT INTO backend_projects (
          id,
          organization_id,
          name,
          slug,
          status,
          description,
          metadata_json
        )
        VALUES ($1, $2, $3, $4, $5, NULLIF($6, ''), $7::jsonb)
        RETURNING
          id,
          organization_id AS "organizationId",
          name,
          slug,
          status,
          description,
          metadata_json AS "metadata",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
      `,
      [
        id,
        organizationId,
        name,
        slug,
        status,
        description,
        JSON.stringify({ createdFrom: "GoodAppBackEnd Console" }),
      ]
    );

    await dbQuery(
      `
        INSERT INTO backend_project_environments (
          id,
          project_id,
          name,
          slug,
          type,
          status,
          api_base_url,
          metadata_json
        )
        VALUES ($1, $2, 'Production', 'production', 'production', 'active', 'https://base.goodos.app', $3::jsonb)
        ON CONFLICT (id) DO NOTHING
      `,
      [
        `env_${id}_production`.slice(0, 120),
        id,
        JSON.stringify({ createdFrom: "Project creation", default: true }),
      ]
    );

    await dbQuery(
      `
        INSERT INTO backend_admin_audit_logs (
          id,
          actor,
          action,
          target_type,
          target_id,
          after_json,
          organization_id,
          project_id,
          environment_id,
          ip_address,
          user_agent
        )
        VALUES ($1, $2, 'project.create', 'project', $3, $4::jsonb, $5, $3, NULL, $6, $7)
      `,
      [
        `audit_${crypto.randomUUID().replace(/-/g, "")}`,
        req.user?.email || req.session?.user?.email || req.auth?.user?.email || "console-user",
        id,
        JSON.stringify(result.rows[0]),
        organizationId,
        req.headers["x-forwarded-for"] || req.socket?.remoteAddress || null,
        req.headers["user-agent"] || null,
      ]
    );

    return ok(res, {
      project: result.rows[0],
      message: "Project created with a default Production environment.",
    });
  } catch (error) {
    if (String(error.message || "").includes("duplicate key")) {
      return fail(res, "Project already exists", 409, error.message);
    }

    return fail(res, "Failed to create project", 500, error.message);
  }
});

router.post("/projects/:id/environments/create-safe", async (req, res) => {
  try {
    const projectId = String(req.params.id || "").trim();
    const name = String(req.body?.name || "").trim();
    const type = normalizeEnvironmentType(req.body?.type || name || "production");
    const slug = normalizeProjectSlug(req.body?.slug || type);
    const id = normalizeProjectSlug(req.body?.id || `env_${projectId}_${slug}`);
    const status = normalizeProjectStatus(req.body?.status || "active");
    const apiBaseUrl = String(req.body?.apiBaseUrl || "https://base.goodos.app").trim();

    if (!name) return fail(res, "Environment name is required", 400);

    const projectCheck = await dbQuery("SELECT id, organization_id FROM backend_projects WHERE id = $1 LIMIT 1", [projectId]);
    const project = projectCheck.rows[0];
    if (!project) return fail(res, "Project not found", 404);

    const result = await dbQuery(
      `
        INSERT INTO backend_project_environments (
          id,
          project_id,
          name,
          slug,
          type,
          status,
          api_base_url,
          metadata_json
        )
        VALUES ($1, $2, $3, $4, $5, $6, NULLIF($7, ''), $8::jsonb)
        RETURNING
          id,
          project_id AS "projectId",
          name,
          slug,
          type,
          status,
          api_base_url AS "apiBaseUrl",
          metadata_json AS "metadata",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
      `,
      [
        id,
        projectId,
        name,
        slug,
        type,
        status,
        apiBaseUrl,
        JSON.stringify({ createdFrom: "GoodAppBackEnd Console" }),
      ]
    );

    await dbQuery(
      `
        INSERT INTO backend_admin_audit_logs (
          id,
          actor,
          action,
          target_type,
          target_id,
          after_json,
          organization_id,
          project_id,
          environment_id,
          ip_address,
          user_agent
        )
        VALUES ($1, $2, 'project.environment.create', 'project_environment', $3, $4::jsonb, $5, $6, $3, $7, $8)
      `,
      [
        `audit_${crypto.randomUUID().replace(/-/g, "")}`,
        req.user?.email || req.session?.user?.email || req.auth?.user?.email || "console-user",
        id,
        JSON.stringify(result.rows[0]),
        project.organization_id,
        projectId,
        req.headers["x-forwarded-for"] || req.socket?.remoteAddress || null,
        req.headers["user-agent"] || null,
      ]
    );

    return ok(res, {
      environment: result.rows[0],
      message: "Project environment created.",
    });
  } catch (error) {
    if (String(error.message || "").includes("duplicate key")) {
      return fail(res, "Environment already exists for this project", 409, error.message);
    }

    return fail(res, "Failed to create project environment", 500, error.message);
  }
});

router.get("/dashboard-activity-page-data", async (req, res) => {
  try {
    const snapshot =
      await dashboardActivityService.getDashboardActivitySnapshot({
        limit: req.query?.limit,
      });

    return ok(res, snapshot);
  } catch (error) {
    return fail(
      res,
      "Failed to load dashboard activity data",
      500,
      error.message
    );
  }
});


router.get("/activity-center-page-data", async (req, res) => {
  try {
    const counts = await activityCenterCounts();
    const readiness = buildModuleReadiness(counts);
    const generatedAt = new Date().toISOString();

    const [
      usersTimeline,
      appsTimeline,
      membershipsTimeline,
      apiKeysTimeline,
      webhooksTimeline,
      realtimeTimeline,
      functionRunsTimeline,
    ] = await Promise.all([
      safeActivityTimeline("users", "created_at", 30, true, "status = 'active'"),
      safeActivityTimeline("apps", "created_at", 30, true, "status = 'active'"),
      safeActivityTimeline("app_memberships", "created_at", 30, true, "status = 'active'"),
      safeActivityTimeline("backend_api_keys", "created_at", 30, true, "status = 'active'"),
      safeActivityTimeline("backend_webhooks", "created_at", 30, true, "status = 'active'"),
      safeActivityTimeline("backend_realtime_events", "created_at", 30, false),
      safeActivityTimeline("backend_edge_function_runs", "created_at", 30, false),
    ]);

    const events = await safeActivityRows("backend_events", `
      SELECT
        id,
        event_type AS "eventType",
        source,
        message,
        payload,
        created_at AS "createdAt"
      FROM backend_events
      ORDER BY created_at DESC
      LIMIT 80
    `);

    const auditLogs = await safeActivityRows("backend_admin_audit_logs", `
      SELECT
        id,
        actor,
        action,
        target_type AS "targetType",
        target_id AS "targetId",
        after_json AS "afterJson",
        ip_address AS "ipAddress",
        created_at AS "createdAt"
      FROM backend_admin_audit_logs
      ORDER BY created_at DESC
      LIMIT 80
    `);

    const logs = await safeActivityRows("backend_system_logs", `
      SELECT
        id,
        source,
        level,
        message,
        context,
        created_at AS "createdAt"
      FROM backend_system_logs
      ORDER BY created_at DESC
      LIMIT 80
    `);

    const recentApps = await safeActivityRows("apps", `
      SELECT
        id,
        name,
        domain,
        status,
        updated_at AS "updatedAt"
      FROM apps
      ORDER BY updated_at DESC NULLS LAST, created_at DESC
      LIMIT 20
    `);

    const runtimeMemory = process.memoryUsage();

    return ok(res, {
      counts,
      readiness,
      charts: {
        generatedAt,
        timelines: {
          users: usersTimeline,
          apps: appsTimeline,
          memberships: membershipsTimeline,
          apiKeys: apiKeysTimeline,
          webhooks: webhooksTimeline,
          realtimeEvents: realtimeTimeline,
          functionRuns: functionRunsTimeline,
        },
      },
      events,
      auditLogs,
      logs,
      recentApps,
      runtime: {
        environment: process.env.NODE_ENV || "production",
        version: process.env.APP_VERSION || "1.0.0",
        node: process.version,
        uptimeSeconds: Math.floor(process.uptime()),
        uptimeFormatted: `${Math.floor(process.uptime() / 3600)}h ${Math.floor((process.uptime() % 3600) / 60)}m`,
        memoryMb: {
          heapUsed: Math.round(runtimeMemory.heapUsed / 1024 / 1024),
          heapTotal: Math.round(runtimeMemory.heapTotal / 1024 / 1024),
          rss: Math.round(runtimeMemory.rss / 1024 / 1024),
        },
      },
    });
  } catch (error) {
    console.error("[activity-center] route failed:", error);
    return ok(res, {
      counts: {},
      readiness: buildModuleReadiness({}),
      events: [],
      auditLogs: [],
      logs: [],
      recentApps: [],
      runtime: {
        environment: process.env.NODE_ENV || "production",
        version: process.env.APP_VERSION || "1.0.0",
        node: process.version,
        uptimeSeconds: Math.floor(process.uptime()),
        uptimeFormatted: `${Math.floor(process.uptime() / 3600)}h ${Math.floor((process.uptime() % 3600) / 60)}m`,
        memoryMb: {
          heapUsed: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
          heapTotal: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
          rss: Math.round(process.memoryUsage().rss / 1024 / 1024),
        },
      },
      warning: error.message,
    });
  }
});


router.get("/global-search-safe", async (req, res) => {
  try {
    const q = String(req.query?.q || "").trim();
    const limit = Math.min(Math.max(Number(req.query?.limit || 10), 3), 25);

    if (!q || q.length < 2) {
      return ok(res, {
        query: q,
        results: [],
        counts: { total: 0 },
      });
    }

    const term = `%${q}%`;
    const results = [];

    const apps = await dbQuery(
      `
        SELECT id, name, domain, status, description
        FROM apps
        WHERE id ILIKE $1 OR name ILIKE $1 OR domain ILIKE $1 OR description ILIKE $1
        ORDER BY name ASC
        LIMIT $2
      `,
      [term, limit]
    );

    results.push(...apps.rows.map((row) => ({
      type: "App",
      title: row.name || row.id,
      subtitle: row.domain || row.status || "",
      detail: row.description || "",
      id: row.id,
      view: "apps",
    })));

    const users = await dbQuery(
      `
        SELECT id::text, email, display_name, platform_role, status
        FROM users
        WHERE email ILIKE $1 OR display_name ILIKE $1 OR platform_role ILIKE $1 OR status ILIKE $1
        ORDER BY created_at DESC
        LIMIT $2
      `,
      [term, limit]
    );

    results.push(...users.rows.map((row) => ({
      type: "User",
      title: row.display_name || row.email,
      subtitle: row.email || row.platform_role || "",
      detail: `${row.platform_role || ""} ${row.status || ""}`.trim(),
      id: row.id,
      view: "users",
    })));

    const apiKeys = await dbQuery(
      `
        SELECT id, name, key_prefix, status, scopes, allowed_app_ids
        FROM backend_api_keys
        WHERE name ILIKE $1 OR key_prefix ILIKE $1 OR id ILIKE $1 OR $3 = ANY(scopes) OR $3 = ANY(allowed_app_ids)
        ORDER BY created_at DESC
        LIMIT $2
      `,
      [term, limit, q]
    );

    results.push(...apiKeys.rows.map((row) => ({
      type: "API Key",
      title: row.name || row.id,
      subtitle: row.key_prefix || "",
      detail: `${row.status || ""} ${(row.scopes || []).join(", ")}`.trim(),
      id: row.id,
      view: "keys",
    })));

    const storage = await dbQuery(
      `
        SELECT id, original_name, display_name, bucket_name, folder_path, status
        FROM backend_storage_files
        WHERE id ILIKE $1 OR original_name ILIKE $1 OR display_name ILIKE $1 OR bucket_name ILIKE $1 OR folder_path ILIKE $1
        ORDER BY created_at DESC
        LIMIT $2
      `,
      [term, limit]
    );

    results.push(...storage.rows.map((row) => ({
      type: "Storage File",
      title: row.display_name || row.original_name || row.id,
      subtitle: row.bucket_name || "",
      detail: `${row.folder_path || ""} ${row.status || ""}`.trim(),
      id: row.id,
      view: "storage",
    })));

    const webhooks = await dbQuery(
      `
        SELECT id, name, url, status, events
        FROM backend_webhooks
        WHERE id ILIKE $1 OR name ILIKE $1 OR url ILIKE $1 OR $3 = ANY(events)
        ORDER BY created_at DESC
        LIMIT $2
      `,
      [term, limit, q]
    );

    results.push(...webhooks.rows.map((row) => ({
      type: "Webhook",
      title: row.name || row.id,
      subtitle: row.url || "",
      detail: `${row.status || ""} ${(row.events || []).join(", ")}`.trim(),
      id: row.id,
      view: "webhooks",
    })));

    const functions = await dbQuery(
      `
        SELECT id, name, route_path, status, description
        FROM backend_edge_functions
        WHERE id ILIKE $1 OR name ILIKE $1 OR route_path ILIKE $1 OR description ILIKE $1
        ORDER BY created_at DESC
        LIMIT $2
      `,
      [term, limit]
    );

    results.push(...functions.rows.map((row) => ({
      type: "Edge Function",
      title: row.name || row.id,
      subtitle: row.route_path || "",
      detail: `${row.status || ""} ${row.description || ""}`.trim(),
      id: row.id,
      view: "functions",
    })));

    const settings = await dbQuery(
      `
        SELECT id, category, setting_key, label, status
        FROM backend_platform_settings
        WHERE category ILIKE $1 OR setting_key ILIKE $1 OR label ILIKE $1
        ORDER BY category ASC, setting_key ASC
        LIMIT $2
      `,
      [term, limit]
    );

    results.push(...settings.rows.map((row) => ({
      type: "Setting",
      title: row.label || row.setting_key,
      subtitle: row.category || "",
      detail: `${row.setting_key || ""} ${row.status || ""}`.trim(),
      id: row.id,
      view: "settings",
    })));

    const logs = await dbQuery(
      `
        SELECT id, source, level, message, created_at
        FROM backend_system_logs
        WHERE source ILIKE $1 OR level ILIKE $1 OR message ILIKE $1
        ORDER BY created_at DESC
        LIMIT $2
      `,
      [term, limit]
    );

    results.push(...logs.rows.map((row) => ({
      type: "Log",
      title: row.message || row.id,
      subtitle: `${row.level || ""} ${row.source || ""}`.trim(),
      detail: row.created_at,
      id: row.id,
      view: "logs",
    })));

    const audit = await dbQuery(
      `
        SELECT id, actor, action, target_type, target_id, created_at
        FROM backend_admin_audit_logs
        WHERE actor ILIKE $1 OR action ILIKE $1 OR target_type ILIKE $1 OR target_id ILIKE $1
        ORDER BY created_at DESC
        LIMIT $2
      `,
      [term, limit]
    );

    results.push(...audit.rows.map((row) => ({
      type: "Audit",
      title: row.action || row.id,
      subtitle: `${row.target_type || ""} ${row.target_id || ""}`.trim(),
      detail: `${row.actor || ""} ${row.created_at || ""}`.trim(),
      id: row.id,
      view: "dashboard",
    })));

    return ok(res, {
      query: q,
      results: results.slice(0, 80),
      counts: {
        total: results.length,
      },
    });
  } catch (error) {
    return fail(res, "Global search failed", 500, error.message);
  }
});

router.get("/dashboard-real-page-data", async (req, res) => {
  try {
    const countsResult = await dbQuery(`
      SELECT
        (SELECT COUNT(*)::int FROM users WHERE status = 'active') AS users,
        (SELECT COUNT(*)::int FROM apps WHERE status = 'active') AS "activeApps",
        (SELECT COUNT(*)::int FROM app_memberships WHERE status = 'active') AS "activeMemberships",
        (SELECT COUNT(*)::int FROM sessions WHERE revoked_at IS NULL AND expires_at > NOW()) AS sessions,
        (SELECT COUNT(*)::int FROM backend_api_keys) AS "apiKeys",
        (SELECT COUNT(*)::int FROM backend_webhooks) AS webhooks,
        (SELECT COUNT(*)::int FROM backend_storage_buckets) AS "storageBuckets",
        (SELECT COUNT(*)::int FROM backend_storage_files) AS "storageFiles"
    `);

    const appsResult = await dbQuery(`
      SELECT
        a.id,
        a.name,
        a.domain,
        a.status,
        a.description,
        COUNT(am.id)::int AS "memberCount",
        a.created_at AS "createdAt",
        a.updated_at AS "updatedAt"
      FROM apps a
      LEFT JOIN app_memberships am
        ON am.app_id = a.id
       AND am.status = 'active'
      GROUP BY a.id, a.name, a.domain, a.status, a.description, a.created_at, a.updated_at
      ORDER BY a.name ASC
      LIMIT 250
    `);

    const usersResult = await dbQuery(`
      SELECT
        id,
        email,
        first_name AS "firstName",
        last_name AS "lastName",
        display_name AS "displayName",
        platform_role AS "platformRole",
        status,
        email_verified AS "emailVerified",
        last_login_at AS "lastLoginAt",
        created_at AS "createdAt"
      FROM users
      ORDER BY created_at DESC
      LIMIT 250
    `);

    const membershipsResult = await dbQuery(`
      SELECT
        am.id,
        u.email,
        u.display_name AS "displayName",
        a.id AS "appId",
        a.name AS "appName",
        a.domain,
        am.role,
        am.status,
        am.created_at AS "createdAt"
      FROM app_memberships am
      JOIN users u ON u.id = am.user_id
      JOIN apps a ON a.id = am.app_id
      ORDER BY a.name ASC, u.email ASC
      LIMIT 500
    `);

    const sessionsResult = await dbQuery(`
      SELECT
        s.id,
        u.email,
        s.ip_address::text AS "ipAddress",
        s.user_agent AS "userAgent",
        s.expires_at AS "expiresAt",
        s.revoked_at AS "revokedAt",
        s.created_at AS "createdAt",
        CASE
          WHEN s.revoked_at IS NOT NULL THEN 'revoked'
          WHEN s.expires_at <= NOW() THEN 'expired'
          ELSE 'active'
        END AS status
      FROM sessions s
      JOIN users u ON u.id = s.user_id
      ORDER BY s.created_at DESC
      LIMIT 100
    `);

    const memory = process.memoryUsage();
    const counts = countsResult.rows[0] || {};

    return ok(res, {
      counts,
      apps: appsResult.rows,
      users: usersResult.rows,
      memberships: membershipsResult.rows,
      sessions: sessionsResult.rows,
      runtime: {
        environment: process.env.NODE_ENV || "production",
        version: process.env.APP_VERSION || "1.0.0",
        node: process.version,
        uptimeSeconds: Math.floor(process.uptime()),
        uptime: `${Math.floor(process.uptime() / 60)} min`,
        memoryHeapMb: Math.round(memory.heapUsed / 1024 / 1024),
        database: "connected",
      },
    });
  } catch (error) {
    return fail(res, "Failed to load real dashboard data", 500, error.message);
  }
});


function quoteIdentifier(value) {
  return '"' + String(value).replace(/"/g, '""') + '"';
}


function normalizeAuthRole(value, fallback = "member") {
  const role = String(value || fallback).trim().toLowerCase();
  if (["owner", "admin", "manager", "developer", "member", "viewer"].includes(role)) return role;
  return fallback;
}

function normalizePlatformRole(value, fallback = "user") {
  const role = String(value || fallback).trim().toLowerCase();
  if (["owner", "admin", "manager", "developer", "user", "viewer"].includes(role)) return role;
  return fallback;
}

function normalizeUserStatus(value, fallback = "active") {
  const status = String(value || fallback).trim().toLowerCase();
  if (["active", "pending", "disabled", "suspended"].includes(status)) return status;
  return fallback;
}

function normalizeInviteStatus(value, fallback = "pending") {
  const status = String(value || fallback).trim().toLowerCase();
  if (["pending", "accepted", "revoked", "expired"].includes(status)) return status;
  return fallback;
}

function hashInviteToken(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}


function normalizeAppId(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

function normalizeAppStatus(value, fallback = "active") {
  const status = String(value || fallback).trim().toLowerCase();
  if (["active", "planned", "disabled", "archived"].includes(status)) return status;
  return fallback;
}

function normalizeAppDomain(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "")
    .slice(0, 180);
}

async function auditAppRegistryAction(req, action, targetType, targetId, afterJson = {}, beforeJson = null) {
  await dbQuery(
    `
      INSERT INTO backend_admin_audit_logs (
        id,
        actor,
        action,
        target_type,
        target_id,
        before_json,
        after_json,
        ip_address,
        user_agent
      )
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9)
    `,
    [
      `audit_${crypto.randomUUID().replace(/-/g, "")}`,
      req.user?.email || req.session?.user?.email || req.auth?.user?.email || "console-user",
      action,
      targetType,
      targetId,
      beforeJson ? JSON.stringify(beforeJson) : null,
      JSON.stringify(afterJson || {}),
      req.headers["x-forwarded-for"] || req.socket?.remoteAddress || null,
      req.headers["user-agent"] || null,
    ]
  );
}

router.get("/apps-page-data", async (req, res) => {
  try {
    const appsResult = await dbQuery(`
      SELECT
        a.id,
        a.name,
        a.domain,
        a.status,
        a.description,
        a.created_at AS "createdAt",
        a.updated_at AS "updatedAt",
        COUNT(am.id) FILTER (WHERE am.status = 'active')::int AS "activeMemberships",
        COUNT(am.id)::int AS "totalMemberships"
      FROM apps a
      LEFT JOIN app_memberships am ON am.app_id = a.id
      GROUP BY a.id, a.name, a.domain, a.status, a.description, a.created_at, a.updated_at
      ORDER BY
        CASE WHEN a.status = 'active' THEN 0 ELSE 1 END,
        a.name ASC
      LIMIT 250
    `);

    const membershipsResult = await dbQuery(`
      SELECT
        am.id::text,
        am.user_id::text AS "userId",
        u.email,
        COALESCE(u.display_name, u.email) AS "displayName",
        am.app_id AS "appId",
        a.name AS "appName",
        a.domain AS "appDomain",
        am.role,
        am.status,
        am.created_at AS "createdAt",
        am.updated_at AS "updatedAt"
      FROM app_memberships am
      LEFT JOIN users u ON u.id = am.user_id
      LEFT JOIN apps a ON a.id = am.app_id
      ORDER BY a.name ASC, u.email ASC
      LIMIT 500
    `);

    const apiKeysResult = await dbQuery(`
      SELECT
        id,
        name,
        key_prefix AS "keyPrefix",
        type,
        scopes,
        allowed_app_ids AS "allowedAppIds",
        status,
        last_used_at AS "lastUsedAt",
        created_at AS "createdAt"
      FROM backend_api_keys
      ORDER BY created_at DESC
      LIMIT 100
    `);

    const auditResult = await dbQuery(`
      SELECT
        id,
        actor,
        action,
        target_type AS "targetType",
        target_id AS "targetId",
        after_json AS "afterJson",
        ip_address AS "ipAddress",
        created_at AS "createdAt"
      FROM backend_admin_audit_logs
      WHERE action ILIKE '%app%'
         OR action ILIKE '%membership%'
      ORDER BY created_at DESC
      LIMIT 100
    `);

    const apps = appsResult.rows;
    const memberships = membershipsResult.rows;
    const apiKeys = apiKeysResult.rows;
    const auditLogs = auditResult.rows;

    return ok(res, {
      apps,
      memberships,
      apiKeys,
      auditLogs,
      counts: {
        apps: apps.length,
        activeApps: apps.filter((app) => app.status === "active").length,
        plannedApps: apps.filter((app) => app.status === "planned").length,
        disabledApps: apps.filter((app) => app.status === "disabled").length,
        memberships: memberships.length,
        activeMemberships: memberships.filter((item) => item.status === "active").length,
        apiKeys: apiKeys.length,
        appRestrictedKeys: apiKeys.filter((key) => Array.isArray(key.allowedAppIds) && !key.allowedAppIds.includes("*")).length,
      },
    });
  } catch (error) {
    return fail(res, "Failed to load app registry page data", 500, error.message);
  }
});

router.get("/apps/:id/detail-safe", async (req, res) => {
  try {
    const id = normalizeAppId(req.params.id);

    const appResult = await dbQuery(
      `
        SELECT
          id,
          name,
          domain,
          status,
          description,
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM apps
        WHERE id = $1
        LIMIT 1
      `,
      [id]
    );

    const app = appResult.rows[0];
    if (!app) return fail(res, "App not found", 404);

    const membershipsResult = await dbQuery(
      `
        SELECT
          am.id::text,
          am.user_id::text AS "userId",
          u.email,
          COALESCE(u.display_name, u.email) AS "displayName",
          am.role,
          am.status,
          am.created_at AS "createdAt",
          am.updated_at AS "updatedAt"
        FROM app_memberships am
        LEFT JOIN users u ON u.id = am.user_id
        WHERE am.app_id = $1
        ORDER BY u.email ASC
      `,
      [id]
    );

    const apiKeysResult = await dbQuery(
      `
        SELECT
          id,
          name,
          key_prefix AS "keyPrefix",
          scopes,
          allowed_app_ids AS "allowedAppIds",
          status,
          last_used_at AS "lastUsedAt",
          created_at AS "createdAt"
        FROM backend_api_keys
        WHERE $1 = ANY(allowed_app_ids)
           OR '*' = ANY(allowed_app_ids)
        ORDER BY created_at DESC
        LIMIT 100
      `,
      [id]
    );

    return ok(res, {
      app,
      memberships: membershipsResult.rows,
      apiKeys: apiKeysResult.rows,
    });
  } catch (error) {
    return fail(res, "Failed to load app detail", 500, error.message);
  }
});

router.post("/apps/create-safe", async (req, res) => {
  try {
    const id = normalizeAppId(req.body?.id || req.body?.name);
    const name = String(req.body?.name || "").trim();
    const domain = normalizeAppDomain(req.body?.domain || "");
    const status = normalizeAppStatus(req.body?.status || "active");
    const description = String(req.body?.description || "").trim();

    if (!id) return fail(res, "App id is required", 400);
    if (!name) return fail(res, "App name is required", 400);

    const result = await dbQuery(
      `
        INSERT INTO apps (
          id,
          name,
          domain,
          status,
          description,
          organization_id,
          project_id,
          environment_id
        )
        VALUES (
          $1,
          $2,
          NULLIF($3, ''),
          $4,
          NULLIF($5, ''),
          'org_goodos',
          'proj_goodos_platform',
          'env_goodos_production'
        )
        RETURNING
          id,
          name,
          domain,
          status,
          description,
          created_at AS "createdAt",
          updated_at AS "updatedAt"
      `,
      [id, name, domain, status, description]
    );

    await auditAppRegistryAction(req, "app.create", "app", id, result.rows[0]);

    return ok(res, {
      app: result.rows[0],
      message: "App created.",
    });
  } catch (error) {
    if (String(error.message || "").includes("duplicate key")) {
      return fail(res, "App id already exists", 409, error.message);
    }

    return fail(res, "Failed to create app", 500, error.message);
  }
});

router.post("/apps/:id/update-safe", async (req, res) => {
  try {
    const id = normalizeAppId(req.params.id);

    const beforeResult = await dbQuery(
      `
        SELECT id, name, domain, status, description, created_at, updated_at
        FROM apps
        WHERE id = $1
        LIMIT 1
      `,
      [id]
    );

    const before = beforeResult.rows[0];
    if (!before) return fail(res, "App not found", 404);

    const name = String(req.body?.name || before.name || "").trim();
    const domain = normalizeAppDomain(req.body?.domain ?? before.domain ?? "");
    const status = normalizeAppStatus(req.body?.status || before.status || "active");
    const description = String(req.body?.description ?? before.description ?? "").trim();

    const result = await dbQuery(
      `
        UPDATE apps
        SET
          name = $2,
          domain = NULLIF($3, ''),
          status = $4,
          description = NULLIF($5, ''),
          updated_at = NOW()
        WHERE id = $1
        RETURNING
          id,
          name,
          domain,
          status,
          description,
          created_at AS "createdAt",
          updated_at AS "updatedAt"
      `,
      [id, name, domain, status, description]
    );

    await auditAppRegistryAction(req, "app.update", "app", id, result.rows[0], before);

    return ok(res, {
      app: result.rows[0],
      message: "App updated.",
    });
  } catch (error) {
    return fail(res, "Failed to update app", 500, error.message);
  }
});

router.post("/apps/:id/status-safe", async (req, res) => {
  try {
    const id = normalizeAppId(req.params.id);
    const status = normalizeAppStatus(req.body?.status || "active");

    const result = await dbQuery(
      `
        UPDATE apps
        SET status = $2, updated_at = NOW()
        WHERE id = $1
        RETURNING
          id,
          name,
          domain,
          status,
          description,
          created_at AS "createdAt",
          updated_at AS "updatedAt"
      `,
      [id, status]
    );

    if (!result.rows[0]) return fail(res, "App not found", 404);

    await auditAppRegistryAction(req, "app.status_update", "app", id, { status });

    return ok(res, {
      app: result.rows[0],
      message: "App status updated.",
    });
  } catch (error) {
    return fail(res, "Failed to update app status", 500, error.message);
  }
});

router.post("/apps/:id/memberships/create-safe", async (req, res) => {
  try {
    const appId = normalizeAppId(req.params.id);
    const userId = String(req.body?.userId || "").trim();
    const role = normalizeAuthRole ? normalizeAuthRole(req.body?.role || "member") : String(req.body?.role || "member").trim().toLowerCase();
    const status = String(req.body?.status || "active").trim().toLowerCase();

    if (!userId) return fail(res, "User id is required", 400);
    if (!["active", "pending", "disabled", "revoked"].includes(status)) return fail(res, "Invalid membership status", 400);

    const existingResult = await dbQuery(
      `
        SELECT id
        FROM app_memberships
        WHERE user_id = $1::uuid
          AND app_id = $2
        LIMIT 1
      `,
      [userId, appId]
    );

    let result;

    if (existingResult.rows[0]) {
      result = await dbQuery(
        `
          UPDATE app_memberships
          SET role = $2, status = $3, updated_at = NOW()
          WHERE id = $1::uuid
          RETURNING
            id::text,
            user_id::text AS "userId",
            app_id AS "appId",
            role,
            status,
            created_at AS "createdAt",
            updated_at AS "updatedAt"
        `,
        [existingResult.rows[0].id, role, status]
      );
    } else {
      result = await dbQuery(
        `
          INSERT INTO app_memberships (
            user_id,
            app_id,
            role,
            status
          )
          VALUES ($1::uuid, $2, $3, $4)
          RETURNING
            id::text,
            user_id::text AS "userId",
            app_id AS "appId",
            role,
            status,
            created_at AS "createdAt",
            updated_at AS "updatedAt"
        `,
        [userId, appId, role, status]
      );
    }

    await auditAppRegistryAction(req, "app.membership.save", "app_membership", `${userId}:${appId}`, {
      userId,
      appId,
      role,
      status,
    });

    return ok(res, {
      membership: result.rows[0],
      message: "App membership saved.",
    });
  } catch (error) {
    return fail(res, "Failed to save app membership", 500, error.message);
  }
});

router.get("/users-page-data", async (req, res) => {
  try {
    const usersResult = await dbQuery(`
      SELECT
        id::text,
        email,
        first_name AS "firstName",
        last_name AS "lastName",
        display_name AS "displayName",
        phone,
        platform_role AS "platformRole",
        status,
        email_verified AS "emailVerified",
        last_login_at AS "lastLoginAt",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM users
      ORDER BY created_at DESC
      LIMIT 250
    `);

    const membershipsResult = await dbQuery(`
      SELECT
        am.id::text,
        am.user_id::text AS "userId",
        u.email,
        COALESCE(u.display_name, u.email) AS "displayName",
        am.app_id AS "appId",
        a.name AS "appName",
        a.domain AS "appDomain",
        am.role,
        am.status,
        am.created_at AS "createdAt",
        am.updated_at AS "updatedAt"
      FROM app_memberships am
      JOIN users u ON u.id = am.user_id
      JOIN apps a ON a.id = am.app_id
      ORDER BY am.created_at DESC
      LIMIT 500
    `);

    const sessionsResult = await dbQuery(`
      SELECT
        s.id::text,
        s.user_id::text AS "userId",
        u.email,
        COALESCE(u.display_name, u.email) AS "displayName",
        s.ip_address::text AS "ipAddress",
        s.user_agent AS "userAgent",
        s.expires_at AS "expiresAt",
        s.revoked_at AS "revokedAt",
        s.created_at AS "createdAt",
        CASE
          WHEN s.revoked_at IS NOT NULL THEN 'revoked'
          WHEN s.expires_at <= NOW() THEN 'expired'
          ELSE 'active'
        END AS status
      FROM sessions s
      JOIN users u ON u.id = s.user_id
      ORDER BY s.created_at DESC
      LIMIT 150
    `);

    const appsResult = await dbQuery(`
      SELECT id, name, domain, status
      FROM apps
      ORDER BY name ASC
      LIMIT 100
    `);

    const invitesResult = await dbQuery(`
      SELECT
        id,
        email,
        invited_by AS "invitedBy",
        platform_role AS "platformRole",
        app_id AS "appId",
        app_role AS "appRole",
        status,
        expires_at AS "expiresAt",
        accepted_at AS "acceptedAt",
        metadata_json AS "metadata",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM backend_user_invites
      ORDER BY created_at DESC
      LIMIT 150
    `);

    const auditResult = await dbQuery(`
      SELECT
        id,
        actor,
        action,
        target_type AS "targetType",
        target_id AS "targetId",
        after_json AS "afterJson",
        ip_address AS "ipAddress",
        created_at AS "createdAt"
      FROM backend_admin_audit_logs
      WHERE action ILIKE '%user%'
         OR action ILIKE '%membership%'
         OR action ILIKE '%invite%'
         OR action ILIKE '%session%'
         OR action ILIKE '%auth%'
      ORDER BY created_at DESC
      LIMIT 100
    `);

    const users = usersResult.rows;
    const memberships = membershipsResult.rows;
    const sessions = sessionsResult.rows;
    const apps = appsResult.rows;
    const invites = invitesResult.rows;
    const auditLogs = auditResult.rows;

    return ok(res, {
      users,
      memberships,
      sessions,
      apps,
      invites,
      auditLogs,
      counts: {
        users: users.length,
        activeUsers: users.filter((user) => user.status === "active").length,
        pendingUsers: users.filter((user) => user.status === "pending").length,
        memberships: memberships.length,
        activeMemberships: memberships.filter((item) => item.status === "active").length,
        sessions: sessions.length,
        activeSessions: sessions.filter((item) => item.status === "active").length,
        invites: invites.length,
        pendingInvites: invites.filter((item) => item.status === "pending").length,
        apps: apps.length,
      },
    });
  } catch (error) {
    return fail(res, "Failed to load users page data", 500, error.message);
  }
});

router.post("/users/invites/create-safe", async (req, res) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const platformRole = normalizePlatformRole(req.body?.platformRole || "user");
    const appId = String(req.body?.appId || "").trim();
    const appRole = normalizeAuthRole(req.body?.appRole || "member");
    const expiresDays = Math.min(Math.max(Number(req.body?.expiresDays || 7), 1), 30);

    if (!email || !email.includes("@")) return fail(res, "Valid invite email is required", 400);

    if (appId) {
      const appCheck = await dbQuery("SELECT id FROM apps WHERE id = $1 LIMIT 1", [appId]);
      if (!appCheck.rows[0]) return fail(res, "Selected app does not exist", 404);
    }

    const rawToken = `goinv_${crypto.randomUUID().replace(/-/g, "")}${crypto.randomUUID().replace(/-/g, "")}`;
    const tokenHash = hashInviteToken(rawToken);
    const id = `invite_${crypto.randomUUID().replace(/-/g, "")}`;

    const result = await dbQuery(
      `
        INSERT INTO backend_user_invites (
          id,
          email,
          invited_by,
          platform_role,
          app_id,
          app_role,
          token_hash,
          status,
          expires_at,
          metadata_json
        )
        VALUES ($1, $2, $3, $4, NULLIF($5, ''), $6, $7, 'pending', NOW() + ($8 || ' days')::interval, $9::jsonb)
        RETURNING
          id,
          email,
          invited_by AS "invitedBy",
          platform_role AS "platformRole",
          app_id AS "appId",
          app_role AS "appRole",
          status,
          expires_at AS "expiresAt",
          created_at AS "createdAt"
      `,
      [
        id,
        email,
        req.user?.email || req.session?.user?.email || req.auth?.user?.email || "console-user",
        platformRole,
        appId,
        appRole,
        tokenHash,
        expiresDays,
        JSON.stringify({
          createdFrom: "GoodAppBackEnd Console",
          appId: appId || null,
          appRole,
        }),
      ]
    );

    await dbQuery(
      `
        INSERT INTO backend_admin_audit_logs (
          id,
          actor,
          action,
          target_type,
          target_id,
          after_json,
          ip_address,
          user_agent
        )
        VALUES ($1, $2, 'auth.invite.create', 'user_invite', $3, $4::jsonb, $5, $6)
      `,
      [
        `audit_${crypto.randomUUID().replace(/-/g, "")}`,
        req.user?.email || req.session?.user?.email || req.auth?.user?.email || "console-user",
        id,
        JSON.stringify({ email, platformRole, appId: appId || null, appRole, expiresDays }),
        req.headers["x-forwarded-for"] || req.socket?.remoteAddress || null,
        req.headers["user-agent"] || null,
      ]
    );

    return ok(res, {
      invite: result.rows[0],
      rawToken,
      inviteUrl: `https://base.goodos.app/invite/${rawToken}`,
      message: "Invite record created. Copy the token now; it is not stored in plain text.",
    });
  } catch (error) {
    return fail(res, "Failed to create invite", 500, error.message);
  }
});

router.post("/users/invites/:id/status-safe", async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    const status = normalizeInviteStatus(req.body?.status || "revoked");

    const result = await dbQuery(
      `
        UPDATE backend_user_invites
        SET status = $2, updated_at = NOW()
        WHERE id = $1
        RETURNING
          id,
          email,
          invited_by AS "invitedBy",
          platform_role AS "platformRole",
          app_id AS "appId",
          app_role AS "appRole",
          status,
          expires_at AS "expiresAt",
          accepted_at AS "acceptedAt",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
      `,
      [id, status]
    );

    if (!result.rows[0]) return fail(res, "Invite not found", 404);

    await dbQuery(
      `
        INSERT INTO backend_admin_audit_logs (
          id,
          actor,
          action,
          target_type,
          target_id,
          after_json,
          ip_address,
          user_agent
        )
        VALUES ($1, $2, 'auth.invite.status_update', 'user_invite', $3, $4::jsonb, $5, $6)
      `,
      [
        `audit_${crypto.randomUUID().replace(/-/g, "")}`,
        req.user?.email || req.session?.user?.email || req.auth?.user?.email || "console-user",
        id,
        JSON.stringify({ status }),
        req.headers["x-forwarded-for"] || req.socket?.remoteAddress || null,
        req.headers["user-agent"] || null,
      ]
    );

    return ok(res, { invite: result.rows[0], message: "Invite status updated." });
  } catch (error) {
    return fail(res, "Failed to update invite status", 500, error.message);
  }
});

router.post("/users/:id/status-safe", async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    const status = normalizeUserStatus(req.body?.status || "active");

    const result = await dbQuery(
      `
        UPDATE users
        SET status = $2, updated_at = NOW()
        WHERE id = $1::uuid
        RETURNING
          id::text,
          email,
          display_name AS "displayName",
          platform_role AS "platformRole",
          status,
          email_verified AS "emailVerified",
          updated_at AS "updatedAt"
      `,
      [id, status]
    );

    if (!result.rows[0]) return fail(res, "User not found", 404);

    if (["disabled", "suspended"].includes(status)) {
      await dbQuery(
        `
          UPDATE sessions
          SET revoked_at = NOW()
          WHERE user_id = $1::uuid
            AND revoked_at IS NULL
        `,
        [id]
      );
    }

    await dbQuery(
      `
        INSERT INTO backend_admin_audit_logs (
          id,
          actor,
          action,
          target_type,
          target_id,
          after_json,
          ip_address,
          user_agent
        )
        VALUES ($1, $2, 'auth.user.status_update', 'user', $3, $4::jsonb, $5, $6)
      `,
      [
        `audit_${crypto.randomUUID().replace(/-/g, "")}`,
        req.user?.email || req.session?.user?.email || req.auth?.user?.email || "console-user",
        id,
        JSON.stringify({ status }),
        req.headers["x-forwarded-for"] || req.socket?.remoteAddress || null,
        req.headers["user-agent"] || null,
      ]
    );

    return ok(res, { user: result.rows[0], message: "User status updated." });
  } catch (error) {
    return fail(res, "Failed to update user status", 500, error.message);
  }
});

router.post("/users/:id/platform-role-safe", async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    const platformRole = normalizePlatformRole(req.body?.platformRole || "user");

    const result = await dbQuery(
      `
        UPDATE users
        SET platform_role = $2, updated_at = NOW()
        WHERE id = $1::uuid
        RETURNING
          id::text,
          email,
          display_name AS "displayName",
          platform_role AS "platformRole",
          status,
          email_verified AS "emailVerified",
          updated_at AS "updatedAt"
      `,
      [id, platformRole]
    );

    if (!result.rows[0]) return fail(res, "User not found", 404);

    await dbQuery(
      `
        INSERT INTO backend_admin_audit_logs (
          id,
          actor,
          action,
          target_type,
          target_id,
          after_json,
          ip_address,
          user_agent
        )
        VALUES ($1, $2, 'auth.user.platform_role_update', 'user', $3, $4::jsonb, $5, $6)
      `,
      [
        `audit_${crypto.randomUUID().replace(/-/g, "")}`,
        req.user?.email || req.session?.user?.email || req.auth?.user?.email || "console-user",
        id,
        JSON.stringify({ platformRole }),
        req.headers["x-forwarded-for"] || req.socket?.remoteAddress || null,
        req.headers["user-agent"] || null,
      ]
    );

    return ok(res, { user: result.rows[0], message: "User platform role updated." });
  } catch (error) {
    return fail(res, "Failed to update platform role", 500, error.message);
  }
});

router.post("/memberships/upsert-safe", async (req, res) => {
  try {
    const userId = String(req.body?.userId || "").trim();
    const appId = String(req.body?.appId || "").trim();
    const role = normalizeAuthRole(req.body?.role || "member");
    const status = String(req.body?.status || "active").trim().toLowerCase();

    if (!userId || !appId) return fail(res, "userId and appId are required", 400);
    if (!["active", "pending", "disabled", "revoked"].includes(status)) return fail(res, "Invalid membership status", 400);

    const userCheck = await dbQuery("SELECT id FROM users WHERE id = $1::uuid LIMIT 1", [userId]);
    if (!userCheck.rows[0]) return fail(res, "User not found", 404);

    const appCheck = await dbQuery("SELECT id FROM apps WHERE id = $1 LIMIT 1", [appId]);
    if (!appCheck.rows[0]) return fail(res, "App not found", 404);

    const result = await dbQuery(
      `
        INSERT INTO app_memberships (
          user_id,
          app_id,
          role,
          status
        )
        VALUES ($1::uuid, $2, $3, $4)
        ON CONFLICT (user_id, app_id) DO UPDATE
        SET role = EXCLUDED.role,
            status = EXCLUDED.status,
            updated_at = NOW()
        RETURNING
          id::text,
          user_id::text AS "userId",
          app_id AS "appId",
          role,
          status,
          created_at AS "createdAt",
          updated_at AS "updatedAt"
      `,
      [userId, appId, role, status]
    );

    await dbQuery(
      `
        INSERT INTO backend_admin_audit_logs (
          id,
          actor,
          action,
          target_type,
          target_id,
          after_json,
          ip_address,
          user_agent
        )
        VALUES ($1, $2, 'auth.membership.upsert', 'app_membership', $3, $4::jsonb, $5, $6)
      `,
      [
        `audit_${crypto.randomUUID().replace(/-/g, "")}`,
        req.user?.email || req.session?.user?.email || req.auth?.user?.email || "console-user",
        `${userId}:${appId}`,
        JSON.stringify({ userId, appId, role, status }),
        req.headers["x-forwarded-for"] || req.socket?.remoteAddress || null,
        req.headers["user-agent"] || null,
      ]
    );

    return ok(res, { membership: result.rows[0], message: "Membership saved." });
  } catch (error) {
    return fail(res, "Failed to save membership", 500, error.message);
  }
});

router.post("/memberships/:id/update-safe", async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    const role = normalizeAuthRole(req.body?.role || "member");
    const status = String(req.body?.status || "active").trim().toLowerCase();

    if (!["active", "pending", "disabled", "revoked"].includes(status)) return fail(res, "Invalid membership status", 400);

    const result = await dbQuery(
      `
        UPDATE app_memberships
        SET role = $2, status = $3, updated_at = NOW()
        WHERE id = $1::uuid
        RETURNING
          id::text,
          user_id::text AS "userId",
          app_id AS "appId",
          role,
          status,
          created_at AS "createdAt",
          updated_at AS "updatedAt"
      `,
      [id, role, status]
    );

    if (!result.rows[0]) return fail(res, "Membership not found", 404);

    await dbQuery(
      `
        INSERT INTO backend_admin_audit_logs (
          id,
          actor,
          action,
          target_type,
          target_id,
          after_json,
          ip_address,
          user_agent
        )
        VALUES ($1, $2, 'auth.membership.update', 'app_membership', $3, $4::jsonb, $5, $6)
      `,
      [
        `audit_${crypto.randomUUID().replace(/-/g, "")}`,
        req.user?.email || req.session?.user?.email || req.auth?.user?.email || "console-user",
        id,
        JSON.stringify({ role, status }),
        req.headers["x-forwarded-for"] || req.socket?.remoteAddress || null,
        req.headers["user-agent"] || null,
      ]
    );

    return ok(res, { membership: result.rows[0], message: "Membership updated." });
  } catch (error) {
    return fail(res, "Failed to update membership", 500, error.message);
  }
});

router.post("/users/sessions/:id/revoke-safe", async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();

    if (String(req.auth?.sessionId || "") === id) {
      return fail(res, "Current session cannot be revoked here. Use Logout instead.", 400);
    }

    const result = await dbQuery(
      `
        UPDATE sessions
        SET revoked_at = NOW()
        WHERE id = $1::uuid
          AND revoked_at IS NULL
        RETURNING
          id::text,
          user_id::text AS "userId",
          ip_address::text AS "ipAddress",
          user_agent AS "userAgent",
          expires_at AS "expiresAt",
          revoked_at AS "revokedAt",
          created_at AS "createdAt"
      `,
      [id]
    );

    if (!result.rows[0]) return fail(res, "Session not found or already revoked", 404);

    await dbQuery(
      `
        INSERT INTO backend_admin_audit_logs (
          id,
          actor,
          action,
          target_type,
          target_id,
          after_json,
          ip_address,
          user_agent
        )
        VALUES ($1, $2, 'auth.session.revoke', 'session', $3, $4::jsonb, $5, $6)
      `,
      [
        `audit_${crypto.randomUUID().replace(/-/g, "")}`,
        req.user?.email || req.session?.user?.email || req.auth?.user?.email || "console-user",
        id,
        JSON.stringify(result.rows[0]),
        req.headers["x-forwarded-for"] || req.socket?.remoteAddress || null,
        req.headers["user-agent"] || null,
      ]
    );

    return ok(res, { session: result.rows[0], message: "Session revoked." });
  } catch (error) {
    return fail(res, "Failed to revoke user session", 500, error.message);
  }
});


function normalizeDbApiAdminSlug(value, fallback = "table") {
  return String(value || fallback)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 100) || fallback;
}

function normalizeDbApiBoolean(value) {
  return value === true || value === "true" || value === 1 || value === "1";
}

function normalizeDbApiArray(value, fallback = []) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  if (typeof value === "string" && value.trim()) {
    return value.split(",").map((item) => item.trim()).filter(Boolean);
  }
  return fallback;
}

router.get("/db-api-page-data", async (req, res) => {
  try {
    const rulesResult = await dbQuery(`
      SELECT
        r.id,
        r.table_name AS "tableName",
        r.api_slug AS "apiSlug",
        r.display_name AS "displayName",
        r.description,
        r.read_enabled AS "readEnabled",
        r.write_enabled AS "writeEnabled",
        r.insert_enabled AS "insertEnabled",
        r.update_enabled AS "updateEnabled",
        r.delete_enabled AS "deleteEnabled",
        r.exposed_columns AS "exposedColumns",
        r.searchable_columns AS "searchableColumns",
        r.allowed_api_key_scopes AS "allowedApiKeyScopes",
        r.allowed_app_ids AS "allowedAppIds",
        r.max_rows AS "maxRows",
        r.status,
        r.organization_id AS "organizationId",
        r.project_id AS "projectId",
        r.environment_id AS "environmentId",
        r.metadata_json AS "metadata",
        r.created_at AS "createdAt",
        r.updated_at AS "updatedAt"
      FROM backend_table_api_rules r
      ORDER BY r.display_name ASC, r.api_slug ASC
      LIMIT 250
    `);

    const tablesResult = await dbQuery(`
      SELECT
        t.table_name AS "tableName",
        COALESCE(s.n_live_tup, 0)::bigint AS "estimatedRows",
        EXISTS (
          SELECT 1
          FROM backend_table_api_rules r
          WHERE r.table_name = t.table_name
            AND r.status = 'active'
        ) AS "isPublished"
      FROM information_schema.tables t
      LEFT JOIN pg_stat_user_tables s
        ON s.relname = t.table_name
       AND s.schemaname = 'public'
      WHERE t.table_schema = 'public'
        AND t.table_type = 'BASE TABLE'
      ORDER BY t.table_name ASC
    `);

    const columnsResult = await dbQuery(`
      SELECT
        table_name AS "tableName",
        column_name AS "columnName",
        data_type AS "dataType",
        ordinal_position AS "position"
      FROM information_schema.columns
      WHERE table_schema = 'public'
      ORDER BY table_name ASC, ordinal_position ASC
    `);

    const rules = rulesResult.rows;
    const tables = tablesResult.rows.map((table) => ({
      ...table,
      columns: columnsResult.rows.filter((column) => column.tableName === table.tableName),
    }));

    return ok(res, {
      rules,
      tables,
      counts: {
        publishedTables: rules.filter((rule) => rule.status === "active" && rule.readEnabled).length,
        writableTables: rules.filter((rule) => rule.status === "active" && rule.writeEnabled).length,
        totalRules: rules.length,
        totalTables: tables.length,
      },
    });
  } catch (error) {
    return fail(res, "Failed to load Database API page data", 500, error.message);
  }
});

router.post("/db-api/rules/create-safe", async (req, res) => {
  try {
    const tableName = String(req.body?.tableName || "").trim();
    const apiSlug = normalizeDbApiAdminSlug(req.body?.apiSlug || tableName);
    const id = `tblapi_${apiSlug.replace(/-/g, "_")}_${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;
    const displayName = String(req.body?.displayName || tableName).trim();
    const description = String(req.body?.description || "").trim();
    const readEnabled = normalizeDbApiBoolean(req.body?.readEnabled ?? true);
    const writeEnabled = normalizeDbApiBoolean(req.body?.writeEnabled ?? false);
    const insertEnabled = normalizeDbApiBoolean(req.body?.insertEnabled ?? false);
    const updateEnabled = normalizeDbApiBoolean(req.body?.updateEnabled ?? false);
    const deleteEnabled = normalizeDbApiBoolean(req.body?.deleteEnabled ?? false);
    const exposedColumns = normalizeDbApiArray(req.body?.exposedColumns || []);
    const searchableColumns = normalizeDbApiArray(req.body?.searchableColumns || []);
    const allowedApiKeyScopes = normalizeDbApiArray(req.body?.allowedApiKeyScopes || ["read:db"]);
    const allowedAppIds = normalizeDbApiArray(req.body?.allowedAppIds || ["*"]);
    const maxRows = Math.min(Math.max(Number(req.body?.maxRows || 100), 1), 500);
    const status = String(req.body?.status || "active").trim().toLowerCase();

    if (!tableName) return fail(res, "tableName is required", 400);

    const exists = await dbQuery(
      `
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_type = 'BASE TABLE'
          AND table_name = $1
        LIMIT 1
      `,
      [tableName]
    );

    if (!exists.rows[0]) return fail(res, "Public table does not exist", 404);

    const result = await dbQuery(
      `
        INSERT INTO backend_table_api_rules (
          id,
          table_name,
          api_slug,
          display_name,
          description,
          read_enabled,
          write_enabled,
          insert_enabled,
          update_enabled,
          delete_enabled,
          exposed_columns,
          searchable_columns,
          allowed_api_key_scopes,
          allowed_app_ids,
          max_rows,
          status,
          organization_id,
          project_id,
          environment_id,
          metadata_json
        )
        VALUES ($1,$2,$3,$4,NULLIF($5,''),$6,$7,$8,$9,$10,$11::text[],$12::text[],$13::text[],$14::text[],$15,$16,'org_goodos','proj_goodos_platform','env_goodos_production',$17::jsonb)
        RETURNING *
      `,
      [
        id,
        tableName,
        apiSlug,
        displayName,
        description,
        readEnabled,
        writeEnabled,
        insertEnabled,
        updateEnabled,
        deleteEnabled,
        exposedColumns,
        searchableColumns,
        allowedApiKeyScopes,
        allowedAppIds,
        maxRows,
        status,
        JSON.stringify({ createdFrom: "GoodAppBackEnd Console" }),
      ]
    );

    await dbQuery(
      `
        INSERT INTO backend_admin_audit_logs (
          id,
          actor,
          action,
          target_type,
          target_id,
          after_json,
          organization_id,
          project_id,
          environment_id,
          ip_address,
          user_agent
        )
        VALUES ($1,$2,'database.api.rule.create','table_api_rule',$3,$4::jsonb,'org_goodos','proj_goodos_platform','env_goodos_production',$5,$6)
      `,
      [
        `audit_${crypto.randomUUID().replace(/-/g, "")}`,
        req.user?.email || req.session?.user?.email || req.auth?.user?.email || "console-user",
        id,
        JSON.stringify(result.rows[0]),
        req.headers["x-forwarded-for"] || req.socket?.remoteAddress || null,
        req.headers["user-agent"] || null,
      ]
    );

    return ok(res, { rule: result.rows[0], message: "Database API rule created." });
  } catch (error) {
    if (String(error.message || "").includes("duplicate key")) {
      return fail(res, "A rule with this API slug already exists", 409, error.message);
    }
    return fail(res, "Failed to create Database API rule", 500, error.message);
  }
});

router.post("/db-api/rules/:id/update-safe", async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();

    const beforeResult = await dbQuery(
      `
        SELECT *
        FROM backend_table_api_rules
        WHERE id = $1
        LIMIT 1
      `,
      [id]
    );

    const before = beforeResult.rows[0];
    if (!before) return fail(res, "Database API rule not found", 404);

    const patch = req.body && typeof req.body === "object" ? req.body : {};

    const displayName = String(patch.displayName ?? before.display_name ?? "").trim();
    const description = String(patch.description ?? before.description ?? "").trim();
    const readEnabled = normalizeDbApiBoolean(patch.readEnabled ?? before.read_enabled);
    const writeEnabled = normalizeDbApiBoolean(patch.writeEnabled ?? before.write_enabled);
    const insertEnabled = normalizeDbApiBoolean(patch.insertEnabled ?? before.insert_enabled);
    const updateEnabled = normalizeDbApiBoolean(patch.updateEnabled ?? before.update_enabled);
    const deleteEnabled = normalizeDbApiBoolean(patch.deleteEnabled ?? before.delete_enabled);
    const exposedColumns = normalizeDbApiArray(patch.exposedColumns ?? before.exposed_columns ?? []);
    const searchableColumns = normalizeDbApiArray(patch.searchableColumns ?? before.searchable_columns ?? []);
    const allowedApiKeyScopes = normalizeDbApiArray(patch.allowedApiKeyScopes ?? before.allowed_api_key_scopes ?? ["read:db"]);
    const allowedAppIds = normalizeDbApiArray(patch.allowedAppIds ?? before.allowed_app_ids ?? ["*"]);
    const maxRows = Math.min(Math.max(Number(patch.maxRows ?? before.max_rows ?? 100), 1), 500);
    const status = String(patch.status ?? before.status ?? "active").trim().toLowerCase();

    const result = await dbQuery(
      `
        UPDATE backend_table_api_rules
        SET
          display_name = NULLIF($2, ''),
          description = NULLIF($3, ''),
          read_enabled = $4,
          write_enabled = $5,
          insert_enabled = $6,
          update_enabled = $7,
          delete_enabled = $8,
          exposed_columns = $9::text[],
          searchable_columns = $10::text[],
          allowed_api_key_scopes = $11::text[],
          allowed_app_ids = $12::text[],
          max_rows = $13,
          status = $14,
          updated_at = NOW()
        WHERE id = $1
        RETURNING *
      `,
      [
        id,
        displayName,
        description,
        readEnabled,
        writeEnabled,
        insertEnabled,
        updateEnabled,
        deleteEnabled,
        exposedColumns,
        searchableColumns,
        allowedApiKeyScopes,
        allowedAppIds,
        maxRows,
        status,
      ]
    );

    await dbQuery(
      `
        INSERT INTO backend_admin_audit_logs (
          id,
          actor,
          action,
          target_type,
          target_id,
          before_json,
          after_json,
          organization_id,
          project_id,
          environment_id,
          ip_address,
          user_agent
        )
        VALUES ($1,$2,'database.api.rule.update','table_api_rule',$3,$4::jsonb,$5::jsonb,'org_goodos','proj_goodos_platform','env_goodos_production',$6,$7)
      `,
      [
        `audit_${crypto.randomUUID().replace(/-/g, "")}`,
        req.user?.email || req.session?.user?.email || req.auth?.user?.email || "console-user",
        id,
        JSON.stringify(before),
        JSON.stringify(result.rows[0]),
        req.headers["x-forwarded-for"] || req.socket?.remoteAddress || null,
        req.headers["user-agent"] || null,
      ]
    );

    return ok(res, { rule: result.rows[0], message: "Database API rule updated." });
  } catch (error) {
    return fail(res, "Failed to update Database API rule", 500, error.message);
  }
});

router.get("/database-page-data", async (req, res) => {
  try {
    const tablesResult = await dbQuery(`
      SELECT table_name AS "tableName"
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_type = 'BASE TABLE'
      ORDER BY table_name ASC
    `);

    const columnsResult = await dbQuery(`
      SELECT
        table_name AS "tableName",
        ordinal_position AS "position",
        column_name AS "columnName",
        data_type AS "dataType",
        is_nullable AS "isNullable",
        column_default AS "columnDefault"
      FROM information_schema.columns
      WHERE table_schema = 'public'
      ORDER BY table_name ASC, ordinal_position ASC
    `);

    const tables = [];

    for (const table of tablesResult.rows) {
      const tableName = table.tableName;

      let rowCount = 0;
      try {
        const countResult = await dbQuery(`SELECT COUNT(*)::int AS count FROM ${quoteIdentifier(tableName)}`);
        rowCount = Number(countResult.rows[0]?.count || 0);
      } catch (error) {
        rowCount = 0;
      }

      tables.push({
        tableName,
        rowCount,
        status: "live",
        columns: columnsResult.rows.filter((column) => column.tableName === tableName),
      });
    }

    return ok(res, {
      tables,
      counts: {
        tables: tables.length,
        rows: tables.reduce((sum, table) => sum + Number(table.rowCount || 0), 0),
      },
    });
  } catch (error) {
    return fail(res, "Failed to load database page data", 500, error.message);
  }
});



function getRealtimeClientMap() {
  if (!global.__goodosRealtimeClients) {
    global.__goodosRealtimeClients = new Map();
  }

  return global.__goodosRealtimeClients;
}

function normalizeRealtimeChannel(value) {
  const channel = String(value || "system")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9:_-]/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 80);

  return channel || "system";
}

function formatRealtimeSse(eventName, payload) {
  return `event: ${eventName}\ndata: ${JSON.stringify(payload || {})}\n\n`;
}

function broadcastRealtimeEventToClients(event) {
  const clients = getRealtimeClientMap();
  let delivered = 0;

  for (const client of clients.values()) {
    try {
      if (client.channel === "*" || client.channel === event.channel) {
        client.res.write(formatRealtimeSse("realtime", event));
        delivered += 1;
      }
    } catch (error) {
      clients.delete(client.id);
    }
  }

  return delivered;
}

async function createRealtimeEventRecord({
  eventType = "system.test",
  source = "backend-console",
  channel = "system",
  message = "Realtime event",
  payload = {},
  status = "recorded",
} = {}) {
  const id = `evt_${crypto.randomUUID().replace(/-/g, "")}`;
  const normalizedChannel = normalizeRealtimeChannel(channel);

  const result = await dbQuery(
    `
      INSERT INTO backend_realtime_events (
        id,
        event_type,
        source,
        channel,
        message,
        payload,
        status
      )
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
      RETURNING
        id,
        event_type AS "eventType",
        source,
        channel,
        message,
        payload,
        status,
        created_at AS "createdAt"
    `,
    [
      id,
      String(eventType || "system.test").trim(),
      String(source || "backend-console").trim(),
      normalizedChannel,
      String(message || "Realtime event").trim(),
      JSON.stringify(payload || {}),
      status,
    ]
  );

  const event = result.rows[0];
  const deliveredClients = broadcastRealtimeEventToClients(event);

  return {
    event,
    deliveredClients,
  };
}

router.get("/realtime-events/stream-safe", async (req, res) => {
  const channel = normalizeRealtimeChannel(req.query?.channel || "system");
  const clientId = `rt_${crypto.randomUUID().replace(/-/g, "")}`;
  const clients = getRealtimeClientMap();

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const client = {
    id: clientId,
    channel,
    connectedAt: new Date(),
    ip: req.headers["x-forwarded-for"] || req.socket?.remoteAddress || null,
    res,
  };

  clients.set(clientId, client);

  res.write(formatRealtimeSse("connected", {
    type: "connected",
    clientId,
    channel,
    connectedAt: client.connectedAt.toISOString(),
  }));

  const heartbeat = setInterval(() => {
    try {
      res.write(formatRealtimeSse("ping", {
        type: "ping",
        clientId,
        channel,
        time: new Date().toISOString(),
      }));
    } catch {
      clearInterval(heartbeat);
      clients.delete(clientId);
    }
  }, 25000);

  req.on("close", () => {
    clearInterval(heartbeat);
    clients.delete(clientId);
  });
});


function realtimeV2CleanChannel(value) {
  return String(value || "system")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9:_.*-]/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 120) || "system";
}

function realtimeV2Bool(value, fallback = false) {
  if (value === true || value === "true" || value === 1 || value === "1") return true;
  if (value === false || value === "false" || value === 0 || value === "0") return false;
  return fallback;
}

function realtimeV2SafeJson(value, fallback = {}) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value === "string" && value.trim()) {
    try { return JSON.parse(value); } catch {}
  }
  return fallback;
}

router.get("/realtime-v2-page-data", async (req, res) => {
  try {
    const channelsResult = await dbQuery(`
      SELECT
        id,
        name,
        display_name AS "displayName",
        description,
        visibility,
        status,
        allow_public_subscribe AS "allowPublicSubscribe",
        allow_public_publish AS "allowPublicPublish",
        require_api_key AS "requireApiKey",
        max_subscribers AS "maxSubscribers",
        retention_days AS "retentionDays",
        message_count AS "messageCount",
        last_message_at AS "lastMessageAt",
        policy_json AS "policy",
        metadata_json AS "metadata",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM backend_realtime_channels
      ORDER BY name ASC
      LIMIT 300
    `);

    const messagesResult = await dbQuery(`
      SELECT
        id,
        channel_id AS "channelId",
        channel,
        event_type AS "eventType",
        source,
        message,
        payload_json AS "payload",
        status,
        delivered_ws_count AS "deliveredWsCount",
        delivered_sse_count AS "deliveredSseCount",
        api_key_id AS "apiKeyId",
        connection_id AS "connectionId",
        metadata_json AS "metadata",
        created_at AS "createdAt"
      FROM backend_realtime_messages
      ORDER BY created_at DESC
      LIMIT 300
    `);

    const connectionsResult = await dbQuery(`
      SELECT
        id,
        transport,
        channel,
        status,
        api_key_id AS "apiKeyId",
        actor_type AS "actorType",
        actor_id AS "actorId",
        ip_address AS "ipAddress",
        user_agent AS "userAgent",
        connected_at AS "connectedAt",
        last_seen_at AS "lastSeenAt",
        disconnected_at AS "disconnectedAt",
        close_code AS "closeCode",
        close_reason AS "closeReason",
        metadata_json AS "metadata"
      FROM backend_realtime_connections
      ORDER BY connected_at DESC
      LIMIT 300
    `);

    const subscriptionsResult = await dbQuery(`
      SELECT
        id,
        connection_id AS "connectionId",
        channel,
        transport,
        api_key_id AS "apiKeyId",
        status,
        subscribed_at AS "subscribedAt",
        unsubscribed_at AS "unsubscribedAt",
        metadata_json AS "metadata"
      FROM backend_realtime_subscriptions
      ORDER BY subscribed_at DESC
      LIMIT 300
    `);

    const presenceResult = await dbQuery(`
      SELECT
        id,
        channel,
        connection_id AS "connectionId",
        api_key_id AS "apiKeyId",
        actor_type AS "actorType",
        actor_id AS "actorId",
        presence_state AS "presenceState",
        metadata_json AS "metadata",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM backend_realtime_presence
      ORDER BY updated_at DESC
      LIMIT 300
    `);

    const policyResult = await dbQuery(`
      SELECT
        id,
        name,
        target_type AS "targetType",
        target_id AS "targetId",
        operation,
        effect,
        priority,
        status,
        condition_json AS "conditionJson"
      FROM backend_policy_rules
      WHERE target_type = 'realtime'
      ORDER BY priority ASC, id ASC
    `);

    const channels = channelsResult.rows;
    const messages = messagesResult.rows;
    const connections = connectionsResult.rows;
    const subscriptions = subscriptionsResult.rows;
    const presence = presenceResult.rows;

    return ok(res, {
      channels,
      messages,
      connections,
      subscriptions,
      presence,
      policies: policyResult.rows,
      counts: {
        channels: channels.length,
        messages: messages.length,
        connections: connections.length,
        connected: connections.filter((item) => item.status === "connected").length,
        subscriptions: subscriptions.filter((item) => item.status === "active").length,
        presenceOnline: presence.filter((item) => item.presenceState === "online").length,
        policies: policyResult.rows.length,
      },
    });
  } catch (error) {
    return fail(res, "Failed to load Realtime V2 page data", 500, error.message);
  }
});

router.post("/realtime/channels/create-safe", async (req, res) => {
  try {
    const channel = realtimeV2CleanChannel(req.body?.name || req.body?.channel || "system");
    const id = `rtch_${channel.replace(/[^a-z0-9]/g, "_")}`.slice(0, 120);

    const result = await dbQuery(
      `
        INSERT INTO backend_realtime_channels (
          id,
          name,
          display_name,
          description,
          visibility,
          status,
          allow_public_subscribe,
          allow_public_publish,
          require_api_key,
          max_subscribers,
          retention_days,
          policy_json,
          metadata_json,
          organization_id,
          project_id,
          environment_id,
          created_by
        )
        VALUES ($1,$2,$3,$4,$5,'active',$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,'org_goodos','proj_goodos_platform','env_goodos_production',(SELECT id FROM users ORDER BY created_at ASC LIMIT 1))
        ON CONFLICT (id) DO UPDATE
        SET
          display_name = EXCLUDED.display_name,
          description = EXCLUDED.description,
          visibility = EXCLUDED.visibility,
          allow_public_subscribe = EXCLUDED.allow_public_subscribe,
          allow_public_publish = EXCLUDED.allow_public_publish,
          require_api_key = EXCLUDED.require_api_key,
          max_subscribers = EXCLUDED.max_subscribers,
          retention_days = EXCLUDED.retention_days,
          policy_json = EXCLUDED.policy_json,
          metadata_json = EXCLUDED.metadata_json,
          updated_at = NOW()
        RETURNING *
      `,
      [
        id,
        channel,
        String(req.body?.displayName || req.body?.display_name || channel).trim(),
        String(req.body?.description || `Realtime channel: ${channel}`).trim(),
        String(req.body?.visibility || "private").trim(),
        realtimeV2Bool(req.body?.allowPublicSubscribe ?? req.body?.allow_public_subscribe, true),
        realtimeV2Bool(req.body?.allowPublicPublish ?? req.body?.allow_public_publish, true),
        realtimeV2Bool(req.body?.requireApiKey ?? req.body?.require_api_key, true),
        Math.min(Math.max(Number(req.body?.maxSubscribers || req.body?.max_subscribers || 1000), 1), 100000),
        Math.min(Math.max(Number(req.body?.retentionDays || req.body?.retention_days || 30), 1), 3650),
        JSON.stringify(realtimeV2SafeJson(req.body?.policy || req.body?.policy_json, {})),
        JSON.stringify(realtimeV2SafeJson(req.body?.metadata || req.body?.metadata_json, { createdFrom: "GoodAppBackEnd Console" })),
      ]
    );

    return ok(res, { channel: result.rows[0], message: "Realtime channel created or updated." });
  } catch (error) {
    return fail(res, "Failed to create realtime channel", 500, error.message);
  }
});

router.get("/realtime-page-data", async (req, res) => {
  try {
    const eventsResult = await dbQuery(`
      SELECT
        id,
        event_type AS "eventType",
        source,
        channel,
        message,
        payload,
        status,
        created_at AS "createdAt"
      FROM backend_realtime_events
      ORDER BY created_at DESC
      LIMIT 250
    `);

    const channelsResult = await dbQuery(`
      SELECT channel, COUNT(*)::int AS count
      FROM backend_realtime_events
      GROUP BY channel
      ORDER BY channel ASC
    `);

    const clients = Array.from(getRealtimeClientMap().values()).map((client) => ({
      id: client.id,
      channel: client.channel,
      connectedAt: client.connectedAt,
      ip: client.ip,
    }));

    const events = eventsResult.rows;
    const channels = channelsResult.rows;

    return ok(res, {
      events,
      channels,
      clients,
      counts: {
        events: events.length,
        channels: channels.length,
        broadcasts: events.filter((event) => event.status === "recorded").length,
        consumers: clients.length,
      },
    });
  } catch (error) {
    return fail(res, "Failed to load realtime page data", 500, error.message);
  }
});

router.post("/realtime-events/create-test-safe", async (req, res) => {
  try {
    const eventType = String(req.body?.eventType || "system.test").trim();
    const source = String(req.body?.source || "backend-console").trim();
    const channel = normalizeRealtimeChannel(req.body?.channel || "system");
    const message = String(req.body?.message || "Realtime test event from GoodAppBackEnd console").trim();

    const payload = req.body?.payload && typeof req.body.payload === "object"
      ? req.body.payload
      : {
          test: true,
          createdFrom: "GoodAppBackEnd Console",
          time: new Date().toISOString(),
        };

    const result = await createRealtimeEventRecord({
      eventType,
      source,
      channel,
      message,
      payload,
      status: "recorded",
    });

    return ok(res, {
      event: result.event,
      deliveredClients: result.deliveredClients,
      message: "Realtime test event created and broadcast.",
    });
  } catch (error) {
    return fail(res, "Failed to create realtime test event", 500, error.message);
  }
});



router.get("/realtime-events/:id/detail-safe", async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();

    if (!id) return fail(res, "Realtime event id is required", 400);

    const result = await dbQuery(
      `
        SELECT
          id,
          event_type AS "eventType",
          source,
          channel,
          message,
          payload,
          status,
          created_at AS "createdAt"
        FROM backend_realtime_events
        WHERE id = $1
        LIMIT 1
      `,
      [id]
    );

    const event = result.rows[0];

    if (!event) return fail(res, "Realtime event not found", 404);

    return ok(res, { event });
  } catch (error) {
    return fail(res, "Failed to load realtime event detail", 500, error.message);
  }
});

router.post("/realtime-events/:id/replay-safe", async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();

    if (!id) return fail(res, "Realtime event id is required", 400);

    const result = await dbQuery(
      `
        SELECT
          id,
          event_type AS "eventType",
          source,
          channel,
          message,
          payload,
          status,
          created_at AS "createdAt"
        FROM backend_realtime_events
        WHERE id = $1
        LIMIT 1
      `,
      [id]
    );

    const event = result.rows[0];

    if (!event) return fail(res, "Realtime event not found", 404);

    const deliveredClients = broadcastRealtimeEventToClients({
      ...event,
      replayed: true,
      replayedAt: new Date().toISOString(),
    });

    await dbQuery(
      `
        INSERT INTO backend_admin_audit_logs (
          id,
          actor,
          action,
          target_type,
          target_id,
          after_json,
          ip_address,
          user_agent
        )
        VALUES ($1, $2, 'realtime.event.replay', 'realtime_event', $3, $4::jsonb, $5, $6)
      `,
      [
        `audit_${crypto.randomUUID().replace(/-/g, "")}`,
        req.user?.email || req.session?.user?.email || req.auth?.user?.email || "console-user",
        id,
        JSON.stringify({ deliveredClients }),
        req.headers["x-forwarded-for"] || req.socket?.remoteAddress || null,
        req.headers["user-agent"] || null,
      ]
    );

    return ok(res, {
      event,
      deliveredClients,
      message: "Realtime event replayed to connected clients.",
    });
  } catch (error) {
    return fail(res, "Failed to replay realtime event", 500, error.message);
  }
});

router.post("/realtime-events/cleanup-safe", async (req, res) => {
  try {
    const keepLast = Math.min(Math.max(Number(req.body?.keepLast || 1000), 100), 10000);

    const deleteResult = await dbQuery(
      `
        DELETE FROM backend_realtime_events
        WHERE id NOT IN (
          SELECT id
          FROM backend_realtime_events
          ORDER BY created_at DESC
          LIMIT $1
        )
        RETURNING id
      `,
      [keepLast]
    );

    await dbQuery(
      `
        INSERT INTO backend_admin_audit_logs (
          id,
          actor,
          action,
          target_type,
          target_id,
          after_json,
          ip_address,
          user_agent
        )
        VALUES ($1, $2, 'realtime.events.cleanup', 'realtime_events', 'bulk', $3::jsonb, $4, $5)
      `,
      [
        `audit_${crypto.randomUUID().replace(/-/g, "")}`,
        req.user?.email || req.session?.user?.email || req.auth?.user?.email || "console-user",
        JSON.stringify({ keepLast, deletedCount: deleteResult.rowCount || 0 }),
        req.headers["x-forwarded-for"] || req.socket?.remoteAddress || null,
        req.headers["user-agent"] || null,
      ]
    );

    return ok(res, {
      deletedCount: deleteResult.rowCount || 0,
      keepLast,
      message: "Realtime event cleanup complete.",
    });
  } catch (error) {
    return fail(res, "Failed to cleanup realtime events", 500, error.message);
  }
});


async function executeControlledEdgeFunction(fn, input = {}) {
  const startedAt = Date.now();
  const id = String(fn.id || "");
  const type = String(fn.type || "http");
  const triggerType = String(fn.trigger_type || fn.triggerType || "manual");

  if (id === "fn_http_health_check" || fn.route_path === "/api/functions/health-check") {
    const dbTime = await dbQuery("SELECT NOW() AS now");
    return {
      status: "success",
      output: {
        ok: true,
        functionId: id,
        name: fn.name,
        type,
        triggerType,
        routePath: fn.route_path || fn.routePath || null,
        runtime: process.version,
        databaseTime: dbTime.rows[0]?.now || null,
        uptimeSeconds: Math.floor(process.uptime()),
        input,
      },
      durationMs: Date.now() - startedAt,
    };
  }

  if (id === "fn_event_webhook_dispatcher" || triggerType === "webhook.event") {
    const eventPayload = {
      id: `evt_${crypto.randomUUID().replace(/-/g, "")}`,
      type: String(input.eventType || "edge.function.test"),
      eventType: String(input.eventType || "edge.function.test"),
      source: "edge-function",
      message: String(input.message || "Edge function event dispatch test."),
      createdAt: new Date().toISOString(),
      data: {
        functionId: id,
        functionName: fn.name,
        input,
      },
    };

    let webhookResult = { dispatched: 0 };

    if (typeof dispatchWebhooksForEvent === "function") {
      webhookResult = await dispatchWebhooksForEvent(eventPayload);
    }

    return {
      status: "success",
      output: {
        ok: true,
        functionId: id,
        name: fn.name,
        eventPayload,
        webhookResult,
      },
      durationMs: Date.now() - startedAt,
    };
  }

  if (id === "fn_scheduled_cleanup" || type === "scheduled") {
    const realtimeCount = await dbQuery("SELECT COUNT(*)::int AS count FROM backend_realtime_events");
    const logCount = await dbQuery("SELECT COUNT(*)::int AS count FROM backend_system_logs");

    return {
      status: "success",
      output: {
        ok: true,
        functionId: id,
        name: fn.name,
        schedule: fn.schedule || "manual",
        cleanupPreview: {
          realtimeEvents: Number(realtimeCount.rows[0]?.count || 0),
          systemLogs: Number(logCount.rows[0]?.count || 0),
          destructiveCleanup: false,
        },
        input,
      },
      durationMs: Date.now() - startedAt,
    };
  }

  return {
    status: "success",
    output: {
      ok: true,
      functionId: id,
      name: fn.name,
      type,
      triggerType,
      note: "Generic controlled Edge Function execution completed.",
      input,
    },
    durationMs: Date.now() - startedAt,
  };
}

async function runEdgeFunctionById(functionId, input = {}, actor = "console-user", triggerTypeOverride = "manual") {
  const fnResult = await dbQuery(
    `
      SELECT
        id,
        name,
        type,
        runtime,
        trigger_type,
        route_path,
        schedule,
        description,
        status,
        timeout_seconds,
        last_run_at,
        organization_id,
        project_id,
        environment_id,
        created_at,
        updated_at
      FROM backend_edge_functions
      WHERE id = $1
      LIMIT 1
    `,
    [functionId]
  );

  const fn = fnResult.rows[0];

  if (!fn) {
    const error = new Error("Edge function not found");
    error.statusCode = 404;
    throw error;
  }

  if (fn.status !== "active") {
    const error = new Error("Edge function is not active");
    error.statusCode = 400;
    throw error;
  }

  const runId = `fnrun_${crypto.randomUUID().replace(/-/g, "")}`;
  const startedAt = Date.now();
  const triggerType = triggerTypeOverride || fn.trigger_type || "manual";

  await dbQuery(
    `
      INSERT INTO backend_edge_function_runs (
        id,
        function_id,
        function_name,
        trigger_type,
        status,
        input_json,
        created_by,
        organization_id,
        project_id,
        environment_id
      )
      VALUES ($1, $2, $3, $4, 'started', $5::jsonb, $6, $7, $8, $9)
    `,
    [
      runId,
      fn.id,
      fn.name,
      triggerType,
      JSON.stringify(input || {}),
      actor,
      fn.organization_id,
      fn.project_id,
      fn.environment_id,
    ]
  );

  try {
    const execution = await executeControlledEdgeFunction(fn, input || {});
    const durationMs = Number(execution.durationMs || (Date.now() - startedAt));

    const runResult = await dbQuery(
      `
        UPDATE backend_edge_function_runs
        SET
          status = $2,
          output_json = $3::jsonb,
          error_message = NULL,
          duration_ms = $4,
          completed_at = NOW()
        WHERE id = $1
        RETURNING
          id,
          function_id AS "functionId",
          function_name AS "functionName",
          trigger_type AS "triggerType",
          status,
          input_json AS "input",
          output_json AS "output",
          error_message AS "errorMessage",
          duration_ms AS "durationMs",
          started_at AS "startedAt",
          completed_at AS "completedAt",
          created_by AS "createdBy"
      `,
      [
        runId,
        execution.status || "success",
        JSON.stringify(execution.output || {}),
        durationMs,
      ]
    );

    await dbQuery(
      `
        UPDATE backend_edge_functions
        SET
          last_run_at = NOW(),
          last_status = $2,
          last_error = NULL,
          run_count = run_count + 1,
          updated_at = NOW()
        WHERE id = $1
      `,
      [fn.id, execution.status || "success"]
    );

    return {
      function: fn,
      run: runResult.rows[0],
    };
  } catch (error) {
    const durationMs = Date.now() - startedAt;

    const runResult = await dbQuery(
      `
        UPDATE backend_edge_function_runs
        SET
          status = 'failed',
          error_message = $2,
          duration_ms = $3,
          completed_at = NOW()
        WHERE id = $1
        RETURNING
          id,
          function_id AS "functionId",
          function_name AS "functionName",
          trigger_type AS "triggerType",
          status,
          input_json AS "input",
          output_json AS "output",
          error_message AS "errorMessage",
          duration_ms AS "durationMs",
          started_at AS "startedAt",
          completed_at AS "completedAt",
          created_by AS "createdBy"
      `,
      [runId, error.message, durationMs]
    );

    await dbQuery(
      `
        UPDATE backend_edge_functions
        SET
          last_run_at = NOW(),
          last_status = 'failed',
          last_error = $2,
          run_count = run_count + 1,
          updated_at = NOW()
        WHERE id = $1
      `,
      [fn.id, error.message]
    );

    return {
      function: fn,
      run: runResult.rows[0],
    };
  }
}


function edgeV2SafeJson(value, fallback = {}) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value === "string" && value.trim()) {
    try { return JSON.parse(value); } catch {}
  }
  return fallback;
}

function edgeV2Bool(value, fallback = false) {
  if (value === true || value === "true" || value === 1 || value === "1") return true;
  if (value === false || value === "false" || value === 0 || value === "0") return false;
  return fallback;
}

function edgeV2CleanText(value, fallback = "") {
  return String(value ?? fallback ?? "").trim();
}

function edgeV2Runtime(value) {
  const runtime = edgeV2CleanText(value || "node").toLowerCase();
  if (["node", "nodejs", "javascript"].includes(runtime)) return "node";
  return "node";
}

function edgeV2HashCode(sourceCode = "") {
  return crypto.createHash("sha256").update(String(sourceCode || "")).digest("hex");
}

router.get("/edge-functions-v2-page-data", async (req, res) => {
  try {
    const functionsResult = await dbQuery(`
      SELECT
        id,
        name,
        type,
        runtime,
        trigger_type AS "triggerType",
        route_path AS "routePath",
        schedule,
        description,
        status,
        timeout_seconds AS "timeoutSeconds",
        timeout_ms AS "timeoutMs",
        memory_mb AS "memoryMb",
        max_input_bytes AS "maxInputBytes",
        runtime_version AS "runtimeVersion",
        runtime_profile AS "runtimeProfile",
        sandbox_mode AS "sandboxMode",
        network_access_enabled AS "networkAccessEnabled",
        secrets_enabled AS "secretsEnabled",
        public_invocation_enabled AS "publicInvocationEnabled",
        require_api_key AS "requireApiKey",
        environment_json AS "environment",
        permissions_json AS "permissions",
        limits_json AS "limits",
        metadata_json AS "metadata",
        deployment_id AS "deploymentId",
        current_version_id AS "currentVersionId",
        version_number AS "versionNumber",
        code_hash AS "codeHash",
        deployed_at AS "deployedAt",
        log_level AS "logLevel",
        run_count AS "runCount",
        last_status AS "lastStatus",
        last_error AS "lastError",
        last_run_at AS "lastRunAt",
        organization_id AS "organizationId",
        project_id AS "projectId",
        environment_id AS "environmentId",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM backend_edge_functions
      ORDER BY created_at DESC
      LIMIT 250
    `);

    const versionsResult = await dbQuery(`
      SELECT
        id,
        function_id AS "functionId",
        version_number AS "versionNumber",
        version_label AS "versionLabel",
        runtime,
        runtime_version AS "runtimeVersion",
        runtime_profile AS "runtimeProfile",
        sandbox_mode AS "sandboxMode",
        handler_name AS "handlerName",
        code_hash AS "codeHash",
        status,
        deployment_status AS "deploymentStatus",
        metadata_json AS "metadata",
        deployed_at AS "deployedAt",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM backend_edge_function_versions
      ORDER BY created_at DESC
      LIMIT 250
    `);

    const deploymentsResult = await dbQuery(`
      SELECT
        id,
        function_id AS "functionId",
        version_id AS "versionId",
        deployment_number AS "deploymentNumber",
        status,
        source,
        started_at AS "startedAt",
        completed_at AS "completedAt",
        duration_ms AS "durationMs",
        logs_json AS "logs",
        metadata_json AS "metadata",
        created_at AS "createdAt"
      FROM backend_edge_function_deployments
      ORDER BY created_at DESC
      LIMIT 250
    `);

    const secretsResult = await dbQuery(`
      SELECT
        id,
        function_id AS "functionId",
        secret_key AS "secretKey",
        secret_prefix AS "secretPrefix",
        secret_ref AS "secretRef",
        scope,
        status,
        metadata_json AS "metadata",
        rotated_at AS "rotatedAt",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM backend_edge_function_secrets
      ORDER BY created_at DESC
      LIMIT 250
    `);

    const runsResult = await dbQuery(`
      SELECT
        id,
        function_id AS "functionId",
        function_name AS "functionName",
        trigger_type AS "triggerType",
        status,
        error_message AS "errorMessage",
        duration_ms AS "durationMs",
        runtime_version AS "runtimeVersion",
        runtime_profile AS "runtimeProfile",
        sandbox_mode AS "sandboxMode",
        timeout_ms AS "timeoutMs",
        memory_mb AS "memoryMb",
        memory_used_mb AS "memoryUsedMb",
        metrics_json AS "metrics",
        logs_json AS "logs",
        deployment_id AS "deploymentId",
        version_id AS "versionId",
        code_hash AS "codeHash",
        invocation_source AS "invocationSource",
        timed_out AS "timedOut",
        started_at AS "startedAt",
        completed_at AS "completedAt",
        created_at AS "createdAt"
      FROM backend_edge_function_runs
      ORDER BY created_at DESC
      LIMIT 250
    `);

    const functions = functionsResult.rows;
    const versions = versionsResult.rows;
    const deployments = deploymentsResult.rows;
    const secrets = secretsResult.rows;
    const runs = runsResult.rows;

    return ok(res, {
      functions,
      versions,
      deployments,
      secrets,
      runs,
      counts: {
        functions: functions.length,
        versions: versions.length,
        deployments: deployments.length,
        secrets: secrets.length,
        runs: runs.length,
        active: functions.filter((item) => item.status === "active").length,
        publicCallable: functions.filter((item) => item.publicInvocationEnabled === true).length,
        v2Ready: functions.filter((item) => item.currentVersionId && item.deploymentId).length,
        failedRuns: runs.filter((item) => item.status === "failed").length,
        timedOutRuns: runs.filter((item) => item.timedOut === true).length,
      },
    });
  } catch (error) {
    return fail(res, "Failed to load Edge Functions V2 page data", 500, error.message);
  }
});

router.post("/edge-functions/:id/v2/update-safe", async (req, res) => {
  try {
    const id = edgeV2CleanText(req.params.id);
    if (!id) return fail(res, "Function id is required", 400);

    const beforeResult = await dbQuery("SELECT * FROM backend_edge_functions WHERE id = $1 LIMIT 1", [id]);
    const before = beforeResult.rows[0];
    if (!before) return fail(res, "Edge function not found", 404);

    const sourceCode = String(req.body?.sourceCode ?? req.body?.source_code ?? before.source_code ?? "");
    const codeHash = edgeV2HashCode(sourceCode || id);

    const result = await dbQuery(
      `
        UPDATE backend_edge_functions
        SET
          source_code = $2,
          handler_name = $3,
          runtime = $4,
          runtime_version = $5,
          runtime_profile = $6,
          sandbox_mode = $7,
          timeout_ms = $8,
          memory_mb = $9,
          max_input_bytes = $10,
          network_access_enabled = $11,
          secrets_enabled = $12,
          public_invocation_enabled = $13,
          require_api_key = $14,
          environment_json = $15::jsonb,
          permissions_json = $16::jsonb,
          limits_json = $17::jsonb,
          metadata_json = $18::jsonb,
          code_hash = $19,
          log_level = $20,
          updated_at = NOW()
        WHERE id = $1
        RETURNING *
      `,
      [
        id,
        sourceCode,
        edgeV2CleanText(req.body?.handlerName ?? req.body?.handler_name ?? before.handler_name ?? "handler"),
        edgeV2Runtime(req.body?.runtime ?? before.runtime ?? "node"),
        edgeV2CleanText(req.body?.runtimeVersion ?? req.body?.runtime_version ?? before.runtime_version ?? "node-v22"),
        edgeV2CleanText(req.body?.runtimeProfile ?? req.body?.runtime_profile ?? before.runtime_profile ?? "controlled"),
        edgeV2CleanText(req.body?.sandboxMode ?? req.body?.sandbox_mode ?? before.sandbox_mode ?? "goodos-controlled"),
        Math.min(Math.max(Number(req.body?.timeoutMs ?? req.body?.timeout_ms ?? before.timeout_ms ?? 5000), 500), 30000),
        Math.min(Math.max(Number(req.body?.memoryMb ?? req.body?.memory_mb ?? before.memory_mb ?? 128), 32), 1024),
        Math.min(Math.max(Number(req.body?.maxInputBytes ?? req.body?.max_input_bytes ?? before.max_input_bytes ?? 262144), 1024), 1048576),
        edgeV2Bool(req.body?.networkAccessEnabled ?? req.body?.network_access_enabled, before.network_access_enabled === true),
        edgeV2Bool(req.body?.secretsEnabled ?? req.body?.secrets_enabled, before.secrets_enabled !== false),
        edgeV2Bool(req.body?.publicInvocationEnabled ?? req.body?.public_invocation_enabled, before.public_invocation_enabled === true),
        edgeV2Bool(req.body?.requireApiKey ?? req.body?.require_api_key, before.require_api_key !== false),
        JSON.stringify(edgeV2SafeJson(req.body?.environment ?? req.body?.environment_json, before.environment_json || {})),
        JSON.stringify(edgeV2SafeJson(req.body?.permissions ?? req.body?.permissions_json, before.permissions_json || {})),
        JSON.stringify(edgeV2SafeJson(req.body?.limits ?? req.body?.limits_json, before.limits_json || {})),
        JSON.stringify(edgeV2SafeJson(req.body?.metadata ?? req.body?.metadata_json, before.metadata_json || {})),
        codeHash,
        edgeV2CleanText(req.body?.logLevel ?? req.body?.log_level ?? before.log_level ?? "info"),
      ]
    );

    await dbQuery(
      `
        INSERT INTO backend_admin_audit_logs (
          id,
          actor,
          action,
          target_type,
          target_id,
          before_json,
          after_json,
          organization_id,
          project_id,
          environment_id,
          ip_address,
          user_agent
        )
        VALUES ($1,$2,'edge_function.v2.update','edge_function',$3,$4::jsonb,$5::jsonb,'org_goodos','proj_goodos_platform','env_goodos_production',$6,$7)
      `,
      [
        `audit_${crypto.randomUUID().replace(/-/g, "")}`,
        req.user?.email || req.session?.user?.email || req.auth?.user?.email || "console-user",
        id,
        JSON.stringify(before),
        JSON.stringify(result.rows[0]),
        req.headers["x-forwarded-for"] || req.socket?.remoteAddress || null,
        req.headers["user-agent"] || null,
      ]
    );

    return ok(res, { function: result.rows[0], message: "Edge Function V2 settings updated." });
  } catch (error) {
    return fail(res, "Failed to update Edge Function V2 settings", 500, error.message);
  }
});

router.post("/edge-functions/:id/versions/create-safe", async (req, res) => {
  try {
    const functionId = edgeV2CleanText(req.params.id);
    if (!functionId) return fail(res, "Function id is required", 400);

    const fnResult = await dbQuery("SELECT * FROM backend_edge_functions WHERE id = $1 LIMIT 1", [functionId]);
    const fn = fnResult.rows[0];
    if (!fn) return fail(res, "Edge function not found", 404);

    const countResult = await dbQuery("SELECT COALESCE(MAX(version_number), 0)::int AS max_version FROM backend_edge_function_versions WHERE function_id = $1", [functionId]);
    const versionNumber = Number(countResult.rows[0]?.max_version || 0) + 1;
    const sourceCode = String(req.body?.sourceCode ?? req.body?.source_code ?? fn.source_code ?? "");
    const codeHash = edgeV2HashCode(sourceCode || `${functionId}:${versionNumber}`);
    const versionId = `fnver_${functionId}_v${versionNumber}`;

    const result = await dbQuery(
      `
        INSERT INTO backend_edge_function_versions (
          id,
          function_id,
          version_number,
          version_label,
          runtime,
          runtime_version,
          runtime_profile,
          sandbox_mode,
          handler_name,
          source_code,
          code_hash,
          status,
          deployment_status,
          environment_json,
          permissions_json,
          limits_json,
          metadata_json,
          organization_id,
          project_id,
          environment_id,
          created_by
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'active','draft',$12::jsonb,$13::jsonb,$14::jsonb,$15::jsonb,$16,$17,$18,(SELECT id FROM users ORDER BY created_at ASC LIMIT 1))
        RETURNING *
      `,
      [
        versionId,
        functionId,
        versionNumber,
        `v${versionNumber}`,
        fn.runtime || "node",
        fn.runtime_version || "node-v22",
        fn.runtime_profile || "controlled",
        fn.sandbox_mode || "goodos-controlled",
        fn.handler_name || "handler",
        sourceCode,
        codeHash,
        JSON.stringify(fn.environment_json || {}),
        JSON.stringify(fn.permissions_json || {}),
        JSON.stringify(fn.limits_json || {}),
        JSON.stringify({ createdFrom: "GoodAppBackEnd Console", phase: "19A" }),
        fn.organization_id || "org_goodos",
        fn.project_id || "proj_goodos_platform",
        fn.environment_id || "env_goodos_production",
      ]
    );

    return ok(res, { version: result.rows[0], message: "Edge Function version created." });
  } catch (error) {
    return fail(res, "Failed to create Edge Function version", 500, error.message);
  }
});

router.post("/edge-functions/:id/deploy-safe", async (req, res) => {
  try {
    const functionId = edgeV2CleanText(req.params.id);
    const versionId = edgeV2CleanText(req.body?.versionId || req.body?.version_id || "");

    if (!functionId) return fail(res, "Function id is required", 400);

    const fnResult = await dbQuery("SELECT * FROM backend_edge_functions WHERE id = $1 LIMIT 1", [functionId]);
    const fn = fnResult.rows[0];
    if (!fn) return fail(res, "Edge function not found", 404);

    let version = null;

    if (versionId) {
      const versionResult = await dbQuery("SELECT * FROM backend_edge_function_versions WHERE id = $1 AND function_id = $2 LIMIT 1", [versionId, functionId]);
      version = versionResult.rows[0];
      if (!version) return fail(res, "Version not found for this function", 404);
    } else {
      const latestResult = await dbQuery(
        "SELECT * FROM backend_edge_function_versions WHERE function_id = $1 ORDER BY version_number DESC LIMIT 1",
        [functionId]
      );
      version = latestResult.rows[0];
      if (!version) return fail(res, "No version exists for this function", 404);
    }

    const countResult = await dbQuery("SELECT COUNT(*)::int AS count FROM backend_edge_function_deployments WHERE function_id = $1", [functionId]);
    const deploymentNumber = Number(countResult.rows[0]?.count || 0) + 1;
    const deploymentId = `fndeploy_${functionId}_${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`;
    const startedAt = Date.now();

    const deploymentResult = await dbQuery(
      `
        INSERT INTO backend_edge_function_deployments (
          id,
          function_id,
          version_id,
          deployment_number,
          status,
          source,
          completed_at,
          duration_ms,
          logs_json,
          metadata_json,
          organization_id,
          project_id,
          environment_id,
          created_by
        )
        VALUES ($1,$2,$3,$4,'deployed',$5,NOW(),$6,$7::jsonb,$8::jsonb,$9,$10,$11,(SELECT id FROM users ORDER BY created_at ASC LIMIT 1))
        RETURNING *
      `,
      [
        deploymentId,
        functionId,
        version.id,
        deploymentNumber,
        edgeV2CleanText(req.body?.source || "console"),
        Date.now() - startedAt,
        JSON.stringify([{ level: "info", message: `Deployed ${version.id}`, time: new Date().toISOString() }]),
        JSON.stringify({ deployedFrom: "GoodAppBackEnd Console", phase: "19A" }),
        fn.organization_id || "org_goodos",
        fn.project_id || "proj_goodos_platform",
        fn.environment_id || "env_goodos_production",
      ]
    );

    const updateResult = await dbQuery(
      `
        UPDATE backend_edge_functions
        SET
          source_code = $2,
          code_hash = $3,
          current_version_id = $4,
          version_number = $5,
          deployment_id = $6,
          deployed_at = NOW(),
          deployed_by = (SELECT id FROM users ORDER BY created_at ASC LIMIT 1),
          updated_at = NOW()
        WHERE id = $1
        RETURNING *
      `,
      [
        functionId,
        version.source_code || fn.source_code || "",
        version.code_hash || fn.code_hash || null,
        version.id,
        version.version_number || fn.version_number || 1,
        deploymentId,
      ]
    );

    await dbQuery(
      "UPDATE backend_edge_function_versions SET deployment_status = 'deployed', deployed_at = NOW(), deployed_by = (SELECT id FROM users ORDER BY created_at ASC LIMIT 1), updated_at = NOW() WHERE id = $1",
      [version.id]
    );

    return ok(res, {
      deployment: deploymentResult.rows[0],
      function: updateResult.rows[0],
      message: "Edge Function deployed.",
    });
  } catch (error) {
    return fail(res, "Failed to deploy Edge Function", 500, error.message);
  }
});

router.post("/edge-functions/:id/secrets/create-safe", async (req, res) => {
  try {
    const functionId = edgeV2CleanText(req.params.id);
    if (!functionId) return fail(res, "Function id is required", 400);

    const secretKey = edgeV2CleanText(req.body?.secretKey || req.body?.secret_key || "");
    const secretValue = String(req.body?.secretValue || req.body?.secret_value || "");

    if (!secretKey) return fail(res, "Secret key is required", 400);
    if (!/^[A-Z0-9_]{3,80}$/.test(secretKey)) return fail(res, "Secret key must be uppercase letters, numbers, and underscores.", 400);
    if (!secretValue) return fail(res, "Secret value is required", 400);

    const secretId = `fnsecret_${functionId}_${secretKey.toLowerCase()}_${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;
    const valueHash = crypto.createHash("sha256").update(secretValue).digest("hex");
    const prefix = secretValue.slice(0, 8);

    const result = await dbQuery(
      `
        INSERT INTO backend_edge_function_secrets (
          id,
          function_id,
          secret_key,
          secret_prefix,
          value_hash,
          secret_ref,
          scope,
          status,
          metadata_json,
          organization_id,
          project_id,
          environment_id,
          created_by,
          rotated_at
        )
        VALUES ($1,$2,$3,$4,$5,$6,'function','active',$7::jsonb,'org_goodos','proj_goodos_platform','env_goodos_production',(SELECT id FROM users ORDER BY created_at ASC LIMIT 1),NOW())
        RETURNING
          id,
          function_id AS "functionId",
          secret_key AS "secretKey",
          secret_prefix AS "secretPrefix",
          secret_ref AS "secretRef",
          scope,
          status,
          metadata_json AS "metadata",
          rotated_at AS "rotatedAt",
          created_at AS "createdAt"
      `,
      [
        secretId,
        functionId,
        secretKey,
        prefix,
        valueHash,
        `internal://edge-functions/${functionId}/${secretKey}`,
        JSON.stringify({ createdFrom: "GoodAppBackEnd Console", rawValueStored: false }),
      ]
    );

    return ok(res, {
      secret: result.rows[0],
      warning: "Raw secret value was hashed and is not returned.",
      message: "Edge Function secret reference created.",
    });
  } catch (error) {
    return fail(res, "Failed to create Edge Function secret", 500, error.message);
  }
});

router.get("/edge-functions-page-data", async (req, res) => {
  try {
    const result = await dbQuery(`
      SELECT
        id,
        name,
        type,
        runtime,
        trigger_type AS "triggerType",
        route_path AS "routePath",
        schedule,
        description,
        status,
        timeout_seconds AS "timeoutSeconds",
        run_count AS "runCount",
        last_status AS "lastStatus",
        last_error AS "lastError",
        last_run_at AS "lastRunAt",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM backend_edge_functions
      ORDER BY created_at DESC
      LIMIT 250
    `);

    const runsResult = await dbQuery(`
      SELECT
        id,
        function_id AS "functionId",
        function_name AS "functionName",
        trigger_type AS "triggerType",
        status,
        input_json AS "input",
        output_json AS "output",
        error_message AS "errorMessage",
        duration_ms AS "durationMs",
        started_at AS "startedAt",
        completed_at AS "completedAt",
        created_by AS "createdBy"
      FROM backend_edge_function_runs
      ORDER BY started_at DESC
      LIMIT 250
    `);

    const functions = result.rows;
    const runs = runsResult.rows;

    return ok(res, {
      functions,
      runs,
      counts: {
        functions: functions.length,
        http: functions.filter((item) => item.type === "http").length,
        event: functions.filter((item) => item.type === "event").length,
        scheduled: functions.filter((item) => item.type === "scheduled").length,
        active: functions.filter((item) => item.status === "active").length,
        runs: runs.length,
        failedRuns: runs.filter((item) => item.status === "failed").length,
      },
    });
  } catch (error) {
    return fail(res, "Failed to load edge functions page data", 500, error.message);
  }
});


router.post("/edge-functions/create-test-safe", async (req, res) => {
  try {
    const id = `fn_${crypto.randomUUID().replace(/-/g, "")}`;
    const name = String(req.body?.name || "Console Test Function").trim();
    const type = String(req.body?.type || "http").trim();
    const runtime = String(req.body?.runtime || "node").trim();
    const triggerType = String(req.body?.triggerType || "manual").trim();
    const routePath = String(req.body?.routePath || `/api/functions/${id}`).trim();
    const description = String(req.body?.description || "Test function created from GoodAppBackEnd console.").trim();

    const result = await dbQuery(
      `
        INSERT INTO backend_edge_functions (
          id,
          name,
          type,
          runtime,
          trigger_type,
          route_path,
          description,
          status
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'active')
        RETURNING
          id,
          name,
          type,
          runtime,
          trigger_type AS "triggerType",
          route_path AS "routePath",
          schedule,
          description,
          status,
          last_run_at AS "lastRunAt",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
      `,
      [id, name, type, runtime, triggerType, routePath, description]
    );

    return ok(res, {
      function: result.rows[0],
      message: "Edge function registry record created.",
    });
  } catch (error) {
    return fail(res, "Failed to create edge function", 500, error.message);
  }
});

router.post("/edge-functions/:id/run-test-safe", async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    const input = req.body?.input && typeof req.body.input === "object"
      ? req.body.input
      : {
          test: true,
          source: "console-run-test",
          time: new Date().toISOString(),
        };

    const actor = req.user?.email || req.session?.user?.email || req.auth?.user?.email || "console-user";
    const result = await runEdgeFunctionById(id, input, actor, "manual");

    return ok(res, {
      ...result,
      message: "Edge function executed.",
    });
  } catch (error) {
    return fail(res, "Failed to run edge function", error.statusCode || 500, error.message);
  }
});

router.get("/edge-functions/runs/:id/detail-safe", async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();

    const result = await dbQuery(
      `
        SELECT
          id,
          function_id AS "functionId",
          function_name AS "functionName",
          trigger_type AS "triggerType",
          status,
          input_json AS "input",
          output_json AS "output",
          error_message AS "errorMessage",
          duration_ms AS "durationMs",
          started_at AS "startedAt",
          completed_at AS "completedAt",
          created_by AS "createdBy"
        FROM backend_edge_function_runs
        WHERE id = $1
        LIMIT 1
      `,
      [id]
    );

    const run = result.rows[0];

    if (!run) return fail(res, "Edge function run not found", 404);

    return ok(res, { run });
  } catch (error) {
    return fail(res, "Failed to load edge function run detail", 500, error.message);
  }
});

router.post("/edge-functions/:id/toggle-safe", async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    const status = String(req.body?.status || "").trim().toLowerCase();

    if (!["active", "disabled", "planned"].includes(status)) {
      return fail(res, "Status must be active, disabled, or planned.", 400);
    }

    const result = await dbQuery(
      `
        UPDATE backend_edge_functions
        SET status = $2, updated_at = NOW()
        WHERE id = $1
        RETURNING
          id,
          name,
          type,
          runtime,
          trigger_type AS "triggerType",
          route_path AS "routePath",
          schedule,
          description,
          status,
          timeout_seconds AS "timeoutSeconds",
          run_count AS "runCount",
          last_status AS "lastStatus",
          last_error AS "lastError",
          last_run_at AS "lastRunAt",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
      `,
      [id, status]
    );

    if (!result.rows[0]) return fail(res, "Edge function not found", 404);

    await dbQuery(
      `
        INSERT INTO backend_admin_audit_logs (
          id,
          actor,
          action,
          target_type,
          target_id,
          after_json,
          ip_address,
          user_agent
        )
        VALUES ($1, $2, 'edge_function.status.update', 'edge_function', $3, $4::jsonb, $5, $6)
      `,
      [
        `audit_${crypto.randomUUID().replace(/-/g, "")}`,
        req.user?.email || req.session?.user?.email || req.auth?.user?.email || "console-user",
        id,
        JSON.stringify({ status }),
        req.headers["x-forwarded-for"] || req.socket?.remoteAddress || null,
        req.headers["user-agent"] || null,
      ]
    );

    return ok(res, {
      function: result.rows[0],
      message: "Edge function status updated.",
    });
  } catch (error) {
    return fail(res, "Failed to update edge function status", 500, error.message);
  }
});



function readTailLines(filePath, lineCount = 80) {
  try {
    const fs = require("fs");
    const childProcess = require("child_process");

    if (!fs.existsSync(filePath)) return [];

    const output = childProcess.execFileSync("tail", ["-n", String(lineCount), filePath], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    });

    return output
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch (error) {
    return [];
  }
}


function findReadableLogFile(candidates = []) {
  const fs = require("fs");

  for (const candidate of candidates.filter(Boolean)) {
    try {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    } catch {}
  }

  return candidates.filter(Boolean)[0] || "";
}

function getGoodAppBackendLogPaths() {
  return {
    output: findReadableLogFile([
      "/root/.pm2/logs/goodapp-backend-out.log",
      "/root/.pm2/logs/goodapp-backend-out-19.log",
      "/home/mgoodlo3/.pm2/logs/goodapp-backend-out.log",
      "/home/mgoodlo3/.pm2/logs/goodapp-backend-out-19.log",
    ]),
    error: findReadableLogFile([
      "/root/.pm2/logs/goodapp-backend-error.log",
      "/root/.pm2/logs/goodapp-backend-error-19.log",
      "/home/mgoodlo3/.pm2/logs/goodapp-backend-error.log",
      "/home/mgoodlo3/.pm2/logs/goodapp-backend-error-19.log",
    ]),
  };
}

function safeLogLevel(value) {
  const level = String(value || "info").trim().toLowerCase();
  if (["debug", "info", "warn", "warning", "error", "output"].includes(level)) return level === "warning" ? "warn" : level;
  return "info";
}

function tailLogFileStructured(filePath, level = "output", source = "pm2:goodapp-backend", lineCount = 120) {
  return readTailLines(filePath, lineCount).map((line, index) => ({
    id: `${level}_${index}`,
    source,
    level,
    message: line,
    filePath,
    createdAt: null,
    context: {
      filePath,
      lineIndex: index,
    },
  }));
}

router.get("/logs-page-data", async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query?.limit || 250), 50), 1000);
    const level = String(req.query?.level || "").trim().toLowerCase();
    const search = String(req.query?.search || "").trim();

    const params = [];
    const where = [];

    if (level && level !== "all") {
      params.push(level);
      where.push(`level = $${params.length}`);
    }

    if (search) {
      params.push(`%${search}%`);
      where.push(`(message ILIKE $${params.length} OR source ILIKE $${params.length})`);
    }

    params.push(limit);

    const dbLogsResult = await dbQuery(
      `
        SELECT
          id,
          source,
          level,
          message,
          context,
          created_at AS "createdAt"
        FROM backend_system_logs
        ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY created_at DESC
        LIMIT $${params.length}
      `,
      params
    );

    const logPaths = getGoodAppBackendLogPaths();

    const outputLines = tailLogFileStructured(logPaths.output, "output", "pm2:goodapp-backend", 160);
    const errorLines = tailLogFileStructured(logPaths.error, "error", "pm2:goodapp-backend", 160);
    const databaseLogs = dbLogsResult.rows;

    let logs = [
      ...databaseLogs,
      ...errorLines.reverse(),
      ...outputLines.reverse(),
    ].slice(0, limit);

    if (level && level !== "all") {
      logs = logs.filter((log) => String(log.level || "").toLowerCase() === level);
    }

    if (search) {
      const term = search.toLowerCase();
      logs = logs.filter((log) =>
        String(log.message || "").toLowerCase().includes(term) ||
        String(log.source || "").toLowerCase().includes(term)
      );
    }

    return ok(res, {
      logs,
      counts: {
        logFiles: [logPaths.output, logPaths.error].filter(Boolean).length,
        databaseLogs: databaseLogs.length,
        errors: logs.filter((log) => log.level === "error").length,
        output: logs.filter((log) => log.level === "output").length,
        total: logs.length,
      },
      files: logPaths,
      filters: {
        level: level || "all",
        search,
        limit,
      },
    });
  } catch (error) {
    return fail(res, "Failed to load logs page data", 500, error.message);
  }
});


router.post("/logs/create-test-safe", async (req, res) => {
  try {
    const id = `log_${crypto.randomUUID().replace(/-/g, "")}`;
    const level = safeLogLevel(req.body?.level || "info");
    const source = String(req.body?.source || "backend-console").trim();
    const message = String(req.body?.message || "Test log from GoodAppBackEnd console.").trim();

    const context = req.body?.context && typeof req.body.context === "object"
      ? req.body.context
      : {
          test: true,
          createdFrom: "GoodAppBackEnd Console",
          time: new Date().toISOString(),
        };

    const result = await dbQuery(
      `
        INSERT INTO backend_system_logs (
          id,
          source,
          level,
          message,
          context
        )
        VALUES ($1, $2, $3, $4, $5::jsonb)
        RETURNING
          id,
          source,
          level,
          message,
          context,
          created_at AS "createdAt"
      `,
      [id, source, level, message, JSON.stringify(context)]
    );

    if (level === "error") {
      console.error("[console-test-error]", message, context);
    } else if (level === "warn") {
      console.warn("[console-test-warn]", message, context);
    } else {
      console.log("[console-test-log]", message, context);
    }

    return ok(res, {
      log: result.rows[0],
      message: "Test log created.",
    });
  } catch (error) {
    return fail(res, "Failed to create test log", 500, error.message);
  }
});

router.get("/logs/pm2-file-safe", async (req, res) => {
  try {
    const file = String(req.query?.file || "output").trim().toLowerCase();
    const lines = Math.min(Math.max(Number(req.query?.lines || 200), 20), 1000);
    const logPaths = getGoodAppBackendLogPaths();
    const selectedPath = file === "error" ? logPaths.error : logPaths.output;

    const logs = tailLogFileStructured(
      selectedPath,
      file === "error" ? "error" : "output",
      "pm2:goodapp-backend",
      lines
    );

    return ok(res, {
      file,
      filePath: selectedPath,
      lines: logs,
      count: logs.length,
    });
  } catch (error) {
    return fail(res, "Failed to read PM2 log file", 500, error.message);
  }
});

router.get("/logs/:id/detail-safe", async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();

    const result = await dbQuery(
      `
        SELECT
          id,
          source,
          level,
          message,
          context,
          created_at AS "createdAt"
        FROM backend_system_logs
        WHERE id = $1
        LIMIT 1
      `,
      [id]
    );

    const log = result.rows[0];

    if (!log) return fail(res, "Database log not found", 404);

    return ok(res, { log });
  } catch (error) {
    return fail(res, "Failed to load log detail", 500, error.message);
  }
});

router.post("/logs/cleanup-safe", async (req, res) => {
  try {
    const keepLast = Math.min(Math.max(Number(req.body?.keepLast || 1000), 100), 50000);

    const deleteResult = await dbQuery(
      `
        DELETE FROM backend_system_logs
        WHERE id NOT IN (
          SELECT id
          FROM backend_system_logs
          ORDER BY created_at DESC
          LIMIT $1
        )
        RETURNING id
      `,
      [keepLast]
    );

    await dbQuery(
      `
        INSERT INTO backend_admin_audit_logs (
          id,
          actor,
          action,
          target_type,
          target_id,
          after_json,
          ip_address,
          user_agent
        )
        VALUES ($1, $2, 'logs.cleanup', 'backend_system_logs', 'bulk', $3::jsonb, $4, $5)
      `,
      [
        `audit_${crypto.randomUUID().replace(/-/g, "")}`,
        req.user?.email || req.session?.user?.email || req.auth?.user?.email || "console-user",
        JSON.stringify({ keepLast, deletedCount: deleteResult.rowCount || 0 }),
        req.headers["x-forwarded-for"] || req.socket?.remoteAddress || null,
        req.headers["user-agent"] || null,
      ]
    );

    return ok(res, {
      deletedCount: deleteResult.rowCount || 0,
      keepLast,
      message: "Log cleanup complete.",
    });
  } catch (error) {
    return fail(res, "Failed to cleanup logs", 500, error.message);
  }
});



router.get("/backups-page-data", async (req, res) => {
  try {
    const result = await dbQuery(`
      SELECT
        id,
        name,
        type,
        status,
        size_bytes AS "sizeBytes",
        file_path AS "filePath",
        backup_format AS "backupFormat",
        checksum_sha256 AS "checksumSha256",
        database_name AS "databaseName",
        notes,
        error_message AS "errorMessage",
        created_by AS "createdBy",
        completed_at AS "completedAt",
        deleted_at AS "deletedAt",
        deleted_by AS "deletedBy",
        deleted_reason AS "deletedReason",
        file_deleted AS "fileDeleted",
        created_at AS "createdAt"
      FROM backend_backups
      ORDER BY created_at DESC
      LIMIT 250
    `);

    const backups = result.rows;

    let restoreTests = [];

    try {
      const restoreTestsResult = await dbQuery(`
        SELECT
          id,
          backup_id AS "backupId",
          test_database AS "testDatabase",
          status,
          table_count AS "tableCount",
          row_count AS "rowCount",
          error_message AS "errorMessage",
          started_at AS "startedAt",
          completed_at AS "completedAt",
          created_at AS "createdAt"
        FROM backend_backup_restore_tests
        ORDER BY created_at DESC
        LIMIT 100
      `);
      restoreTests = restoreTestsResult.rows;
    } catch (restoreTestError) {
      restoreTests = [];
    }

    return ok(res, {
      backups,
      restoreTests,
      counts: {
        backups: backups.length,
        completed: backups.filter((item) => item.status === "completed").length,
        failed: backups.filter((item) => item.status === "failed").length,
        pending: backups.filter((item) => item.status === "pending").length,
      },
    });
  } catch (error) {
    return fail(res, "Failed to load backups page data", 500, error.message);
  }
});

router.post("/backups/create-safe", async (req, res) => {
  try {
    const id = `backup_${crypto.randomUUID().replace(/-/g, "")}`;
    const now = new Date();
    const name = String(req.body?.name || `Manual Backup ${now.toISOString()}`).trim();
    const type = String(req.body?.type || "database").trim();
    const notes = String(req.body?.notes || "Manual backup record created from GoodAppBackEnd console.").trim();

    const result = await dbQuery(
      `
        INSERT INTO backend_backups (
          id,
          name,
          type,
          status,
          size_bytes,
          file_path,
          notes,
          created_by,
          completed_at
        )
        VALUES ($1, $2, $3, 'completed', 0, '/var/www/GoodAppBackEnd/backups', $4, 'console', NOW())
        RETURNING
          id,
          name,
          type,
          status,
          size_bytes AS "sizeBytes",
          file_path AS "filePath",
          notes,
          created_by AS "createdBy",
          completed_at AS "completedAt",
          created_at AS "createdAt"
      `,
      [id, name, type, notes]
    );

    return ok(res, {
      backup: result.rows[0],
      message: "Backup record created.",
    });
  } catch (error) {
    return fail(res, "Failed to create backup record", 500, error.message);
  }
});



function getSecuritySettingValue(row = {}) {
  const valueJson = row.valueJson || row.value_json || {};
  if (valueJson && typeof valueJson === "object" && Object.prototype.hasOwnProperty.call(valueJson, "value")) {
    return valueJson.value;
  }

  return valueJson;
}

function normalizeSecuritySettingValue(value, valueType = "string") {
  const type = String(valueType || "string").toLowerCase();

  if (type === "boolean") {
    if (typeof value === "boolean") return value;
    return ["true", "1", "yes", "on", "enabled", "active"].includes(String(value || "").trim().toLowerCase());
  }

  if (type === "number") {
    const numberValue = Number(value);
    if (!Number.isFinite(numberValue)) return 0;
    return numberValue;
  }

  if (type === "json") {
    if (value && typeof value === "object") return value;
    try {
      return JSON.parse(String(value || "{}"));
    } catch {
      return {};
    }
  }

  return String(value ?? "").trim();
}

function isSecuritySettingKeyAllowed(settingKey = "") {
  const key = String(settingKey || "").toLowerCase();
  return (
    key.startsWith("security.") ||
    key.startsWith("auth.") ||
    key.startsWith("domain.cors") ||
    key.includes("cookie") ||
    key.includes("jwt") ||
    key.includes("rate")
  );
}


function normalizePolicyAdminArray(value, fallback = []) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  if (typeof value === "string" && value.trim()) {
    return value.split(",").map((item) => item.trim()).filter(Boolean);
  }
  return fallback;
}

function normalizePolicyAdminSlug(value, fallback = "*") {
  return String(value || fallback)
    .trim()
    .replace(/[^a-zA-Z0-9:_*.-]/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 140) || fallback;
}

function normalizePolicyEffect(value) {
  const effect = String(value || "allow").trim().toLowerCase();
  if (["allow", "deny"].includes(effect)) return effect;
  return "allow";
}

function normalizePolicyTargetType(value) {
  const targetType = String(value || "db_api").trim().toLowerCase();
  if (["*", "db_api", "storage", "function", "webhook", "admin", "api_key", "realtime"].includes(targetType)) return targetType;
  return "db_api";
}

function normalizePolicyOperation(value) {
  const operation = String(value || "*").trim().toLowerCase();
  if (["*", "read", "insert", "update", "delete", "execute", "write", "admin", "list"].includes(operation)) return operation;
  return "*";
}

router.get("/policy-rules-page-data", async (req, res) => {
  try {
    const rulesResult = await dbQuery(`
      SELECT
        id,
        name,
        description,
        target_type AS "targetType",
        target_id AS "targetId",
        operation,
        effect,
        priority,
        condition_json AS "conditionJson",
        message,
        status,
        organization_id AS "organizationId",
        project_id AS "projectId",
        environment_id AS "environmentId",
        metadata_json AS "metadata",
        created_by::text AS "createdBy",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM backend_policy_rules
      ORDER BY priority ASC, target_type ASC, target_id ASC, operation ASC
      LIMIT 300
    `);

    const evaluationsResult = await dbQuery(`
      SELECT
        id,
        policy_id AS "policyId",
        decision,
        reason,
        target_type AS "targetType",
        target_id AS "targetId",
        operation,
        actor_type AS "actorType",
        actor_id AS "actorId",
        api_key_id AS "apiKeyId",
        organization_id AS "organizationId",
        project_id AS "projectId",
        environment_id AS "environmentId",
        context_json AS "context",
        created_at AS "createdAt"
      FROM backend_policy_evaluations
      ORDER BY created_at DESC
      LIMIT 150
    `);

    const summaryResult = await dbQuery(`
      SELECT
        target_type AS "targetType",
        decision,
        COUNT(*)::int AS count
      FROM backend_policy_evaluations
      WHERE created_at > NOW() - INTERVAL '24 hours'
      GROUP BY target_type, decision
      ORDER BY target_type ASC, decision ASC
    `);

    const rules = rulesResult.rows;
    const evaluations = evaluationsResult.rows;

    return ok(res, {
      rules,
      evaluations,
      summary: summaryResult.rows,
      counts: {
        rules: rules.length,
        activeRules: rules.filter((rule) => rule.status === "active").length,
        denyRules: rules.filter((rule) => rule.effect === "deny").length,
        evaluations: evaluations.length,
        denied24h: summaryResult.rows.filter((item) => item.decision === "deny").reduce((sum, item) => sum + Number(item.count || 0), 0),
      },
    });
  } catch (error) {
    return fail(res, "Failed to load policy rules page data", 500, error.message);
  }
});

router.post("/policy-rules/create-safe", async (req, res) => {
  try {
    const name = String(req.body?.name || "").trim();
    if (!name) return fail(res, "Policy name is required", 400);

    const targetType = normalizePolicyTargetType(req.body?.targetType);
    const targetId = normalizePolicyAdminSlug(req.body?.targetId || "*");
    const operation = normalizePolicyOperation(req.body?.operation || "*");
    const effect = normalizePolicyEffect(req.body?.effect || "allow");
    const priority = Math.min(Math.max(Number(req.body?.priority || 100), 1), 10000);
    const status = String(req.body?.status || "active").trim().toLowerCase();
    const conditionJson = req.body?.conditionJson && typeof req.body.conditionJson === "object" ? req.body.conditionJson : {};
    const description = String(req.body?.description || "").trim();
    const message = String(req.body?.message || "").trim();

    const id = `pol_${targetType}_${targetId}_${operation}_${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`
      .replace(/[^a-zA-Z0-9_:-]/g, "_")
      .slice(0, 160);

    const result = await dbQuery(
      `
        INSERT INTO backend_policy_rules (
          id,
          name,
          description,
          target_type,
          target_id,
          operation,
          effect,
          priority,
          condition_json,
          message,
          status,
          organization_id,
          project_id,
          environment_id,
          metadata_json,
          created_by
        )
        VALUES ($1,$2,NULLIF($3,''),$4,$5,$6,$7,$8,$9::jsonb,NULLIF($10,''),$11,'org_goodos','proj_goodos_platform','env_goodos_production',$12::jsonb,(SELECT id FROM users ORDER BY created_at ASC LIMIT 1))
        RETURNING
          id,
          name,
          description,
          target_type AS "targetType",
          target_id AS "targetId",
          operation,
          effect,
          priority,
          condition_json AS "conditionJson",
          message,
          status,
          organization_id AS "organizationId",
          project_id AS "projectId",
          environment_id AS "environmentId",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
      `,
      [
        id,
        name,
        description,
        targetType,
        targetId,
        operation,
        effect,
        priority,
        JSON.stringify(conditionJson),
        message,
        status,
        JSON.stringify({ createdFrom: "GoodAppBackEnd Console" }),
      ]
    );

    await dbQuery(
      `
        INSERT INTO backend_admin_audit_logs (
          id,
          actor,
          action,
          target_type,
          target_id,
          after_json,
          organization_id,
          project_id,
          environment_id,
          ip_address,
          user_agent
        )
        VALUES ($1,$2,'policy.rule.create','policy_rule',$3,$4::jsonb,'org_goodos','proj_goodos_platform','env_goodos_production',$5,$6)
      `,
      [
        `audit_${crypto.randomUUID().replace(/-/g, "")}`,
        req.user?.email || req.session?.user?.email || req.auth?.user?.email || "console-user",
        id,
        JSON.stringify(result.rows[0]),
        req.headers["x-forwarded-for"] || req.socket?.remoteAddress || null,
        req.headers["user-agent"] || null,
      ]
    );

    return ok(res, { rule: result.rows[0], message: "Policy rule created." });
  } catch (error) {
    return fail(res, "Failed to create policy rule", 500, error.message);
  }
});

router.post("/policy-rules/:id/update-safe", async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();

    const beforeResult = await dbQuery("SELECT * FROM backend_policy_rules WHERE id = $1 LIMIT 1", [id]);
    const before = beforeResult.rows[0];

    if (!before) return fail(res, "Policy rule not found", 404);

    const patch = req.body && typeof req.body === "object" ? req.body : {};

    const name = String(patch.name ?? before.name ?? "").trim();
    const description = String(patch.description ?? before.description ?? "").trim();
    const targetType = normalizePolicyTargetType(patch.targetType ?? before.target_type);
    const targetId = normalizePolicyAdminSlug(patch.targetId ?? before.target_id ?? "*");
    const operation = normalizePolicyOperation(patch.operation ?? before.operation ?? "*");
    const effect = normalizePolicyEffect(patch.effect ?? before.effect ?? "allow");
    const priority = Math.min(Math.max(Number(patch.priority ?? before.priority ?? 100), 1), 10000);
    const conditionJson = patch.conditionJson && typeof patch.conditionJson === "object" ? patch.conditionJson : (before.condition_json || {});
    const message = String(patch.message ?? before.message ?? "").trim();
    const status = String(patch.status ?? before.status ?? "active").trim().toLowerCase();

    const result = await dbQuery(
      `
        UPDATE backend_policy_rules
        SET
          name = $2,
          description = NULLIF($3, ''),
          target_type = $4,
          target_id = $5,
          operation = $6,
          effect = $7,
          priority = $8,
          condition_json = $9::jsonb,
          message = NULLIF($10, ''),
          status = $11,
          updated_at = NOW()
        WHERE id = $1
        RETURNING
          id,
          name,
          description,
          target_type AS "targetType",
          target_id AS "targetId",
          operation,
          effect,
          priority,
          condition_json AS "conditionJson",
          message,
          status,
          organization_id AS "organizationId",
          project_id AS "projectId",
          environment_id AS "environmentId",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
      `,
      [
        id,
        name,
        description,
        targetType,
        targetId,
        operation,
        effect,
        priority,
        JSON.stringify(conditionJson),
        message,
        status,
      ]
    );

    await dbQuery(
      `
        INSERT INTO backend_admin_audit_logs (
          id,
          actor,
          action,
          target_type,
          target_id,
          before_json,
          after_json,
          organization_id,
          project_id,
          environment_id,
          ip_address,
          user_agent
        )
        VALUES ($1,$2,'policy.rule.update','policy_rule',$3,$4::jsonb,$5::jsonb,'org_goodos','proj_goodos_platform','env_goodos_production',$6,$7)
      `,
      [
        `audit_${crypto.randomUUID().replace(/-/g, "")}`,
        req.user?.email || req.session?.user?.email || req.auth?.user?.email || "console-user",
        id,
        JSON.stringify(before),
        JSON.stringify(result.rows[0]),
        req.headers["x-forwarded-for"] || req.socket?.remoteAddress || null,
        req.headers["user-agent"] || null,
      ]
    );

    return ok(res, { rule: result.rows[0], message: "Policy rule updated." });
  } catch (error) {
    return fail(res, "Failed to update policy rule", 500, error.message);
  }
});

router.post("/policy-rules/test-safe", async (req, res) => {
  try {
    const targetType = normalizePolicyTargetType(req.body?.targetType || "db_api");
    const targetId = normalizePolicyAdminSlug(req.body?.targetId || "*");
    const operation = normalizePolicyOperation(req.body?.operation || "read");
    const scopes = normalizePolicyAdminArray(req.body?.scopes || ["read:db"]);
    const appIds = normalizePolicyAdminArray(req.body?.allowedAppIds || ["*"]);

    const policiesResult = await dbQuery(
      `
        SELECT
          id,
          name,
          target_type AS "targetType",
          target_id AS "targetId",
          operation,
          effect,
          priority,
          condition_json AS "conditionJson",
          message,
          status
        FROM backend_policy_rules
        WHERE status = 'active'
          AND (target_type = '*' OR target_type = $1)
          AND (target_id = '*' OR target_id = $2)
          AND (operation = '*' OR operation = $3)
        ORDER BY priority ASC, created_at ASC
      `,
      [targetType, targetId, operation]
    );

    const requiredMatches = (condition) => {
      const requiredScopes = normalizePolicyAdminArray(condition.requiredScopes || condition.required_scopes || []);
      if (requiredScopes.length && !requiredScopes.every((scope) => scopes.includes(scope))) return false;

      const anyScopes = normalizePolicyAdminArray(condition.anyScopes || condition.any_scopes || []);
      if (anyScopes.length && !anyScopes.some((scope) => scopes.includes(scope))) return false;

      const allowedAppIds = normalizePolicyAdminArray(condition.allowedAppIds || condition.allowed_app_ids || []);
      if (allowedAppIds.length && !allowedAppIds.some((appId) => appId === "*" || appIds.includes(appId))) return false;

      return true;
    };

    const matched = policiesResult.rows.filter((policy) => requiredMatches(policy.conditionJson || {}));
    const deny = matched.find((policy) => policy.effect === "deny");
    const allow = matched.find((policy) => policy.effect === "allow");

    const decision = deny
      ? { allowed: false, decision: "deny", policy: deny, reason: deny.message || "Denied by policy." }
      : allow
        ? { allowed: true, decision: "allow", policy: allow, reason: allow.message || "Allowed by policy." }
        : { allowed: true, decision: "allow", policy: null, reason: "No matching policy. Existing controls would decide." };

    return ok(res, {
      request: { targetType, targetId, operation, scopes, allowedAppIds: appIds },
      matchedPolicies: matched,
      decision,
    });
  } catch (error) {
    return fail(res, "Failed to test policy", 500, error.message);
  }
});

router.get("/security-page-data", async (req, res) => {
  try {
    const settingsResult = await dbQuery(`
      SELECT
        id,
        category,
        setting_key AS "settingKey",
        label,
        value_json AS "valueJson",
        value_type AS "valueType",
        is_secret AS "isSecret",
        is_editable AS "isEditable",
        description,
        status,
        updated_at AS "updatedAt"
      FROM backend_platform_settings
      WHERE category ILIKE '%security%'
         OR category ILIKE '%auth%'
         OR category ILIKE '%cors%'
         OR setting_key ILIKE '%security%'
         OR setting_key ILIKE '%auth%'
         OR setting_key ILIKE '%cors%'
         OR setting_key ILIKE '%cookie%'
         OR setting_key ILIKE '%jwt%'
         OR setting_key ILIKE '%rate%'
      ORDER BY category ASC, label ASC
      LIMIT 150
    `);

    const sessionsResult = await dbQuery(`
      SELECT
        id::text,
        user_id::text AS "userId",
        ip_address::text AS "ipAddress",
        user_agent AS "userAgent",
        expires_at AS "expiresAt",
        revoked_at AS "revokedAt",
        created_at AS "createdAt",
        CASE
          WHEN revoked_at IS NULL AND expires_at > NOW() THEN true
          ELSE false
        END AS "isActive"
      FROM sessions
      ORDER BY created_at DESC
      LIMIT 100
    `);

    const auditResult = await dbQuery(`
      SELECT
        id,
        actor,
        action,
        target_type AS "targetType",
        target_id AS "targetId",
        before_json AS "beforeJson",
        after_json AS "afterJson",
        ip_address AS "ipAddress",
        user_agent AS "userAgent",
        created_at AS "createdAt"
      FROM backend_admin_audit_logs
      WHERE action ILIKE '%security%'
         OR action ILIKE '%auth%'
         OR action ILIKE '%session%'
         OR action ILIKE '%api_key%'
      ORDER BY created_at DESC
      LIMIT 100
    `);

    const countsResult = await dbQuery(`
      SELECT
        (SELECT COUNT(*)::int FROM sessions WHERE revoked_at IS NULL AND expires_at > NOW()) AS active_sessions,
        (SELECT COUNT(*)::int FROM sessions WHERE revoked_at IS NOT NULL) AS revoked_sessions,
        (SELECT COUNT(*)::int FROM sessions WHERE revoked_at IS NULL AND expires_at <= NOW()) AS expired_sessions,
        (SELECT COUNT(*)::int FROM backend_api_keys WHERE status = 'active') AS active_api_keys,
        (SELECT COUNT(*)::int FROM backend_platform_settings WHERE status = 'active') AS active_settings
    `);

    const settings = settingsResult.rows;
    const sessions = sessionsResult.rows;
    const auditLogs = auditResult.rows;
    const counts = countsResult.rows[0] || {};

    const settingMap = {};
    for (const setting of settings) {
      settingMap[setting.settingKey] = getSecuritySettingValue(setting);
    }

    const currentSessionId = req.auth?.sessionId || null;

    return ok(res, {
      security: {
        headers: {
          helmet: true,
          hsts: true,
          csp: true,
          frameOptions: true,
          noSniff: true,
          referrerPolicy: true,
          crossOriginProtection: true,
        },
        cors: {
          credentials: true,
          allowedDomain: settingMap["auth.sso_domain"] || process.env.AUTH_COOKIE_DOMAIN || ".goodos.app",
          sameSite: process.env.AUTH_COOKIE_SAMESITE || "lax",
          goodosSubdomainsAllowed: true,
        },
        auth: {
          cookieName: settingMap["auth.cookie_name"] || process.env.AUTH_COOKIE_NAME || "goodos_session",
          cookieDomain: settingMap["auth.sso_domain"] || process.env.AUTH_COOKIE_DOMAIN || ".goodos.app",
          sessionDays: settingMap["auth.session_days"] || process.env.SESSION_DAYS || "7",
          jwtExpiresIn: process.env.JWT_EXPIRES_IN || "7d",
          ownerOnlyAdmin: settingMap["auth.owner_only_admin"] ?? true,
          emailVerification: settingMap["auth.email_verification"] ?? true,
        },
        rateLimit: {
          status: settingMap["security.rate_limit"] || "planned",
          loginLimiter: true,
        },
      },
      settings,
      sessions: sessions.map((session) => ({
        ...session,
        isCurrent: String(session.id) === String(currentSessionId),
      })),
      auditLogs,
      counts: {
        activeSessions: Number(counts.active_sessions || 0),
        revokedSessions: Number(counts.revoked_sessions || 0),
        expiredSessions: Number(counts.expired_sessions || 0),
        activeApiKeys: Number(counts.active_api_keys || 0),
        activeSettings: Number(counts.active_settings || 0),
        auditLogs: auditLogs.length,
      },
    });
  } catch (error) {
    return fail(res, "Failed to load security page data", 500, error.message);
  }
});

router.post("/security/settings/:id/update-safe", async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();

    const existingResult = await dbQuery(
      `
        SELECT
          id,
          category,
          setting_key AS "settingKey",
          label,
          value_json AS "valueJson",
          value_type AS "valueType",
          is_editable AS "isEditable",
          status
        FROM backend_platform_settings
        WHERE id = $1
        LIMIT 1
      `,
      [id]
    );

    const existing = existingResult.rows[0];

    if (!existing) return fail(res, "Security setting not found", 404);
    if (!existing.isEditable) return fail(res, "This setting is not editable", 400);
    if (!isSecuritySettingKeyAllowed(existing.settingKey)) return fail(res, "This setting is not allowed from Security Rules", 400);

    const newValue = normalizeSecuritySettingValue(req.body?.value, existing.valueType);
    const newValueJson = { value: newValue };

    const updateResult = await dbQuery(
      `
        UPDATE backend_platform_settings
        SET
          value_json = $2::jsonb,
          updated_at = NOW()
        WHERE id = $1
        RETURNING
          id,
          category,
          setting_key AS "settingKey",
          label,
          value_json AS "valueJson",
          value_type AS "valueType",
          is_secret AS "isSecret",
          is_editable AS "isEditable",
          description,
          status,
          updated_at AS "updatedAt"
      `,
      [id, JSON.stringify(newValueJson)]
    );

    await dbQuery(
      `
        INSERT INTO backend_admin_audit_logs (
          id,
          actor,
          action,
          target_type,
          target_id,
          before_json,
          after_json,
          ip_address,
          user_agent
        )
        VALUES ($1, $2, 'security.setting.update', 'platform_setting', $3, $4::jsonb, $5::jsonb, $6, $7)
      `,
      [
        `audit_${crypto.randomUUID().replace(/-/g, "")}`,
        req.user?.email || req.session?.user?.email || req.auth?.user?.email || "console-user",
        id,
        JSON.stringify(existing),
        JSON.stringify(updateResult.rows[0]),
        req.headers["x-forwarded-for"] || req.socket?.remoteAddress || null,
        req.headers["user-agent"] || null,
      ]
    );

    return ok(res, {
      setting: updateResult.rows[0],
      message: "Security setting updated.",
    });
  } catch (error) {
    return fail(res, "Failed to update security setting", 500, error.message);
  }
});

router.post("/security/sessions/:id/revoke-safe", async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();

    if (!id) return fail(res, "Session id is required", 400);

    if (String(req.auth?.sessionId || "") === id) {
      return fail(res, "Current session cannot be revoked from this control. Use Logout instead.", 400);
    }

    const result = await dbQuery(
      `
        UPDATE sessions
        SET revoked_at = NOW()
        WHERE id = $1::uuid
          AND revoked_at IS NULL
        RETURNING
          id::text,
          user_id::text AS "userId",
          ip_address::text AS "ipAddress",
          user_agent AS "userAgent",
          expires_at AS "expiresAt",
          revoked_at AS "revokedAt",
          created_at AS "createdAt"
      `,
      [id]
    );

    const session = result.rows[0];

    if (!session) return fail(res, "Session not found or already revoked", 404);

    await dbQuery(
      `
        INSERT INTO backend_admin_audit_logs (
          id,
          actor,
          action,
          target_type,
          target_id,
          after_json,
          ip_address,
          user_agent
        )
        VALUES ($1, $2, 'security.session.revoke', 'session', $3, $4::jsonb, $5, $6)
      `,
      [
        `audit_${crypto.randomUUID().replace(/-/g, "")}`,
        req.user?.email || req.session?.user?.email || req.auth?.user?.email || "console-user",
        id,
        JSON.stringify(session),
        req.headers["x-forwarded-for"] || req.socket?.remoteAddress || null,
        req.headers["user-agent"] || null,
      ]
    );

    return ok(res, {
      session,
      message: "Session revoked.",
    });
  } catch (error) {
    return fail(res, "Failed to revoke session", 500, error.message);
  }
});

router.post("/security/sessions/cleanup-expired-safe", async (req, res) => {
  try {
    const result = await dbQuery(`
      UPDATE sessions
      SET revoked_at = NOW()
      WHERE revoked_at IS NULL
        AND expires_at <= NOW()
      RETURNING id::text
    `);

    await dbQuery(
      `
        INSERT INTO backend_admin_audit_logs (
          id,
          actor,
          action,
          target_type,
          target_id,
          after_json,
          ip_address,
          user_agent
        )
        VALUES ($1, $2, 'security.sessions.cleanup_expired', 'sessions', 'expired', $3::jsonb, $4, $5)
      `,
      [
        `audit_${crypto.randomUUID().replace(/-/g, "")}`,
        req.user?.email || req.session?.user?.email || req.auth?.user?.email || "console-user",
        JSON.stringify({ revokedCount: result.rowCount || 0 }),
        req.headers["x-forwarded-for"] || req.socket?.remoteAddress || null,
        req.headers["user-agent"] || null,
      ]
    );

    return ok(res, {
      revokedCount: result.rowCount || 0,
      message: "Expired session cleanup complete.",
    });
  } catch (error) {
    return fail(res, "Failed to cleanup expired sessions", 500, error.message);
  }
});

router.get("/settings-page-data", async (req, res) => {
  try {
    const settingsResult = await dbQuery(`
      SELECT
        id,
        category,
        setting_key AS "settingKey",
        label,
        CASE
          WHEN is_secret = true THEN '{"value":"********"}'::jsonb
          ELSE value_json
        END AS "valueJson",
        value_type AS "valueType",
        is_secret AS "isSecret",
        is_editable AS "isEditable",
        description,
        status,
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM backend_platform_settings
      ORDER BY category ASC, label ASC
      LIMIT 500
    `);

    const categoriesResult = await dbQuery(`
      SELECT
        category,
        COUNT(*)::int AS count,
        COUNT(*) FILTER (WHERE status = 'active')::int AS active,
        COUNT(*) FILTER (WHERE status = 'planned')::int AS planned
      FROM backend_platform_settings
      GROUP BY category
      ORDER BY category ASC
    `);

    const memory = process.memoryUsage();

    return ok(res, {
      settings: settingsResult.rows,
      categories: categoriesResult.rows,
      runtime: {
        environment: process.env.NODE_ENV || "production",
        service: "Goodbase",
        node: process.version,
        pid: process.pid,
        uptimeSeconds: Math.floor(process.uptime()),
        uptime: `${Math.floor(process.uptime() / 60)} min`,
        memoryHeapMb: Math.round(memory.heapUsed / 1024 / 1024),
        database: "connected",
      },
      counts: {
        settings: settingsResult.rows.length,
        categories: categoriesResult.rows.length,
        active: settingsResult.rows.filter((item) => item.status === "active").length,
        planned: settingsResult.rows.filter((item) => item.status === "planned").length,
      },
    });
  } catch (error) {
    return fail(res, "Failed to load settings page data", 500, error.message);
  }
});

router.post("/settings/update-safe", async (req, res) => {
  try {
    const settingKey = String(req.body?.settingKey || "").trim();
    const value = req.body?.value;

    if (!settingKey) return fail(res, "Setting key is required", 400);

    const existingResult = await dbQuery(
      `
        SELECT setting_key, is_editable, is_secret
        FROM backend_platform_settings
        WHERE setting_key = $1
      `,
      [settingKey]
    );

    const existing = existingResult.rows[0];

    if (!existing) return fail(res, "Setting not found", 404);
    if (!existing.is_editable) return fail(res, "This setting is read only", 403);
    if (existing.is_secret) return fail(res, "Secret settings cannot be edited from this console yet", 403);

    const result = await dbQuery(
      `
        UPDATE backend_platform_settings
        SET
          value_json = $2::jsonb,
          updated_at = NOW()
        WHERE setting_key = $1
        RETURNING
          id,
          category,
          setting_key AS "settingKey",
          label,
          value_json AS "valueJson",
          value_type AS "valueType",
          is_secret AS "isSecret",
          is_editable AS "isEditable",
          description,
          status,
          created_at AS "createdAt",
          updated_at AS "updatedAt"
      `,
      [settingKey, JSON.stringify({ value })]
    );

    await dbQuery(
      `
        INSERT INTO backend_admin_audit_logs (
          id,
          actor,
          action,
          target_type,
          target_id,
          after_json,
          ip_address,
          user_agent
        )
        VALUES ($1, $2, 'settings.update', 'platform_setting', $3, $4::jsonb, $5, $6)
      `,
      [
        `audit_${crypto.randomUUID().replace(/-/g, "")}`,
        req.user?.email || req.session?.user?.email || req.auth?.user?.email || "console-user",
        settingKey,
        JSON.stringify({ value }),
        req.headers["x-forwarded-for"] || req.socket?.remoteAddress || null,
        req.headers["user-agent"] || null,
      ]
    );

    return ok(res, {
      setting: result.rows[0],
      message: "Setting updated.",
    });
  } catch (error) {
    return fail(res, "Failed to update setting", 500, error.message);
  }
});


router.get("/settings-readiness-page-data", async (req, res) => {
  try {
    const countsResult = await dbQuery(`
      SELECT
        (SELECT COUNT(*)::int FROM users WHERE status = 'active') AS users,
        (SELECT COUNT(*)::int FROM apps WHERE status = 'active') AS apps,
        (SELECT COUNT(*)::int FROM app_memberships WHERE status = 'active') AS memberships,
        (SELECT COUNT(*)::int FROM sessions WHERE revoked_at IS NULL AND expires_at > NOW()) AS sessions,
        (SELECT COUNT(*)::int FROM backend_api_keys WHERE status = 'active') AS "activeApiKeys",
        (SELECT COUNT(*)::int FROM backend_storage_buckets WHERE status = 'active') AS buckets,
        (SELECT COUNT(*)::int FROM backend_storage_files) AS files,
        (SELECT COUNT(*)::int FROM backend_webhooks WHERE status = 'active') AS "activeWebhooks",
        (SELECT COUNT(*)::int FROM backend_webhook_deliveries) AS "webhookDeliveries",
        (SELECT COUNT(*)::int FROM backend_realtime_events) AS "realtimeEvents",
        (SELECT COUNT(*)::int FROM backend_edge_functions) AS "edgeFunctions",
        (SELECT COUNT(*)::int FROM backend_system_logs) AS "systemLogs",
        (SELECT COUNT(*)::int FROM backend_backups) AS backups,
        (SELECT COUNT(*)::int FROM backend_platform_settings) AS settings
    `);

    const counts = countsResult.rows[0] || {};

    const checks = [
      { category: "Auth", label: "Owner account exists", status: counts.users > 0 ? "ready" : "missing", value: counts.users },
      { category: "Apps", label: "App registry populated", status: counts.apps >= 10 ? "ready" : "partial", value: counts.apps },
      { category: "Apps", label: "Owner app memberships", status: counts.memberships >= counts.apps ? "ready" : "partial", value: counts.memberships },
      { category: "Sessions", label: "Active session tracking", status: counts.sessions > 0 ? "ready" : "missing", value: counts.sessions },
      { category: "API Keys", label: "Active scoped API keys", status: counts.activeApiKeys > 0 ? "ready" : "missing", value: counts.activeApiKeys },
      { category: "Storage", label: "Storage buckets configured", status: counts.buckets > 0 ? "ready" : "missing", value: counts.buckets },
      { category: "Storage", label: "File tracking active", status: counts.files > 0 ? "ready" : "missing", value: counts.files },
      { category: "Webhooks", label: "Webhook endpoints active", status: counts.activeWebhooks > 0 ? "ready" : "missing", value: counts.activeWebhooks },
      { category: "Webhooks", label: "Delivery logs active", status: counts.webhookDeliveries > 0 ? "ready" : "missing", value: counts.webhookDeliveries },
      { category: "Realtime", label: "Realtime event table active", status: counts.realtimeEvents > 0 ? "ready" : "missing", value: counts.realtimeEvents },
      { category: "Functions", label: "Edge function registry active", status: counts.edgeFunctions > 0 ? "ready" : "missing", value: counts.edgeFunctions },
      { category: "Logs", label: "System logging active", status: counts.systemLogs > 0 ? "ready" : "missing", value: counts.systemLogs },
      { category: "Backups", label: "Backup registry active", status: counts.backups > 0 ? "ready" : "missing", value: counts.backups },
      { category: "Settings", label: "Platform settings registry active", status: counts.settings >= 40 ? "ready" : "partial", value: counts.settings },
    ];

    const ready = checks.filter((check) => check.status === "ready").length;
    const partial = checks.filter((check) => check.status === "partial").length;
    const missing = checks.filter((check) => check.status === "missing").length;

    return ok(res, {
      checks,
      counts,
      score: {
        ready,
        partial,
        missing,
        total: checks.length,
        percent: Math.round((ready / checks.length) * 100),
      },
    });
  } catch (error) {
    return fail(res, "Failed to load settings readiness data", 500, error.message);
  }
});

router.get("/settings-audit-page-data", async (req, res) => {
  try {
    const result = await dbQuery(`
      SELECT
        id,
        actor,
        action,
        target_type AS "targetType",
        target_id AS "targetId",
        before_json AS "beforeJson",
        after_json AS "afterJson",
        ip_address AS "ipAddress",
        user_agent AS "userAgent",
        created_at AS "createdAt"
      FROM backend_admin_audit_logs
      ORDER BY created_at DESC
      LIMIT 250
    `);

    return ok(res, {
      auditLogs: result.rows,
    });
  } catch (error) {
    return fail(res, "Failed to load settings audit data", 500, error.message);
  }
});






router.get("/ssl-certificates-page-data", async (req, res) => {
  try {
    const force = ["1", "true", "yes"].includes(
      String(req.query?.force || "").trim().toLowerCase()
    );

    const snapshot =
      await sslCertificatesService.getSslCertificatesSnapshot({
        force,
      });

    return ok(res, snapshot);
  } catch (error) {
    return fail(
      res,
      "Failed to load SSL certificate page data",
      500,
      error.message
    );
  }
});


router.get("/secrets-v2-page-data", async (req, res) => {
  try {
    const snapshot = await secretService.listSecrets();
    return ok(res, snapshot);
  } catch (error) {
    return fail(res, "Failed to load Secrets V2 page data", 500, error.message);
  }
});

router.post("/secrets/create-safe", async (req, res) => {
  try {
    const secret = await secretService.createOrRotateSecret({
      secretKey: req.body?.secretKey || req.body?.secret_key,
      secretValue: req.body?.secretValue || req.body?.secret_value,
      displayName: req.body?.displayName || req.body?.display_name,
      category: req.body?.category || "general",
      description: req.body?.description || "",
      actorId: currentUserId(req) || "admin-console",
    });

    return ok(res, {
      secret,
      message: "Secret created or rotated safely.",
    });
  } catch (error) {
    return fail(res, "Failed to create or rotate secret", error.statusCode || 500, error.message);
  }
});

router.post("/secrets/:key/rotate-safe", async (req, res) => {
  try {
    const secret = await secretService.createOrRotateSecret({
      secretKey: req.params.key,
      secretValue: req.body?.secretValue || req.body?.secret_value,
      displayName: req.body?.displayName || req.body?.display_name || req.params.key,
      category: req.body?.category || "general",
      description: req.body?.description || "Rotated from admin console.",
      actorId: currentUserId(req) || "admin-console",
    });

    return ok(res, {
      secret,
      message: "Secret rotated safely.",
    });
  } catch (error) {
    return fail(res, "Failed to rotate secret", error.statusCode || 500, error.message);
  }
});

router.post("/secrets/:key/resolve-test-safe", async (req, res) => {
  try {
    const value = await secretService.getSecretValue(req.params.key);

    if (!value) return fail(res, "Secret not found", 404);

    return ok(res, {
      resolved: true,
      length: String(value).length,
      preview: String(value).slice(0, 3) + "***",
      warning: "Raw value was resolved for test but not returned.",
    });
  } catch (error) {
    return fail(res, "Failed to resolve secret test", 500, error.message);
  }
});

router.get("/jobs-page-data", async (req, res) => {
  try {
    const snapshot = await jobService.getJobsSnapshot();
    return ok(res, snapshot);
  } catch (error) {
    return fail(res, "Failed to load jobs page data", 500, error.message);
  }
});

router.post("/jobs/run-due-safe", async (req, res) => {
  try {
    const result = await jobService.runDueJobs({
      workerId: `admin-manual-${process.pid}`,
      limit: Math.min(Math.max(Number(req.body?.limit || 10), 1), 50),
      source: "admin-console",
    });

    return ok(res, {
      ...result,
      message: "Due jobs processed.",
    });
  } catch (error) {
    return fail(res, "Failed to run due jobs", 500, error.message);
  }
});

router.post("/jobs/:id/run-safe", async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();

    const result = await jobService.runJobById(id, {
      workerId: `admin-manual-${process.pid}`,
      source: "admin-console",
    });

    return ok(res, {
      ...result,
      message: "Job run completed.",
    });
  } catch (error) {
    return fail(res, "Failed to run job", error.statusCode || 500, error.message);
  }
});

router.post("/jobs/:id/status-safe", async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    const status = String(req.body?.status || "active").trim().toLowerCase();

    if (!["active", "disabled", "paused", "archived"].includes(status)) {
      return fail(res, "Status must be active, disabled, paused, or archived.", 400);
    }

    const result = await dbQuery(
      `
        UPDATE backend_jobs
        SET status = $2,
            updated_at = NOW()
        WHERE id = $1 OR name = $1
        RETURNING id, name, display_name AS "displayName", status, updated_at AS "updatedAt"
      `,
      [id, status]
    );

    if (!result.rows[0]) return fail(res, "Job not found", 404);

    await dbQuery(
      `
        UPDATE backend_job_schedules
        SET enabled = $2,
            updated_at = NOW()
        WHERE job_id = $1
      `,
      [result.rows[0].id, status === "active"]
    ).catch(() => null);

    return ok(res, {
      job: result.rows[0],
      message: "Job status updated.",
    });
  } catch (error) {
    return fail(res, "Failed to update job status", 500, error.message);
  }
});

router.post("/jobs/queue-items/create-safe", async (req, res) => {
  try {
    const queueName = String(req.body?.queueName || req.body?.queue_name || "default").trim() || "default";
    const handlerKey = String(req.body?.handlerKey || req.body?.handler_key || "queue.items.process").trim() || "queue.items.process";
    const payload = req.body?.payload || { createdFrom: "admin-console" };
    const id = `queue_${crypto.randomUUID().replace(/-/g, "")}`;

    const result = await dbQuery(
      `
        INSERT INTO backend_queue_items (
          id,
          queue_name,
          item_type,
          status,
          priority,
          handler_key,
          payload_json,
          scheduled_at,
          metadata_json,
          organization_id,
          project_id,
          environment_id
        )
        VALUES ($1,$2,'job','pending',$3,$4,$5::jsonb,NOW(),$6::jsonb,'org_goodos','proj_goodos_platform','env_goodos_production')
        RETURNING id, queue_name AS "queueName", status, handler_key AS "handlerKey", created_at AS "createdAt"
      `,
      [
        id,
        queueName,
        Number(req.body?.priority || 100),
        handlerKey,
        JSON.stringify(payload),
        JSON.stringify({ createdFrom: "Jobs V2 Console" }),
      ]
    );

    return ok(res, {
      queueItem: result.rows[0],
      message: "Queue item created.",
    });
  } catch (error) {
    return fail(res, "Failed to create queue item", 500, error.message);
  }
});

router.get("/notifications-page-data", async (req, res) => {
  try {
    const snapshot = await notificationService.getNotificationSnapshot();
    return ok(res, snapshot);
  } catch (error) {
    return fail(res, "Failed to load notifications page data", 500, error.message);
  }
});

router.post("/notifications/test-safe", async (req, res) => {
  try {
    const notification = await notificationService.createNotification({
      title: req.body?.title || "GoodOS test notification",
      message: req.body?.message || "This is a Notifications V2 test message.",
      severity: req.body?.severity || "info",
      category: req.body?.category || "system",
      channel: req.body?.channel || "in_app",
      recipientEmail: req.body?.recipientEmail || req.body?.email || null,
      queueEmail: req.body?.queueEmail === true,
      templateKey: req.body?.templateKey || "system.notice",
      variables: {
        title: req.body?.title || "GoodOS test notification",
        message: req.body?.message || "This is a Notifications V2 test message."
      },
      source: "admin-console",
      sourceId: "notifications-test-safe",
      payload: {
        createdFrom: "GoodAppBackEnd Console",
        time: new Date().toISOString()
      }
    });

    return ok(res, {
      notification,
      message: "Notification test created.",
    });
  } catch (error) {
    return fail(res, "Failed to create test notification", 500, error.message);
  }
});

router.post("/notifications/email-queue/process-safe", async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.body?.limit || 10), 1), 50);
    const result = await notificationService.processEmailQueue(limit);

    return ok(res, {
      ...result,
      message: "Email queue processed.",
    });
  } catch (error) {
    return fail(res, "Failed to process email queue", 500, error.message);
  }
});

router.post("/notifications/alerts/evaluate-safe", async (req, res) => {
  try {
    const result = await notificationService.evaluateAlertRules();

    return ok(res, {
      ...result,
      message: "Alert rules evaluated.",
    });
  } catch (error) {
    return fail(res, "Failed to evaluate alert rules", 500, error.message);
  }
});

router.post("/notifications/:id/read-safe", async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();

    const result = await dbQuery(
      `
        UPDATE backend_notifications
        SET status = 'read',
            read_at = NOW(),
            updated_at = NOW()
        WHERE id = $1
        RETURNING id, title, status, read_at AS "readAt"
      `,
      [id]
    );

    await dbQuery(
      `
        UPDATE backend_message_center
        SET status = 'read',
            read_at = NOW(),
            updated_at = NOW()
        WHERE notification_id = $1
      `,
      [id]
    ).catch(() => null);

    if (!result.rows[0]) return fail(res, "Notification not found", 404);

    return ok(res, {
      notification: result.rows[0],
      message: "Notification marked read.",
    });
  } catch (error) {
    return fail(res, "Failed to mark notification read", 500, error.message);
  }
});

router.post("/notifications/alert-rules/:id/status-safe", async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    const status = String(req.body?.status || "active").trim().toLowerCase();

    if (!["active", "disabled", "planned", "archived"].includes(status)) {
      return fail(res, "Status must be active, disabled, planned, or archived.", 400);
    }

    const result = await dbQuery(
      `
        UPDATE backend_alert_rules
        SET status = $2,
            updated_at = NOW()
        WHERE id = $1
        RETURNING id, rule_key AS "ruleKey", name, status, updated_at AS "updatedAt"
      `,
      [id, status]
    );

    if (!result.rows[0]) return fail(res, "Alert rule not found", 404);

    return ok(res, {
      alertRule: result.rows[0],
      message: "Alert rule status updated.",
    });
  } catch (error) {
    return fail(res, "Failed to update alert rule", 500, error.message);
  }
});

router.get("/billing-page-data", async (req, res) => {
  try {
    const plansResult = await dbQuery(`
      SELECT
        id,
        name,
        display_name AS "displayName",
        description,
        currency,
        monthly_price_cents AS "monthlyPriceCents",
        annual_price_cents AS "annualPriceCents",
        included_json AS "included",
        limits_json AS "limits",
        features_json AS "features",
        status,
        sort_order AS "sortOrder",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM backend_billing_plans
      ORDER BY sort_order ASC, monthly_price_cents ASC
    `);

    const customersResult = await dbQuery(`
      SELECT
        id,
        organization_id AS "organizationId",
        user_id::text AS "userId",
        name,
        email,
        provider,
        billing_email AS "billingEmail",
        tax_status AS "taxStatus",
        status,
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM backend_billing_customers
      ORDER BY created_at DESC
      LIMIT 250
    `);

    const subscriptionsResult = await dbQuery(`
      SELECT
        s.id,
        s.customer_id AS "customerId",
        c.name AS "customerName",
        s.organization_id AS "organizationId",
        s.plan_id AS "planId",
        s.plan_name AS "planName",
        p.display_name AS "planDisplayName",
        s.status,
        s.billing_cycle AS "billingCycle",
        s.current_period_start AS "currentPeriodStart",
        s.current_period_end AS "currentPeriodEnd",
        s.provider,
        s.created_at AS "createdAt",
        s.updated_at AS "updatedAt"
      FROM backend_subscriptions s
      LEFT JOIN backend_billing_customers c ON c.id = s.customer_id
      LEFT JOIN backend_billing_plans p ON p.id = s.plan_id
      ORDER BY s.created_at DESC
      LIMIT 250
    `);

    const invoicesResult = await dbQuery(`
      SELECT
        id,
        customer_id AS "customerId",
        subscription_id AS "subscriptionId",
        invoice_number AS "invoiceNumber",
        status,
        currency,
        subtotal_cents AS "subtotalCents",
        tax_cents AS "taxCents",
        total_cents AS "totalCents",
        amount_paid_cents AS "amountPaidCents",
        amount_due_cents AS "amountDueCents",
        period_start AS "periodStart",
        period_end AS "periodEnd",
        due_at AS "dueAt",
        paid_at AS "paidAt",
        provider,
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM backend_invoices
      ORDER BY created_at DESC
      LIMIT 250
    `);

    const meterResult = await dbQuery(`
      SELECT
        id,
        metric_key AS "metricKey",
        meter_name AS "meterName",
        quantity,
        unit,
        billable,
        api_key_id AS "apiKeyId",
        customer_id AS "customerId",
        subscription_id AS "subscriptionId",
        usage_event_id AS "usageEventId",
        created_at AS "createdAt"
      FROM backend_meter_events
      ORDER BY created_at DESC
      LIMIT 300
    `);

    const plans = plansResult.rows;
    const customers = customersResult.rows;
    const subscriptions = subscriptionsResult.rows;
    const invoices = invoicesResult.rows;
    const meterEvents = meterResult.rows;

    return ok(res, {
      plans,
      customers,
      subscriptions,
      invoices,
      meterEvents,
      counts: {
        plans: plans.length,
        activePlans: plans.filter((item) => item.status === "active").length,
        customers: customers.length,
        subscriptions: subscriptions.length,
        activeSubscriptions: subscriptions.filter((item) => item.status === "active").length,
        invoices: invoices.length,
        meterEvents: meterEvents.length,
      },
    });
  } catch (error) {
    return fail(res, "Failed to load billing page data", 500, error.message);
  }
});

router.get("/usage-v2-page-data", async (req, res) => {
  try {
    const usageEventsResult = await dbQuery(`
      SELECT
        id,
        metric_key AS "metricKey",
        category,
        source,
        quantity,
        unit,
        api_key_id AS "apiKeyId",
        route,
        method,
        status_code AS "statusCode",
        organization_id AS "organizationId",
        project_id AS "projectId",
        environment_id AS "environmentId",
        created_at AS "createdAt"
      FROM backend_usage_events
      ORDER BY created_at DESC
      LIMIT 300
    `);

    const apiLogsResult = await dbQuery(`
      SELECT
        id,
        api_key_id AS "apiKeyId",
        api_key_prefix AS "apiKeyPrefix",
        metric_key AS "metricKey",
        route,
        method,
        status_code AS "statusCode",
        quantity,
        ip_address AS "ipAddress",
        created_at AS "createdAt"
      FROM backend_api_key_usage_logs
      ORDER BY created_at DESC
      LIMIT 300
    `);

    const dailyResult = await dbQuery(`
      SELECT
        id,
        usage_date AS "usageDate",
        metric_key AS "metricKey",
        category,
        quantity,
        unit,
        api_key_id AS "apiKeyId",
        organization_id AS "organizationId",
        updated_at AS "updatedAt"
      FROM backend_usage_daily
      ORDER BY usage_date DESC, metric_key ASC
      LIMIT 300
    `);

    const countersResult = await dbQuery(`
      SELECT
        id,
        metric_key AS "metricKey",
        scope_type AS "scopeType",
        scope_id AS "scopeId",
        period,
        period_start AS "periodStart",
        period_end AS "periodEnd",
        quantity,
        quota_limit AS "quotaLimit",
        status,
        updated_at AS "updatedAt"
      FROM backend_quota_counters
      ORDER BY updated_at DESC
      LIMIT 300
    `);

    return ok(res, {
      usageEvents: usageEventsResult.rows,
      apiKeyUsageLogs: apiLogsResult.rows,
      dailyUsage: dailyResult.rows,
      quotaCounters: countersResult.rows,
      counts: {
        usageEvents: usageEventsResult.rows.length,
        apiKeyUsageLogs: apiLogsResult.rows.length,
        dailyUsage: dailyResult.rows.length,
        quotaCounters: countersResult.rows.length,
        warnings: countersResult.rows.filter((item) => item.status === "warning").length,
        overLimit: countersResult.rows.filter((item) => item.status === "over_limit").length,
      },
    });
  } catch (error) {
    return fail(res, "Failed to load Usage V2 page data", 500, error.message);
  }
});

router.post("/billing/plans/:id/status-safe", async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    const status = String(req.body?.status || "active").trim().toLowerCase();

    if (!["active", "archived", "disabled"].includes(status)) {
      return fail(res, "Status must be active, archived, or disabled.", 400);
    }

    const result = await dbQuery(
      `
        UPDATE backend_billing_plans
        SET status = $2,
            updated_at = NOW()
        WHERE id = $1
        RETURNING id, name, display_name AS "displayName", status, updated_at AS "updatedAt"
      `,
      [id, status]
    );

    if (!result.rows[0]) return fail(res, "Billing plan not found", 404);

    return ok(res, {
      plan: result.rows[0],
      message: "Billing plan status updated.",
    });
  } catch (error) {
    return fail(res, "Failed to update billing plan", 500, error.message);
  }
});

router.get("/usage-page-data", async (req, res) => {
  try {
    const usageResult = await dbQuery(`
      SELECT
        (SELECT COUNT(*)::bigint FROM backend_api_key_usage_logs WHERE created_at >= date_trunc('month', NOW())) AS "api.calls.monthly",
        (SELECT COUNT(*)::bigint FROM backend_api_keys WHERE status = 'active') AS "api.keys.active",
        (SELECT COUNT(*)::bigint FROM backend_storage_buckets WHERE status = 'active') AS "storage.buckets",
        (SELECT COUNT(*)::bigint FROM backend_storage_files) AS "storage.files",
        COALESCE((SELECT SUM(size_bytes)::bigint FROM backend_storage_files), 0) AS "storage.bytes",
        (SELECT COUNT(*)::bigint FROM backend_webhooks WHERE status = 'active') AS "webhooks.active",
        (SELECT COUNT(*)::bigint FROM backend_webhook_deliveries WHERE created_at >= date_trunc('month', NOW())) AS "webhooks.deliveries.monthly",
        (SELECT COUNT(*)::bigint FROM backend_realtime_events WHERE created_at >= date_trunc('month', NOW())) AS "realtime.events.monthly",
        (SELECT COUNT(*)::bigint FROM backend_edge_functions) AS "functions.registered",
        (SELECT COUNT(*)::bigint FROM backend_backups) AS "backups.records",
        (SELECT COUNT(*)::bigint FROM sessions WHERE revoked_at IS NULL AND expires_at > NOW()) AS "sessions.active",
        (SELECT COUNT(*)::bigint FROM apps WHERE status = 'active') AS "apps.active"
    `);

    const quotaResult = await dbQuery(`
      SELECT
        id,
        metric_key AS "metricKey",
        label,
        category,
        quota_limit AS "quotaLimit",
        quota_unit AS "quotaUnit",
        warning_percent AS "warningPercent",
        is_enforced AS "isEnforced",
        description,
        status,
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM backend_usage_quotas
      WHERE status = 'active'
      ORDER BY category ASC, label ASC
    `);

    const rawUsage = usageResult.rows[0] || {};
    const quotas = quotaResult.rows;

    const usage = quotas.map((quota) => {
      const current = Number(rawUsage[quota.metricKey] || 0);
      const limit = Number(quota.quotaLimit || 0);
      const percent = limit > 0 ? Math.round((current / limit) * 100) : 0;

      let state = "ok";
      if (limit > 0 && current >= limit) state = "over_limit";
      else if (limit > 0 && percent >= Number(quota.warningPercent || 80)) state = "warning";

      return {
        ...quota,
        current,
        percent,
        state,
      };
    });

    return ok(res, {
      usage,
      rawUsage,
      counts: {
        metrics: usage.length,
        ok: usage.filter((item) => item.state === "ok").length,
        warning: usage.filter((item) => item.state === "warning").length,
        overLimit: usage.filter((item) => item.state === "over_limit").length,
        enforced: usage.filter((item) => item.isEnforced).length,
      },
    });
  } catch (error) {
    return fail(res, "Failed to load usage page data", 500, error.message);
  }
});

router.post("/usage-quotas/update-safe", async (req, res) => {
  try {
    const metricKey = String(req.body?.metricKey || "").trim();
    const quotaLimit = Number(req.body?.quotaLimit);

    if (!metricKey) return fail(res, "Metric key is required", 400);
    if (!Number.isFinite(quotaLimit) || quotaLimit < 0) {
      return fail(res, "Quota limit must be a valid positive number", 400);
    }

    const beforeResult = await dbQuery(
      `
        SELECT *
        FROM backend_usage_quotas
        WHERE metric_key = $1
      `,
      [metricKey]
    );

    const before = beforeResult.rows[0];
    if (!before) return fail(res, "Quota not found", 404);

    const result = await dbQuery(
      `
        UPDATE backend_usage_quotas
        SET
          quota_limit = $2,
          updated_at = NOW()
        WHERE metric_key = $1
        RETURNING
          id,
          metric_key AS "metricKey",
          label,
          category,
          quota_limit AS "quotaLimit",
          quota_unit AS "quotaUnit",
          warning_percent AS "warningPercent",
          is_enforced AS "isEnforced",
          description,
          status,
          created_at AS "createdAt",
          updated_at AS "updatedAt"
      `,
      [metricKey, quotaLimit]
    );

    await dbQuery(
      `
        INSERT INTO backend_admin_audit_logs (
          id,
          actor,
          action,
          target_type,
          target_id,
          before_json,
          after_json,
          ip_address,
          user_agent
        )
        VALUES ($1, $2, 'usage.quota.update', 'usage_quota', $3, $4::jsonb, $5::jsonb, $6, $7)
      `,
      [
        `audit_${crypto.randomUUID().replace(/-/g, "")}`,
        req.user?.email || req.session?.user?.email || req.auth?.user?.email || "console-user",
        metricKey,
        JSON.stringify(before),
        JSON.stringify({ quotaLimit }),
        req.headers["x-forwarded-for"] || req.socket?.remoteAddress || null,
        req.headers["user-agent"] || null,
      ]
    );

    return ok(res, {
      quota: result.rows[0],
      message: "Usage quota updated.",
    });
  } catch (error) {
    return fail(res, "Failed to update usage quota", 500, error.message);
  }
});


router.post("/backups/create-real-safe", async (req, res) => {
  try {
    const childProcess = require("child_process");
    const scriptPath = "/var/www/GoodBase/scripts/create-db-backup.sh";

    const output = childProcess.execFileSync("/usr/bin/sudo", ["-n", scriptPath], {
      encoding: "utf8",
      timeout: 120000,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const backupIdLine = output.split("\n").find((line) => line.startsWith("BACKUP_ID="));
    const backupId = backupIdLine ? backupIdLine.replace("BACKUP_ID=", "").trim() : null;

    let backup = null;

    if (backupId) {
      const backupResult = await dbQuery(
        `
          SELECT
            id,
            name,
            type,
            status,
            size_bytes AS "sizeBytes",
            file_path AS "filePath",
            backup_format AS "backupFormat",
            checksum_sha256 AS "checksumSha256",
            database_name AS "databaseName",
            notes,
            error_message AS "errorMessage",
            created_by AS "createdBy",
            completed_at AS "completedAt",
            created_at AS "createdAt"
          FROM backend_backups
          WHERE id = $1
        `,
        [backupId]
      );

      backup = backupResult.rows[0] || null;
    }

    return ok(res, {
      backup,
      output,
      message: "Real database backup created.",
    });
  } catch (error) {
    return fail(res, "Failed to create real database backup", 500, error.message);
  }
});

router.get("/backups/:id/download", async (req, res) => {
  try {
    const fs = require("fs");
    const path = require("path");

    const id = String(req.params.id || "").trim();

    const result = await dbQuery(
      `
        SELECT id, file_path, status
        FROM backend_backups
        WHERE id = $1
      `,
      [id]
    );

    const backup = result.rows[0];

    if (!backup) return fail(res, "Backup not found", 404);
    if (backup.status !== "completed") return fail(res, "Backup is not completed", 400);
    if (backup.deleted_at || backup.file_deleted) return fail(res, "Backup file was deleted", 410);
    if (!backup.file_path || !fs.existsSync(backup.file_path)) {
      return fail(res, "Backup file does not exist on disk", 404);
    }

    const safeName = path.basename(backup.file_path);

    return res.download(backup.file_path, safeName);
  } catch (error) {
    return fail(res, "Failed to download backup", 500, error.message);
  }
});

router.post("/backups/:id/verify-safe", async (req, res) => {
  try {
    const fs = require("fs");
    const childProcess = require("child_process");

    const id = String(req.params.id || "").trim();

    const result = await dbQuery(
      `
        SELECT
          id,
          file_path AS "filePath",
          checksum_sha256 AS "checksumSha256",
          status
        FROM backend_backups
        WHERE id = $1
      `,
      [id]
    );

    const backup = result.rows[0];

    if (!backup) return fail(res, "Backup not found", 404);
    if (!backup.filePath || !fs.existsSync(backup.filePath)) {
      return fail(res, "Backup file does not exist on disk", 404);
    }

    const output = childProcess.execFileSync("sha256sum", [backup.filePath], {
      encoding: "utf8",
      timeout: 30000,
    });

    const currentChecksum = output.split(/\s+/)[0];
    const matches = currentChecksum === backup.checksumSha256;

    return ok(res, {
      backupId: id,
      filePath: backup.filePath,
      expectedChecksum: backup.checksumSha256,
      currentChecksum,
      matches,
      message: matches ? "Backup checksum verified." : "Backup checksum mismatch.",
    });
  } catch (error) {
    return fail(res, "Failed to verify backup", 500, error.message);
  }
});


router.post("/backups/:id/restore-verify-safe", async (req, res) => {
  try {
    const childProcess = require("child_process");
    const id = String(req.params.id || "").trim();
    const scriptPath = "/var/www/GoodAppBackEnd/scripts/verify-db-restore.sh";

    if (!id) return fail(res, "Backup id is required", 400);

    const output = childProcess.execFileSync("/usr/bin/sudo", ["-n", scriptPath, id], {
      encoding: "utf8",
      timeout: 180000,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const testIdLine = output.split("\n").find((line) => line.startsWith("TEST_ID="));
    const testId = testIdLine ? testIdLine.replace("TEST_ID=", "").trim() : null;

    let restoreTest = null;

    if (testId) {
      const testResult = await dbQuery(
        `
          SELECT
            id,
            backup_id AS "backupId",
            test_database AS "testDatabase",
            status,
            table_count AS "tableCount",
            row_count AS "rowCount",
            error_message AS "errorMessage",
            started_at AS "startedAt",
            completed_at AS "completedAt",
            created_at AS "createdAt"
          FROM backend_backup_restore_tests
          WHERE id = $1
        `,
        [testId]
      );

      restoreTest = testResult.rows[0] || null;
    }

    return ok(res, {
      restoreTest,
      output,
      message: "Backup restore verification completed safely.",
    });
  } catch (error) {
    return fail(res, "Failed to verify backup restore", 500, error.message);
  }
});


router.post("/backups/:id/delete-safe", async (req, res) => {
  try {
    const childProcess = require("child_process");

    const id = String(req.params.id || "").trim();
    const reason = String(req.body?.reason || "Manual delete from GoodAppBackEnd console.").trim();

    if (!id) return fail(res, "Backup id is required", 400);

    const beforeResult = await dbQuery(
      `
        SELECT *
        FROM backend_backups
        WHERE id = $1
      `,
      [id]
    );

    const before = beforeResult.rows[0];

    if (!before) return fail(res, "Backup not found", 404);

    let fileDeleted = false;

    const deleteOutput = childProcess.execFileSync("/usr/bin/sudo", ["-n", "/var/www/GoodAppBackEnd/scripts/delete-db-backup.sh", id], {
      encoding: "utf8",
      timeout: 30000,
      stdio: ["ignore", "pipe", "pipe"],
    });

    fileDeleted = deleteOutput.split("\n").some((line) => line.trim() === "FILE_DELETED=true");

    const result = await dbQuery(
      `
        UPDATE backend_backups
        SET
          status = CASE WHEN status = 'completed' THEN 'deleted' ELSE status END,
          deleted_at = NOW(),
          deleted_by = $2,
          deleted_reason = $3,
          file_deleted = true
        WHERE id = $1
        RETURNING
          id,
          name,
          type,
          status,
          size_bytes AS "sizeBytes",
          file_path AS "filePath",
          backup_format AS "backupFormat",
          checksum_sha256 AS "checksumSha256",
          database_name AS "databaseName",
          notes,
          error_message AS "errorMessage",
          created_by AS "createdBy",
          completed_at AS "completedAt",
          deleted_at AS "deletedAt",
          deleted_by AS "deletedBy",
          deleted_reason AS "deletedReason",
          file_deleted AS "fileDeleted",
          created_at AS "createdAt"
      `,
      [
        id,
        req.user?.email || req.session?.user?.email || req.auth?.user?.email || "console-user",
        reason,
      ]
    );

    await dbQuery(
      `
        INSERT INTO backend_admin_audit_logs (
          id,
          actor,
          action,
          target_type,
          target_id,
          before_json,
          after_json,
          ip_address,
          user_agent
        )
        VALUES ($1, $2, 'backup.delete', 'backup', $3, $4::jsonb, $5::jsonb, $6, $7)
      `,
      [
        `audit_${crypto.randomUUID().replace(/-/g, "")}`,
        req.user?.email || req.session?.user?.email || req.auth?.user?.email || "console-user",
        id,
        JSON.stringify(before),
        JSON.stringify({ fileDeleted, reason }),
        req.headers["x-forwarded-for"] || req.socket?.remoteAddress || null,
        req.headers["user-agent"] || null,
      ]
    );

    return ok(res, {
      backup: result.rows[0],
      fileDeleted,
      message: fileDeleted ? "Backup file deleted and record marked." : "Backup record marked; no file was found on disk.",
    });
  } catch (error) {
    return fail(res, "Failed to delete backup safely", 500, error.message);
  }
});

router.post("/backups/retention-cleanup-safe", async (req, res) => {
  try {
    const childProcess = require("child_process");
    const output = childProcess.execFileSync("/usr/bin/sudo", ["-n", "/var/www/GoodAppBackEnd/scripts/cleanup-db-backups.sh"], {
      encoding: "utf8",
      timeout: 120000,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const values = Object.fromEntries(
      output
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const index = line.indexOf("=");
          return index === -1 ? [line, ""] : [line.slice(0, index), line.slice(index + 1)];
        })
    );

    await dbQuery(
      `
        INSERT INTO backend_admin_audit_logs (
          id,
          actor,
          action,
          target_type,
          target_id,
          after_json,
          ip_address,
          user_agent
        )
        VALUES ($1, $2, 'backup.retention_cleanup', 'backup_retention', 'retention', $3::jsonb, $4, $5)
      `,
      [
        `audit_${crypto.randomUUID().replace(/-/g, "")}`,
        req.user?.email || req.session?.user?.email || req.auth?.user?.email || "console-user",
        JSON.stringify(values),
        req.headers["x-forwarded-for"] || req.socket?.remoteAddress || null,
        req.headers["user-agent"] || null,
      ]
    );

    return ok(res, {
      retentionDays: Number(values.RETENTION_DAYS || 0),
      checked: Number(values.CHECKED || 0),
      deleted: Number(values.DELETED || 0),
      errors: Number(values.ERRORS || 0),
      output,
      message: "Retention cleanup completed.",
    });
  } catch (error) {
    return fail(res, "Failed to run backup retention cleanup", 500, error.message);
  }
});


function quoteDbIdentifierSafe(value) {
  return '"' + String(value).replace(/"/g, '""') + '"';
}

async function assertPublicTableExists(tableName) {
  const result = await dbQuery(
    `
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_type = 'BASE TABLE'
        AND table_name = $1
      LIMIT 1
    `,
    [tableName]
  );

  return Boolean(result.rows[0]);
}

router.get("/database/tables/:tableName/rows", async (req, res) => {
  try {
    const tableName = String(req.params.tableName || "").trim();

    if (!tableName) return fail(res, "Table name is required", 400);

    const exists = await assertPublicTableExists(tableName);
    if (!exists) return fail(res, "Table not found or not allowed", 404);

    const limit = Math.min(Math.max(Number(req.query.limit || 25), 1), 100);
    const offset = Math.max(Number(req.query.offset || 0), 0);
    const search = String(req.query.search || "").trim();

    const columnsResult = await dbQuery(
      `
        SELECT
          column_name AS "columnName",
          data_type AS "dataType",
          ordinal_position AS "position"
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = $1
        ORDER BY ordinal_position ASC
      `,
      [tableName]
    );

    const columns = columnsResult.rows;
    const quotedTable = quoteDbIdentifierSafe(tableName);

    let whereSql = "";
    let countParams = [];
    let rowsParams = [limit, offset];

    if (search) {
      const searchableColumns = columns.map((column) => {
        return `COALESCE(${quoteDbIdentifierSafe(column.columnName)}::text, '')`;
      });

      if (searchableColumns.length) {
        whereSql = `WHERE (${searchableColumns.join(" || ' ' || ")}) ILIKE $1`;
        countParams = [`%${search}%`];
        rowsParams = [`%${search}%`, limit, offset];
      }
    }

    const countSql = `
      SELECT COUNT(*)::int AS count
      FROM ${quotedTable}
      ${whereSql}
    `;

    const rowsSql = `
      SELECT ctid::text AS "__ctid", *
      FROM ${quotedTable}
      ${whereSql}
      LIMIT $${search ? 2 : 1}
      OFFSET $${search ? 3 : 2}
    `;

    const countResult = await dbQuery(countSql, countParams);
    const rowsResult = await dbQuery(rowsSql, rowsParams);

    return ok(res, {
      tableName,
      columns,
      rows: rowsResult.rows,
      pagination: {
        limit,
        offset,
        total: Number(countResult.rows[0]?.count || 0),
        nextOffset: offset + rowsResult.rows.length,
        hasMore: offset + rowsResult.rows.length < Number(countResult.rows[0]?.count || 0),
      },
      search,
    });
  } catch (error) {
    return fail(res, "Failed to load table rows", 500, error.message);
  }
});


function csvEscape(value) {
  if (value === null || value === undefined) return "";
  let output = typeof value === "object" ? JSON.stringify(value) : String(value);
  output = output.replace(/"/g, '""');
  return `"${output}"`;
}

router.get("/database/tables/:tableName/export", async (req, res) => {
  try {
    const tableName = String(req.params.tableName || "").trim();

    if (!tableName) return fail(res, "Table name is required", 400);

    const exists = await assertPublicTableExists(tableName);
    if (!exists) return fail(res, "Table not found or not allowed", 404);

    const format = String(req.query.format || "csv").toLowerCase();
    const limit = Math.min(Math.max(Number(req.query.limit || 5000), 1), 5000);
    const search = String(req.query.search || "").trim();

    const columnsResult = await dbQuery(
      `
        SELECT
          column_name AS "columnName",
          data_type AS "dataType",
          ordinal_position AS "position"
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = $1
        ORDER BY ordinal_position ASC
      `,
      [tableName]
    );

    const columns = columnsResult.rows;
    const quotedTable = quoteDbIdentifierSafe(tableName);

    let whereSql = "";
    let rowsParams = [limit];

    if (search) {
      const searchableColumns = columns.map((column) => {
        return `COALESCE(${quoteDbIdentifierSafe(column.columnName)}::text, '')`;
      });

      if (searchableColumns.length) {
        whereSql = `WHERE (${searchableColumns.join(" || ' ' || ")}) ILIKE $1`;
        rowsParams = [`%${search}%`, limit];
      }
    }

    const rowsSql = `
      SELECT ctid::text AS "__ctid", *
      FROM ${quotedTable}
      ${whereSql}
      LIMIT $${search ? 2 : 1}
    `;

    const rowsResult = await dbQuery(rowsSql, rowsParams);
    const rows = rowsResult.rows;

    const safeFileTableName = tableName.replace(/[^a-zA-Z0-9_-]/g, "_");
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");

    if (format === "json") {
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${safeFileTableName}_${timestamp}.json"`);
      return res.send(JSON.stringify({
        tableName,
        exportedAt: new Date().toISOString(),
        search,
        limit,
        rowCount: rows.length,
        columns,
        rows,
      }, null, 2));
    }

    if (format !== "csv") {
      return fail(res, "Unsupported export format. Use csv or json.", 400);
    }

    const header = columns.map((column) => csvEscape(column.columnName)).join(",");
    const body = rows.map((row) => {
      return columns.map((column) => csvEscape(row[column.columnName])).join(",");
    }).join("\n");

    const csv = `${header}\n${body}\n`;

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${safeFileTableName}_${timestamp}.csv"`);
    return res.send(csv);
  } catch (error) {
    return fail(res, "Failed to export table rows", 500, error.message);
  }
});


const DATABASE_BROWSER_READ_ONLY_TABLES = new Set([
  "backend_admin_audit_logs"
]);

async function getPublicTableColumns(tableName) {
  const result = await dbQuery(
    `
      SELECT
        column_name AS "columnName",
        data_type AS "dataType",
        is_nullable AS "isNullable",
        column_default AS "columnDefault",
        is_identity AS "isIdentity",
        is_generated AS "isGenerated"
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = $1
      ORDER BY ordinal_position ASC
    `,
    [tableName]
  );

  return result.rows;
}

function ensureTableWritable(tableName) {
  if (DATABASE_BROWSER_READ_ONLY_TABLES.has(tableName)) {
    const error = new Error("This table is read-only from the Database Browser.");
    error.statusCode = 403;
    throw error;
  }
}

function normalizeDbBrowserValue(value, column) {
  if (value === undefined) return null;
  if (value === "") return null;

  if (column && ["json", "jsonb"].includes(column.dataType)) {
    if (typeof value === "string") {
      try {
        JSON.parse(value);
        return value;
      } catch (error) {
        return JSON.stringify(value);
      }
    }
    return JSON.stringify(value);
  }

  return value;
}

function valueExpressionForColumn(paramIndex, column) {
  if (column && column.dataType === "jsonb") return `$${paramIndex}::jsonb`;
  if (column && column.dataType === "json") return `$${paramIndex}::json`;
  return `$${paramIndex}`;
}

router.post("/database/tables/:tableName/rows/create-safe", async (req, res) => {
  try {
    const tableName = String(req.params.tableName || "").trim();

    if (!tableName) return fail(res, "Table name is required", 400);

    const exists = await assertPublicTableExists(tableName);
    if (!exists) return fail(res, "Table not found or not allowed", 404);

    ensureTableWritable(tableName);

    const input = req.body?.row && typeof req.body.row === "object" ? req.body.row : {};
    const columns = await getPublicTableColumns(tableName);
    const writableColumns = columns.filter((column) => {
      return column.isGenerated !== "ALWAYS" && column.isIdentity !== "YES";
    });

    const columnMap = new Map(writableColumns.map((column) => [column.columnName, column]));
    const entries = Object.entries(input).filter(([key]) => columnMap.has(key));

    if (!entries.length) return fail(res, "No valid writable columns provided", 400);

    const quotedTable = quoteDbIdentifierSafe(tableName);
    const quotedColumns = entries.map(([key]) => quoteDbIdentifierSafe(key));
    const params = [];
    const valueExpressions = [];

    entries.forEach(([key, value], index) => {
      const column = columnMap.get(key);
      params.push(normalizeDbBrowserValue(value, column));
      valueExpressions.push(valueExpressionForColumn(index + 1, column));
    });

    const sql = `
      INSERT INTO ${quotedTable} (${quotedColumns.join(", ")})
      VALUES (${valueExpressions.join(", ")})
      RETURNING ctid::text AS "__ctid", *
    `;

    const result = await dbQuery(sql, params);

    await dbQuery(
      `
        INSERT INTO backend_admin_audit_logs (
          id,
          actor,
          action,
          target_type,
          target_id,
          after_json,
          ip_address,
          user_agent
        )
        VALUES ($1, $2, 'database.row.create', 'database_row', $3, $4::jsonb, $5, $6)
      `,
      [
        `audit_${crypto.randomUUID().replace(/-/g, "")}`,
        req.user?.email || req.session?.user?.email || req.auth?.user?.email || "console-user",
        tableName,
        JSON.stringify({ row: result.rows[0] }),
        req.headers["x-forwarded-for"] || req.socket?.remoteAddress || null,
        req.headers["user-agent"] || null,
      ]
    );

    return ok(res, {
      row: result.rows[0],
      message: "Row created.",
    });
  } catch (error) {
    return fail(res, "Failed to create row", error.statusCode || 500, error.message);
  }
});

router.post("/database/tables/:tableName/rows/update-safe", async (req, res) => {
  try {
    const tableName = String(req.params.tableName || "").trim();
    const rowCtid = String(req.body?.ctid || "").trim();
    const columnName = String(req.body?.columnName || "").trim();
    const value = req.body?.value;

    if (!tableName) return fail(res, "Table name is required", 400);
    if (!rowCtid) return fail(res, "Row ctid is required", 400);
    if (!columnName) return fail(res, "Column name is required", 400);

    const exists = await assertPublicTableExists(tableName);
    if (!exists) return fail(res, "Table not found or not allowed", 404);

    ensureTableWritable(tableName);

    const columns = await getPublicTableColumns(tableName);
    const column = columns.find((item) => item.columnName === columnName);

    if (!column) return fail(res, "Column not found", 404);
    if (column.isGenerated === "ALWAYS" || column.isIdentity === "YES") {
      return fail(res, "This column cannot be edited", 400);
    }

    const quotedTable = quoteDbIdentifierSafe(tableName);
    const quotedColumn = quoteDbIdentifierSafe(columnName);

    const beforeResult = await dbQuery(
      `
        SELECT ctid::text AS "__ctid", *
        FROM ${quotedTable}
        WHERE ctid = $1::tid
        LIMIT 1
      `,
      [rowCtid]
    );

    const before = beforeResult.rows[0];
    if (!before) return fail(res, "Row not found", 404);

    const normalizedValue = normalizeDbBrowserValue(value, column);
    const expression = valueExpressionForColumn(1, column);

    const result = await dbQuery(
      `
        UPDATE ${quotedTable}
        SET ${quotedColumn} = ${expression}
        WHERE ctid = $2::tid
        RETURNING ctid::text AS "__ctid", *
      `,
      [normalizedValue, rowCtid]
    );

    await dbQuery(
      `
        INSERT INTO backend_admin_audit_logs (
          id,
          actor,
          action,
          target_type,
          target_id,
          before_json,
          after_json,
          ip_address,
          user_agent
        )
        VALUES ($1, $2, 'database.row.update', 'database_row', $3, $4::jsonb, $5::jsonb, $6, $7)
      `,
      [
        `audit_${crypto.randomUUID().replace(/-/g, "")}`,
        req.user?.email || req.session?.user?.email || req.auth?.user?.email || "console-user",
        `${tableName}:${rowCtid}:${columnName}`,
        JSON.stringify({ row: before }),
        JSON.stringify({ row: result.rows[0], changedColumn: columnName }),
        req.headers["x-forwarded-for"] || req.socket?.remoteAddress || null,
        req.headers["user-agent"] || null,
      ]
    );

    return ok(res, {
      row: result.rows[0],
      message: "Row updated.",
    });
  } catch (error) {
    return fail(res, "Failed to update row", error.statusCode || 500, error.message);
  }
});

router.post("/database/tables/:tableName/rows/delete-safe", async (req, res) => {
  try {
    const tableName = String(req.params.tableName || "").trim();
    const rowCtid = String(req.body?.ctid || "").trim();

    if (!tableName) return fail(res, "Table name is required", 400);
    if (!rowCtid) return fail(res, "Row ctid is required", 400);

    const exists = await assertPublicTableExists(tableName);
    if (!exists) return fail(res, "Table not found or not allowed", 404);

    ensureTableWritable(tableName);

    const quotedTable = quoteDbIdentifierSafe(tableName);

    const result = await dbQuery(
      `
        DELETE FROM ${quotedTable}
        WHERE ctid = $1::tid
        RETURNING ctid::text AS "__ctid", *
      `,
      [rowCtid]
    );

    const deleted = result.rows[0];
    if (!deleted) return fail(res, "Row not found", 404);

    await dbQuery(
      `
        INSERT INTO backend_admin_audit_logs (
          id,
          actor,
          action,
          target_type,
          target_id,
          before_json,
          ip_address,
          user_agent
        )
        VALUES ($1, $2, 'database.row.delete', 'database_row', $3, $4::jsonb, $5, $6)
      `,
      [
        `audit_${crypto.randomUUID().replace(/-/g, "")}`,
        req.user?.email || req.session?.user?.email || req.auth?.user?.email || "console-user",
        `${tableName}:${rowCtid}`,
        JSON.stringify({ row: deleted }),
        req.headers["x-forwarded-for"] || req.socket?.remoteAddress || null,
        req.headers["user-agent"] || null,
      ]
    );

    return ok(res, {
      row: deleted,
      message: "Row deleted.",
    });
  } catch (error) {
    return fail(res, "Failed to delete row", error.statusCode || 500, error.message);
  }
});


function validateReadOnlySqlQuery(sqlText) {
  const raw = String(sqlText || "").trim();

  if (!raw) {
    return { ok: false, message: "SQL query is required." };
  }

  const normalized = raw.replace(/\s+/g, " ").trim();
  const withoutTrailingSemicolon = normalized.replace(/;+\s*$/, "");

  if (withoutTrailingSemicolon.includes(";")) {
    return { ok: false, message: "Only one SQL statement is allowed." };
  }

  if (!/^(select|with)\s/i.test(withoutTrailingSemicolon)) {
    return { ok: false, message: "Only SELECT or read-only WITH queries are allowed." };
  }

  const blockedPatterns = [
    /\binsert\b/i,
    /\bupdate\b/i,
    /\bdelete\b/i,
    /\bdrop\b/i,
    /\balter\b/i,
    /\btruncate\b/i,
    /\bcreate\b/i,
    /\bgrant\b/i,
    /\brevoke\b/i,
    /\bcopy\b/i,
    /\bcall\b/i,
    /\bdo\s+\$\$/i,
    /\bexecute\b/i,
    /\bvacuum\b/i,
    /\banalyze\b/i,
    /\breindex\b/i,
    /\bcluster\b/i,
    /\brefresh\s+materialized\b/i,
    /\bpg_sleep\b/i,
    /\bpg_read_file\b/i,
    /\bpg_ls_dir\b/i,
    /\bpg_stat_file\b/i,
    /\bdblink\b/i,
    /\blo_import\b/i,
    /\blo_export\b/i
  ];

  for (const pattern of blockedPatterns) {
    if (pattern.test(withoutTrailingSemicolon)) {
      return { ok: false, message: "This query contains a blocked keyword or function." };
    }
  }

  return {
    ok: true,
    sql: withoutTrailingSemicolon,
  };
}

router.get("/database/saved-queries-page-data", async (req, res) => {
  try {
    const savedResult = await dbQuery(`
      SELECT
        id,
        name,
        sql_text AS "sqlText",
        description,
        status,
        created_by AS "createdBy",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM backend_saved_queries
      WHERE status = 'active'
      ORDER BY updated_at DESC
      LIMIT 250
    `);

    const executionsResult = await dbQuery(`
      SELECT
        id,
        saved_query_id AS "savedQueryId",
        sql_text AS "sqlText",
        status,
        row_count AS "rowCount",
        duration_ms AS "durationMs",
        error_message AS "errorMessage",
        executed_by AS "executedBy",
        created_at AS "createdAt"
      FROM backend_query_executions
      ORDER BY created_at DESC
      LIMIT 100
    `);

    return ok(res, {
      savedQueries: savedResult.rows,
      executions: executionsResult.rows,
    });
  } catch (error) {
    return fail(res, "Failed to load saved queries", 500, error.message);
  }
});

router.post("/database/query/run-safe", async (req, res) => {
  const started = Date.now();
  let executionId = `query_exec_${crypto.randomUUID().replace(/-/g, "")}`;
  let sqlText = String(req.body?.sqlText || "").trim();
  let savedQueryId = req.body?.savedQueryId ? String(req.body.savedQueryId).trim() : null;

  try {
    const validation = validateReadOnlySqlQuery(sqlText);

    if (!validation.ok) {
      await dbQuery(
        `
          INSERT INTO backend_query_executions (
            id,
            saved_query_id,
            sql_text,
            status,
            row_count,
            duration_ms,
            error_message,
            executed_by
          )
          VALUES ($1, $2, $3, 'blocked', 0, $4, $5, $6)
        `,
        [
          executionId,
          savedQueryId,
          sqlText,
          Date.now() - started,
          validation.message,
          req.user?.email || req.session?.user?.email || req.auth?.user?.email || "console-user",
        ]
      );

      return fail(res, validation.message, 400);
    }

    const limit = Math.min(Math.max(Number(req.body?.limit || 250), 1), 500);
    const wrappedSql = `SELECT * FROM (${validation.sql}) AS goodos_query_result LIMIT $1`;

    const result = await dbQuery(wrappedSql, [limit]);
    const durationMs = Date.now() - started;

    const columns = result.fields.map((field) => ({
      name: field.name,
    }));

    await dbQuery(
      `
        INSERT INTO backend_query_executions (
          id,
          saved_query_id,
          sql_text,
          status,
          row_count,
          duration_ms,
          executed_by
        )
        VALUES ($1, $2, $3, 'completed', $4, $5, $6)
      `,
      [
        executionId,
        savedQueryId,
        validation.sql,
        result.rows.length,
        durationMs,
        req.user?.email || req.session?.user?.email || req.auth?.user?.email || "console-user",
      ]
    );

    await dbQuery(
      `
        INSERT INTO backend_admin_audit_logs (
          id,
          actor,
          action,
          target_type,
          target_id,
          after_json,
          ip_address,
          user_agent
        )
        VALUES ($1, $2, 'database.query.run', 'database_query', $3, $4::jsonb, $5, $6)
      `,
      [
        `audit_${crypto.randomUUID().replace(/-/g, "")}`,
        req.user?.email || req.session?.user?.email || req.auth?.user?.email || "console-user",
        executionId,
        JSON.stringify({ rowCount: result.rows.length, durationMs, savedQueryId }),
        req.headers["x-forwarded-for"] || req.socket?.remoteAddress || null,
        req.headers["user-agent"] || null,
      ]
    );

    return ok(res, {
      executionId,
      columns,
      rows: result.rows,
      rowCount: result.rows.length,
      durationMs,
      limit,
      sqlText: validation.sql,
    });
  } catch (error) {
    const durationMs = Date.now() - started;

    try {
      await dbQuery(
        `
          INSERT INTO backend_query_executions (
            id,
            saved_query_id,
            sql_text,
            status,
            row_count,
            duration_ms,
            error_message,
            executed_by
          )
          VALUES ($1, $2, $3, 'failed', 0, $4, $5, $6)
        `,
        [
          executionId,
          savedQueryId,
          sqlText,
          durationMs,
          error.message,
          req.user?.email || req.session?.user?.email || req.auth?.user?.email || "console-user",
        ]
      );
    } catch (auditError) {}

    return fail(res, "Failed to run query", 500, error.message);
  }
});

router.post("/database/query/save-safe", async (req, res) => {
  try {
    const name = String(req.body?.name || "").trim();
    const sqlText = String(req.body?.sqlText || "").trim();
    const description = String(req.body?.description || "").trim();

    if (!name) return fail(res, "Query name is required", 400);

    const validation = validateReadOnlySqlQuery(sqlText);
    if (!validation.ok) return fail(res, validation.message, 400);

    const id = `saved_query_${crypto.randomUUID().replace(/-/g, "")}`;

    const result = await dbQuery(
      `
        INSERT INTO backend_saved_queries (
          id,
          name,
          sql_text,
          description,
          status,
          created_by
        )
        VALUES ($1, $2, $3, $4, 'active', $5)
        RETURNING
          id,
          name,
          sql_text AS "sqlText",
          description,
          status,
          created_by AS "createdBy",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
      `,
      [
        id,
        name,
        validation.sql,
        description,
        req.user?.email || req.session?.user?.email || req.auth?.user?.email || "console-user",
      ]
    );

    await dbQuery(
      `
        INSERT INTO backend_admin_audit_logs (
          id,
          actor,
          action,
          target_type,
          target_id,
          after_json,
          ip_address,
          user_agent
        )
        VALUES ($1, $2, 'database.query.save', 'saved_query', $3, $4::jsonb, $5, $6)
      `,
      [
        `audit_${crypto.randomUUID().replace(/-/g, "")}`,
        req.user?.email || req.session?.user?.email || req.auth?.user?.email || "console-user",
        id,
        JSON.stringify({ name, sqlText: validation.sql }),
        req.headers["x-forwarded-for"] || req.socket?.remoteAddress || null,
        req.headers["user-agent"] || null,
      ]
    );

    return ok(res, {
      savedQuery: result.rows[0],
      message: "Query saved.",
    });
  } catch (error) {
    return fail(res, "Failed to save query", 500, error.message);
  }
});

router.post("/database/saved-queries/:id/delete-safe", async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();

    if (!id) return fail(res, "Saved query id is required", 400);

    const result = await dbQuery(
      `
        UPDATE backend_saved_queries
        SET
          status = 'deleted',
          updated_at = NOW()
        WHERE id = $1
        RETURNING
          id,
          name,
          sql_text AS "sqlText",
          status,
          updated_at AS "updatedAt"
      `,
      [id]
    );

    if (!result.rows[0]) return fail(res, "Saved query not found", 404);

    await dbQuery(
      `
        INSERT INTO backend_admin_audit_logs (
          id,
          actor,
          action,
          target_type,
          target_id,
          after_json,
          ip_address,
          user_agent
        )
        VALUES ($1, $2, 'database.query.delete', 'saved_query', $3, $4::jsonb, $5, $6)
      `,
      [
        `audit_${crypto.randomUUID().replace(/-/g, "")}`,
        req.user?.email || req.session?.user?.email || req.auth?.user?.email || "console-user",
        id,
        JSON.stringify(result.rows[0]),
        req.headers["x-forwarded-for"] || req.socket?.remoteAddress || null,
        req.headers["user-agent"] || null,
      ]
    );

    return ok(res, {
      savedQuery: result.rows[0],
      message: "Saved query deleted.",
    });
  } catch (error) {
    return fail(res, "Failed to delete saved query", 500, error.message);
  }
});


const DATABASE_BROWSER_ALLOWED_TYPES = new Set([
  "text",
  "integer",
  "bigint",
  "numeric",
  "boolean",
  "timestamptz",
  "timestamp",
  "date",
  "jsonb",
  "uuid"
]);

function isSafeDbIdentifier(value) {
  return /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(String(value || ""));
}

function validateSchemaColumn(column) {
  const name = String(column?.name || "").trim();
  const type = String(column?.type || "text").trim().toLowerCase();
  const nullable = column?.nullable !== false;
  const unique = column?.unique === true;
  const primaryKey = column?.primaryKey === true;
  const defaultValue = column?.defaultValue;

  if (!isSafeDbIdentifier(name)) {
    return { ok: false, message: `Invalid column name: ${name}` };
  }

  if (!DATABASE_BROWSER_ALLOWED_TYPES.has(type)) {
    return { ok: false, message: `Unsupported column type: ${type}` };
  }

  let definition = `${quoteDbIdentifierSafe(name)} ${type}`;

  if (primaryKey) definition += " PRIMARY KEY";
  if (!nullable || primaryKey) definition += " NOT NULL";
  if (unique && !primaryKey) definition += " UNIQUE";

  if (defaultValue !== undefined && defaultValue !== null && String(defaultValue).trim() !== "") {
    const defaultText = String(defaultValue).trim();

    const allowedDefaults = [
      "now()",
      "gen_random_uuid()",
      "true",
      "false",
      "0",
      "1",
      "CURRENT_TIMESTAMP"
    ];

    if (!allowedDefaults.includes(defaultText) && !/^'.*'$/.test(defaultText) && !/^[0-9]+(\.[0-9]+)?$/.test(defaultText)) {
      return { ok: false, message: `Unsafe default value for ${name}. Use quoted text, number, now(), gen_random_uuid(), true, or false.` };
    }

    definition += ` DEFAULT ${defaultText}`;
  }

  return {
    ok: true,
    name,
    type,
    definition,
  };
}

router.post("/database/schema/create-table-safe", async (req, res) => {
  try {
    const tableName = String(req.body?.tableName || "").trim();
    const columnsInput = Array.isArray(req.body?.columns) ? req.body.columns : [];

    if (!isSafeDbIdentifier(tableName)) {
      return fail(res, "Invalid table name. Use letters, numbers, and underscores only. Must start with a letter or underscore.", 400);
    }

    if (!columnsInput.length) {
      return fail(res, "At least one column is required.", 400);
    }

    const exists = await assertPublicTableExists(tableName);
    if (exists) return fail(res, "Table already exists.", 409);

    const validatedColumns = [];

    for (const column of columnsInput) {
      const validated = validateSchemaColumn(column);
      if (!validated.ok) return fail(res, validated.message, 400);
      validatedColumns.push(validated);
    }

    const hasPrimaryKey = validatedColumns.some((column) => / PRIMARY KEY/.test(column.definition));

    const finalDefinitions = hasPrimaryKey
      ? validatedColumns.map((column) => column.definition)
      : [`"id" uuid PRIMARY KEY DEFAULT gen_random_uuid()`, ...validatedColumns.map((column) => column.definition)];

    const sql = `
      CREATE TABLE ${quoteDbIdentifierSafe(tableName)} (
        ${finalDefinitions.join(",\n        ")}
      )
    `;

    await dbQuery(sql);

    await dbQuery(
      `
        INSERT INTO backend_admin_audit_logs (
          id,
          actor,
          action,
          target_type,
          target_id,
          after_json,
          ip_address,
          user_agent
        )
        VALUES ($1, $2, 'database.schema.create_table', 'database_table', $3, $4::jsonb, $5, $6)
      `,
      [
        `audit_${crypto.randomUUID().replace(/-/g, "")}`,
        req.user?.email || req.session?.user?.email || req.auth?.user?.email || "console-user",
        tableName,
        JSON.stringify({ tableName, columns: columnsInput }),
        req.headers["x-forwarded-for"] || req.socket?.remoteAddress || null,
        req.headers["user-agent"] || null,
      ]
    );

    return ok(res, {
      tableName,
      message: "Table created.",
    });
  } catch (error) {
    return fail(res, "Failed to create table", 500, error.message);
  }
});

router.post("/database/schema/add-column-safe", async (req, res) => {
  try {
    const tableName = String(req.body?.tableName || "").trim();
    const column = req.body?.column || {};

    if (!isSafeDbIdentifier(tableName)) {
      return fail(res, "Invalid table name.", 400);
    }

    const exists = await assertPublicTableExists(tableName);
    if (!exists) return fail(res, "Table not found.", 404);

    ensureTableWritable(tableName);

    const validated = validateSchemaColumn(column);
    if (!validated.ok) return fail(res, validated.message, 400);

    const columns = await getPublicTableColumns(tableName);
    if (columns.some((item) => item.columnName === validated.name)) {
      return fail(res, "Column already exists.", 409);
    }

    const sql = `
      ALTER TABLE ${quoteDbIdentifierSafe(tableName)}
      ADD COLUMN ${validated.definition}
    `;

    await dbQuery(sql);

    await dbQuery(
      `
        INSERT INTO backend_admin_audit_logs (
          id,
          actor,
          action,
          target_type,
          target_id,
          after_json,
          ip_address,
          user_agent
        )
        VALUES ($1, $2, 'database.schema.add_column', 'database_column', $3, $4::jsonb, $5, $6)
      `,
      [
        `audit_${crypto.randomUUID().replace(/-/g, "")}`,
        req.user?.email || req.session?.user?.email || req.auth?.user?.email || "console-user",
        `${tableName}.${validated.name}`,
        JSON.stringify({ tableName, column }),
        req.headers["x-forwarded-for"] || req.socket?.remoteAddress || null,
        req.headers["user-agent"] || null,
      ]
    );

    return ok(res, {
      tableName,
      columnName: validated.name,
      message: "Column added.",
    });
  } catch (error) {
    return fail(res, "Failed to add column", error.statusCode || 500, error.message);
  }
});

router.post("/database/schema/create-index-safe", async (req, res) => {
  try {
    const tableName = String(req.body?.tableName || "").trim();
    const columnName = String(req.body?.columnName || "").trim();
    const unique = req.body?.unique === true;

    if (!isSafeDbIdentifier(tableName)) return fail(res, "Invalid table name.", 400);
    if (!isSafeDbIdentifier(columnName)) return fail(res, "Invalid column name.", 400);

    const exists = await assertPublicTableExists(tableName);
    if (!exists) return fail(res, "Table not found.", 404);

    ensureTableWritable(tableName);

    const columns = await getPublicTableColumns(tableName);
    if (!columns.some((item) => item.columnName === columnName)) {
      return fail(res, "Column not found.", 404);
    }

    const indexName = `${tableName}_${columnName}_${unique ? "uniq" : "idx"}`.slice(0, 60);

    const sql = `
      CREATE ${unique ? "UNIQUE " : ""}INDEX IF NOT EXISTS ${quoteDbIdentifierSafe(indexName)}
      ON ${quoteDbIdentifierSafe(tableName)} (${quoteDbIdentifierSafe(columnName)})
    `;

    await dbQuery(sql);

    await dbQuery(
      `
        INSERT INTO backend_admin_audit_logs (
          id,
          actor,
          action,
          target_type,
          target_id,
          after_json,
          ip_address,
          user_agent
        )
        VALUES ($1, $2, 'database.schema.create_index', 'database_index', $3, $4::jsonb, $5, $6)
      `,
      [
        `audit_${crypto.randomUUID().replace(/-/g, "")}`,
        req.user?.email || req.session?.user?.email || req.auth?.user?.email || "console-user",
        indexName,
        JSON.stringify({ tableName, columnName, unique, indexName }),
        req.headers["x-forwarded-for"] || req.socket?.remoteAddress || null,
        req.headers["user-agent"] || null,
      ]
    );

    return ok(res, {
      tableName,
      columnName,
      indexName,
      unique,
      message: "Index created.",
    });
  } catch (error) {
    return fail(res, "Failed to create index", error.statusCode || 500, error.message);
  }
});


router.get("/database/tables/:tableName/metadata", async (req, res) => {
  try {
    const tableName = String(req.params.tableName || "").trim();

    if (!tableName) return fail(res, "Table name is required", 400);

    const exists = await assertPublicTableExists(tableName);
    if (!exists) return fail(res, "Table not found or not allowed", 404);

    const qualifiedName = `public.${tableName}`;

    const columnsResult = await dbQuery(
      `
        SELECT
          column_name AS "columnName",
          data_type AS "dataType",
          is_nullable AS "isNullable",
          column_default AS "columnDefault",
          ordinal_position AS "position"
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = $1
        ORDER BY ordinal_position ASC
      `,
      [tableName]
    );

    const indexesResult = await dbQuery(
      `
        SELECT
          indexname AS "indexName",
          indexdef AS "indexDef"
        FROM pg_indexes
        WHERE schemaname = 'public'
          AND tablename = $1
        ORDER BY indexname ASC
      `,
      [tableName]
    );

    const constraintsResult = await dbQuery(
      `
        SELECT
          con.conname AS "constraintName",
          con.contype AS "constraintType",
          CASE con.contype
            WHEN 'p' THEN 'primary_key'
            WHEN 'f' THEN 'foreign_key'
            WHEN 'u' THEN 'unique'
            WHEN 'c' THEN 'check'
            ELSE con.contype::text
          END AS "constraintLabel",
          pg_get_constraintdef(con.oid) AS "definition"
        FROM pg_constraint con
        JOIN pg_class rel ON rel.oid = con.conrelid
        JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
        WHERE nsp.nspname = 'public'
          AND rel.relname = $1
        ORDER BY con.contype ASC, con.conname ASC
      `,
      [tableName]
    );

    const foreignKeysResult = await dbQuery(
      `
        SELECT
          con.conname AS "constraintName",
          pg_get_constraintdef(con.oid) AS "definition",
          ref.relname AS "referencedTable"
        FROM pg_constraint con
        JOIN pg_class rel ON rel.oid = con.conrelid
        JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
        JOIN pg_class ref ON ref.oid = con.confrelid
        WHERE nsp.nspname = 'public'
          AND rel.relname = $1
          AND con.contype = 'f'
        ORDER BY con.conname ASC
      `,
      [tableName]
    );

    const statsResult = await dbQuery(
      `
        SELECT
          COALESCE(n_live_tup, 0)::bigint AS "estimatedRows",
          COALESCE(seq_scan, 0)::bigint AS "seqScan",
          COALESCE(idx_scan, 0)::bigint AS "idxScan",
          COALESCE(n_tup_ins, 0)::bigint AS "rowsInserted",
          COALESCE(n_tup_upd, 0)::bigint AS "rowsUpdated",
          COALESCE(n_tup_del, 0)::bigint AS "rowsDeleted",
          last_vacuum AS "lastVacuum",
          last_autovacuum AS "lastAutovacuum",
          last_analyze AS "lastAnalyze",
          last_autoanalyze AS "lastAutoanalyze"
        FROM pg_stat_user_tables
        WHERE schemaname = 'public'
          AND relname = $1
        LIMIT 1
      `,
      [tableName]
    );

    const sizeResult = await dbQuery(
      `
        SELECT
          pg_total_relation_size($1::regclass)::bigint AS "totalSizeBytes",
          pg_relation_size($1::regclass)::bigint AS "tableSizeBytes",
          pg_indexes_size($1::regclass)::bigint AS "indexSizeBytes",
          pg_size_pretty(pg_total_relation_size($1::regclass)) AS "totalSizePretty",
          pg_size_pretty(pg_relation_size($1::regclass)) AS "tableSizePretty",
          pg_size_pretty(pg_indexes_size($1::regclass)) AS "indexSizePretty"
      `,
      [qualifiedName]
    );

    return ok(res, {
      tableName,
      columns: columnsResult.rows,
      indexes: indexesResult.rows,
      constraints: constraintsResult.rows,
      foreignKeys: foreignKeysResult.rows,
      stats: statsResult.rows[0] || {},
      size: sizeResult.rows[0] || {},
      counts: {
        columns: columnsResult.rows.length,
        indexes: indexesResult.rows.length,
        constraints: constraintsResult.rows.length,
        foreignKeys: foreignKeysResult.rows.length,
      },
    });
  } catch (error) {
    return fail(res, "Failed to load table metadata", 500, error.message);
  }
});


function normalizeStorageRow(row = {}) {
  const normalized = {};

  for (const [key, value] of Object.entries(row)) {
    normalized[key] = value;
    normalized[key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
  }

  return normalized;
}

function getStorageFilePath(file = {}) {
  return (
    file.file_path ||
    file.filePath ||
    file.storage_path ||
    file.storagePath ||
    file.full_path ||
    file.fullPath ||
    file.path ||
    null
  );
}

function getStorageFileName(file = {}) {
  return (
    file.original_name ||
    file.originalName ||
    file.filename ||
    file.file_name ||
    file.fileName ||
    file.name ||
    file.id ||
    "download"
  );
}


function storageV2SafeJson(value, fallback = {}) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value === "string" && value.trim()) {
    try { return JSON.parse(value); } catch {}
  }
  return fallback;
}

function storageV2Bool(value, fallback = false) {
  if (value === true || value === "true" || value === 1 || value === "1") return true;
  if (value === false || value === "false" || value === 0 || value === "0") return false;
  return fallback;
}

function storageV2Provider(value) {
  const provider = String(value || "local").trim().toLowerCase();
  if (["local", "s3", "r2", "minio", "spaces", "wasabi"].includes(provider)) return provider;
  return "local";
}

function storageV2CleanText(value, fallback = "") {
  const text = String(value ?? fallback ?? "").trim();
  return text;
}

function storageV2Sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function storageV2Md5File(filePath) {
  return crypto.createHash("md5").update(fs.readFileSync(filePath)).digest("hex");
}

router.get("/storage-v2-page-data", async (req, res) => {
  try {
    const providersResult = await dbQuery(`
      SELECT
        id,
        name,
        provider,
        status,
        endpoint_url AS "endpointUrl",
        region,
        bucket_name AS "bucketName",
        access_key_prefix AS "accessKeyPrefix",
        secret_ref AS "secretRef",
        cdn_base_url AS "cdnBaseUrl",
        path_style AS "pathStyle",
        force_ssl AS "forceSsl",
        metadata_json AS "metadata",
        organization_id AS "organizationId",
        project_id AS "projectId",
        environment_id AS "environmentId",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM backend_storage_provider_configs
      ORDER BY created_at DESC
      LIMIT 100
    `);

    const bucketsResult = await dbQuery(`
      SELECT
        b.*,
        COALESCE(file_stats.file_count, 0)::int AS "fileCount",
        COALESCE(file_stats.total_bytes, 0)::bigint AS "totalBytes"
      FROM backend_storage_buckets b
      LEFT JOIN (
        SELECT bucket_id, COUNT(*)::int AS file_count, COALESCE(SUM(size_bytes), 0)::bigint AS total_bytes
        FROM backend_storage_files
        WHERE status = 'active'
          AND COALESCE(file_deleted, false) = false
        GROUP BY bucket_id
      ) file_stats ON file_stats.bucket_id = b.id
      ORDER BY b.created_at DESC
      LIMIT 250
    `);

    const filesResult = await dbQuery(`
      SELECT
        f.*,
        b.name AS bucket_name,
        b.provider AS bucket_provider,
        b.cdn_enabled AS bucket_cdn_enabled,
        b.cdn_base_url AS bucket_cdn_base_url
      FROM backend_storage_files f
      LEFT JOIN backend_storage_buckets b ON b.id = f.bucket_id
      ORDER BY f.created_at DESC
      LIMIT 300
    `);

    const versionsResult = await dbQuery(`
      SELECT *
      FROM backend_storage_object_versions
      ORDER BY created_at DESC
      LIMIT 200
    `);

    const signedUrlsResult = await dbQuery(`
      SELECT *
      FROM backend_storage_signed_urls
      ORDER BY created_at DESC
      LIMIT 100
    `);

    return ok(res, {
      providers: providersResult.rows,
      buckets: bucketsResult.rows,
      files: filesResult.rows,
      versions: versionsResult.rows,
      signedUrls: signedUrlsResult.rows,
      counts: {
        providers: providersResult.rows.length,
        buckets: bucketsResult.rows.length,
        files: filesResult.rows.length,
        versions: versionsResult.rows.length,
        signedUrls: signedUrlsResult.rows.length,
        cdnEnabledBuckets: bucketsResult.rows.filter((bucket) => bucket.cdn_enabled === true).length,
        publicBuckets: bucketsResult.rows.filter((bucket) => bucket.public_read_enabled === true || bucket.visibility === "public").length,
        localFiles: filesResult.rows.filter((file) => file.provider === "local").length,
      },
    });
  } catch (error) {
    return fail(res, "Failed to load Storage V2 page data", 500, error.message);
  }
});

router.post("/storage/providers/create-safe", async (req, res) => {
  try {
    const provider = storageV2Provider(req.body?.provider || "local");
    const name = storageV2CleanText(req.body?.name || `${provider.toUpperCase()} Provider`);
    const id = `storage_provider_${provider}_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;

    const result = await dbQuery(
      `
        INSERT INTO backend_storage_provider_configs (
          id,
          name,
          provider,
          status,
          endpoint_url,
          region,
          bucket_name,
          access_key_prefix,
          secret_ref,
          cdn_base_url,
          path_style,
          force_ssl,
          metadata_json,
          organization_id,
          project_id,
          environment_id,
          created_by
        )
        VALUES ($1,$2,$3,$4,NULLIF($5,''),NULLIF($6,''),NULLIF($7,''),NULLIF($8,''),NULLIF($9,''),NULLIF($10,''),$11,$12,$13::jsonb,'org_goodos','proj_goodos_platform','env_goodos_production',(SELECT id FROM users ORDER BY created_at ASC LIMIT 1))
        RETURNING *
      `,
      [
        id,
        name,
        provider,
        storageV2CleanText(req.body?.status || "active"),
        storageV2CleanText(req.body?.endpointUrl || req.body?.endpoint_url || ""),
        storageV2CleanText(req.body?.region || ""),
        storageV2CleanText(req.body?.bucketName || req.body?.bucket_name || ""),
        storageV2CleanText(req.body?.accessKeyPrefix || req.body?.access_key_prefix || ""),
        storageV2CleanText(req.body?.secretRef || req.body?.secret_ref || ""),
        storageV2CleanText(req.body?.cdnBaseUrl || req.body?.cdn_base_url || ""),
        storageV2Bool(req.body?.pathStyle ?? req.body?.path_style, true),
        storageV2Bool(req.body?.forceSsl ?? req.body?.force_ssl, true),
        JSON.stringify(storageV2SafeJson(req.body?.metadata || req.body?.metadata_json, { createdFrom: "GoodAppBackEnd Console" })),
      ]
    );

    await dbQuery(
      `
        INSERT INTO backend_admin_audit_logs (
          id,
          actor,
          action,
          target_type,
          target_id,
          after_json,
          organization_id,
          project_id,
          environment_id,
          ip_address,
          user_agent
        )
        VALUES ($1,$2,'storage.provider.create','storage_provider',$3,$4::jsonb,'org_goodos','proj_goodos_platform','env_goodos_production',$5,$6)
      `,
      [
        `audit_${crypto.randomUUID().replace(/-/g, "")}`,
        req.user?.email || req.session?.user?.email || req.auth?.user?.email || "console-user",
        id,
        JSON.stringify(result.rows[0]),
        req.headers["x-forwarded-for"] || req.socket?.remoteAddress || null,
        req.headers["user-agent"] || null,
      ]
    );

    return ok(res, { provider: result.rows[0], message: "Storage provider created." });
  } catch (error) {
    return fail(res, "Failed to create storage provider", 500, error.message);
  }
});

router.post("/storage/buckets/:bucketId/v2/update-safe", async (req, res) => {
  try {
    const bucketId = String(req.params.bucketId || "").trim();
    if (!bucketId) return fail(res, "Bucket id is required", 400);

    const beforeResult = await dbQuery("SELECT * FROM backend_storage_buckets WHERE id = $1 LIMIT 1", [bucketId]);
    const before = beforeResult.rows[0];
    if (!before) return fail(res, "Bucket not found", 404);

    const provider = storageV2Provider(req.body?.provider ?? before.provider ?? "local");
    const cdnEnabled = storageV2Bool(req.body?.cdnEnabled ?? req.body?.cdn_enabled, before.cdn_enabled === true);
    const publicReadEnabled = storageV2Bool(req.body?.publicReadEnabled ?? req.body?.public_read_enabled, before.public_read_enabled === true);

    const result = await dbQuery(
      `
        UPDATE backend_storage_buckets
        SET
          provider = $2,
          provider_config_id = NULLIF($3, ''),
          provider_bucket_name = NULLIF($4, ''),
          provider_region = NULLIF($5, ''),
          provider_endpoint = NULLIF($6, ''),
          provider_prefix = $7,
          cdn_enabled = $8,
          cdn_base_url = NULLIF($9, ''),
          public_read_enabled = $10,
          cache_control = $11,
          object_lock_enabled = $12,
          lifecycle_json = $13::jsonb,
          cors_json = $14::jsonb,
          storage_class = $15,
          checksum_algorithm = $16,
          metadata_json = $17::jsonb,
          updated_at = NOW()
        WHERE id = $1
        RETURNING *
      `,
      [
        bucketId,
        provider,
        storageV2CleanText(req.body?.providerConfigId ?? req.body?.provider_config_id ?? before.provider_config_id ?? ""),
        storageV2CleanText(req.body?.providerBucketName ?? req.body?.provider_bucket_name ?? before.provider_bucket_name ?? before.name),
        storageV2CleanText(req.body?.providerRegion ?? req.body?.provider_region ?? before.provider_region ?? "local"),
        storageV2CleanText(req.body?.providerEndpoint ?? req.body?.provider_endpoint ?? before.provider_endpoint ?? ""),
        storageV2CleanText(req.body?.providerPrefix ?? req.body?.provider_prefix ?? before.provider_prefix ?? ""),
        cdnEnabled,
        storageV2CleanText(req.body?.cdnBaseUrl ?? req.body?.cdn_base_url ?? before.cdn_base_url ?? ""),
        publicReadEnabled,
        storageV2CleanText(req.body?.cacheControl ?? req.body?.cache_control ?? before.cache_control ?? (publicReadEnabled ? "public, max-age=3600" : "private, max-age=0")),
        storageV2Bool(req.body?.objectLockEnabled ?? req.body?.object_lock_enabled, before.object_lock_enabled === true),
        JSON.stringify(storageV2SafeJson(req.body?.lifecycleJson ?? req.body?.lifecycle_json, before.lifecycle_json || {})),
        JSON.stringify(storageV2SafeJson(req.body?.corsJson ?? req.body?.cors_json, before.cors_json || {})),
        storageV2CleanText(req.body?.storageClass ?? req.body?.storage_class ?? before.storage_class ?? "standard"),
        storageV2CleanText(req.body?.checksumAlgorithm ?? req.body?.checksum_algorithm ?? before.checksum_algorithm ?? "sha256"),
        JSON.stringify(storageV2SafeJson(req.body?.metadataJson ?? req.body?.metadata_json, before.metadata_json || {})),
      ]
    );

    await dbQuery(
      `
        UPDATE backend_storage_files f
        SET
          provider = $2,
          provider_bucket_name = $3,
          provider_region = $4,
          provider_endpoint = $5,
          cache_control = $6,
          public_url = CASE
            WHEN $7::boolean = true THEN 'https://base.goodos.app/storage/public/' || $8 || '/' || COALESCE(NULLIF(f.object_key, ''), f.filename)
            ELSE f.public_url
          END,
          cdn_url = CASE
            WHEN $9::boolean = true AND NULLIF($10, '') IS NOT NULL THEN rtrim($10, '/') || '/' || COALESCE(NULLIF(f.object_key, ''), f.filename)
            ELSE f.cdn_url
          END,
          updated_at = NOW()
        WHERE f.bucket_id = $1
      `,
      [
        bucketId,
        provider,
        result.rows[0].provider_bucket_name || result.rows[0].name,
        result.rows[0].provider_region || "local",
        result.rows[0].provider_endpoint || "",
        result.rows[0].cache_control || "private, max-age=0",
        result.rows[0].public_read_enabled === true || result.rows[0].visibility === "public",
        result.rows[0].name,
        result.rows[0].cdn_enabled === true,
        result.rows[0].cdn_base_url || "",
      ]
    );

    return ok(res, { bucket: result.rows[0], message: "Storage V2 bucket settings updated." });
  } catch (error) {
    return fail(res, "Failed to update Storage V2 bucket settings", 500, error.message);
  }
});

router.post("/storage/files/:fileId/metadata-refresh-safe", async (req, res) => {
  try {
    const fileId = String(req.params.fileId || "").trim();
    if (!fileId) return fail(res, "File id is required", 400);

    const fileResult = await dbQuery(
      `
        SELECT
          f.*,
          b.name AS bucket_name,
          b.public_read_enabled,
          b.visibility,
          b.cdn_enabled,
          b.cdn_base_url,
          b.cache_control AS bucket_cache_control
        FROM backend_storage_files f
        LEFT JOIN backend_storage_buckets b ON b.id = f.bucket_id
        WHERE f.id = $1
        LIMIT 1
      `,
      [fileId]
    );

    const file = fileResult.rows[0];
    if (!file) return fail(res, "Storage file not found", 404);

    const storagePath = file.storage_path || file.storagePath;
    if (!storagePath || !fs.existsSync(storagePath)) {
      return fail(res, "File path is missing from disk", 404);
    }

    const stats = fs.statSync(storagePath);
    const checksumSha256 = storageV2Sha256File(storagePath);
    const checksumMd5 = storageV2Md5File(storagePath);
    const objectKey = storageV2CleanText(file.object_key || file.filename || path.basename(storagePath));
    const publicEnabled = file.public_read_enabled === true || file.visibility === "public";
    const publicUrl = publicEnabled ? `https://base.goodos.app/storage/public/${file.bucket_name}/${objectKey}` : file.public_url;
    const cdnUrl = file.cdn_enabled === true && file.cdn_base_url ? `${String(file.cdn_base_url).replace(/\/+$/, "")}/${objectKey}` : file.cdn_url;

    const updateResult = await dbQuery(
      `
        UPDATE backend_storage_files
        SET
          size_bytes = $2,
          checksum_sha256 = $3,
          checksum_md5 = $4,
          checksum_algorithm = 'sha256',
          object_key = $5,
          provider_etag = $3,
          version_id = COALESCE(version_id, 'v1'),
          version_number = COALESCE(version_number, 1),
          is_latest_version = true,
          public_url = $6,
          cdn_url = $7,
          cache_control = COALESCE(cache_control, $8),
          provider_metadata_json = jsonb_build_object('lastRefreshAt', NOW(), 'diskPath', $9, 'local', true),
          updated_at = NOW()
        WHERE id = $1
        RETURNING *
      `,
      [
        fileId,
        stats.size,
        checksumSha256,
        checksumMd5,
        objectKey,
        publicUrl || null,
        cdnUrl || null,
        file.bucket_cache_control || "private, max-age=0",
        storagePath,
      ]
    );

    await dbQuery(
      `
        INSERT INTO backend_storage_object_versions (
          id,
          file_id,
          bucket_id,
          object_key,
          version_id,
          version_number,
          provider,
          size_bytes,
          checksum_sha256,
          checksum_md5,
          storage_path,
          public_url,
          cdn_url,
          status,
          metadata_json,
          organization_id,
          project_id,
          environment_id,
          created_by
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'active',$14::jsonb,$15,$16,$17,(SELECT id FROM users ORDER BY created_at ASC LIMIT 1))
        ON CONFLICT (id) DO UPDATE
        SET
          size_bytes = EXCLUDED.size_bytes,
          checksum_sha256 = EXCLUDED.checksum_sha256,
          checksum_md5 = EXCLUDED.checksum_md5,
          storage_path = EXCLUDED.storage_path,
          public_url = EXCLUDED.public_url,
          cdn_url = EXCLUDED.cdn_url,
          status = 'active'
      `,
      [
        `storver_${fileId}_v${file.version_number || 1}`,
        fileId,
        file.bucket_id,
        objectKey,
        file.version_id || "v1",
        Number(file.version_number || 1),
        file.provider || "local",
        stats.size,
        checksumSha256,
        checksumMd5,
        storagePath,
        publicUrl || null,
        cdnUrl || null,
        JSON.stringify({ refreshedFrom: "Storage V2 Console", refreshedAt: new Date().toISOString() }),
        file.organization_id || "org_goodos",
        file.project_id || "proj_goodos_platform",
        file.environment_id || "env_goodos_production",
      ]
    );

    return ok(res, {
      file: updateResult.rows[0],
      message: "Storage file metadata refreshed.",
    });
  } catch (error) {
    return fail(res, "Failed to refresh storage file metadata", 500, error.message);
  }
});

router.get("/storage-manager-page-data", async (req, res) => {
  try {
    const bucketsResult = await dbQuery(`
      SELECT *
      FROM backend_storage_buckets
      ORDER BY created_at DESC NULLS LAST, name ASC
      LIMIT 500
    `);

    const filesResult = await dbQuery(`
      SELECT *
      FROM backend_storage_files
      WHERE deleted_at IS NULL
        AND COALESCE(file_deleted, false) = false
      ORDER BY created_at DESC NULLS LAST
      LIMIT 1000
    `);

    const signedUrlsResult = await dbQuery(`
      SELECT *
      FROM backend_storage_signed_urls
      ORDER BY created_at DESC NULLS LAST
      LIMIT 250
    `);

    const buckets = bucketsResult.rows.map(normalizeStorageRow);
    const files = filesResult.rows.map(normalizeStorageRow);
    const signedUrls = signedUrlsResult.rows.map(normalizeStorageRow);

    const bucketStats = files.reduce((acc, file) => {
      const bucketId = file.bucketId || file.bucket_id;
      if (!bucketId) return acc;

      if (!acc[bucketId]) {
        acc[bucketId] = {
          fileCount: 0,
          totalBytes: 0,
        };
      }

      acc[bucketId].fileCount += 1;
      acc[bucketId].totalBytes += Number(file.sizeBytes || file.size_bytes || 0);

      return acc;
    }, {});

    return ok(res, {
      buckets,
      files,
      signedUrls,
      bucketStats,
      counts: {
        buckets: buckets.length,
        files: files.length,
        signedUrls: signedUrls.length,
        totalBytes: files.reduce((sum, file) => sum + Number(file.sizeBytes || file.size_bytes || 0), 0),
      },
    });
  } catch (error) {
    return fail(res, "Failed to load storage manager data", 500, error.message);
  }
});

router.get("/storage/files/:fileId/download", async (req, res) => {
  try {
    const fs = require("fs");
    const path = require("path");

    const fileId = String(req.params.fileId || "").trim();

    if (!fileId) return fail(res, "File id is required", 400);

    const result = await dbQuery(
      `
        SELECT *
        FROM backend_storage_files
        WHERE id = $1
        LIMIT 1
      `,
      [fileId]
    );

    const file = normalizeStorageRow(result.rows[0] || {});

    if (!file.id) return fail(res, "File not found", 404);
    if (file.deletedAt || file.deleted_at || file.fileDeleted || file.file_deleted) {
      return fail(res, "File was deleted", 410);
    }

    const filePath = getStorageFilePath(file);

    if (!filePath || !fs.existsSync(filePath)) {
      return fail(res, "File does not exist on disk", 404);
    }

    const safeName = path.basename(getStorageFileName(file));

    return res.download(filePath, safeName);
  } catch (error) {
    return fail(res, "Failed to download storage file", 500, error.message);
  }
});

router.post("/storage/files/:fileId/delete-safe", async (req, res) => {
  try {
    const fs = require("fs");

    const fileId = String(req.params.fileId || "").trim();
    const reason = String(req.body?.reason || "Manual delete from Storage File Manager.").trim();

    if (!fileId) return fail(res, "File id is required", 400);

    const beforeResult = await dbQuery(
      `
        SELECT *
        FROM backend_storage_files
        WHERE id = $1
        LIMIT 1
      `,
      [fileId]
    );

    const before = beforeResult.rows[0];
    if (!before) return fail(res, "File not found", 404);

    const normalizedBefore = normalizeStorageRow(before);
    const filePath = getStorageFilePath(normalizedBefore);
    let diskDeleted = false;

    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      diskDeleted = true;
    }

    const updateResult = await dbQuery(
      `
        UPDATE backend_storage_files
        SET
          status = CASE WHEN status = 'active' THEN 'deleted' ELSE status END,
          deleted_at = NOW(),
          deleted_by = $2,
          deleted_reason = $3,
          file_deleted = true
        WHERE id = $1
        RETURNING *
      `,
      [
        fileId,
        req.user?.email || req.session?.user?.email || req.auth?.user?.email || "console-user",
        reason,
      ]
    );

    await dbQuery(
      `
        INSERT INTO backend_admin_audit_logs (
          id,
          actor,
          action,
          target_type,
          target_id,
          before_json,
          after_json,
          ip_address,
          user_agent
        )
        VALUES ($1, $2, 'storage.file.delete', 'storage_file', $3, $4::jsonb, $5::jsonb, $6, $7)
      `,
      [
        `audit_${crypto.randomUUID().replace(/-/g, "")}`,
        req.user?.email || req.session?.user?.email || req.auth?.user?.email || "console-user",
        fileId,
        JSON.stringify(normalizedBefore),
        JSON.stringify({ diskDeleted, reason }),
        req.headers["x-forwarded-for"] || req.socket?.remoteAddress || null,
        req.headers["user-agent"] || null,
      ]
    );

    return ok(res, {
      file: normalizeStorageRow(updateResult.rows[0]),
      diskDeleted,
      message: diskDeleted ? "File deleted from disk and record marked." : "File record marked deleted. Disk file was not found.",
    });
  } catch (error) {
    return fail(res, "Failed to delete storage file", 500, error.message);
  }
});


function normalizeStorageFileManagerRow(row = {}) {
  const normalized = {};

  for (const [key, value] of Object.entries(row)) {
    normalized[key] = value;
    normalized[key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
  }

  return normalized;
}

function getStorageFileManagerPath(file = {}) {
  return (
    file.file_path ||
    file.filePath ||
    file.storage_path ||
    file.storagePath ||
    file.full_path ||
    file.fullPath ||
    file.path ||
    null
  );
}

function getStorageFileManagerName(file = {}) {
  return (
    file.original_name ||
    file.originalName ||
    file.filename ||
    file.file_name ||
    file.fileName ||
    file.name ||
    file.id ||
    "download"
  );
}

function getStorageFileManagerMime(file = {}) {
  return (
    file.mime_type ||
    file.mimeType ||
    file.content_type ||
    file.contentType ||
    file.type ||
    "application/octet-stream"
  );
}


router.get("/storage/files/:fileId/preview-safe", async (req, res) => {
  try {
    const fs = require("fs");
    const path = require("path");

    const fileId = String(req.params.fileId || "").trim();

    if (!fileId) return fail(res, "File id is required", 400);

    const result = await dbQuery(
      `
        SELECT *
        FROM backend_storage_files
        WHERE id = $1
        LIMIT 1
      `,
      [fileId]
    );

    const file = normalizeStorageFileManagerRow(result.rows[0] || {});

    if (!file.id) return fail(res, "File not found", 404);

    if (file.deletedAt || file.deleted_at || file.fileDeleted || file.file_deleted) {
      return fail(res, "File was deleted", 410);
    }

    const filePath = getStorageFileManagerPath(file);

    if (!filePath || !fs.existsSync(filePath)) {
      return fail(res, "File does not exist on disk", 404);
    }

    const safeName = path.basename(getStorageFileManagerName(file));
    const mimeType = getStorageFileManagerMime(file);

    res.setHeader("Content-Type", mimeType);
    res.setHeader("Content-Disposition", `inline; filename="${safeName}"`);
    return res.sendFile(filePath);
  } catch (error) {
    return fail(res, "Failed to preview storage file", 500, error.message);
  }
});

router.get("/storage/files/:fileId/download", async (req, res) => {
  try {
    const fs = require("fs");
    const path = require("path");

    const fileId = String(req.params.fileId || "").trim();

    if (!fileId) return fail(res, "File id is required", 400);

    const result = await dbQuery(
      `
        SELECT *
        FROM backend_storage_files
        WHERE id = $1
        LIMIT 1
      `,
      [fileId]
    );

    const file = normalizeStorageFileManagerRow(result.rows[0] || {});

    if (!file.id) return fail(res, "File not found", 404);

    if (file.deletedAt || file.deleted_at || file.fileDeleted || file.file_deleted) {
      return fail(res, "File was deleted", 410);
    }

    const filePath = getStorageFileManagerPath(file);

    if (!filePath || !fs.existsSync(filePath)) {
      return fail(res, "File does not exist on disk", 404);
    }

    const safeName = path.basename(getStorageFileManagerName(file));

    return res.download(filePath, safeName);
  } catch (error) {
    return fail(res, "Failed to download storage file", 500, error.message);
  }
});

router.post("/storage/files/:fileId/delete-safe", async (req, res) => {
  try {
    const fs = require("fs");

    const fileId = String(req.params.fileId || "").trim();
    const reason = String(req.body?.reason || "Manual delete from Storage File Manager.").trim();

    if (!fileId) return fail(res, "File id is required", 400);

    const beforeResult = await dbQuery(
      `
        SELECT *
        FROM backend_storage_files
        WHERE id = $1
        LIMIT 1
      `,
      [fileId]
    );

    const before = beforeResult.rows[0];

    if (!before) return fail(res, "File not found", 404);

    const normalizedBefore = normalizeStorageFileManagerRow(before);
    const filePath = getStorageFileManagerPath(normalizedBefore);

    let diskDeleted = false;

    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      diskDeleted = true;
    }

    const updateResult = await dbQuery(
      `
        UPDATE backend_storage_files
        SET
          status = CASE WHEN status = 'active' THEN 'deleted' ELSE status END,
          deleted_at = NOW(),
          deleted_by = $2,
          deleted_reason = $3,
          file_deleted = true
        WHERE id = $1
        RETURNING *
      `,
      [
        fileId,
        req.user?.email || req.session?.user?.email || req.auth?.user?.email || "console-user",
        reason,
      ]
    );

    await dbQuery(
      `
        INSERT INTO backend_admin_audit_logs (
          id,
          actor,
          action,
          target_type,
          target_id,
          before_json,
          after_json,
          ip_address,
          user_agent
        )
        VALUES ($1, $2, 'storage.file.delete', 'storage_file', $3, $4::jsonb, $5::jsonb, $6, $7)
      `,
      [
        `audit_${crypto.randomUUID().replace(/-/g, "")}`,
        req.user?.email || req.session?.user?.email || req.auth?.user?.email || "console-user",
        fileId,
        JSON.stringify(normalizedBefore),
        JSON.stringify({ diskDeleted, reason }),
        req.headers["x-forwarded-for"] || req.socket?.remoteAddress || null,
        req.headers["user-agent"] || null,
      ]
    );

    return ok(res, {
      file: normalizeStorageFileManagerRow(updateResult.rows[0]),
      diskDeleted,
      message: diskDeleted ? "File deleted from disk and record marked." : "File record marked deleted. Disk file was not found.",
    });
  } catch (error) {
    return fail(res, "Failed to delete storage file", 500, error.message);
  }
});


function normalizeStorageFolderPath(value) {
  let folder = String(value || "").trim();

  folder = folder.replace(/^\/+|\/+$/g, "");
  folder = folder.replace(/\/+/g, "/");

  if (!folder) return "";

  const parts = folder.split("/");

  for (const part of parts) {
    if (!/^[a-zA-Z0-9._-]{1,80}$/.test(part)) {
      const error = new Error("Invalid folder path. Use letters, numbers, dashes, underscores, dots, and slashes only.");
      error.statusCode = 400;
      throw error;
    }
  }

  return folder;
}

function normalizeStorageDisplayName(value) {
  const name = String(value || "").trim();

  if (!name) {
    const error = new Error("File name is required.");
    error.statusCode = 400;
    throw error;
  }

  if (name.length > 180 || /[\/\\]/.test(name)) {
    const error = new Error("Invalid file name. Do not use slashes and keep it under 180 characters.");
    error.statusCode = 400;
    throw error;
  }

  return name;
}

router.post("/storage/files/:fileId/rename-safe", async (req, res) => {
  try {
    const fileId = String(req.params.fileId || "").trim();
    const displayName = normalizeStorageDisplayName(req.body?.displayName);

    if (!fileId) return fail(res, "File id is required", 400);

    const beforeResult = await dbQuery(
      `
        SELECT *
        FROM backend_storage_files
        WHERE id = $1
        LIMIT 1
      `,
      [fileId]
    );

    const before = beforeResult.rows[0];
    if (!before) return fail(res, "File not found", 404);

    const result = await dbQuery(
      `
        UPDATE backend_storage_files
        SET
          display_name = $2,
          metadata_json = COALESCE(metadata_json, '{}'::jsonb) || jsonb_build_object('renamedAt', NOW(), 'renamedBy', $3)
        WHERE id = $1
        RETURNING *
      `,
      [
        fileId,
        displayName,
        req.user?.email || req.session?.user?.email || req.auth?.user?.email || "console-user",
      ]
    );

    await dbQuery(
      `
        INSERT INTO backend_admin_audit_logs (
          id,
          actor,
          action,
          target_type,
          target_id,
          before_json,
          after_json,
          ip_address,
          user_agent
        )
        VALUES ($1, $2, 'storage.file.rename', 'storage_file', $3, $4::jsonb, $5::jsonb, $6, $7)
      `,
      [
        `audit_${crypto.randomUUID().replace(/-/g, "")}`,
        req.user?.email || req.session?.user?.email || req.auth?.user?.email || "console-user",
        fileId,
        JSON.stringify(before),
        JSON.stringify(result.rows[0]),
        req.headers["x-forwarded-for"] || req.socket?.remoteAddress || null,
        req.headers["user-agent"] || null,
      ]
    );

    return ok(res, {
      file: result.rows[0],
      message: "File renamed.",
    });
  } catch (error) {
    return fail(res, "Failed to rename storage file", error.statusCode || 500, error.message);
  }
});

router.post("/storage/files/:fileId/move-safe", async (req, res) => {
  try {
    const fileId = String(req.params.fileId || "").trim();
    const folderPath = normalizeStorageFolderPath(req.body?.folderPath);

    if (!fileId) return fail(res, "File id is required", 400);

    const beforeResult = await dbQuery(
      `
        SELECT *
        FROM backend_storage_files
        WHERE id = $1
        LIMIT 1
      `,
      [fileId]
    );

    const before = beforeResult.rows[0];
    if (!before) return fail(res, "File not found", 404);

    const result = await dbQuery(
      `
        UPDATE backend_storage_files
        SET
          folder_path = $2,
          metadata_json = COALESCE(metadata_json, '{}'::jsonb) || jsonb_build_object('movedAt', NOW(), 'movedBy', $3)
        WHERE id = $1
        RETURNING *
      `,
      [
        fileId,
        folderPath,
        req.user?.email || req.session?.user?.email || req.auth?.user?.email || "console-user",
      ]
    );

    await dbQuery(
      `
        INSERT INTO backend_admin_audit_logs (
          id,
          actor,
          action,
          target_type,
          target_id,
          before_json,
          after_json,
          ip_address,
          user_agent
        )
        VALUES ($1, $2, 'storage.file.move', 'storage_file', $3, $4::jsonb, $5::jsonb, $6, $7)
      `,
      [
        `audit_${crypto.randomUUID().replace(/-/g, "")}`,
        req.user?.email || req.session?.user?.email || req.auth?.user?.email || "console-user",
        fileId,
        JSON.stringify(before),
        JSON.stringify(result.rows[0]),
        req.headers["x-forwarded-for"] || req.socket?.remoteAddress || null,
        req.headers["user-agent"] || null,
      ]
    );

    return ok(res, {
      file: result.rows[0],
      message: "File moved.",
    });
  } catch (error) {
    return fail(res, "Failed to move storage file", error.statusCode || 500, error.message);
  }
});


function normalizeStoragePolicyStringArray(value, kind) {
  if (value === undefined || value === null) return [];

  if (!Array.isArray(value)) {
    const error = new Error(`${kind} must be an array.`);
    error.statusCode = 400;
    throw error;
  }

  return value
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .slice(0, 100);
}

function normalizeStorageExtensions(value) {
  return normalizeStoragePolicyStringArray(value, "allowedExtensions").map((item) => {
    let ext = item.toLowerCase();
    if (!ext.startsWith(".")) ext = "." + ext;
    if (!/^\.[a-z0-9]{1,12}$/.test(ext)) {
      const error = new Error(`Invalid extension: ${item}`);
      error.statusCode = 400;
      throw error;
    }
    return ext;
  });
}

function normalizeStorageMimeTypes(value) {
  return normalizeStoragePolicyStringArray(value, "allowedMimeTypes").map((item) => {
    const mime = item.toLowerCase();
    if (!/^[a-z0-9.+-]+\/[a-z0-9.+*-]+$/.test(mime)) {
      const error = new Error(`Invalid MIME type: ${item}`);
      error.statusCode = 400;
      throw error;
    }
    return mime;
  });
}

router.post("/storage/buckets/:bucketId/policy/update-safe", async (req, res) => {
  try {
    const bucketId = String(req.params.bucketId || "").trim();

    if (!bucketId) return fail(res, "Bucket id is required", 400);

    const beforeResult = await dbQuery(
      `
        SELECT *
        FROM backend_storage_buckets
        WHERE id = $1
        LIMIT 1
      `,
      [bucketId]
    );

    const before = beforeResult.rows[0];
    if (!before) return fail(res, "Bucket not found", 404);

    const visibility = String(req.body?.visibility || before.visibility || "private").trim().toLowerCase();
    if (!["private", "public"].includes(visibility)) {
      return fail(res, "Visibility must be private or public.", 400);
    }

    const maxFileSizeBytes = Math.min(
      Math.max(Number(req.body?.maxFileSizeBytes ?? req.body?.max_file_size_bytes ?? before.max_file_size_bytes ?? 10485760), 1024),
      5368709120
    );

    const signedUrlTtlSeconds = Math.min(
      Math.max(Number(req.body?.signedUrlTtlSeconds ?? req.body?.signed_url_ttl_seconds ?? before.signed_url_ttl_seconds ?? 3600), 60),
      604800
    );

    const allowedMimeTypes = normalizeStorageMimeTypes(
      req.body?.allowedMimeTypes ?? req.body?.allowed_mime_types ?? before.allowed_mime_types ?? []
    );

    const allowedExtensions = normalizeStorageExtensions(
      req.body?.allowedExtensions ?? req.body?.allowed_extensions ?? before.allowed_extensions ?? []
    );

    const publicReadEnabled = req.body?.publicReadEnabled === true || req.body?.public_read_enabled === true;
    const fileVersioningEnabled = req.body?.fileVersioningEnabled === true || req.body?.file_versioning_enabled === true;
    const virusScanRequired = req.body?.virusScanRequired === true || req.body?.virus_scan_required === true;

    const encryptionMode = String(req.body?.encryptionMode || req.body?.encryption_mode || before.encryption_mode || "local").trim().toLowerCase();

    if (!["local", "managed", "external"].includes(encryptionMode)) {
      return fail(res, "Encryption mode must be local, managed, or external.", 400);
    }

    const result = await dbQuery(
      `
        UPDATE backend_storage_buckets
        SET
          visibility = $2,
          max_file_size_bytes = $3,
          allowed_mime_types = $4,
          allowed_extensions = $5,
          public_read_enabled = $6,
          signed_url_ttl_seconds = $7,
          file_versioning_enabled = $8,
          virus_scan_required = $9,
          encryption_mode = $10,
          updated_at = NOW()
        WHERE id = $1
        RETURNING *
      `,
      [
        bucketId,
        visibility,
        maxFileSizeBytes,
        allowedMimeTypes,
        allowedExtensions,
        publicReadEnabled,
        signedUrlTtlSeconds,
        fileVersioningEnabled,
        virusScanRequired,
        encryptionMode,
      ]
    );

    await dbQuery(
      `
        INSERT INTO backend_admin_audit_logs (
          id,
          actor,
          action,
          target_type,
          target_id,
          before_json,
          after_json,
          ip_address,
          user_agent
        )
        VALUES ($1, $2, 'storage.bucket.policy.update', 'storage_bucket', $3, $4::jsonb, $5::jsonb, $6, $7)
      `,
      [
        `audit_${crypto.randomUUID().replace(/-/g, "")}`,
        req.user?.email || req.session?.user?.email || req.auth?.user?.email || "console-user",
        bucketId,
        JSON.stringify(before),
        JSON.stringify(result.rows[0]),
        req.headers["x-forwarded-for"] || req.socket?.remoteAddress || null,
        req.headers["user-agent"] || null,
      ]
    );

    return ok(res, {
      bucket: result.rows[0],
      message: "Bucket policy updated.",
    });
  } catch (error) {
    return fail(res, "Failed to update bucket policy", error.statusCode || 500, error.message);
  }
});


function normalizeWebhookEventsInput(value) {
  if (!Array.isArray(value) || !value.length) return ["*"];

  const events = value
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .slice(0, 100);

  return events.length ? events : ["*"];
}

function normalizeWebhookUrl(value) {
  const url = String(value || "").trim();

  let parsed;

  try {
    parsed = new URL(url);
  } catch {
    const error = new Error("Webhook URL must be a valid URL.");
    error.statusCode = 400;
    throw error;
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    const error = new Error("Webhook URL must start with http:// or https://.");
    error.statusCode = 400;
    throw error;
  }

  return url;
}


router.post("/webhook-deliveries/process-retries-safe", async (req, res) => {
  try {
    const limit = Number(req.body?.limit || 25);
    const result = await processDueWebhookRetries(limit);

    return ok(res, {
      ...result,
      message: "Webhook retry queue processed.",
    });
  } catch (error) {
    return fail(res, "Failed to process webhook retry queue", 500, error.message);
  }
});

router.post("/webhooks/:id/policy/update-safe", async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();

    if (!id) return fail(res, "Webhook id is required", 400);

    const beforeResult = await dbQuery(
      `
        SELECT *
        FROM backend_webhooks
        WHERE id = $1
        LIMIT 1
      `,
      [id]
    );

    const before = beforeResult.rows[0];
    if (!before) return fail(res, "Webhook not found", 404);

    const name = String(req.body?.name || before.name || "").trim();
    const url = normalizeWebhookUrl(req.body?.url || before.url);
    const description = String(req.body?.description || "").trim();
    const events = normalizeWebhookEventsInput(req.body?.events || before.events || ["*"]);
    const status = String(req.body?.status || before.status || "active").trim().toLowerCase();

    if (!name) return fail(res, "Webhook name is required", 400);
    if (!["active", "disabled"].includes(status)) return fail(res, "Status must be active or disabled", 400);

    const deliveryTimeoutSeconds = Math.min(Math.max(Number(req.body?.deliveryTimeoutSeconds ?? before.delivery_timeout_seconds ?? 15), 3), 60);
    const maxRetries = Math.min(Math.max(Number(req.body?.maxRetries ?? before.max_retries ?? 3), 0), 10);
    const retryBackoffSeconds = Math.min(Math.max(Number(req.body?.retryBackoffSeconds ?? before.retry_backoff_seconds ?? 300), 30), 86400);
    const signingAlgorithm = String(req.body?.signingAlgorithm || before.signing_algorithm || "sha256").trim().toLowerCase();

    if (!["sha256"].includes(signingAlgorithm)) {
      return fail(res, "Signing algorithm must be sha256.", 400);
    }

    const result = await dbQuery(
      `
        UPDATE backend_webhooks
        SET
          name = $2,
          url = $3,
          description = $4,
          events = $5::text[],
          status = $6,
          delivery_timeout_seconds = $7,
          max_retries = $8,
          retry_backoff_seconds = $9,
          signing_algorithm = $10,
          updated_at = NOW()
        WHERE id = $1
        RETURNING
          id,
          name,
          url,
          description,
          events,
          status,
          signing_algorithm AS "signingAlgorithm",
          delivery_timeout_seconds AS "deliveryTimeoutSeconds",
          max_retries AS "maxRetries",
          retry_backoff_seconds AS "retryBackoffSeconds",
          failure_count AS "failureCount",
          success_count AS "successCount",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          last_triggered_at AS "lastTriggeredAt"
      `,
      [
        id,
        name,
        url,
        description || null,
        events,
        status,
        deliveryTimeoutSeconds,
        maxRetries,
        retryBackoffSeconds,
        signingAlgorithm,
      ]
    );

    await dbQuery(
      `
        INSERT INTO backend_admin_audit_logs (
          id,
          actor,
          action,
          target_type,
          target_id,
          before_json,
          after_json,
          ip_address,
          user_agent
        )
        VALUES ($1, $2, 'webhook.policy.update', 'webhook', $3, $4::jsonb, $5::jsonb, $6, $7)
      `,
      [
        `audit_${crypto.randomUUID().replace(/-/g, "")}`,
        req.user?.email || req.session?.user?.email || req.auth?.user?.email || "console-user",
        id,
        JSON.stringify(before),
        JSON.stringify(result.rows[0]),
        req.headers["x-forwarded-for"] || req.socket?.remoteAddress || null,
        req.headers["user-agent"] || null,
      ]
    );

    return ok(res, {
      webhook: result.rows[0],
      message: "Webhook policy updated.",
    });
  } catch (error) {
    return fail(res, "Failed to update webhook policy", error.statusCode || 500, error.message);
  }
});

router.post("/webhooks/:id/rotate-secret-safe", async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();

    if (!id) return fail(res, "Webhook id is required", 400);

    const beforeResult = await dbQuery(
      `
        SELECT id, name, url, events, status
        FROM backend_webhooks
        WHERE id = $1
        LIMIT 1
      `,
      [id]
    );

    const before = beforeResult.rows[0];
    if (!before) return fail(res, "Webhook not found", 404);

    const secret = `whsec_${crypto.randomBytes(24).toString("hex")}`;

    const result = await dbQuery(
      `
        UPDATE backend_webhooks
        SET
          secret = $2,
          updated_at = NOW()
        WHERE id = $1
        RETURNING
          id,
          name,
          url,
          events,
          status,
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          last_triggered_at AS "lastTriggeredAt"
      `,
      [id, secret]
    );

    await dbQuery(
      `
        INSERT INTO backend_admin_audit_logs (
          id,
          actor,
          action,
          target_type,
          target_id,
          before_json,
          after_json,
          ip_address,
          user_agent
        )
        VALUES ($1, $2, 'webhook.secret.rotate', 'webhook', $3, $4::jsonb, $5::jsonb, $6, $7)
      `,
      [
        `audit_${crypto.randomUUID().replace(/-/g, "")}`,
        req.user?.email || req.session?.user?.email || req.auth?.user?.email || "console-user",
        id,
        JSON.stringify(before),
        JSON.stringify({ rotated: true }),
        req.headers["x-forwarded-for"] || req.socket?.remoteAddress || null,
        req.headers["user-agent"] || null,
      ]
    );

    return ok(res, {
      webhook: result.rows[0],
      secret,
      warning: "Copy this webhook secret now. It will not be shown again.",
    });
  } catch (error) {
    return fail(res, "Failed to rotate webhook secret", 500, error.message);
  }
});

router.post("/webhook-deliveries/:id/replay-safe", async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();

    if (!id) return fail(res, "Delivery id is required", 400);

    const deliveryResult = await dbQuery(
      `
        SELECT
          d.*,
          w.id AS webhook_id,
          w.name AS webhook_name,
          w.url AS webhook_url,
          w.events AS webhook_events,
          w.secret AS webhook_secret,
          w.status AS webhook_status,
          w.delivery_timeout_seconds,
          w.max_retries,
          w.retry_backoff_seconds
        FROM backend_webhook_deliveries d
        JOIN backend_webhooks w ON w.id = d.webhook_id
        WHERE d.id = $1
        LIMIT 1
      `,
      [id]
    );

    const delivery = deliveryResult.rows[0];

    if (!delivery) return fail(res, "Webhook delivery not found", 404);
    if (delivery.webhook_status !== "active") return fail(res, "Webhook is not active", 400);

    const replayPayload = {
      id: webhookRandomId("evt"),
      type: delivery.event_type || "webhook.replay",
      eventType: delivery.event_type || "webhook.replay",
      replay: true,
      replayedFromDeliveryId: id,
      createdAt: new Date().toISOString(),
      data: {
        originalDeliveryId: id,
        originalEventId: delivery.event_id,
        originalRequestBody: delivery.request_body || {},
      },
    };

    const webhook = {
      id: delivery.webhook_id,
      name: delivery.webhook_name,
      url: delivery.webhook_url,
      events: delivery.webhook_events || ["*"],
      secret: delivery.webhook_secret,
      delivery_timeout_seconds: delivery.delivery_timeout_seconds,
      max_retries: delivery.max_retries,
      retry_backoff_seconds: delivery.retry_backoff_seconds,
    };

    const replayDelivery = await deliverWebhook(webhook, replayPayload);

    await dbQuery(
      `
        UPDATE backend_webhook_deliveries
        SET
          replayed_from_delivery_id = $2,
          replayed_at = NOW(),
          replayed_by = $3
        WHERE id = $1
      `,
      [
        replayDelivery.id,
        id,
        req.user?.email || req.session?.user?.email || req.auth?.user?.email || "console-user",
      ]
    );

    await dbQuery(
      `
        INSERT INTO backend_admin_audit_logs (
          id,
          actor,
          action,
          target_type,
          target_id,
          after_json,
          ip_address,
          user_agent
        )
        VALUES ($1, $2, 'webhook.delivery.replay', 'webhook_delivery', $3, $4::jsonb, $5, $6)
      `,
      [
        `audit_${crypto.randomUUID().replace(/-/g, "")}`,
        req.user?.email || req.session?.user?.email || req.auth?.user?.email || "console-user",
        id,
        JSON.stringify({ replayDeliveryId: replayDelivery.id }),
        req.headers["x-forwarded-for"] || req.socket?.remoteAddress || null,
        req.headers["user-agent"] || null,
      ]
    );

    return ok(res, {
      delivery: replayDelivery,
      message: "Webhook delivery replayed.",
    });
  } catch (error) {
    return fail(res, "Failed to replay webhook delivery", 500, error.message);
  }
});


if (!global.__goodosWebhookRetryWorkerStarted) {
  global.__goodosWebhookRetryWorkerStarted = true;

  const webhookRetryWorker = setInterval(() => {
    if (typeof processDueWebhookRetries === "function") {
      processDueWebhookRetries(25).catch((error) => {
        console.warn("Webhook retry worker failed:", error.message);
      });
    }
  }, Number(process.env.WEBHOOK_RETRY_WORKER_INTERVAL_MS || 60000));

  if (typeof webhookRetryWorker.unref === "function") {
    webhookRetryWorker.unref();
  }
}


function authV2CleanRole(value, fallback = "user") {
  const role = String(value || fallback).trim().toLowerCase();
  if (["owner", "admin", "manager", "developer", "user", "viewer"].includes(role)) return role;
  return fallback;
}

function authV2Hash(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function authV2Token(prefix = "tok") {
  return `${prefix}_${crypto.randomBytes(32).toString("hex")}`;
}

router.get("/auth-v2-page-data", async (req, res) => {
  try {
    const usersResult = await dbQuery(`
      SELECT
        id::text,
        email,
        display_name AS "displayName",
        platform_role AS "platformRole",
        status,
        email_verified AS "emailVerified",
        mfa_enabled AS "mfaEnabled",
        mfa_required AS "mfaRequired",
        failed_login_count AS "failedLoginCount",
        locked_until AS "lockedUntil",
        password_updated_at AS "passwordUpdatedAt",
        last_password_reset_at AS "lastPasswordResetAt",
        last_login_at AS "lastLoginAt",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM users
      ORDER BY created_at DESC
      LIMIT 300
    `);

    const rolesResult = await dbQuery(`
      SELECT id, name, display_name AS "displayName", description, level, status, created_at AS "createdAt", updated_at AS "updatedAt"
      FROM backend_roles
      ORDER BY level ASC, name ASC
    `);

    const permissionsResult = await dbQuery(`
      SELECT id, name, category, description, status, created_at AS "createdAt", updated_at AS "updatedAt"
      FROM backend_permissions
      ORDER BY category ASC, name ASC
    `);

    const userRolesResult = await dbQuery(`
      SELECT
        ur.id,
        ur.user_id::text AS "userId",
        u.email,
        ur.role_id AS "roleId",
        ur.role_name AS "roleName",
        ur.scope_type AS "scopeType",
        ur.scope_id AS "scopeId",
        ur.status,
        ur.assigned_at AS "assignedAt",
        ur.revoked_at AS "revokedAt"
      FROM backend_user_roles ur
      LEFT JOIN users u ON u.id = ur.user_id
      ORDER BY ur.assigned_at DESC
      LIMIT 500
    `);

    const mfaResult = await dbQuery(`
      SELECT
        f.id,
        f.user_id::text AS "userId",
        u.email,
        f.type,
        f.label,
        f.status,
        f.secret_prefix AS "secretPrefix",
        f.verified_at AS "verifiedAt",
        f.last_used_at AS "lastUsedAt",
        f.created_at AS "createdAt",
        f.updated_at AS "updatedAt"
      FROM backend_mfa_factors f
      LEFT JOIN users u ON u.id = f.user_id
      ORDER BY f.created_at DESC
      LIMIT 300
    `);

    const sessionsResult = await dbQuery(`
      SELECT
        s.id,
        s.user_id::text AS "userId",
        u.email,
        u.display_name AS "displayName",
        s.ip_address AS "ipAddress",
        s.user_agent AS "userAgent",
        s.auth_level AS "authLevel",
        s.mfa_verified AS "mfaVerified",
        s.risk_score AS "riskScore",
        s.device_label AS "deviceLabel",
        s.created_at AS "createdAt",
        s.expires_at AS "expiresAt",
        s.revoked_at AS "revokedAt",
        s.last_seen_at AS "lastSeenAt",
        CASE
          WHEN s.revoked_at IS NOT NULL THEN 'revoked'
          WHEN s.expires_at <= NOW() THEN 'expired'
          ELSE 'active'
        END AS status
      FROM sessions s
      LEFT JOIN users u ON u.id = s.user_id
      ORDER BY s.created_at DESC
      LIMIT 300
    `);

    const resetsResult = await dbQuery(`
      SELECT
        r.id,
        r.user_id::text AS "userId",
        u.email,
        r.status,
        r.requested_by AS "requestedBy",
        r.expires_at AS "expiresAt",
        r.used_at AS "usedAt",
        r.created_at AS "createdAt"
      FROM backend_password_reset_tokens r
      LEFT JOIN users u ON u.id = r.user_id
      ORDER BY r.created_at DESC
      LIMIT 300
    `);

    const auditResult = await dbQuery(`
      SELECT
        id,
        user_id::text AS "userId",
        event_type AS "eventType",
        status,
        ip_address AS "ipAddress",
        risk_score AS "riskScore",
        metadata_json AS "metadata",
        created_at AS "createdAt"
      FROM backend_auth_audit_events
      ORDER BY created_at DESC
      LIMIT 300
    `);

    return ok(res, {
      users: usersResult.rows,
      roles: rolesResult.rows,
      permissions: permissionsResult.rows,
      userRoles: userRolesResult.rows,
      mfaFactors: mfaResult.rows,
      sessions: sessionsResult.rows,
      passwordResets: resetsResult.rows,
      auditEvents: auditResult.rows,
      counts: {
        users: usersResult.rows.length,
        activeUsers: usersResult.rows.filter((user) => user.status === "active").length,
        mfaEnabled: usersResult.rows.filter((user) => user.mfaEnabled === true).length,
        roles: rolesResult.rows.length,
        permissions: permissionsResult.rows.length,
        activeSessions: sessionsResult.rows.filter((item) => item.status === "active").length,
        activePasswordResets: resetsResult.rows.filter((item) => item.status === "active").length,
      },
    });
  } catch (error) {
    return fail(res, "Failed to load Auth V2 page data", 500, error.message);
  }
});

router.post("/auth-v2/users/:id/role-safe", async (req, res) => {
  try {
    const userId = String(req.params.id || "").trim();
    const roleName = authV2CleanRole(req.body?.role || req.body?.roleName || req.body?.role_name || "user");
    const scopeType = String(req.body?.scopeType || req.body?.scope_type || "platform").trim();
    const scopeId = String(req.body?.scopeId || req.body?.scope_id || "*").trim() || "*";

    const roleResult = await dbQuery("SELECT * FROM backend_roles WHERE name = $1 AND status = 'active' LIMIT 1", [roleName]);
    const role = roleResult.rows[0];
    if (!role) return fail(res, "Role not found", 404);

    const userResult = await dbQuery("SELECT id, email FROM users WHERE id = $1::uuid LIMIT 1", [userId]);
    const user = userResult.rows[0];
    if (!user) return fail(res, "User not found", 404);

    const result = await dbQuery(
      `
        INSERT INTO backend_user_roles (
          id,
          user_id,
          role_id,
          role_name,
          scope_type,
          scope_id,
          status,
          assigned_by,
          metadata_json,
          organization_id,
          project_id,
          environment_id
        )
        VALUES ($1,$2::uuid,$3,$4,$5,$6,'active',(SELECT id FROM users ORDER BY created_at ASC LIMIT 1),$7::jsonb,'org_goodos','proj_goodos_platform','env_goodos_production')
        ON CONFLICT (user_id, role_id, scope_type, scope_id) DO UPDATE
        SET
          role_name = EXCLUDED.role_name,
          status = 'active',
          revoked_at = NULL,
          updated_at = NOW()
        RETURNING *
      `,
      [
        `userrole_${userId.replace(/-/g, "")}_${roleName}_${scopeType}_${scopeId.replace(/[^a-zA-Z0-9]/g, "_")}`.slice(0, 180),
        userId,
        role.id,
        roleName,
        scopeType,
        scopeId,
        JSON.stringify({ assignedFrom: "Auth V2 Console" }),
      ]
    );

    await dbQuery(
      "UPDATE users SET platform_role = $2, updated_at = NOW() WHERE id = $1::uuid",
      [userId, roleName]
    );

    return ok(res, {
      userRole: result.rows[0],
      message: "Auth V2 role assigned.",
    });
  } catch (error) {
    return fail(res, "Failed to assign Auth V2 role", 500, error.message);
  }
});

router.post("/auth-v2/users/:id/mfa-require-safe", async (req, res) => {
  try {
    const userId = String(req.params.id || "").trim();
    const required = req.body?.required === true || req.body?.required === "true" || req.body?.mfaRequired === true || req.body?.mfa_required === true;

    const result = await dbQuery(
      `
        UPDATE users
        SET mfa_required = $2,
            auth_metadata_json = COALESCE(auth_metadata_json, '{}'::jsonb) || jsonb_build_object('mfaRequiredUpdatedAt', NOW()),
            updated_at = NOW()
        WHERE id = $1::uuid
        RETURNING id::text, email, platform_role AS "platformRole", mfa_enabled AS "mfaEnabled", mfa_required AS "mfaRequired", status
      `,
      [userId, required]
    );

    if (!result.rows[0]) return fail(res, "User not found", 404);

    return ok(res, {
      user: result.rows[0],
      message: required ? "MFA is now required for this user." : "MFA is no longer required for this user.",
    });
  } catch (error) {
    return fail(res, "Failed to update MFA requirement", 500, error.message);
  }
});

router.post("/auth-v2/mfa/factors/:id/status-safe", async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    const status = String(req.body?.status || "disabled").trim().toLowerCase();
    if (!["active", "pending", "disabled", "revoked"].includes(status)) return fail(res, "Invalid MFA factor status", 400);

    const result = await dbQuery(
      `
        UPDATE backend_mfa_factors
        SET status = $2,
            updated_at = NOW()
        WHERE id = $1
        RETURNING id, user_id::text AS "userId", type, label, status, verified_at AS "verifiedAt", last_used_at AS "lastUsedAt"
      `,
      [id, status]
    );

    if (!result.rows[0]) return fail(res, "MFA factor not found", 404);

    await dbQuery(
      `
        UPDATE users
        SET mfa_enabled = EXISTS (
          SELECT 1 FROM backend_mfa_factors
          WHERE user_id = users.id
            AND status = 'active'
        ),
        updated_at = NOW()
        WHERE id = $1::uuid
      `,
      [result.rows[0].userId]
    );

    return ok(res, {
      factor: result.rows[0],
      message: "MFA factor status updated.",
    });
  } catch (error) {
    return fail(res, "Failed to update MFA factor", 500, error.message);
  }
});

router.post("/auth-v2/password-resets/create-safe", async (req, res) => {
  try {
    const userId = String(req.body?.userId || req.body?.user_id || "").trim();
    const userResult = await dbQuery("SELECT id, email FROM users WHERE id = $1::uuid LIMIT 1", [userId]);
    const user = userResult.rows[0];
    if (!user) return fail(res, "User not found", 404);

    const rawToken = authV2Token("reset");
    const tokenId = `reset_${crypto.randomUUID().replace(/-/g, "")}`;

    const result = await dbQuery(
      `
        INSERT INTO backend_password_reset_tokens (
          id,
          user_id,
          token_hash,
          status,
          requested_by,
          expires_at,
          metadata_json,
          organization_id,
          project_id,
          environment_id
        )
        VALUES ($1,$2::uuid,$3,'active',$4,NOW() + INTERVAL '1 hour',$5::jsonb,'org_goodos','proj_goodos_platform','env_goodos_production')
        RETURNING id, user_id::text AS "userId", status, expires_at AS "expiresAt", created_at AS "createdAt"
      `,
      [
        tokenId,
        userId,
        authV2Hash(rawToken),
        req.user?.email || req.session?.user?.email || req.auth?.user?.email || "console-user",
        JSON.stringify({ createdFrom: "Auth V2 Admin", rawTokenReturnedOnce: true }),
      ]
    );

    return ok(res, {
      reset: result.rows[0],
      rawToken,
      resetUrl: `https://base.goodos.app/password-reset/${rawToken}`,
      warning: "Copy this reset token now. It will not be shown again.",
      message: "Password reset token created.",
    });
  } catch (error) {
    return fail(res, "Failed to create password reset token", 500, error.message);
  }
});


// GoodOS live dashboard charts endpoint - additive only, no dashboard replacement
function goodosChartsV28Query(sql, params = []) {
  if (typeof goodosChartsDatabaseV28.query === "function") return goodosChartsDatabaseV28.query(sql, params);
  if (goodosChartsDatabaseV28.pool && typeof goodosChartsDatabaseV28.pool.query === "function") return goodosChartsDatabaseV28.pool.query(sql, params);
  if (typeof goodosChartsDatabaseV28.getPool === "function") return goodosChartsDatabaseV28.getPool().query(sql, params);
  if (goodosChartsDatabaseV28.default && typeof goodosChartsDatabaseV28.default.query === "function") return goodosChartsDatabaseV28.default.query(sql, params);
  throw new Error("Database query function not found");
}

function goodosChartsV28Ident(name) {
  const value = String(name || "");
  if (!/^[a-zA-Z0-9_]+$/.test(value)) throw new Error("Unsafe SQL identifier");
  return value;
}

async function goodosChartsV28TableExists(tableName) {
  const result = await goodosChartsV28Query("SELECT to_regclass($1) AS table_name", [tableName]);
  return Boolean(result.rows[0] && result.rows[0].table_name);
}

async function goodosChartsV28ColumnExists(tableName, columnName) {
  const result = await goodosChartsV28Query(
    `
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = $1
        AND column_name = $2
      LIMIT 1
    `,
    [tableName, columnName]
  );
  return result.rows.length > 0;
}

async function goodosChartsV28FirstTable(tableNames = []) {
  for (const table of tableNames) {
    if (await goodosChartsV28TableExists(table)) return table;
  }
  return null;
}

async function goodosChartsV28Count(tableName, whereSql = "") {
  const table = goodosChartsV28Ident(tableName);
  if (!(await goodosChartsV28TableExists(table))) return 0;
  const result = await goodosChartsV28Query(`SELECT COUNT(*)::int AS count FROM ${table} ${whereSql}`);
  return Number(result.rows[0]?.count || 0);
}

async function goodosChartsV28CountFirst(tableNames = [], whereSql = "") {
  for (const table of tableNames) {
    if (await goodosChartsV28TableExists(table)) return goodosChartsV28Count(table, whereSql);
  }
  return 0;
}

async function goodosChartsV28SumFirst(tableNames = [], columnNames = [], whereSql = "") {
  for (const tableName of tableNames) {
    const table = goodosChartsV28Ident(tableName);
    if (!(await goodosChartsV28TableExists(table))) continue;

    for (const columnName of columnNames) {
      const column = goodosChartsV28Ident(columnName);
      if (!(await goodosChartsV28ColumnExists(table, column))) continue;

      const result = await goodosChartsV28Query(`SELECT COALESCE(SUM(${column}), 0)::numeric AS total FROM ${table} ${whereSql}`);
      return Number(result.rows[0]?.total || 0);
    }
  }

  return 0;
}

async function goodosChartsV28DailyCounts(tableNames = [], preferredColumns = ["created_at"], days = 14) {
  for (const tableName of tableNames) {
    const table = goodosChartsV28Ident(tableName);
    if (!(await goodosChartsV28TableExists(table))) continue;

    for (const columnName of preferredColumns) {
      const column = goodosChartsV28Ident(columnName);
      if (!(await goodosChartsV28ColumnExists(table, column))) continue;

      const result = await goodosChartsV28Query(
        `
          SELECT date_trunc('day', ${column})::date AS day, COUNT(*)::int AS count
          FROM ${table}
          WHERE ${column} >= NOW() - ($1::int || ' days')::interval
          GROUP BY 1
          ORDER BY 1 ASC
        `,
        [days]
      );

      return result.rows || [];
    }
  }

  return [];
}

async function goodosChartsV28StatusBreakdown(tableNames = [], statusColumns = ["status"]) {
  for (const tableName of tableNames) {
    const table = goodosChartsV28Ident(tableName);
    if (!(await goodosChartsV28TableExists(table))) continue;

    for (const columnName of statusColumns) {
      const column = goodosChartsV28Ident(columnName);
      if (!(await goodosChartsV28ColumnExists(table, column))) continue;

      const result = await goodosChartsV28Query(
        `
          SELECT COALESCE(${column}::text, 'unknown') AS label, COUNT(*)::int AS value
          FROM ${table}
          GROUP BY ${column}
          ORDER BY value DESC, label ASC
          LIMIT 12
        `
      );

      return result.rows || [];
    }
  }

  return [];
}

async function goodosChartsV28EnvironmentScoped(tableNames = []) {
  for (const tableName of tableNames) {
    const table = goodosChartsV28Ident(tableName);
    if (!(await goodosChartsV28TableExists(table))) continue;
    if (!(await goodosChartsV28ColumnExists(table, "environment_id"))) return 0;
    return goodosChartsV28Count(table, "WHERE environment_id IS NOT NULL");
  }
  return 0;
}

router.get("/dashboard-live-charts-data", async (req, res) => {
  try {
    const modules = [
      { key: "organizations", label: "Organizations", tables: ["backend_organizations", "organizations"] },
      { key: "projects", label: "Projects", tables: ["backend_projects", "projects"] },
      { key: "environments", label: "Environments", tables: ["backend_project_environments", "project_environments", "environments"] },
      { key: "users", label: "Users", tables: ["users", "backend_users"] },
      { key: "api_keys", label: "API Keys", tables: ["backend_api_keys", "api_keys"] },
      { key: "webhooks", label: "Webhooks", tables: ["backend_webhooks", "webhooks"] },
      { key: "storage", label: "Storage", tables: ["backend_storage_files", "backend_storage_objects", "storage_files"] },
      { key: "functions", label: "Functions", tables: ["backend_edge_functions", "edge_functions"] },
      { key: "realtime", label: "Realtime", tables: ["backend_realtime_channels", "backend_realtime_messages", "backend_realtime_events"] },
      { key: "jobs", label: "Jobs", tables: ["backend_jobs", "backend_job_runs"] },
      { key: "notifications", label: "Notifications", tables: ["backend_notifications", "backend_email_queue"] },
      { key: "billing", label: "Billing", tables: ["backend_billing_plans", "backend_subscriptions", "backend_invoices"] },
      { key: "secrets", label: "Secrets", tables: ["backend_secrets", "backend_secret_vaults", "backend_provider_credentials"] },
      { key: "policies", label: "Policies", tables: ["backend_policy_rules"] },
      { key: "backups", label: "Backups", tables: ["backend_db_backups", "backend_backups", "db_backups"] }
    ];

    const moduleCounts = [];
    const environmentMapping = [];

    for (const item of modules) {
      const table = await goodosChartsV28FirstTable(item.tables);
      const total = table ? await goodosChartsV28Count(table) : 0;
      const scoped = table ? await goodosChartsV28EnvironmentScoped([table]) : 0;

      moduleCounts.push({
        key: item.key,
        label: item.label,
        table,
        value: total
      });

      environmentMapping.push({
        key: item.key,
        label: item.label,
        table,
        total,
        scoped,
        percent: total > 0 ? Math.round((scoped / total) * 100) : 0
      });
    }

    const projectStatus = await goodosChartsV28StatusBreakdown(["backend_projects", "projects"]);
    const environmentStatus = await goodosChartsV28StatusBreakdown(["backend_project_environments", "project_environments", "environments"]);
    const jobStatus = await goodosChartsV28StatusBreakdown(["backend_jobs"]);
    const notificationStatus = await goodosChartsV28StatusBreakdown(["backend_notifications"]);
    const emailQueueStatus = await goodosChartsV28StatusBreakdown(["backend_email_queue"]);
    const providerStatus = await goodosChartsV28StatusBreakdown(["backend_provider_credentials"]);

    const apiDaily = await goodosChartsV28DailyCounts(["backend_api_key_usage_logs", "api_key_usage_logs"], ["created_at"], 14);
    const jobDaily = await goodosChartsV28DailyCounts(["backend_job_runs"], ["created_at", "started_at"], 14);
    const notificationDaily = await goodosChartsV28DailyCounts(["backend_notifications"], ["created_at"], 14);
    const webhookDaily = await goodosChartsV28DailyCounts(["backend_webhook_deliveries", "webhook_deliveries"], ["created_at"], 14);
    const realtimeDaily = await goodosChartsV28DailyCounts(["backend_realtime_messages", "backend_realtime_events"], ["created_at", "sent_at"], 14);

    const summary = {
      apiKeys: await goodosChartsV28CountFirst(["backend_api_keys", "api_keys"]),
      webhooks: await goodosChartsV28CountFirst(["backend_webhooks", "webhooks"]),
      storageFiles: await goodosChartsV28CountFirst(["backend_storage_files", "backend_storage_objects", "storage_files"]),
      storageBytes: await goodosChartsV28SumFirst(["backend_storage_files", "backend_storage_objects", "backend_storage_object_versions"], ["size_bytes", "bytes", "file_size"]),
      functions: await goodosChartsV28CountFirst(["backend_edge_functions", "edge_functions"]),
      realtimeChannels: await goodosChartsV28CountFirst(["backend_realtime_channels"]),
      jobs: await goodosChartsV28CountFirst(["backend_jobs"]),
      notifications: await goodosChartsV28CountFirst(["backend_notifications"]),
      billingPlans: await goodosChartsV28CountFirst(["backend_billing_plans"]),
      subscriptions: await goodosChartsV28CountFirst(["backend_subscriptions"]),
      secrets: await goodosChartsV28CountFirst(["backend_secrets"]),
      providers: await goodosChartsV28CountFirst(["backend_provider_credentials"]),
      policies: await goodosChartsV28CountFirst(["backend_policy_rules"])
    };

    return res.json({
      success: true,
      data: {
        generatedAt: new Date().toISOString(),
        summary,
        charts: {
          moduleCounts,
          environmentMapping,
          projectStatus,
          environmentStatus,
          jobStatus,
          notificationStatus,
          emailQueueStatus,
          providerStatus,
          apiDaily,
          jobDaily,
          notificationDaily,
          webhookDaily,
          realtimeDaily
        }
      }
    });
  } catch (error) {
    console.error("dashboard-live-charts-data failed:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Dashboard live charts data failed"
    });
  }
});



/* GOODOS_RECENT_APPS_LIVE_V1 */

router.get(
  "/recent-apps-page-data",
  async (req, res) => {
    try {
      const userId =
        currentUserId(req);

      if (!userId) {
        return fail(
          res,
          "Authenticated user is required.",
          401
        );
      }

      const data =
        await recentAppsService.getRecentApps({
            userId,
            limit:
              req.query?.limit,
          });

      return ok(
        res,
        data
      );
    } catch (error) {
      if (error.statusCode) {
        return fail(
          res,
          error.message,
          error.statusCode
        );
      }

      console.error(
        "[recent-apps] page-data failed:",
        error
      );

      return fail(
        res,
        "Failed to load recently used applications.",
        500
      );
    }
  }
);

router.post(
  "/recent-apps/:appId/open-safe",
  async (req, res) => {
    try {
      const userId =
        currentUserId(req);

      if (!userId) {
        return fail(
          res,
          "Authenticated user is required.",
          401
        );
      }

      const data =
        await recentAppsService.recordAppOpen({
            userId,
            appId:
              req.params.appId,
          });

      return ok(
        res,
        data
      );
    } catch (error) {
      if (error.statusCode) {
        return fail(
          res,
          error.message,
          error.statusCode
        );
      }

      console.error(
        "[recent-apps] open tracking failed:",
        error
      );

      return fail(
        res,
        "Failed to record application access.",
        500
      );
    }
  }
);

/* END GOODOS_RECENT_APPS_LIVE_V1 */


module.exports = router;
