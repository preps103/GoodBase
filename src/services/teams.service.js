const crypto = require("crypto");

const {
  query,
  pool,
} = require("../config/database");

const {
  logAudit,
} = require("./audit.service");

const notificationService =
  require("./notification.service");

function serviceError(
  message,
  statusCode = 500
) {
  const error = new Error(message);
  error.statusCode = statusCode;

  return error;
}

function cleanPage(
  value,
  fallback = 1
) {
  const parsed = Number.parseInt(
    String(value || ""),
    10
  );

  if (
    !Number.isFinite(parsed) ||
    parsed < 1
  ) {
    return fallback;
  }

  return parsed;
}

function cleanPageSize(
  value,
  fallback = 20
) {
  const parsed = Number.parseInt(
    String(value || ""),
    10
  );

  if (
    !Number.isFinite(parsed) ||
    parsed < 1
  ) {
    return fallback;
  }

  return Math.min(
    parsed,
    100
  );
}

async function getSchemaHealth() {
  const result = await query(
    `
      SELECT
        to_regclass(
          'public.backend_teams'
        ) IS NOT NULL AS "teamsTable",

        to_regclass(
          'public.backend_team_memberships'
        ) IS NOT NULL AS "teamMembershipsTable",

        EXISTS (
          SELECT 1
          FROM backend_permissions
          WHERE name = 'team:read'
            AND status = 'active'
        ) AS "readPermission",

        EXISTS (
          SELECT 1
          FROM backend_permissions
          WHERE name = 'team:manage'
            AND status = 'active'
        ) AS "managePermission"
    `
  );

  const health =
    result.rows[0] || {};

  return {
    ...health,

    schemaReady:
      Boolean(health.teamsTable) &&
      Boolean(
        health.teamMembershipsTable
      ) &&
      Boolean(health.readPermission) &&
      Boolean(health.managePermission),
  };
}

async function getOrganizationForUser(
  userId
) {
  const result = await query(
    `
      SELECT
        organization.id,
        organization.name,
        organization.slug,
        organization.plan,
        organization.status,

        membership.role
          AS "membershipRole",

        membership.status
          AS "membershipStatus"

      FROM backend_organization_memberships
           membership

      JOIN backend_organizations organization
        ON organization.id =
           membership.organization_id

      WHERE membership.user_id =
            $1::uuid

        AND membership.status =
            'active'

        AND organization.status =
            'active'

      ORDER BY
        CASE membership.role
          WHEN 'owner' THEN 1
          WHEN 'admin' THEN 2
          WHEN 'manager' THEN 3
          ELSE 4
        END,

        organization.created_at ASC

      LIMIT 1
    `,
    [
      userId,
    ]
  );

  return result.rows[0] || null;
}

async function requireOrganizationForUser(
  userId
) {
  const organization =
    await getOrganizationForUser(
      userId
    );

  if (!organization) {
    throw serviceError(
      "No active organization membership was found.",
      403
    );
  }

  return organization;
}

async function getSummaryForUser(
  userId
) {
  const organization =
    await requireOrganizationForUser(
      userId
    );

  const result = await query(
    `
      SELECT
        (
          SELECT COUNT(*)::int

          FROM backend_organization_memberships
               membership

          JOIN users user_account
            ON user_account.id =
               membership.user_id

          WHERE membership.organization_id =
                $1

            AND membership.status =
                'active'

            AND user_account.status <>
                'deleted'
        ) AS "totalMembers",

        (
          SELECT COUNT(*)::int

          FROM backend_organization_memberships
               membership

          JOIN users user_account
            ON user_account.id =
               membership.user_id

          WHERE membership.organization_id =
                $1

            AND membership.status =
                'active'

            AND user_account.status =
                'active'
        ) AS "activeMembers",

        (
          SELECT COUNT(
            DISTINCT session_record.user_id
          )::int

          FROM sessions session_record

          JOIN backend_organization_memberships
               membership
            ON membership.user_id =
               session_record.user_id

          WHERE membership.organization_id =
                $1

            AND membership.status =
                'active'

            AND session_record.revoked_at
                IS NULL

            AND session_record.expires_at >
                NOW()
        ) AS "membersWithActiveSessions",

        (
          SELECT COUNT(*)::int

          FROM backend_roles role

          WHERE role.status = 'active'

            AND (
              role.organization_id = $1
              OR role.organization_id IS NULL
            )
        ) AS "roles",

        (
          SELECT COUNT(*)::int

          FROM backend_teams team

          WHERE team.organization_id = $1
            AND team.status = 'active'
        ) AS "teams",

        (
          SELECT COUNT(*)::int

          FROM backend_user_invites invitation

          WHERE COALESCE(
            invitation.organization_id,
            'org_goodos'
          ) = $1

            AND invitation.status =
                'pending'

            AND invitation.expires_at >
                NOW()
        ) AS "pendingInvitations"
    `,
    [
      organization.id,
    ]
  );

  return {
    organization,
    ...(result.rows[0] || {}),
  };
}

async function getMembersForUser(
  userId,
  options = {}
) {
  const organization =
    await requireOrganizationForUser(
      userId
    );

  const page =
    cleanPage(
      options.page,
      1
    );

  const pageSize =
    cleanPageSize(
      options.pageSize,
      20
    );

  const offset =
    (page - 1) * pageSize;

  const search =
    String(
      options.search || ""
    )
      .trim()
      .toLowerCase();

  const teamId =
    String(
      options.teamId || ""
    ).trim();

  const role =
    String(
      options.role || ""
    )
      .trim()
      .toLowerCase();

  const result = await query(
    `
      WITH member_directory AS (
        SELECT
          user_account.id,
          user_account.email,

          user_account.first_name
            AS "firstName",

          user_account.last_name
            AS "lastName",

          user_account.display_name
            AS "displayName",

          user_account.platform_role
            AS "platformRole",

          user_account.status,

          user_account.email_verified
            AS "emailVerified",

          user_account.last_login_at
            AS "lastLoginAt",

          membership.role
            AS "organizationRole",

          membership.created_at
            AS "joinedAt",

          COALESCE(
            selected_role.role_id,

            CASE
              user_account.platform_role
              WHEN 'owner'
                THEN 'role_owner'
              WHEN 'admin'
                THEN 'role_admin'
              ELSE 'role_user'
            END
          ) AS "roleId",

          COALESCE(
            selected_role.role_name,
            user_account.platform_role
          ) AS "roleName",

          COALESCE(
            selected_role.role_display_name,
            INITCAP(
              user_account.platform_role
            )
          ) AS "roleDisplayName",

          COALESCE(
            team_data.teams,
            '[]'::jsonb
          ) AS teams,

          (
            SELECT MAX(
              session_record.created_at
            )

            FROM sessions session_record

            WHERE session_record.user_id =
                  user_account.id
          ) AS "lastSessionAt"

        FROM backend_organization_memberships
             membership

        JOIN users user_account
          ON user_account.id =
             membership.user_id

        LEFT JOIN LATERAL (
          SELECT
            user_role.role_id,
            user_role.role_name,

            role_record.display_name
              AS role_display_name,

            role_record.level

          FROM backend_user_roles
               user_role

          LEFT JOIN backend_roles
                    role_record
            ON role_record.id =
               user_role.role_id

          WHERE user_role.user_id =
                user_account.id

            AND user_role.status =
                'active'

            AND (
              user_role.organization_id = $1
              OR user_role.scope_type =
                 'platform'
            )

          ORDER BY
            CASE
              WHEN user_role.organization_id =
                   $1
                THEN 0
              ELSE 1
            END,

            COALESCE(
              role_record.level,
              999
            ) ASC,

            user_role.assigned_at DESC

          LIMIT 1
        ) selected_role
          ON TRUE

        LEFT JOIN LATERAL (
          SELECT
            COALESCE(
              jsonb_agg(
                jsonb_build_object(
                  'id',
                  team.id,

                  'name',
                  team.name,

                  'slug',
                  team.slug,

                  'roleId',
                  team_membership.role_id,

                  'status',
                  team_membership.status
                )

                ORDER BY team.name
              ) FILTER (
                WHERE team.id IS NOT NULL
              ),

              '[]'::jsonb
            ) AS teams

          FROM backend_team_memberships
               team_membership

          JOIN backend_teams team
            ON team.id =
               team_membership.team_id

          WHERE team_membership.user_id =
                user_account.id

            AND team_membership.status =
                'active'

            AND team.status =
                'active'

            AND team.organization_id =
                $1
        ) team_data
          ON TRUE

        WHERE membership.organization_id =
              $1

          AND membership.status =
              'active'

          AND user_account.status <>
              'deleted'

          AND (
            $2 = ''

            OR LOWER(
              user_account.email
            ) LIKE '%' || $2 || '%'

            OR LOWER(
              COALESCE(
                user_account.display_name,
                ''
              )
            ) LIKE '%' || $2 || '%'

            OR LOWER(
              COALESCE(
                user_account.first_name,
                ''
              )
              || ' ' ||
              COALESCE(
                user_account.last_name,
                ''
              )
            ) LIKE '%' || $2 || '%'
          )

          AND (
            $3 = ''

            OR EXISTS (
              SELECT 1

              FROM backend_team_memberships
                   filter_membership

              JOIN backend_teams
                   filter_team
                ON filter_team.id =
                   filter_membership.team_id

              WHERE filter_membership.user_id =
                    user_account.id

                AND filter_membership.team_id =
                    $3

                AND filter_membership.status =
                    'active'

                AND filter_team.organization_id =
                    $1

                AND filter_team.status =
                    'active'
            )
          )

          AND (
            $4 = ''

            OR LOWER(
              COALESCE(
                selected_role.role_name,
                user_account.platform_role
              )
            ) = $4
          )
      )

      SELECT
        member_directory.*,

        COUNT(*) OVER()::int
          AS "totalRows"

      FROM member_directory

      ORDER BY
        CASE
          WHEN "organizationRole" =
               'owner'
            THEN 0
          ELSE 1
        END,

        COALESCE(
          "displayName",
          "email"
        ) ASC

      LIMIT $5
      OFFSET $6
    `,
    [
      organization.id,
      search,
      teamId,
      role,
      pageSize,
      offset,
    ]
  );

  const total =
    result.rows.length > 0
      ? result.rows[0].totalRows
      : 0;

  const members =
    result.rows.map(row => {
      const {
        totalRows,
        ...member
      } = row;

      return member;
    });

  return {
    organization,
    page,
    pageSize,
    total,
    members,
  };
}

