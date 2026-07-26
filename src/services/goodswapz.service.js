"use strict";

const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");

const database = require("../config/database");
const { logAudit } = require("./audit.service");
const notificationService = require("./notification.service");

const APP_ID = "goodswapz";
const APP_URL = "https://swapz.goodos.app";
const PLATFORM_LABELS = Object.freeze({
  youtube: "YouTube",
  instagram: "Instagram",
  tiktok: "TikTok",
  twitter: "Twitter/X",
  telegram: "Telegram",
});
const PLATFORM_HOSTS = Object.freeze({
  youtube: ["youtube.com", "youtu.be"],
  instagram: ["instagram.com"],
  tiktok: ["tiktok.com"],
  twitter: ["x.com", "twitter.com"],
  telegram: ["t.me", "telegram.me"],
});

const COMMON_STEPS = Object.freeze([
  {
    key: "policy_confirmation",
    title: "Confirm transfer eligibility",
    description: "Both parties confirm that the account may be transferred and that all platform-specific conditions have been reviewed.",
    actor: "both",
  },
  {
    key: "deposit_verified",
    title: "External deposit verified",
    description: "GoodBase records a signed confirmation from the connected payment or escrow provider before any ownership change begins.",
    actor: "system",
  },
]);

const PLATFORM_STEPS = Object.freeze({
  youtube: [
    {
      key: "youtube_buyer_invited",
      title: "Invite the buyer through native permissions",
      description: "The seller adds the buyer's Google identity through YouTube or Brand Account permissions without sharing a password.",
      actor: "seller",
    },
    {
      key: "youtube_access_accepted",
      title: "Accept channel access",
      description: "The buyer confirms that the correct channel, permissions, monetization context, and analytics are visible.",
      actor: "buyer",
    },
    {
      key: "youtube_primary_owner",
      title: "Transfer primary ownership",
      description: "After any platform-enforced waiting period, the seller assigns the buyer the highest available ownership role.",
      actor: "seller",
    },
    {
      key: "youtube_security_review",
      title: "Secure the buyer-controlled identity",
      description: "The buyer verifies recovery methods, multi-factor authentication, active sessions, and connected services on the buyer-controlled identity.",
      actor: "buyer",
    },
    {
      key: "youtube_seller_removed",
      title: "Remove former-owner access",
      description: "The seller removes legacy access and both parties confirm that the buyer retains complete control.",
      actor: "both",
    },
  ],
  instagram: [
    {
      key: "instagram_destination_ready",
      title: "Prepare buyer-controlled contact methods",
      description: "The buyer prepares an email address and phone number under their control. Do not enter codes or credentials in GoodSwapz.",
      actor: "buyer",
    },
    {
      key: "instagram_contact_updated",
      title: "Move account contact methods",
      description: "The seller changes the account email and phone to the buyer-controlled destinations using Instagram's own security flow.",
      actor: "seller",
    },
    {
      key: "instagram_security_enabled",
      title: "Enable buyer security",
      description: "The buyer enables multi-factor authentication, reviews recovery options, and confirms access to the account center.",
      actor: "buyer",
    },
    {
      key: "instagram_sessions_revoked",
      title: "Review and revoke old sessions",
      description: "Both parties confirm that seller-controlled sessions, linked devices, and unnecessary third-party connections are removed.",
      actor: "both",
    },
  ],
  tiktok: [
    {
      key: "tiktok_destination_ready",
      title: "Prepare buyer contact methods",
      description: "The buyer prepares buyer-controlled email and phone destinations without posting verification codes in GoodSwapz.",
      actor: "buyer",
    },
    {
      key: "tiktok_contact_updated",
      title: "Transfer verified contact methods",
      description: "The seller uses TikTok's native settings to move verified contact methods to the buyer.",
      actor: "seller",
    },
    {
      key: "tiktok_security_review",
      title: "Secure login and recovery",
      description: "The buyer enables multi-factor authentication and reviews trusted devices, recovery methods, business access, and connected applications.",
      actor: "buyer",
    },
    {
      key: "tiktok_sessions_revoked",
      title: "Remove former-owner access",
      description: "Both parties verify that seller devices and unnecessary integrations no longer have account access.",
      actor: "both",
    },
  ],
  twitter: [
    {
      key: "twitter_destination_ready",
      title: "Prepare buyer contact methods",
      description: "The buyer prepares buyer-controlled email and phone destinations without sharing authentication secrets.",
      actor: "buyer",
    },
    {
      key: "twitter_contact_updated",
      title: "Move contact and recovery ownership",
      description: "The seller updates the account email and phone using X's native security workflow.",
      actor: "seller",
    },
    {
      key: "twitter_security_review",
      title: "Secure the account",
      description: "The buyer enables multi-factor authentication and reviews delegates, applications, sessions, recovery settings, and payment connections.",
      actor: "buyer",
    },
    {
      key: "twitter_seller_removed",
      title: "Remove legacy access",
      description: "Both parties confirm that former-owner sessions, delegates, and unnecessary connected applications are removed.",
      actor: "both",
    },
  ],
  telegram: [
    {
      key: "telegram_buyer_admin",
      title: "Add the buyer as an administrator",
      description: "The seller adds the buyer through Telegram's native channel or group administrator controls.",
      actor: "seller",
    },
    {
      key: "telegram_buyer_access",
      title: "Verify administrator access",
      description: "The buyer confirms that the intended channel, history, permissions, and linked resources are accessible.",
      actor: "buyer",
    },
    {
      key: "telegram_ownership_transfer",
      title: "Transfer native ownership",
      description: "The seller completes Telegram's native ownership-transfer workflow after all platform security and waiting requirements are satisfied.",
      actor: "seller",
    },
    {
      key: "telegram_security_review",
      title: "Review security and administrators",
      description: "The buyer reviews two-step verification, active sessions, bots, administrators, linked groups, and recovery options.",
      actor: "buyer",
    },
    {
      key: "telegram_seller_removed",
      title: "Confirm former-owner access",
      description: "Both parties confirm the seller's final role and remove access when required by the transaction terms.",
      actor: "both",
    },
  ],
});

const FINAL_STEPS = Object.freeze([
  {
    key: "buyer_inspection",
    title: "Complete buyer inspection",
    description: "The buyer confirms that the account identity, audience, monetization access, content, and connected resources match the listing.",
    actor: "buyer",
  },
  {
    key: "final_access_review",
    title: "Complete final access review",
    description: "Both parties confirm that ownership is stable, the buyer controls recovery, and no prohibited secrets were exchanged through GoodSwapz.",
    actor: "both",
  },
]);

function serviceError(message, statusCode = 400, code = "GOODSWAPZ_REQUEST_FAILED") {
  const requestError = new Error(message);
  requestError.statusCode = statusCode;
  requestError.code = code;
  return requestError;
}

function cleanText(value, maximum = 500, minimum = 0) {
  const cleaned = String(value ?? "").trim().replace(/\s+/g, " ").slice(0, maximum);
  if (cleaned.length < minimum) {
    throw serviceError(`A value of at least ${minimum} characters is required.`, 400, "INVALID_TEXT_LENGTH");
  }
  return cleaned;
}

function normalizePlatform(value) {
  const normalized = String(value || "")
    .toLowerCase()
    .replace(/[^a-z]/g, "");
  const aliases = {
    youtube: "youtube",
    instagram: "instagram",
    tiktok: "tiktok",
    twitter: "twitter",
    twitterx: "twitter",
    x: "twitter",
    telegram: "telegram",
  };
  const platform = aliases[normalized];
  if (!platform) {
    throw serviceError("A supported social platform is required.", 400, "UNSUPPORTED_PLATFORM");
  }
  return platform;
}

function platformSteps(platformValue) {
  const platform = normalizePlatform(platformValue);
  return [...COMMON_STEPS, ...PLATFORM_STEPS[platform], ...FINAL_STEPS].map((step, index) => ({
    ...step,
    sequence: index + 1,
  }));
}

function assertNoSecrets(value, fieldName = "Text") {
  const text = String(value || "");
  const secretPatterns = [
    /\bpassword\s*[:=]\s*\S+/i,
    /\b(passcode|pin|otp)\s*[:=]\s*[a-z0-9-]{4,}/i,
    /\b(recovery|backup)\s*(code|key)\s*[:=]\s*\S+/i,
    /\b(2fa|mfa|totp)\s*(code|secret)?\s*[:=]\s*\S+/i,
    /\b(session|auth)\s*(cookie|token)\s*[:=]\s*\S+/i,
    /\bbearer\s+[a-z0-9._~+/-]{12,}/i,
    /\b(api|private)\s*[_ -]?(key|token)\s*[:=]\s*\S+/i,
    /\b(seed|secret)\s+phrase\s*[:=]\s*\S+/i,
  ];
  if (secretPatterns.some((pattern) => pattern.test(text))) {
    throw serviceError(
      `${fieldName} appears to contain a password, authentication code, token, or recovery secret. GoodSwapz never stores those values.`,
      400,
      "SECRET_CONTENT_REJECTED"
    );
  }
  return text;
}

