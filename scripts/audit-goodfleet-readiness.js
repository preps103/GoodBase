"use strict";

const path = require("node:path");

const goodBaseRoot = path.resolve(
  process.env.GOODBASE_ROOT || path.join(__dirname, ".."),
);
const database = require(path.join(goodBaseRoot, "src/config/database"));

const ORGANIZATION_ID =
  process.env.GOODFLEET_PUBLIC_ORGANIZATION_ID || "org_goodos";

const REQUIRED_TABLES = [
  "fleet_audit_events",
  "fleet_booking_additional_drivers",
  "fleet_booking_change_requests",
  "fleet_bookings",
  "fleet_chat_channel_members",
  "fleet_chat_channels",
  "fleet_chat_messages",
  "fleet_chat_reads",
  "fleet_claim_cases",
  "fleet_claim_events",
  "fleet_claim_evidence",
  "fleet_condition_photos",
  "fleet_condition_reports",
  "fleet_contract_envelopes",
  "fleet_contract_events",
  "fleet_contract_recipients",
  "fleet_contract_templates",
  "fleet_customer_checkins",
  "fleet_customer_notification_deliveries",
  "fleet_customer_notifications",
  "fleet_customer_support_messages",
  "fleet_customer_support_tickets",
  "fleet_customers",
  "fleet_host_profiles",
  "fleet_host_team_members",
  "fleet_host_team_vehicle_access",
  "fleet_managed_assets",
  "fleet_payment_operations",
  "fleet_payment_webhook_events",
  "fleet_roadside_cases",
  "fleet_roadside_events",
  "fleet_staff_onboarding_progress",
  "fleet_telematics_commands",
  "fleet_telematics_connections",
  "fleet_telematics_snapshots",
  "fleet_trip_conversations",
  "fleet_trip_message_reads",
  "fleet_trip_message_reports",
  "fleet_trip_messages",
  "fleet_trip_reviews",
  "fleet_vehicle_listings",
  "fleet_vehicles",
  "fleet_workspace_revisions",
  "fleet_workspace_state",
];

const ACTIVE_BOOKING_STATUSES = [
  "pending_payment",
  "confirmed",
  "assigned",
  "checked_in",
  "checked_out",
  "extended",
  "overdue",
];

function asCountMap(rows) {
  return Object.fromEntries(rows.map(row => [row.table_name, Number(row.row_count)]));
}

async function tableInventory(client) {
  const installed = await client.query(
    `SELECT tablename
       FROM pg_catalog.pg_tables
      WHERE schemaname='public' AND tablename=ANY($1::text[])
      ORDER BY tablename`,
    [REQUIRED_TABLES],
  );
  const installedNames = installed.rows.map(row => row.tablename);
  const missing = REQUIRED_TABLES.filter(name => !installedNames.includes(name));
  const scopedColumns = await client.query(
    `SELECT table_name
       FROM information_schema.columns
      WHERE table_schema='public'
        AND table_name=ANY($1::text[])
        AND column_name='organization_id'`,
    [installedNames],
  );
  const organizationScopedTables = new Set(
    scopedColumns.rows.map(row => row.table_name),
  );

  const counts = [];
  for (const tableName of installedNames) {
    const result = await client.query(
      organizationScopedTables.has(tableName)
        ? `SELECT COUNT(*)::bigint AS row_count FROM ${tableName}
            WHERE organization_id=$1`
        : `SELECT COUNT(*)::bigint AS row_count FROM ${tableName}`,
      organizationScopedTables.has(tableName) ? [ORGANIZATION_ID] : [],
    );
    counts.push({ table_name: tableName, row_count: result.rows[0].row_count });
  }

  return {
    expected: REQUIRED_TABLES.length,
    installed: installedNames.length,
    missing,
    counts: asCountMap(counts),
  };
}

async function constraints(client) {
  const result = await client.query(
    `SELECT relation.relname AS table_name,
            constraint_record.conname AS constraint_name,
            constraint_record.contype AS constraint_type,
            constraint_record.convalidated AS validated
       FROM pg_constraint constraint_record
       JOIN pg_class relation ON relation.oid=constraint_record.conrelid
       JOIN pg_namespace namespace_record ON namespace_record.oid=relation.relnamespace
      WHERE namespace_record.nspname='public'
        AND relation.relname LIKE 'fleet\\_%' ESCAPE '\\'
        AND constraint_record.contype IN ('c','f','p','u')
      ORDER BY relation.relname,constraint_record.conname`,
  );
  const invalid = result.rows
    .filter(row => !row.validated)
    .map(row => ({
      table: row.table_name,
      constraint: row.constraint_name,
      type: row.constraint_type,
    }));
  return {
    total: result.rows.length,
    invalid: invalid.length,
    invalidConstraints: invalid,
  };
}