async function getRolesForUser(
  userId
) {
  const organization =
    await requireOrganizationForUser(
      userId
    );

  const result = await query(
    `
      SELECT
        role.id,
        role.name,

        role.display_name
          AS "displayName",

        role.description,
        role.level,
        role.status,

        COALESCE(
          jsonb_agg(
            permission.name
            ORDER BY permission.name
          ) FILTER (
            WHERE permission.id IS NOT NULL
              AND role_permission.status =
                  'active'
              AND permission.status =
                  'active'
          ),

          '[]'::jsonb
        ) AS permissions,

        (
          SELECT COUNT(*)::int

          FROM backend_user_roles
               user_role

          WHERE user_role.role_id =
                role.id

            AND user_role.status =
                'active'

            AND (
              user_role.organization_id =
                $1

              OR user_role.scope_type =
                 'platform'
            )
        ) AS "assignedUsers"

      FROM backend_roles role

      LEFT JOIN backend_role_permissions
                role_permission
        ON role_permission.role_id =
           role.id

      LEFT JOIN backend_permissions
                permission
        ON permission.id =
           role_permission.permission_id

      WHERE role.status = 'active'

        AND (
          role.organization_id = $1
          OR role.organization_id IS NULL
        )

      GROUP BY
        role.id,
        role.name,
        role.display_name,
        role.description,
        role.level,
        role.status

      ORDER BY
        role.level ASC,
        role.display_name ASC
    `,
    [
      organization.id,
    ]
  );

  return {
    organization,
    roles: result.rows,
  };
}

async function getTeamsForUser(
  userId
) {
  const organization =
    await requireOrganizationForUser(
      userId
    );

  const result = await query(
    `
      SELECT
        team.id,
        team.name,
        team.slug,
        team.description,
        team.status,

        team.created_at
          AS "createdAt",

        team.updated_at
          AS "updatedAt",

        creator.display_name
          AS "createdByName",

        creator.email
          AS "createdByEmail",

        COUNT(
          team_membership.id
        ) FILTER (
          WHERE team_membership.status =
                'active'
        )::int AS "activeMembers",

        COUNT(
          team_membership.id
        )::int AS "totalMembershipRecords"

      FROM backend_teams team

      LEFT JOIN users creator
        ON creator.id =
           team.created_by

      LEFT JOIN backend_team_memberships
                team_membership
        ON team_membership.team_id =
           team.id

      WHERE team.organization_id = $1

      GROUP BY
        team.id,
        team.name,
        team.slug,
        team.description,
        team.status,
        team.created_at,
        team.updated_at,
        creator.display_name,
        creator.email

      ORDER BY
        CASE team.status
          WHEN 'active' THEN 0
          ELSE 1
        END,

        team.name ASC
    `,
    [
      organization.id,
    ]
  );

  return {
    organization,
    teams: result.rows,
  };
}

async function getInvitationsForUser(
  userId
) {
  const organization =
    await requireOrganizationForUser(
      userId
    );

  const result = await query(
    `
      SELECT
        invitation.id,
        invitation.email,

        invitation.invited_by
          AS "invitedBy",

        invitation.platform_role
          AS "platformRole",

        invitation.app_id
          AS "appId",

        invitation.app_role
          AS "appRole",

        invitation.status,

        invitation.expires_at
          AS "expiresAt",

        invitation.accepted_at
          AS "acceptedAt",

        invitation.metadata_json
          AS metadata,

        invitation.created_at
          AS "createdAt",

        invitation.updated_at
          AS "updatedAt",

        CASE
          WHEN invitation.status =
               'pending'
           AND invitation.expires_at <=
               NOW()
            THEN 'expired'
          ELSE invitation.status
        END AS "effectiveStatus"

      FROM backend_user_invites invitation

      WHERE COALESCE(
        invitation.organization_id,
        'org_goodos'
      ) = $1

      ORDER BY
        invitation.created_at DESC,
        invitation.email ASC
    `,
    [
      organization.id,
    ]
  );

  return {
    organization,
    invitations: result.rows,
  };
}

async function getActivityForUser(
  userId,
  options = {}
) {
  const organization =
    await requireOrganizationForUser(
      userId
    );

  const limit =
    Math.min(
      cleanPageSize(
        options.limit,
        50
      ),
      100
    );

  const result = await query(
    `
      SELECT
        audit.id,
        audit.action,

        audit.entity_type
          AS "entityType",

        audit.entity_id
          AS "entityId",

        audit.metadata,

        audit.ip_address
          AS "ipAddress",

        audit.created_at
          AS "createdAt",

        actor.display_name
          AS "actorName",

        actor.email
          AS "actorEmail"

      FROM audit_logs audit

      LEFT JOIN users actor
        ON actor.id =
           audit.user_id

      WHERE (
        audit.action LIKE 'team.%'

        OR audit.entity_type IN (
          'team',
          'team_member',
          'team_invitation'
        )
      )

      AND (
        audit.metadata ->>
          'organizationId' = $1

        OR (
          audit.metadata ->>
            'organizationId'
          IS NULL

          AND EXISTS (
            SELECT 1

            FROM backend_organization_memberships
                 actor_membership

            WHERE actor_membership.user_id =
                  audit.user_id

              AND actor_membership.organization_id =
                  $1

              AND actor_membership.status =
                  'active'
          )
        )
      )

      ORDER BY audit.created_at DESC
      LIMIT $2
    `,
    [
      organization.id,
      limit,
    ]
  );

  return {
    organization,
    activity: result.rows,
  };
}


// GOODOS_TEAMS_PRODUCTION_WRITES_V1

function teamProductionError(
  message,
  statusCode = 500
) {
  const error = new Error(message);
  error.statusCode = statusCode;

  return error;
}

function teamProductionId(prefix) {
  return (
    `${prefix}_` +
    crypto.randomUUID().replace(/-/g, "")
  );
}

function teamProductionText(
  value,
  maximum = 160
) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, maximum);
}

function teamProductionEmail(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function teamProductionValidEmail(value) {
  return (
    value.length >= 3 &&
    value.length <= 320 &&
    /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)
  );
}

function teamProductionSlug(value) {
  return teamProductionText(
    value,
    100
  )
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 70);
}

function teamProductionHash(value) {
  return crypto
    .createHash("sha256")
    .update(String(value || ""))
    .digest("hex");
}

function teamProductionToken() {
  return crypto
    .randomBytes(32)
    .toString("hex");
}

function teamProductionEscapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function teamProductionOrganizationRole(
  roleName
) {
  if (roleName === "owner") {
    return "owner";
  }

  if (roleName === "admin") {
    return "admin";
  }

  if (roleName === "manager") {
    return "manager";
  }

  return "member";
}

function teamProductionAppRole(
  roleName
) {
  if (roleName === "owner") {
    return "owner";
  }

  if (roleName === "admin") {
    return "admin";
  }

  if (roleName === "viewer") {
    return "viewer";
  }

  return "member";
}

function teamProductionUniqueStrings(values) {
  if (!Array.isArray(values)) {
    return [];
  }

  return [
    ...new Set(
      values
        .map(value =>
          String(value || "").trim()
        )
        .filter(Boolean)
    ),
  ];
}

async function teamProductionTransaction(
  callback
) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const result =
      await callback(client);

    await client.query("COMMIT");

    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function teamProductionRequireManage(
  userId
) {
  const organization =
    await requireOrganizationForUser(
      userId
    );

  if (
    [
      "owner",
      "admin",
      "manager",
    ].includes(
      organization.membershipRole
    )
  ) {
    return organization;
  }

  const permissionResult = await query(
    `
      SELECT 1
      FROM backend_user_roles user_role

      JOIN backend_role_permissions
           role_permission
        ON role_permission.role_id =
           user_role.role_id
       AND role_permission.status =
           'active'

      JOIN backend_permissions permission
        ON permission.id =
           role_permission.permission_id
       AND permission.status =
           'active'

      WHERE user_role.user_id =
            $1::uuid

        AND user_role.status =
            'active'

        AND permission.name =
            'team:manage'

        AND (
          user_role.organization_id =
            $2

          OR user_role.scope_type =
             'platform'
        )

      LIMIT 1
    `,
    [
      userId,
      organization.id,
    ]
  );

  if (permissionResult.rowCount === 0) {
    throw teamProductionError(
      "Team management permission is required.",
      403
    );
  }

  return organization;
}

