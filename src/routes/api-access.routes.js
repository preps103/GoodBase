/* GOODOS_API_ACCESS_LIVE_V1 */

const express =
  require("express");

const authRequired =
  require("../middleware/authRequired");

const database =
  require("../config/database");

const apiAccessService =
  require("../services/api-access.service");

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
                'public.backend_api_keys'
              ) IS NOT NULL
                AS keys_ready,

              to_regclass(
                'public.backend_api_key_usage_logs'
              ) IS NOT NULL
                AS usage_ready,

              (
                SELECT COUNT(*)
                FROM information_schema.columns
                WHERE table_schema =
                      'public'
                  AND table_name =
                      'backend_api_keys'
                  AND column_name IN (
                    'description',
                    'expires_at',
                    'updated_at',
                    'metadata_json',
                    'rotated_from_key_id',
                    'last_rotated_at'
                  )
              ) = 6
                AS operations_ready
          `
        );

      const row =
        result.rows[0] || {};

      return ok(res, {
        service:
          "GoodOS API Access",
        status: "ok",
        schemaReady:
          Boolean(
            row.keys_ready &&
            row.usage_ready &&
            row.operations_ready
          ),
      });
    } catch (
      requestError
    ) {
      return fail(
        res,
        requestError,
        "API Access health check failed."
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
        await apiAccessService
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
        "Failed to load API Access."
      );
    }
  }
);

router.post(
  "/keys",
  async (
    req,
    res
  ) => {
    try {
      const result =
        await apiAccessService
          .createKeyForUser(
            req.user.id,
            req.body || {},
            {
              ipAddress:
                req.ip,
            }
          );

      return ok(res, {
        ...result,
        message:
          "API key generated. Copy the secret now because it will not be shown again.",
      });
    } catch (
      requestError
    ) {
      return fail(
        res,
        requestError,
        "Failed to create API key."
      );
    }
  }
);

router.patch(
  "/keys/:keyId",
  async (
    req,
    res
  ) => {
    try {
      const apiKey =
        await apiAccessService
          .updateKeyForUser(
            req.user.id,
            String(
              req.params.keyId
            ),
            req.body || {},
            {
              ipAddress:
                req.ip,
            }
          );

      return ok(res, {
        apiKey,
        message:
          "API key settings saved.",
      });
    } catch (
      requestError
    ) {
      return fail(
        res,
        requestError,
        "Failed to update API key."
      );
    }
  }
);

router.post(
  "/keys/:keyId/revoke",
  async (
    req,
    res
  ) => {
    try {
      const apiKey =
        await apiAccessService
          .revokeKeyForUser(
            req.user.id,
            String(
              req.params.keyId
            ),
            {
              ipAddress:
                req.ip,
            }
          );

      return ok(res, {
        apiKey,
        message:
          "API key revoked.",
      });
    } catch (
      requestError
    ) {
      return fail(
        res,
        requestError,
        "Failed to revoke API key."
      );
    }
  }
);

router.delete(
  "/keys/:keyId",
  async (
    req,
    res
  ) => {
    try {
      const apiKey =
        await apiAccessService
          .deleteRevokedKeyForUser(
            req.user.id,
            String(
              req.params.keyId
            ),
            {
              ipAddress:
                req.ip,
            }
          );

      return ok(res, {
        apiKey,
        message:
          "Revoked API key permanently deleted.",
      });
    } catch (
      requestError
    ) {
      return fail(
        res,
        requestError,
        "Failed to delete revoked API key."
      );
    }
  }
);

router.post(
  "/keys/:keyId/rotate",
  async (
    req,
    res
  ) => {
    try {
      const result =
        await apiAccessService
          .rotateKeyForUser(
            req.user.id,
            String(
              req.params.keyId
            ),
            {
              ipAddress:
                req.ip,
            }
          );

      return ok(res, {
        ...result,
        message:
          "API key rotated. Copy the replacement secret now because it will not be shown again.",
      });
    } catch (
      requestError
    ) {
      return fail(
        res,
        requestError,
        "Failed to rotate API key."
      );
    }
  }
);

module.exports =
  router;
