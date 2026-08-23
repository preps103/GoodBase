/* GOODOS_ROLES_CONSOLE_V1 */

const crypto = require("crypto");

const database =
  require("../config/database");

const {
  logAudit,
} = require("./audit.service");

const SYSTEM_ROLE_IDS = new Set([
  "role_owner",
  "role_admin",
  "role_manager",
  "role_developer",
  "role_user",
  "role_viewer",
]);

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

function idValue(
  prefix
) {
  return (
    `${prefix}_` +
    crypto
      .randomUUID()
      .replace(/-/g, "")
  );
}

function cleanText(
  value,
  maximum = 255
) {
  return String(
    value ?? ""
  )
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
          cleanText(value, 200)
        )
        .filter(Boolean)
    ),
  ];
}

function roleSlug(
  value
) {
  return cleanText(
    value,
    100
  )
    .toLowerCase()
    .replace(
      /[^a-z0-9]+/g,
      "_"
    )
    .replace(
      /^_+|_+$/g,
      ""
    )
    .slice(0, 60);
}

function isSystemRole(
  roleId
) {
  return SYSTEM_ROLE_IDS.has(
    roleId
  );
}

async function requireContext(
  userId,
  requireManage = false
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
            AS "platformRole"

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
            WHEN 'manager' THEN 3
            ELSE 4
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

  const canManage =
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

  if (
    requireManage &&
    !canManage
  ) {
    throw serviceError(
      "Owner or administrator access is required.",
      403
    );
  }

  return {
    ...context,
    canManage,
  };
}

async function validatePermissions(
  permissionIds
) {
  const ids =
    uniqueStrings(
      permissionIds
    );

  if (ids.length === 0) {
    return [];
  }

  const result =
    await dbQuery(
      `
        SELECT id
        FROM backend_permissions

        WHERE id =
              ANY($1::text[])

          AND status =
              'active'
      `,
      [
        ids,
      ]
    );

  if (
    result.rows.length !==
    ids.length
  ) {
    throw serviceError(
      "One or more selected permissions are invalid."
    );
  }

  return ids;
}

