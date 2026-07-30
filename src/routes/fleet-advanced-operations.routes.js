"use strict";

const express = require("express");
const authRequired = require("../middleware/authRequired");
const { pool, query } = require("../config/database");
const notificationService = require("../services/notification.service");
const secretService = require("../services/secret.service");

const router = express.Router();
const ORGANIZATION_ID =
  process.env.GOODFLEET_PUBLIC_ORGANIZATION_ID || "org_goodos";
const EMPLOYEE_ROLES = new Set(["owner", "admin", "manager", "staff", "mechanic"]);
const MANAGEMENT_ROLES = new Set(["owner", "admin", "manager"]);
const HOST_TEAM_ROLES = new Set(["team_manager", "cohost", "vehicle_manager", "messenger"]);
const HOST_PERMISSIONS = new Set([
  "listing_view",
  "listing_manage",
  "trips_view",
  "trips_manage",
  "messaging",
  "pricing",
]);
const ROAD_ASSISTANCE_TYPES = new Set([
  "tow",
  "flat_tire",
  "battery",
  "lockout",
  "fuel",
  "mechanical",
  "accident",
  "other",
]);
const ROAD_STATUSES = new Set([
  "requested",
  "awaiting_provider",
  "dispatched",
  "en_route",
  "arrived",
  "resolved",
  "cancelled",
  "failed",
]);
const TELEMATICS_COMMANDS = new Set(["locate", "lock", "unlock", "honk", "lights"]);
const TELEMATICS_CAPABILITIES = new Set([
  "location",
  "odometer",
  "fuel",
  "battery",
  "ignition",
  "door_lock",
  "honk",
  "lights",
]);

router.use(authRequired);

function clean(value, max = 4000) {
  return String(value ?? "").trim().slice(0, max);
}

function fail(response, status, code, message, details) {
  return response.status(status).json({
    success: false,
    code,
    message,
    ...(details ? { details } : {}),
  });
}

function fleetRole(request) {
  const membership = (request.apps || []).find(
    app =>
      clean(app?.membershipStatus, 40).toLowerCase() === "active" &&
      (clean(app?.id, 80).toLowerCase() === "goodfleet" ||
        clean(app?.domain, 160).toLowerCase() === "fleet.goodos.app"),
  );
  return clean(membership?.role, 40).toLowerCase();
}

function requireFleetMember(request, response, next) {
  if (!fleetRole(request)) {
    return fail(
      response,
      403,
      "GOODFLEET_MEMBERSHIP_REQUIRED",
      "An active GoodFleet account is required.",
    );
  }
  next();
}

router.use(requireFleetMember);

function requireEmployee(request, response, next) {
  if (!EMPLOYEE_ROLES.has(fleetRole(request))) {
    return fail(
      response,
      403,
      "EMPLOYEE_ACCESS_REQUIRED",
      "GoodFleet employee access is required.",
    );
  }
  next();
}

function requireManagement(request, response, next) {
  if (!MANAGEMENT_ROLES.has(fleetRole(request))) {
    return fail(
      response,
      403,
      "MANAGEMENT_ACCESS_REQUIRED",
      "GoodFleet management access is required.",
    );
  }
  next();
}

async function requireHost(request, response, next) {
  if (fleetRole(request) === "host") return next();
  try {
    const delegated = await query(
      `UPDATE fleet_host_team_members
          SET user_id=COALESCE(user_id,$2),
              status=CASE WHEN status='invited' THEN 'active' ELSE status END,
              accepted_at=CASE
                WHEN status='invited' THEN COALESCE(accepted_at,NOW())
                ELSE accepted_at
              END,
              updated_at=CASE WHEN status='invited' THEN NOW() ELSE updated_at END
        WHERE organization_id=$1
          AND status IN ('invited','active')
          AND (
            user_id=$2 OR
            (user_id IS NULL AND lower(invited_email)=lower($3))
          )
        RETURNING id`,
      [ORGANIZATION_ID, request.user.id, clean(request.user.email, 320)],
    );
    if (delegated.rowCount) return next();
    return fail(
      response,
      403,
      "HOST_ACCESS_REQUIRED",
      "An active GoodFleet host or delegated host-team account is required.",
    );
  } catch (error) {
    return next(error);
  }
}

function permissions(value, allowed = HOST_PERMISSIONS) {
  return [...new Set(
    (Array.isArray(value) ? value : [])
      .map(item => clean(item, 80).toLowerCase())
      .filter(item => allowed.has(item)),
  )];
}

function numberOrNull(value, min, max) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) return null;
  return parsed;
}

function hostMemberPayload(row) {
  return {
    id: row.id,
    hostProfileId: row.host_profile_id,
    userId: row.user_id || null,
    email: row.invited_email,
    displayName: row.display_name || null,
    role: row.role,
    status: row.status,
    permissions: row.permissions_json || [],
    vehicleAccess: Array.isArray(row.vehicle_access) ? row.vehicle_access : [],
    invitedAt: row.invited_at,
    acceptedAt: row.accepted_at || null,
    updatedAt: row.updated_at,
  };
}

