/* GOODOS_API_ACCESS_LIVE_V1 */

const crypto = require("crypto");

const database =
  require("../config/database");

const {
  logAudit,
} = require("./audit.service");

const READ_ONLY_SCOPES = [
  "read:health",
  "read:apps",
  "read:usage",
  "read:notifications",
  "read:storage",
  "read:db",
  "read:realtime",
  "subscribe:realtime",
];

const AVAILABLE_SCOPES = [
  {
    id: "read:health",
    label: "Read health",
    description:
      "Read public API and platform health.",
    category: "Platform",
  },
  {
    id: "read:apps",
    label: "Read applications",
    description:
      "Read permitted GoodOS application records.",
    category: "Applications",
  },
  {
    id: "read:usage",
    label: "Read usage",
    description:
      "Read API usage and quota information.",
    category: "Platform",
  },
  {
    id: "read:notifications",
    label: "Read notifications",
    description:
      "Read notification records.",
    category: "Notifications",
  },
  {
    id: "write:notifications",
    label: "Write notifications",
    description:
      "Create notification records.",
    category: "Notifications",
  },
  {
    id: "read:storage",
    label: "Read storage",
    description:
      "Read buckets and file metadata.",
    category: "Storage",
  },
  {
    id: "read:db",
    label: "Read published data",
    description:
      "Read permitted published database tables.",
    category: "Database",
  },
  {
    id: "write:db",
    label: "Write published data",
    description:
      "Insert, update, and delete permitted published rows.",
    category: "Database",
  },
  {
    id: "read:realtime",
    label: "Read realtime",
    description:
      "Read realtime channels and events.",
    category: "Realtime",
  },
  {
    id: "publish:realtime",
    label: "Publish realtime",
    description:
      "Publish events to permitted realtime channels.",
    category: "Realtime",
  },
  {
    id: "subscribe:realtime",
    label: "Subscribe realtime",
    description:
      "Subscribe to permitted realtime streams.",
    category: "Realtime",
  },
  {
    id: "execute:functions",
    label: "Execute functions",
    description:
      "Run public callable edge functions.",
    category: "Functions",
  },
];

const AVAILABLE_SCOPE_IDS =
  new Set(
    AVAILABLE_SCOPES.map(
      scope => scope.id
    )
  );

function dbQuery(
  sql,
  params = []
) {
  if (
    typeof database.query ===
    "function"
  ) {
    return database.query(
      sql,
      params
    );
  }

  if (
    database.pool &&
    typeof database.pool.query ===
      "function"
  ) {
    return database.pool.query(
      sql,
      params
    );
  }

  if (
    typeof database.getPool ===
    "function"
  ) {
    return database
      .getPool()
      .query(
        sql,
        params
      );
  }

  throw new Error(
    "Database query function not found"
  );
}

function getPool() {
  if (
    database.pool &&
    typeof database.pool.connect ===
      "function"
  ) {
    return database.pool;
  }

  if (
    typeof database.getPool ===
    "function"
  ) {
    return database.getPool();
  }

  throw new Error(
    "Database connection pool not found"
  );
}

function serviceError(
  message,
  statusCode = 400
) {
  const error =
    new Error(message);

  error.statusCode =
    statusCode;

  return error;
}

function cleanText(
  value,
  maximum = 255
) {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, maximum);
}

function uniqueStrings(
  values
) {
  if (!Array.isArray(values)) {
    return [];
  }

  return [
    ...new Set(
      values
        .map(value =>
          String(value || "")
            .trim()
        )
        .filter(Boolean)
    ),
  ];
}

function hashKey(
  secret
) {
  return crypto
    .createHash("sha256")
    .update(String(secret))
    .digest("hex");
}

function createSecret() {
  return (
    "gos_live_" +
    crypto
      .randomBytes(32)
      .toString("base64url")
  );
}

function createId() {
  return (
    "apikey_" +
    crypto
      .randomUUID()
      .replace(/-/g, "")
  );
}