async function teamProductionRequireRoleManage(
  userId
) {
  const organization =
    await teamProductionRequireManage(
      userId
    );

  if (
    ![
      "owner",
      "admin",
    ].includes(
      organization.membershipRole
    )
  ) {
    throw teamProductionError(
      "Owner or admin access is required to manage roles.",
      403
    );
  }

  return organization;
}

async function teamProductionFindRole(
  client,
  organizationId,
  roleSelector
) {
  const selector =
    teamProductionText(
      roleSelector,
      120
    );

  if (!selector) {
    throw teamProductionError(
      "A valid role is required.",
      400
    );
  }

  const result = await client.query(
    `
      SELECT
        id,
        name,
        display_name AS "displayName",
        description,
        level,
        status,
        metadata_json AS metadata

      FROM backend_roles

      WHERE status = 'active'

        AND (
          id = $1
          OR LOWER(name) =
             LOWER($1)
        )

        AND (
          organization_id = $2
          OR organization_id IS NULL
        )

      ORDER BY
        CASE
          WHEN organization_id = $2
            THEN 0
          ELSE 1
        END

      LIMIT 1
    `,
    [
      selector,
      organizationId,
    ]
  );

  if (result.rowCount === 0) {
    throw teamProductionError(
      "The selected role does not exist.",
      404
    );
  }

  return result.rows[0];
}

async function teamProductionFindTeam(
  client,
  organizationId,
  teamId,
  includeArchived = false
) {
  const result = await client.query(
    `
      SELECT
        id,
        organization_id AS "organizationId",
        name,
        slug,
        description,
        status,
        created_by AS "createdBy",
        created_at AS "createdAt",
        updated_at AS "updatedAt"

      FROM backend_teams

      WHERE id = $1
        AND organization_id = $2

        AND (
          $3::boolean = TRUE
          OR status = 'active'
        )

      LIMIT 1
    `,
    [
      teamId,
      organizationId,
      includeArchived,
    ]
  );

  if (result.rowCount === 0) {
    throw teamProductionError(
      "The selected team does not exist.",
      404
    );
  }

  return result.rows[0];
}

async function teamProductionValidateTeams(
  client,
  organizationId,
  teamIds
) {
  const uniqueTeamIds =
    teamProductionUniqueStrings(
      teamIds
    );

  if (uniqueTeamIds.length === 0) {
    return [];
  }

  const result = await client.query(
    `
      SELECT
        id,
        name,
        slug,
        status

      FROM backend_teams

      WHERE organization_id = $1
        AND status = 'active'
        AND id = ANY($2::text[])

      ORDER BY name
    `,
    [
      organizationId,
      uniqueTeamIds,
    ]
  );

  if (
    result.rows.length !==
    uniqueTeamIds.length
  ) {
    throw teamProductionError(
      "One or more selected teams are invalid or archived.",
      400
    );
  }

  return result.rows;
}

async function teamProductionSyncTeams({
  client,
  organizationId,
  userId,
  roleId,
  teamIds,
  actorUserId,
  replaceExisting,
}) {
  const teams =
    await teamProductionValidateTeams(
      client,
      organizationId,
      teamIds
    );

  const validIds =
    teams.map(team => team.id);

  if (replaceExisting) {
    await client.query(
      `
        UPDATE backend_team_memberships
        SET
          status = 'removed',
          updated_at = NOW()

        WHERE user_id = $1::uuid

          AND team_id IN (
            SELECT id
            FROM backend_teams
            WHERE organization_id = $2
          )

          AND NOT (
            team_id = ANY($3::text[])
          )
      `,
      [
        userId,
        organizationId,
        validIds,
      ]
    );
  }

  for (const selectedTeam of teams) {
    await client.query(
      `
        INSERT INTO backend_team_memberships (
          id,
          team_id,
          user_id,
          role_id,
          status,
          added_by,
          metadata_json
        )
        VALUES (
          $1,
          $2,
          $3::uuid,
          $4,
          'active',
          $5::uuid,
          $6::jsonb
        )

        ON CONFLICT (
          team_id,
          user_id
        )
        DO UPDATE SET
          role_id =
            EXCLUDED.role_id,

          status =
            'active',

          added_by =
            EXCLUDED.added_by,

          metadata_json =
            EXCLUDED.metadata_json,

          updated_at =
            NOW()
      `,
      [
        teamProductionId("teammem"),
        selectedTeam.id,
        userId,
        roleId,
        actorUserId,
        JSON.stringify({
          source:
            "goodos_teams_production_v1",
        }),
      ]
    );
  }

  return teams;
}

