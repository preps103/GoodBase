BEGIN;

ALTER TABLE fleet_vehicles
  VALIDATE CONSTRAINT fleet_vehicles_status_v2_check;

ALTER TABLE fleet_customers
  VALIDATE CONSTRAINT fleet_customers_status_v2_check;

ALTER TABLE fleet_customers
  VALIDATE CONSTRAINT fleet_customers_license_status_v2_check;

ALTER TABLE fleet_customers
  VALIDATE CONSTRAINT fleet_customers_license_verification_method_check;

ALTER TABLE fleet_bookings
  VALIDATE CONSTRAINT fleet_bookings_payment_status_v2_check;

COMMIT;