function effectiveStatus(
  row
) {
  if (
    row.revokedAt ||
    row.status === "revoked"
  ) {
    return "revoked";
  }

  if (
    row.expiresAt &&
    new Date(row.expiresAt) <=
      new Date()
  ) {
    return "expired";
  }

  return row.status || "active";
}

function publicKey(
  row
) {
  return {
    ...row,
    usageThisMonth:
      Number(
        row.usageThisMonth || 0
      ),
    totalUsage:
      Number(
        row.totalUsage || 0
      ),
    effectiveStatus:
      effectiveStatus(row),
  };
}

async function requireManageContext(
  userId
) {
  const result =
    await dbQuery(
      `
        SELECT
          organization.id
            AS "organizationId",

          organization.name
            AS "organizationName",

          membership.role
            AS "organizationRole",

          account.platform_role
            AS "platformRole",

          (
            SELECT project.id

            FROM backend_projects
                 project

            WHERE project.organization_id =
                  organization.id

              AND project.status =
                  'active'

            ORDER BY
              project.created_at

            LIMIT 1
          ) AS "projectId",

          (
            SELECT environment.id

            FROM backend_project_environments
                 environment

            JOIN backend_projects
                 project
              ON project.id =
                 environment.project_id

            WHERE project.organization_id =
                  organization.id

              AND project.status =
                  'active'

              AND environment.status =
                  'active'

            ORDER BY
              environment.created_at

            LIMIT 1
          ) AS "environmentId"

        FROM backend_organization_memberships
             membership

        JOIN backend_organizations
             organization
          ON organization.id =
             membership.organization_id

        JOIN users account
          ON account.id =
             membership.user_id

        WHERE membership.user_id =
              $1::uuid

          AND membership.status =
              'active'

          AND organization.status =
              'active'

          AND account.status =
              'active'

        ORDER BY
          CASE membership.role
            WHEN 'owner' THEN 1
            WHEN 'admin' THEN 2
            ELSE 3
          END

        LIMIT 1
      `,
      [
        userId,
      ]
    );

  const context =
    result.rows[0];

  if (!context) {
    throw serviceError(
      "Active organization membership is required.",
      403
    );
  }

  const permitted =
    [
      "owner",
      "admin",
    ].includes(
      context.organizationRole
    ) ||
    [
      "owner",
      "admin",
    ].includes(
      context.platformRole
    );

  if (!permitted) {
    throw serviceError(
      "Owner or administrator access is required to manage API keys.",
      403
    );
  }

  return context;
}

function normalizeType(
  value
) {
  const type =
    String(value || "")
      .trim()
      .toLowerCase();

  if (
    ![
      "read_only",
      "full_access",
      "custom",
    ].includes(type)
  ) {
    throw serviceError(
      "API key type must be read_only, full_access, or custom."
    );
  }

  return type;
}

function normalizeScopes(
  type,
  values
) {
  if (type === "full_access") {
    return ["*"];
  }

  if (type === "read_only") {
    return [
      ...READ_ONLY_SCOPES,
    ];
  }

  const scopes =
    uniqueStrings(values);

  if (scopes.length === 0) {
    throw serviceError(
      "Select at least one permission scope for a custom key."
    );
  }

  for (const scope of scopes) {
    if (
      !AVAILABLE_SCOPE_IDS.has(
        scope
      )
    ) {
      throw serviceError(
        `Unsupported API scope: ${scope}`
      );
    }
  }

  return scopes;
}

async function normalizeAllowedApps(
  values
) {
  const appIds =
    uniqueStrings(values);

  if (
    appIds.length === 0 ||
    appIds.includes("*")
  ) {
    return ["*"];
  }

  const result =
    await dbQuery(
      `
        SELECT id
        FROM apps
        WHERE id =
              ANY($1::text[])
          AND status = 'active'
      `,
      [
        appIds,
      ]
    );

  if (
    result.rows.length !==
    appIds.length
  ) {
    throw serviceError(
      "One or more selected applications are invalid."
    );
  }

  return appIds;
}

