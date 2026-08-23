/* GOODOS_ROLES_CONSOLE_V1 */

const express =
  require("express");

const authRequired =
  require("../middleware/authRequired");

const database =
  require("../config/database");

const rolesService =
  require("../services/roles-console.service");

const router =
  express.Router();

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

function ok(
  res,
  data = {}
) {
  return res.json({
    success: true,
    ...data,
  });
}

function fail(
  res,
  requestError,
  fallback
) {
  console.error(
    fallback,
    requestError
  );

  return res
    .status(
      requestError.statusCode ||
      500
    )
    .json({
      success: false,
      message:
        requestError.message ||
        fallback,
    });
}

router.get(
  "/health",
  async (
    req,
    res
  ) => {
    try {
      const result =
        await dbQuery(
          `
            SELECT
              to_regclass(
                'public.backend_roles'
              ) IS NOT NULL
                AS roles_ready,

              to_regclass(
                'public.backend_permissions'
              ) IS NOT NULL
                AS permissions_ready,

              to_regclass(
                'public.backend_role_permissions'
              ) IS NOT NULL
                AS role_permissions_ready,

              to_regclass(
                'public.backend_user_roles'
              ) IS NOT NULL
                AS assignments_ready,

              to_regclass(
                'public.backend_access_requests'
              ) IS NOT NULL
                AS requests_ready,

              to_regclass(
                'public.backend_role_settings'
              ) IS NOT NULL
                AS settings_ready
          `
        );

      const row =
        result.rows[0] || {};

      return ok(res, {
        service:
          "GoodOS Roles Console",
        status:
          "ok",
        schemaReady:
          Boolean(
            row.roles_ready &&
            row.permissions_ready &&
            row.role_permissions_ready &&
            row.assignments_ready &&
            row.requests_ready &&
            row.settings_ready
          ),
      });
    } catch (
      requestError
    ) {
      return fail(
        res,
        requestError,
        "Roles Console health check failed."
      );
    }
  }
);

router.use(
  authRequired
);

router.get(
  "/overview",
  async (
    req,
    res
  ) => {
    try {
      const overview =
        await rolesService
          .getOverviewForUser(
            req.user.id
          );

      return ok(
        res,
        overview
      );
    } catch (
      requestError
    ) {
      return fail(
        res,
        requestError,
        "Failed to load Roles Console."
      );
    }
  }
);

router.put(
  "/application-access/:targetUserId",
  async (
    req,
    res
  ) => {
    try {
      const access =
        await rolesService
          .replaceApplicationAccessForUser(
            req.user.id,
            String(
              req.params.targetUserId
            ),
            req.body || {},
            {
              ipAddress:
                req.ip,
            }
          );

      return ok(res, {
        access,
        message:
          "Application access saved.",
      });
    } catch (
      requestError
    ) {
      return fail(
        res,
        requestError,
        "Failed to save application access."
      );
    }
  }
);

router.post(
  "/roles",
  async (
    req,
    res
  ) => {
    try {
      const role =
        await rolesService
          .createRoleForUser(
            req.user.id,
            req.body || {},
            {
              ipAddress:
                req.ip,
            }
          );

      return ok(res, {
        role,
        message:
          "Custom role created.",
      });
    } catch (
      requestError
    ) {
      return fail(
        res,
        requestError,
        "Failed to create role."
      );
    }
  }
);

router.patch(
  "/roles/:roleId",
  async (
    req,
    res
  ) => {
    try {
      const role =
        await rolesService
          .updateRoleForUser(
            req.user.id,
            String(
              req.params.roleId
            ),
            req.body || {},
            {
              ipAddress:
                req.ip,
            }
          );

      return ok(res, {
        role,
        message:
          "Role updated.",
      });
    } catch (
      requestError
    ) {
      return fail(
        res,
        requestError,
        "Failed to update role."
      );
    }
  }
);

