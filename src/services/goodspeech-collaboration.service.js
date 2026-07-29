"use strict";

const { pool, query } = require("../config/database");
const notificationService = require("./notification.service");

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ELEVATED_ROLES = new Set(["owner", "admin", "manager"]);
const PROJECT_STATUSES = new Set(["planning", "active", "review", "completed", "archived"]);
const TASK_STATUSES = new Set(["todo", "in_progress", "blocked", "review", "done"]);
const PROJECT_ROLES = new Set(["owner", "editor", "reviewer"]);

function serviceError(message, statusCode = 400, code = "GOODSPEECH_COLLABORATION_INVALID") {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function boundedText(value, maximum) {
  return String(value || "").trim().slice(0, maximum + 1);
}

function requireText(value, label, maximum) {
  const text = boundedText(value, maximum);
  if (!text) throw serviceError(`${label} is required.`);
  if (text.length > maximum) throw serviceError(`${label} is too long.`, 413);
  return text;
}

function requireUuid(value, label = "ID") {
  const id = String(value || "").trim();
  if (!UUID_PATTERN.test(id)) throw serviceError(`A valid ${label} is required.`);
  return id;
}

function requireTeamId(value) {
  const id = String(value || "").trim();
  if (!/^[A-Za-z0-9_-]{2,120}$/.test(id)) throw serviceError("A valid team is required.");
  return id;
}

function uniqueUserIds(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map((value) => String(value || "").trim()).filter((value) => UUID_PATTERN.test(value)))].slice(0, 100);
}

function roleFromContext(context) {
  return String(context?.organization?.membershipRole || "").trim().toLowerCase();
}

function isElevated(context) {
  return ELEVATED_ROLES.has(roleFromContext(context));
}

function slugify(value) {
  const slug = String(value || "").trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
  if (!slug) throw serviceError("Enter a channel name.");
  return slug;
}

function directKey(userIds) {
  return [...userIds].sort().map((id) => id.replaceAll("-", "")).join("-");
}

function displayNameExpression(alias) {
  return `COALESCE(
    NULLIF(${alias}.display_name, ''),
    NULLIF(CONCAT_WS(' ', ${alias}.first_name, ${alias}.last_name), ''),
    SPLIT_PART(${alias}.email, '@', 1),
    'Team member'
  )`;
}

function avatarExpression(alias) {
  return `COALESCE(
    TO_JSONB(${alias})->>'avatar_url',
    TO_JSONB(${alias})->>'profile_image_url',
    TO_JSONB(${alias})->'auth_metadata_json'->>'picture'
  )`;
}

async function requireTeamAccess({ teamId, context, userId, client = { query } }) {
  const result = await client.query(
    `SELECT team.id, team.name, team.slug, team.description, team.status,
            role.name AS "teamRole"
     FROM backend_teams team
     LEFT JOIN backend_team_memberships membership
       ON membership.team_id = team.id
      AND membership.user_id = $3::uuid
      AND membership.status = 'active'
     LEFT JOIN backend_roles role ON role.id = membership.role_id
     WHERE team.id = $1
       AND team.organization_id = $2
       AND team.status = 'active'
       AND ($4::boolean OR membership.user_id IS NOT NULL)
     LIMIT 1`,
    [requireTeamId(teamId), context.organizationId, userId, isElevated(context)]
  );
  if (!result.rows[0]) {
    throw serviceError("Team not found or unavailable.", 404, "GOODSPEECH_TEAM_NOT_FOUND");
  }
  return result.rows[0];
}

async function listTeams({ context, userId }) {
  const result = await query(
    `SELECT team.id, team.name, team.slug, team.description, team.status,
            team.created_at AS "createdAt", team.updated_at AS "updatedAt",
            role.name AS "currentUserRole",
            COUNT(all_members.id) FILTER (WHERE all_members.status = 'active')::integer AS "activeMembers"
     FROM backend_teams team
     LEFT JOIN backend_team_memberships own_membership
       ON own_membership.team_id = team.id
      AND own_membership.user_id = $2::uuid
      AND own_membership.status = 'active'
     LEFT JOIN backend_roles role ON role.id = own_membership.role_id
     LEFT JOIN backend_team_memberships all_members ON all_members.team_id = team.id
     WHERE team.organization_id = $1
       AND team.status = 'active'
       AND ($3::boolean OR own_membership.user_id IS NOT NULL)
     GROUP BY team.id, role.name
     ORDER BY team.name`,
    [context.organizationId, userId, isElevated(context)]
  );
  return result.rows;
}

