BEGIN;

CREATE OR REPLACE FUNCTION protect_fleet_contract_template_version()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status IN ('active', 'archived') AND (
    NEW.organization_id IS DISTINCT FROM OLD.organization_id OR
    NEW.name IS DISTINCT FROM OLD.name OR
    NEW.version IS DISTINCT FROM OLD.version OR
    NEW.content_text IS DISTINCT FROM OLD.content_text OR
    NEW.consumer_disclosure_text IS DISTINCT FROM OLD.consumer_disclosure_text OR
    NEW.content_hash IS DISTINCT FROM OLD.content_hash OR
    NEW.created_by IS DISTINCT FROM OLD.created_by OR
    NEW.created_at IS DISTINCT FROM OLD.created_at
  ) THEN
    RAISE EXCEPTION 'published fleet contract template versions are immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS fleet_contract_template_version_immutable
  ON fleet_contract_templates;
CREATE TRIGGER fleet_contract_template_version_immutable
  BEFORE UPDATE ON fleet_contract_templates
  FOR EACH ROW EXECUTE FUNCTION protect_fleet_contract_template_version();

CREATE OR REPLACE FUNCTION protect_fleet_contract_envelope_snapshot()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id OR
     NEW.contract_number IS DISTINCT FROM OLD.contract_number OR
     NEW.booking_id IS DISTINCT FROM OLD.booking_id OR
     NEW.template_id IS DISTINCT FROM OLD.template_id OR
     NEW.template_version IS DISTINCT FROM OLD.template_version OR
     NEW.subject IS DISTINCT FROM OLD.subject OR
     NEW.message IS DISTINCT FROM OLD.message OR
     NEW.content_snapshot IS DISTINCT FROM OLD.content_snapshot OR
     NEW.disclosure_snapshot IS DISTINCT FROM OLD.disclosure_snapshot OR
     NEW.document_hash IS DISTINCT FROM OLD.document_hash OR
     NEW.created_by IS DISTINCT FROM OLD.created_by OR
     NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'fleet contract envelope snapshots are immutable';
  END IF;
  IF NEW.status = 'completed' AND (
    NEW.completed_at IS NULL OR NEW.completed_record_hash IS NULL
  ) THEN
    RAISE EXCEPTION 'completed fleet contracts require a completion record';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS fleet_contract_envelope_snapshot_immutable
  ON fleet_contract_envelopes;
CREATE TRIGGER fleet_contract_envelope_snapshot_immutable
  BEFORE UPDATE ON fleet_contract_envelopes
  FOR EACH ROW EXECUTE FUNCTION protect_fleet_contract_envelope_snapshot();

CREATE OR REPLACE FUNCTION protect_signed_fleet_contract_recipient()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = 'signed' AND (
    NEW.organization_id IS DISTINCT FROM OLD.organization_id OR
    NEW.envelope_id IS DISTINCT FROM OLD.envelope_id OR
    NEW.recipient_user_id IS DISTINCT FROM OLD.recipient_user_id OR
    NEW.recipient_role IS DISTINCT FROM OLD.recipient_role OR
    NEW.full_name IS DISTINCT FROM OLD.full_name OR
    NEW.email IS DISTINCT FROM OLD.email OR
    NEW.signing_order IS DISTINCT FROM OLD.signing_order OR
    NEW.status IS DISTINCT FROM OLD.status OR
    NEW.consented_at IS DISTINCT FROM OLD.consented_at OR
    NEW.signed_at IS DISTINCT FROM OLD.signed_at OR
    NEW.signature_type IS DISTINCT FROM OLD.signature_type OR
    NEW.signature_text IS DISTINCT FROM OLD.signature_text OR
    NEW.signature_data IS DISTINCT FROM OLD.signature_data OR
    NEW.signature_hash IS DISTINCT FROM OLD.signature_hash OR
    NEW.consent_record IS DISTINCT FROM OLD.consent_record OR
    NEW.signed_ip IS DISTINCT FROM OLD.signed_ip OR
    NEW.signed_user_agent IS DISTINCT FROM OLD.signed_user_agent OR
    NEW.created_at IS DISTINCT FROM OLD.created_at
  ) THEN
    RAISE EXCEPTION 'signed fleet contract evidence is immutable';
  END IF;
  IF NEW.status = 'signed' AND (
    NEW.consented_at IS NULL OR NEW.signed_at IS NULL OR
    NEW.signature_type IS NULL OR NEW.signature_hash IS NULL OR
    NEW.consent_record IS NULL
  ) THEN
    RAISE EXCEPTION 'signed fleet contract recipients require complete evidence';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS fleet_contract_signed_recipient_immutable
  ON fleet_contract_recipients;
CREATE TRIGGER fleet_contract_signed_recipient_immutable
  BEFORE UPDATE ON fleet_contract_recipients
  FOR EACH ROW EXECUTE FUNCTION protect_signed_fleet_contract_recipient();

COMMIT;