function roadsidePayload(row) {
  return {
    id: row.id,
    bookingId: row.booking_id || null,
    customerId: row.customer_id || null,
    vehicleId: row.vehicle_id || null,
    reservationNumber: row.reservation_number || null,
    customerName: row.customer_name || null,
    vehicleName: [row.model_year, row.make, row.model].filter(Boolean).join(" "),
    assistanceType: row.assistance_type,
    priority: row.priority,
    status: row.status,
    location: {
      latitude: row.latitude === null ? null : Number(row.latitude),
      longitude: row.longitude === null ? null : Number(row.longitude),
      address: row.address || "",
    },
    notes: row.notes,
    safetyConcern: Boolean(row.safety_concern),
    provider: row.provider || null,
    providerReference: row.provider_reference || null,
    providerStatus: row.provider_status || null,
    assignedTo: row.assigned_to || null,
    events: Array.isArray(row.events) ? row.events : [],
    dispatchedAt: row.dispatched_at || null,
    resolvedAt: row.resolved_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function telematicsPayload(row) {
  const latest = row.latest_snapshot || null;
  return {
    vehicleId: row.vehicle_id,
    vehicleName: [row.model_year, row.make, row.model].filter(Boolean).join(" "),
    licensePlate: row.license_plate,
    imageUrl: row.vehicle_payload?.imageUrl || null,
    connection: row.connection_id
      ? {
          id: row.connection_id,
          provider: row.provider,
          externalVehicleId: row.external_vehicle_id,
          status: row.connection_status,
          capabilities: row.capabilities_json || [],
          safeConfiguration: row.safe_configuration_json || {},
          lastSyncedAt: row.last_synced_at || null,
          lastErrorCode: row.last_error_code || null,
        }
      : null,
    latestSnapshot: latest
      ? {
          id: latest.id,
          latitude: latest.latitude === null ? null : Number(latest.latitude),
          longitude: latest.longitude === null ? null : Number(latest.longitude),
          speedMph: latest.speed_mph === null ? null : Number(latest.speed_mph),
          odometerMiles:
            latest.odometer_miles === null ? null : Number(latest.odometer_miles),
          fuelPercent: latest.fuel_percent === null ? null : Number(latest.fuel_percent),
          batteryPercent:
            latest.battery_percent === null ? null : Number(latest.battery_percent),
          ignitionOn: latest.ignition_on,
          doorsLocked: latest.doors_locked,
          headingDegrees:
            latest.heading_degrees === null ? null : Number(latest.heading_degrees),
          capturedAt: latest.captured_at,
          receivedAt: latest.received_at,
        }
      : null,
  };
}

async function audit(client, request, action, entityType, entityId, details) {
  await client.query(
    `INSERT INTO fleet_audit_events
      (organization_id,actor_id,action,entity_type,entity_id,after_json,request_id,ip_address)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)`,
    [
      ORGANIZATION_ID,
      request.user.id,
      action,
      entityType,
      entityId,
      JSON.stringify(details || {}),
      request.id || request.get("X-Request-ID") || null,
      request.ip || null,
    ],
  );
}

async function ownerHostProfile(client, userId, lock = false) {
  const result = await client.query(
    `SELECT *
       FROM fleet_host_profiles
      WHERE organization_id=$1 AND user_id=$2
      LIMIT 1
      ${lock ? "FOR UPDATE" : ""}`,
    [ORGANIZATION_ID, userId],
  );
  return result.rows[0] || null;
}

async function hostTeamRows(client, hostProfileId) {
  const result = await client.query(
    `SELECT member.*,
            COALESCE((
              SELECT jsonb_agg(jsonb_build_object(
                'vehicleId',access.vehicle_id,
                'vehicleName',concat_ws(' ',vehicle.model_year,vehicle.make,vehicle.model),
                'permissions',access.permissions_json
              ) ORDER BY vehicle.make,vehicle.model)
                FROM fleet_host_team_vehicle_access access
                JOIN fleet_vehicles vehicle
                  ON vehicle.organization_id=access.organization_id
                 AND vehicle.id=access.vehicle_id
               WHERE access.organization_id=member.organization_id
                 AND access.team_member_id=member.id
            ),'[]'::jsonb) AS vehicle_access
       FROM fleet_host_team_members member
      WHERE member.organization_id=$1 AND member.host_profile_id=$2
      ORDER BY member.status='active' DESC,member.invited_at DESC`,
    [ORGANIZATION_ID, hostProfileId],
  );
  return result.rows;
}

async function roadsideRecord(client, caseId) {
  const result = await client.query(
    `SELECT roadside.*,booking.reservation_number,customer.full_name AS customer_name,
            customer.user_id AS customer_user_id,customer.email AS customer_email,
            vehicle.make,vehicle.model,vehicle.model_year,
            COALESCE((
              SELECT jsonb_agg(jsonb_build_object(
                'id',event.id,'eventType',event.event_type,
                'details',event.details_json,'createdAt',event.created_at
              ) ORDER BY event.created_at)
                FROM fleet_roadside_events event
               WHERE event.organization_id=roadside.organization_id
                 AND event.case_id=roadside.id
            ),'[]'::jsonb) AS events
       FROM fleet_roadside_cases roadside
       LEFT JOIN fleet_bookings booking
         ON booking.organization_id=roadside.organization_id
        AND booking.id=roadside.booking_id
       LEFT JOIN fleet_customers customer
         ON customer.organization_id=roadside.organization_id
        AND customer.id=roadside.customer_id
       LEFT JOIN fleet_vehicles vehicle
         ON vehicle.organization_id=roadside.organization_id
        AND vehicle.id=roadside.vehicle_id
      WHERE roadside.organization_id=$1 AND roadside.id=$2`,
    [ORGANIZATION_ID, caseId],
  );
  return result.rows[0] || null;
}

async function notifyRoadsideCustomer(record, title, message) {
  if (!record?.customer_user_id && !record?.customer_email) return;
  await notificationService.createNotification({
    appId: "goodfleet",
    recipientUserId: record.customer_user_id || undefined,
    recipientEmail: record.customer_email || undefined,
    title,
    message,
    category: "support",
    severity: record.safety_concern ? "critical" : "info",
    channel: record.customer_user_id ? "in_app" : "email",
    actionUrl: "/account/support",
    source: "goodfleet-roadside",
    sourceId: record.id,
  }).catch(() => {});
}

async function secretOrEnv(key) {
  try {
    const value = await secretService.getSecretValue(key);
    if (value) return value;
  } catch (_) {
    // Environment variables remain the deployment fallback.
  }
  return process.env[key] || null;
}

async function providerConfiguration(kind) {
  const prefix =
    kind === "roadside" ? "GOODFLEET_ROADSIDE_PROVIDER" : "GOODFLEET_TELEMATICS_PROVIDER";
  const [url, token] = await Promise.all([
    secretOrEnv(`${prefix}_URL`),
    secretOrEnv(`${prefix}_TOKEN`),
  ]);
  if (!url || !token) return null;
  const parsed = new URL(url);
  if (
    parsed.protocol !== "https:" ||
    ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname) ||
    /^\d{1,3}(?:\.\d{1,3}){3}$/.test(parsed.hostname)
  ) {
    throw Object.assign(new Error("Provider URL must be a public HTTPS endpoint."), {
      statusCode: 503,
      code: "PROVIDER_CONFIGURATION_INVALID",
    });
  }
  return { url: parsed, token };
}

async function providerRequest(configuration, path, input) {
  const url = new URL(path.replace(/^\/+/, ""), `${configuration.url.toString().replace(/\/?$/, "/")}`);
  if (url.origin !== configuration.url.origin) {
    throw new Error("Provider request escaped the configured origin.");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${configuration.token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(input),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error("The external provider rejected the request.");
      error.code = clean(payload?.code, 120) || `PROVIDER_HTTP_${response.status}`;
      throw error;
    }
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

async function providerReadiness(kind) {
  try {
    const configuration = await providerConfiguration(kind);
    return {
      configured: Boolean(configuration),
      state: configuration ? "ready" : "external_activation_required",
      mode:
        kind === "roadside"
          ? configuration ? "live" : "intake_only"
          : configuration ? "live" : "disabled",
      configurationValid: true,
    };
  } catch (error) {
    return {
      configured: false,
      state: "misconfigured",
      mode: kind === "roadside" ? "intake_only" : "disabled",
      configurationValid: false,
      errorCode: clean(error?.code, 120) || "PROVIDER_CONFIGURATION_INVALID",
    };
  }
}

function marketplaceVehicleReadiness(row) {
  const blockers = [];
  const warnings = [];
  if (!row.listing_id) blockers.push("listing_missing");
  else if (row.listing_status !== "active" || row.listing_archived) blockers.push("listing_not_active");
  if (!["available", "reserved"].includes(row.vehicle_status)) blockers.push("vehicle_not_available");
  if (!row.registration_current) {
    blockers.push(row.registration_expiry ? "registration_expired" : "registration_expiry_missing");
  }
  if (!row.insurance_current) {
    blockers.push(row.insurance_expiry ? "insurance_expired" : "insurance_expiry_missing");
  }
  if (!["clear", "resolved"].includes(clean(row.recall_status, 40).toLowerCase() || "clear")) {
    blockers.push("recall_not_cleared");
  }
  if (row.listing_id && !row.operator_managed && !row.host_ready) {
    blockers.push("host_verification_required");
  }
  if (Number(row.photo_count || 0) < 6) blockers.push("listing_photos_incomplete");

  return {
    vehicleId: row.vehicle_id,
    vehicleName: [row.model_year, row.make, row.model].filter(Boolean).join(" "),
    listingId: row.listing_id || null,
    vehicleStatus: row.vehicle_status,
    listingStatus: row.listing_status || "missing",
    registrationExpiry: row.registration_expiry || null,
    insuranceExpiry: row.insurance_expiry || null,
    photoCount: Number(row.photo_count || 0),
    bookable: blockers.length === 0,
    blockers,
    warnings,
  };
}

router.get("/integrations/readiness", requireManagement, async (_request, response, next) => {
  try {
    const [
      roadside,
      telematics,
      inventoryResult,
      socialResult,
      smsResult,
      connectionResult,
    ] = await Promise.all([
      providerReadiness("roadside"),
      providerReadiness("telematics"),
      query(
        `SELECT vehicle.id AS vehicle_id,vehicle.make,vehicle.model,vehicle.model_year,
                vehicle.status AS vehicle_status,vehicle.registration_expiry,
                vehicle.insurance_expiry,
                COALESCE(vehicle.payload->>'recallStatus','clear') AS recall_status,
                vehicle.registration_expiry IS NOT NULL
                  AND vehicle.registration_expiry>=CURRENT_DATE AS registration_current,
                vehicle.insurance_expiry IS NOT NULL
                  AND vehicle.insurance_expiry>=CURRENT_DATE AS insurance_current,
                listing.id AS listing_id,listing.status AS listing_status,
                listing.archived_at IS NOT NULL AS listing_archived,
                COALESCE(listing.operator_managed,false) AS operator_managed,
                COALESCE(
                  CASE
                    WHEN jsonb_typeof(listing.photos_json)='array'
                    THEN jsonb_array_length(listing.photos_json)
                    ELSE 0
                  END,
                  0
                )::integer AS photo_count,
                COALESCE(
                  host.status='active' AND host.identity_verification_status='verified',
                  false
                ) AS host_ready
           FROM fleet_vehicles vehicle
           LEFT JOIN fleet_vehicle_listings listing
             ON listing.organization_id=vehicle.organization_id
            AND listing.vehicle_id=vehicle.id
            AND listing.archived_at IS NULL
           LEFT JOIN fleet_host_profiles host
             ON host.organization_id=listing.organization_id
            AND host.id=listing.host_profile_id
          WHERE vehicle.organization_id=$1
            AND vehicle.archived_at IS NULL
          ORDER BY vehicle.make,vehicle.model`,
        [ORGANIZATION_ID],
      ),
      query(
        `SELECT id,provider_type,display_name,status,
                controller_url IS NOT NULL AS controller_configured,
                secret_ref IS NOT NULL AS secret_configured,
                updated_at
           FROM goodbase_consumer_auth_providers
          WHERE organization_id=$1
            AND provider_type IN ('google','apple','microsoft')
          ORDER BY display_name`,
        [ORGANIZATION_ID],
      ),
      query(
        `SELECT EXISTS (
           SELECT 1
             FROM goodbase_consumer_auth_providers provider
            WHERE provider.organization_id=$1
              AND provider.provider_type IN ('phone_otp','sms_mfa')
              AND provider.status='enabled'
              AND provider.controller_url IS NOT NULL
              AND provider.secret_ref IS NOT NULL
         ) AS provider_configured`,
        [ORGANIZATION_ID],
      ),
      query(
        `SELECT COUNT(*)::integer AS total,
                COUNT(*) FILTER (WHERE status='connected')::integer AS connected
           FROM fleet_telematics_connections
          WHERE organization_id=$1`,
        [ORGANIZATION_ID],
      ),
    ]);

    const vehicles = inventoryResult.rows.map(marketplaceVehicleReadiness);
    const bookableVehicles = vehicles.filter(vehicle => vehicle.bookable).length;
    const smsConfigured = Boolean(smsResult.rows[0]?.provider_configured);
    const socialProviders = socialResult.rows.map(provider => ({
      id: provider.id,
      providerType: provider.provider_type,
      displayName: provider.display_name,
      status: provider.status,
      available:
        provider.status === "enabled" &&
        provider.controller_configured &&
        provider.secret_configured,
      controllerConfigured: provider.controller_configured,
      secretConfigured: provider.secret_configured,
      updatedAt: provider.updated_at,
    }));

    response.json({
      success: true,
      data: {
        generatedAt: new Date().toISOString(),
        marketplace: {
          state: bookableVehicles > 0 ? "ready" : "action_required",
          totalVehicles: vehicles.length,
          bookableVehicles,
          blockedVehicles: vehicles.length - bookableVehicles,
          vehicles,
        },
        customerSms: {
          state: smsConfigured ? "ready" : "external_activation_required",
          softwareReady: true,
          providerConfigured: smsConfigured,
          requiredConfiguration: [
            "Enabled phone or SMS provider",
            "Verified HTTPS controller",
            "Encrypted provider secret",
          ],
        },
        roadside: {
          ...roadside,
          softwareReady: true,
          requiredSecrets: [
            "GOODFLEET_ROADSIDE_PROVIDER_URL",
            "GOODFLEET_ROADSIDE_PROVIDER_TOKEN",
          ],
        },
        telematics: {
          ...telematics,
          softwareReady: true,
          connections: connectionResult.rows[0] || { total: 0, connected: 0 },
          requiredSecrets: [
            "GOODFLEET_TELEMATICS_PROVIDER_URL",
            "GOODFLEET_TELEMATICS_PROVIDER_TOKEN",
          ],
        },
        socialSignIn: {
          state: socialProviders.some(provider => provider.available)
            ? "ready"
            : "external_activation_required",
          providers: socialProviders,
        },
        identityVerification: {
          state: "ready_manual",
          softwareReady: true,
          mode: "management_review",
          externalAutomationConfigured: false,
        },
        insuranceVerification: {
          state: "ready_manual",
          softwareReady: true,
          mode: "document_review",
          externalAutomationConfigured: false,
        },
        claims: {
          state: "ready_internal",
          softwareReady: true,
          mode: "internal_case_management",
          externalInsurerConfigured: false,
        },
      },
    });
  } catch (error) {
    next(error);
  }
});

router.get("/host-team", requireHost, async (request, response, next) => {
  const client = await pool.connect();
  try {
    const profile = await ownerHostProfile(client, request.user.id);
    if (!profile) {
      return fail(response, 409, "HOST_PROFILE_REQUIRED", "Complete your host profile first.");
    }
    response.json({
      success: true,
      data: {
        hostProfileId: profile.id,
        members: (await hostTeamRows(client, profile.id)).map(hostMemberPayload),
      },
    });
  } catch (error) {
    next(error);
  } finally {
    client.release();
  }
});

router.get("/host-team/access", requireHost, async (request, response, next) => {
  try {
    const owned = await query(
      `SELECT id FROM fleet_host_profiles
        WHERE organization_id=$1 AND user_id=$2 LIMIT 1`,
      [ORGANIZATION_ID, request.user.id],
    );
    if (owned.rowCount) {
      return response.json({
        success: true,
        data: {
          hostProfileId: owned.rows[0].id,
          owner: true,
          role: "owner",
          permissions: [...HOST_PERMISSIONS],
          vehicleAccess: [],
        },
      });
    }
    const delegated = await query(
      `SELECT member.*,
              COALESCE((
                SELECT jsonb_agg(jsonb_build_object(
                  'vehicleId',access.vehicle_id,
                  'permissions',access.permissions_json
                ))
                  FROM fleet_host_team_vehicle_access access
                 WHERE access.organization_id=member.organization_id
                   AND access.team_member_id=member.id
              ),'[]'::jsonb) AS vehicle_access
         FROM fleet_host_team_members member
        WHERE member.organization_id=$1
          AND member.status='active'
          AND (member.user_id=$2 OR lower(member.invited_email)=lower($3))
        ORDER BY member.accepted_at DESC NULLS LAST
        LIMIT 1`,
      [ORGANIZATION_ID, request.user.id, clean(request.user.email, 320)],
    );
    if (!delegated.rowCount) {
      return fail(response, 403, "HOST_TEAM_ACCESS_REQUIRED", "No active host team access was found.");
    }
    const member = delegated.rows[0];
    response.json({
      success: true,
      data: {
        hostProfileId: member.host_profile_id,
        owner: false,
        role: member.role,
        permissions: member.permissions_json || [],
        vehicleAccess: member.vehicle_access || [],
      },
    });
  } catch (error) {
    next(error);
  }
});

router.post("/host-team/invitations", requireHost, async (request, response, next) => {
  const client = await pool.connect();
  try {
    const email = clean(request.body?.email, 320).toLowerCase();
    const role = clean(request.body?.role, 40).toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !HOST_TEAM_ROLES.has(role)) {
      return fail(response, 400, "HOST_TEAM_INVITATION_INVALID", "A valid email and team role are required.");
    }
    if (email === clean(request.user.email, 320).toLowerCase()) {
      return fail(response, 409, "HOST_TEAM_SELF_INVITE", "The host owner already has full access.");
    }
    await client.query("BEGIN");
    const profile = await ownerHostProfile(client, request.user.id, true);
    if (!profile) {
      await client.query("ROLLBACK");
      return fail(response, 409, "HOST_PROFILE_REQUIRED", "Complete your host profile first.");
    }
    const account = await client.query(
      `SELECT id,display_name,email FROM users WHERE lower(email)=lower($1) LIMIT 1`,
      [email],
    );
    const desired = permissions(request.body?.permissions);
    const created = await client.query(
      `INSERT INTO fleet_host_team_members
        (organization_id,host_profile_id,user_id,invited_email,display_name,
         role,status,permissions_json,invited_by,accepted_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)
       ON CONFLICT (organization_id,host_profile_id,invited_email)
       DO UPDATE SET role=EXCLUDED.role,permissions_json=EXCLUDED.permissions_json,
         status=CASE
           WHEN fleet_host_team_members.status='active' THEN 'active'
           ELSE EXCLUDED.status
         END,user_id=COALESCE(fleet_host_team_members.user_id,EXCLUDED.user_id),
         display_name=COALESCE(EXCLUDED.display_name,fleet_host_team_members.display_name),
         updated_at=NOW()
       RETURNING *`,
      [
        ORGANIZATION_ID,
        profile.id,
        account.rows[0]?.id || null,
        email,
        account.rows[0]?.display_name || null,
        role,
        account.rowCount ? "active" : "invited",
        JSON.stringify(desired),
        request.user.id,
        account.rowCount ? new Date() : null,
      ],
    );
    await audit(client, request, "host_team.invited", "host_team_member", created.rows[0].id, {
      email,
      role,
      permissions: desired,
    });
    await client.query("COMMIT");
    await notificationService.createNotification({
      appId: "goodfleet",
      recipientUserId: account.rows[0]?.id || undefined,
      recipientEmail: email,
      title: "You were invited to a GoodFleet host team",
      message: `${clean(request.user.displayName, 160) || "A GoodFleet host"} granted you ${role.replaceAll("_", " ")} access.`,
      category: "account",
      severity: "info",
      channel: account.rowCount ? "in_app" : "email",
      actionUrl: "/host/team",
      source: "goodfleet-host-team",
      sourceId: created.rows[0].id,
    }).catch(() => {});
    response.status(201).json({
      success: true,
      data: hostMemberPayload({ ...created.rows[0], vehicle_access: [] }),
    });
  } catch (error) {
    await client.query("ROLLBACK");
    next(error);
  } finally {
    client.release();
  }
});

router.patch("/host-team/:memberId", requireHost, async (request, response, next) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const profile = await ownerHostProfile(client, request.user.id, true);
    if (!profile) {
      await client.query("ROLLBACK");
      return fail(response, 404, "HOST_TEAM_MEMBER_NOT_FOUND", "Host team member not found.");
    }
    const memberResult = await client.query(
      `SELECT * FROM fleet_host_team_members
        WHERE organization_id=$1 AND host_profile_id=$2 AND id=$3
        FOR UPDATE`,
      [ORGANIZATION_ID, profile.id, request.params.memberId],
    );
    if (!memberResult.rowCount) {
      await client.query("ROLLBACK");
      return fail(response, 404, "HOST_TEAM_MEMBER_NOT_FOUND", "Host team member not found.");
    }
    const current = memberResult.rows[0];
    const role = HOST_TEAM_ROLES.has(clean(request.body?.role, 40))
      ? clean(request.body.role, 40)
      : current.role;
    const status = ["active", "suspended", "revoked"].includes(clean(request.body?.status, 40))
      ? clean(request.body.status, 40)
      : current.status;
    const desired = request.body?.permissions === undefined
      ? current.permissions_json
      : permissions(request.body.permissions);
    const updated = await client.query(
      `UPDATE fleet_host_team_members
          SET role=$4,status=$5,permissions_json=$6::jsonb,updated_at=NOW()
        WHERE organization_id=$1 AND host_profile_id=$2 AND id=$3
        RETURNING *`,
      [ORGANIZATION_ID, profile.id, current.id, role, status, JSON.stringify(desired)],
    );
    if (Array.isArray(request.body?.vehicleAccess)) {
      await client.query(
        `DELETE FROM fleet_host_team_vehicle_access
          WHERE organization_id=$1 AND team_member_id=$2`,
        [ORGANIZATION_ID, current.id],
      );
      for (const access of request.body.vehicleAccess.slice(0, 200)) {
        const vehicleId = clean(access?.vehicleId, 100);
        const allowed = permissions(access?.permissions);
        const ownsVehicle = await client.query(
          `SELECT 1
             FROM fleet_vehicle_listings listing
            WHERE listing.organization_id=$1
              AND listing.host_profile_id=$2
              AND listing.vehicle_id=$3
              AND listing.archived_at IS NULL`,
          [ORGANIZATION_ID, profile.id, vehicleId],
        );
        if (!ownsVehicle.rowCount) continue;
        await client.query(
          `INSERT INTO fleet_host_team_vehicle_access
            (organization_id,team_member_id,vehicle_id,permissions_json,granted_by)
           VALUES ($1,$2,$3,$4::jsonb,$5)`,
          [ORGANIZATION_ID, current.id, vehicleId, JSON.stringify(allowed), request.user.id],
        );
      }
    }
    await audit(client, request, "host_team.updated", "host_team_member", current.id, {
      role,
      status,
      permissions: desired,
    });
    await client.query("COMMIT");
    const rows = await hostTeamRows(client, profile.id);
    response.json({
      success: true,
      data: hostMemberPayload(rows.find(row => row.id === current.id)),
    });
  } catch (error) {
    await client.query("ROLLBACK");
    next(error);
  } finally {
    client.release();
  }
});