function positiveNumber(value, fieldName, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > maximum) {
    throw serviceError(`${fieldName} is invalid.`, 400, "INVALID_NUMBER");
  }
  return parsed;
}

function nonNegativeNumber(value, fieldName, maximum) {
  const parsed = Number(value || 0);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > maximum) {
    throw serviceError(`${fieldName} is invalid.`, 400, "INVALID_NUMBER");
  }
  return parsed;
}

function moneyToCents(value, fieldName = "Amount") {
  return Math.round(positiveNumber(value, fieldName, 100_000_000) * 100);
}

function centsToMoney(value) {
  return Number(value || 0) / 100;
}

function normalizeIdempotencyKey(value) {
  const key = String(value || "").trim();
  if (!key) return null;
  if (key.length > 128 || !/^[a-zA-Z0-9._:-]+$/.test(key)) {
    throw serviceError("The idempotency key is invalid.", 400, "INVALID_IDEMPOTENCY_KEY");
  }
  return key;
}

function validUuid(value, label = "Identifier") {
  const id = String(value || "").trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    throw serviceError(`${label} is invalid.`, 400, "INVALID_IDENTIFIER");
  }
  return id;
}

function safeHttpsUrl(value, fieldName, allowedHosts = null) {
  let parsed;
  try {
    parsed = new URL(String(value || "").trim());
  } catch {
    throw serviceError(`${fieldName} must be a valid HTTPS URL.`, 400, "INVALID_URL");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw serviceError(`${fieldName} must be a valid HTTPS URL.`, 400, "INVALID_URL");
  }
  const hostname = parsed.hostname.toLowerCase().replace(/^www\./, "");
  if (
    Array.isArray(allowedHosts) &&
    !allowedHosts.some((host) => hostname === host || hostname.endsWith(`.${host}`))
  ) {
    throw serviceError(`${fieldName} does not match the selected platform.`, 400, "PLATFORM_URL_MISMATCH");
  }
  return parsed.toString();
}

