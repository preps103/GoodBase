#!/usr/bin/bash
set -Eeuo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this provisioning script as root." >&2
  exit 77
fi

readonly deployment_user="goodapp"
readonly deployment_group="goodapp"
readonly backup_root="/var/backups/goodos-site-updates"
readonly product_home="/home/mgoodlo3"

readonly -a application_paths=(
  "/home/mgoodlo3/GoodOS"
  "/home/mgoodlo3/GoodAds"
  "/home/mgoodlo3/GoodBoost"
  "/home/mgoodlo3/GoodBuilder"
  "/home/mgoodlo3/GoodCustoms"
  "/home/mgoodlo3/GoodDesigner"
  "/home/mgoodlo3/GoodEditor"
  "/home/mgoodlo3/GoodEscrow"
  "/home/mgoodlo3/GoodFleet"
  "/home/mgoodlo3/GoodQR"
  "/home/mgoodlo3/GoodScan"
  "/home/mgoodlo3/GoodSpeech"
  "/home/mgoodlo3/GoodSwapz"
  "/home/mgoodlo3/GoodTrusts"
  "/home/mgoodlo3/GoodVoice"
  "/var/www/GoodID"
)

getent passwd "${deployment_user}" >/dev/null
getent group "${deployment_group}" >/dev/null

chgrp "${deployment_group}" "${product_home}"
chmod g+rx "${product_home}"

for application_path in "${application_paths[@]}"; do
  if [[ ! -d "${application_path}" ]]; then
    echo "Missing canonical application directory: ${application_path}" >&2
    exit 66
  fi

  chown -R "${deployment_user}:${deployment_group}" "${application_path}"
  find "${application_path}" -type d -exec chmod u+rwx {} +
  find "${application_path}" -type f -exec chmod u+rw {} +
done

install -d -m 0700 -o "${deployment_user}" -g "${deployment_group}" "${backup_root}"

echo "GoodBase deployment access provisioned for ${#application_paths[@]} application directories."