router.post(
  "/roles/:roleId/archive",
  async (
    req,
    res
  ) => {
    try {
      const role =
        await rolesService
          .archiveRoleForUser(
            req.user.id,
            String(
              req.params.roleId
            ),
            {
              ipAddress:
                req.ip,
            }
          );

      return ok(res, {
        role,
        message:
          "Role archived.",
      });
    } catch (
      requestError
    ) {
      return fail(
        res,
        requestError,
        "Failed to archive role."
      );
    }
  }
);

router.post(
  "/roles/:roleId/restore",
  async (
    req,
    res
  ) => {
    try {
      const role =
        await rolesService
          .restoreRoleForUser(
            req.user.id,
            String(
              req.params.roleId
            ),
            {
              ipAddress:
                req.ip,
            }
          );

      return ok(res, {
        role,
        message:
          "Role restored.",
      });
    } catch (
      requestError
    ) {
      return fail(
        res,
        requestError,
        "Failed to restore role."
      );
    }
  }
);

router.post(
  "/roles/:roleId/duplicate",
  async (
    req,
    res
  ) => {
    try {
      const role =
        await rolesService
          .duplicateRoleForUser(
            req.user.id,
            String(
              req.params.roleId
            ),
            req.body || {},
            {
              ipAddress:
                req.ip,
            }
          );

      return ok(res, {
        role,
        message:
          "Role duplicated.",
      });
    } catch (
      requestError
    ) {
      return fail(
        res,
        requestError,
        "Failed to duplicate role."
      );
    }
  }
);

router.post(
  "/assignments",
  async (
    req,
    res
  ) => {
    try {
      const assignment =
        await rolesService
          .assignRoleForUser(
            req.user.id,
            req.body || {},
            {
              ipAddress:
                req.ip,
            }
          );

      return ok(res, {
        assignment,
        message:
          "Role assigned.",
      });
    } catch (
      requestError
    ) {
      return fail(
        res,
        requestError,
        "Failed to assign role."
      );
    }
  }
);

router.post(
  "/assignments/:assignmentId/revoke",
  async (
    req,
    res
  ) => {
    try {
      const assignment =
        await rolesService
          .revokeAssignmentForUser(
            req.user.id,
            String(
              req.params
                .assignmentId
            ),
            {
              ipAddress:
                req.ip,
            }
          );

      return ok(res, {
        assignment,
        message:
          "Role assignment revoked.",
      });
    } catch (
      requestError
    ) {
      return fail(
        res,
        requestError,
        "Failed to revoke role assignment."
      );
    }
  }
);

router.post(
  "/access-requests",
  async (
    req,
    res
  ) => {
    try {
      const request =
        await rolesService
          .createAccessRequestForUser(
            req.user.id,
            req.body || {},
            {
              ipAddress:
                req.ip,
            }
          );

      return ok(res, {
        request,
        message:
          "Access request submitted.",
      });
    } catch (
      requestError
    ) {
      return fail(
        res,
        requestError,
        "Failed to create access request."
      );
    }
  }
);

router.post(
  "/access-requests/:requestId/resolve",
  async (
    req,
    res
  ) => {
    try {
      const request =
        await rolesService
          .resolveAccessRequestForUser(
            req.user.id,
            String(
              req.params.requestId
            ),
            req.body || {},
            {
              ipAddress:
                req.ip,
            }
          );

      return ok(res, {
        request,
        message:
          `Access request ${request.status}.`,
      });
    } catch (
      requestError
    ) {
      return fail(
        res,
        requestError,
        "Failed to resolve access request."
      );
    }
  }
);

router.patch(
  "/settings",
  async (
    req,
    res
  ) => {
    try {
      const settings =
        await rolesService
          .updateSettingsForUser(
            req.user.id,
            req.body || {},
            {
              ipAddress:
                req.ip,
            }
          );

      return ok(res, {
        settings,
        message:
          "Role governance settings saved.",
      });
    } catch (
      requestError
    ) {
      return fail(
        res,
        requestError,
        "Failed to update role settings."
      );
    }
  }
);

module.exports =
  router;