async function teamProductionApplyActiveMember({
  client,
  organization,
  userId,
  role,
  teamIds,
  actorUserId,
  replaceTeams,
}) {
  await client.query(
    `
      INSERT INTO backend_organization_memberships (
        id,
        organization_id,
        user_id,
        role,
        status
      )
      VALUES (
        $1,
        $2,
        $3::uuid,
        $4,
        'active'
      )

      ON CONFLICT (
        organization_id,
        user_id
      )
      DO UPDATE SET
        role =
          EXCLUDED.role,

        status =
          'active',

        updated_at =
          NOW()
    `,
    [
      teamProductionId("orgmem"),
      organization.id,
      userId,
      teamProductionOrganizationRole(
        role.name
      ),
    ]
  );

  await client.query(
    `
      UPDATE backend_user_roles
      SET
        status = 'revoked',
        revoked_at = NOW(),
        updated_at = NOW()

      WHERE user_id = $1::uuid
        AND scope_type = 'organization'
        AND scope_id = $2
        AND status = 'active'
        AND role_id <> $3
    `,
    [
      userId,
      organization.id,
      role.id,
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
        revoked_at,
        metadata_json,
        organization_id,
        project_id,
        environment_id
      )
      VALUES (
        $1,
        $2::uuid,
        $3,
        $4,
        'organization',
        $5,
        'active',
        $6::uuid,
        NOW(),
        NULL,
        $7::jsonb,
        $5,
        'proj_goodos_platform',
        'env_goodos_production'
      )

      ON CONFLICT (
        user_id,
        role_id,
        scope_type,
        scope_id
      )
      DO UPDATE SET
        role_name =
          EXCLUDED.role_name,

        status =
          'active',

        assigned_by =
          EXCLUDED.assigned_by,

        assigned_at =
          NOW(),

        revoked_at =
          NULL,

        metadata_json =
          EXCLUDED.metadata_json,

        updated_at =
          NOW()
    `,
    [
      teamProductionId("userrole"),
      userId,
      role.id,
      role.name,
      organization.id,
      actorUserId,
      JSON.stringify({
        source:
          "goodos_teams_production_v1",
      }),
    ]
  );

  await client.query(
    `
      INSERT INTO app_memberships (
        id,
        user_id,
        app_id,
        role,
        status,
        organization_id,
        project_id,
        environment_id
      )
      VALUES (
        $1,
        $2::uuid,
        'goodos',
        $3,
        'active',
        $4,
        'proj_goodos_platform',
        'env_goodos_production'
      )

      ON CONFLICT (
        user_id,
        app_id
      )
      DO UPDATE SET
        role =
          EXCLUDED.role,

        status =
          'active',

        organization_id =
          EXCLUDED.organization_id,

        project_id =
          EXCLUDED.project_id,

        environment_id =
          EXCLUDED.environment_id,

        updated_at =
          NOW()
    `,
    [
      // app_memberships.id is a PostgreSQL UUID. The other team tables use
      // prefixed text identifiers, so reusing teamProductionId here caused
      // every existing-user invitation to roll back with an invalid UUID.
      crypto.randomUUID(),
      userId,
      teamProductionAppRole(
        role.name
      ),
      organization.id,
    ]
  );

  return teamProductionSyncTeams({
    client,
    organizationId:
      organization.id,
    userId,
    roleId: role.id,
    teamIds,
    actorUserId,
    replaceExisting:
      replaceTeams,
  });
}

async function getTeamPermissionsForUser(
  userId
) {
  const organization =
    await requireOrganizationForUser(
      userId
    );

  const result = await query(
    `
      SELECT
        id,
        name,
        category,
        description,
        status

      FROM backend_permissions

      WHERE status = 'active'

      ORDER BY
        category,
        name
    `
  );

  return {
    organization,
    permissions:
      result.rows,
  };
}

async function createTeamForUser(
  actorUserId,
  input = {},
  requestMeta = {}
) {
  const organization =
    await teamProductionRequireManage(
      actorUserId
    );

  const name =
    teamProductionText(
      input.name,
      80
    );

  const description =
    teamProductionText(
      input.description,
      500
    );

  if (name.length < 2) {
    throw teamProductionError(
      "Team name must contain at least two characters.",
      400
    );
  }

  const initialSlug =
    teamProductionSlug(name);

  if (!initialSlug) {
    throw teamProductionError(
      "Team name must contain letters or numbers.",
      400
    );
  }

  const team =
    await teamProductionTransaction(
      async client => {
        const slugResult =
          await client.query(
            `
              SELECT slug
              FROM backend_teams
              WHERE organization_id = $1
                AND slug LIKE $2
            `,
            [
              organization.id,
              `${initialSlug}%`,
            ]
          );

        const usedSlugs =
          new Set(
            slugResult.rows.map(
              row => row.slug
            )
          );

        let slug = initialSlug;
        let suffix = 2;

        while (usedSlugs.has(slug)) {
          slug =
            `${initialSlug}-${suffix}`;

          suffix += 1;
        }

        const createResult =
          await client.query(
            `
              INSERT INTO backend_teams (
                id,
                organization_id,
                name,
                slug,
                description,
                status,
                created_by,
                metadata_json
              )
              VALUES (
                $1,
                $2,
                $3,
                $4,
                NULLIF($5, ''),
                'active',
                $6::uuid,
                $7::jsonb
              )
              RETURNING
                id,
                organization_id
                  AS "organizationId",
                name,
                slug,
                description,
                status,
                created_at
                  AS "createdAt",
                updated_at
                  AS "updatedAt"
            `,
            [
              teamProductionId("team"),
              organization.id,
              name,
              slug,
              description,
              actorUserId,
              JSON.stringify({
                source:
                  "goodos_teams_production_v1",
              }),
            ]
          );

        const createdTeam =
          createResult.rows[0];

        const creatorRole =
          await teamProductionFindRole(
            client,
            organization.id,
            organization.membershipRole
          );

        await client.query(
          `
            INSERT INTO backend_team_memberships (
              id,
              team_id,
              user_id,
              role_id,
              status,
              added_by,
              metadata_json
            )
            VALUES (
              $1,
              $2,
              $3::uuid,
              $4,
              'active',
              $3::uuid,
              $5::jsonb
            )
          `,
          [
            teamProductionId("teammem"),
            createdTeam.id,
            actorUserId,
            creatorRole.id,
            JSON.stringify({
              source:
                "team_creator",
            }),
          ]
        );

        return createdTeam;
      }
    );

  await logAudit({
    userId: actorUserId,
    appId: "goodos",
    action: "team.created",
    entityType: "team",
    entityId: team.id,
    ipAddress:
      requestMeta.ipAddress || null,
    metadata: {
      organizationId:
        organization.id,
      name: team.name,
      slug: team.slug,
    },
  });

  return team;
}

async function updateTeamForUser(
  actorUserId,
  teamId,
  input = {},
  requestMeta = {}
) {
  const organization =
    await teamProductionRequireManage(
      actorUserId
    );

  const updated =
    await teamProductionTransaction(
      async client => {
        const current =
          await teamProductionFindTeam(
            client,
            organization.id,
            teamId,
            true
          );

        const name =
          input.name === undefined
            ? current.name
            : teamProductionText(
                input.name,
                80
              );

        const description =
          input.description === undefined
            ? current.description || ""
            : teamProductionText(
                input.description,
                500
              );

        const status =
          input.status === undefined
            ? current.status
            : String(
                input.status
              ).toLowerCase();

        if (name.length < 2) {
          throw teamProductionError(
            "Team name must contain at least two characters.",
            400
          );
        }

        if (
          ![
            "active",
            "archived",
          ].includes(status)
        ) {
          throw teamProductionError(
            "Team status must be active or archived.",
            400
          );
        }

        let slug = current.slug;

        if (name !== current.name) {
          const baseSlug =
            teamProductionSlug(name);

          if (!baseSlug) {
            throw teamProductionError(
              "Team name must contain letters or numbers.",
              400
            );
          }

          const slugResult =
            await client.query(
              `
                SELECT slug
                FROM backend_teams
                WHERE organization_id = $1
                  AND id <> $2
                  AND slug LIKE $3
              `,
              [
                organization.id,
                teamId,
                `${baseSlug}%`,
              ]
            );

          const usedSlugs =
            new Set(
              slugResult.rows.map(
                row => row.slug
              )
            );

          slug = baseSlug;
          let suffix = 2;

          while (usedSlugs.has(slug)) {
            slug =
              `${baseSlug}-${suffix}`;

            suffix += 1;
          }
        }

        const result =
          await client.query(
            `
              UPDATE backend_teams
              SET
                name = $3,
                slug = $4,
                description =
                  NULLIF($5, ''),
                status = $6,
                updated_at = NOW()

              WHERE id = $1
                AND organization_id = $2

              RETURNING
                id,
                organization_id
                  AS "organizationId",
                name,
                slug,
                description,
                status,
                created_at
                  AS "createdAt",
                updated_at
                  AS "updatedAt"
            `,
            [
              teamId,
              organization.id,
              name,
              slug,
              description,
              status,
            ]
          );

        if (
          status === "archived" &&
          current.status !== "archived"
        ) {
          await client.query(
            `
              UPDATE backend_team_memberships
              SET
                status = 'removed',
                updated_at = NOW()

              WHERE team_id = $1
                AND status = 'active'
            `,
            [
              teamId,
            ]
          );
        }

        return result.rows[0];
      }
    );

  await logAudit({
    userId: actorUserId,
    appId: "goodos",
    action:
      updated.status === "archived"
        ? "team.archived"
        : "team.updated",
    entityType: "team",
    entityId: updated.id,
    ipAddress:
      requestMeta.ipAddress || null,
    metadata: {
      organizationId:
        organization.id,
      name: updated.name,
      status: updated.status,
    },
  });

  return updated;
}

async function updateTeamMemberForUser(
  actorUserId,
  targetUserId,
  input = {},
  requestMeta = {}
) {
  const organization =
    await teamProductionRequireManage(
      actorUserId
    );

  const roleSelector =
    teamProductionText(
      input.roleName ||
      input.roleId,
      120
    );

  const status =
    String(
      input.status || "active"
    ).toLowerCase();

  const teamIds =
    teamProductionUniqueStrings(
      input.teamIds
    );

  if (
    ![
      "active",
      "suspended",
      "removed",
    ].includes(status)
  ) {
    throw teamProductionError(
      "Member status must be active, suspended, or removed.",
      400
    );
  }

  const member =
    await teamProductionTransaction(
      async client => {
        const currentResult =
          await client.query(
            `
              SELECT
                membership.user_id
                  AS "userId",

                membership.role
                  AS "organizationRole",

                membership.status,

                user_account.email,

                user_account.display_name
                  AS "displayName"

              FROM backend_organization_memberships
                   membership

              JOIN users user_account
                ON user_account.id =
                   membership.user_id

              WHERE membership.organization_id =
                    $1

                AND membership.user_id =
                    $2::uuid

              LIMIT 1

              FOR UPDATE
            `,
            [
              organization.id,
              targetUserId,
            ]
          );

        if (
          currentResult.rowCount === 0
        ) {
          throw teamProductionError(
            "Organization member was not found.",
            404
          );
        }

        const current =
          currentResult.rows[0];

        const role =
          await teamProductionFindRole(
            client,
            organization.id,
            roleSelector
          );

        const removingOwner =
          current.organizationRole ===
            "owner" &&
          (
            status !== "active" ||
            role.name !== "owner"
          );

        if (removingOwner) {
          const ownerResult =
            await client.query(
              `
                SELECT COUNT(*)::int
                  AS owners

                FROM backend_organization_memberships

                WHERE organization_id = $1
                  AND role = 'owner'
                  AND status = 'active'
              `,
              [
                organization.id,
              ]
            );

          if (
            ownerResult.rows[0].owners <=
            1
          ) {
            throw teamProductionError(
              "The final active organization owner cannot be removed, suspended, or demoted.",
              409
            );
          }
        }

        if (status === "active") {
          await teamProductionApplyActiveMember({
            client,
            organization,
            userId: targetUserId,
            role,
            teamIds,
            actorUserId,
            replaceTeams: true,
          });
        } else {
          await client.query(
            `
              UPDATE backend_organization_memberships
              SET
                status = $3,
                updated_at = NOW()

              WHERE organization_id = $1
                AND user_id = $2::uuid
            `,
            [
              organization.id,
              targetUserId,
              status,
            ]
          );

          await client.query(
            `
              UPDATE backend_user_roles
              SET
                status = 'revoked',
                revoked_at = NOW(),
                updated_at = NOW()

              WHERE user_id = $1::uuid
                AND scope_type =
                    'organization'
                AND scope_id = $2
                AND status = 'active'
            `,
            [
              targetUserId,
              organization.id,
            ]
          );

          await client.query(
            `
              UPDATE backend_team_memberships
              SET
                status = 'removed',
                updated_at = NOW()

              WHERE user_id = $1::uuid

                AND team_id IN (
                  SELECT id
                  FROM backend_teams
                  WHERE organization_id = $2
                )

                AND status = 'active'
            `,
            [
              targetUserId,
              organization.id,
            ]
          );

          await client.query(
            `
              UPDATE app_memberships
              SET
                status = $3,
                updated_at = NOW()

              WHERE user_id = $1::uuid
                AND app_id = 'goodos'
                AND organization_id = $2
            `,
            [
              targetUserId,
              organization.id,
              status,
            ]
          );
        }

        return {
          userId: current.userId,
          email: current.email,
          displayName:
            current.displayName,
          roleId: role.id,
          roleName: role.name,
          roleDisplayName:
            role.displayName,
          status,
          teamIds,
        };
      }
    );

  await logAudit({
    userId: actorUserId,
    appId: "goodos",
    action:
      member.status === "removed"
        ? "team.member_removed"
        : member.status === "suspended"
          ? "team.member_suspended"
          : "team.member_updated",
    entityType: "team_member",
    entityId: member.userId,
    ipAddress:
      requestMeta.ipAddress || null,
    metadata: {
      organizationId:
        organization.id,
      email: member.email,
      roleName:
        member.roleName,
      status:
        member.status,
      teamIds:
        member.teamIds,
    },
  });

  return member;
}

async function teamProductionQueueInvitation({
  organization,
  email,
  invitationId,
  rawToken,
  role,
  teams,
}) {
  const appUrl = (
    process.env.PUBLIC_APP_URL ||
    "https://goodos.app"
  ).replace(/\/+$/, "");

  const invitationUrl =
    `${appUrl}/?teamInvite=` +
    encodeURIComponent(rawToken);

  const safeOrganization =
    teamProductionEscapeHtml(
      organization.name
    );

  const safeRole =
    teamProductionEscapeHtml(
      role.displayName
    );

  const teamNames =
    teams.map(team => team.name);

  const safeTeams =
    teamNames
      .map(teamProductionEscapeHtml)
      .join(", ");

  return notificationService.queueEmail({
    toEmail: email,

    templateKey:
      "auth.invite",

    subject:
      `You have been invited to ${organization.name}`,

    bodyText: [
      `You have been invited to ${organization.name}.`,
      "",
      `Role: ${role.displayName}`,
      teamNames.length
        ? `Teams: ${teamNames.join(", ")}`
        : "",
      "",
      "Accept the secure invitation:",
      invitationUrl,
      "",
      "This invitation expires in seven days.",
    ]
      .filter(Boolean)
      .join("\n"),

    bodyHtml: `
<!doctype html>
<html lang="en">
<body style="margin:0;background:#090b10;color:#ffffff;font-family:Arial,sans-serif;">
  <div style="max-width:620px;margin:0 auto;padding:36px 20px;">
    <div style="background:#151821;border:1px solid #292e39;border-radius:22px;padding:34px;">
      <div style="font-size:12px;font-weight:700;letter-spacing:2px;color:#5eead4;">
        GOODOS TEAM INVITATION
      </div>

      <h1 style="font-size:28px;margin:18px 0 12px;">
        Join ${safeOrganization}
      </h1>

      <p style="color:#c4cad4;line-height:1.65;">
        Role: <strong>${safeRole}</strong>
      </p>

      ${
        safeTeams
          ? `
      <p style="color:#c4cad4;line-height:1.65;">
        Teams: <strong>${safeTeams}</strong>
      </p>
          `
          : ""
      }

      <a
        href="${teamProductionEscapeHtml(
          invitationUrl
        )}"
        style="display:inline-block;margin:22px 0;padding:15px 22px;background:#10b981;color:#07110e;text-decoration:none;border-radius:12px;font-weight:700;"
      >
        Accept team invitation
      </a>

      <p style="color:#949dac;font-size:14px;line-height:1.6;">
        This secure invitation expires in seven days.
      </p>
    </div>
  </div>
