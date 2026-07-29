"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const express = require("express");
const multer = require("multer");
const authRequired = require("../middleware/authRequired");
const { pool, query } = require("../config/database");
const notificationService = require("../services/notification.service");

const router = express.Router();
router.use(authRequired);

const fileSystem = fs.promises;
const PHOTO_ROOT = path.resolve(
  process.env.GOODFLEET_CONDITION_PHOTO_DIR ||
    "/var/lib/goodbase/goodfleet-condition-photos"
);
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
const REQUIRED_SLOTS = [
  "front",
  "rear",
  "driver_side",
  "passenger_side",
  "dashboard",
  "front_interior",
  "rear_interior",
  "odometer",
  "fuel_gauge",
];
const ALLOWED_PHASES = new Set(["departure", "return"]);
const DEPARTURE_STATUSES = new Set(["confirmed", "assigned", "checked_in"]);
const RETURN_STATUSES = new Set(["checked_out", "extended", "overdue"]);
const EMPLOYEE_ROLES = ["owner", "admin", "manager", "staff", "mechanic"];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { files: 1, fileSize: MAX_PHOTO_BYTES, fields: 10 },
});

function receivePhoto(request, response, next) {
  upload.single("photo")(request, response, error => {
    if (!error) return next();
    if (error.code === "LIMIT_FILE_SIZE") {
      return fail(response, 413, "PHOTO_TOO_LARGE", "Condition photos must be 10 MB or smaller.");
    }
    return fail(response, 400, "PHOTO_UPLOAD_FAILED", error.message || "Condition photo upload failed.");
  });
}

function clean(value, maximum = 4000) {
  return String(value ?? "").trim().slice(0, maximum);
}

function fail(response, status, code, message) {
  return response.status(status).json({ success: false, code, message });
}

function imageType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { contentType: "image/jpeg", extension: "jpg" };
  }
  if (buffer.subarray(0, 8).equals(Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]))) {
    return { contentType: "image/png", extension: "png" };
  }
  if (
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return { contentType: "image/webp", extension: "webp" };
  }
  return null;
}

function safePhotoPath(fileName) {
  const normalized = path.basename(String(fileName || ""));
  if (!normalized || normalized !== fileName) return null;
  const resolved = path.resolve(PHOTO_ROOT, normalized);
  return resolved.startsWith(`${PHOTO_ROOT}${path.sep}`) ? resolved : null;
}

function reportPayload(row, photos = []) {
  return {
    id: row.id,
    bookingId: row.booking_id,
    vehicleId: row.vehicle_id,
    customerId: row.customer_id,
    phase: row.phase,
    status: row.status,
    capturedByType: row.captured_by_type,
    mileage: row.mileage === null ? null : Number(row.mileage),
    fuelLevel: row.fuel_level === null ? null : Number(row.fuel_level),
    conditionNotes: row.condition_notes || "",
    acknowledgement: row.acknowledgement_json || {},
    submittedAt: row.submitted_at,
    reviewedAt: row.reviewed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    requiredSlots: REQUIRED_SLOTS,
    photos: photos.map(photo => ({
      id: photo.id,
      slot: photo.slot,
      contentType: photo.content_type,
      sizeBytes: Number(photo.size_bytes),
      checksumSha256: photo.checksum_sha256,
      capturedAt: photo.captured_at,
      url: `/api/fleet/v1/condition-reports/photos/${photo.id}`,
    })),
  };
}