function expirationFromDays(
  value
) {
  if (
    value === null ||
    value === undefined ||
    value === "" ||
    Number(value) === 0
  ) {
    return null;
  }

  const days =
    Number.parseInt(
      String(value),
      10
    );

  if (
    ![
      7,
      30,
      60,
      90,
      180,
      365,
    ].includes(days)
  ) {
    throw serviceError(
      "Expiration must be 7, 30, 60, 90, 180, or 365 days."
    );
  }

  return new Date(
    Date.now() +
      days *
        24 *
        60 *
        60 *
        1000
  );
}

function normalizeExpiresAt(
  value
) {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return null;
  }

  const date =
    new Date(value);

  if (
    Number.isNaN(
      date.getTime()
    )
  ) {
    throw serviceError(
      "Expiration date is invalid."
    );
  }

  if (
    date <= new Date()
  ) {
    throw serviceError(
      "Expiration must be in the future."
    );
  }

  return date;
}

async function findManagedKey(
  organizationId,
  keyId,
  client = null
) {
  const runner =
    client || {
      query: dbQuery,
    };

  const result =
    await runner.query(
      `
        SELECT
          id,
          name,
          description,
          type,
          key_prefix
            AS "keyPrefix",
          status,
          scopes,
          allowed_app_ids
            AS "allowedAppIds",
          expires_at
            AS "expiresAt",
          revoked_at
            AS "revokedAt",
          organization_id
            AS "organizationId",
          project_id
            AS "projectId",
          environment_id
            AS "environmentId",
          metadata_json
            AS metadata

        FROM backend_api_keys

        WHERE id = $1

          AND COALESCE(
            organization_id,
            'org_goodos'
          ) = $2

        LIMIT 1
      `,
      [
        keyId,
        organizationId,
      ]
    );

  if (!result.rows[0]) {
    throw serviceError(
      "API key was not found.",
      404
    );
  }

  return result.rows[0];
}