</body>
</html>
    `,

    payload: {
      invitationId,
      roleId: role.id,
      roleName: role.name,
      teamIds:
        teams.map(team => team.id),
      organizationId:
        organization.id,
    },

    organizationId:
      organization.id,

    projectId:
      "proj_goodos_platform",

    environmentId:
      "env_goodos_production",
  });
}

async function inviteTeamMemberForUser(
  actorUserId,
  input = {},
  requestMeta = {}
) {
  const organization =
    await teamProductionRequireManage(
      actorUserId
    );

  const email =
    teamProductionEmail(
      input.email
    );

  const roleSelector =
    teamProductionText(
      input.roleName ||
      input.roleId ||
      "user",
      120
    );

  const teamIds =
    teamProductionUniqueStrings(
      input.teamIds
    );

  if (
    !teamProductionValidEmail(
      email
    )
  ) {
    throw teamProductionError(
      "A valid email address is required.",
      400
    );
  }

  const result =
    await teamProductionTransaction(
      async client => {
        const role =
          await teamProductionFindRole(
            client,
            organization.id,
            roleSelector
          );

        const teams =
          await teamProductionValidateTeams(
            client,
            organization.id,
            teamIds
          );

        const userResult =
          await client.query(
            `
              SELECT
                id,
                email,
                display_name
                  AS "displayName",
                status

              FROM users

              WHERE LOWER(email) =
                    LOWER($1)

                AND status <>
                    'deleted'

              LIMIT 1
            `,
            [
              email,
            ]
          );

        if (
          userResult.rowCount > 0
        ) {
          const user =
            userResult.rows[0];

          await teamProductionApplyActiveMember({
            client,
            organization,
            userId: user.id,
            role,
            teamIds,
            actorUserId,
            replaceTeams: false,
          });

          return {
            type: "member",
            memberAdded: true,
            user,
            role,
            teams,
          };
        }

        await client.query(
          `
            UPDATE backend_user_invites
            SET
              status = 'revoked',
              updated_at = NOW(),

              metadata_json =
                COALESCE(
                  metadata_json,
                  '{}'::jsonb
                ) ||
                $3::jsonb

            WHERE LOWER(email) =
                  LOWER($1)

              AND COALESCE(
                organization_id,
                'org_goodos'
              ) = $2

              AND status = 'pending'
          `,
          [
            email,
            organization.id,
            JSON.stringify({
              revokedReason:
                "Superseded by a newer invitation",
            }),
          ]
        );

        const rawToken =
          teamProductionToken();

        const invitationId =
          teamProductionId("invite");

        const invitationResult =
          await client.query(
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
                metadata_json,
                organization_id,
                project_id,
                environment_id
              )
              VALUES (
                $1,
                $2,
                $3,
                'user',
                'goodos',
                $4,
                $5,
                'pending',
                NOW() +
                  INTERVAL '7 days',
                $6::jsonb,
                $7,
                'proj_goodos_platform',
                'env_goodos_production'
              )
              RETURNING
                id,
                email,
                status,
                expires_at
                  AS "expiresAt",
                created_at
                  AS "createdAt"
            `,
            [
              invitationId,
              email,
              actorUserId,
              teamProductionAppRole(
                role.name
              ),
              teamProductionHash(
                rawToken
              ),
              JSON.stringify({
                roleId: role.id,
                roleName: role.name,
                roleDisplayName:
                  role.displayName,
                teamIds:
                  teams.map(
                    team => team.id
                  ),
                teamNames:
                  teams.map(
                    team => team.name
                  ),
                source:
                  "goodos_teams_production_v1",
              }),
              organization.id,
            ]
          );

        return {
          type: "invitation",
          memberAdded: false,
          invitation:
            invitationResult.rows[0],
          rawToken,
          role,
          teams,
        };
      }
    );

  if (result.memberAdded) {
    await logAudit({
      userId: actorUserId,
      appId: "goodos",
      action: "team.member_added",
      entityType: "team_member",
      entityId: result.user.id,
      ipAddress:
        requestMeta.ipAddress || null,
      metadata: {
        organizationId:
          organization.id,
        email,
        roleName:
          result.role.name,
        teamIds:
          result.teams.map(
            team => team.id
          ),
      },
    });

    return {
      memberAdded: true,
      emailQueued: false,
      message:
        "Existing GoodOS user was added successfully.",
      member: result.user,
    };
  }

  let emailQueued = false;
  let emailQueue = null;

  try {
    emailQueue =
      await teamProductionQueueInvitation({
        organization,
        email,
        invitationId:
          result.invitation.id,
        rawToken:
          result.rawToken,
        role:
          result.role,
        teams:
          result.teams,
      });

    emailQueued = true;
  } catch (emailError) {
    console.error(
      "Team invitation email queue failed:",
      emailError
    );
  }

  await logAudit({
    userId: actorUserId,
    appId: "goodos",
    action:
      "team.invitation_created",
    entityType:
      "team_invitation",
    entityId:
      result.invitation.id,
    ipAddress:
      requestMeta.ipAddress || null,
    metadata: {
      organizationId:
        organization.id,
      email,
      roleName:
        result.role.name,
      teamIds:
        result.teams.map(
          team => team.id
        ),
      emailQueued,
    },
  });

  return {
    memberAdded: false,
    emailQueued,
    emailQueue,
    invitation:
      result.invitation,
    message:
      emailQueued
        ? "Invitation created and queued for delivery."
        : "Invitation created, but email delivery could not be queued.",
  };
}

async function resendTeamInvitationForUser(
  actorUserId,
  invitationId,
  requestMeta = {}
) {
  const organization =
    await teamProductionRequireManage(
      actorUserId
    );

  const rawToken =
    teamProductionToken();

  const result = await query(
    `
      UPDATE backend_user_invites
      SET
        token_hash = $1,
        status = 'pending',
        expires_at =
          NOW() + INTERVAL '7 days',
        accepted_at = NULL,
        updated_at = NOW()

      WHERE id = $2

        AND COALESCE(
          organization_id,
          'org_goodos'
        ) = $3

        AND status <> 'accepted'

      RETURNING
        id,
        email,
        metadata_json AS metadata,
        expires_at AS "expiresAt"
    `,
    [
      teamProductionHash(
        rawToken
      ),
      invitationId,
      organization.id,
    ]
  );

  if (result.rowCount === 0) {
    throw teamProductionError(
      "Invitation could not be resent.",
      404
    );
  }

  const invitation =
    result.rows[0];

  const metadata =
    invitation.metadata || {};

  const roleResult =
    await query(
      `
        SELECT
          id,
          name,
          display_name
            AS "displayName"

        FROM backend_roles

        WHERE id = $1
          AND status = 'active'

        LIMIT 1
      `,
      [
        metadata.roleId ||
        "role_user",
      ]
    );

  const role =
    roleResult.rows[0] || {
      id: "role_user",
      name: "user",
      displayName: "User",
    };

  const teamIds =
    teamProductionUniqueStrings(
      metadata.teamIds
    );

  const teamResult =
    teamIds.length
      ? await query(
          `
            SELECT
              id,
              name,
              slug,
              status

            FROM backend_teams

            WHERE organization_id = $1
              AND id =
                  ANY($2::text[])
              AND status = 'active'

            ORDER BY name
          `,
          [
            organization.id,
            teamIds,
          ]
        )
      : {
          rows: [],
        };

  let emailQueued = false;

  try {
    await teamProductionQueueInvitation({
      organization,
      email:
        invitation.email,
      invitationId:
        invitation.id,
      rawToken,
      role,
      teams:
        teamResult.rows,
    });

    emailQueued = true;
  } catch (emailError) {
    console.error(
      "Team invitation resend queue failed:",
      emailError
    );
  }

  await logAudit({
    userId: actorUserId,
    appId: "goodos",
    action:
      "team.invitation_resent",
    entityType:
      "team_invitation",
    entityId:
      invitation.id,
    ipAddress:
      requestMeta.ipAddress || null,
    metadata: {
      organizationId:
        organization.id,
      email:
        invitation.email,
      emailQueued,
    },
  });

  return {
    ...invitation,
    emailQueued,
  };
}