router.get("/roadside/readiness", requireEmployee, async (_request, response, next) => {
  try {
    response.json({
      success: true,
      data: {
        configured: Boolean(await providerConfiguration("roadside")),
        mode: (await providerConfiguration("roadside")) ? "live" : "intake_only",
        requiredSecrets: [
          "GOODFLEET_ROADSIDE_PROVIDER_URL",
          "GOODFLEET_ROADSIDE_PROVIDER_TOKEN",
        ],
      },
    });
  } catch (error) {
    next(error);
  }
});

router.get("/roadside/cases", async (request, response, next) => {
  const client = await pool.connect();
  try {
    const role = fleetRole(request);
    const employee = EMPLOYEE_ROLES.has(role);
    const result = await client.query(
      `SELECT roadside.id
         FROM fleet_roadside_cases roadside
         LEFT JOIN fleet_customers customer
           ON customer.organization_id=roadside.organization_id
          AND customer.id=roadside.customer_id
        WHERE roadside.organization_id=$1
          AND ($2::boolean OR roadside.requested_by=$3 OR customer.user_id=$3)
        ORDER BY roadside.created_at DESC
        LIMIT 500`,
      [ORGANIZATION_ID, employee, request.user.id],
    );
    const rows = [];
    for (const item of result.rows) {
      rows.push(roadsidePayload(await roadsideRecord(client, item.id)));
    }
    response.json({ success: true, data: rows });
  } catch (error) {
    next(error);
  } finally {
    client.release();
  }
});

