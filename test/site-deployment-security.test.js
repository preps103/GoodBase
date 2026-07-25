"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

test("deployment commands scope Git safe.directory to the selected application", async (context) => {
  const childProcess = require("node:child_process");
  const originalSpawn = childProcess.spawn;
  let invocation;

  childProcess.spawn = (command, args, options) => {
    invocation = { command, args, options };
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    process.nextTick(() => child.emit("close", 0, null));
    return child;
  };

  context.after(() => {
    childProcess.spawn = originalSpawn;
  });

  delete require.cache[require.resolve("../src/services/site-deployment.service")];
  const deployment = require("../src/services/site-deployment.service");
  await deployment.runCommand("git", ["status", "--short"], {
    cwd: "/var/www/GoodBase",
  });

  assert.equal(invocation.command, "git");
  assert.deepEqual(invocation.args.slice(0, 2), [
    "-c",
    "safe.directory=/var/www/GoodBase",
  ]);
  assert.deepEqual(invocation.args.slice(2), ["status", "--short"]);
});