async function revokeTeamInvitationForUser(
  actorUserId,
  invitationId,
  requestMeta = {}
) {
  const organization =
    await teamProductionRequireManage(
      actorUserId
    );

  const result = await query(
    `
      UPDATE backend_user_invites
      SET
        status = 'revoked',
        updated_at = NOW(),

        metadata_json =
          COALESCE(
            metadata_json,
            '{}'::jsonb
          ) ||
          $3::jsonb

      WHERE id = $1

        AND COALESCE(
          organization_id,
          'org_goodos'
        ) = $2

        AND status = 'pending'

      RETURNING
        id,
        email,
        status,
        updated_at AS "updatedAt"
    `,
    [
      invitationId,
      organization.id,
      JSON.stringify({
        revokedBy:
          actorUserId,
        revokedAt:
          new Date().toISOString(),
      }),
    ]
  );

  if (result.rowCount === 0) {
    throw teamProductionError(
      "Pending invitation was not found.",
      404
    );
  }

  const invitation =
    result.rows[0];

  await logAudit({
    userId: actorUserId,
    appId: "goodos",
    action:
      "team.invitation_revoked",
    entityType:
      "team_invitation",
    entityId:
      invitation.id,
    ipAddress:
      requestMeta.ipAddress || null,
    metadata: {
      organizationId:
        organization.id,
      email:
        invitation.email,
    },
  });

  return invitation;
}

async function acceptTeamInvitationForUser(
  userId,
  rawToken,
  requestMeta = {}
) {
  if (
    !rawToken ||
    String(rawToken).length < 32
  ) {
    throw teamProductionError(
      "Invitation token is invalid.",
      400
    );
  }

  const tokenHash =
    teamProductionHash(
      rawToken
    );

  const accepted =
    await teamProductionTransaction(
      async client => {
        const invitationResult =
          await client.query(
            `
              SELECT
                invitation.*,

                user_account.email
                  AS "currentUserEmail"

              FROM backend_user_invites
                   invitation

              JOIN users user_account
                ON user_account.id =
                   $1::uuid

              WHERE invitation.token_hash =
                    $2

                AND invitation.status =
                    'pending'

                AND invitation.expires_at >
                    NOW()

                AND LOWER(
                  invitation.email
                ) =
                LOWER(
                  user_account.email
                )

              FOR UPDATE
            `,
            [
              userId,
              tokenHash,
            ]
          );

        if (
          invitationResult.rowCount ===
          0
        ) {
          throw teamProductionError(
            "Invitation is invalid, expired, or belongs to another account.",
            400
          );
        }

        const invitation =
          invitationResult.rows[0];

        const organizationResult =
          await client.query(
            `
              SELECT
                id,
                name,
                slug,
                plan,
                status

              FROM backend_organizations

              WHERE id = COALESCE(
                $1,
                'org_goodos'
              )

                AND status = 'active'

              LIMIT 1
            `,
            [
              invitation.organization_id,
            ]
          );

        if (
          organizationResult.rowCount ===
          0
        ) {
          throw teamProductionError(
            "Invitation organization is unavailable.",
            404
          );
        }

        const organization =
          organizationResult.rows[0];

        const metadata =
          invitation.metadata_json || {};

        const role =
          await teamProductionFindRole(
            client,
            organization.id,
            metadata.roleId ||
            metadata.roleName ||
            "role_user"
          );

        const teamIds =
          teamProductionUniqueStrings(
            metadata.teamIds
          );

        const teams =
          await teamProductionApplyActiveMember({
            client,
            organization,
            userId,
            role,
            teamIds,
            actorUserId: userId,
            replaceTeams: false,
          });

        await client.query(
          `
            UPDATE backend_user_invites
            SET
              status = 'accepted',
              accepted_at = NOW(),
              updated_at = NOW()

            WHERE id = $1
          `,
          [
            invitation.id,
          ]
        );

        return {
          invitationId:
            invitation.id,
          organization,
          role,
          teams,
        };
      }
    );

  await logAudit({
    userId,
    appId: "goodos",
    action:
      "team.invitation_accepted",
    entityType:
      "team_invitation",
    entityId:
      accepted.invitationId,
    ipAddress:
      requestMeta.ipAddress || null,
    metadata: {
      organizationId:
        accepted.organization.id,
      roleName:
        accepted.role.name,
      teamIds:
        accepted.teams.map(
          team => team.id
        ),
    },
  });

  return {
    message:
      `You joined ${accepted.organization.name}.`,
    organization:
      accepted.organization,
    role:
      accepted.role,
    teams:
      accepted.teams,
  };
}