async function getOverviewForUser(
  userId
) {
  const context =
    await requireManageContext(
      userId
    );

  const [
    keysResult,
    appsResult,
    usageResult,
    auditResult,
  ] = await Promise.all([
    dbQuery(
      `
        SELECT
          key_record.id,
          key_record.name,
          key_record.description,
          key_record.type,

          key_record.key_prefix
            AS "keyPrefix",

          key_record.status,
          key_record.scopes,

          key_record.allowed_app_ids
            AS "allowedAppIds",

          key_record.created_by
            AS "createdBy",

          creator.display_name
            AS "createdByName",

          creator.email
            AS "createdByEmail",

          key_record.created_at
            AS "createdAt",

          key_record.updated_at
            AS "updatedAt",

          key_record.last_used_at
            AS "lastUsedAt",

          key_record.revoked_at
            AS "revokedAt",

          key_record.expires_at
            AS "expiresAt",

          key_record.rotated_from_key_id
            AS "rotatedFromKeyId",

          key_record.last_rotated_at
            AS "lastRotatedAt",

          key_record.organization_id
            AS "organizationId",

          key_record.project_id
            AS "projectId",

          key_record.environment_id
            AS "environmentId",

          COALESCE(
            usage_month.calls,
            0
          )::int
            AS "usageThisMonth",

          COALESCE(
            usage_total.calls,
            0
          )::int
            AS "totalUsage"

        FROM backend_api_keys
             key_record

        LEFT JOIN users creator
          ON creator.id =
             key_record.created_by

        LEFT JOIN LATERAL (
          SELECT COUNT(*) AS calls

          FROM backend_api_key_usage_logs
               usage_log

          WHERE usage_log.api_key_id =
                key_record.id

            AND usage_log.created_at >=
                DATE_TRUNC(
                  'month',
                  NOW()
                )
        ) usage_month
          ON TRUE

        LEFT JOIN LATERAL (
          SELECT COUNT(*) AS calls

          FROM backend_api_key_usage_logs
               usage_log

          WHERE usage_log.api_key_id =
                key_record.id
        ) usage_total
          ON TRUE

        WHERE COALESCE(
          key_record.organization_id,
          'org_goodos'
        ) = $1

        ORDER BY
          key_record.created_at DESC
      `,
      [
        context.organizationId,
      ]
    ),

    dbQuery(
      `
        SELECT
          id,
          name,
          domain,
          status

        FROM apps

        WHERE status = 'active'

        ORDER BY name
      `
    ),

    dbQuery(
      `
        SELECT
          usage_log.id,

          usage_log.api_key_id
            AS "apiKeyId",

          key_record.name
            AS "apiKeyName",

          usage_log.api_key_prefix
            AS "apiKeyPrefix",

          usage_log.metric_key
            AS "metricKey",

          usage_log.route,
          usage_log.method,

          usage_log.status_code
            AS "statusCode",

          usage_log.scope,
          usage_log.quantity,

          usage_log.ip_address
            AS "ipAddress",

          usage_log.created_at
            AS "createdAt"

        FROM backend_api_key_usage_logs
             usage_log

        JOIN backend_api_keys
             key_record
          ON key_record.id =
             usage_log.api_key_id

        WHERE COALESCE(
          key_record.organization_id,
          'org_goodos'
        ) = $1

        ORDER BY
          usage_log.created_at DESC

        LIMIT 100
      `,
      [
        context.organizationId,
      ]
    ),

    dbQuery(
      `
        SELECT
          audit.id::text
            AS id,

          audit.action,

          audit.entity_type
            AS "entityType",

          audit.entity_id::text
            AS "entityId",

          audit.ip_address::text
            AS "ipAddress",

          audit.metadata,

          audit.created_at
            AS "createdAt",

          COALESCE(
            actor.display_name,
            actor.email,
            'System'
          ) AS actor

        FROM audit_logs audit

        LEFT JOIN users actor
          ON actor.id =
             audit.user_id

        WHERE audit.action LIKE
              'api_key.%'

          AND (
            audit.metadata
                  ->> 'organizationId'
                = $1

            OR audit.entity_id IN (
              SELECT id
              FROM backend_api_keys
              WHERE COALESCE(
                organization_id,
                'org_goodos'
              ) = $1
            )
          )

        ORDER BY
          audit.created_at DESC

        LIMIT 100
      `,
      [
        context.organizationId,
      ]
    ),
  ]);

  const keys =
    keysResult.rows.map(
      publicKey
    );

  return {
    organization: {
      id:
        context.organizationId,
      name:
        context.organizationName,
      role:
        context.organizationRole,
    },

    keys,

    applications:
      appsResult.rows,

    availableScopes:
      AVAILABLE_SCOPES,

    recentUsage:
      usageResult.rows,

    auditLogs:
      auditResult.rows,

    stats: {
      total:
        keys.length,

      active:
        keys.filter(
          key =>
            key.effectiveStatus ===
            "active"
        ).length,

      revoked:
        keys.filter(
          key =>
            key.effectiveStatus ===
            "revoked"
        ).length,

      expired:
        keys.filter(
          key =>
            key.effectiveStatus ===
            "expired"
        ).length,

      callsThisMonth:
        keys.reduce(
          (
            total,
            key
          ) =>
            total +
            key.usageThisMonth,
          0
        ),
    },

    publicApiBaseUrl:
      "https://base.goodos.app/api/v1",

    documentation: {
      developer:
        "https://base.goodos.app/docs",
      api:
        "https://base.goodos.app/api-docs",
      openApi:
        "https://base.goodos.app/openapi.json",
      sdk:
        "https://base.goodos.app/sdk/goodbase.js",
      postman:
        "https://base.goodos.app/postman/goodos-postman-collection.json",
    },
  };
}

