"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const requirements = fs.readFileSync(
  path.join(
    __dirname,
    "..",
    "services",
    "kokoro-tts",
    "requirements.txt"
  ),
  "utf8"
);

test("Kokoro pins a Transformers-compatible Hugging Face Hub release", () => {
  assert.match(requirements, /^transformers==5\.5\.2$/m);
  assert.match(requirements, /^huggingface-hub==1\.5\.0$/m);
  assert.doesNotMatch(requirements, /^huggingface-hub==0\.33\.4$/m);
});