function validatedListingInput(payload = {}) {
  const platform = normalizePlatform(payload.platform);
  const transferMethod = assertNoSecrets(cleanText(payload.transferMethod, 500, 20), "Transfer plan");
  return {
    platform,
    title: cleanText(payload.title, 120, 4),
    handle: cleanText(payload.handle, 100, 2),
    accountUrl: safeHttpsUrl(payload.accountUrl, "Account URL", PLATFORM_HOSTS[platform]),
    subscribers: Math.round(nonNegativeNumber(payload.subscribers, "Subscribers", 10_000_000_000)),
    priceCents: moneyToCents(payload.price, "Asking price"),
    monthlyRevenueCents: Math.round(nonNegativeNumber(payload.monthlyRevenue, "Monthly revenue", 100_000_000) * 100),
    description: cleanText(payload.description, 4000, 40),
    category: cleanText(payload.category, 100, 2),
    engagementRate: nonNegativeNumber(payload.engagementRate, "Engagement rate", 100),
    imageUrl: payload.imageUrl ? safeHttpsUrl(payload.imageUrl, "Listing image URL") : null,
    country: cleanText(payload.country, 80, 2),
    originalEmailIncluded: payload.ogEmail === true,
    audienceMalePercent: nonNegativeNumber(payload.audienceMalePercent ?? 50, "Audience percentage", 100),
    audienceReport: payload.audienceReport === true,
    transferMethod,
    audienceAgeRange: objectValue(payload.audienceAgeRange),
    audienceTopLocations: objectValue(payload.audienceTopLocations),
  };
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function query(text, params = []) {
  return database.query(text, params);
}

async function requireApprovedIdentity({ context, userId, client = database, roleLabel = "User" }) {
  const executor = typeof client.query === "function" ? client : database;
  const result = await executor.query(
    `
      SELECT id
      FROM goodswapz_identity_verifications
      WHERE organization_id = $1
        AND user_id = $2::uuid
        AND status = 'approved'
      ORDER BY reviewed_at DESC NULLS LAST, created_at DESC
      LIMIT 1
    `,
    [context.organizationId, userId]
  );
  if (!result.rows[0]) {
    throw serviceError(
      `${roleLabel} must complete GoodSwapz identity verification before this action.`,
      403,
      "GOODSWAPZ_IDENTITY_VERIFICATION_REQUIRED"
    );
  }
  return result.rows[0];
}

async function withTransaction(operation) {
  const client = await database.pool.connect();
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function listingProjection(alias = "listing") {
  return `
    ${alias}.id,
    ${alias}.title,
    ${alias}.handle,
    ${alias}.account_url AS "accountUrl",
    ${alias}.platform,
    ${alias}.subscribers,
    ${alias}.price_cents AS "priceCents",
    ${alias}.monthly_revenue_cents AS "monthlyRevenueCents",
    ${alias}.description,
    ${alias}.status,
    ${alias}.category,
    ${alias}.engagement_rate AS "engagementRate",
    ${alias}.image_url AS "imageUrl",
    ${alias}.country,
    ${alias}.original_email_included AS "ogEmail",
    ${alias}.audience_male_percent AS "audienceMalePercent",
    ${alias}.escrow_accepted AS "escrowAccepted",
    ${alias}.instant_delivery AS "instantDelivery",
    ${alias}.audience_report AS "audienceReport",
    ${alias}.transfer_method AS "transferMethod",
    ${alias}.ownership_verification_code AS "ownershipVerificationCode",
    ${alias}.ownership_verified_at AS "ownershipVerifiedAt",
    ${alias}.audience_age_range AS "audienceAgeRange",
    ${alias}.audience_top_locations AS "audienceTopLocations",
    ${alias}.seller_user_id AS "sellerUserId",
    ${alias}.created_at AS "createdAt",
    seller.display_name AS "sellerName",
    seller.email_verified AS "sellerEmailVerified",
    COALESCE((
      SELECT COUNT(*)::int
      FROM goodswapz_handoffs completed_handoff
      WHERE completed_handoff.seller_user_id = ${alias}.seller_user_id
        AND completed_handoff.status = 'completed'
    ), 0) AS "sellerDealsCompleted"
  `;
}

function mapListing(row, viewerUserId = null) {
  return {
    id: row.id,
    title: row.title,
    handle: row.handle,
    accountUrl: row.accountUrl,
    platform: PLATFORM_LABELS[row.platform] || row.platform,
    subscribers: Number(row.subscribers || 0),
    price: centsToMoney(row.priceCents),
    monthlyRevenue: centsToMoney(row.monthlyRevenueCents),
    description: row.description,
    verified: Boolean(row.ownershipVerifiedAt),
    status: row.status,
    category: row.category,
    engagementRate: Number(row.engagementRate || 0),
    imageUrl: row.imageUrl || undefined,
    country: row.country,
    ogEmail: Boolean(row.ogEmail),
    audienceMalePercent: Number(row.audienceMalePercent || 0),
    escrowAccepted: Boolean(row.escrowAccepted),
    instantDelivery: Boolean(row.instantDelivery),
    audienceReport: Boolean(row.audienceReport),
    transferMethod: row.transferMethod,
    ...(row.sellerUserId === viewerUserId
      ? { ownershipVerificationCode: row.ownershipVerificationCode }
      : {}),
    audienceAgeRange: objectValue(row.audienceAgeRange),
    audienceTopLocations: objectValue(row.audienceTopLocations),
    seller: {
      id: row.sellerUserId,
      name: row.sellerName || "GoodSwapz seller",
      rating: Number(row.sellerDealsCompleted || 0) > 0 ? 5 : 0,
      dealsCompleted: Number(row.sellerDealsCompleted || 0),
      verified: Boolean(row.sellerEmailVerified && row.ownershipVerifiedAt),
    },
  };
}

async function safeAudit(input) {
  try {
    await logAudit({ appId: APP_ID, ...input });
  } catch (error) {
    console.error("GoodSwapz audit write failed:", error.message);
  }
}

async function notifyUser({
  userId,
  organizationId,
  title,
  message,
  severity = "info",
  sourceId,
  actionUrl = `${APP_URL}/`,
  eventType,
}) {
  if (!userId) return;
  try {
    await notificationService.createNotification({
      recipientUserId: userId,
      organizationId,
      appId: APP_ID,
      title,
      message,
      severity,
      source: "goodswapz",
      sourceId,
      actionUrl,
      eventType,
      category: "marketplace",
      metadata: { appId: APP_ID },
    });
  } catch (error) {
    console.error("GoodSwapz notification failed:", error.message);
  }
}

async function health() {
  const result = await query(`
    SELECT
      to_regclass('public.goodswapz_listings') IS NOT NULL AS listings_ready,
      to_regclass('public.goodswapz_escrow_transactions') IS NOT NULL AS transactions_ready,
      to_regclass('public.goodswapz_handoffs') IS NOT NULL AS handoffs_ready,
      to_regclass('public.goodswapz_handoff_steps') IS NOT NULL AS steps_ready
  `);
  const row = result.rows[0] || {};
  return {
    service: "GoodSwapz GoodBase API",
    status: "ok",
    schemaReady: Boolean(
      row.listings_ready &&
      row.transactions_ready &&
      row.handoffs_ready &&
      row.steps_ready
    ),
    appId: APP_ID,
  };
}

async function listListings({ context, userId }) {
  const result = await query(
    `
      SELECT ${listingProjection("listing")}
      FROM goodswapz_listings AS listing
      JOIN users AS seller ON seller.id = listing.seller_user_id
      WHERE listing.organization_id = $1
        AND (
          listing.status = 'active'
          OR listing.seller_user_id = $2::uuid
          OR EXISTS (
            SELECT 1
            FROM goodswapz_handoffs participant_handoff
            WHERE participant_handoff.listing_id = listing.id
              AND (
                participant_handoff.buyer_user_id = $2::uuid
                OR participant_handoff.seller_user_id = $2::uuid
              )
          )
        )
      ORDER BY listing.created_at DESC
      LIMIT 500
    `,
    [context.organizationId, userId]
  );
  return { listings: result.rows.map((row) => mapListing(row, userId)) };
}

async function createListing({ context, userId, payload, ipAddress }) {
  if (payload.acceptsSellerTerms !== true || payload.submitForReview !== true) {
    throw serviceError(
      "Seller certification and ownership review are required.",
      400,
      "SELLER_CERTIFICATION_REQUIRED"
    );
  }
  await requireApprovedIdentity({
    context,
    userId,
    roleLabel: "The seller",
  });
  const input = validatedListingInput(payload);
  const verificationCode = `GSW-${crypto.randomBytes(6).toString("hex").toUpperCase()}`;
  const result = await query(
    `
      INSERT INTO goodswapz_listings (
        organization_id, seller_user_id, platform, title, handle, account_url,
        subscribers, price_cents, monthly_revenue_cents, description, status,
        category, engagement_rate, image_url, country, original_email_included,
        audience_male_percent, escrow_accepted, instant_delivery, audience_report,
        transfer_method, ownership_verification_code, audience_age_range,
        audience_top_locations, metadata_json
      )
      VALUES (
        $1, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, 'pending_review',
        $11, $12, $13, $14, $15, $16, TRUE, FALSE, $17, $18, $19,
        $20::jsonb, $21::jsonb, $22::jsonb
      )
      RETURNING id
    `,
    [
      context.organizationId,
      userId,
      input.platform,
      input.title,
      input.handle,
      input.accountUrl,
      input.subscribers,
      input.priceCents,
      input.monthlyRevenueCents,
      input.description,
      input.category,
      input.engagementRate,
      input.imageUrl,
      input.country,
      input.originalEmailIncluded,
      input.audienceMalePercent,
      input.audienceReport,
      input.transferMethod,
      verificationCode,
      JSON.stringify(input.audienceAgeRange),
      JSON.stringify(input.audienceTopLocations),
      JSON.stringify({ source: APP_ID, sellerCertifiedAt: new Date().toISOString() }),
    ]
  );
  const listing = await getListingForParticipant({
    listingId: result.rows[0].id,
    context,
    userId,
    includePending: true,
  });
  await safeAudit({
    userId,
    action: "goodswapz.listing.created",
    entityType: "goodswapz_listing",
    entityId: listing.id,
    ipAddress,
    metadata: { organizationId: context.organizationId, platform: input.platform },
  });
  return { listing };
}

async function getListingForParticipant({ listingId, context, userId, includePending = false }) {
  const id = validUuid(listingId, "Listing identifier");
  const result = await query(
    `
      SELECT ${listingProjection("listing")}
      FROM goodswapz_listings AS listing
      JOIN users AS seller ON seller.id = listing.seller_user_id
      WHERE listing.id = $1::uuid
        AND listing.organization_id = $2
        AND (
          listing.status = 'active'
          OR listing.seller_user_id = $3::uuid
          OR $4::boolean
          OR EXISTS (
            SELECT 1
            FROM goodswapz_handoffs participant_handoff
            WHERE participant_handoff.listing_id = listing.id
              AND (
                participant_handoff.buyer_user_id = $3::uuid
                OR participant_handoff.seller_user_id = $3::uuid
              )
          )
        )
      LIMIT 1
    `,
    [id, context.organizationId, userId, includePending]
  );
  if (!result.rows[0]) {
    throw serviceError("Listing not found.", 404, "LISTING_NOT_FOUND");
  }
  return mapListing(result.rows[0], userId);
}

async function reviewListing({ context, reviewerUserId, listingId, decision, note, ipAddress }) {
  const status = String(decision || "").toLowerCase();
  if (!["approve", "reject"].includes(status)) {
    throw serviceError("Review decision must be approve or reject.", 400, "INVALID_REVIEW_DECISION");
  }
  const reviewNote = assertNoSecrets(cleanText(note, 1000), "Review note");
  const nextStatus = status === "approve" ? "active" : "rejected";
  if (nextStatus === "active") {
    const sellerResult = await query(
      `
        SELECT seller_user_id AS "sellerUserId"
        FROM goodswapz_listings
        WHERE id = $1::uuid
          AND organization_id = $2
          AND status = 'pending_review'
        LIMIT 1
      `,
      [validUuid(listingId, "Listing identifier"), context.organizationId]
    );
    if (!sellerResult.rows[0]) {
      throw serviceError("Pending listing not found.", 404, "PENDING_LISTING_NOT_FOUND");
    }
    await requireApprovedIdentity({
      context,
      userId: sellerResult.rows[0].sellerUserId,
      roleLabel: "The seller",
    });
  }
  const result = await query(
    `
      UPDATE goodswapz_listings
      SET
        status = $1,
        ownership_verified_at = CASE WHEN $1 = 'active' THEN NOW() ELSE NULL END,
        ownership_verified_by = CASE WHEN $1 = 'active' THEN $2::uuid ELSE NULL END,
        review_note = NULLIF($3, ''),
        updated_at = NOW()
      WHERE id = $4::uuid
        AND organization_id = $5
        AND status = 'pending_review'
      RETURNING id, seller_user_id AS "sellerUserId"
    `,
    [nextStatus, reviewerUserId, reviewNote, validUuid(listingId, "Listing identifier"), context.organizationId]
  );
  const updated = result.rows[0];
  if (!updated) {
    throw serviceError("Pending listing not found.", 404, "PENDING_LISTING_NOT_FOUND");
  }
  await Promise.all([
    safeAudit({
      userId: reviewerUserId,
      action: `goodswapz.listing.${nextStatus}`,
      entityType: "goodswapz_listing",
      entityId: updated.id,
      ipAddress,
      metadata: { organizationId: context.organizationId, reviewNote },
    }),
    notifyUser({
      userId: updated.sellerUserId,
      organizationId: context.organizationId,
      title: nextStatus === "active" ? "Your GoodSwapz listing is live" : "Your GoodSwapz listing needs changes",
      message: nextStatus === "active"
        ? "Ownership review passed and buyers can now view this listing."
        : reviewNote || "The listing did not pass ownership review.",
      severity: nextStatus === "active" ? "success" : "warning",
      sourceId: updated.id,
      eventType: `listing.${nextStatus}`,
    }),
  ]);
  return { listingId: updated.id, status: nextStatus };
}

async function toggleWatchlist({ context, userId, listingId }) {
  const id = validUuid(listingId, "Listing identifier");
  const result = await withTransaction(async (client) => {
    const listing = await client.query(
      "SELECT id FROM goodswapz_listings WHERE id = $1::uuid AND organization_id = $2 AND status = 'active' LIMIT 1",
      [id, context.organizationId]
    );
    if (!listing.rows[0]) throw serviceError("Active listing not found.", 404, "LISTING_NOT_FOUND");
    const existing = await client.query(
      "SELECT 1 FROM goodswapz_watchlist WHERE user_id = $1::uuid AND listing_id = $2::uuid",
      [userId, id]
    );
    if (existing.rows[0]) {
      await client.query(
        "DELETE FROM goodswapz_watchlist WHERE user_id = $1::uuid AND listing_id = $2::uuid",
        [userId, id]
      );
    } else {
      await client.query(
        "INSERT INTO goodswapz_watchlist (organization_id, user_id, listing_id) VALUES ($1, $2::uuid, $3::uuid)",
        [context.organizationId, userId, id]
      );
    }
    return client.query(
      "SELECT listing_id::text FROM goodswapz_watchlist WHERE user_id = $1::uuid ORDER BY created_at DESC",
      [userId]
    );
  });
  return { watchlist: result.rows.map((row) => row.listing_id) };
}

async function getWatchlist({ userId }) {
  const result = await query(
    "SELECT listing_id::text FROM goodswapz_watchlist WHERE user_id = $1::uuid ORDER BY created_at DESC",
    [userId]
  );
  return { watchlist: result.rows.map((row) => row.listing_id) };
}

async function getUserState({ context, userId }) {
  const [verificationResult, watchlist] = await Promise.all([
    query(
      `
        SELECT id, status, created_at AS "createdAt", reviewed_at AS "reviewedAt"
        FROM goodswapz_identity_verifications
        WHERE organization_id = $1 AND user_id = $2::uuid
        ORDER BY created_at DESC
        LIMIT 1
      `,
      [context.organizationId, userId]
    ),
    getWatchlist({ userId }),
  ]);
  const verification = verificationResult.rows[0] || null;
  return {
    verification: verification
      ? {
          id: verification.id,
          status: String(verification.status).toUpperCase(),
          createdAt: verification.createdAt,
          reviewedAt: verification.reviewedAt,
        }
      : {
          id: null,
          status: "UNVERIFIED",
          createdAt: null,
          reviewedAt: null,
        },
    watchlist: watchlist.watchlist,
  };
}

async function createOffer({ context, userId, listingId, payload, idempotencyKey, ipAddress }) {
  const amountCents = moneyToCents(payload.amount, "Offer amount");
  const message = assertNoSecrets(cleanText(payload.message, 1000), "Offer message");
  const key = normalizeIdempotencyKey(idempotencyKey);
  const result = await withTransaction(async (client) => {
    if (key) {
      const existing = await client.query(
        `
          SELECT id, listing_id AS "listingId", amount_cents AS "amountCents", status, created_at AS "createdAt"
          FROM goodswapz_offers
          WHERE buyer_user_id = $1::uuid AND idempotency_key = $2
          LIMIT 1
        `,
        [userId, key]
      );
      if (existing.rows[0]) return existing.rows[0];
    }
    const listingResult = await client.query(
      `
        SELECT id, seller_user_id AS "sellerUserId", price_cents AS "priceCents", title
        FROM goodswapz_listings
        WHERE id = $1::uuid AND organization_id = $2 AND status = 'active'
        FOR UPDATE
      `,
      [validUuid(listingId, "Listing identifier"), context.organizationId]
    );
    const listing = listingResult.rows[0];
    if (!listing) throw serviceError("Active listing not found.", 404, "LISTING_NOT_FOUND");
    if (listing.sellerUserId === userId) {
      throw serviceError("A seller cannot make an offer on their own listing.", 409, "SELF_OFFER_NOT_ALLOWED");
    }
    if (amountCents > Number(listing.priceCents) * 5) {
      throw serviceError("Offer amount is outside the permitted range.", 400, "OFFER_OUT_OF_RANGE");
    }
    const offer = await client.query(
      `
        INSERT INTO goodswapz_offers (
          organization_id, listing_id, buyer_user_id, amount_cents, message, idempotency_key
        )
        VALUES ($1, $2::uuid, $3::uuid, $4, NULLIF($5, ''), $6)
        RETURNING id, listing_id AS "listingId", amount_cents AS "amountCents", status, created_at AS "createdAt"
      `,
      [context.organizationId, listing.id, userId, amountCents, message, key]
    );
    return { ...offer.rows[0], sellerUserId: listing.sellerUserId, listingTitle: listing.title };
  });
  await Promise.all([
    safeAudit({
      userId,
      action: "goodswapz.offer.created",
      entityType: "goodswapz_offer",
      entityId: result.id,
      ipAddress,
      metadata: { organizationId: context.organizationId, listingId: result.listingId },
    }),
    result.sellerUserId
      ? notifyUser({
          userId: result.sellerUserId,
          organizationId: context.organizationId,
          title: "New GoodSwapz offer",
          message: `A buyer submitted an offer for ${result.listingTitle}.`,
          sourceId: result.id,
          eventType: "offer.created",
        })
      : Promise.resolve(),
  ]);
  return {
    offer: {
      id: result.id,
      listingId: result.listingId,
      amount: centsToMoney(result.amountCents),
      status: result.status,
      createdAt: result.createdAt,
    },
  };
}

async function respondToOffer({ context, userId, offerId, decision, ipAddress }) {
  const nextStatus = String(decision || "").toLowerCase();
  if (!["accepted", "rejected"].includes(nextStatus)) {
    throw serviceError("Offer decision must be accepted or rejected.", 400, "INVALID_OFFER_DECISION");
  }
  const result = await query(
    `
      UPDATE goodswapz_offers AS offer
      SET status = $1, responded_at = NOW(), updated_at = NOW()
      FROM goodswapz_listings AS listing
      WHERE offer.id = $2::uuid
        AND offer.listing_id = listing.id
        AND offer.organization_id = $3
        AND listing.seller_user_id = $4::uuid
        AND offer.status = 'pending'
      RETURNING offer.id, offer.buyer_user_id AS "buyerUserId", offer.listing_id AS "listingId"
    `,
    [nextStatus, validUuid(offerId, "Offer identifier"), context.organizationId, userId]
  );
  const offer = result.rows[0];
  if (!offer) throw serviceError("Pending offer not found.", 404, "OFFER_NOT_FOUND");
  await Promise.all([
    safeAudit({
      userId,
      action: `goodswapz.offer.${nextStatus}`,
      entityType: "goodswapz_offer",
      entityId: offer.id,
      ipAddress,
      metadata: { organizationId: context.organizationId, listingId: offer.listingId },
    }),
    notifyUser({
      userId: offer.buyerUserId,
      organizationId: context.organizationId,
      title: `Your GoodSwapz offer was ${nextStatus}`,
      message: nextStatus === "accepted"
        ? "The seller accepted your offer. You can now start the protected transaction workflow."
        : "The seller declined your offer.",
      severity: nextStatus === "accepted" ? "success" : "info",
      sourceId: offer.id,
      eventType: `offer.${nextStatus}`,
    }),
  ]);
  return { offerId: offer.id, status: nextStatus };
}

function generateDescription(payload = {}) {
  const platform = PLATFORM_LABELS[normalizePlatform(payload.platform)];
  const category = cleanText(payload.category, 100, 2);
  const subscribers = Math.round(nonNegativeNumber(payload.subscribers, "Subscribers", 10_000_000_000));
  const revenue = nonNegativeNumber(payload.revenue, "Monthly revenue", 100_000_000);
  const title = cleanText(payload.title || `${category} account`, 120, 2);
  const notes = assertNoSecrets(cleanText(payload.notes, 500), "Valuation notes");
  const monetization = revenue > 0
    ? `It reports approximately $${Math.round(revenue).toLocaleString("en-US")} in monthly revenue.`
    : "Revenue and monetization access should be confirmed during buyer inspection.";
  return {
    description: `${title} is a ${platform} account in the ${category} category with approximately ${subscribers.toLocaleString("en-US")} followers or subscribers. ${monetization} ${notes || "The buyer should review current analytics, content ownership, policy standing, and connected services before completing the protected handoff."}`.slice(0, 1800),
  };
}

function estimateValuation(payload = {}) {
  const platform = normalizePlatform(payload.platform);
  const subscribers = nonNegativeNumber(payload.subscribers, "Subscribers", 10_000_000_000);
  const revenue = nonNegativeNumber(payload.revenue, "Monthly revenue", 100_000_000);
  const engagementText = assertNoSecrets(cleanText(payload.engagement, 200), "Engagement notes");
  const platformMultiplier = {
    youtube: 1.25,
    instagram: 0.85,
    tiktok: 0.75,
    twitter: 0.65,
    telegram: 0.7,
  }[platform];
  const audienceValue = subscribers * 0.015 * platformMultiplier;
  const revenueValue = revenue * 24;
  const midpoint = Math.max(100, audienceValue + revenueValue);
  return {
    low: Math.round(midpoint * 0.72),
    high: Math.round(midpoint * 1.28),
    reasoning: `Estimate based on audience scale, reported revenue, and a ${PLATFORM_LABELS[platform]} market factor. ${engagementText || "GoodSwapz does not treat this estimate as a guarantee; buyers must verify analytics, policy standing, and monetization access."}`.slice(0, 600),
  };
}

function escrowRedirectUrl(transactionId) {
  const configured = String(process.env.GOODESCROW_APP_URL || "https://escrow.goodos.app").replace(/\/+$/, "");
  const parsed = safeHttpsUrl(configured, "GoodEscrow application URL", ["goodos.app"]);
  const destination = new URL(parsed);
  destination.searchParams.set("source", APP_ID);
  destination.searchParams.set("transactionId", transactionId);
  return destination.toString();
}

async function initiateTransaction({
  context,
  userId,
  listingId,
  offerId,
  idempotencyKey,
  ipAddress,
}) {
  const key = normalizeIdempotencyKey(idempotencyKey);
  const result = await withTransaction(async (client) => {
    if (key) {
      const existing = await client.query(
        `
          SELECT
            transaction.id,
            transaction.fee_cents AS "feeCents",
            transaction.status,
            handoff.id AS "handoffId"
          FROM goodswapz_escrow_transactions AS transaction
          JOIN goodswapz_handoffs AS handoff ON handoff.transaction_id = transaction.id
          WHERE transaction.buyer_user_id = $1::uuid
            AND transaction.idempotency_key = $2
          LIMIT 1
        `,
        [userId, key]
      );
      if (existing.rows[0]) return existing.rows[0];
    }
    const listingResult = await client.query(
      `
        SELECT id, seller_user_id AS "sellerUserId", platform, title, price_cents AS "priceCents", status
        FROM goodswapz_listings
        WHERE id = $1::uuid AND organization_id = $2
        FOR UPDATE
      `,
      [validUuid(listingId, "Listing identifier"), context.organizationId]
    );
    const listing = listingResult.rows[0];
    if (!listing || listing.status !== "active") {
      throw serviceError("This listing is not available for purchase.", 409, "LISTING_NOT_AVAILABLE");
    }
    if (listing.sellerUserId === userId) {
      throw serviceError("A seller cannot buy their own listing.", 409, "SELF_PURCHASE_NOT_ALLOWED");
    }
    await requireApprovedIdentity({
      context,
      userId,
      client,
      roleLabel: "The buyer",
    });
    await requireApprovedIdentity({
      context,
      userId: listing.sellerUserId,
      client,
      roleLabel: "The seller",
    });
    let amountCents = Number(listing.priceCents);
    let acceptedOfferId = null;
    if (offerId) {
      const offerResult = await client.query(
        `
          SELECT id, amount_cents AS "amountCents"
          FROM goodswapz_offers
          WHERE id = $1::uuid
            AND listing_id = $2::uuid
            AND buyer_user_id = $3::uuid
            AND status = 'accepted'
          LIMIT 1
        `,
        [validUuid(offerId, "Offer identifier"), listing.id, userId]
      );
      if (!offerResult.rows[0]) {
        throw serviceError("Accepted offer not found.", 404, "ACCEPTED_OFFER_NOT_FOUND");
      }
      acceptedOfferId = offerResult.rows[0].id;
      amountCents = Number(offerResult.rows[0].amountCents);
    }
    const feeCents = Math.round(amountCents * 0.025);
    const transactionResult = await client.query(
      `
        INSERT INTO goodswapz_escrow_transactions (
          organization_id, listing_id, buyer_user_id, seller_user_id, offer_id,
          amount_cents, fee_cents, idempotency_key, metadata_json
        )
        VALUES ($1, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7, $8, $9::jsonb)
        RETURNING id, fee_cents AS "feeCents", status
      `,
      [
        context.organizationId,
        listing.id,
        userId,
        listing.sellerUserId,
        acceptedOfferId,
        amountCents,
        feeCents,
        key,
        JSON.stringify({
          source: APP_ID,
          custodyNotice: "GoodSwapz and GoodEscrow coordinate workflow; deposit status must come from a connected provider.",
        }),
      ]
    );
    const transaction = transactionResult.rows[0];
    const handoffResult = await client.query(
      `
        INSERT INTO goodswapz_handoffs (
          organization_id, listing_id, transaction_id, buyer_user_id, seller_user_id, platform
        )
        VALUES ($1, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6)
        RETURNING id
      `,
      [context.organizationId, listing.id, transaction.id, userId, listing.sellerUserId, listing.platform]
    );
    const handoffId = handoffResult.rows[0].id;
    for (const step of platformSteps(listing.platform)) {
      await client.query(
        `
          INSERT INTO goodswapz_handoff_steps (
            handoff_id, step_key, sequence_number, title, description, required_actor
          )
          VALUES ($1::uuid, $2, $3, $4, $5, $6)
        `,
        [handoffId, step.key, step.sequence, step.title, step.description, step.actor]
      );
    }
    await client.query(
      `
        INSERT INTO goodswapz_handoff_events (
          handoff_id, actor_user_id, event_type, to_status, metadata_json
        )
        VALUES ($1::uuid, $2::uuid, 'handoff.created', 'awaiting_funding', $3::jsonb)
      `,
      [handoffId, userId, JSON.stringify({ listingId: listing.id, platform: listing.platform })]
    );
    return {
      ...transaction,
      handoffId,
      sellerUserId: listing.sellerUserId,
      listingTitle: listing.title,
    };
  });
  await safeAudit({
    userId,
    action: "goodswapz.transaction.created",
    entityType: "goodswapz_escrow_transaction",
    entityId: result.id,
    ipAddress,
    metadata: {
      organizationId: context.organizationId,
      listingId,
      handoffId: result.handoffId,
    },
  });
  return {
    transactionId: result.id,
    handoffId: result.handoffId,
    redirectUrl: escrowRedirectUrl(result.id),
    fees: centsToMoney(result.feeCents),
    status: String(result.status).toUpperCase(),
    custodyNotice: "GoodSwapz does not accept passwords or hold funds. Wait for GoodBase to show an externally verified deposit before beginning the handoff.",
  };
}

async function transactionStatus({ context, userId, transactionId }) {
  const result = await query(
    `
      SELECT
        transaction.id,
        transaction.status,
        transaction.funded_at AS "fundedAt",
        transaction.expires_at AS "expiresAt",
        handoff.id AS "handoffId",
        handoff.status AS "handoffStatus"
      FROM goodswapz_escrow_transactions AS transaction
      JOIN goodswapz_handoffs AS handoff ON handoff.transaction_id = transaction.id
      WHERE transaction.id = $1::uuid
        AND transaction.organization_id = $2
        AND (
          transaction.buyer_user_id = $3::uuid
          OR transaction.seller_user_id = $3::uuid
        )
      LIMIT 1
    `,
    [validUuid(transactionId, "Transaction identifier"), context.organizationId, userId]
  );
  const transaction = result.rows[0];
  if (!transaction) throw serviceError("Transaction not found.", 404, "TRANSACTION_NOT_FOUND");
  return {
    ...transaction,
    status: String(transaction.status).toUpperCase(),
  };
}

function webhookCanonicalPayload(payload) {
  return [
    cleanText(payload.eventId, 200, 3),
    validUuid(payload.transactionId, "Transaction identifier"),
    cleanText(payload.status, 40, 3).toLowerCase(),
    String(payload.timestamp || ""),
    cleanText(payload.externalReference, 200),
  ].join(".");
}

function verifyEscrowWebhook({ payload, signature, timestamp }) {
  const secret = String(process.env.GOODESCROW_WEBHOOK_SECRET || "");
  if (secret.length < 32) {
    throw serviceError("GoodEscrow webhook verification is not configured.", 503, "ESCROW_WEBHOOK_NOT_CONFIGURED");
  }
  const timestampValue = Number(timestamp || payload.timestamp);
  if (!Number.isFinite(timestampValue) || Math.abs(Date.now() - timestampValue) > 5 * 60 * 1000) {
    throw serviceError("GoodEscrow webhook timestamp is invalid.", 401, "INVALID_WEBHOOK_TIMESTAMP");
  }
  const canonical = webhookCanonicalPayload({ ...payload, timestamp: timestampValue });
  const expected = crypto.createHmac("sha256", secret).update(canonical).digest("hex");
  const supplied = String(signature || "").replace(/^sha256=/i, "").trim().toLowerCase();
  if (
    supplied.length !== expected.length ||
    !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))
  ) {
    throw serviceError("GoodEscrow webhook signature is invalid.", 401, "INVALID_WEBHOOK_SIGNATURE");
  }
  return { canonical, payloadSha256: crypto.createHash("sha256").update(canonical).digest("hex") };
}