router.post("/roadside/cases", async (request, response, next) => {
  const client = await pool.connect();
  try {
    const type = clean(request.body?.assistanceType, 40).toLowerCase();
    if (!ROAD_ASSISTANCE_TYPES.has(type)) {
      return fail(response, 400, "ROADSIDE_TYPE_REQUIRED", "Select the roadside assistance needed.");
    }
    const latitude = numberOrNull(request.body?.location?.latitude, -90, 90);
    const longitude = numberOrNull(request.body?.location?.longitude, -180, 180);
    if ((latitude === null) !== (longitude === null)) {
      return fail(response, 400, "ROADSIDE_LOCATION_INVALID", "Latitude and longitude must be provided together.");
    }
    const role = fleetRole(request);
    await client.query("BEGIN");
    let booking = null;
    const bookingId = clean(request.body?.bookingId, 100);
    if (bookingId) {
      const result = await client.query(
        `SELECT booking.*,customer.user_id AS customer_user_id
           FROM fleet_bookings booking
           JOIN fleet_customers customer
             ON customer.organization_id=booking.organization_id
            AND customer.id=booking.customer_id
          WHERE booking.organization_id=$1 AND booking.id=$2
            AND booking.archived_at IS NULL
          FOR UPDATE OF booking`,
        [ORGANIZATION_ID, bookingId],
      );
      booking = result.rows[0] || null;
      if (
        !booking ||
        (!EMPLOYEE_ROLES.has(role) && booking.customer_user_id !== request.user.id)
      ) {
        await client.query("ROLLBACK");
        return fail(response, 404, "BOOKING_NOT_FOUND", "The selected trip was not found.");
      }
    }
    const created = await client.query(
      `INSERT INTO fleet_roadside_cases
        (organization_id,booking_id,customer_id,vehicle_id,requested_by,
         assistance_type,priority,latitude,longitude,address,notes,safety_concern)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING *`,
      [
        ORGANIZATION_ID,
        booking?.id || null,
        booking?.customer_id || null,
        booking?.vehicle_id || null,
        request.user.id,
        type,
        request.body?.safetyConcern ? "emergency" : clean(request.body?.priority, 40) || "urgent",
        latitude,
        longitude,
        clean(request.body?.location?.address, 500) || null,
        clean(request.body?.notes, 4000),
        Boolean(request.body?.safetyConcern),
      ],
    );
    await client.query(
      `INSERT INTO fleet_roadside_events
        (organization_id,case_id,actor_id,event_type,details_json)
       VALUES ($1,$2,$3,'roadside.requested',$4::jsonb)`,
      [ORGANIZATION_ID, created.rows[0].id, request.user.id, JSON.stringify({ type })],
    );
    await audit(client, request, "roadside.requested", "roadside_case", created.rows[0].id, {
      bookingId: booking?.id || null,
      assistanceType: type,
      safetyConcern: Boolean(request.body?.safetyConcern),
    });
    await client.query("COMMIT");
    await notificationService.createNotification({
      appId: "goodfleet",
      title: request.body?.safetyConcern ? "Emergency roadside request" : "Roadside assistance requested",
      message: `${clean(request.user.displayName, 160) || "A customer"} requested ${type.replaceAll("_", " ")} assistance.`,
      category: "support",
      severity: request.body?.safetyConcern ? "critical" : "warning",
      actionUrl: `/app/support?tab=roadside&case=${encodeURIComponent(created.rows[0].id)}`,
      source: "goodfleet-roadside",
      sourceId: created.rows[0].id,
    }).catch(() => {});
    response.status(201).json({
      success: true,
      data: roadsidePayload(await roadsideRecord(client, created.rows[0].id)),
    });
  } catch (error) {
    await client.query("ROLLBACK");
    next(error);
  } finally {
    client.release();
  }
});