async function createKeyForUser(
  userId,
  input = {},
  requestMeta = {}
) {
  const context =
    await requireManageContext(
      userId
    );

  const name =
    cleanText(
      input.name,
      100
    );

  if (name.length < 3) {
    throw serviceError(
      "API key name must contain at least three characters."
    );
  }

  const description =
    cleanText(
      input.description,
      500
    ) || null;

  const type =
    normalizeType(
      input.type ||
      "read_only"
    );

  const scopes =
    normalizeScopes(
      type,
      input.scopes
    );

  const allowedAppIds =
    await normalizeAllowedApps(
      input.allowedAppIds
    );

  const expiresAt =
    expirationFromDays(
      input.expirationDays
    );

  const activeResult =
    await dbQuery(
      `
        SELECT COUNT(*)::int
          AS count

        FROM backend_api_keys

        WHERE COALESCE(
          organization_id,
          'org_goodos'
        ) = $1

          AND status = 'active'

          AND revoked_at IS NULL

          AND (
            expires_at IS NULL
            OR expires_at > NOW()
          )
      `,
      [
        context.organizationId,
      ]
    );

  if (
    Number(
      activeResult.rows[0]
        ?.count || 0
    ) >= 100
  ) {
    throw serviceError(
      "This workspace has reached the maximum of 100 active API keys.",
      409
    );
  }

  const id =
    createId();

  const secret =
    createSecret();

  const keyPrefix =
    secret.slice(0, 18);

  const result =
    await dbQuery(
      `
        INSERT INTO backend_api_keys (
          id,
          name,
          description,
          type,
          key_prefix,
          key_hash,
          status,
          scopes,
          allowed_app_ids,
          expires_at,
          created_by,
          organization_id,
          project_id,
          environment_id,
          metadata_json,
          updated_at
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          'active',
          $7::text[],
          $8::text[],
          $9,
          $10::uuid,
          $11,
          $12,
          $13,
          $14::jsonb,
          NOW()
        )

        RETURNING
          id,
          name,
          description,
          type,

          key_prefix
            AS "keyPrefix",

          status,
          scopes,

          allowed_app_ids
            AS "allowedAppIds",

          expires_at
            AS "expiresAt",

          created_at
            AS "createdAt",

          updated_at
            AS "updatedAt"
      `,
      [
        id,
        name,
        description,
        type,
        keyPrefix,
        hashKey(secret),
        scopes,
        allowedAppIds,
        expiresAt,
        userId,
        context.organizationId,
        context.projectId,
        context.environmentId,
        JSON.stringify({
          source:
            "goodos_api_access_v1",
          revealOnce: true,
        }),
      ]
    );

  await logAudit({
    userId,
    appId: "goodos",
    action:
      "api_key.created",
    entityType:
      "api_key",
    entityId: id,
    ipAddress:
      requestMeta.ipAddress ||
      null,
    metadata: {
      organizationId:
        context.organizationId,
      name,
      type,
      scopes,
      allowedAppIds,
      expiresAt,
    },
  });

  return {
    apiKey:
      publicKey(
        result.rows[0]
      ),
    secret,
  };
}