async function getRole(
  organizationId,
  roleId,
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

          display_name
            AS "displayName",

          description,
          level,
          status,

          organization_id
            AS "organizationId",

          created_by
            AS "createdBy",

          created_at
            AS "createdAt",

          updated_at
            AS "updatedAt"

        FROM backend_roles

        WHERE id = $1

          AND (
            organization_id = $2
            OR organization_id IS NULL
          )

        LIMIT 1
      `,
      [
        roleId,
        organizationId,
      ]
    );

  if (!result.rows[0]) {
    throw serviceError(
      "Role was not found.",
      404
    );
  }

  return {
    ...result.rows[0],
    isSystem:
      isSystemRole(
        result.rows[0].id
      ),
  };
}

async function replaceRolePermissions(
  client,
  roleId,
  permissionIds
) {
  await client.query(
    `
      DELETE FROM
        backend_role_permissions

      WHERE role_id = $1
    `,
    [
      roleId,
    ]
  );

  for (
    const permissionId
    of permissionIds
  ) {
    await client.query(
      `
        INSERT INTO
          backend_role_permissions (
            id,
            role_id,
            permission_id,
            status,
            created_at
          )
        VALUES (
          $1,
          $2,
          $3,
          'active',
          NOW()
        )
      `,
      [
        idValue("roleperm"),
        roleId,
        permissionId,
      ]
    );
  }
}

async function getOverviewForUser(
  userId
) {
  const context =
    await requireContext(
      userId
    );

  const [
    rolesResult,
    permissionsResult,
    usersResult,
    assignmentsResult,
    requestsResult,
    settingsResult,
    auditResult,
    teamsResult,
    appsResult,
    appMembershipsResult,
  ] = await Promise.all([
    dbQuery(
      `
        SELECT
          role.id,
          role.name,

          role.display_name
            AS "displayName",

          role.description,
          role.level,
          role.status,

          role.organization_id
            AS "organizationId",

          role.created_by
            AS "createdBy",

          role.created_at
            AS "createdAt",

          role.updated_at
            AS "updatedAt",

          COALESCE(
            ARRAY_AGG(
              DISTINCT permission.id
            ) FILTER (
              WHERE permission.id
                    IS NOT NULL

                AND role_permission.status =
                    'active'

                AND permission.status =
                    'active'
            ),
            ARRAY[]::text[]
          ) AS "permissionIds",

          COUNT(
            DISTINCT assignment.user_id
          ) FILTER (
            WHERE assignment.status =
                  'active'

              AND assignment.revoked_at
                  IS NULL
          )::int AS "assignedUsers"

        FROM backend_roles role

        LEFT JOIN backend_role_permissions
                  role_permission
          ON role_permission.role_id =
             role.id

        LEFT JOIN backend_permissions
                  permission
          ON permission.id =
             role_permission.permission_id

        LEFT JOIN backend_user_roles
                  assignment
          ON assignment.role_id =
             role.id

         AND assignment.status =
             'active'

         AND assignment.revoked_at
             IS NULL

        WHERE (
          role.organization_id = $1
          OR role.organization_id IS NULL
        )

        GROUP BY
          role.id,
          role.name,
          role.display_name,
          role.description,
          role.level,
          role.status,
          role.organization_id,
          role.created_by,
          role.created_at,
          role.updated_at

        ORDER BY
          role.level DESC,
          role.display_name
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
          category,
          description,
          status,

          INITCAP(
            REPLACE(
              REPLACE(
                name,
                ':',
                ' '
              ),
              '_',
              ' '
            )
          ) AS "displayName"

        FROM backend_permissions

        WHERE status = 'active'

        ORDER BY
          category,
          name
      `
    ),

    dbQuery(
      `
        SELECT
          account.id,
          account.email,

          account.display_name
            AS "displayName",

          account.first_name
            AS "firstName",

          account.last_name
            AS "lastName",

          account.status,

          membership.role
            AS "organizationRole"

        FROM backend_organization_memberships
             membership

        JOIN users account
          ON account.id =
             membership.user_id

        WHERE membership.organization_id =
              $1

          AND membership.status =
              'active'

          AND account.status =
              'active'

        ORDER BY
          COALESCE(
            account.display_name,
            account.email
          )
      `,
      [
        context.organizationId,
      ]
    ),

    dbQuery(
      `
        SELECT
          assignment.id,

          assignment.user_id
            AS "userId",

          account.email,

          account.display_name
            AS "displayName",

          assignment.role_id
            AS "roleId",

          role.display_name
            AS "roleDisplayName",

          role.name
            AS "roleName",

          assignment.scope_type
            AS "scopeType",

          assignment.scope_id
            AS "scopeId",

          assignment.status,

          assignment.assigned_by
            AS "assignedBy",

          assignment.assigned_at
            AS "assignedAt",

          assignment.revoked_at
            AS "revokedAt"

        FROM backend_user_roles
             assignment

        JOIN users account
          ON account.id =
             assignment.user_id

        JOIN backend_roles role
          ON role.id =
             assignment.role_id

        WHERE COALESCE(
          assignment.organization_id,
          $1
        ) = $1

          AND assignment.status =
              'active'

          AND assignment.revoked_at
              IS NULL

        ORDER BY
          assignment.assigned_at DESC
      `,
      [
        context.organizationId,
      ]
    ),

    dbQuery(
      `
        SELECT
          request.id,

          request.requester_user_id
            AS "requesterUserId",

          requester.email
            AS "requesterEmail",

          requester.display_name
            AS "requesterName",

          request.requested_role_id
            AS "requestedRoleId",

          role.display_name
            AS "requestedRoleName",

          request.scope_type
            AS "scopeType",

          request.scope_id
            AS "scopeId",

          request.reason,
          request.status,

          request.reviewed_by
            AS "reviewedBy",

          reviewer.display_name
            AS "reviewedByName",

          request.reviewed_at
            AS "reviewedAt",

          request.decision_note
            AS "decisionNote",

          request.created_at
            AS "createdAt",

          request.updated_at
            AS "updatedAt"

        FROM backend_access_requests
             request

        JOIN users requester
          ON requester.id =
             request.requester_user_id

        JOIN backend_roles role
          ON role.id =
             request.requested_role_id

        LEFT JOIN users reviewer
          ON reviewer.id =
             request.reviewed_by

        WHERE request.organization_id =
              $1

        ORDER BY
          CASE request.status
            WHEN 'pending' THEN 1
            ELSE 2
          END,
          request.created_at DESC

        LIMIT 200
      `,
      [
        context.organizationId,
      ]
    ),

    dbQuery(
      `
        SELECT
          settings.organization_id
            AS "organizationId",

          settings.default_role_id
            AS "defaultRoleId",

          settings.allow_self_service_requests
            AS "allowSelfServiceRequests",

          settings.require_request_reason
            AS "requireRequestReason",

          settings.created_at
            AS "createdAt",

          settings.updated_at
            AS "updatedAt"

        FROM backend_role_settings
             settings

        WHERE settings.organization_id =
              $1

        LIMIT 1
      `,
      [
        context.organizationId,
      ]
    ),

    dbQuery(
      `
        SELECT
          audit.id::text AS id,
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

        WHERE (
          audit.action LIKE
            'role.%'

          OR audit.action LIKE
            'access_request.%'
        )

        AND (
          audit.metadata
                ->> 'organizationId'
              = $1

          OR audit.entity_id IN (
            SELECT id
            FROM backend_roles
            WHERE organization_id = $1
          )

          OR audit.entity_id IN (
            SELECT id
            FROM backend_access_requests
            WHERE organization_id = $1
          )
        )

        ORDER BY
          audit.created_at DESC

        LIMIT 200
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
          status

        FROM backend_teams

        WHERE organization_id = $1
          AND status = 'active'

        ORDER BY name
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
          membership.id::text,
          membership.user_id::text
            AS "userId",
          membership.app_id
            AS "appId",
          membership.role,
          membership.status,
          membership.updated_at
            AS "updatedAt"

        FROM app_memberships membership

        JOIN backend_organization_memberships
             organization_membership
          ON organization_membership.user_id =
             membership.user_id

         AND organization_membership.organization_id =
             $1

         AND organization_membership.status =
             'active'

        JOIN apps application
          ON application.id =
             membership.app_id

         AND application.status =
             'active'

        ORDER BY
          membership.user_id,
          application.name
      `,
      [
        context.organizationId,
      ]
    ),
  ]);

  const roles =
    rolesResult.rows.map(
      role => ({
        ...role,
        isSystem:
          isSystemRole(
            role.id
          ),
      })
    );

  const assignments =
    assignmentsResult.rows;

  const assignedUsers =
    new Set(
      assignments.map(
        assignment =>
          assignment.userId
      )
    ).size;

  const pendingRequests =
    requestsResult.rows.filter(
      request =>
        request.status ===
        "pending"
    ).length;

  return {
    organization: {
      id:
        context.organizationId,
      name:
        context.organizationName,
      role:
        context.organizationRole,
    },

    canManage:
      context.canManage,

    roles,
    permissions:
      permissionsResult.rows,

    users:
      usersResult.rows,

    assignments,

    accessRequests:
      requestsResult.rows,

    settings:
      settingsResult.rows[0] || {
        organizationId:
          context.organizationId,
        defaultRoleId: null,
        allowSelfServiceRequests: true,
        requireRequestReason: true,
        createdAt: null,
        updatedAt: null,
      },

    auditLogs:
      auditResult.rows,

    teams:
      teamsResult.rows,

    applications:
      appsResult.rows,

    appMemberships:
      appMembershipsResult.rows,

    stats: {
      totalRoles:
        roles.length,

      activeRoles:
        roles.filter(
          role =>
            role.status ===
            "active"
        ).length,

      customRoles:
        roles.filter(
          role =>
            !role.isSystem
        ).length,

      permissions:
        permissionsResult.rows.length,

      assignedUsers,

      activeAssignments:
        assignments.length,

      pendingRequests,
    },
  };
}

async function replaceApplicationAccessForUser(
  userId,
  targetUserId,
  input = {},
  requestMeta = {}
) {
  const context =
    await requireContext(
      userId,
      true
    );

  const targetId =
    cleanText(
      targetUserId,
      100
    );

  const targetResult =
    await dbQuery(
      `
        SELECT account.id
        FROM users account
        JOIN backend_organization_memberships membership
          ON membership.user_id = account.id
        WHERE account.id = $1::uuid
          AND membership.organization_id = $2
          AND membership.status = 'active'
          AND account.status = 'active'
        LIMIT 1
      `,
      [
        targetId,
        context.organizationId,
      ]
    );

  if (!targetResult.rows[0]) {
    throw serviceError(
      "Active organization user was not found.",
      404
    );
  }

  const requestedIds =
    uniqueStrings(
      input.appIds
    );

  const appResult =
    await dbQuery(
      `
        SELECT id
        FROM apps
        WHERE status = 'active'
        ORDER BY id
      `
    );

  const activeIds =
    appResult.rows.map(
      (app) => app.id
    );

  const activeIdSet =
    new Set(activeIds);

  if (
    requestedIds.some(
      (appId) =>
        !activeIdSet.has(appId)
    )
  ) {
    throw serviceError(
      "One or more selected applications are invalid."
    );
  }

  if (
    targetId === userId &&
    activeIdSet.has("goodos") &&
    !requestedIds.includes("goodos")
  ) {
    requestedIds.push("goodos");
  }

  const role =
    [
      "admin",
      "manager",
      "member",
      "viewer",
    ].includes(
      cleanText(
        input.role || "member",
        30
      ).toLowerCase()
    )
      ? cleanText(
          input.role || "member",
          30
        ).toLowerCase()
      : "member";

  const pool = getPool();
  const client =
    await pool.connect();

  try {
    await client.query("BEGIN");

    await client.query(
      `
        UPDATE app_memberships
        SET status = 'revoked',
            updated_at = NOW()
        WHERE user_id = $1::uuid
          AND app_id = ANY($2::text[])
          AND NOT (
            app_id = ANY($3::text[])
          )
      `,
      [
        targetId,
        activeIds,
        requestedIds,
      ]
    );

    for (const appId of requestedIds) {
      await client.query(
        `
          INSERT INTO app_memberships (
            user_id,
            app_id,
            role,
            status,
            organization_id,
            project_id,
            environment_id
          )
          VALUES (
            $1::uuid,
            $2,
            $3,
            'active',
            $4,
            'proj_goodos_platform',
            'env_goodos_production'
          )
          ON CONFLICT (user_id, app_id)
          DO UPDATE SET
            role = CASE
              WHEN app_memberships.role = 'owner'
                THEN 'owner'
              ELSE EXCLUDED.role
            END,
            status = 'active',
            organization_id =
              EXCLUDED.organization_id,
            project_id =
              EXCLUDED.project_id,
            environment_id =
              EXCLUDED.environment_id,
            updated_at = NOW()
        `,
        [
          targetId,
          appId,
          role,
          context.organizationId,
        ]
      );
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  await logAudit({
    userId,
    appId: "goodos",
    action:
      "application_access.replaced",
    entityType:
      "user",
    entityId: targetId,
    ipAddress:
      requestMeta.ipAddress ||
      null,
    metadata: {
      organizationId:
        context.organizationId,
      targetUserId: targetId,
      appIds: requestedIds,
      role,
    },
  });

  return {
    userId: targetId,
    appIds: requestedIds,
    role,
  };
}

async function createRoleForUser(
  userId,
  input = {},
  requestMeta = {}
) {
  const context =
    await requireContext(
      userId,
      true
    );

  const displayName =
    cleanText(
      input.displayName,
      100
    );

  if (displayName.length < 2) {
    throw serviceError(
      "Role name must contain at least two characters."
    );
  }

  const description =
    cleanText(
      input.description,
      500
    ) || null;

  const level =
    Number.parseInt(
      String(
        input.level ?? 50
      ),
      10
    );

  if (
    !Number.isFinite(level) ||
    level < 1 ||
    level > 99
  ) {
    throw serviceError(
      "Role level must be between 1 and 99."
    );
  }

  const permissionIds =
    await validatePermissions(
      input.permissionIds
    );

  const baseName =
    roleSlug(displayName);

  if (!baseName) {
    throw serviceError(
      "Role name is invalid."
    );
  }

  const id =
    idValue("role_custom");

  const name =
    `${baseName}_${id.slice(-6)}`;

  const pool =
    getPool();

  const client =
    await pool.connect();

  let created;

  try {
    await client.query(
      "BEGIN"
    );

    const result =
      await client.query(
        `
          INSERT INTO backend_roles (
            id,
            name,
            display_name,
            description,
            level,
            status,
            metadata_json,
            organization_id,
            created_by,
            created_at,
            updated_at
          )
          VALUES (
            $1,
            $2,
            $3,
            $4,
            $5,
            'active',
            $6::jsonb,
            $7,
            $8::uuid,
            NOW(),
            NOW()
          )

          RETURNING
            id,
            name,

            display_name
              AS "displayName",

            description,
            level,
            status,

            organization_id
              AS "organizationId",

            created_by
              AS "createdBy",

            created_at
              AS "createdAt",

            updated_at
              AS "updatedAt"
        `,
        [
          id,
          name,
          displayName,
          description,
          level,
          JSON.stringify({
            system: false,
            source:
              "goodos_roles_console_v1",
          }),
          context.organizationId,
          userId,
        ]
      );

    created =
      result.rows[0];

    await replaceRolePermissions(
      client,
      id,
      permissionIds
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
      "role.created",
    entityType:
      "role",
    entityId: id,
    ipAddress:
      requestMeta.ipAddress ||
      null,
    metadata: {
      organizationId:
        context.organizationId,
      displayName,
      permissionIds,
      level,
    },
  });

  return {
    ...created,
    permissionIds,
    assignedUsers: 0,
    isSystem: false,
  };
}

async function updateRoleForUser(
  userId,
  roleId,
  input = {},
  requestMeta = {}
) {
  const context =
    await requireContext(
      userId,
      true
    );

  const current =
    await getRole(
      context.organizationId,
      roleId
    );

  if (current.isSystem) {
    throw serviceError(
      "Built-in roles cannot be modified.",
      409
    );
  }

  const displayName =
    input.displayName ===
    undefined
      ? current.displayName
      : cleanText(
          input.displayName,
          100
        );

  if (displayName.length < 2) {
    throw serviceError(
      "Role name must contain at least two characters."
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

  const level =
    input.level === undefined
      ? current.level
      : Number.parseInt(
          String(input.level),
          10
        );

  if (
    !Number.isFinite(level) ||
    level < 1 ||
    level > 99
  ) {
    throw serviceError(
      "Role level must be between 1 and 99."
    );
  }

  const permissionIds =
    input.permissionIds ===
    undefined
      ? null
      : await validatePermissions(
          input.permissionIds
        );

  const pool =
    getPool();

  const client =
    await pool.connect();

  let updated;

  try {
    await client.query(
      "BEGIN"
    );

    const result =
      await client.query(
        `
          UPDATE backend_roles

          SET
            display_name = $3,
            description = $4,
            level = $5,
            updated_at = NOW()

          WHERE id = $1
            AND organization_id = $2

          RETURNING
            id,
            name,

            display_name
              AS "displayName",

            description,
            level,
            status,

            organization_id
              AS "organizationId",

            created_by
              AS "createdBy",

            created_at
              AS "createdAt",

            updated_at
              AS "updatedAt"
        `,
        [
          roleId,
          context.organizationId,
          displayName,
          description,
          level,
        ]
      );

    if (!result.rows[0]) {
      throw serviceError(
        "Role was not found.",
        404
      );
    }

    updated =
      result.rows[0];

    if (permissionIds) {
      await replaceRolePermissions(
        client,
        roleId,
        permissionIds
      );
    }

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
      "role.updated",
    entityType:
      "role",
    entityId:
      roleId,
    ipAddress:
      requestMeta.ipAddress ||
      null,
    metadata: {
      organizationId:
        context.organizationId,
      displayName,
      permissionIds,
      level,
    },
  });

  return updated;
}

async function archiveRoleForUser(
  userId,
  roleId,
  requestMeta = {}
) {
  const context =
    await requireContext(
      userId,
      true
    );

  const role =
    await getRole(
      context.organizationId,
      roleId
    );

  if (role.isSystem) {
    throw serviceError(
      "Built-in roles cannot be archived.",
      409
    );
  }

  const assignments =
    await dbQuery(
      `
        SELECT COUNT(*)::int
          AS count

        FROM backend_user_roles

        WHERE role_id = $1
          AND status = 'active'
          AND revoked_at IS NULL
      `,
      [
        roleId,
      ]
    );

  if (
    Number(
      assignments.rows[0]
        ?.count || 0
    ) > 0
  ) {
    throw serviceError(
      "Reassign or revoke all active users before archiving this role.",
      409
    );
  }

  const result =
    await dbQuery(
      `
        UPDATE backend_roles

        SET
          status = 'archived',
          updated_at = NOW()

        WHERE id = $1
          AND organization_id = $2

        RETURNING
          id,
          status,
          updated_at
            AS "updatedAt"
      `,
      [
        roleId,
        context.organizationId,
      ]
    );

  await logAudit({
    userId,
    appId: "goodos",
    action:
      "role.archived",
    entityType:
      "role",
    entityId:
      roleId,
    ipAddress:
      requestMeta.ipAddress ||
      null,
    metadata: {
      organizationId:
        context.organizationId,
      roleName:
        role.displayName,
    },
  });

  return result.rows[0];
}

async function restoreRoleForUser(
  userId,
  roleId,
  requestMeta = {}
) {
  const context =
    await requireContext(
      userId,
      true
    );

  const role =
    await getRole(
      context.organizationId,
      roleId
    );

  if (role.isSystem) {
    throw serviceError(
      "Built-in roles do not require restoration.",
      409
    );
  }

  const result =
    await dbQuery(
      `
        UPDATE backend_roles

        SET
          status = 'active',
          updated_at = NOW()

        WHERE id = $1
          AND organization_id = $2

        RETURNING
          id,
          status,
          updated_at
            AS "updatedAt"
      `,
      [
        roleId,
        context.organizationId,
      ]
    );

  await logAudit({
    userId,
    appId: "goodos",
    action:
      "role.restored",
    entityType:
      "role",
    entityId:
      roleId,
    ipAddress:
      requestMeta.ipAddress ||
      null,
    metadata: {
      organizationId:
        context.organizationId,
      roleName:
        role.displayName,
    },
  });

  return result.rows[0];
}

async function duplicateRoleForUser(
  userId,
  roleId,
  input = {},
  requestMeta = {}
) {
  const context =
    await requireContext(
      userId,
      true
    );

  const role =
    await getRole(
      context.organizationId,
      roleId
    );

  const permissions =
    await dbQuery(
      `
        SELECT permission_id
        FROM backend_role_permissions

        WHERE role_id = $1
          AND status = 'active'
      `,
      [
        roleId,
      ]
    );

  return createRoleForUser(
    userId,
    {
      displayName:
        cleanText(
          input.displayName ||
          `${role.displayName} Copy`,
          100
        ),

      description:
        role.description,

      level:
        role.level,

      permissionIds:
        permissions.rows.map(
          row =>
            row.permission_id
        ),
    },
    requestMeta
  );
}

async function assignRoleForUser(
  actorUserId,
  input = {},
  requestMeta = {}
) {
  const context =
    await requireContext(
      actorUserId,
      true
    );

  const targetUserId =
    cleanText(
      input.userId,
      100
    );

  const roleId =
    cleanText(
      input.roleId,
      150
    );

  const scopeType =
    cleanText(
      input.scopeType ||
      "organization",
      50
    );

  if (
    ![
      "organization",
      "team",
      "app",
    ].includes(scopeType)
  ) {
    throw serviceError(
      "Assignment scope is invalid."
    );
  }

  const scopeId =
    scopeType ===
    "organization"
      ? context.organizationId
      : cleanText(
          input.scopeId,
          200
        );

  if (!scopeId) {
    throw serviceError(
      "Assignment scope identifier is required."
    );
  }

  const [
    memberResult,
    role,
  ] = await Promise.all([
    dbQuery(
      `
        SELECT
          membership.role
            AS "organizationRole",

          account.email,

          account.display_name
            AS "displayName"

        FROM backend_organization_memberships
             membership

        JOIN users account
          ON account.id =
             membership.user_id

        WHERE membership.organization_id =
              $1

          AND membership.user_id =
              $2::uuid

          AND membership.status =
              'active'

          AND account.status =
              'active'

        LIMIT 1
      `,
      [
        context.organizationId,
        targetUserId,
      ]
    ),

    getRole(
      context.organizationId,
      roleId
    ),
  ]);

  const member =
    memberResult.rows[0];

  if (!member) {
    throw serviceError(
      "Selected user is not an active workspace member.",
      404
    );
  }

  if (role.status !== "active") {
    throw serviceError(
      "Only active roles can be assigned.",
      409
    );
  }

  if (role.name === "owner") {
    throw serviceError(
      "The Owner role cannot be assigned from this control.",
      409
    );
  }

  if (
    member.organizationRole ===
    "owner"
  ) {
    throw serviceError(
      "The workspace owner role cannot be replaced.",
      409
    );
  }

  if (
    scopeType === "team"
  ) {
    const teamResult =
      await dbQuery(
        `
          SELECT id
          FROM backend_teams

          WHERE id = $1
            AND organization_id = $2
            AND status = 'active'

          LIMIT 1
        `,
        [
          scopeId,
          context.organizationId,
        ]
      );

    if (!teamResult.rows[0]) {
      throw serviceError(
        "Selected team was not found.",
        404
      );
    }
  }

  if (
    scopeType === "app"
  ) {
    const appResult =
      await dbQuery(
        `
          SELECT id
          FROM apps

          WHERE id = $1
            AND status = 'active'

          LIMIT 1
        `,
        [
          scopeId,
        ]
      );

    if (!appResult.rows[0]) {
      throw serviceError(
        "Selected application was not found.",
        404
      );
    }
  }

  const pool =
    getPool();

  const client =
    await pool.connect();

  const assignmentId =
    idValue("userrole");

  try {
    await client.query(
      "BEGIN"
    );

    await client.query(
      `
        UPDATE backend_user_roles

        SET
          status = 'revoked',
          revoked_at = NOW(),
          updated_at = NOW()

        WHERE user_id =
              $1::uuid

          AND scope_type = $2

          AND scope_id = $3

          AND COALESCE(
            organization_id,
            $4
          ) = $4

          AND status = 'active'

          AND revoked_at IS NULL
      `,
      [
        targetUserId,
        scopeType,
        scopeId,
        context.organizationId,
      ]
    );

    await client.query(
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
          assigned_at,
          metadata_json,
          organization_id,
          created_at,
          updated_at
        )
        VALUES (
          $1,
          $2::uuid,
          $3,
          $4,
          $5,
          $6,
          'active',
          $7::uuid,
          NOW(),
          $8::jsonb,
          $9,
          NOW(),
          NOW()
        )
      `,
      [
        assignmentId,
        targetUserId,
        role.id,
        role.name,
        scopeType,
        scopeId,
        actorUserId,
        JSON.stringify({
          source:
            "goodos_roles_console_v1",
        }),
        context.organizationId,
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
    userId:
      actorUserId,
    appId: "goodos",
    action:
      "role.assigned",
    entityType:
      "user_role",
    entityId:
      assignmentId,
    ipAddress:
      requestMeta.ipAddress ||
      null,
    metadata: {
      organizationId:
        context.organizationId,
      targetUserId,
      targetEmail:
        member.email,
      roleId:
        role.id,
      roleName:
        role.displayName,
      scopeType,
      scopeId,
    },
  });

  return {
    id:
      assignmentId,
    userId:
      targetUserId,
    roleId:
      role.id,
    roleName:
      role.name,
    roleDisplayName:
      role.displayName,
    scopeType,
    scopeId,
    status:
      "active",
  };
}