router.post("/roadside/cases/:caseId/dispatch", requireManagement, async (request, response, next) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const record = await roadsideRecord(client, request.params.caseId);
    if (!record) {
      await client.query("ROLLBACK");
      return fail(response, 404, "ROADSIDE_CASE_NOT_FOUND", "Roadside case not found.");
    }
    const configuration = await providerConfiguration("roadside");
    if (!configuration) {
      await client.query(
        `UPDATE fleet_roadside_cases
            SET status='awaiting_provider',provider_status='credentials_required',
                assigned_to=$3,updated_at=NOW()
          WHERE organization_id=$1 AND id=$2`,
        [ORGANIZATION_ID, record.id, request.user.id],
      );
      await client.query(
        `INSERT INTO fleet_roadside_events
          (organization_id,case_id,actor_id,event_type,details_json)
         VALUES ($1,$2,$3,'roadside.awaiting_provider',$4::jsonb)`,
        [ORGANIZATION_ID, record.id, request.user.id, JSON.stringify({ reason: "credentials_required" })],
      );
      await audit(client, request, "roadside.dispatch_blocked", "roadside_case", record.id, {
        reason: "provider_credentials_required",
      });
      await client.query("COMMIT");
      return fail(
        response,
        409,
        "ROADSIDE_PROVIDER_NOT_CONFIGURED",
        "The request is saved, but live dispatch requires roadside provider credentials.",
        roadsidePayload(await roadsideRecord(client, record.id)),
      );
    }
    let providerResult;
    try {
      providerResult = await providerRequest(configuration, "/dispatch", {
        caseId: record.id,
        assistanceType: record.assistance_type,
        priority: record.priority,
        location: {
          latitude: record.latitude,
          longitude: record.longitude,
          address: record.address,
        },
        vehicle: {
          id: record.vehicle_id,
          description: [record.model_year, record.make, record.model].filter(Boolean).join(" "),
        },
        notes: record.notes,
      });
    } catch (error) {
      await client.query(
        `UPDATE fleet_roadside_cases
            SET status='failed',provider_status=$3,updated_at=NOW()
          WHERE organization_id=$1 AND id=$2`,
        [ORGANIZATION_ID, record.id, clean(error.code, 120) || "provider_error"],
      );
      await audit(client, request, "roadside.dispatch_failed", "roadside_case", record.id, {
        errorCode: clean(error.code, 120) || "provider_error",
      });
      await client.query("COMMIT");
      return fail(response, 502, "ROADSIDE_PROVIDER_FAILED", "The provider did not accept the dispatch.");
    }
    await client.query(
      `UPDATE fleet_roadside_cases
          SET status='dispatched',provider=$3,provider_reference=$4,
              provider_status=$5,assigned_to=$6,dispatched_at=NOW(),updated_at=NOW()
        WHERE organization_id=$1 AND id=$2`,
      [
        ORGANIZATION_ID,
        record.id,
        clean(providerResult.provider, 120) || configuration.url.hostname,
        clean(providerResult.reference, 240) || null,
        clean(providerResult.status, 120) || "accepted",
        request.user.id,
      ],
    );
    await client.query(
      `INSERT INTO fleet_roadside_events
        (organization_id,case_id,actor_id,event_type,details_json)
       VALUES ($1,$2,$3,'roadside.dispatched',$4::jsonb)`,
      [ORGANIZATION_ID, record.id, request.user.id, JSON.stringify({
        providerReference: clean(providerResult.reference, 240) || null,
      })],
    );
    await audit(client, request, "roadside.dispatched", "roadside_case", record.id, {
      providerReference: clean(providerResult.reference, 240) || null,
    });
    await client.query("COMMIT");
    const dispatched = await roadsideRecord(client, record.id);
    await notifyRoadsideCustomer(
      dispatched,
      "Roadside help is on the way",
      dispatched.provider_reference
        ? `Your roadside request was accepted. Reference: ${dispatched.provider_reference}.`
        : "Your roadside request was accepted by the assistance provider.",
    );
    response.json({
      success: true,
      data: roadsidePayload(dispatched),
    });
  } catch (error) {
    await client.query("ROLLBACK");
    next(error);
  } finally {
    client.release();
  }
});