async function listMembers({ context, userId, teamId = null }) {
  if (teamId) await requireTeamAccess({ teamId, context, userId });
  const result = await query(
    `SELECT user_account.id, user_account.email,
            user_account.first_name AS "firstName",
            user_account.last_name AS "lastName",
            ${displayNameExpression("user_account")} AS "displayName",
            ${avatarExpression("user_account")} AS "avatarUrl",
            organization_membership.role AS "organizationRole",
            team_scope.team_ids AS "teamIds",
            team_scope.team_role AS "teamRole"
     FROM backend_organization_memberships organization_membership
     JOIN users user_account ON user_account.id = organization_membership.user_id
     LEFT JOIN LATERAL (
       SELECT ARRAY_AGG(team_membership.team_id ORDER BY team_membership.team_id) AS team_ids,
              MAX(team_role.name) AS team_role
       FROM backend_team_memberships team_membership
       LEFT JOIN backend_roles team_role ON team_role.id = team_membership.role_id
       WHERE team_membership.user_id = user_account.id
         AND team_membership.status = 'active'
     ) team_scope ON TRUE
     WHERE organization_membership.organization_id = $1
       AND organization_membership.status = 'active'
       AND user_account.status <> 'deleted'
       AND ($2::text IS NULL OR $2 = ANY(COALESCE(team_scope.team_ids, ARRAY[]::text[])))
     ORDER BY CASE organization_membership.role
       WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'manager' THEN 2 ELSE 3 END,
       ${displayNameExpression("user_account")}`,
    [context.organizationId, teamId ? requireTeamId(teamId) : null]
  );
  return result.rows;
}

async function syncTeamChannels({ context, userId }) {
  const teams = await listTeams({ context, userId });
  if (!teams.length) return teams;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const team of teams) {
      const channelResult = await client.query(
        `INSERT INTO goodspeech_chat_channels (
           organization_id, team_id, name, slug, description, channel_kind, created_by_user_id
         ) VALUES ($1, $2, 'General', 'general', 'Team-wide production coordination.', 'team', $3::uuid)
         ON CONFLICT (organization_id, team_id, slug)
           WHERE channel_kind = 'team' AND archived_at IS NULL
         DO UPDATE SET updated_at = goodspeech_chat_channels.updated_at
         RETURNING id`,
        [context.organizationId, team.id, userId]
      );
      await client.query(
        `INSERT INTO goodspeech_chat_channel_members (channel_id, user_id)
         SELECT $1::uuid, membership.user_id
         FROM backend_team_memberships membership
         WHERE membership.team_id = $2 AND membership.status = 'active'
         ON CONFLICT (channel_id, user_id) DO NOTHING`,
        [channelResult.rows[0].id, team.id]
      );
    }
    await client.query(
      `INSERT INTO goodspeech_chat_channel_members (channel_id, user_id)
       SELECT channel_record.id, membership.user_id
       FROM goodspeech_chat_channels channel_record
       JOIN backend_team_memberships membership
         ON membership.team_id = channel_record.team_id
        AND membership.status = 'active'
       WHERE channel_record.organization_id = $1
         AND channel_record.channel_kind IN ('team', 'project')
         AND channel_record.archived_at IS NULL
       ON CONFLICT (channel_id, user_id) DO NOTHING`,
      [context.organizationId]
    );
    await client.query("COMMIT");
    return teams;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function projectAccessSql(projectAlias = "project_record") {
  return `(
    $3::boolean OR EXISTS (
      SELECT 1 FROM backend_team_memberships team_access
      WHERE team_access.team_id = ${projectAlias}.team_id
        AND team_access.user_id = $2::uuid
        AND team_access.status = 'active'
    )
  )`;
}

async function listProjects({ context, userId, teamId = null }) {
  if (teamId) await requireTeamAccess({ teamId, context, userId });
  const result = await query(
    `SELECT project_record.id, project_record.team_id AS "teamId",
            team.name AS "teamName", project_record.name, project_record.description,
            project_record.status, project_record.due_at AS "dueAt",
            project_record.created_by_user_id AS "createdByUserId",
            project_record.created_at AS "createdAt", project_record.updated_at AS "updatedAt",
            COUNT(DISTINCT member.user_id)::integer AS "memberCount",
            COUNT(DISTINCT task.id)::integer AS "taskCount",
            COUNT(DISTINCT task.id) FILTER (WHERE task.status = 'done')::integer AS "completedTaskCount",
            project_channel.id AS "channelId"
     FROM goodspeech_projects project_record
     JOIN backend_teams team ON team.id = project_record.team_id
     LEFT JOIN goodspeech_project_members member ON member.project_id = project_record.id
     LEFT JOIN goodspeech_project_tasks task ON task.project_id = project_record.id
     LEFT JOIN goodspeech_chat_channels project_channel
       ON project_channel.project_id = project_record.id
      AND project_channel.channel_kind = 'project'
      AND project_channel.archived_at IS NULL
     WHERE project_record.organization_id = $1
       AND project_record.archived_at IS NULL
       AND ${projectAccessSql()}
       AND ($4::text IS NULL OR project_record.team_id = $4)
     GROUP BY project_record.id, team.name, project_channel.id
     ORDER BY CASE project_record.status
       WHEN 'active' THEN 0 WHEN 'review' THEN 1 WHEN 'planning' THEN 2 WHEN 'completed' THEN 3 ELSE 4 END,
       project_record.updated_at DESC`,
    [context.organizationId, userId, isElevated(context), teamId ? requireTeamId(teamId) : null]
  );
  return result.rows;
}