async function createTeamRoleForUser(
  actorUserId,
  input = {},
  requestMeta = {}
) {
  const organization =
    await teamProductionRequireRoleManage(
      actorUserId
    );

  const displayName =
    teamProductionText(
      input.displayName,
      80
    );

  const description =
    teamProductionText(
      input.description,
      500
    );

  const level =
    Math.min(
      Math.max(
        Number.parseInt(
          String(input.level || 60),
          10
        ) || 60,
        20
      ),
      99
    );

  const permissionIds =
    teamProductionUniqueStrings(
      input.permissionIds
    );

  if (displayName.length < 2) {
    throw teamProductionError(
      "Role name must contain at least two characters.",
      400
    );
  }

  const baseName =
    teamProductionSlug(
      displayName
    );

  if (!baseName) {
    throw teamProductionError(
      "Role name must contain letters or numbers.",
      400
    );
  }

  const role =
    await teamProductionTransaction(
      async client => {
        const validPermissions =
          permissionIds.length
            ? await client.query(
                `
                  SELECT id
                  FROM backend_permissions
                  WHERE status = 'active'
                    AND id =
                        ANY($1::text[])
                `,
                [
                  permissionIds,
                ]
              )
            : {
                rows: [],
              };

        if (
          validPermissions.rows.length !==
          permissionIds.length
        ) {
          throw teamProductionError(
            "One or more selected permissions are invalid.",
            400
          );
        }

        let roleName =
          `goodos_${baseName}`;

        const existingResult =
          await client.query(
            `
              SELECT name
              FROM backend_roles
              WHERE name LIKE $1
            `,
            [
              `${roleName}%`,
            ]
          );

        const existingNames =
          new Set(
            existingResult.rows.map(
              row => row.name
            )
          );

        let suffix = 2;

        while (
          existingNames.has(
            roleName
          )
        ) {
          roleName =
            `goodos_${baseName}_${suffix}`;

          suffix += 1;
        }

        const roleResult =
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
                project_id,
                environment_id,
                created_by
              )
              VALUES (
                $1,
                $2,
                $3,
                NULLIF($4, ''),
                $5,
                'active',
                $6::jsonb,
                $7,
                'proj_goodos_platform',
                'env_goodos_production',
                $8::uuid
              )
              RETURNING
                id,
                name,
                display_name
                  AS "displayName",
                description,
                level,
                status
            `,
            [
              teamProductionId("role"),
              roleName,
              displayName,
              description,
              level,
              JSON.stringify({
                source:
                  "goodos_teams_custom_role",
                custom: true,
              }),
              organization.id,
              actorUserId,
            ]
          );

        const createdRole =
          roleResult.rows[0];

        for (
          const permissionId
          of permissionIds
        ) {
          await client.query(
            `
              INSERT INTO backend_role_permissions (
                id,
                role_id,
                permission_id,
                status
              )
              VALUES (
                $1,
                $2,
                $3,
                'active'
              )
            `,
            [
              teamProductionId("rp"),
              createdRole.id,
              permissionId,
            ]
          );
        }

        return createdRole;
      }
    );

  await logAudit({
    userId: actorUserId,
    appId: "goodos",
    action: "team.role_created",
    entityType: "team_role",
    entityId: role.id,
    ipAddress:
      requestMeta.ipAddress || null,
    metadata: {
      organizationId:
        organization.id,
      roleName:
        role.name,
      displayName:
        role.displayName,
      permissionIds,
    },
  });

  return role;
}

async function updateTeamRoleForUser(
  actorUserId,
  roleId,
  input = {},
  requestMeta = {}
) {
  const organization =
    await teamProductionRequireRoleManage(
      actorUserId
    );

  const displayName =
    teamProductionText(
      input.displayName,
      80
    );

  const description =
    teamProductionText(
      input.description,
      500
    );

  const level =
    Math.min(
      Math.max(
        Number.parseInt(
          String(input.level || 60),
          10
        ) || 60,
        20
      ),
      99
    );

  const permissionIds =
    teamProductionUniqueStrings(
      input.permissionIds
    );

  if (displayName.length < 2) {
    throw teamProductionError(
      "Role name must contain at least two characters.",
      400
    );
  }

  const role =
    await teamProductionTransaction(
      async client => {
        const currentResult =
          await client.query(
            `
              SELECT
                id,
                name,
                display_name,
                metadata_json

              FROM backend_roles

              WHERE id = $1
                AND organization_id = $2
                AND status = 'active'

              LIMIT 1

              FOR UPDATE
            `,
            [
              roleId,
              organization.id,
            ]
          );

        if (
          currentResult.rowCount === 0
        ) {
          throw teamProductionError(
            "Custom role was not found.",
            404
          );
        }

        const current =
          currentResult.rows[0];

        if (
          current.metadata_json
            ?.source !==
          "goodos_teams_custom_role"
        ) {
          throw teamProductionError(
            "Built-in roles cannot be modified from the Teams screen.",
            409
          );
        }

        const validPermissions =
          permissionIds.length
            ? await client.query(
                `
                  SELECT id
                  FROM backend_permissions
                  WHERE status = 'active'
                    AND id =
                        ANY($1::text[])
                `,
                [
                  permissionIds,
                ]
              )
            : {
                rows: [],
              };

        if (
          validPermissions.rows.length !==
          permissionIds.length
        ) {
          throw teamProductionError(
            "One or more selected permissions are invalid.",
            400
          );
        }

        const updateResult =
          await client.query(
            `
              UPDATE backend_roles
              SET
                display_name = $3,
                description =
                  NULLIF($4, ''),
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
                status
            `,
            [
              roleId,
              organization.id,
              displayName,
              description,
              level,
            ]
          );

        await client.query(
          `
            DELETE FROM backend_role_permissions
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
              INSERT INTO backend_role_permissions (
                id,
                role_id,
                permission_id,
                status
              )
              VALUES (
                $1,
                $2,
                $3,
                'active'
              )
            `,
            [
              teamProductionId("rp"),
              roleId,
              permissionId,
            ]
          );
        }

        return updateResult.rows[0];
      }
    );

  await logAudit({
    userId: actorUserId,
    appId: "goodos",
    action: "team.role_updated",
    entityType: "team_role",
    entityId: role.id,
    ipAddress:
      requestMeta.ipAddress || null,
    metadata: {
      organizationId:
        organization.id,
      roleName:
        role.name,
      displayName:
        role.displayName,
      permissionIds,
    },
  });

  return role;
}

async function archiveTeamRoleForUser(
  actorUserId,
  roleId,
  requestMeta = {}
) {
  const organization =
    await teamProductionRequireRoleManage(
      actorUserId
    );

  const role =
    await teamProductionTransaction(
      async client => {
        const currentResult =
          await client.query(
            `
              SELECT
                id,
                name,
                display_name
                  AS "displayName",
                metadata_json

              FROM backend_roles

              WHERE id = $1
                AND organization_id = $2
                AND status = 'active'

              LIMIT 1

              FOR UPDATE
            `,
            [
              roleId,
              organization.id,
            ]
          );

        if (
          currentResult.rowCount === 0
        ) {
          throw teamProductionError(
            "Custom role was not found.",
            404
          );
        }

        const current =
          currentResult.rows[0];

        if (
          current.metadata_json
            ?.source !==
          "goodos_teams_custom_role"
        ) {
          throw teamProductionError(
            "Built-in roles cannot be archived.",
            409
          );
        }

        const assignedResult =
          await client.query(
            `
              SELECT COUNT(*)::int
                AS assignments

              FROM backend_user_roles

              WHERE role_id = $1
                AND status = 'active'
            `,
            [
              roleId,
            ]
          );

        if (
          assignedResult.rows[0]
            .assignments > 0
        ) {
          throw teamProductionError(
            "Reassign all members before archiving this role.",
            409
          );
        }

        await client.query(
          `
            DELETE FROM backend_role_permissions
            WHERE role_id = $1
          `,
          [
            roleId,
          ]
        );

        const archiveResult =
          await client.query(
            `
              UPDATE backend_roles
              SET
                status = 'inactive',
                updated_at = NOW()

              WHERE id = $1
                AND organization_id = $2

              RETURNING
                id,
                name,
                display_name
                  AS "displayName",
                status
            `,
            [
              roleId,
              organization.id,
            ]
          );

        return archiveResult.rows[0];
      }
    );

  await logAudit({
    userId: actorUserId,
    appId: "goodos",
    action: "team.role_archived",
    entityType: "team_role",
    entityId: role.id,
    ipAddress:
      requestMeta.ipAddress || null,
    metadata: {
      organizationId:
        organization.id,
      roleName:
        role.name,
      displayName:
        role.displayName,
    },
  });

  return role;
}



// GOODOS_TEAM_WORKSPACE_BACKEND_V2

function teamWorkspaceUserIds(values) {
  const userIds =
    teamProductionUniqueStrings(values);

  if (
    userIds.length === 0 ||
    userIds.length > 100
  ) {
    throw teamProductionError(
      "Select between one and one hundred members.",
      400
    );
  }

  const uuidPattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  if (
    userIds.some(
      userId =>
        !uuidPattern.test(userId)
    )
  ) {
    throw teamProductionError(
      "One or more selected member IDs are invalid.",
      400
    );
  }

  return userIds;
}

async function getTeamDetailsForUser(
  userId,
  teamId
) {
  const organization =
    await requireOrganizationForUser(
      userId
    );

  const teamResult = await query(
    `
      SELECT
        team.id,
        team.organization_id
          AS "organizationId",
        team.name,
        team.slug,
        team.description,
        team.status,
        team.created_at
          AS "createdAt",
        team.updated_at
          AS "updatedAt",

        creator.display_name
          AS "createdByName",

        creator.email
          AS "createdByEmail",

        (
          SELECT COUNT(*)::int

          FROM backend_team_memberships
               membership

          WHERE membership.team_id =
                team.id

            AND membership.status =
                'active'
        ) AS "activeMembers",

        (
          SELECT COUNT(*)::int

          FROM backend_team_memberships
               membership

          WHERE membership.team_id =
                team.id
        ) AS "totalMembershipRecords"

      FROM backend_teams team

      LEFT JOIN users creator
        ON creator.id =
           team.created_by

      WHERE team.id = $1
        AND team.organization_id = $2

      LIMIT 1
    `,
    [
      teamId,
      organization.id,
    ]
  );

  if (teamResult.rowCount === 0) {
    throw teamProductionError(
      "Team was not found.",
      404
    );
  }

  const [
    membersResult,
    invitationResult,
    activityResult,
  ] = await Promise.all([
    query(
      `
        SELECT
          membership.id
            AS "membershipId",

          membership.user_id
            AS "userId",

          membership.role_id
            AS "roleId",

          membership.status,

          membership.created_at
            AS "joinedAt",

          membership.updated_at
            AS "updatedAt",

          user_account.email,

          user_account.display_name
            AS "displayName",

          user_account.first_name
            AS "firstName",

          user_account.last_name
            AS "lastName",

          user_account.status
            AS "accountStatus",

          user_account.email_verified
            AS "emailVerified",

          role.name
            AS "roleName",

          role.display_name
            AS "roleDisplayName"

        FROM backend_team_memberships
             membership

        JOIN users user_account
          ON user_account.id =
             membership.user_id

        LEFT JOIN backend_roles role
          ON role.id =
             membership.role_id

        WHERE membership.team_id = $1
          AND membership.status =
              'active'

        ORDER BY
          CASE role.name
            WHEN 'owner' THEN 1
            WHEN 'admin' THEN 2
            WHEN 'manager' THEN 3
            ELSE 4
          END,

          COALESCE(
            user_account.display_name,
            user_account.email
          )
      `,
      [
        teamId,
      ]
    ),

    query(
      `
        SELECT
          invitation.id,
          invitation.email,
          invitation.status,

          invitation.expires_at
            AS "expiresAt",

          invitation.created_at
            AS "createdAt",

          invitation.metadata_json
            AS metadata

        FROM backend_user_invites
             invitation

        WHERE COALESCE(
          invitation.organization_id,
          'org_goodos'
        ) = $1

          AND invitation.status =
              'pending'

          AND invitation.expires_at >
              NOW()

          AND COALESCE(
            invitation.metadata_json
              -> 'teamIds',
            '[]'::jsonb
          ) ? $2

        ORDER BY
          invitation.created_at DESC
      `,
      [
        organization.id,
        teamId,
      ]
    ),

    query(
      `
        SELECT
          audit.id,
          audit.action,

          audit.entity_type
            AS "entityType",

          audit.entity_id
            AS "entityId",

          audit.metadata,

          audit.created_at
            AS "createdAt",

          actor.display_name
            AS "actorName",

          actor.email
            AS "actorEmail"

        FROM audit_logs audit

        LEFT JOIN users actor
          ON actor.id =
             audit.user_id

        WHERE audit.metadata
                ->> 'organizationId'
              = $1

          AND (
            audit.entity_id = $2

            OR audit.metadata
                 ->> 'teamId'
               = $2

            OR COALESCE(
              audit.metadata
                -> 'teamIds',
              '[]'::jsonb
            ) ? $2
          )

        ORDER BY
          audit.created_at DESC

        LIMIT 50
      `,
      [
        organization.id,
        teamId,
      ]
    ),
  ]);

  return {
    organization,
    team: teamResult.rows[0],
    members: membersResult.rows,
    pendingInvitations:
      invitationResult.rows,
    activity: activityResult.rows,
  };
}

async function upsertTeamMembershipForUser(
  actorUserId,
  teamId,
  targetUserId,
  input = {},
  requestMeta = {}
) {
  const organization =
    await teamProductionRequireManage(
      actorUserId
    );

  const result =
    await teamProductionTransaction(
      async client => {
        const team =
          await teamProductionFindTeam(
            client,
            organization.id,
            teamId,
            false
          );

        const role =
          await teamProductionFindRole(
            client,
            organization.id,
            input.roleId ||
            input.roleName
          );

        const memberResult =
          await client.query(
            `
              SELECT
                membership.user_id
                  AS "userId",

                user_account.email,

                user_account.display_name
                  AS "displayName"

              FROM backend_organization_memberships
                   membership

              JOIN users user_account
                ON user_account.id =
                   membership.user_id

              WHERE membership.organization_id =
                    $1

                AND membership.user_id =
                    $2::uuid

                AND membership.status =
                    'active'

                AND user_account.status =
                    'active'

              LIMIT 1
            `,
            [
              organization.id,
              targetUserId,
            ]
          );

        if (
          memberResult.rowCount === 0
        ) {
          throw teamProductionError(
            "The selected user is not an active organization member.",
            404
          );
        }

        const membershipResult =
          await client.query(
            `
              INSERT INTO backend_team_memberships (
                id,
                team_id,
                user_id,
                role_id,
                status,
                added_by,
                metadata_json
              )
              VALUES (
                $1,
                $2,
                $3::uuid,
                $4,
                'active',
                $5::uuid,
                $6::jsonb
              )

              ON CONFLICT (
                team_id,
                user_id
              )
              DO UPDATE SET
                role_id =
                  EXCLUDED.role_id,

                status =
                  'active',

                added_by =
                  EXCLUDED.added_by,

                metadata_json =
                  EXCLUDED.metadata_json,

                updated_at =
                  NOW()

              RETURNING
                id,
                team_id
                  AS "teamId",
                user_id
                  AS "userId",
                role_id
                  AS "roleId",
                status,
                created_at
                  AS "createdAt",
                updated_at
                  AS "updatedAt"
            `,
            [
              teamProductionId(
                "teammem"
              ),
              team.id,
              targetUserId,
              role.id,
              actorUserId,
              JSON.stringify({
                source:
                  "goodos_team_workspace_v2",
              }),
            ]
          );

        return {
          team,
          role,
          member:
            memberResult.rows[0],
          membership:
            membershipResult.rows[0],
        };
      }
    );

  await logAudit({
    userId: actorUserId,
    appId: "goodos",
    action:
      "team.membership_updated",
    entityType:
      "team_member",
    entityId:
      targetUserId,
    ipAddress:
      requestMeta.ipAddress ||
      null,
    metadata: {
      organizationId:
        organization.id,
      teamId:
        result.team.id,
      teamName:
        result.team.name,
      targetUserId,
      email:
        result.member.email,
      roleId:
        result.role.id,
      roleName:
        result.role.name,
    },
  });

  return {
    ...result.membership,
    teamName:
      result.team.name,
    roleName:
      result.role.name,
    roleDisplayName:
      result.role.displayName,
    email:
      result.member.email,
    displayName:
      result.member.displayName,
  };
}

async function removeTeamMembershipForUser(
  actorUserId,
  teamId,
  targetUserId,
  requestMeta = {}
) {
  const organization =
    await teamProductionRequireManage(
      actorUserId
    );

  const teamResult = await query(
    `
      SELECT
        id,
        name

      FROM backend_teams

      WHERE id = $1
        AND organization_id = $2

      LIMIT 1
    `,
    [
      teamId,
      organization.id,
    ]
  );

  if (teamResult.rowCount === 0) {
    throw teamProductionError(
      "Team was not found.",
      404
    );
  }

  const result = await query(
    `
      UPDATE backend_team_memberships
      SET
        status = 'removed',
        updated_at = NOW()

      WHERE team_id = $1
        AND user_id = $2::uuid
        AND status = 'active'

      RETURNING
        id,
        team_id AS "teamId",
        user_id AS "userId",
        role_id AS "roleId",
        status,
        updated_at AS "updatedAt"
    `,
    [
      teamId,
      targetUserId,
    ]
  );

  if (result.rowCount === 0) {
    throw teamProductionError(
      "Active team membership was not found.",
      404
    );
  }

  await logAudit({
    userId: actorUserId,
    appId: "goodos",
    action:
      "team.membership_removed",
    entityType:
      "team_member",
    entityId:
      targetUserId,
    ipAddress:
      requestMeta.ipAddress ||
      null,
    metadata: {
      organizationId:
        organization.id,
      teamId,
      teamName:
        teamResult.rows[0].name,
      targetUserId,
    },
  });

  return result.rows[0];
}

async function bulkTeamMembershipForUser(
  actorUserId,
  input = {},
  requestMeta = {}
) {
  const organization =
    await teamProductionRequireManage(
      actorUserId
    );

  const action =
    String(
      input.action || ""
    ).toLowerCase();

  if (
    ![
      "assign",
      "remove",
    ].includes(action)
  ) {
    throw teamProductionError(
      "Bulk team action must be assign or remove.",
      400
    );
  }

  const userIds =
    teamWorkspaceUserIds(
      input.userIds
    );

  const result =
    await teamProductionTransaction(
      async client => {
        const team =
          await teamProductionFindTeam(
            client,
            organization.id,
            input.teamId,
            action === "remove"
          );

        const memberResult =
          await client.query(
            `
              SELECT
                membership.user_id
                  AS "userId"

              FROM backend_organization_memberships
                   membership

              JOIN users user_account
                ON user_account.id =
                   membership.user_id

              WHERE membership.organization_id =
                    $1

                AND membership.user_id =
                    ANY($2::uuid[])

                AND membership.status =
                    'active'

                AND user_account.status =
                    'active'
            `,
            [
              organization.id,
              userIds,
            ]
          );

        if (
          memberResult.rows.length !==
          userIds.length
        ) {
          throw teamProductionError(
            "One or more selected users are not active organization members.",
            400
          );
        }

        let role = null;

        if (action === "assign") {
          role =
            await teamProductionFindRole(
              client,
              organization.id,
              input.roleId ||
              input.roleName
            );

          for (
            const targetUserId
            of userIds
          ) {
            await client.query(
              `
                INSERT INTO backend_team_memberships (
                  id,
                  team_id,
                  user_id,
                  role_id,
                  status,
                  added_by,
                  metadata_json
                )
                VALUES (
                  $1,
                  $2,
                  $3::uuid,
                  $4,
                  'active',
                  $5::uuid,
                  $6::jsonb
                )

                ON CONFLICT (
                  team_id,
                  user_id
                )
                DO UPDATE SET
                  role_id =
                    EXCLUDED.role_id,

                  status =
                    'active',

                  added_by =
                    EXCLUDED.added_by,

                  metadata_json =
                    EXCLUDED.metadata_json,

                  updated_at =
                    NOW()
              `,
              [
                teamProductionId(
                  "teammem"
                ),
                team.id,
                targetUserId,
                role.id,
                actorUserId,
                JSON.stringify({
                  source:
                    "goodos_team_workspace_bulk_v2",
                }),
              ]
            );
          }
        } else {
          await client.query(
            `
              UPDATE backend_team_memberships
              SET
                status = 'removed',
                updated_at = NOW()

              WHERE team_id = $1
                AND user_id =
                    ANY($2::uuid[])
                AND status = 'active'
            `,
            [
              team.id,
              userIds,
            ]
          );
        }

        return {
          team,
          role,
          userIds,
          action,
        };
      }
    );

  await logAudit({
    userId: actorUserId,
    appId: "goodos",
    action:
      result.action === "assign"
        ? "team.members_bulk_assigned"
        : "team.members_bulk_removed",
    entityType: "team",
    entityId: result.team.id,
    ipAddress:
      requestMeta.ipAddress ||
      null,
    metadata: {
      organizationId:
        organization.id,
      teamId:
        result.team.id,
      teamName:
        result.team.name,
      userIds:
        result.userIds,
      roleId:
        result.role?.id || null,
      roleName:
        result.role?.name || null,
      count:
        result.userIds.length,
    },
  });

  return {
    teamId:
      result.team.id,
    teamName:
      result.team.name,
    action:
      result.action,
    updatedMembers:
      result.userIds.length,
    roleId:
      result.role?.id || null,
    roleName:
      result.role?.name || null,
  };
}


module.exports = {
  getSchemaHealth,
  getOrganizationForUser,
  getSummaryForUser,
  getMembersForUser,
  getRolesForUser,
  getTeamsForUser,
  getInvitationsForUser,
  getActivityForUser,

  getTeamPermissionsForUser,
  createTeamForUser,
  updateTeamForUser,
  updateTeamMemberForUser,
  inviteTeamMemberForUser,
  resendTeamInvitationForUser,
  revokeTeamInvitationForUser,
  acceptTeamInvitationForUser,
  createTeamRoleForUser,
  updateTeamRoleForUser,
  archiveTeamRoleForUser,

  getTeamDetailsForUser,
  upsertTeamMembershipForUser,
  removeTeamMembershipForUser,
  bulkTeamMembershipForUser,
};