async function processEscrowWebhook({ payload, signature, timestamp }) {
  const verified = verifyEscrowWebhook({ payload, signature, timestamp });
  const eventId = cleanText(payload.eventId, 200, 3);
  const transactionId = validUuid(payload.transactionId, "Transaction identifier");
  const providerStatus = String(payload.status || "").toLowerCase();
  const statusMap = {
    funded: "funded",
    deposit_verified: "funded",
    failed: "failed",
    cancelled: "cancelled",
    disputed: "disputed",
  };
  const nextStatus = statusMap[providerStatus];
  if (!nextStatus) {
    throw serviceError("Unsupported GoodEscrow event status.", 400, "UNSUPPORTED_ESCROW_STATUS");
  }
  const transition = await withTransaction(async (client) => {
    const duplicate = await client.query(
      "SELECT event_id FROM goodswapz_escrow_webhook_events WHERE event_id = $1 LIMIT 1",
      [eventId]
    );
    if (duplicate.rows[0]) return { duplicate: true };
    const transactionResult = await client.query(
      `
        SELECT id, organization_id AS "organizationId", listing_id AS "listingId",
               buyer_user_id AS "buyerUserId", seller_user_id AS "sellerUserId", status
        FROM goodswapz_escrow_transactions
        WHERE id = $1::uuid
        FOR UPDATE
      `,
      [transactionId]
    );
    const transaction = transactionResult.rows[0];
    if (!transaction) throw serviceError("Transaction not found.", 404, "TRANSACTION_NOT_FOUND");
    const allowed = {
      pending: ["funded", "failed", "cancelled"],
      funded: ["disputed"],
      disputed: [],
      failed: [],
      cancelled: [],
      completed: [],
    };
    if (transaction.status !== nextStatus && !(allowed[transaction.status] || []).includes(nextStatus)) {
      throw serviceError("Escrow state transition is not permitted.", 409, "INVALID_ESCROW_TRANSITION");
    }
    await client.query(
      `
        UPDATE goodswapz_escrow_transactions
        SET
          status = $1,
          external_reference = COALESCE(NULLIF($2, ''), external_reference),
          funded_at = CASE WHEN $1 = 'funded' THEN COALESCE(funded_at, NOW()) ELSE funded_at END,
          updated_at = NOW()
        WHERE id = $3::uuid
      `,
      [nextStatus, cleanText(payload.externalReference, 200), transactionId]
    );
    const handoffResult = await client.query(
      "SELECT id, status FROM goodswapz_handoffs WHERE transaction_id = $1::uuid FOR UPDATE",
      [transactionId]
    );
    const handoff = handoffResult.rows[0];
    let handoffStatus = handoff.status;
    if (nextStatus === "funded") {
      handoffStatus = "ready";
      await client.query(
        `
          UPDATE goodswapz_handoffs
          SET status = 'ready', review_deadline = NOW() + INTERVAL '7 days', updated_at = NOW()
          WHERE id = $1::uuid
        `,
        [handoff.id]
      );
      await client.query(
        `
          UPDATE goodswapz_handoff_steps
          SET system_confirmed_at = NOW(), completed_at = NOW(), updated_at = NOW()
          WHERE handoff_id = $1::uuid AND step_key = 'deposit_verified'
        `,
        [handoff.id]
      );
      await client.query(
        "UPDATE goodswapz_listings SET status = 'reserved', updated_at = NOW() WHERE id = $1::uuid",
        [transaction.listingId]
      );
    } else if (["failed", "cancelled"].includes(nextStatus)) {
      handoffStatus = "cancelled";
      await client.query(
        "UPDATE goodswapz_handoffs SET status = 'cancelled', updated_at = NOW() WHERE id = $1::uuid",
        [handoff.id]
      );
    } else if (nextStatus === "disputed") {
      handoffStatus = "disputed";
      await client.query(
        "UPDATE goodswapz_handoffs SET status = 'disputed', updated_at = NOW() WHERE id = $1::uuid",
        [handoff.id]
      );
    }
    await client.query(
      `
        INSERT INTO goodswapz_handoff_events (
          handoff_id, event_type, from_status, to_status, metadata_json
        )
        VALUES ($1::uuid, $2, $3, $4, $5::jsonb)
      `,
      [
        handoff.id,
        `escrow.${nextStatus}`,
        handoff.status,
        handoffStatus,
        JSON.stringify({ eventId, externalReference: cleanText(payload.externalReference, 200) }),
      ]
    );
    await client.query(
      `
        INSERT INTO goodswapz_escrow_webhook_events (
          event_id, transaction_id, event_type, payload_sha256
        )
        VALUES ($1, $2::uuid, $3, $4)
      `,
      [eventId, transactionId, `escrow.${nextStatus}`, verified.payloadSha256]
    );
    return { duplicate: false, nextStatus, handoffStatus, handoffId: handoff.id, ...transaction };
  });
  if (!transition.duplicate) {
    const notification = transition.nextStatus === "funded"
      ? {
          title: "External deposit verified",
          message: "GoodBase received a signed provider confirmation. The seller may now begin the protected account handoff.",
          severity: "success",
        }
      : {
          title: `GoodSwapz transaction ${transition.nextStatus}`,
          message: "The protected transaction status changed. Review the handoff workspace before taking further action.",
          severity: transition.nextStatus === "disputed" ? "warning" : "info",
        };
    await Promise.all([
      notifyUser({
        userId: transition.buyerUserId,
        organizationId: transition.organizationId,
        ...notification,
        sourceId: transition.handoffId,
        eventType: `escrow.${transition.nextStatus}`,
      }),
      notifyUser({
        userId: transition.sellerUserId,
        organizationId: transition.organizationId,
        ...notification,
        sourceId: transition.handoffId,
        eventType: `escrow.${transition.nextStatus}`,
      }),
    ]);
  }
  return transition;
}