async function revokeAssignmentForUser(
  actorUserId,
  assignmentId,
  requestMeta = {}
) {
  const context =
    await requireContext(
      actorUserId,
      true
    );

  const assignmentResult =
    await dbQuery(
      `
        SELECT
          assignment.id,

          assignment.user_id
            AS "userId",

          assignment.role_id
            AS "roleId",

          role.name
            AS "roleName",

          role.display_name
            AS "roleDisplayName",

          membership.role
            AS "organizationRole"

        FROM backend_user_roles
             assignment

        JOIN backend_roles role
          ON role.id =
             assignment.role_id

        LEFT JOIN backend_organization_memberships
                  membership
          ON membership.user_id =
             assignment.user_id

         AND membership.organization_id =
             $2

         AND membership.status =
             'active'

        WHERE assignment.id = $1

          AND COALESCE(
            assignment.organization_id,
            $2
          ) = $2

          AND assignment.status =
              'active'

          AND assignment.revoked_at
              IS NULL

        LIMIT 1
      `,
      [
        assignmentId,
        context.organizationId,
      ]
    );

  const assignment =
    assignmentResult.rows[0];

  if (!assignment) {
    throw serviceError(
      "Active role assignment was not found.",
      404
    );
  }

  if (
    assignment.roleName ===
      "owner" ||
    assignment.organizationRole ===
      "owner"
  ) {
    throw serviceError(
      "The workspace owner's role assignment cannot be revoked.",
      409
    );
  }

  await dbQuery(
    `
      UPDATE backend_user_roles

      SET
        status = 'revoked',
        revoked_at = NOW(),
        updated_at = NOW()

      WHERE id = $1
    `,
    [
      assignmentId,
    ]
  );

  await logAudit({
    userId:
      actorUserId,
    appId: "goodos",
    action:
      "role.assignment_revoked",
    entityType:
      "user_role",
    entityId:
      assignmentId,
    ipAddress:
      requestMeta.ipAddress ||
      null,
    metadata: {
      organizationId:
        context.organizationId,
      targetUserId:
        assignment.userId,
      roleId:
        assignment.roleId,
      roleName:
        assignment.roleDisplayName,
    },
  });

  return {
    id:
      assignmentId,
    revoked: true,
  };
}

