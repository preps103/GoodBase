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
const kokoroDockerfile = fs.readFileSync(
  path.join(__dirname, "..", "services", "kokoro-tts", "Dockerfile"),
  "utf8"
);
const kokoroCompose = fs.readFileSync(
  path.join(__dirname, "..", "deploy", "goodspeech", "compose.yaml"),
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
const chatterboxRequirements = fs.readFileSync(
  path.join(__dirname, "..", "services", "chatterbox-voice", "requirements.txt"),
  "utf8"
);
const chatterboxDockerfile = fs.readFileSync(
  path.join(__dirname, "..", "services", "chatterbox-voice", "Dockerfile"),
  "utf8"
);
const whisperRequirements = fs.readFileSync(
  path.join(__dirname, "..", "services", "faster-whisper", "requirements.txt"),
  "utf8"
);
const whisperDockerfile = fs.readFileSync(
  path.join(__dirname, "..", "services", "faster-whisper", "Dockerfile"),
  "utf8"
);

test("Kokoro pins a Transformers-compatible Hugging Face Hub release", () => {
  assert.match(requirements, /^torch==2\.7\.1$/m);
  assert.match(requirements, /^transformers==5\.5\.2$/m);
  assert.match(requirements, /^huggingface-hub==1\.5\.0$/m);
  assert.doesNotMatch(requirements, /^huggingface-hub==0\.33\.4$/m);
  assert.match(kokoroDockerfile, /from transformers\.models\.albert\.modeling_albert import AlbertModel/);
  assert.match(kokoroDockerfile, /from kokoro import KPipeline/);
  assert.match(kokoroCompose, /\/tmp:rw,exec,nosuid,nodev,size=256m,mode=1777/);
});

test("GoodMotion pins scanner-cleared media and model dependencies", () => {
  assert.match(goodMotionRequirements, /^diffusers==0\.38\.0$/m);
  assert.match(goodMotionRequirements, /^pillow==12\.3\.0$/m);
  assert.match(goodMotionRequirements, /^python-multipart==0\.0\.30$/m);
  assert.match(goodMotionRequirements, /^transformers==5\.10\.0$/m);
  assert.doesNotMatch(
    goodMotionRequirements,
    /^(?:diffusers==0\.35\.2|pillow==11\.3\.0|python-multipart==0\.0\.20|transformers==4\.57\.1)$/m
  );
  assert.match(goodMotionCompose, /goodos\/goodmotion-video:1\.0\.1/);
});

test("GoodSpeech pins the CPU cloning engine and hardened private runtime", () => {
  assert.match(chatterboxRequirements, /^python-multipart==0\.0\.30$/m);
  assert.match(chatterboxRequirements, /^transformers==5\.2\.0$/m);
  assert.match(chatterboxRequirements, /^huggingface-hub==1\.5\.0$/m);
  assert.match(chatterboxDockerfile, /chatterbox\.git@5de7a54aa4e5e2baadb0182dde554908b48b85c2/);
  assert.match(kokoroCompose, /127\.0\.0\.1:8881:8881/);
  assert.match(kokoroCompose, /cap_drop:[\s\S]*- ALL/);
  assert.match(kokoroCompose, /no-new-privileges:true/);
});

test("GoodSpeech pins and isolates the private Faster-Whisper runtime", () => {
  assert.match(whisperRequirements, /^faster-whisper==1\.2\.1$/m);
  assert.match(whisperRequirements, /^huggingface-hub==1\.5\.0$/m);
  assert.match(whisperDockerfile, /USER whisper/);
  assert.match(kokoroCompose, /127\.0\.0\.1:8882:8882/);
  assert.match(kokoroCompose, /faster_whisper_models/);
  assert.match(kokoroCompose, /read_only: true/);
});