router.patch("/roadside/cases/:caseId", requireEmployee, async (request, response, next) => {
  const client = await pool.connect();
  try {
    const status = clean(request.body?.status, 40).toLowerCase();
    if (!ROAD_STATUSES.has(status)) {
      return fail(response, 400, "ROADSIDE_STATUS_INVALID", "Select a valid roadside status.");
    }
    await client.query("BEGIN");
    const result = await client.query(
      `UPDATE fleet_roadside_cases
          SET status=$3,provider_status=COALESCE(NULLIF($4,''),provider_status),
              resolved_at=CASE WHEN $3='resolved' THEN NOW() ELSE resolved_at END,
              updated_at=NOW()
        WHERE organization_id=$1 AND id=$2
        RETURNING id`,
      [ORGANIZATION_ID, request.params.caseId, status, clean(request.body?.providerStatus, 120)],
    );
    if (!result.rowCount) {
      await client.query("ROLLBACK");
      return fail(response, 404, "ROADSIDE_CASE_NOT_FOUND", "Roadside case not found.");
    }
    await client.query(
      `INSERT INTO fleet_roadside_events
        (organization_id,case_id,actor_id,event_type,details_json)
       VALUES ($1,$2,$3,$4,$5::jsonb)`,
      [
        ORGANIZATION_ID,
        request.params.caseId,
        request.user.id,
        `roadside.${status}`,
        JSON.stringify({ note: clean(request.body?.note, 1000) }),
      ],
    );
    await audit(client, request, `roadside.${status}`, "roadside_case", request.params.caseId, {
      note: clean(request.body?.note, 1000),
    });
    await client.query("COMMIT");
    const roadside = await roadsideRecord(client, request.params.caseId);
    await notifyRoadsideCustomer(
      roadside,
      `Roadside request ${status.replaceAll("_", " ")}`,
      clean(request.body?.note, 1000) ||
        `Your roadside request is now ${status.replaceAll("_", " ")}.`,
    );
    response.json({
      success: true,
      data: roadsidePayload(roadside),
    });
  } catch (error) {
    await client.query("ROLLBACK");
    next(error);
  } finally {
    client.release();
  }
});

