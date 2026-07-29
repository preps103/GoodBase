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
const goodMotionRequirements = fs.readFileSync(
  path.join(
    __dirname,
    "..",
    "services",
    "goodmotion-video",
    "requirements.txt"
  ),
  "utf8"
);
const goodMotionCompose = fs.readFileSync(
  path.join(__dirname, "..", "deploy", "goodspeech-video", "compose.yaml"),
  "utf8"
);

test("Kokoro pins a Transformers-compatible Hugging Face Hub release", () => {
  assert.match(requirements, /^transformers==5\.5\.2$/m);
  assert.match(requirements, /^huggingface-hub==1\.5\.0$/m);
  assert.doesNotMatch(requirements, /^huggingface-hub==0\.33\.4$/m);
});

test("GoodMotion pins scanner-cleared media and model dependencies", () => {
  assert.match(goodMotionRequirements, /^diffusers==0\.38\.0$/m);
  assert.match(goodMotionRequirements, /^pillow==12\.3\.0$/m);
  assert.match(goodMotionRequirements, /^python-multipart==0\.0\.30$/m);
  assert.match(goodMotionRequirements, /^transformers==5\.5\.2$/m);
  assert.doesNotMatch(
    goodMotionRequirements,
    /^(?:diffusers==0\.35\.2|pillow==11\.3\.0|python-multipart==0\.0\.20|transformers==4\.57\.1)$/m
  );
  assert.match(goodMotionCompose, /goodos\/goodmotion-video:1\.0\.1/);
});
