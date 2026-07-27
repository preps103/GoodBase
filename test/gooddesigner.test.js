"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const service = require("../src/services/gooddesigner.service");

test("GoodDesigner maps supported aspect ratios to image sizes", () => {
  assert.equal(service._internal.imageSizeForAspectRatio("1:1"), "1024x1024");
  assert.equal(service._internal.imageSizeForAspectRatio("16:9"), "1536x1024");
  assert.equal(service._internal.imageSizeForAspectRatio("9:16"), "1024x1536");
});

test("GoodDesigner rejects unsupported and oversized data images", () => {
  assert.throws(
    () => service._internal.parseDataImage("data:image/svg+xml;base64,PHN2Zz4="),
    /PNG, JPEG, or WebP/
  );
  const tooLarge = Buffer.alloc((10 * 1024 * 1024) + 1).toString("base64");
  assert.throws(
    () => service._internal.parseDataImage(`data:image/png;base64,${tooLarge}`),
    /10 MB/
  );
});

test("GoodDesigner accepts safe SVG and rejects active content", () => {
  assert.equal(
    service._internal.validatedSvg("<svg viewBox=\"0 0 10 10\"><path d=\"M0 0h10v10z\"/></svg>"),
    "<svg viewBox=\"0 0 10 10\"><path d=\"M0 0h10v10z\"/></svg>"
  );
  assert.throws(
    () => service._internal.validatedSvg("<svg><script>alert(1)</script></svg>"),
    /unsafe/
  );
  assert.throws(
    () => service._internal.validatedSvg("<svg><path onclick=\"alert(1)\"/></svg>"),
    /unsafe/
  );
});

test("GoodDesigner bounds production campaign shot counts", () => {
  assert.equal(service._internal.campaignShotCount(undefined), 4);
  assert.equal(service._internal.campaignShotCount(0), 4);
  assert.equal(service._internal.campaignShotCount(2), 2);
  assert.equal(service._internal.campaignShotCount(9), 4);
  assert.equal(service._internal.campaignShotCount(-3), 1);
});