async function telematicsRows(client) {
  const result = await client.query(
    `SELECT vehicle.id AS vehicle_id,vehicle.make,vehicle.model,vehicle.model_year,
            vehicle.license_plate,vehicle.payload AS vehicle_payload,
            connection.id AS connection_id,connection.provider,
            connection.external_vehicle_id,connection.status AS connection_status,
            connection.capabilities_json,connection.safe_configuration_json,
            connection.last_synced_at,connection.last_error_code,
            snapshot.latest_snapshot
       FROM fleet_vehicles vehicle
       LEFT JOIN fleet_telematics_connections connection
         ON connection.organization_id=vehicle.organization_id
        AND connection.vehicle_id=vehicle.id
       LEFT JOIN LATERAL (
         SELECT to_jsonb(latest.*) AS latest_snapshot
           FROM fleet_telematics_snapshots latest
          WHERE latest.organization_id=vehicle.organization_id
            AND latest.vehicle_id=vehicle.id
          ORDER BY latest.captured_at DESC
          LIMIT 1
       ) snapshot ON true
      WHERE vehicle.organization_id=$1 AND vehicle.archived_at IS NULL
      ORDER BY vehicle.make,vehicle.model`,
    [ORGANIZATION_ID],
  );
  return result.rows;
}

router.get("/telematics/readiness", requireEmployee, async (_request, response, next) => {
  try {
    const configured = Boolean(await providerConfiguration("telematics"));
    const connections = await query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE status='connected')::int AS connected
         FROM fleet_telematics_connections WHERE organization_id=$1`,
      [ORGANIZATION_ID],
    );
    response.json({
      success: true,
      data: {
        configured,
        mode: configured ? "live" : "disabled",
        connections: connections.rows[0] || { total: 0, connected: 0 },
        requiredSecrets: [
          "GOODFLEET_TELEMATICS_PROVIDER_URL",
          "GOODFLEET_TELEMATICS_PROVIDER_TOKEN",
        ],
      },
    });
  } catch (error) {
    next(error);
  }
});

router.get("/telematics/vehicles", requireEmployee, async (_request, response, next) => {
  const client = await pool.connect();
  try {
    response.json({
      success: true,
      data: (await telematicsRows(client)).map(telematicsPayload),
    });
  } catch (error) {
    next(error);
  } finally {
    client.release();
  }
});

router.put("/telematics/vehicles/:vehicleId/connection", requireManagement, async (request, response, next) => {
  const client = await pool.connect();
  try {
    const provider = clean(request.body?.provider, 100).toLowerCase();
    const externalVehicleId = clean(request.body?.externalVehicleId, 240);
    const capabilities = permissions(request.body?.capabilities, TELEMATICS_CAPABILITIES);
    if (!provider || !externalVehicleId || !capabilities.length) {
      return fail(
        response,
        400,
        "TELEMATICS_CONNECTION_INVALID",
        "Provider, external vehicle ID, and at least one capability are required.",
      );
    }
    await client.query("BEGIN");
    const vehicle = await client.query(
      `SELECT id FROM fleet_vehicles
        WHERE organization_id=$1 AND id=$2 AND archived_at IS NULL
        FOR UPDATE`,
      [ORGANIZATION_ID, request.params.vehicleId],
    );
    if (!vehicle.rowCount) {
      await client.query("ROLLBACK");
      return fail(response, 404, "VEHICLE_NOT_FOUND", "Vehicle not found.");
    }
    const configuration = await providerConfiguration("telematics");
    await client.query(
      `INSERT INTO fleet_telematics_connections
        (organization_id,vehicle_id,provider,external_vehicle_id,status,
         capabilities_json,safe_configuration_json,configured_by)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8)
       ON CONFLICT (organization_id,vehicle_id)
       DO UPDATE SET provider=EXCLUDED.provider,
         external_vehicle_id=EXCLUDED.external_vehicle_id,
         status=EXCLUDED.status,capabilities_json=EXCLUDED.capabilities_json,
         safe_configuration_json=EXCLUDED.safe_configuration_json,
         configured_by=EXCLUDED.configured_by,updated_at=NOW()`,
      [
        ORGANIZATION_ID,
        vehicle.rows[0].id,
        provider,
        externalVehicleId,
        configuration ? "connected" : "pending",
        JSON.stringify(capabilities),
        JSON.stringify({
          remoteCommandsRequireManager: true,
          lockRequiresIgnitionOff: true,
          lockRequiresStationaryVehicle: true,
        }),
        request.user.id,
      ],
    );
    await audit(client, request, "telematics.connection_configured", "vehicle", vehicle.rows[0].id, {
      provider,
      capabilities,
      credentialsConfigured: Boolean(configuration),
    });
    await client.query("COMMIT");
    const row = (await telematicsRows(client)).find(item => item.vehicle_id === vehicle.rows[0].id);
    response.json({ success: true, data: telematicsPayload(row) });
  } catch (error) {
    await client.query("ROLLBACK");
    next(error);
  } finally {
    client.release();
  }
});

async function syncTelematics(client, request, record) {
  const configuration = await providerConfiguration("telematics");
  if (!configuration) {
    const error = new Error("Telematics provider credentials are required.");
    error.statusCode = 409;
    error.code = "TELEMATICS_PROVIDER_NOT_CONFIGURED";
    throw error;
  }
  const payload = await providerRequest(
    configuration,
    `/vehicles/${encodeURIComponent(record.external_vehicle_id)}/status`,
    { vehicleId: record.vehicle_id },
  );
  const capturedAt = new Date(payload.capturedAt || Date.now());
  if (Number.isNaN(capturedAt.getTime())) {
    const error = new Error("The provider returned an invalid telemetry timestamp.");
    error.statusCode = 502;
    error.code = "TELEMATICS_PROVIDER_INVALID_RESPONSE";
    throw error;
  }
  await client.query(
    `INSERT INTO fleet_telematics_snapshots
      (organization_id,connection_id,vehicle_id,latitude,longitude,speed_mph,
       odometer_miles,fuel_percent,battery_percent,ignition_on,doors_locked,
       heading_degrees,captured_at,raw_reference)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [
      ORGANIZATION_ID,
      record.connection_id,
      record.vehicle_id,
      numberOrNull(payload.latitude, -90, 90),
      numberOrNull(payload.longitude, -180, 180),
      numberOrNull(payload.speedMph, 0, 400),
      numberOrNull(payload.odometerMiles, 0, 10000000),
      numberOrNull(payload.fuelPercent, 0, 100),
      numberOrNull(payload.batteryPercent, 0, 100),
      payload.ignitionOn === null || payload.ignitionOn === undefined
        ? null
        : Boolean(payload.ignitionOn),
      payload.doorsLocked === null || payload.doorsLocked === undefined
        ? null
        : Boolean(payload.doorsLocked),
      numberOrNull(payload.headingDegrees, 0, 360),
      capturedAt.toISOString(),
      clean(payload.reference, 300) || null,
    ],
  );
  await client.query(
    `UPDATE fleet_telematics_connections
        SET status='connected',last_synced_at=NOW(),last_error_code=NULL,updated_at=NOW()
      WHERE organization_id=$1 AND id=$2`,
    [ORGANIZATION_ID, record.connection_id],
  );
  await audit(client, request, "telematics.snapshot_received", "vehicle", record.vehicle_id, {
    capturedAt: capturedAt.toISOString(),
  });
}