function stepCompleted(row) {
  if (row.requiredActor === "seller") return Boolean(row.sellerConfirmedAt);
  if (row.requiredActor === "buyer") return Boolean(row.buyerConfirmedAt);
  if (row.requiredActor === "both") return Boolean(row.sellerConfirmedAt && row.buyerConfirmedAt);
  return Boolean(row.systemConfirmedAt);
}

function mapStep(row, role) {
  const completed = stepCompleted(row);
  const roleConfirmed = role === "seller"
    ? Boolean(row.sellerConfirmedAt)
    : role === "buyer"
      ? Boolean(row.buyerConfirmedAt)
      : false;
  return {
    id: row.id,
    key: row.stepKey,
    sequence: Number(row.sequenceNumber),
    title: row.title,
    description: row.description,
    requiredActor: row.requiredActor,
    required: Boolean(row.required),
    completed,
    roleConfirmed,
    sellerConfirmedAt: row.sellerConfirmedAt,
    buyerConfirmedAt: row.buyerConfirmedAt,
    systemConfirmedAt: row.systemConfirmedAt,
    completedAt: row.completedAt,
    evidenceReference: row.evidenceReference || null,
    completionNote: row.completionNote || null,
  };
}

async function loadHandoff({ context, userId, handoffId, client = database }) {
  const executor = typeof client.query === "function" ? client : database;
  const result = await executor.query(
    `
      SELECT
        handoff.id,
        handoff.status,
        handoff.platform,
        handoff.listing_id AS "listingId",
        handoff.transaction_id AS "transactionId",
        handoff.buyer_user_id AS "buyerUserId",
        handoff.seller_user_id AS "sellerUserId",
        handoff.seller_started_at AS "sellerStartedAt",
        handoff.buyer_confirmed_at AS "buyerConfirmedAt",
        handoff.review_deadline AS "reviewDeadline",
        handoff.completed_at AS "completedAt",
        handoff.dispute_reason AS "disputeReason",
        handoff.created_at AS "createdAt",
        handoff.updated_at AS "updatedAt",
        listing.title AS "listingTitle",
        listing.handle,
        transaction.status AS "transactionStatus",
        transaction.amount_cents AS "amountCents",
        transaction.fee_cents AS "feeCents",
        buyer.display_name AS "buyerName",
        seller.display_name AS "sellerName"
      FROM goodswapz_handoffs AS handoff
      JOIN goodswapz_listings AS listing ON listing.id = handoff.listing_id
      JOIN goodswapz_escrow_transactions AS transaction ON transaction.id = handoff.transaction_id
      JOIN users AS buyer ON buyer.id = handoff.buyer_user_id
      JOIN users AS seller ON seller.id = handoff.seller_user_id
      WHERE handoff.id = $1::uuid
        AND handoff.organization_id = $2
        AND (
          handoff.buyer_user_id = $3::uuid
          OR handoff.seller_user_id = $3::uuid
        )
      LIMIT 1
    `,
    [validUuid(handoffId, "Handoff identifier"), context.organizationId, userId]
  );
  const handoff = result.rows[0];
  if (!handoff) throw serviceError("Handoff not found.", 404, "HANDOFF_NOT_FOUND");
  const role = handoff.buyerUserId === userId ? "buyer" : "seller";
  const stepsResult = await executor.query(
    `
      SELECT
        id, step_key AS "stepKey", sequence_number AS "sequenceNumber", title,
        description, required_actor AS "requiredActor", required,
        seller_confirmed_at AS "sellerConfirmedAt",
        buyer_confirmed_at AS "buyerConfirmedAt",
        system_confirmed_at AS "systemConfirmedAt",
        evidence_reference AS "evidenceReference",
        completion_note AS "completionNote",
        completed_at AS "completedAt"
      FROM goodswapz_handoff_steps
      WHERE handoff_id = $1::uuid
      ORDER BY sequence_number ASC
    `,
    [handoff.id]
  );
  return {
    ...handoff,
    role,
    platform: PLATFORM_LABELS[handoff.platform] || handoff.platform,
    amount: centsToMoney(handoff.amountCents),
    fees: centsToMoney(handoff.feeCents),
    transactionStatus: String(handoff.transactionStatus).toUpperCase(),
    steps: stepsResult.rows.map((step) => mapStep(step, role)),
  };
}