async function createAccessRequestForUser(
  userId,
  input = {},
  requestMeta = {}
) {
  const context =
    await requireContext(
      userId
    );

  const settingsResult =
    await dbQuery(
      `
        SELECT
          allow_self_service_requests
            AS "allowSelfServiceRequests",

          require_request_reason
            AS "requireRequestReason"

        FROM backend_role_settings

        WHERE organization_id = $1

        LIMIT 1
      `,
      [
        context.organizationId,
      ]
    );

  const settings =
    settingsResult.rows[0] || {
      allowSelfServiceRequests:
        true,
      requireRequestReason:
        true,
    };

  if (
    !context.canManage &&
    !settings.allowSelfServiceRequests
  ) {
    throw serviceError(
      "Self-service access requests are disabled.",
      403
    );
  }

  const role =
    await getRole(
      context.organizationId,
      cleanText(
        input.roleId,
        150
      )
    );

  if (
    role.status !==
    "active"
  ) {
    throw serviceError(
      "Only active roles can be requested.",
      409
    );
  }

  if (
    role.name ===
      "owner" ||
    role.name ===
      "admin"
  ) {
    throw serviceError(
      "Owner and Admin access cannot be requested through self-service.",
      409
    );
  }

  const scopeType =
    cleanText(
      input.scopeType ||
      "organization",
      50
    );

  if (
    ![
      "organization",
      "team",
      "app",
    ].includes(scopeType)
  ) {
    throw serviceError(
      "Access-request scope is invalid."
    );
  }

  const scopeId =
    scopeType ===
    "organization"
      ? context.organizationId
      : cleanText(
          input.scopeId,
          200
        );

  if (!scopeId) {
    throw serviceError(
      "Access-request scope identifier is required."
    );
  }

  const reason =
    cleanText(
      input.reason,
      1000
    );

  if (
    settings.requireRequestReason &&
    reason.length < 5
  ) {
    throw serviceError(
      "A reason is required for access requests."
    );
  }

  const existing =
    await dbQuery(
      `
        SELECT id
        FROM backend_access_requests

        WHERE organization_id = $1
          AND requester_user_id =
              $2::uuid
          AND requested_role_id = $3
          AND scope_type = $4
          AND scope_id = $5
          AND status = 'pending'

        LIMIT 1
      `,
      [
        context.organizationId,
        userId,
        role.id,
        scopeType,
        scopeId,
      ]
    );

  if (existing.rows[0]) {
    throw serviceError(
      "A matching access request is already pending.",
      409
    );
  }

  const id =
    idValue("accessreq");

  await dbQuery(
    `
      INSERT INTO backend_access_requests (
        id,
        organization_id,
        requester_user_id,
        requested_role_id,
        scope_type,
        scope_id,
        reason,
        status,
        metadata_json,
        created_at,
        updated_at
      )
      VALUES (
        $1,
        $2,
        $3::uuid,
        $4,
        $5,
        $6,
        $7,
        'pending',
        $8::jsonb,
        NOW(),
        NOW()
      )
    `,
    [
      id,
      context.organizationId,
      userId,
      role.id,
      scopeType,
      scopeId,
      reason || null,
      JSON.stringify({
        source:
          "goodos_roles_console_v1",
      }),
    ]
  );

  await logAudit({
    userId,
    appId: "goodos",
    action:
      "access_request.created",
    entityType:
      "access_request",
    entityId:
      id,
    ipAddress:
      requestMeta.ipAddress ||
      null,
    metadata: {
      organizationId:
        context.organizationId,
      roleId:
        role.id,
      roleName:
        role.displayName,
      scopeType,
      scopeId,
    },
  });

  return {
    id,
    status:
      "pending",
  };
}

