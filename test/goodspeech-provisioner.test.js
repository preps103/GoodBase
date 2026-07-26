"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const provisioner = fs.readFileSync(
  path.join(__dirname, "..", "scripts", "provision-goodspeech.sh"),
  "utf8"
);

test("GoodSpeech provisioner restarts the live Base PM2 process", () => {
  assert.match(
    provisioner,
    /GOODBASE_PM2_PROCESSES=.*goodapp-backend goodapp-backend-ha goodbase-api goodbase-api-ha/
  );
  assert.match(provisioner, /pm2 restart "\$\{process_name\}" --update-env/);
});

test("GoodSpeech provisioner discovers both user and root PM2 runtimes", () => {
  assert.match(
    provisioner,
    /GOODBASE_PM2_RUNTIMES=.*\$\{GOODBASE_PM2_USER\}:\$\{GOODBASE_PM2_HOME\} root:\/root\/\.pm2/
  );
  assert.match(provisioner, /for pm2_runtime in \$\{GOODBASE_PM2_RUNTIMES\}/);
  assert.match(provisioner, /PM2_HOME="\$\{pm2_home\}" pm2 describe/);
  assert.match(provisioner, /PM2_HOME="\$\{pm2_home\}" pm2 save/);
});

test("GoodSpeech provisioner fails if no configured Base process was restarted", () => {
  assert.match(provisioner, /if \[\[ "\$\{restarted\}" -ne 1 \]\]/);
  assert.match(provisioner, /No configured Base PM2 process was found/);
});
