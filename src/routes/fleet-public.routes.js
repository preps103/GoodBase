"use strict";

const express = require("express");
const fs = require("node:fs");
const path = require("node:path");
const { query } = require("../config/database");

const router = express.Router();
const PUBLIC_ORGANIZATION_ID = process.env.GOODFLEET_PUBLIC_ORGANIZATION_ID || "org_goodos";
const MANAGED_ASSET_ROOT = path.resolve(
  process.env.GOODFLEET_MANAGED_ASSET_DIR ||
    "/var/lib/goodbase/goodfleet-managed-assets",
);

function fail(response, status, code, message) {
  return response.status(status).json({ success: false, code, message });
}

function rentalTimestamp(value, fallbackTime) {
  const date = String(value || "").slice(0, 10);
  const parsed = new Date(`${date}T${fallbackTime}:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function clean(value, max = 500) {
  return String(value ?? "").trim().slice(0, max);
}

function safeManagedAssetPath(fileName) {
  const normalized = path.basename(String(fileName || ""));
  if (!normalized || normalized !== fileName) return null;
  const resolved = path.resolve(MANAGED_ASSET_ROOT, normalized);
  return resolved.startsWith(`${MANAGED_ASSET_ROOT}${path.sep}`)
    ? resolved
    : null;
}

function publicLocation(branch) {
  const hours = branch?.operatingHours && typeof branch.operatingHours === "object"
    ? Object.fromEntries(
      Object.entries(branch.operatingHours).map(([day, schedule]) => [
        clean(day, 20),
        {
          open: clean(schedule?.open, 10),
          close: clean(schedule?.close, 10),
          closed: Boolean(schedule?.closed),
        },
      ]),
    )
    : {};
  return {
    id: clean(branch?.id, 100),
    name: clean(branch?.name, 160),
    address: clean(branch?.address, 300),
    phone: clean(branch?.phone, 40),
    timezone: clean(branch?.timezone, 80),
    operatingHours: hours,
    allowAfterHoursDropOff: Boolean(branch?.locationRules?.allowAfterHoursDropOff),
  };
}

function isPublishableLocation(location) {
  const address = clean(location?.address, 300).toLowerCase();
  const phone = clean(location?.phone, 40);
  const timezone = clean(location?.timezone, 80);
  const placeholderAddress = /\b(?:example|placeholder|test|tbd|todo|unknown)\b/.test(address) ||
    /^(?:123|000)\s+(?:main|market|test)\b/.test(address);

  let validTimezone = false;
  try {
    validTimezone = Boolean(timezone && new Intl.DateTimeFormat("en-US", { timeZone: timezone }));
  } catch {
    validTimezone = false;
  }

  let validPhone = true;
  if (phone) {
    const digits = phone.replace(/\D/g, "");
    const national = digits.length === 11 && digits.startsWith("1")
      ? digits.slice(1)
      : digits;
    validPhone = national.length === 10 &&
      /^[2-9]\d{2}[2-9]\d{6}$/.test(national) &&
      national.slice(3, 6) !== "555";
  }

  return Boolean(
    location?.id &&
    location?.name &&
    address.length >= 10 &&
    !placeholderAddress &&
    validTimezone &&
    validPhone
  );
}

function publicOffer(discount) {
  return {
    id: clean(discount?.id, 100),
    name: clean(discount?.name, 160),
    code: clean(discount?.code, 80),
    type: discount?.type === "fixed" ? "fixed" : "percentage",
    value: Math.max(Number(discount?.value) || 0, 0),
    minDays: Math.max(Number(discount?.minDays) || 0, 0) || null,
    maxDays: Math.max(Number(discount?.maxDays) || 0, 0) || null,
    startDate: clean(discount?.startDate, 10) || null,
    endDate: clean(discount?.endDate, 10) || null,
    branchId: clean(discount?.branchId, 100) || null,
  };
}

async function publicWorkspaceState() {
  const result = await query(
    `SELECT state_json
       FROM fleet_workspace_state
      WHERE organization_id=$1
      LIMIT 1`,
    [PUBLIC_ORGANIZATION_ID],
  );
  return result.rows[0]?.state_json || {};
}

router.get("/availability", async (request, response, next) => {
  try {
    const pickupAt = rentalTimestamp(request.query.start, "10:00");
    const returnAt = rentalTimestamp(request.query.end, "10:00");
    if (!pickupAt || !returnAt || new Date(returnAt) <= new Date(pickupAt)) {
      return fail(response, 400, "INVALID_RENTAL_PERIOD", "Valid pickup and return dates are required.");
    }
    const category = String(request.query.category || "").trim().slice(0, 80);
    const pickupLocationId = clean(request.query.location, 200);
    const search = clean(request.query.search, 160).toLowerCase();
    const deliveryRequired = ["true", "1", "delivery"].includes(
      clean(request.query.delivery, 20).toLowerCase(),
    );
    const result = await query(
      `SELECT vehicle.id,vehicle.make,vehicle.model,vehicle.model_year,vehicle.daily_rate,
              vehicle.payload->>'category' AS category,
              vehicle.payload->>'imageUrl' AS image_url,
              vehicle.payload->>'seats' AS seats,
              vehicle.payload->>'fuelType' AS fuel_type,
              vehicle.payload->>'transmission' AS transmission,
              listing.id AS listing_id,listing.title,listing.description,
              listing.instant_book,listing.delivery_enabled,
              listing.delivery_radius_miles,listing.delivery_fee,
              listing.minimum_trip_days,listing.maximum_trip_days,
              listing.advance_notice_hours,listing.mileage_limit_per_day,
              listing.photos_json,listing.availability_json,
              host.user_id AS host_user_id,
              COALESCE(host.display_name,'GoodFleet') AS host_name,
              COALESCE(review_summary.rating,0) AS host_rating,
              COALESCE(review_summary.review_count,0) AS host_review_count
       FROM fleet_vehicles vehicle
       JOIN fleet_vehicle_listings listing
         ON listing.organization_id=vehicle.organization_id
        AND listing.vehicle_id=vehicle.id
        AND listing.status='active'
        AND listing.archived_at IS NULL
       LEFT JOIN fleet_host_profiles host
         ON host.organization_id=listing.organization_id
        AND host.id=listing.host_profile_id
       LEFT JOIN LATERAL (
         SELECT ROUND(AVG(review.rating)::numeric,2) AS rating,
                COUNT(*)::integer AS review_count
           FROM fleet_trip_reviews review
          WHERE review.organization_id=listing.organization_id
            AND review.reviewee_user_id=host.user_id
            AND review.status='published'
       ) review_summary ON TRUE
       WHERE vehicle.organization_id=$1
         AND vehicle.archived_at IS NULL
         AND vehicle.status IN ('available','reserved')
         AND vehicle.registration_expiry IS NOT NULL
         AND vehicle.registration_expiry >= $3::date
         AND vehicle.insurance_expiry IS NOT NULL
         AND vehicle.insurance_expiry >= $3::date
         AND COALESCE(vehicle.payload->>'recallStatus','clear') IN ('clear','resolved')
         AND jsonb_typeof(listing.photos_json)='array'
         AND jsonb_array_length(listing.photos_json)>=6
         AND (
           listing.operator_managed OR (
             host.status='active'
             AND host.identity_verification_status='verified'
           )
         )
         AND ($4='' OR lower(vehicle.payload->>'category')=lower($4))
         AND ($6='' OR vehicle.assigned_branch_id=$6)
         AND (NOT $7::boolean OR listing.delivery_enabled)
         AND (
           $8='' OR
           lower(concat(vehicle.make,' ',vehicle.model,' ',listing.title)) LIKE '%' || $8 || '%'
         )
         AND (
           EXTRACT(EPOCH FROM ($2::timestamptz-NOW())) / 3600
         ) >= listing.advance_notice_hours
         AND CEIL(EXTRACT(EPOCH FROM ($3::timestamptz-$2::timestamptz)) / 86400)
           BETWEEN listing.minimum_trip_days AND listing.maximum_trip_days
         AND EXISTS (
           SELECT 1
             FROM jsonb_array_elements_text(
               COALESCE(
                 listing.availability_json->'pickupDays',
                 '[0,1,2,3,4,5,6]'::jsonb
               )
             ) pickup_day
            WHERE pickup_day::integer=EXTRACT(DOW FROM $2::timestamptz)::integer
         )
         AND NOT EXISTS (
           SELECT 1
             FROM jsonb_array_elements(
               COALESCE(
                 listing.availability_json->'unavailableRanges',
                 '[]'::jsonb
               )
             ) blocked
            WHERE (blocked->>'start')::timestamptz<$3::timestamptz
              AND (blocked->>'end')::timestamptz>$2::timestamptz
         )
         AND NOT EXISTS (
           SELECT 1 FROM fleet_bookings booking
           WHERE booking.organization_id=vehicle.organization_id
             AND booking.vehicle_id=vehicle.id
             AND booking.archived_at IS NULL
             AND booking.status=ANY($5::text[])
             AND tsrange(
               (booking.pickup_at AT TIME ZONE 'UTC') - interval '2 hours',
               (booking.return_at AT TIME ZONE 'UTC') + interval '2 hours',
               '[)'
             ) && tsrange(
               ($2::timestamptz AT TIME ZONE 'UTC'),
               ($3::timestamptz AT TIME ZONE 'UTC'),
               '[)'
             )
         )
       ORDER BY vehicle.daily_rate,vehicle.make,vehicle.model
       LIMIT 100`,
      [
        PUBLIC_ORGANIZATION_ID,
        pickupAt,
        returnAt,
        category,
        ["pending_payment", "confirmed", "assigned", "checked_in", "checked_out", "extended", "overdue"],
        pickupLocationId,
        deliveryRequired,
        search,
      ]
    );
    response.json({
      success: true,
      data: result.rows.map(vehicle => ({
        id: vehicle.id,
        name: `${vehicle.make} ${vehicle.model}`,
        make: vehicle.make,
        model: vehicle.model,
        year: vehicle.model_year,
        category: vehicle.category || "Vehicle",
        seats: Number(vehicle.seats || 0),
        fuelType: vehicle.fuel_type || "gasoline",
        transmission: vehicle.transmission || "automatic",
        dailyRate: Number(vehicle.daily_rate),
        imageUrl: vehicle.photos_json?.[0] || vehicle.image_url || null,
        photos: vehicle.photos_json || [],
        listingId: vehicle.listing_id,
        title: vehicle.title,
        description: vehicle.description,
        instantBook: Boolean(vehicle.instant_book),
        deliveryEnabled: Boolean(vehicle.delivery_enabled),
        deliveryRadiusMiles: vehicle.delivery_radius_miles === null
          ? null
          : Number(vehicle.delivery_radius_miles),
        deliveryFee: Number(vehicle.delivery_fee),
        minimumTripDays: vehicle.minimum_trip_days,
        maximumTripDays: vehicle.maximum_trip_days,
        advanceNoticeHours: vehicle.advance_notice_hours,
        mileageLimitPerDay: vehicle.mileage_limit_per_day,
        availability: vehicle.availability_json || {
          unavailableRanges: [],
          pickupDays: [0, 1, 2, 3, 4, 5, 6],
        },
        host: {
          id: vehicle.host_user_id || null,
          name: vehicle.host_name,
          rating: Number(vehicle.host_rating),
          reviewCount: Number(vehicle.host_review_count),
          operatorManaged: !vehicle.host_user_id,
        },
      }))
    });
  } catch (error) {
    next(error);
  }
});

router.get("/listings/:listingId", async (request, response, next) => {
  try {
    const result = await query(
      `SELECT listing.*,vehicle.make,vehicle.model,vehicle.model_year,
              vehicle.daily_rate,vehicle.assigned_branch_id,
              vehicle.payload AS vehicle_payload,
              COALESCE(host.display_name,'GoodFleet') AS host_name,
              host.user_id AS host_user_id,
              COALESCE(review_summary.rating,0) AS host_rating,
              COALESCE(review_summary.review_count,0) AS host_review_count
         FROM fleet_vehicle_listings listing
         JOIN fleet_vehicles vehicle
           ON vehicle.organization_id=listing.organization_id
          AND vehicle.id=listing.vehicle_id
         LEFT JOIN fleet_host_profiles host
           ON host.organization_id=listing.organization_id
          AND host.id=listing.host_profile_id
         LEFT JOIN LATERAL (
           SELECT ROUND(AVG(review.rating)::numeric,2) AS rating,
                  COUNT(*)::integer AS review_count
             FROM fleet_trip_reviews review
            WHERE review.organization_id=listing.organization_id
              AND review.reviewee_user_id=host.user_id
              AND review.status='published'
         ) review_summary ON TRUE
        WHERE listing.organization_id=$1
          AND listing.id=$2
          AND listing.status='active'
          AND listing.archived_at IS NULL
          AND vehicle.archived_at IS NULL
          AND vehicle.registration_expiry IS NOT NULL
          AND vehicle.registration_expiry>=CURRENT_DATE
          AND vehicle.insurance_expiry IS NOT NULL
          AND vehicle.insurance_expiry>=CURRENT_DATE
          AND jsonb_typeof(listing.photos_json)='array'
          AND jsonb_array_length(listing.photos_json)>=6
          AND (listing.operator_managed OR host.status='active')
        LIMIT 1`,
      [PUBLIC_ORGANIZATION_ID, request.params.listingId],
    );
    const listing = result.rows[0];
    if (!listing) {
      return fail(
        response,
        404,
        "LISTING_NOT_FOUND",
        "This vehicle listing is not available.",
      );
    }
    response.json({
      success: true,
      data: {
        id: listing.id,
        vehicleId: listing.vehicle_id,
        title: listing.title,
        description: listing.description,
        dailyRate: Number(listing.daily_rate),
        imageUrl:
          listing.photos_json?.[0] ||
          listing.vehicle_payload?.imageUrl ||
          null,
        photos: listing.photos_json || [],
        make: listing.make,
        model: listing.model,
        year: listing.model_year,
        category: listing.vehicle_payload?.category || "Vehicle",
        seats: Number(listing.vehicle_payload?.seats || 0),
        fuelType: listing.vehicle_payload?.fuelType || "gasoline",
        transmission: listing.vehicle_payload?.transmission || "automatic",
        pickupLocationId: listing.assigned_branch_id,
        instantBook: Boolean(listing.instant_book),
        deliveryEnabled: Boolean(listing.delivery_enabled),
        deliveryRadiusMiles: listing.delivery_radius_miles === null
          ? null
          : Number(listing.delivery_radius_miles),
        deliveryFee: Number(listing.delivery_fee),
        minimumTripDays: listing.minimum_trip_days,
        maximumTripDays: listing.maximum_trip_days,
        advanceNoticeHours: listing.advance_notice_hours,
        mileageLimitPerDay: listing.mileage_limit_per_day,
        additionalMileRate: listing.additional_mile_rate === null
          ? null
          : Number(listing.additional_mile_rate),
        rules: listing.rules_json || {},
        features: listing.features_json || [],
        availability: listing.availability_json || {
          unavailableRanges: [],
          pickupDays: [0, 1, 2, 3, 4, 5, 6],
        },
        host: {
          id: listing.host_user_id || null,
          name: listing.host_name,
          rating: Number(listing.host_rating),
          reviewCount: Number(listing.host_review_count),
          operatorManaged: !listing.host_user_id,
        },
        reviews: (await query(
          `SELECT review.id,review.rating,review.body,review.response,
                  review.created_at,
                  COALESCE(account.display_name,'Verified guest') AS reviewer_name
             FROM fleet_trip_reviews review
             JOIN users account ON account.id=review.reviewer_user_id
            WHERE review.organization_id=$1
              AND review.reviewee_user_id=$2
              AND review.reviewer_role='guest'
              AND review.status='published'
            ORDER BY review.created_at DESC
            LIMIT 20`,
          [PUBLIC_ORGANIZATION_ID, listing.host_user_id],
        )).rows.map(review => ({
          id: review.id,
          rating: Number(review.rating),
          body: review.body,
          response: review.response || null,
          reviewerName: review.reviewer_name,
          createdAt: review.created_at,
        })),
      },
    });
  } catch (error) {
    next(error);
  }
});

router.get("/listing-media/:assetId", async (request, response, next) => {
  try {
    const result = await query(
      `SELECT asset.stored_name,asset.original_name,asset.content_type,
              asset.size_bytes,asset.checksum_sha256
         FROM fleet_managed_assets asset
         JOIN fleet_vehicle_listings listing
           ON listing.organization_id=asset.organization_id
          AND listing.vehicle_id=asset.entity_id
          AND listing.status='active'
          AND listing.archived_at IS NULL
        WHERE asset.organization_id=$1
          AND asset.id=$2
          AND asset.category='vehicle_image'
          AND asset.entity_type='vehicle'
        LIMIT 1`,
      [PUBLIC_ORGANIZATION_ID, request.params.assetId],
    );
    const asset = result.rows[0];
    if (!asset) {
      return fail(response, 404, "LISTING_MEDIA_NOT_FOUND", "Listing image not found.");
    }
    const assetPath = safeManagedAssetPath(asset.stored_name);
    if (!assetPath) {
      return fail(response, 404, "LISTING_MEDIA_NOT_FOUND", "Listing image not found.");
    }
    await fs.promises.access(assetPath, fs.constants.R_OK);
    response.setHeader("Content-Type", asset.content_type);
    response.setHeader("Content-Length", String(asset.size_bytes));
    response.setHeader("ETag", `"${asset.checksum_sha256}"`);
    response.setHeader("Cache-Control", "public, max-age=86400, immutable");
    response.setHeader(
      "Content-Disposition",
      `inline; filename="${String(asset.original_name).replace(/["\r\n]/g, "_")}"`,
    );
    return response.sendFile(assetPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return fail(response, 404, "LISTING_MEDIA_NOT_FOUND", "Listing image not found.");
    }
    return next(error);
  }
});

router.get("/locations", async (_request, response, next) => {
  try {
    const state = await publicWorkspaceState();
    const locations = (Array.isArray(state.branches) ? state.branches : [])
      .map(publicLocation)
      .filter(isPublishableLocation);
    response.json({ success: true, data: locations });
  } catch (error) {
    next(error);
  }
});

router.get("/offers", async (_request, response, next) => {
  try {
    const state = await publicWorkspaceState();
    const now = new Date().toISOString().slice(0, 10);
    const offers = (Array.isArray(state.discounts) ? state.discounts : [])
      .filter(discount => discount?.status === "active")
      .filter(discount => !discount.startDate || clean(discount.startDate, 10) <= now)
      .filter(discount => !discount.endDate || clean(discount.endDate, 10) >= now)
      .map(publicOffer)
      .filter(offer => offer.id && offer.name && offer.value > 0);
    response.json({ success: true, data: offers });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
