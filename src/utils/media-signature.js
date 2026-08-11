"use strict";

function ascii(buffer, start, end) {
  return Buffer.isBuffer(buffer) && buffer.length >= end
    ? buffer.subarray(start, end).toString("ascii")
    : "";
}

function matchesMediaSignature(buffer, mimeType) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return false;
  const mime = String(mimeType || "").toLowerCase();
  if (mime === "image/png") {
    return buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  if (mime === "image/jpeg") {
    return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  }
  if (mime === "image/webp") {
    return ascii(buffer, 0, 4) === "RIFF" && ascii(buffer, 8, 12) === "WEBP";
  }
  if (mime === "audio/wav" || mime === "audio/x-wav") {
    return ascii(buffer, 0, 4) === "RIFF" && ascii(buffer, 8, 12) === "WAVE";
  }
  if (mime === "audio/mpeg") {
    return ascii(buffer, 0, 3) === "ID3" || (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0);
  }
  if (mime === "audio/webm") {
    return buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3;
  }
  if (mime === "audio/mp4") {
    return ascii(buffer, 4, 8) === "ftyp";
  }
  return false;
}

module.exports = { matchesMediaSignature };