async function listHandoffs({ context, userId }) {
  const result = await query(
    `
      SELECT id
      FROM goodswapz_handoffs
      WHERE organization_id = $1
        AND (buyer_user_id = $2::uuid OR seller_user_id = $2::uuid)
      ORDER BY updated_at DESC
      LIMIT 250
    `,
    [context.organizationId, userId]
  );
  const handoffs = [];
  for (const row of result.rows) {
    handoffs.push(await loadHandoff({ context, userId, handoffId: row.id }));
  }
  return { handoffs };
}

async function startHandoff({ context, userId, handoffId, ipAddress }) {
  const result = await query(
    `
      UPDATE goodswapz_handoffs
      SET status = 'in_progress', seller_started_at = NOW(), updated_at = NOW()
      WHERE id = $1::uuid
        AND organization_id = $2
        AND seller_user_id = $3::uuid
        AND status = 'ready'
      RETURNING id
    `,
    [validUuid(handoffId, "Handoff identifier"), context.organizationId, userId]
  );
  if (!result.rows[0]) {
    throw serviceError(
      "Only the seller can begin a funded handoff that is ready.",
      409,
      "HANDOFF_NOT_READY"
    );
  }
  await Promise.all([
    query(
      `
        INSERT INTO goodswapz_handoff_events (
          handoff_id, actor_user_id, event_type, from_status, to_status
        )
        VALUES ($1::uuid, $2::uuid, 'handoff.started', 'ready', 'in_progress')
      `,
      [result.rows[0].id, userId]
    ),
    safeAudit({
      userId,
      action: "goodswapz.handoff.started",
      entityType: "goodswapz_handoff",
      entityId: result.rows[0].id,
      ipAddress,
      metadata: { organizationId: context.organizationId },
    }),
  ]);
  return loadHandoff({ context, userId, handoffId: result.rows[0].id });
}