async function resolveAccessRequestForUser(
  actorUserId,
  requestId,
  input = {},
  requestMeta = {}
) {
  const context =
    await requireContext(
      actorUserId,
      true
    );

  const decision =
    cleanText(
      input.decision,
      20
    );

  if (
    ![
      "approved",
      "denied",
    ].includes(decision)
  ) {
    throw serviceError(
      "Decision must be approved or denied."
    );
  }

  const note =
    cleanText(
      input.decisionNote,
      1000
    ) || null;

  const requestResult =
    await dbQuery(
      `
        SELECT
          request.id,

          request.requester_user_id
            AS "requesterUserId",

          request.requested_role_id
            AS "requestedRoleId",

          request.scope_type
            AS "scopeType",

          request.scope_id
            AS "scopeId",

          request.status,

          role.name
            AS "roleName",

          role.display_name
            AS "roleDisplayName",

          membership.role
            AS "organizationRole"

        FROM backend_access_requests
             request

        JOIN backend_roles role
          ON role.id =
             request.requested_role_id

        LEFT JOIN backend_organization_memberships
                  membership
          ON membership.user_id =
             request.requester_user_id

         AND membership.organization_id =
             request.organization_id

         AND membership.status =
             'active'

        WHERE request.id = $1

          AND request.organization_id =
              $2

        LIMIT 1
      `,
      [
        requestId,
        context.organizationId,
      ]
    );

  const request =
    requestResult.rows[0];

  if (!request) {
    throw serviceError(
      "Access request was not found.",
      404
    );
  }

  if (
    request.status !==
    "pending"
  ) {
    throw serviceError(
      "Access request has already been resolved.",
      409
    );
  }

  if (
    decision === "approved" &&
    (
      request.roleName ===
        "owner" ||
      request.organizationRole ===
        "owner"
    )
  ) {
    throw serviceError(
      "The workspace Owner role cannot be changed through access requests.",
      409
    );
  }

  if (
    decision === "approved"
  ) {
    await assignRoleForUser(
      actorUserId,
      {
        userId:
          request.requesterUserId,
        roleId:
          request.requestedRoleId,
        scopeType:
          request.scopeType,
        scopeId:
          request.scopeId,
      },
      requestMeta
    );
  }

  await dbQuery(
    `
      UPDATE backend_access_requests

      SET
        status = $3,
        reviewed_by =
          $4::uuid,
        reviewed_at =
          NOW(),
        decision_note = $5,
        updated_at =
          NOW()

      WHERE id = $1
        AND organization_id = $2
    `,
    [
      requestId,
      context.organizationId,
      decision,
      actorUserId,
      note,
    ]
  );

  await logAudit({
    userId:
      actorUserId,
    appId: "goodos",
    action:
      `access_request.${decision}`,
    entityType:
      "access_request",
    entityId:
      requestId,
    ipAddress:
      requestMeta.ipAddress ||
      null,
    metadata: {
      organizationId:
        context.organizationId,
      requesterUserId:
        request.requesterUserId,
      roleId:
        request.requestedRoleId,
      roleName:
        request.roleDisplayName,
      scopeType:
        request.scopeType,
      scopeId:
        request.scopeId,
      decisionNote:
        note,
    },
  });

  return {
    id:
      requestId,
    status:
      decision,
  };
}