async function bookingAccess(client, request, bookingId) {
  const bookingResult = await client.query(
    `SELECT booking.*, customer.email AS customer_email
       FROM fleet_bookings booking
       JOIN fleet_customers customer
         ON customer.organization_id=booking.organization_id
        AND customer.id=booking.customer_id
      WHERE booking.id=$1 AND booking.archived_at IS NULL
      LIMIT 1`,
    [bookingId]
  );
  const booking = bookingResult.rows[0];
  if (!booking) return null;

  const email = clean(request.user?.email, 320).toLowerCase();
  const customer = email && email === clean(booking.customer_email, 320).toLowerCase();
  const employeeResult = await client.query(
    `SELECT EXISTS (
       SELECT 1
         FROM app_memberships membership
        WHERE membership.organization_id=$1
          AND membership.user_id=$2::uuid
          AND membership.app_id='goodfleet'
          AND membership.status='active'
          AND membership.role=ANY($3::text[])
     ) OR EXISTS (
       SELECT 1
         FROM backend_organization_memberships membership
        WHERE membership.organization_id=$1
          AND membership.user_id=$2::uuid
          AND membership.status='active'
          AND membership.role=ANY($4::text[])
     ) AS allowed`,
    [
      booking.organization_id,
      request.user.id,
      EMPLOYEE_ROLES,
      ["owner", "admin", "manager"],
    ]
  );
  const employee = Boolean(employeeResult.rows[0]?.allowed);
  return {
    booking,
    employee,
    customer,
    actorType: employee ? "employee" : customer ? "customer" : null,
  };
}

async function reportAccess(client, request, reportId) {
  const result = await client.query(
    `SELECT report.*, booking.id AS access_booking_id
       FROM fleet_condition_reports report
       JOIN fleet_bookings booking
         ON booking.organization_id=report.organization_id
        AND booking.id=report.booking_id
      WHERE report.id=$1
      LIMIT 1`,
    [reportId]
  );
  if (!result.rowCount) return null;
  const access = await bookingAccess(client, request, result.rows[0].access_booking_id);
  return access ? { ...access, report: result.rows[0] } : null;
}

async function audit(client, request, organizationId, action, entityId, after) {
  await client.query(
    `INSERT INTO fleet_audit_events
      (organization_id,actor_id,action,entity_type,entity_id,after_json,request_id,ip_address)
     VALUES ($1,$2,$3,'condition_report',$4,$5::jsonb,$6,$7)`,
    [
      organizationId,
      request.user.id,
      action,
      entityId,
      JSON.stringify(after || {}),
      request.id || request.get("X-Request-ID") || null,
      request.ip || null,
    ]
  );
}

async function photosForReports(client, organizationId, reportIds) {
  if (!reportIds.length) return [];
  const result = await client.query(
    `SELECT *
       FROM fleet_condition_photos
      WHERE organization_id=$1 AND report_id=ANY($2::uuid[])
      ORDER BY captured_at`,
    [organizationId, reportIds]
  );
  return result.rows;
}

async function notifyReturnSubmitted(access, report) {
  const recipients = await query(
    `SELECT DISTINCT account.id,account.email
       FROM backend_organization_memberships membership
       JOIN users account ON account.id=membership.user_id
      WHERE membership.organization_id=$1
        AND membership.status='active'
        AND account.status='active'
        AND (
          membership.role IN ('owner','admin')
          OR account.platform_role IN ('owner','manager')
        )`,
    [access.booking.organization_id]
  );
  await Promise.all(recipients.rows.map(async recipient => {
    try {
      await notificationService.createNotification({
        appId: "goodfleet",
        organizationId: access.booking.organization_id,
        recipientUserId: recipient.id,
        recipientEmail: recipient.email,
        notificationKey: "goodfleet.return_photos.submitted",
        title: `Return walkaround ready — ${access.booking.reservation_number}`,
        message: "The renter submitted the required return photos. Compare them with the departure walkaround before completing the return.",
        severity: "info",
        category: "fleet_operations",
        actionUrl: `/bookings?bookingId=${access.booking.id}&action=check-in`,
        source: "goodfleet-condition",
        sourceId: report.id,
        payload: {
          bookingId: access.booking.id,
          reservationNumber: access.booking.reservation_number,
          conditionReportId: report.id,
        },
      });
    } catch (error) {
      if (error.code !== "23505") throw error;
    }
  }));
}