async function completeHandoffStep({
  context,
  userId,
  handoffId,
  stepId,
  evidenceReference,
  completionNote,
  ipAddress,
}) {
  const result = await withTransaction(async (client) => {
    const handoff = await loadHandoff({ context, userId, handoffId, client });
    if (!["in_progress", "buyer_review"].includes(handoff.status)) {
      throw serviceError("This handoff is not accepting step confirmations.", 409, "HANDOFF_NOT_IN_PROGRESS");
    }
    const role = handoff.role;
    const stepResult = await client.query(
      `
        SELECT
          id, step_key AS "stepKey", sequence_number AS "sequenceNumber",
          required_actor AS "requiredActor", required,
          seller_confirmed_at AS "sellerConfirmedAt",
          buyer_confirmed_at AS "buyerConfirmedAt",
          system_confirmed_at AS "systemConfirmedAt",
          completed_at AS "completedAt"
        FROM goodswapz_handoff_steps
        WHERE id = $1::uuid AND handoff_id = $2::uuid
        FOR UPDATE
      `,
      [validUuid(stepId, "Step identifier"), handoff.id]
    );
    const step = stepResult.rows[0];
    if (!step) throw serviceError("Handoff step not found.", 404, "HANDOFF_STEP_NOT_FOUND");
    if (step.requiredActor === "system") {
      throw serviceError("System-confirmed steps cannot be changed by a user.", 403, "SYSTEM_STEP_PROTECTED");
    }
    if (step.requiredActor !== "both" && step.requiredActor !== role) {
      throw serviceError("Your transaction role cannot confirm this step.", 403, "HANDOFF_ROLE_DENIED");
    }
    const previous = await client.query(
      `
        SELECT
          required_actor AS "requiredActor",
          seller_confirmed_at AS "sellerConfirmedAt",
          buyer_confirmed_at AS "buyerConfirmedAt",
          system_confirmed_at AS "systemConfirmedAt"
        FROM goodswapz_handoff_steps
        WHERE handoff_id = $1::uuid
          AND sequence_number < $2
          AND required = TRUE
        ORDER BY sequence_number ASC
      `,
      [handoff.id, step.sequenceNumber]
    );
    if (previous.rows.some((item) => !stepCompleted(item))) {
      throw serviceError("Complete the earlier required steps first.", 409, "HANDOFF_STEP_OUT_OF_ORDER");
    }
    const safeEvidence = evidenceReference
      ? assertNoSecrets(cleanText(evidenceReference, 300), "Evidence reference")
      : "";
    const safeNote = completionNote
      ? assertNoSecrets(cleanText(completionNote, 1000), "Completion note")
      : "";
    if (safeEvidence && /^https?:\/\//i.test(safeEvidence)) {
      safeHttpsUrl(safeEvidence, "Evidence reference");
    }
    const sellerConfirmed = role === "seller" ? new Date() : step.sellerConfirmedAt;
    const buyerConfirmed = role === "buyer" ? new Date() : step.buyerConfirmedAt;
    const completed = step.requiredActor === "both"
      ? Boolean(sellerConfirmed && buyerConfirmed)
      : true;
    await client.query(
      `
        UPDATE goodswapz_handoff_steps
        SET
          seller_confirmed_at = CASE WHEN $1 = 'seller' THEN COALESCE(seller_confirmed_at, NOW()) ELSE seller_confirmed_at END,
          buyer_confirmed_at = CASE WHEN $1 = 'buyer' THEN COALESCE(buyer_confirmed_at, NOW()) ELSE buyer_confirmed_at END,
          evidence_reference = COALESCE(NULLIF($2, ''), evidence_reference),
          completion_note = COALESCE(NULLIF($3, ''), completion_note),
          completed_at = CASE WHEN $4::boolean THEN COALESCE(completed_at, NOW()) ELSE completed_at END,
          updated_at = NOW()
        WHERE id = $5::uuid
      `,
      [role, safeEvidence, safeNote, completed, step.id]
    );
    const remaining = await client.query(
      `
        SELECT
          required_actor AS "requiredActor",
          seller_confirmed_at AS "sellerConfirmedAt",
          buyer_confirmed_at AS "buyerConfirmedAt",
          system_confirmed_at AS "systemConfirmedAt"
        FROM goodswapz_handoff_steps
        WHERE handoff_id = $1::uuid AND required = TRUE
      `,
      [handoff.id]
    );
    const allComplete = remaining.rows.every(stepCompleted);
    if (allComplete && handoff.status === "in_progress") {
      await client.query(
        "UPDATE goodswapz_handoffs SET status = 'buyer_review', updated_at = NOW() WHERE id = $1::uuid",
        [handoff.id]
      );
    }
    await client.query(
      `
        INSERT INTO goodswapz_handoff_events (
          handoff_id, actor_user_id, event_type, from_status, to_status, metadata_json
        )
        VALUES ($1::uuid, $2::uuid, 'handoff.step_confirmed', $3, $4, $5::jsonb)
      `,
      [
        handoff.id,
        userId,
        handoff.status,
        allComplete ? "buyer_review" : handoff.status,
        JSON.stringify({ stepId: step.id, stepKey: step.stepKey, role, completed }),
      ]
    );
    return { handoffId: handoff.id };
  });
  await safeAudit({
    userId,
    action: "goodswapz.handoff.step_confirmed",
    entityType: "goodswapz_handoff",
    entityId: result.handoffId,
    ipAddress,
    metadata: { organizationId: context.organizationId, stepId },
  });
  return loadHandoff({ context, userId, handoffId: result.handoffId });
}

async function confirmReceipt({ context, userId, handoffId, ipAddress }) {
  const result = await withTransaction(async (client) => {
    const handoff = await loadHandoff({ context, userId, handoffId, client });
    if (handoff.role !== "buyer" || handoff.status !== "buyer_review") {
      throw serviceError(
        "Only the buyer can complete a handoff after every required step is confirmed.",
        409,
        "HANDOFF_NOT_READY_FOR_COMPLETION"
      );
    }
    if (handoff.steps.some((step) => step.required && !step.completed)) {
      throw serviceError("Every required handoff step must be complete.", 409, "HANDOFF_STEPS_INCOMPLETE");
    }
    await client.query(
      `
        UPDATE goodswapz_handoffs
        SET status = 'completed', buyer_confirmed_at = NOW(), completed_at = NOW(), updated_at = NOW()
        WHERE id = $1::uuid
      `,
      [handoff.id]
    );
    await client.query(
      `
        UPDATE goodswapz_escrow_transactions
        SET status = 'completed', completed_at = NOW(), updated_at = NOW()
        WHERE id = $1::uuid AND status = 'funded'
      `,
      [handoff.transactionId]
    );
    await client.query(
      "UPDATE goodswapz_listings SET status = 'sold', updated_at = NOW() WHERE id = $1::uuid",
      [handoff.listingId]
    );
    await client.query(
      `
        INSERT INTO goodswapz_handoff_events (
          handoff_id, actor_user_id, event_type, from_status, to_status
        )
        VALUES ($1::uuid, $2::uuid, 'handoff.completed', 'buyer_review', 'completed')
      `,
      [handoff.id, userId]
    );
    return handoff;
  });
  await Promise.all([
    safeAudit({
      userId,
      action: "goodswapz.handoff.completed",
      entityType: "goodswapz_handoff",
      entityId: result.id,
      ipAddress,
      metadata: { organizationId: context.organizationId, transactionId: result.transactionId },
    }),
    notifyUser({
      userId: result.sellerUserId,
      organizationId: context.organizationId,
      title: "GoodSwapz handoff completed",
      message: "The buyer confirmed final receipt. Review the connected provider workspace for any external settlement action.",
      severity: "success",
      sourceId: result.id,
      eventType: "handoff.completed",
    }),
  ]);
  return loadHandoff({ context, userId, handoffId: result.id });
}