async function updateSettingsForUser(
  userId,
  input = {},
  requestMeta = {}
) {
  const context =
    await requireContext(
      userId,
      true
    );

  const defaultRoleId =
    cleanText(
      input.defaultRoleId,
      150
    ) || null;

  if (defaultRoleId) {
    const role =
      await getRole(
        context.organizationId,
        defaultRoleId
      );

    if (
      role.status !==
      "active"
    ) {
      throw serviceError(
        "Default role must be active."
      );
    }

    if (
      role.name ===
        "owner" ||
      role.name ===
        "admin"
    ) {
      throw serviceError(
        "Owner and Admin cannot be selected as the default role.",
        409
      );
    }
  }

  const allowSelfServiceRequests =
    input.allowSelfServiceRequests ===
    undefined
      ? true
      : Boolean(
          input.allowSelfServiceRequests
        );

  const requireRequestReason =
    input.requireRequestReason ===
    undefined
      ? true
      : Boolean(
          input.requireRequestReason
        );

  const result =
    await dbQuery(
      `
        INSERT INTO backend_role_settings (
          organization_id,
          default_role_id,
          allow_self_service_requests,
          require_request_reason,
          metadata_json,
          updated_by,
          created_at,
          updated_at
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5::jsonb,
          $6::uuid,
          NOW(),
          NOW()
        )

        ON CONFLICT (
          organization_id
        )
        DO UPDATE SET
          default_role_id =
            EXCLUDED.default_role_id,

          allow_self_service_requests =
            EXCLUDED.allow_self_service_requests,

          require_request_reason =
            EXCLUDED.require_request_reason,

          metadata_json =
            EXCLUDED.metadata_json,

          updated_by =
            EXCLUDED.updated_by,

          updated_at =
            NOW()

        RETURNING
          organization_id
            AS "organizationId",

          default_role_id
            AS "defaultRoleId",

          allow_self_service_requests
            AS "allowSelfServiceRequests",

          require_request_reason
            AS "requireRequestReason",

          created_at
            AS "createdAt",

          updated_at
            AS "updatedAt"
      `,
      [
        context.organizationId,
        defaultRoleId,
        allowSelfServiceRequests,
        requireRequestReason,
        JSON.stringify({
          source:
            "goodos_roles_console_v1",
        }),
        userId,
      ]
    );

  await logAudit({
    userId,
    appId: "goodos",
    action:
      "role.settings_updated",
    entityType:
      "role_settings",
    entityId:
      context.organizationId,
    ipAddress:
      requestMeta.ipAddress ||
      null,
    metadata: {
      organizationId:
        context.organizationId,
      defaultRoleId,
      allowSelfServiceRequests,
      requireRequestReason,
    },
  });

  return result.rows[0];
}

module.exports = {
  getOverviewForUser,
  replaceApplicationAccessForUser,
  createRoleForUser,
  updateRoleForUser,
  archiveRoleForUser,
  restoreRoleForUser,
  duplicateRoleForUser,
  assignRoleForUser,
  revokeAssignmentForUser,
  createAccessRequestForUser,
  resolveAccessRequestForUser,
  updateSettingsForUser,
};
