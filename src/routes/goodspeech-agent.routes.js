"use strict";

const express = require("express");
const { rateLimit } = require("express-rate-limit");
const authRequired = require("../middleware/authRequired");
const tenantContext = require("../middleware/tenantContext");
const service = require("../services/goodspeech-agent.service");
const { requireGoodSpeechAccess } = require("./goodspeech-collaboration.routes");

const router = express.Router();
const turnLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  keyGenerator: (req) => `goodspeech-agent-user:${req.user.id}`,
  message: { success: false, code: "GOODSPEECH_AGENT_RATE_LIMITED", message: "Too many agent requests. Try again shortly." },
});
const writeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 240,
  standardHeaders: "draft-8",
  legacyHeaders: false,
});

function handle(res, label, operation, status = 200) {
  return Promise.resolve(operation)
    .then((data) => res.status(status).json({ success: true, data }))
    .catch((error) => {
      const statusCode = error.statusCode || 500;
      if (statusCode >= 500) console.error(`[GoodSpeech agents] ${label} failed:`, error.message);
      return res.status(statusCode).json({
        success: false,
        code: error.code || "GOODSPEECH_AGENT_FAILED",
        message: Number.isInteger(error.statusCode) ? error.message : "GoodSpeech could not complete the agent request.",
      });
    });
}

router.use(authRequired, tenantContext, requireGoodSpeechAccess);

router.get("/bootstrap", (req, res) => handle(res, "bootstrap", service.bootstrap({ context: req.tenantContext, userId: req.user.id })));
router.get("/analytics", (req, res) => handle(res, "analytics", service.analyticsSummary({ context: req.tenantContext, userId: req.user.id, agentId: req.query.agentId || null })));
router.post("/", writeLimiter, (req, res) => handle(res, "agent.create", service.createAgent({ payload: req.body, context: req.tenantContext, userId: req.user.id }), 201));
router.patch("/:agentId", writeLimiter, (req, res) => handle(res, "agent.update", service.updateAgent({ agentId: req.params.agentId, payload: req.body, context: req.tenantContext, userId: req.user.id })));

router.get("/:agentId/knowledge", (req, res) => handle(res, "knowledge.list", service.listKnowledge({ agentId: req.params.agentId, context: req.tenantContext, userId: req.user.id })));
router.post("/:agentId/knowledge", writeLimiter, (req, res) => handle(res, "knowledge.add", service.addKnowledge({ agentId: req.params.agentId, payload: req.body, context: req.tenantContext, userId: req.user.id }), 201));
router.delete("/:agentId/knowledge/:knowledgeId", writeLimiter, (req, res) => handle(res, "knowledge.delete", service.deleteKnowledge({ agentId: req.params.agentId, knowledgeId: req.params.knowledgeId, context: req.tenantContext, userId: req.user.id })));

router.post("/:agentId/sessions", turnLimiter, (req, res) => handle(res, "session.start", service.startSession({ agentId: req.params.agentId, payload: req.body, context: req.tenantContext, userId: req.user.id }), 201));
router.get("/sessions/:sessionId", (req, res) => handle(res, "session.get", service.getSession({ sessionId: req.params.sessionId, context: req.tenantContext, userId: req.user.id })));
router.post("/sessions/:sessionId/turns", turnLimiter, (req, res) => handle(res, "session.turn", service.turn({ sessionId: req.params.sessionId, payload: req.body, context: req.tenantContext, userId: req.user.id }), 201));
router.post("/sessions/:sessionId/interrupt", turnLimiter, (req, res) => handle(res, "session.interrupt", service.interrupt({ sessionId: req.params.sessionId, context: req.tenantContext, userId: req.user.id })));
router.post("/sessions/:sessionId/complete", writeLimiter, (req, res) => handle(res, "session.complete", service.completeSession({ sessionId: req.params.sessionId, payload: req.body, context: req.tenantContext, userId: req.user.id })));

router.get("/:agentId/tests", (req, res) => handle(res, "tests.list", service.listTests({ agentId: req.params.agentId, context: req.tenantContext, userId: req.user.id })));
router.post("/:agentId/tests", writeLimiter, (req, res) => handle(res, "test.create", service.createTest({ agentId: req.params.agentId, payload: req.body, context: req.tenantContext, userId: req.user.id }), 201));
router.post("/:agentId/tests/:testId/run", turnLimiter, (req, res) => handle(res, "test.run", service.runTest({ agentId: req.params.agentId, testId: req.params.testId, context: req.tenantContext, userId: req.user.id })));

module.exports = router;