async function openDispute({ context, userId, handoffId, reason, ipAddress }) {
  const safeReason = assertNoSecrets(cleanText(reason, 1500, 20), "Dispute reason");
  const result = await withTransaction(async (client) => {
    const handoff = await loadHandoff({ context, userId, handoffId, client });
    if (!["ready", "in_progress", "buyer_review"].includes(handoff.status)) {
      throw serviceError("This handoff cannot be disputed in its current state.", 409, "HANDOFF_DISPUTE_NOT_ALLOWED");
    }
    await client.query(
      `
        UPDATE goodswapz_handoffs
        SET status = 'disputed', dispute_reason = $1, updated_at = NOW()
        WHERE id = $2::uuid
      `,
      [safeReason, handoff.id]
    );
    await client.query(
      "UPDATE goodswapz_escrow_transactions SET status = 'disputed', updated_at = NOW() WHERE id = $1::uuid AND status = 'funded'",
      [handoff.transactionId]
    );
    await client.query(
      `
        INSERT INTO goodswapz_handoff_events (
          handoff_id, actor_user_id, event_type, from_status, to_status, metadata_json
        )
        VALUES ($1::uuid, $2::uuid, 'handoff.disputed', $3, 'disputed', $4::jsonb)
      `,
      [handoff.id, userId, handoff.status, JSON.stringify({ reason: safeReason })]
    );
    return handoff;
  });
  const counterpartyId = result.role === "buyer" ? result.sellerUserId : result.buyerUserId;
  await Promise.all([
    safeAudit({
      userId,
      action: "goodswapz.handoff.disputed",
      entityType: "goodswapz_handoff",
      entityId: result.id,
      ipAddress,
      metadata: { organizationId: context.organizationId },
    }),
    notifyUser({
      userId: counterpartyId,
      organizationId: context.organizationId,
      title: "GoodSwapz handoff paused for review",
      message: "A participant opened a dispute. Stop ownership changes and review the handoff timeline.",
      severity: "warning",
      sourceId: result.id,
      eventType: "handoff.disputed",
    }),
  ]);
  return loadHandoff({ context, userId, handoffId: result.id });
}

function detectContentType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return "image/jpeg";
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (buffer.subarray(0, 5).toString("ascii") === "%PDF-") return "application/pdf";
  return null;
}

function documentEncryptionKey() {
  const secret = String(process.env.GOODSWAPZ_DOCUMENT_ENCRYPTION_KEY || "");
  if (secret.length < 32) {
    throw serviceError(
      "Private identity document encryption is not configured.",
      503,
      "DOCUMENT_ENCRYPTION_NOT_CONFIGURED"
    );
  }
  return crypto.createHash("sha256").update(secret).digest();
}

async function encryptAndStoreDocument({ verificationId, documentType, file }) {
  const contentType = detectContentType(file.buffer);
  if (!contentType || contentType !== file.mimetype) {
    throw serviceError("Identity document type is not permitted.", 400, "INVALID_IDENTITY_DOCUMENT");
  }
  if (documentType === "selfie" && contentType === "application/pdf") {
    throw serviceError("The liveness image must be JPEG, PNG, or WebP.", 400, "INVALID_SELFIE_DOCUMENT");
  }
  const key = documentEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(file.buffer), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const payload = Buffer.concat([Buffer.from("GSW1"), iv, authTag, encrypted]);
  const storageDirectory = path.resolve(
    process.env.GOODSWAPZ_PRIVATE_STORAGE_PATH ||
      path.join(process.cwd(), "storage", "private", "goodswapz")
  );
  const verificationDirectory = path.join(storageDirectory, verificationId);
  await fs.mkdir(verificationDirectory, { recursive: true, mode: 0o700 });
  const fileId = crypto.randomUUID();
  const storageKey = path.join(verificationId, `${fileId}.enc`);
  await fs.writeFile(path.join(storageDirectory, storageKey), payload, { mode: 0o600, flag: "wx" });
  return {
    id: fileId,
    documentType,
    storageKey,
    contentType,
    sizeBytes: file.size,
    sha256: crypto.createHash("sha256").update(file.buffer).digest("hex"),
  };
}

async function submitIdentityVerification({ context, userId, idType, files, ipAddress }) {
  const normalizedType = String(idType || "").toLowerCase();
  if (!["license", "passport"].includes(normalizedType)) {
    throw serviceError("Identity document type is invalid.", 400, "INVALID_ID_TYPE");
  }
  const fileMap = {
    front: files?.frontImage?.[0],
    back: files?.backImage?.[0],
    selfie: files?.selfieImage?.[0],
  };
  if (!fileMap.front || !fileMap.selfie || (normalizedType === "license" && !fileMap.back)) {
    throw serviceError("Required identity documents are missing.", 400, "IDENTITY_DOCUMENTS_REQUIRED");
  }
  const verificationId = crypto.randomUUID();
  const stored = [];
  try {
    for (const [documentType, file] of Object.entries(fileMap)) {
      if (!file) continue;
      stored.push(await encryptAndStoreDocument({ verificationId, documentType, file }));
    }
    await withTransaction(async (client) => {
      await client.query(
        `
          INSERT INTO goodswapz_identity_verifications (
            id, organization_id, user_id, id_type
          )
          VALUES ($1::uuid, $2, $3::uuid, $4)
        `,
        [verificationId, context.organizationId, userId, normalizedType]
      );
      for (const document of stored) {
        await client.query(
          `
            INSERT INTO goodswapz_identity_documents (
              id, verification_id, document_type, storage_key, content_type, size_bytes, sha256
            )
            VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7)
          `,
          [
            document.id,
            verificationId,
            document.documentType,
            document.storageKey,
            document.contentType,
            document.sizeBytes,
            document.sha256,
          ]
        );
      }
    });
  } catch (error) {
    const storageDirectory = path.resolve(
      process.env.GOODSWAPZ_PRIVATE_STORAGE_PATH ||
        path.join(process.cwd(), "storage", "private", "goodswapz")
    );
    await fs.rm(path.join(storageDirectory, verificationId), { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  await safeAudit({
    userId,
    action: "goodswapz.identity_verification.submitted",
    entityType: "goodswapz_identity_verification",
    entityId: verificationId,
    ipAddress,
    metadata: {
      organizationId: context.organizationId,
      idType: normalizedType,
      documentCount: stored.length,
    },
  });
  return {
    verification: {
      id: verificationId,
      status: "PENDING",
      submittedAt: new Date().toISOString(),
    },
  };
}

async function reviewIdentityVerification({
  context,
  reviewerUserId,
  verificationId,
  decision,
  note,
  ipAddress,
}) {
  const normalizedDecision = String(decision || "").toLowerCase();
  if (!["approved", "rejected"].includes(normalizedDecision)) {
    throw serviceError("Verification decision must be approved or rejected.", 400, "INVALID_VERIFICATION_DECISION");
  }
  const reviewNote = assertNoSecrets(cleanText(note, 1000), "Verification review note");
  const result = await query(
    `
      UPDATE goodswapz_identity_verifications
      SET
        status = $1,
        review_note = NULLIF($2, ''),
        reviewed_by = $3::uuid,
        reviewed_at = NOW(),
        updated_at = NOW()
      WHERE id = $4::uuid
        AND organization_id = $5
        AND status = 'pending'
      RETURNING id, user_id AS "userId", status
    `,
    [
      normalizedDecision,
      reviewNote,
      reviewerUserId,
      validUuid(verificationId, "Verification identifier"),
      context.organizationId,
    ]
  );
  const verification = result.rows[0];
  if (!verification) {
    throw serviceError("Pending identity verification not found.", 404, "VERIFICATION_NOT_FOUND");
  }
  await Promise.all([
    safeAudit({
      userId: reviewerUserId,
      action: `goodswapz.identity_verification.${normalizedDecision}`,
      entityType: "goodswapz_identity_verification",
      entityId: verification.id,
      ipAddress,
      metadata: { organizationId: context.organizationId },
    }),
    notifyUser({
      userId: verification.userId,
      organizationId: context.organizationId,
      title: `GoodSwapz identity verification ${normalizedDecision}`,
      message: normalizedDecision === "approved"
        ? "Your GoodSwapz identity review is complete."
        : reviewNote || "Your identity submission requires attention.",
      severity: normalizedDecision === "approved" ? "success" : "warning",
      sourceId: verification.id,
      eventType: `identity_verification.${normalizedDecision}`,
    }),
  ]);
  return {
    verification: {
      id: verification.id,
      status: String(verification.status).toUpperCase(),
    },
  };
}

module.exports = {
  APP_ID,
  PLATFORM_LABELS,
  assertNoSecrets,
  completeHandoffStep,
  confirmReceipt,
  createListing,
  createOffer,
  detectContentType,
  estimateValuation,
  generateDescription,
  getUserState,
  getWatchlist,
  health,
  initiateTransaction,
  listHandoffs,
  listListings,
  loadHandoff,
  normalizePlatform,
  openDispute,
  platformSteps,
  processEscrowWebhook,
  respondToOffer,
  reviewIdentityVerification,
  reviewListing,
  startHandoff,
  submitIdentityVerification,
  toggleWatchlist,
  transactionStatus,
  validatedListingInput,
  verifyEscrowWebhook,
};