async function integrity(client) {
  const result = await client.query(
    `SELECT
       (SELECT COUNT(*)::integer
          FROM fleet_bookings booking
          LEFT JOIN fleet_customers customer
            ON customer.organization_id=booking.organization_id
           AND customer.id=booking.customer_id
         WHERE booking.organization_id=$1
           AND booking.archived_at IS NULL
           AND customer.id IS NULL) AS bookings_without_customer,
       (SELECT COUNT(*)::integer
          FROM fleet_bookings booking
          LEFT JOIN fleet_vehicles vehicle
            ON vehicle.organization_id=booking.organization_id
           AND vehicle.id=booking.vehicle_id
         WHERE booking.organization_id=$1
           AND booking.archived_at IS NULL
           AND booking.vehicle_id IS NOT NULL
           AND vehicle.id IS NULL) AS bookings_without_vehicle,
       (SELECT COUNT(*)::integer
          FROM fleet_vehicle_listings listing
          LEFT JOIN fleet_vehicles vehicle
            ON vehicle.organization_id=listing.organization_id
           AND vehicle.id=listing.vehicle_id
         WHERE listing.organization_id=$1
           AND listing.archived_at IS NULL
           AND vehicle.id IS NULL) AS listings_without_vehicle,
       (SELECT COUNT(*)::integer
          FROM fleet_condition_photos photo
          LEFT JOIN fleet_condition_reports report
            ON report.organization_id=photo.organization_id
           AND report.id=photo.report_id
         WHERE photo.organization_id=$1
           AND report.id IS NULL) AS photos_without_report,
       (SELECT COUNT(*)::integer
          FROM fleet_contract_recipients recipient
          LEFT JOIN fleet_contract_envelopes envelope
            ON envelope.organization_id=recipient.organization_id
           AND envelope.id=recipient.envelope_id
         WHERE recipient.organization_id=$1
           AND envelope.id IS NULL) AS recipients_without_envelope,
       (SELECT COUNT(*)::integer
          FROM fleet_trip_messages message
          LEFT JOIN fleet_trip_conversations conversation
            ON conversation.organization_id=message.organization_id
           AND conversation.id=message.conversation_id
         WHERE message.organization_id=$1
           AND conversation.id IS NULL) AS messages_without_conversation`,
    [ORGANIZATION_ID],
  );
  return Object.fromEntries(
    Object.entries(result.rows[0] || {}).map(([key, value]) => [key, Number(value)]),
  );
}

async function operationalIntegrity(client) {
  const result = await client.query(
    `SELECT
       (SELECT COUNT(*)::integer
          FROM fleet_workspace_state workspace
          LEFT JOIN fleet_workspace_revisions revision
            ON revision.organization_id=workspace.organization_id
           AND revision.workspace_version=workspace.version
           AND revision.state_json=workspace.state_json
         WHERE workspace.organization_id=$1
           AND revision.id IS NULL) AS current_workspace_without_revision,
       (SELECT COUNT(*)::integer
          FROM fleet_bookings booking
         WHERE booking.organization_id=$1
           AND booking.archived_at IS NULL
           AND (
             booking.paid_amount > booking.total_amount
             OR (booking.payment_status='paid' AND booking.paid_amount < booking.total_amount)
             OR (booking.payment_status='unpaid' AND booking.paid_amount > 0)
           )) AS booking_financial_mismatches,
       (SELECT COUNT(*)::integer
          FROM fleet_bookings booking
          JOIN fleet_vehicles vehicle
            ON vehicle.organization_id=booking.organization_id
           AND vehicle.id=booking.vehicle_id
         WHERE booking.organization_id=$1
           AND booking.archived_at IS NULL
           AND booking.status IN ('checked_out','extended','overdue')
           AND vehicle.status NOT IN ('checked_out','in_transit')) AS active_rental_vehicle_mismatches,
       (SELECT COUNT(*)::integer
          FROM fleet_contract_envelopes envelope
         WHERE envelope.organization_id=$1
           AND envelope.status='completed'
           AND (
             envelope.completed_at IS NULL
             OR envelope.completed_record_hash IS NULL
             OR NOT EXISTS (
               SELECT 1
                 FROM fleet_contract_recipients recipient
                WHERE recipient.organization_id=envelope.organization_id
                  AND recipient.envelope_id=envelope.id
                  AND recipient.status='signed'
                  AND recipient.signed_at IS NOT NULL
                  AND recipient.signature_hash IS NOT NULL
             )
           )) AS incomplete_completed_contracts,
       (SELECT COUNT(*)::integer
          FROM fleet_condition_reports report
         WHERE report.organization_id=$1
           AND report.status IN ('submitted','reviewed')
           AND (
             report.submitted_at IS NULL
             OR report.mileage IS NULL
             OR report.fuel_level IS NULL
             OR (
               SELECT COUNT(DISTINCT photo.slot)
                 FROM fleet_condition_photos photo
                WHERE photo.organization_id=report.organization_id
                  AND photo.report_id=report.id
                  AND photo.slot IN (
                    'front','rear','driver_side','passenger_side','dashboard',
                    'front_interior','rear_interior'
                  )
             ) < 7
           )) AS incomplete_submitted_condition_reports,
       (SELECT COUNT(*)::integer
          FROM fleet_customer_notifications notification
          CROSS JOIN LATERAL unnest(notification.channels) requested_channel
          LEFT JOIN fleet_customer_notification_deliveries delivery
            ON delivery.notification_id=notification.id
           AND delivery.channel=requested_channel
         WHERE notification.organization_id=$1
           AND delivery.id IS NULL) AS notification_channels_without_delivery,
       (SELECT COUNT(*)::integer
          FROM fleet_bookings booking
         WHERE booking.organization_id=$1
           AND booking.archived_at IS NULL
           AND booking.status='completed'
           AND COALESCE(booking.payload->>'dataProvenance','')
               <> 'recovered-legacy-live-ledger'
           AND COALESCE(
             NULLIF(booking.payload->>'actualReturnAt',''),
             NULLIF(booking.payload->>'returnInspectionCompletedAt',''),
             NULLIF(booking.payload->>'returnInspectionRequiredAt','')
           ) IS NULL) AS completed_bookings_without_return_record`,
    [ORGANIZATION_ID],
  );
  return Object.fromEntries(
    Object.entries(result.rows[0] || {}).map(([key, value]) => [key, Number(value)]),
  );
}