router.get("/booking/:bookingId", async (request, response, next) => {
  const client = await pool.connect();
  try {
    const access = await bookingAccess(client, request, request.params.bookingId);
    if (!access || (!access.employee && !access.customer)) {
      return fail(response, 404, "BOOKING_NOT_FOUND", "Reservation not found.");
    }
    const reports = await client.query(
      `SELECT *
         FROM fleet_condition_reports
        WHERE organization_id=$1 AND booking_id=$2
        ORDER BY CASE phase WHEN 'departure' THEN 1 ELSE 2 END`,
      [access.booking.organization_id, access.booking.id]
    );
    const photos = await photosForReports(
      client,
      access.booking.organization_id,
      reports.rows.map(report => report.id)
    );
    response.json({
      success: true,
      data: reports.rows.map(report => reportPayload(
        report,
        photos.filter(photo => photo.report_id === report.id)
      )),
    });
  } catch (error) {
    next(error);
  } finally {
    client.release();
  }
});

router.post("/booking/:bookingId/:phase", async (request, response, next) => {
  const client = await pool.connect();
  try {
    const phase = clean(request.params.phase, 20);
    if (!ALLOWED_PHASES.has(phase)) {
      return fail(response, 400, "INVALID_CONDITION_PHASE", "Choose departure or return.");
    }
    const access = await bookingAccess(client, request, request.params.bookingId);
    if (!access || (!access.employee && !access.customer)) {
      return fail(response, 404, "BOOKING_NOT_FOUND", "Reservation not found.");
    }
    if (phase === "departure" && !access.employee) {
      return fail(response, 403, "EMPLOYEE_WALKAROUND_REQUIRED", "A GoodFleet employee must complete the departure walkaround.");
    }
    const allowedStatuses = phase === "departure" ? DEPARTURE_STATUSES : RETURN_STATUSES;
    if (!allowedStatuses.has(access.booking.status)) {
      return fail(
        response,
        409,
        "CONDITION_REPORT_NOT_AVAILABLE",
        phase === "departure"
          ? "The reservation is not ready for the departure walkaround."
          : "The rental is not ready for return photos."
      );
    }
    const mileage = request.body?.mileage === "" || request.body?.mileage === null
      ? null
      : Number(request.body?.mileage);
    const fuelLevel = request.body?.fuelLevel === "" || request.body?.fuelLevel === null
      ? null
      : Number(request.body?.fuelLevel);
    if (mileage !== null && (!Number.isInteger(mileage) || mileage < 0)) {
      return fail(response, 400, "INVALID_MILEAGE", "Enter a valid odometer reading.");
    }
    if (fuelLevel !== null && (!Number.isInteger(fuelLevel) || fuelLevel < 0 || fuelLevel > 100)) {
      return fail(response, 400, "INVALID_FUEL_LEVEL", "Fuel level must be between 0 and 100.");
    }
    const acknowledgement = request.body?.acknowledgement &&
      typeof request.body.acknowledgement === "object" &&
      !Array.isArray(request.body.acknowledgement)
      ? request.body.acknowledgement
      : {};
    const saved = await client.query(
      `INSERT INTO fleet_condition_reports
        (organization_id,booking_id,vehicle_id,customer_id,phase,status,captured_by_type,
         captured_by_user_id,mileage,fuel_level,condition_notes,acknowledgement_json)
       VALUES ($1,$2,$3,$4,$5,'draft',$6,$7,$8,$9,$10,$11::jsonb)
       ON CONFLICT (organization_id,booking_id,phase)
       DO UPDATE SET
         mileage=EXCLUDED.mileage,
         fuel_level=EXCLUDED.fuel_level,
         condition_notes=EXCLUDED.condition_notes,
         acknowledgement_json=EXCLUDED.acknowledgement_json,
         captured_by_type=EXCLUDED.captured_by_type,
         captured_by_user_id=EXCLUDED.captured_by_user_id,
         updated_at=NOW()
       WHERE fleet_condition_reports.status='draft'
       RETURNING *`,
      [
        access.booking.organization_id,
        access.booking.id,
        access.booking.vehicle_id,
        access.booking.customer_id,
        phase,
        access.actorType,
        request.user.id,
        mileage,
        fuelLevel,
        clean(request.body?.conditionNotes, 5000) || null,
        JSON.stringify(acknowledgement),
      ]
    );
    if (!saved.rowCount) {
      return fail(response, 409, "CONDITION_REPORT_LOCKED", "Submitted condition reports cannot be changed.");
    }
    const photos = await photosForReports(client, access.booking.organization_id, [saved.rows[0].id]);
    response.status(201).json({ success: true, data: reportPayload(saved.rows[0], photos) });
  } catch (error) {
    next(error);
  } finally {
    client.release();
  }
});