async function requireProjectAccess({ projectId, context, userId, manage = false, client = { query } }) {
  const result = await client.query(
    `SELECT project_record.*, team.name AS team_name,
            project_member.project_role,
            team_role.name AS team_role
     FROM goodspeech_projects project_record
     JOIN backend_teams team ON team.id = project_record.team_id
     LEFT JOIN goodspeech_project_members project_member
       ON project_member.project_id = project_record.id
      AND project_member.user_id = $3::uuid
     LEFT JOIN backend_team_memberships team_member
       ON team_member.team_id = project_record.team_id
      AND team_member.user_id = $3::uuid
      AND team_member.status = 'active'
     LEFT JOIN backend_roles team_role ON team_role.id = team_member.role_id
     WHERE project_record.id = $1::uuid
       AND project_record.organization_id = $2
       AND project_record.archived_at IS NULL
       AND ($4::boolean OR team_member.user_id IS NOT NULL)
     LIMIT 1`,
    [requireUuid(projectId, "project ID"), context.organizationId, userId, isElevated(context)]
  );
  const project = result.rows[0];
  if (!project) throw serviceError("Project not found or unavailable.", 404, "GOODSPEECH_PROJECT_NOT_FOUND");
  const projectRole = String(project.project_role || "").toLowerCase();
  const teamRole = String(project.team_role || "").toLowerCase();
  project.canManage = isElevated(context) || ["owner", "editor"].includes(projectRole) || ELEVATED_ROLES.has(teamRole);
  if (manage && !project.canManage) {
    throw serviceError("Project editor access is required.", 403, "GOODSPEECH_PROJECT_EDIT_FORBIDDEN");
  }
  return project;
}

async function validateProjectMembers(client, teamId, userIds) {
  if (!userIds.length) return [];
  const result = await client.query(
    `SELECT membership.user_id
     FROM backend_team_memberships membership
     JOIN users user_account ON user_account.id = membership.user_id
     WHERE membership.team_id = $1
       AND membership.status = 'active'
       AND user_account.status <> 'deleted'
       AND membership.user_id = ANY($2::uuid[])`,
    [teamId, userIds]
  );
  if (result.rows.length !== userIds.length) {
    throw serviceError("Every project collaborator must be an active member of the selected team.");
  }
  return result.rows.map((row) => row.user_id);
}

async function replaceProjectMembers(client, projectId, teamId, actorUserId, memberUserIds) {
  const requested = [...new Set([actorUserId, ...uniqueUserIds(memberUserIds)])];
  await validateProjectMembers(client, teamId, requested.filter((memberId) => memberId !== actorUserId));
  await client.query(
    `DELETE FROM goodspeech_project_members
     WHERE project_id = $1::uuid AND user_id <> ALL($2::uuid[])`,
    [projectId, requested]
  );
  await client.query(
    `INSERT INTO goodspeech_project_members (
       project_id, user_id, project_role, added_by_user_id
     )
     SELECT $1::uuid, member_id,
            CASE WHEN member_id = $2::uuid THEN 'owner' ELSE 'editor' END,
            $2::uuid
     FROM UNNEST($3::uuid[]) member_id
     ON CONFLICT (project_id, user_id)
     DO UPDATE SET updated_at = NOW()`,
    [projectId, actorUserId, requested]
  );
  return requested;
}