async function legacyDataWarnings(client) {
  const result = await client.query(
    `SELECT
       COUNT(*)::integer AS legacy_completed_bookings_without_return_record,
       COALESCE(
         array_agg(booking.reservation_number ORDER BY booking.return_at)
           FILTER (WHERE booking.id IS NOT NULL),
         ARRAY[]::text[]
       ) AS legacy_completed_reservation_numbers
       FROM fleet_bookings booking
      WHERE booking.organization_id=$1
        AND booking.archived_at IS NULL
        AND booking.status='completed'
        AND booking.payload->>'dataProvenance'='recovered-legacy-live-ledger'
        AND COALESCE(
          NULLIF(booking.payload->>'actualReturnAt',''),
          NULLIF(booking.payload->>'returnInspectionCompletedAt',''),
          NULLIF(booking.payload->>'returnInspectionRequiredAt','')
        ) IS NULL`,
    [ORGANIZATION_ID],
  );
  return {
    legacy_completed_bookings_without_return_record:
      Number(result.rows[0]?.legacy_completed_bookings_without_return_record || 0),
    legacy_completed_reservation_numbers:
      result.rows[0]?.legacy_completed_reservation_numbers || [],
  };
}

async function inventory(client) {
  const result = await client.query(
    `SELECT vehicle.id AS vehicle_id,
            concat_ws(' ',vehicle.model_year,vehicle.make,vehicle.model) AS vehicle,
            vehicle.status AS vehicle_status,
            vehicle.registration_expiry,
            vehicle.insurance_expiry,
            COALESCE(vehicle.payload->>'recallStatus','clear') AS recall_status,
            listing.id AS listing_id,
            COALESCE(listing.status,'missing') AS listing_status,
            COALESCE(listing.operator_managed,false) AS operator_managed,
            COALESCE(
              CASE WHEN jsonb_typeof(listing.photos_json)='array'
                THEN jsonb_array_length(listing.photos_json)
                ELSE 0
              END,
              0
            )::integer AS photo_count,
            COALESCE(
              host.status='active' AND host.identity_verification_status='verified',
              false
            ) AS host_verified,
            EXISTS (
              SELECT 1
                FROM fleet_bookings booking
               WHERE booking.organization_id=vehicle.organization_id
                 AND booking.vehicle_id=vehicle.id
                 AND booking.archived_at IS NULL
                 AND booking.status=ANY($2::text[])
            ) AS active_booking
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
    [ORGANIZATION_ID, ACTIVE_BOOKING_STATUSES],
  );

  return result.rows.map(row => {
    const blockers = [];
    if (!row.listing_id) blockers.push("listing_missing");
    else if (row.listing_status !== "active") blockers.push("listing_not_active");
    if (!["available", "reserved"].includes(row.vehicle_status)) {
      blockers.push("vehicle_not_available");
    }
    if (!row.registration_expiry) blockers.push("registration_expiry_missing");
    else if (new Date(row.registration_expiry) < new Date()) {
      blockers.push("registration_expired");
    }
    if (!row.insurance_expiry) blockers.push("insurance_expiry_missing");
    else if (new Date(row.insurance_expiry) < new Date()) {
      blockers.push("insurance_expired");
    }
    if (!["clear", "resolved"].includes(String(row.recall_status).toLowerCase())) {
      blockers.push("recall_not_cleared");
    }
    if (row.listing_id && !row.operator_managed && !row.host_verified) {
      blockers.push("host_verification_required");
    }
    if (Number(row.photo_count) < 6) {
      blockers.push("listing_photos_incomplete");
    }

    return {
      vehicleId: row.vehicle_id,
      vehicle: row.vehicle,
      vehicleStatus: row.vehicle_status,
      listingId: row.listing_id,
      listingStatus: row.listing_status,
      photoCount: Number(row.photo_count),
      activeBooking: Boolean(row.active_booking),
      bookable: blockers.length === 0,
      blockers,
    };
  });
}

async function providerState(client) {
  const result = await client.query(
    `SELECT
       COUNT(*) FILTER (
         WHERE provider_type IN ('google','apple','microsoft')
           AND status='enabled'
           AND controller_url IS NOT NULL
           AND secret_ref IS NOT NULL
       )::integer AS enabled_social,
       EXISTS (
         SELECT 1
           FROM goodbase_consumer_auth_providers
          WHERE organization_id=$1
            AND provider_type IN ('phone_otp','sms_mfa')
            AND status='enabled'
            AND controller_url IS NOT NULL
            AND secret_ref IS NOT NULL
       ) AS sms_configured
       FROM goodbase_consumer_auth_providers
      WHERE organization_id=$1`,
    [ORGANIZATION_ID],
  );
  return {
    socialProvidersEnabled: Number(result.rows[0]?.enabled_social || 0),
    smsConfigured: Boolean(result.rows[0]?.sms_configured),
    roadsideConfigured: Boolean(
      process.env.GOODFLEET_ROADSIDE_PROVIDER_URL &&
      process.env.GOODFLEET_ROADSIDE_PROVIDER_TOKEN
    ),
    telematicsConfigured: Boolean(
      process.env.GOODFLEET_TELEMATICS_PROVIDER_URL &&
      process.env.GOODFLEET_TELEMATICS_PROVIDER_TOKEN
    ),
    stripeConfigured: Boolean(
      process.env.STRIPE_SECRET_KEY && process.env.STRIPE_WEBHOOK_SECRET
    ),
  };
}

async function main() {
  const client = await database.pool.connect();
  try {
    await client.query("BEGIN TRANSACTION READ ONLY");
    const tables = await tableInventory(client);
    const schemaConstraints = await constraints(client);
    const dataIntegrity = await integrity(client);
    const operations = await operationalIntegrity(client);
    const warnings = await legacyDataWarnings(client);
    const vehicles = await inventory(client);
    const providers = await providerState(client);
    await client.query("COMMIT");

    const integrityFailures = Object.values(dataIntegrity)
      .reduce((sum, value) => sum + Number(value), 0);
    const operationalFailures = Object.values(operations)
      .reduce((sum, value) => sum + Number(value), 0);
    const report = {
      audit: "GoodFleet production readiness",
      generatedAt: new Date().toISOString(),
      organizationId: ORGANIZATION_ID,
      database: {
        tables,
        constraints: schemaConstraints,
        integrity: dataIntegrity,
        operations,
        warnings,
        healthy:
          tables.missing.length === 0 &&
          schemaConstraints.invalid === 0 &&
          integrityFailures === 0 &&
          operationalFailures === 0,
      },
      inventory: {
        total: vehicles.length,
        bookable: vehicles.filter(vehicle => vehicle.bookable).length,
        vehicles,
      },
      providers,
      paymentExcludedReadiness:
        tables.missing.length === 0 &&
        schemaConstraints.invalid === 0 &&
        integrityFailures === 0 &&
        operationalFailures === 0,
    };

    console.log(JSON.stringify(report, null, 2));
    if (!report.paymentExcludedReadiness) process.exitCode = 1;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
    await database.pool.end();
  }
}

main().catch(error => {
  console.error(`GoodFleet readiness audit failed: ${error.message}`);
  process.exitCode = 1;
});
