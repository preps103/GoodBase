"use strict";

const DEFAULT_PUBLIC_BACKEND_URL =
  "https://base.goodos.app";

function publicBackendUrl() {
  const configured = String(
    process.env.PUBLIC_BACKEND_URL ||
      DEFAULT_PUBLIC_BACKEND_URL
  ).replace(/\/+$/, "");

  try {
    const parsed = new URL(configured);

    if (!["http:", "https:"].includes(parsed.protocol)) {
      return DEFAULT_PUBLIC_BACKEND_URL;
    }

    return parsed.origin;
  } catch {
    return DEFAULT_PUBLIC_BACKEND_URL;
  }
}

function providerAvatarUrl(row) {
  const rawMetadata = row && row.auth_metadata_json;
  let metadata = rawMetadata;

  if (typeof rawMetadata === "string") {
    try {
      metadata = JSON.parse(rawMetadata);
    } catch {
      metadata = {};
    }
  }

  if (!metadata || typeof metadata !== "object") {
    metadata = {};
  }

  const candidate =
    row.avatar_url ||
    metadata.avatarUrl ||
    metadata.avatar_url ||
    metadata.profileImageUrl ||
    metadata.picture ||
    metadata.photoURL ||
    null;

  if (!candidate) return null;

  try {
    const parsed = new URL(String(candidate));
    return parsed.protocol === "https:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function profileAvatarUrl(row) {
  if (!row) return null;

  if (!row.avatar_file_name || !row.id) {
    return providerAvatarUrl(row);
  }

  const updatedAt = Date.parse(
    row.avatar_updated_at || ""
  );
  const version = Number.isFinite(updatedAt)
    ? `?v=${updatedAt}`
    : "";

  return (
    `${publicBackendUrl()}/api/settings/avatars/` +
    `${encodeURIComponent(String(row.id))}${version}`
  );
}

module.exports = {
  DEFAULT_PUBLIC_BACKEND_URL,
  publicBackendUrl,
  providerAvatarUrl,
  profileAvatarUrl
};