async function createProject({ payload, context, userId }) {
  const team = await requireTeamAccess({ teamId: payload?.teamId, context, userId });
  const name = requireText(payload?.name, "Project name", 120);
  const description = boundedText(payload?.description, 2000);
  if (description.length > 2000) throw serviceError("Project description is too long.", 413);
  const dueAt = payload?.dueAt ? new Date(String(payload.dueAt)) : null;
  if (dueAt && Number.isNaN(dueAt.getTime())) throw serviceError("Choose a valid due date.");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const inserted = await client.query(
      `INSERT INTO goodspeech_projects (
         organization_id, team_id, name, description, status, due_at,
         created_by_user_id, updated_by_user_id
       ) VALUES ($1, $2, $3, $4, 'planning', $5, $6::uuid, $6::uuid)
       RETURNING *`,
      [context.organizationId, team.id, name, description, dueAt ? dueAt.toISOString() : null, userId]
    );
    const project = inserted.rows[0];
    await replaceProjectMembers(client, project.id, team.id, userId, payload?.memberUserIds);
    const channelResult = await client.query(
      `INSERT INTO goodspeech_chat_channels (
         organization_id, team_id, project_id, name, slug, description, channel_kind, created_by_user_id
       ) VALUES ($1, $2, $3::uuid, $4, 'project', $5, 'project', $6::uuid)
       RETURNING id`,
      [context.organizationId, team.id, project.id, name, `${name} project collaboration`, userId]
    );
    await client.query(
      `INSERT INTO goodspeech_chat_channel_members (channel_id, user_id, member_role)
       SELECT $1::uuid, membership.user_id,
              CASE WHEN membership.user_id = $3::uuid THEN 'owner' ELSE 'member' END
       FROM backend_team_memberships membership
       WHERE membership.team_id = $2 AND membership.status = 'active'
       ON CONFLICT (channel_id, user_id) DO NOTHING`,
      [channelResult.rows[0].id, team.id, userId]
    );
    await client.query(
      `INSERT INTO goodspeech_chat_messages (
         channel_id, organization_id, sender_user_id, message_type, body, metadata
       ) VALUES ($1::uuid, $2, $3::uuid, 'system', $4, $5::jsonb)`,
      [
        channelResult.rows[0].id,
        context.organizationId,
        userId,
        `${name} is ready for the team.`,
        JSON.stringify({ event: "project.created", projectId: project.id }),
      ]
    );
    await client.query("COMMIT");
    return { id: project.id, channelId: channelResult.rows[0].id };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function updateProject({ projectId, payload, context, userId }) {
  const project = await requireProjectAccess({ projectId, context, userId, manage: true });
  const fields = {
    name: payload?.name === undefined ? project.name : requireText(payload.name, "Project name", 120),
    description: payload?.description === undefined ? project.description : boundedText(payload.description, 2000),
    status: payload?.status === undefined ? project.status : String(payload.status),
    dueAt: payload?.dueAt === undefined ? project.due_at : payload.dueAt ? new Date(String(payload.dueAt)) : null,
  };
  if (!PROJECT_STATUSES.has(fields.status)) throw serviceError("Choose a valid project status.");
  if (fields.description.length > 2000) throw serviceError("Project description is too long.", 413);
  if (fields.dueAt && Number.isNaN(fields.dueAt.getTime())) throw serviceError("Choose a valid due date.");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE goodspeech_projects
       SET name = $1, description = $2, status = $3, due_at = $4,
           updated_by_user_id = $5::uuid, updated_at = NOW(),
           archived_at = CASE WHEN $3 = 'archived' THEN NOW() ELSE NULL END
       WHERE id = $6::uuid`,
      [fields.name, fields.description, fields.status, fields.dueAt ? fields.dueAt.toISOString() : null, userId, project.id]
    );
    if (payload?.memberUserIds !== undefined) {
      await replaceProjectMembers(client, project.id, project.team_id, userId, payload.memberUserIds);
    }
    await client.query(
      `UPDATE goodspeech_chat_channels
       SET name = $1, updated_at = NOW(),
           archived_at = CASE WHEN $2 = 'archived' THEN NOW() ELSE NULL END
       WHERE project_id = $3::uuid`,
      [fields.name, fields.status, project.id]
    );
    await client.query("COMMIT");
    return { id: project.id };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function getProject({ projectId, context, userId }) {
  const project = await requireProjectAccess({ projectId, context, userId });
  const [members, tasks, channel] = await Promise.all([
    query(
      `SELECT member.user_id AS "userId", member.project_role AS "projectRole",
              ${displayNameExpression("user_account")} AS "displayName",
              user_account.email, ${avatarExpression("user_account")} AS "avatarUrl"
       FROM goodspeech_project_members member
       JOIN users user_account ON user_account.id = member.user_id
       WHERE member.project_id = $1::uuid
       ORDER BY CASE member.project_role WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END,
                ${displayNameExpression("user_account")}`,
      [project.id]
    ),
    query(
      `SELECT task.id, task.title, task.description, task.status,
              task.assignee_user_id AS "assigneeUserId", task.due_at AS "dueAt",
              task.sort_order AS "sortOrder", task.created_at AS "createdAt",
              task.updated_at AS "updatedAt",
              ${displayNameExpression("assignee")} AS "assigneeName"
       FROM goodspeech_project_tasks task
       LEFT JOIN users assignee ON assignee.id = task.assignee_user_id
       WHERE task.project_id = $1::uuid
       ORDER BY task.sort_order, task.created_at`,
      [project.id]
    ),
    query(
      `SELECT id FROM goodspeech_chat_channels
       WHERE project_id = $1::uuid AND archived_at IS NULL LIMIT 1`,
      [project.id]
    ),
  ]);
  return {
    project: {
      id: project.id,
      teamId: project.team_id,
      teamName: project.team_name,
      name: project.name,
      description: project.description,
      status: project.status,
      dueAt: project.due_at,
      createdAt: project.created_at,
      updatedAt: project.updated_at,
      canManage: project.canManage,
      channelId: channel.rows[0]?.id || null,
    },
    members: members.rows,
    tasks: tasks.rows,
  };
}

async function createTask({ projectId, payload, context, userId }) {
  const project = await requireProjectAccess({ projectId, context, userId, manage: true });
  const title = requireText(payload?.title, "Task title", 180);
  const description = boundedText(payload?.description, 2000);
  const assigneeUserId = payload?.assigneeUserId ? requireUuid(payload.assigneeUserId, "assignee ID") : null;
  const dueAt = payload?.dueAt ? new Date(String(payload.dueAt)) : null;
  if (dueAt && Number.isNaN(dueAt.getTime())) throw serviceError("Choose a valid task due date.");
  if (assigneeUserId) await validateProjectMembers({ query }, project.team_id, [assigneeUserId]);
  const result = await query(
    `INSERT INTO goodspeech_project_tasks (
       project_id, title, description, assignee_user_id, due_at, sort_order,
       created_by_user_id, updated_by_user_id
     ) VALUES (
       $1::uuid, $2, $3, $4::uuid, $5,
       COALESCE((SELECT MAX(sort_order) + 1 FROM goodspeech_project_tasks WHERE project_id = $1::uuid), 0),
       $6::uuid, $6::uuid
     ) RETURNING id`,
    [project.id, title, description, assigneeUserId, dueAt ? dueAt.toISOString() : null, userId]
  );
  await query("UPDATE goodspeech_projects SET updated_at = NOW() WHERE id = $1::uuid", [project.id]);
  return { id: result.rows[0].id };
}

async function updateTask({ projectId, taskId, payload, context, userId }) {
  const project = await requireProjectAccess({ projectId, context, userId, manage: true });
  const current = await query(
    `SELECT * FROM goodspeech_project_tasks WHERE id = $1::uuid AND project_id = $2::uuid LIMIT 1`,
    [requireUuid(taskId, "task ID"), project.id]
  );
  const task = current.rows[0];
  if (!task) throw serviceError("Task not found.", 404, "GOODSPEECH_TASK_NOT_FOUND");
  const title = payload?.title === undefined ? task.title : requireText(payload.title, "Task title", 180);
  const description = payload?.description === undefined ? task.description : boundedText(payload.description, 2000);
  const status = payload?.status === undefined ? task.status : String(payload.status);
  if (!TASK_STATUSES.has(status)) throw serviceError("Choose a valid task status.");
  const assigneeUserId = payload?.assigneeUserId === undefined
    ? task.assignee_user_id
    : payload.assigneeUserId ? requireUuid(payload.assigneeUserId, "assignee ID") : null;
  if (assigneeUserId) await validateProjectMembers({ query }, project.team_id, [assigneeUserId]);
  const dueAt = payload?.dueAt === undefined ? task.due_at : payload.dueAt ? new Date(String(payload.dueAt)) : null;
  if (dueAt && Number.isNaN(dueAt.getTime())) throw serviceError("Choose a valid task due date.");
  await query(
    `UPDATE goodspeech_project_tasks
     SET title = $1, description = $2, status = $3, assignee_user_id = $4::uuid,
         due_at = $5, updated_by_user_id = $6::uuid, updated_at = NOW()
     WHERE id = $7::uuid`,
    [title, description, status, assigneeUserId, dueAt ? new Date(dueAt).toISOString() : null, userId, task.id]
  );
  await query("UPDATE goodspeech_projects SET updated_at = NOW() WHERE id = $1::uuid", [project.id]);
  return { id: task.id };
}

function channelAccessSql(alias = "channel_record") {
  return `(
    ($3::boolean AND ${alias}.organization_id = $1)
    OR (${alias}.channel_kind = 'direct' AND EXISTS (
      SELECT 1 FROM goodspeech_chat_channel_members direct_access
      WHERE direct_access.channel_id = ${alias}.id AND direct_access.user_id = $2::uuid
    ))
    OR (${alias}.channel_kind IN ('team', 'project') AND EXISTS (
      SELECT 1 FROM backend_team_memberships team_access
      WHERE team_access.team_id = ${alias}.team_id
        AND team_access.user_id = $2::uuid
        AND team_access.status = 'active'
    ))
  )`;
}

function rowToChannel(row) {
  return {
    id: row.id,
    teamId: row.team_id || null,
    teamName: row.team_name || null,
    projectId: row.project_id || null,
    name: row.channel_kind === "direct" && row.direct_partner_name ? row.direct_partner_name : row.name,
    slug: row.slug,
    description: row.description,
    kind: row.channel_kind,
    unreadCount: Number(row.unread_count || 0),
    memberCount: Number(row.member_count || 0),
    lastReadAt: row.last_read_at || null,
    directParticipant: row.direct_partner_id ? {
      id: row.direct_partner_id,
      displayName: row.direct_partner_name,
      avatarUrl: row.direct_partner_avatar_url || null,
    } : null,
    lastMessage: row.last_message_id ? {
      id: row.last_message_id,
      body: row.last_message_body,
      createdAt: row.last_message_created_at,
      senderName: row.last_message_sender_name,
    } : null,
  };
}

async function requireChannelAccess({ channelId, context, userId, client = { query } }) {
  const result = await client.query(
    `SELECT channel_record.*, team.name AS team_name
     FROM goodspeech_chat_channels channel_record
     LEFT JOIN backend_teams team ON team.id = channel_record.team_id
     WHERE channel_record.id = $4::uuid
       AND channel_record.organization_id = $1
       AND channel_record.archived_at IS NULL
       AND ${channelAccessSql()}
     LIMIT 1`,
    [context.organizationId, userId, isElevated(context), requireUuid(channelId, "channel ID")]
  );
  if (!result.rows[0]) throw serviceError("Chat channel not found.", 404, "GOODSPEECH_CHANNEL_NOT_FOUND");
  return result.rows[0];
}

async function listChannels({ context, userId }) {
  await syncTeamChannels({ context, userId });
  const result = await query(
    `SELECT channel_record.*, team.name AS team_name, member.last_read_at,
            COALESCE(unread.unread_count, 0)::integer AS unread_count,
            COALESCE(member_total.member_count, 0)::integer AS member_count,
            last_message.id AS last_message_id,
            last_message.body AS last_message_body,
            last_message.created_at AS last_message_created_at,
            ${displayNameExpression("last_sender")} AS last_message_sender_name,
            direct_partner.id AS direct_partner_id,
            direct_partner.display_name AS direct_partner_name,
            direct_partner.avatar_url AS direct_partner_avatar_url
     FROM goodspeech_chat_channels channel_record
     LEFT JOIN backend_teams team ON team.id = channel_record.team_id
     LEFT JOIN goodspeech_chat_channel_members member
       ON member.channel_id = channel_record.id AND member.user_id = $2::uuid
     LEFT JOIN LATERAL (
       SELECT COUNT(*)::integer AS unread_count
       FROM goodspeech_chat_messages unread_message
       WHERE unread_message.channel_id = channel_record.id
         AND unread_message.deleted_at IS NULL
         AND unread_message.sender_user_id <> $2::uuid
         AND unread_message.created_at > COALESCE(member.last_read_at, 'epoch'::timestamptz)
     ) unread ON TRUE
     LEFT JOIN LATERAL (
       SELECT COUNT(*)::integer AS member_count
       FROM goodspeech_chat_channel_members channel_member
       WHERE channel_member.channel_id = channel_record.id
     ) member_total ON TRUE
     LEFT JOIN LATERAL (
       SELECT * FROM goodspeech_chat_messages message_record
       WHERE message_record.channel_id = channel_record.id AND message_record.deleted_at IS NULL
       ORDER BY message_record.created_at DESC LIMIT 1
     ) last_message ON TRUE
     LEFT JOIN users last_sender ON last_sender.id = last_message.sender_user_id
     LEFT JOIN LATERAL (
       SELECT direct_user.id,
              ${displayNameExpression("direct_user")} AS display_name,
              ${avatarExpression("direct_user")} AS avatar_url
       FROM goodspeech_chat_channel_members direct_member
       JOIN users direct_user ON direct_user.id = direct_member.user_id
       WHERE direct_member.channel_id = channel_record.id
         AND direct_member.user_id <> $2::uuid
       ORDER BY direct_member.joined_at LIMIT 1
     ) direct_partner ON channel_record.channel_kind = 'direct'
     WHERE channel_record.organization_id = $1
       AND channel_record.archived_at IS NULL
       AND ${channelAccessSql()}
     ORDER BY CASE channel_record.channel_kind WHEN 'team' THEN 0 WHEN 'project' THEN 1 ELSE 2 END,
              channel_record.updated_at DESC`,
    [context.organizationId, userId, isElevated(context)]
  );
  const items = result.rows.map(rowToChannel);
  return { items, unreadTotal: items.reduce((sum, item) => sum + item.unreadCount, 0) };
}

async function createChannel({ payload, context, userId }) {
  const team = await requireTeamAccess({ teamId: payload?.teamId, context, userId });
  const name = requireText(payload?.name, "Channel name", 100);
  const description = boundedText(payload?.description, 500);
  const result = await query(
    `INSERT INTO goodspeech_chat_channels (
       organization_id, team_id, name, slug, description, channel_kind, created_by_user_id
     ) VALUES ($1, $2, $3, $4, $5, 'team', $6::uuid)
     RETURNING id`,
    [context.organizationId, team.id, name, slugify(name), description, userId]
  ).catch((error) => {
    if (error.code === "23505") throw serviceError("That team already has a channel with this name.", 409);
    throw error;
  });
  await query(
    `INSERT INTO goodspeech_chat_channel_members (channel_id, user_id)
     SELECT $1::uuid, membership.user_id
     FROM backend_team_memberships membership
     WHERE membership.team_id = $2 AND membership.status = 'active'
     ON CONFLICT (channel_id, user_id) DO NOTHING`,
    [result.rows[0].id, team.id]
  );
  return { id: result.rows[0].id };
}

async function openDirectChannel({ participantUserId, context, userId }) {
  const otherUserId = requireUuid(participantUserId, "team member ID");
  if (otherUserId === userId) throw serviceError("Choose another team member.");
  const valid = await query(
    `SELECT user_id FROM backend_organization_memberships
     WHERE organization_id = $1 AND status = 'active' AND user_id = ANY($2::uuid[])`,
    [context.organizationId, [userId, otherUserId]]
  );
  if (valid.rows.length !== 2) throw serviceError("The selected team member is unavailable.", 404);
  const key = directKey([userId, otherUserId]);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const inserted = await client.query(
      `INSERT INTO goodspeech_chat_channels (
         organization_id, name, slug, description, channel_kind, direct_key, created_by_user_id
       ) VALUES ($1, 'Direct message', $2, '', 'direct', $3, $4::uuid)
       ON CONFLICT (organization_id, direct_key)
         WHERE channel_kind = 'direct' AND archived_at IS NULL
       DO UPDATE SET updated_at = goodspeech_chat_channels.updated_at
       RETURNING id`,
      [context.organizationId, `dm-${key}`.slice(0, 100), key, userId]
    );
    await client.query(
      `INSERT INTO goodspeech_chat_channel_members (channel_id, user_id)
       SELECT $1::uuid, member_id FROM UNNEST($2::uuid[]) member_id
       ON CONFLICT (channel_id, user_id) DO NOTHING`,
      [inserted.rows[0].id, [userId, otherUserId]]
    );
    await client.query("COMMIT");
    return { id: inserted.rows[0].id };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function rowToMessage(row) {
  return {
    id: row.id,
    channelId: row.channel_id,
    senderUserId: row.sender_user_id,
    replyToMessageId: row.reply_to_message_id || null,
    type: row.message_type,
    body: row.deleted_at ? "" : row.body,
    metadata: row.metadata || {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    editedAt: row.edited_at || null,
    deletedAt: row.deleted_at || null,
    sender: {
      id: row.sender_user_id,
      displayName: row.sender_display_name,
      email: row.sender_email,
      avatarUrl: row.sender_avatar_url || null,
    },
  };
}

async function listMessages({ channelId, context, userId, limit = 60, before = null }) {
  const channel = await requireChannelAccess({ channelId, context, userId });
  const boundedLimit = Math.min(Math.max(Number(limit) || 60, 1), 100);
  const cursor = before ? new Date(String(before)) : null;
  if (cursor && Number.isNaN(cursor.getTime())) throw serviceError("The message cursor is invalid.");
  const result = await query(
    `SELECT message_record.*, sender.email AS sender_email,
            ${displayNameExpression("sender")} AS sender_display_name,
            ${avatarExpression("sender")} AS sender_avatar_url
     FROM goodspeech_chat_messages message_record
     JOIN users sender ON sender.id = message_record.sender_user_id
     WHERE message_record.channel_id = $1::uuid
       AND message_record.organization_id = $2
       AND ($3::timestamptz IS NULL OR message_record.created_at < $3::timestamptz)
     ORDER BY message_record.created_at DESC
     LIMIT $4`,
    [channel.id, context.organizationId, cursor ? cursor.toISOString() : null, boundedLimit + 1]
  );
  const hasMore = result.rows.length > boundedLimit;
  const rows = result.rows.slice(0, boundedLimit).reverse();
  return {
    channel: rowToChannel(channel),
    items: rows.map(rowToMessage),
    hasMore,
    nextCursor: hasMore ? rows[0]?.created_at || null : null,
  };
}

function normalizeClientMessageKey(value) {
  const key = boundedText(value, 128);
  if (!key) return null;
  if (key.length < 8 || !/^[A-Za-z0-9._:-]+$/.test(key)) {
    throw serviceError("The message idempotency key is invalid.");
  }
  return key;
}

async function sendMessage({ channelId, payload, context, userId, idempotencyKey = null }) {
  const channel = await requireChannelAccess({ channelId, context, userId });
  const body = requireText(payload?.body, "Message", 4000);
  const replyToMessageId = payload?.replyToMessageId
    ? requireUuid(payload.replyToMessageId, "reply message ID")
    : null;
  const clientKey = normalizeClientMessageKey(idempotencyKey);
  const client = await pool.connect();
  let message;
  try {
    await client.query("BEGIN");
    if (replyToMessageId) {
      const reply = await client.query(
        `SELECT id FROM goodspeech_chat_messages
         WHERE id = $1::uuid AND channel_id = $2::uuid AND deleted_at IS NULL`,
        [replyToMessageId, channel.id]
      );
      if (!reply.rows[0]) throw serviceError("The message being replied to is unavailable.", 404);
    }
    const inserted = await client.query(
      `INSERT INTO goodspeech_chat_messages (
         channel_id, organization_id, sender_user_id, reply_to_message_id,
         client_message_key, body
       ) VALUES ($1::uuid, $2, $3::uuid, $4::uuid, $5, $6)
       ON CONFLICT (organization_id, sender_user_id, client_message_key)
         WHERE client_message_key IS NOT NULL
       DO UPDATE SET updated_at = goodspeech_chat_messages.updated_at
       RETURNING *`,
      [channel.id, context.organizationId, userId, replyToMessageId, clientKey, body]
    );
    await client.query(
      `INSERT INTO goodspeech_chat_channel_members (channel_id, user_id, last_read_at)
       VALUES ($1::uuid, $2::uuid, NOW())
       ON CONFLICT (channel_id, user_id)
       DO UPDATE SET last_read_at = NOW(), updated_at = NOW()`,
      [channel.id, userId]
    );
    await client.query("UPDATE goodspeech_chat_channels SET updated_at = NOW() WHERE id = $1::uuid", [channel.id]);
    const hydrated = await client.query(
      `SELECT message_record.*, sender.email AS sender_email,
              ${displayNameExpression("sender")} AS sender_display_name,
              ${avatarExpression("sender")} AS sender_avatar_url
       FROM goodspeech_chat_messages message_record
       JOIN users sender ON sender.id = message_record.sender_user_id
       WHERE message_record.id = $1::uuid`,
      [inserted.rows[0].id]
    );
    message = rowToMessage(hydrated.rows[0]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  notifyChannelMembers({ channel, senderUserId: userId, body, messageId: message.id }).catch(() => {});
  return message;
}

async function notifyChannelMembers({ channel, senderUserId, body, messageId }) {
  const recipients = await query(
    `SELECT member.user_id
     FROM goodspeech_chat_channel_members member
     WHERE member.channel_id = $1::uuid AND member.user_id <> $2::uuid AND member.muted = FALSE
     LIMIT 100`,
    [channel.id, senderUserId]
  );
  await Promise.allSettled(recipients.rows.map((recipient) => notificationService.createNotification({
    appId: "goodspeech",
    recipientUserId: recipient.user_id,
    title: channel.channel_kind === "project" ? `${channel.name} · new project message` : `New message in ${channel.name}`,
    message: body.slice(0, 240),
    category: "collaboration",
    channel: "in_app",
    payload: { channelId: channel.id, projectId: channel.project_id || null, messageId },
    metadata: { appId: "goodspeech", channelId: channel.id },
  })));
}

async function editMessage({ channelId, messageId, payload, context, userId }) {
  await requireChannelAccess({ channelId, context, userId });
  const body = requireText(payload?.body, "Message", 4000);
  const result = await query(
    `UPDATE goodspeech_chat_messages
     SET body = $1, edited_at = NOW(), updated_at = NOW()
     WHERE id = $2::uuid AND channel_id = $3::uuid AND organization_id = $4
       AND sender_user_id = $5::uuid AND deleted_at IS NULL
     RETURNING id`,
    [body, requireUuid(messageId, "message ID"), requireUuid(channelId, "channel ID"), context.organizationId, userId]
  );
  if (!result.rows[0]) throw serviceError("You cannot edit this message.", 403);
  return { id: result.rows[0].id, body, editedAt: new Date().toISOString() };
}

async function deleteMessage({ channelId, messageId, context, userId }) {
  await requireChannelAccess({ channelId, context, userId });
  const result = await query(
    `UPDATE goodspeech_chat_messages
     SET body = '[deleted]', deleted_at = NOW(), updated_at = NOW()
     WHERE id = $1::uuid AND channel_id = $2::uuid AND organization_id = $3
       AND deleted_at IS NULL AND (sender_user_id = $4::uuid OR $5::boolean)
     RETURNING id`,
    [
      requireUuid(messageId, "message ID"),
      requireUuid(channelId, "channel ID"),
      context.organizationId,
      userId,
      isElevated(context),
    ]
  );
  if (!result.rows[0]) throw serviceError("You cannot delete this message.", 403);
  return { id: result.rows[0].id, deletedAt: new Date().toISOString() };
}

async function markRead({ channelId, context, userId }) {
  const channel = await requireChannelAccess({ channelId, context, userId });
  await query(
    `INSERT INTO goodspeech_chat_channel_members (channel_id, user_id, last_read_at)
     VALUES ($1::uuid, $2::uuid, NOW())
     ON CONFLICT (channel_id, user_id)
     DO UPDATE SET last_read_at = NOW(), updated_at = NOW()`,
    [channel.id, userId]
  );
  return { channelId: channel.id, readAt: new Date().toISOString() };
}

async function bootstrap({ context, userId }) {
  const teams = await syncTeamChannels({ context, userId });
  const [members, projects, channels] = await Promise.all([
    listMembers({ context, userId }),
    listProjects({ context, userId }),
    listChannels({ context, userId }),
  ]);
  return {
    organization: {
      id: context.organization.id,
      name: context.organization.name,
      role: context.organization.membershipRole,
    },
    permissions: {
      canManageTeams: isElevated(context),
      canCreateProjects: teams.length > 0,
    },
    teams,
    members,
    projects,
    channels: channels.items,
    unreadTotal: channels.unreadTotal,
  };
}

module.exports = {
  bootstrap,
  listTeams,
  listMembers,
  listProjects,
  createProject,
  updateProject,
  getProject,
  createTask,
  updateTask,
  listChannels,
  createChannel,
  openDirectChannel,
  listMessages,
  sendMessage,
  editMessage,
  deleteMessage,
  markRead,
  requireTeamAccess,
  requireProjectAccess,
  serviceError,
};