async function updateKeyForUser(
  userId,
  keyId,
  input = {},
  requestMeta = {}
) {
  const context =
    await requireManageContext(
      userId
    );

  const current =
    await findManagedKey(
      context.organizationId,
      keyId
    );

  if (
    effectiveStatus(current) !==
    "active"
  ) {
    throw serviceError(
      "Only active API keys can be edited.",
      409
    );
  }

  const name =
    input.name === undefined
      ? current.name
      : cleanText(
          input.name,
          100
        );

  if (name.length < 3) {
    throw serviceError(
      "API key name must contain at least three characters."
    );
  }

  const description =
    input.description ===
    undefined
      ? current.description
      : cleanText(
          input.description,
          500
        ) || null;

  const type =
    input.type === undefined
      ? current.type
      : normalizeType(
          input.type
        );

  const scopes =
    input.type === undefined &&
    input.scopes === undefined
      ? current.scopes
      : normalizeScopes(
          type,
          input.scopes
        );

  const allowedAppIds =
    input.allowedAppIds ===
    undefined
      ? current.allowedAppIds
      : await normalizeAllowedApps(
          input.allowedAppIds
        );

  const expiresAt =
    input.expiresAt === undefined
      ? current.expiresAt
      : normalizeExpiresAt(
          input.expiresAt
        );

  const result =
    await dbQuery(
      `
        UPDATE backend_api_keys

        SET
          name = $3,
          description = $4,
          type = $5,
          scopes = $6::text[],
          allowed_app_ids =
            $7::text[],
          expires_at = $8,
          updated_at = NOW()

        WHERE id = $1

          AND COALESCE(
            organization_id,
            'org_goodos'
          ) = $2

        RETURNING
          id,
          name,
          description,
          type,

          key_prefix
            AS "keyPrefix",

          status,
          scopes,

          allowed_app_ids
            AS "allowedAppIds",

          created_at
            AS "createdAt",

          updated_at
            AS "updatedAt",

          last_used_at
            AS "lastUsedAt",

          revoked_at
            AS "revokedAt",

          expires_at
            AS "expiresAt"
      `,
      [
        keyId,
        context.organizationId,
        name,
        description,
        type,
        scopes,
        allowedAppIds,
        expiresAt,
      ]
    );

  await logAudit({
    userId,
    appId: "goodos",
    action:
      "api_key.updated",
    entityType:
      "api_key",
    entityId: keyId,
    ipAddress:
      requestMeta.ipAddress ||
      null,
    metadata: {
      organizationId:
        context.organizationId,
      name,
      type,
      scopes,
      allowedAppIds,
      expiresAt,
    },
  });

  return publicKey(
    result.rows[0]
  );
}

async function revokeKeyForUser(
  userId,
  keyId,
  requestMeta = {}
) {
  const context =
    await requireManageContext(
      userId
    );

  const result =
    await dbQuery(
      `
        UPDATE backend_api_keys

        SET
          status = 'revoked',
          revoked_at = NOW(),
          updated_at = NOW()

        WHERE id = $1

          AND COALESCE(
            organization_id,
            'org_goodos'
          ) = $2

          AND status = 'active'

          AND revoked_at IS NULL

        RETURNING
          id,
          name,
          key_prefix
            AS "keyPrefix",
          status,
          revoked_at
            AS "revokedAt"
      `,
      [
        keyId,
        context.organizationId,
      ]
    );

  if (!result.rows[0]) {
    throw serviceError(
      "Active API key was not found.",
      404
    );
  }

  await logAudit({
    userId,
    appId: "goodos",
    action:
      "api_key.revoked",
    entityType:
      "api_key",
    entityId: keyId,
    ipAddress:
      requestMeta.ipAddress ||
      null,
    metadata: {
      organizationId:
        context.organizationId,
      name:
        result.rows[0].name,
    },
  });

  return publicKey(
    result.rows[0]
  );
}

async function deleteRevokedKeyForUser(
  userId,
  keyId,
  requestMeta = {}
) {
  const context =
    await requireManageContext(
      userId
    );

  const current =
    await findManagedKey(
      context.organizationId,
      keyId
    );

  if (
    effectiveStatus(current) !==
    "revoked"
  ) {
    throw serviceError(
      "Only a revoked API key can be permanently deleted.",
      409
    );
  }

  const result =
    await dbQuery(
      `
        DELETE FROM backend_api_keys

        WHERE id = $1

          AND COALESCE(
            organization_id,
            'org_goodos'
          ) = $2

          AND (
            status = 'revoked'
            OR revoked_at IS NOT NULL
          )

        RETURNING
          id,
          name,
          key_prefix AS "keyPrefix"
      `,
      [
        keyId,
        context.organizationId,
      ]
    );

  if (!result.rows[0]) {
    throw serviceError(
      "Revoked API key was not found.",
      404
    );
  }

  await logAudit({
    userId,
    appId: "goodos",
    action:
      "api_key.deleted",
    entityType:
      "api_key",
    entityId: keyId,
    ipAddress:
      requestMeta.ipAddress ||
      null,
    metadata: {
      organizationId:
        context.organizationId,
      name:
        result.rows[0].name,
      keyPrefix:
        result.rows[0].keyPrefix,
      previousStatus:
        "revoked",
    },
  });

  return {
    id: result.rows[0].id,
    name: result.rows[0].name,
  };
}

