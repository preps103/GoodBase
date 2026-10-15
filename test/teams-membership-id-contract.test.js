const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const service = fs.readFileSync(
  path.join(__dirname, "../src/services/teams.service.js"),
  "utf8"
);

test("existing team users receive a UUID app membership id", () => {
  const appMembershipInsert = service.match(
    /INSERT INTO app_memberships[\s\S]*?ON CONFLICT \([\s\S]*?user_id,[\s\S]*?app_id[\s\S]*?\)[\s\S]*?\[([\s\S]*?)\]\s*\);/
  );

  assert.ok(appMembershipInsert, "app membership insert was not found");
  assert.match(appMembershipInsert[1], /crypto\.randomUUID\(\)/);
  assert.doesNotMatch(
    appMembershipInsert[1],
    /teamProductionId\("membership"\)/
  );
});