router.post("/telematics/vehicles/:vehicleId/sync", requireEmployee, async (request, response, next) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const row = (await telematicsRows(client)).find(item => item.vehicle_id === request.params.vehicleId);
    if (!row?.connection_id) {
      await client.query("ROLLBACK");
      return fail(response, 409, "TELEMATICS_CONNECTION_REQUIRED", "Connect this vehicle to a telematics provider first.");
    }
    await syncTelematics(client, request, row);
    await client.query("COMMIT");
    const updated = (await telematicsRows(client)).find(item => item.vehicle_id === row.vehicle_id);
    response.json({ success: true, data: telematicsPayload(updated) });
  } catch (error) {
    await client.query("ROLLBACK");
    next(error);
  } finally {
    client.release();
  }
});

router.post("/telematics/vehicles/:vehicleId/commands", requireManagement, async (request, response, next) => {
  const client = await pool.connect();
  try {
    const command = clean(request.body?.command, 40).toLowerCase();
    const idempotencyKey = clean(request.get("Idempotency-Key"), 200);
    if (!TELEMATICS_COMMANDS.has(command) || !idempotencyKey) {
      return fail(response, 400, "TELEMATICS_COMMAND_INVALID", "A supported command and Idempotency-Key are required.");
    }
    if (command !== "locate" && request.body?.confirmed !== true) {
      return fail(response, 400, "TELEMATICS_CONFIRMATION_REQUIRED", "Confirm the remote vehicle action.");
    }
    await client.query("BEGIN");
    const row = (await telematicsRows(client)).find(item => item.vehicle_id === request.params.vehicleId);
    if (!row?.connection_id) {
      await client.query("ROLLBACK");
      return fail(response, 409, "TELEMATICS_CONNECTION_REQUIRED", "Connect this vehicle to a telematics provider first.");
    }
    const existing = await client.query(
      `SELECT * FROM fleet_telematics_commands
        WHERE organization_id=$1 AND idempotency_key=$2`,
      [ORGANIZATION_ID, idempotencyKey],
    );
    if (existing.rowCount) {
      await client.query("COMMIT");
      return response.json({ success: true, data: existing.rows[0] });
    }
    const capabilities = new Set(row.capabilities_json || []);
    const requiredCapability =
      command === "lock" || command === "unlock" ? "door_lock" : command;
    if (!capabilities.has(requiredCapability === "locate" ? "location" : requiredCapability)) {
      await client.query("ROLLBACK");
      return fail(response, 409, "TELEMATICS_CAPABILITY_UNAVAILABLE", "This vehicle does not support that remote action.");
    }
    if (
      command === "lock" &&
      (!row.latest_snapshot ||
        row.latest_snapshot.ignition_on !== false ||
        Number(row.latest_snapshot.speed_mph || 0) > 0)
    ) {
      await client.query("ROLLBACK");
      return fail(
        response,
        409,
        "REMOTE_LOCK_SAFETY_BLOCK",
        "Remote lock requires current proof that the vehicle is stationary with ignition off.",
      );
    }
    const created = await client.query(
      `INSERT INTO fleet_telematics_commands
        (organization_id,connection_id,vehicle_id,requested_by,command,
         idempotency_key,request_json)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
       RETURNING *`,
      [
        ORGANIZATION_ID,
        row.connection_id,
        row.vehicle_id,
        request.user.id,
        command,
        idempotencyKey,
        JSON.stringify({ confirmed: request.body?.confirmed === true }),
      ],
    );
    const configuration = await providerConfiguration("telematics");
    if (!configuration) {
      await client.query(
        `UPDATE fleet_telematics_commands
            SET status='denied',error_code='credentials_required',completed_at=NOW()
          WHERE organization_id=$1 AND id=$2`,
        [ORGANIZATION_ID, created.rows[0].id],
      );
      await audit(client, request, "telematics.command_denied", "vehicle", row.vehicle_id, {
        command,
        reason: "provider_credentials_required",
      });
      await client.query("COMMIT");
      return fail(
        response,
        409,
        "TELEMATICS_PROVIDER_NOT_CONFIGURED",
        "The command was safely blocked because telematics provider credentials are not configured.",
      );
    }
    try {
      const providerResult = await providerRequest(
        configuration,
        `/vehicles/${encodeURIComponent(row.external_vehicle_id)}/commands`,
        { command, commandId: created.rows[0].id },
      );
      const status = providerResult.completed === true ? "succeeded" : "dispatched";
      const updated = await client.query(
        `UPDATE fleet_telematics_commands
            SET status=$3,provider_reference=$4,response_json=$5::jsonb,
                completed_at=CASE WHEN $3='succeeded' THEN NOW() ELSE NULL END
          WHERE organization_id=$1 AND id=$2
          RETURNING *`,
        [
          ORGANIZATION_ID,
          created.rows[0].id,
          status,
          clean(providerResult.reference, 240) || null,
          JSON.stringify({
            status: clean(providerResult.status, 120) || status,
            completed: providerResult.completed === true,
          }),
        ],
      );
      await audit(client, request, "telematics.command_dispatched", "vehicle", row.vehicle_id, {
        command,
        status,
        providerReference: clean(providerResult.reference, 240) || null,
      });
      await client.query("COMMIT");
      response.status(202).json({ success: true, data: updated.rows[0] });
    } catch (error) {
      await client.query(
        `UPDATE fleet_telematics_commands
            SET status='failed',error_code=$3,completed_at=NOW()
          WHERE organization_id=$1 AND id=$2`,
        [ORGANIZATION_ID, created.rows[0].id, clean(error.code, 120) || "provider_error"],
      );
      await audit(client, request, "telematics.command_failed", "vehicle", row.vehicle_id, {
        command,
        errorCode: clean(error.code, 120) || "provider_error",
      });
      await client.query("COMMIT");
      return fail(response, 502, "TELEMATICS_PROVIDER_FAILED", "The telematics provider did not accept the command.");
    }
  } catch (error) {
    await client.query("ROLLBACK");
    next(error);
  } finally {
    client.release();
  }
});

router.get("/telematics/vehicles/:vehicleId/history", requireEmployee, async (request, response, next) => {
  try {
    const hours = Math.min(Math.max(Number(request.query.hours) || 24, 1), 720);
    const result = await query(
      `SELECT id,latitude,longitude,speed_mph,odometer_miles,fuel_percent,
              battery_percent,ignition_on,doors_locked,heading_degrees,
              captured_at,received_at
         FROM fleet_telematics_snapshots
        WHERE organization_id=$1 AND vehicle_id=$2
          AND captured_at >= NOW() - ($3::text || ' hours')::interval
        ORDER BY captured_at`,
      [ORGANIZATION_ID, request.params.vehicleId, hours],
    );
    response.json({ success: true, data: result.rows });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