async function rotateKeyForUser(
  userId,
  keyId,
  requestMeta = {}
) {
  const context =
    await requireManageContext(
      userId
    );

  const pool =
    getPool();

  const client =
    await pool.connect();

  const newId =
    createId();

  const secret =
    createSecret();

  const keyPrefix =
    secret.slice(0, 18);

  let original;
  let created;

  try {
    await client.query(
      "BEGIN"
    );

    original =
      await findManagedKey(
        context.organizationId,
        keyId,
        client
      );

    if (
      effectiveStatus(original) !==
      "active"
    ) {
      throw serviceError(
        "Only an active API key can be rotated.",
        409
      );
    }

    const result =
      await client.query(
        `
          INSERT INTO backend_api_keys (
            id,
            name,
            description,
            type,
            key_prefix,
            key_hash,
            status,
            scopes,
            allowed_app_ids,
            expires_at,
            created_by,
            organization_id,
            project_id,
            environment_id,
            metadata_json,
            rotated_from_key_id,
            last_rotated_at,
            updated_at
          )
          VALUES (
            $1,
            $2,
            $3,
            $4,
            $5,
            $6,
            'active',
            $7::text[],
            $8::text[],
            $9,
            $10::uuid,
            $11,
            $12,
            $13,
            $14::jsonb,
            $15,
            NOW(),
            NOW()
          )

          RETURNING
            id,
            name,
            description,
            type,

            key_prefix
              AS "keyPrefix",

            status,
            scopes,

            allowed_app_ids
              AS "allowedAppIds",

            expires_at
              AS "expiresAt",

            created_at
              AS "createdAt",

            updated_at
              AS "updatedAt",

            rotated_from_key_id
              AS "rotatedFromKeyId"
        `,
        [
          newId,
          original.name,
          original.description,
          original.type,
          keyPrefix,
          hashKey(secret),
          original.scopes,
          original.allowedAppIds,
          original.expiresAt,
          userId,
          context.organizationId,
          original.projectId ||
            context.projectId,
          original.environmentId ||
            context.environmentId,
          JSON.stringify({
            source:
              "goodos_api_access_rotation_v1",
            revealOnce: true,
          }),
          original.id,
        ]
      );

    created =
      result.rows[0];

    await client.query(
      `
        UPDATE backend_api_keys

        SET
          status = 'revoked',
          revoked_at = NOW(),
          last_rotated_at = NOW(),
          metadata_json =
            COALESCE(
              metadata_json,
              '{}'::jsonb
            ) ||
            jsonb_build_object(
              'rotatedToKeyId',
              $3
            ),
          updated_at = NOW()

        WHERE id = $1

          AND COALESCE(
            organization_id,
            'org_goodos'
          ) = $2
      `,
      [
        keyId,
        context.organizationId,
        newId,
      ]
    );

    await client.query(
      "COMMIT"
    );
  } catch (error) {
    await client.query(
      "ROLLBACK"
    );

    throw error;
  } finally {
    client.release();
  }

  await logAudit({
    userId,
    appId: "goodos",
    action:
      "api_key.rotated",
    entityType:
      "api_key",
    entityId: newId,
    ipAddress:
      requestMeta.ipAddress ||
      null,
    metadata: {
      organizationId:
        context.organizationId,
      previousKeyId: keyId,
      newKeyId: newId,
      name:
        original.name,
    },
  });

  return {
    apiKey:
      publicKey(created),
    secret,
    previousKeyId: keyId,
  };
}

module.exports = {
  getOverviewForUser,
  createKeyForUser,
  updateKeyForUser,
  revokeKeyForUser,
  deleteRevokedKeyForUser,
  rotateKeyForUser,
};
