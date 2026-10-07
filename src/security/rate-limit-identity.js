"use strict";

const net = require("node:net");
const { ipKeyGenerator } = require("express-rate-limit");

function rateLimitIdentity(request) {
  const cloudflareAddress = String(
    request.headers?.["cf-connecting-ip"] || ""
  ).trim();

  const clientAddress = net.isIP(cloudflareAddress)
    ? cloudflareAddress
    : request.ip;

  return ipKeyGenerator(clientAddress || "unknown");
}

module.exports = {
  rateLimitIdentity,
};
