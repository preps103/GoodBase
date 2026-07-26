"use strict";

const express = require("express");
const { query } = require("../config/database");

const router = express.Router();
const PUBLIC_ORGANIZATION_ID = process.env.GOODFLEET_PUBLIC_ORGANIZATION_ID || "org_goodos";

function fail(response, status, code, message) {
  return response.status(status).json({ success: false, code, message });
}

function rentalTimestamp(value, fallbackTime) {
  const date = String(value || "").slice(0, 10);
  const parsed = new Date(`${date}T${fallbackTime}:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

router.get("/availability", async (request, response, next) => {
  try {
    const pickupAt = rentalTimestamp(request.query.start, "10:00");
    const returnAt = rentalTimestamp(request.query.end, "10:00");
    if (!pickupAt || !returnAt || new Date(returnAt) <= new Date(pickupAt)) {
      return fail(response, 400, "INVALID_RENTAL_PERIOD", "Valid pickup and return dates are required.");
    }
    const category = String(request.query.category || "").trim().slice(0, 80);
    const result = await query(
      `SELECT vehicle.id,vehicle.make,vehicle.model,vehicle.model_year,vehicle.daily_rate,
              vehicle.payload->>'category' AS category,
              vehicle.payload->>'imageUrl' AS image_url,
              vehicle.payload->>'seats' AS seats,
              vehicle.payload->>'fuelType' AS fuel_type,
              vehicle.payload->>'transmission' AS transmission
       FROM fleet_vehicles vehicle
       WHERE vehicle.organization_id=$1
         AND vehicle.archived_at IS NULL
         AND vehicle.status='available'
         AND (vehicle.registration_expiry IS NULL OR vehicle.registration_expiry >= $2::date)
         AND (vehicle.insurance_expiry IS NULL OR vehicle.insurance_expiry >= $2::date)
         AND ($4='' OR lower(vehicle.payload->>'category')=lower($4))
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
        ["pending_payment", "confirmed", "assigned", "checked_in", "checked_out", "extended", "overdue"]
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
        imageUrl: vehicle.image_url || null
      }))
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