router.post("/:reportId/photos/:slot", receivePhoto, async (request, response, next) => {
  const client = await pool.connect();
  let finalPath = null;
  try {
    const slot = clean(request.params.slot, 40);
    if (!REQUIRED_SLOTS.includes(slot)) {
      return fail(response, 400, "INVALID_PHOTO_SLOT", "Choose a required vehicle photo angle.");
    }
    if (!request.file?.buffer) {
      return fail(response, 400, "PHOTO_REQUIRED", "Take or choose a vehicle photo.");
    }
    const detected = imageType(request.file.buffer);
    if (!detected) {
      return fail(response, 415, "INVALID_PHOTO_TYPE", "Use a JPEG, PNG, or WebP vehicle photo.");
    }
    const access = await reportAccess(client, request, request.params.reportId);
    if (!access || (!access.employee && !access.customer)) {
      return fail(response, 404, "CONDITION_REPORT_NOT_FOUND", "Condition report not found.");
    }
    if (access.report.status !== "draft") {
      return fail(response, 409, "CONDITION_REPORT_LOCKED", "Submitted condition reports cannot be changed.");
    }
    if (access.report.phase === "departure" && !access.employee) {
      return fail(response, 403, "EMPLOYEE_WALKAROUND_REQUIRED", "A GoodFleet employee must capture departure photos.");
    }

    await fileSystem.mkdir(PHOTO_ROOT, { recursive: true, mode: 0o750 });
    const fileName = `${access.report.organization_id}-${access.report.id}-${slot}-${crypto.randomUUID()}.${detected.extension}`;
    finalPath = safePhotoPath(fileName);
    const temporaryPath = `${finalPath}.uploading`;
    await fileSystem.writeFile(temporaryPath, request.file.buffer, { mode: 0o640, flag: "wx" });
    await fileSystem.rename(temporaryPath, finalPath);
    const checksum = crypto.createHash("sha256").update(request.file.buffer).digest("hex");

    await client.query("BEGIN");
    const previous = await client.query(
      `SELECT file_name
         FROM fleet_condition_photos
        WHERE report_id=$1 AND slot=$2
        FOR UPDATE`,
      [access.report.id, slot]
    );
    const photo = await client.query(
      `INSERT INTO fleet_condition_photos
        (organization_id,report_id,slot,file_name,content_type,size_bytes,checksum_sha256,captured_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (report_id,slot)
       DO UPDATE SET
         file_name=EXCLUDED.file_name,
         content_type=EXCLUDED.content_type,
         size_bytes=EXCLUDED.size_bytes,
         checksum_sha256=EXCLUDED.checksum_sha256,
         captured_by=EXCLUDED.captured_by,
         captured_at=NOW()
       RETURNING *`,
      [
        access.report.organization_id,
        access.report.id,
        slot,
        fileName,
        detected.contentType,
        request.file.buffer.length,
        checksum,
        request.user.id,
      ]
    );
    await audit(client, request, access.report.organization_id, "condition.photo.captured", access.report.id, {
      bookingId: access.report.booking_id,
      phase: access.report.phase,
      slot,
      photoId: photo.rows[0].id,
      checksumSha256: checksum,
    });
    await client.query("COMMIT");
    const previousPath = safePhotoPath(previous.rows[0]?.file_name);
    if (previousPath && previousPath !== finalPath) {
      await fileSystem.unlink(previousPath).catch(() => {});
    }
    response.status(201).json({
      success: true,
      data: reportPayload(access.report, [photo.rows[0]]).photos[0],
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    if (finalPath) await fileSystem.unlink(finalPath).catch(() => {});
    next(error);
  } finally {
    client.release();
  }
});

router.post("/:reportId/submit", async (request, response, next) => {
  const client = await pool.connect();
  try {
    const access = await reportAccess(client, request, request.params.reportId);
    if (!access || (!access.employee && !access.customer)) {
      return fail(response, 404, "CONDITION_REPORT_NOT_FOUND", "Condition report not found.");
    }
    if (access.report.phase === "departure" && !access.employee) {
      return fail(response, 403, "EMPLOYEE_WALKAROUND_REQUIRED", "A GoodFleet employee must submit the departure walkaround.");
    }
    if (access.report.status === "submitted") {
      const photos = await photosForReports(client, access.report.organization_id, [access.report.id]);
      return response.json({ success: true, data: reportPayload(access.report, photos) });
    }
    const acknowledgement = access.report.acknowledgement_json || {};
    if (
      acknowledgement.confirmed !== true ||
      !clean(acknowledgement.name, 160)
    ) {
      return fail(
        response,
        409,
        "WALKAROUND_ACKNOWLEDGEMENT_REQUIRED",
        access.report.phase === "departure"
          ? "Record the customer's joint walkaround acknowledgement before vehicle release."
          : "Confirm that the return photos accurately show the vehicle's condition."
      );
    }
    const photos = await photosForReports(client, access.report.organization_id, [access.report.id]);
    const captured = new Set(photos.map(photo => photo.slot));
    const missing = REQUIRED_SLOTS.filter(slot => !captured.has(slot));
    if (missing.length) {
      return fail(
        response,
        409,
        "CONDITION_PHOTOS_REQUIRED",
        `Capture every required angle before submitting (${missing.join(", ")}).`
      );
    }
    await client.query("BEGIN");
    const submitted = await client.query(
      `UPDATE fleet_condition_reports
          SET status='submitted',submitted_by=$3,submitted_at=NOW(),updated_at=NOW()
        WHERE organization_id=$1 AND id=$2 AND status='draft'
        RETURNING *`,
      [access.report.organization_id, access.report.id, request.user.id]
    );
    if (!submitted.rowCount) {
      await client.query("ROLLBACK");
      return fail(response, 409, "CONDITION_REPORT_LOCKED", "Condition report is already locked.");
    }
    await audit(client, request, access.report.organization_id, "condition.report.submitted", access.report.id, {
      bookingId: access.report.booking_id,
      phase: access.report.phase,
      photoCount: photos.length,
      acknowledgedBy: clean(acknowledgement.name, 160),
    });
    await client.query("COMMIT");
    if (access.report.phase === "return" && access.customer) {
      await notifyReturnSubmitted(access, submitted.rows[0]);
    }
    response.json({ success: true, data: reportPayload(submitted.rows[0], photos) });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    next(error);
  } finally {
    client.release();
  }
});

router.get("/photos/:photoId", async (request, response, next) => {
  const client = await pool.connect();
  try {
    const photoResult = await client.query(
      `SELECT photo.*, report.booking_id
         FROM fleet_condition_photos photo
         JOIN fleet_condition_reports report
           ON report.organization_id=photo.organization_id
          AND report.id=photo.report_id
        WHERE photo.id=$1
        LIMIT 1`,
      [request.params.photoId]
    );
    const photo = photoResult.rows[0];
    if (!photo) return response.sendStatus(404);
    const access = await bookingAccess(client, request, photo.booking_id);
    if (!access || (!access.employee && !access.customer)) return response.sendStatus(404);
    const filePath = safePhotoPath(photo.file_name);
    if (!filePath) return response.sendStatus(404);
    await fileSystem.access(filePath, fs.constants.R_OK);
    response.set({
      "Content-Type": photo.content_type,
      "Content-Length": String(photo.size_bytes),
      "Cache-Control": "private, no-store",
      "Content-Disposition": `inline; filename="${photo.slot}.${photo.content_type.split("/")[1]}"`,
      "X-Content-Type-Options": "nosniff",
      "Cross-Origin-Resource-Policy": "same-site",
    });
    return response.sendFile(filePath);
  } catch (error) {
    if (error.code === "ENOENT") return response.sendStatus(404);
    return next(error);
  } finally {
    client.release();
  }
});

module.exports = router;
