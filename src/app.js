const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const { codeToSession } = require("./wechat");
const { decryptResource, verifyWechatpaySignature } = require("./wechat-pay");
const {
  DEFAULT_LEGACY_APPID,
  paymentTenants,
  publicTenant,
  resolveTenantFromRequest
} = require("./tenant-config");

const publicDir = path.join(__dirname, "..", "public");

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function ok(res, data) {
  send(res, 200, { ok: true, data });
}

function fail(res, status, message, details) {
  send(res, status, { ok: false, error: message, details });
}

function readBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", chunk => {
      raw += chunk;
      if (raw.length > maxBytes) {
        reject(new Error("请求体过大"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("JSON 格式不正确"));
      }
    });
    req.on("error", reject);
  });
}

const UPLOAD_RULES = {
    "image/png": { ext: ".png", max: 5 * 1024 * 1024, type: "image" },
    "image/jpeg": { ext: ".jpg", max: 5 * 1024 * 1024, type: "image" },
    "image/webp": { ext: ".webp", max: 5 * 1024 * 1024, type: "image" },
    "image/gif": { ext: ".gif", max: 5 * 1024 * 1024, type: "image" },
    "audio/mpeg": { ext: ".mp3", max: 20 * 1024 * 1024, type: "audio" },
    "audio/mp3": { ext: ".mp3", max: 20 * 1024 * 1024, type: "audio" },
    "audio/wav": { ext: ".wav", max: 20 * 1024 * 1024, type: "audio" },
    "audio/x-wav": { ext: ".wav", max: 20 * 1024 * 1024, type: "audio" },
    "audio/ogg": { ext: ".ogg", max: 20 * 1024 * 1024, type: "audio" },
    "audio/mp4": { ext: ".m4a", max: 20 * 1024 * 1024, type: "audio" },
    "audio/x-m4a": { ext: ".m4a", max: 20 * 1024 * 1024, type: "audio" }
};

function readRawBuffer(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    req.on("data", chunk => {
      length += chunk.length;
      if (length > maxBytes) {
        const error = new Error(`文件大小不能超过 ${Math.floor(maxBytes / 1024 / 1024)}MB`);
        error.statusCode = 413;
        reject(error);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function uploadFormatError(message = "上传文件格式不正确") {
  const error = new Error(message);
  error.statusCode = 422;
  return error;
}

// 小程序 wx.uploadFile 走 multipart/form-data，这里取出第一个文件段。
function parseMultipartUpload(raw, contentType = "") {
  const boundaryMatch = String(contentType).match(/boundary="?([^";]+)"?/i);
  if (!boundaryMatch) throw uploadFormatError();
  const boundary = `--${boundaryMatch[1]}`;
  const text = raw.toString("latin1");
  const firstBoundary = text.indexOf(boundary);
  if (firstBoundary < 0) throw uploadFormatError();
  const headerStart = firstBoundary + boundary.length;
  const headerEnd = text.indexOf("\r\n\r\n", headerStart);
  if (headerEnd < 0) throw uploadFormatError();
  const headerText = text.slice(headerStart, headerEnd);
  const bodyStart = headerEnd + 4;
  const nextBoundary = text.indexOf(`\r\n${boundary}`, bodyStart);
  const bodyEnd = nextBoundary < 0 ? text.length : nextBoundary;
  if (bodyEnd <= bodyStart) throw uploadFormatError();
  const mimeMatch = headerText.match(/content-type:\s*([^\r\n;]+)/i);
  return {
    buffer: raw.subarray(bodyStart, bodyEnd),
    mime: mimeMatch ? mimeMatch[1].trim().toLowerCase() : ""
  };
}

// 微信返回的临时文件后缀不一定可信，用文件头确认真实类型。
function sniffUploadMime(buffer) {
  const head = buffer.subarray(0, 12);
  if (head.subarray(0, 4).toString("hex") === "89504e47") return "image/png";
  if (head.subarray(0, 3).toString("hex") === "ffd8ff") return "image/jpeg";
  if (head.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (head.subarray(0, 3).toString("ascii") === "GIF") return "image/gif";
  if (head.subarray(0, 3).toString("hex") === "494433") return "audio/mpeg";
  if (["fffb", "fff3", "fff2"].some(prefix => head.subarray(0, 2).toString("hex") === prefix)) return "audio/mpeg";
  if (head.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WAVE") return "audio/wav";
  if (head.subarray(0, 4).toString("ascii") === "OggS") return "audio/ogg";
  if (head.toString("ascii").includes("ftyp")) return "audio/mp4";
  return "";
}

async function storeUploadBuffer(input = {}, appid = "", options = {}) {
  const buffer = Buffer.isBuffer(input.buffer) ? input.buffer : Buffer.alloc(0);
  let mime = String(input.mime || "").toLowerCase().replace("image/jpg", "image/jpeg");
  const allowed = UPLOAD_RULES;
  if (!allowed[mime] && buffer.length) {
    const sniffed = sniffUploadMime(buffer);
    if (sniffed) mime = sniffed;
  }
  const rule = allowed[mime];
  if (!rule || (options.imageOnly && rule.type !== "image")) {
    const error = new Error(options.imageOnly ? "只支持上传 PNG、JPG、WebP、GIF 图片" : "只支持上传 PNG、JPG、WebP、GIF 图片或 MP3、WAV、OGG、M4A 音频");
    error.statusCode = 422;
    throw error;
  }
  const maxSize = Number(options.maxBytes || process.env.ADMIN_UPLOAD_MAX_BYTES || rule.max);
  if (!buffer.length || buffer.length > maxSize) {
    const error = new Error(`文件大小不能超过 ${Math.floor(maxSize / 1024 / 1024)}MB`);
    error.statusCode = 422;
    throw error;
  }
  const signature = buffer.subarray(0, 12).toString("hex");
  const asciiHead = buffer.subarray(0, 12).toString("ascii");
  const imageValid = (
    mime === "image/png" && signature.startsWith("89504e47") ||
    mime === "image/jpeg" && signature.startsWith("ffd8ff") ||
    mime === "image/webp" && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP" ||
    mime === "image/gif" && buffer.subarray(0, 3).toString("ascii") === "GIF"
  );
  const audioValid = (
    ["audio/mpeg", "audio/mp3"].includes(mime) && (signature.startsWith("494433") || signature.startsWith("fffb") || signature.startsWith("fff3") || signature.startsWith("fff2")) ||
    ["audio/wav", "audio/x-wav"].includes(mime) && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WAVE" ||
    mime === "audio/ogg" && buffer.subarray(0, 4).toString("ascii") === "OggS" ||
    ["audio/mp4", "audio/x-m4a"].includes(mime) && asciiHead.includes("ftyp")
  );
  const valid = rule.type === "image" ? imageValid : audioValid;
  if (!valid) {
    const error = new Error("上传内容和文件格式不匹配");
    error.statusCode = 422;
    throw error;
  }
  const safeAppid = String(appid || "default").replace(/[^a-zA-Z0-9_-]/g, "_");
  const dir = path.join(publicDir, "uploads", safeAppid);
  await fs.promises.mkdir(dir, { recursive: true });
  const name = `${Date.now()}-${crypto.randomBytes(8).toString("hex")}${rule.ext}`;
  const filePath = path.join(dir, name);
  await fs.promises.writeFile(filePath, buffer);
  return {
    url: `/uploads/${safeAppid}/${name}`,
    mime_type: mime,
    type: rule.type,
    size: buffer.length
  };
}

async function saveAdminUpload(body = {}, appid = "", options = {}) {
  const raw = String(body.data_url || body.data || "");
  const match = raw.match(/^data:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\r\n]+)$/i);
  if (!match) throw uploadFormatError();
  return storeUploadBuffer({
    buffer: Buffer.from(match[2].replace(/\s/g, ""), "base64"),
    mime: match[1]
  }, appid, options);
}

// 同一路由同时兼容 JSON(data_url) 与 wx.uploadFile 的 multipart 上传。
async function saveUploadRequest(req, appid = "", options = {}) {
  const contentType = String(req.headers["content-type"] || "");
  const maxBytes = Number(options.maxBytes || process.env.ADMIN_UPLOAD_BODY_MAX_BYTES || 32 * 1024 * 1024);
  if (/^multipart\/form-data/i.test(contentType)) {
    const raw = await readRawBuffer(req, maxBytes);
    const file = parseMultipartUpload(raw, contentType);
    return storeUploadBuffer(file, appid, options);
  }
  return saveAdminUpload(await readBody(req, maxBytes), appid, options);
}

async function saveUserAvatarUpload(body = {}, appid = "") {
  return saveAdminUpload(body, appid, { imageOnly: true, maxBytes: 5 * 1024 * 1024 });
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    req.on("data", chunk => {
      chunks.push(chunk);
      length += chunk.length;
      if (length > 1024 * 1024) {
        reject(new Error("请求体过大"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function matchId(pathname, prefix) {
  if (!pathname.startsWith(prefix)) return null;
  const rest = pathname.slice(prefix.length);
  if (!/^\d+(\/.*)?$/.test(rest)) return null;
  return Number(rest.split("/")[0]);
}

function safeEqualText(left, right) {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function adminTokenSecret() {
  return process.env.ADMIN_TOKEN_SECRET || process.env.ADMIN_PASSWORD || "mall-admin-token";
}

function signAdminToken(payload) {
  const data = Buffer.from(JSON.stringify({
    ...payload,
    exp: Date.now() + Number(process.env.ADMIN_TOKEN_TTL_MS || 7 * 86400000)
  })).toString("base64url");
  const signature = crypto.createHmac("sha256", adminTokenSecret()).update(data).digest("base64url");
  return `${data}.${signature}`;
}

function verifyAdminToken(token = "") {
  const [data, signature] = String(token || "").split(".");
  if (!data || !signature) return null;
  const expected = crypto.createHmac("sha256", adminTokenSecret()).update(data).digest("base64url");
  if (!safeEqualText(signature, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(data, "base64url").toString("utf8"));
    if (!payload.appid || Number(payload.exp || 0) < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

function legacyAdminAppId() {
  return process.env.ADMIN_APPID || process.env.WECHAT_LEGACY_APP_ID || DEFAULT_LEGACY_APPID;
}

function adminOwnerId(admin = {}) {
  const id = Number(admin.id || 0);
  return admin.role === "agent" && id > 0 ? id : null;
}

function isSuperAdmin(admin = {}) {
  return admin.role !== "agent" || !Number(admin.id || 0);
}

function hasAdminAuth(req) {
  const username = process.env.ADMIN_USERNAME || "";
  const password = process.env.ADMIN_PASSWORD || "";
  const token = (req.headers["x-admin-token"] || "").toString();
  const admin = verifyAdminToken(token);
  if (admin) {
    req.admin = admin;
    return true;
  }
  if (!username || !password) return false;
  const expectedToken = crypto.createHash("sha256").update(`${username}:${password}`).digest("hex");
  if (token && safeEqualText(token, expectedToken)) {
    req.admin = { id: 0, username, appid: legacyAdminAppId(), role: "super" };
    return true;
  }
  const header = req.headers.authorization || "";
  if (!header.startsWith("Basic ")) return false;
  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  const splitAt = decoded.indexOf(":");
  if (splitAt < 0) return false;
  const ok = safeEqualText(decoded.slice(0, splitAt), username) && safeEqualText(decoded.slice(splitAt + 1), password);
  if (ok) {
    req.admin = { id: 0, username, appid: legacyAdminAppId(), role: "super" };
  }
  return ok;
}

function requireAdmin(req, res, isApi = false) {
  if (process.env.NODE_ENV !== "production" && !process.env.ADMIN_PASSWORD) {
    req.admin = { id: 0, username: "dev", appid: legacyAdminAppId(), role: "super" };
    return true;
  }
  if (hasAdminAuth(req)) return true;
  if (isApi) {
    fail(res, 401, "后台需要登录");
    return false;
  }
  res.writeHead(401, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end("后台需要登录");
  return false;
}

function requireMerchant(req, res) {
  const token = (req.headers["x-merchant-token"] || "").toString();
  const merchant = verifyAdminToken(token);
  if (merchant && merchant.appid) {
    req.merchant = merchant;
    return true;
  }
  fail(res, 401, "商家中心需要登录");
  return false;
}

function decodeWechatPayNotification(headers, rawBody) {
  const tenants = paymentTenants();
  for (const tenant of tenants) {
    try {
      if (!verifyWechatpaySignature(headers, rawBody, tenant)) continue;
      const payload = JSON.parse(rawBody || "{}");
      return {
        tenant,
        resource: decryptResource(payload.resource || {}, tenant)
      };
    } catch {
      // Try the next configured payment tenant.
    }
  }
  return null;
}

function serveStatic(req, res, pathname, hostname = "") {
  const isCmsHost = hostname.split(":")[0].toLowerCase() === "mallcms.bhzn.top";
  const routePath = pathname === "/"
    ? (isCmsHost ? "/admin.html" : "/index.html")
    : pathname === "/admin"
      ? "/admin.html"
      : pathname;
  const absolute = path.normalize(path.join(publicDir, decodeURIComponent(routePath)));
  if (!absolute.startsWith(publicDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(absolute, (error, data) => {
    if (error) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }
    const ext = path.extname(absolute).toLowerCase();
    const type = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".webp": "image/webp",
      ".gif": "image/gif",
      ".mp3": "audio/mpeg",
      ".wav": "audio/wav",
      ".ogg": "audio/ogg",
      ".m4a": "audio/mp4",
      ".svg": "image/svg+xml"
    }[ext] || "application/octet-stream";
    const isAdminAsset = isCmsHost && [".html", ".css", ".js"].includes(ext);
    const cache = isAdminAsset
      ? "no-cache"
      : [".css", ".js", ".png", ".jpg", ".jpeg", ".svg"].includes(ext)
      ? "public, max-age=3600"
      : "no-cache";
    res.writeHead(200, {
      "Content-Type": type,
      "Cache-Control": cache,
      "X-Content-Type-Options": "nosniff"
    });
    res.end(data);
  });
}

function createServer({ store }) {
  function requestSessionToken(req) {
    return (req.headers["x-mall-session"] || "").toString();
  }

  async function requireUserSession(req, tenant, userId) {
    await store.requireSessionUser(Number(userId), requestSessionToken(req), tenant.appid);
  }

  async function requireOrderSession(req, tenant, orderId) {
    await store.requireSessionOrder(Number(orderId), requestSessionToken(req), tenant.appid);
  }

  async function handleApi(req, res, pathname, searchParams) {
    if (req.method === "GET" && pathname === "/api/health") {
      await store.ping();
      ok(res, {
        service: "wechat-distribution-mall",
        storage: "mysql",
        time: new Date().toISOString()
      });
      return;
    }

    if (req.method === "GET" && pathname === "/api/app/config") {
      const tenant = resolveTenantFromRequest(req, searchParams);
      const appSettings = await store.settings(undefined, tenant.appid);
      ok(res, {
        ...publicTenant(tenant),
        home_config: appSettings.home_config || null
      });
      return;
    }

    if (req.method === "POST" && pathname === "/api/auth/login") {
      if (process.env.NODE_ENV === "production" && process.env.ENABLE_DEV_LOGIN !== "1") {
        fail(res, 403, "生产环境请使用微信小程序登录");
        return;
      }
      ok(res, await store.login(await readBody(req)));
      return;
    }

    if (req.method === "POST" && pathname === "/api/admin/login") {
      const body = await readBody(req);
      const admin = await store.verifyAdminLogin(body);
      ok(res, {
        token: signAdminToken(admin),
        id: admin.id || 0,
        username: admin.username,
        phone: admin.phone || "",
        display_name: admin.display_name || admin.username,
        role: admin.role || "super",
        appid: admin.appid
      });
      return;
    }

    if (req.method === "POST" && pathname === "/api/merchant/login") {
      const body = await readBody(req);
      const merchant = await store.verifyAdminLogin(body);
      ok(res, {
        token: signAdminToken(merchant),
        id: merchant.id || 0,
        username: merchant.username,
        phone: merchant.phone || "",
        display_name: merchant.display_name || merchant.username,
        role: merchant.role || "agent",
        appid: merchant.appid
      });
      return;
    }

    if (req.method === "GET" && pathname === "/api/merchant/dashboard") {
      ok(res, await store.merchantDashboard(req.merchant));
      return;
    }

    if (req.method === "POST" && pathname === "/api/merchant/uploads") {
      ok(res, await saveUploadRequest(req, req.merchant.appid));
      return;
    }

    if (req.method === "POST" && pathname === "/api/merchant/campaigns") {
      ok(res, await store.createAcquisitionCampaign(await readBody(req), req.merchant));
      return;
    }

    const merchantCampaignId = matchId(pathname, "/api/merchant/campaigns/");
    if (merchantCampaignId) {
      if (req.method === "GET") {
        const userId = Number(searchParams.get("user_id") || 0);
        if (userId) await requireUserSession(req, { appid: req.merchant.appid }, userId);
        ok(res, await store.merchantCampaignData(merchantCampaignId, req.merchant, { userId }));
        return;
      }
      if (req.method === "PUT") {
        ok(res, await store.updateAcquisitionCampaign(merchantCampaignId, await readBody(req), req.merchant));
        return;
      }
      if (req.method === "DELETE") {
        ok(res, await store.deleteAcquisitionCampaign(merchantCampaignId, req.merchant));
        return;
      }
    }

    if (req.method === "POST" && pathname === "/api/wechat/login") {
      const body = await readBody(req);
      const tenant = resolveTenantFromRequest(req, searchParams, body);
      const session = await codeToSession(body.code, tenant);
      ok(res, await store.wechatLogin({
        appid: tenant.appid,
        openid: session.openid,
        unionid: session.unionid || "",
        sessionKey: session.session_key || "",
        scene: body.scene || body.parent_id || "",
        userInfo: body.userInfo || null
      }, tenant.appid));
      return;
    }

    if (req.method === "GET" && pathname === "/api/me") {
      const tenant = resolveTenantFromRequest(req, searchParams);
      await requireUserSession(req, tenant, searchParams.get("user_id"));
      ok(res, await store.getUser(Number(searchParams.get("user_id")), undefined, tenant.appid));
      return;
    }

    if (req.method === "PATCH" && pathname === "/api/me/profile") {
      const body = await readBody(req, 8 * 1024 * 1024);
      const tenant = resolveTenantFromRequest(req, searchParams, body);
      await requireUserSession(req, tenant, body.user_id);
      let avatar = body.avatar || body.avatar_url || "";
      if (body.avatar_data_url) {
        const uploaded = await saveUserAvatarUpload({ data_url: body.avatar_data_url }, tenant.appid);
        avatar = uploaded.url;
      }
      ok(res, await store.updateUserProfile({
        ...body,
        avatar,
        session_token: (req.headers["x-mall-session"] || "").toString()
      }, tenant.appid));
      return;
    }

    if (req.method === "GET" && pathname === "/api/user/addresses") {
      const tenant = resolveTenantFromRequest(req, searchParams);
      await requireUserSession(req, tenant, searchParams.get("user_id"));
      ok(res, await store.listUserAddresses(Number(searchParams.get("user_id")), undefined, tenant.appid));
      return;
    }

    if (req.method === "POST" && pathname === "/api/user/addresses") {
      const body = await readBody(req);
      const tenant = resolveTenantFromRequest(req, searchParams, body);
      await requireUserSession(req, tenant, body.user_id);
      ok(res, await store.saveUserAddress(body, tenant.appid));
      return;
    }

    const userAddressId = matchId(pathname, "/api/user/addresses/");
    if (req.method === "PUT" && userAddressId) {
      const body = await readBody(req);
      const tenant = resolveTenantFromRequest(req, searchParams, body);
      await requireUserSession(req, tenant, body.user_id);
      ok(res, await store.saveUserAddress({ ...body, id: userAddressId }, tenant.appid));
      return;
    }

    if (req.method === "PATCH" && pathname === "/api/me/inviter") {
      const body = await readBody(req);
      const tenant = resolveTenantFromRequest(req, searchParams, body);
      await requireUserSession(req, tenant, body.user_id);
      ok(res, await store.bindInviter(body, tenant.appid));
      return;
    }

    if (req.method === "POST" && pathname === "/api/distribution/apply") {
      const body = await readBody(req);
      const tenant = resolveTenantFromRequest(req, searchParams, body);
      await requireUserSession(req, tenant, body.user_id);
      ok(res, await store.applyDistributor(body, tenant.appid));
      return;
    }

    if (req.method === "GET" && pathname === "/api/products") {
      const tenant = resolveTenantFromRequest(req, searchParams);
      ok(res, await store.listPublicProducts({
        category: searchParams.get("category") || "全部",
        keyword: searchParams.get("keyword") || "",
        appid: tenant.appid
      }));
      return;
    }

    const productId = matchId(pathname, "/api/products/");
    if (req.method === "GET" && productId) {
      const tenant = resolveTenantFromRequest(req, searchParams);
      ok(res, await store.getPublicProduct(productId, undefined, tenant.appid));
      return;
    }

    if (req.method === "GET" && pathname === "/api/acquisition/campaigns") {
      const tenant = resolveTenantFromRequest(req, searchParams);
      ok(res, await store.listPublicAcquisitionCampaigns({
        keyword: searchParams.get("keyword") || "",
        appid: tenant.appid
      }));
      return;
    }

    if (req.method === "GET" && pathname === "/api/acquisition/active") {
      const tenant = resolveTenantFromRequest(req, searchParams);
      if (searchParams.get("user_id")) await requireUserSession(req, tenant, searchParams.get("user_id"));
      ok(res, await store.getActiveAcquisitionCampaign(
        Number(searchParams.get("user_id")) || null,
        searchParams.get("scene") || "",
        tenant.appid
      ));
      return;
    }

    const publicAcquisitionId = matchId(pathname, "/api/acquisition/campaigns/");
    if (req.method === "GET" && publicAcquisitionId && pathname === `/api/acquisition/campaigns/${publicAcquisitionId}/invite-poster`) {
      const tenant = resolveTenantFromRequest(req, searchParams);
      await requireUserSession(req, tenant, searchParams.get("user_id"));
      ok(res, await store.campaignInvitePoster({
        campaignId: publicAcquisitionId,
        userId: Number(searchParams.get("user_id")),
        envVersion: searchParams.get("env_version") || "release"
      }, tenant));
      return;
    }

    if (req.method === "GET" && publicAcquisitionId) {
      const tenant = resolveTenantFromRequest(req, searchParams);
      if (searchParams.get("user_id")) await requireUserSession(req, tenant, searchParams.get("user_id"));
      ok(res, await store.getPublicAcquisitionCampaign(
        publicAcquisitionId,
        Number(searchParams.get("user_id")) || null,
        searchParams.get("scene") || "",
        tenant.appid
      ));
      return;
    }

    if (req.method === "POST" && pathname === "/api/orders") {
      const body = await readBody(req);
      const tenant = resolveTenantFromRequest(req, searchParams, body);
      await requireUserSession(req, tenant, body.user_id);
      ok(res, await store.createOrder(body, tenant));
      return;
    }

    if (req.method === "GET" && pathname === "/api/orders") {
      const tenant = resolveTenantFromRequest(req, searchParams);
      await requireUserSession(req, tenant, searchParams.get("user_id"));
      ok(res, await store.listOrders({ userId: Number(searchParams.get("user_id")) || null, appid: tenant.appid }));
      return;
    }

    if (req.method === "GET" && pathname === "/api/lottery/records") {
      const tenant = resolveTenantFromRequest(req, searchParams);
      await requireUserSession(req, tenant, searchParams.get("user_id"));
      ok(res, await store.userLotteryRecords(Number(searchParams.get("user_id")) || 0, tenant.appid));
      return;
    }
    const orderId = matchId(pathname, "/api/orders/");
    if (req.method === "POST" && orderId && pathname.endsWith("/pay/sync")) {
      const tenant = resolveTenantFromRequest(req, searchParams);
      await requireOrderSession(req, tenant, orderId);
      ok(res, await store.syncWechatPayment(orderId, tenant));
      return;
    }

    if (req.method === "POST" && orderId && pathname.endsWith("/close")) {
      const tenant = resolveTenantFromRequest(req, searchParams);
      await requireOrderSession(req, tenant, orderId);
      ok(res, await store.closeUnpaidOrder(orderId, tenant.appid));
      return;
    }

    if (req.method === "POST" && orderId && pathname.endsWith("/confirm")) {
      const tenant = resolveTenantFromRequest(req, searchParams);
      await requireOrderSession(req, tenant, orderId);
      ok(res, await store.confirmOrder(orderId, tenant.appid));
      return;
    }

    if (req.method === "POST" && pathname === "/api/pay/wechat/notify") {
      const rawBody = await readRawBody(req);
      const decoded = decodeWechatPayNotification(req.headers, rawBody);
      if (!decoded) {
        send(res, 401, { code: "FAIL", message: "签名验证失败" });
        return;
      }
      await store.handleWechatPayNotification(decoded.resource);
      send(res, 200, { code: "SUCCESS", message: "成功" });
      return;
    }

    if (req.method === "GET" && pathname === "/api/distribution/summary") {
      const tenant = resolveTenantFromRequest(req, searchParams);
      await requireUserSession(req, tenant, searchParams.get("user_id"));
      ok(res, await store.distributionSummary(Number(searchParams.get("user_id")), tenant.appid));
      return;
    }

    if (req.method === "POST" && pathname === "/api/withdrawals") {
      const body = await readBody(req);
      const tenant = resolveTenantFromRequest(req, searchParams, body);
      await requireUserSession(req, tenant, body.user_id);
      ok(res, await store.createWithdrawal(body, tenant.appid));
      return;
    }

    if (req.method === "GET" && pathname === "/api/share-poster") {
      const tenant = resolveTenantFromRequest(req, searchParams);
      await requireUserSession(req, tenant, searchParams.get("user_id"));
      ok(res, await store.sharePoster({
        userId: Number(searchParams.get("user_id")),
        productId: Number(searchParams.get("product_id")),
        envVersion: searchParams.get("env_version") || "release"
      }, tenant));
      return;
    }

    if (req.method === "GET" && pathname === "/api/screen/dashboard") {
      const tenant = resolveTenantFromRequest(req, searchParams);
      ok(res, await store.screenDashboard(tenant.appid));
      return;
    }

    if (req.method === "POST" && pathname === "/api/screen/heartbeat") {
      const body = await readBody(req);
      const tenant = resolveTenantFromRequest(req, searchParams, body);
      await requireUserSession(req, tenant, body.user_id);
      ok(res, await store.screenHeartbeat(body, tenant.appid));
      return;
    }

    if (req.method === "GET" && pathname === "/api/admin/dashboard") {
      ok(res, {
        ...(await store.dashboard(req.admin.appid)),
        appid: req.admin.appid
      });
      return;
    }

    if (req.method === "POST" && pathname === "/api/admin/uploads") {
      ok(res, await saveUploadRequest(req, req.admin.appid));
      return;
    }

    if (req.method === "GET" && pathname === "/api/admin/agents") {
      ok(res, await store.listAgentAdmins(req.admin));
      return;
    }

    if (req.method === "POST" && pathname === "/api/admin/agents") {
      ok(res, await store.saveAgentAdmin(await readBody(req), req.admin));
      return;
    }

    const adminAgentId = matchId(pathname, "/api/admin/agents/");
    if (req.method === "PUT" && adminAgentId) {
      ok(res, await store.saveAgentAdmin({ ...(await readBody(req)), id: adminAgentId }, req.admin));
      return;
    }
    if (req.method === "DELETE" && adminAgentId) {
      ok(res, await store.deleteAgentAdmin(adminAgentId, req.admin));
      return;
    }

    if (req.method === "GET" && pathname === "/api/admin/products") {
      ok(res, await store.listAdminProducts(req.admin.appid));
      return;
    }

    if (req.method === "POST" && pathname === "/api/admin/products") {
      ok(res, await store.createProduct(await readBody(req), req.admin.appid));
      return;
    }

    const adminProductId = matchId(pathname, "/api/admin/products/");
    if (req.method === "PUT" && adminProductId) {
      ok(res, await store.updateProduct(adminProductId, await readBody(req), req.admin.appid));
      return;
    }
    if (req.method === "DELETE" && adminProductId) {
      ok(res, await store.deleteProduct(adminProductId, req.admin.appid));
      return;
    }

    if (req.method === "GET" && pathname === "/api/admin/acquisition/campaigns") {
      ok(res, await store.listAcquisitionCampaigns({
        status: searchParams.get("status") || "",
        keyword: searchParams.get("keyword") || "",
        appid: req.admin.appid,
        ownerAdminId: adminOwnerId(req.admin)
      }));
      return;
    }

    if (req.method === "POST" && pathname === "/api/admin/acquisition/campaigns") {
      ok(res, await store.createAcquisitionCampaign(await readBody(req), req.admin));
      return;
    }

    if (req.method === "GET" && pathname === "/api/admin/acquisition/materials") {
      ok(res, await store.listAcquisitionMaterials(req.admin.appid));
      return;
    }

    if (req.method === "POST" && pathname === "/api/admin/acquisition/materials") {
      ok(res, await store.saveAcquisitionMaterial(await readBody(req), req.admin.appid));
      return;
    }

    const materialId = matchId(pathname, "/api/admin/acquisition/materials/");
    if (req.method === "DELETE" && materialId) {
      ok(res, await store.deleteAcquisitionMaterial(materialId, req.admin.appid));
      return;
    }

    const acquisitionId = matchId(pathname, "/api/admin/acquisition/campaigns/");
    if (acquisitionId) {
      if (req.method === "GET" && pathname === `/api/admin/acquisition/campaigns/${acquisitionId}`) {
        ok(res, await store.getAcquisitionCampaign(acquisitionId, undefined, req.admin));
        return;
      }
      if (req.method === "PUT" && pathname === `/api/admin/acquisition/campaigns/${acquisitionId}`) {
        ok(res, await store.updateAcquisitionCampaign(acquisitionId, await readBody(req), req.admin));
        return;
      }
      if (req.method === "PATCH" && pathname === `/api/admin/acquisition/campaigns/${acquisitionId}`) {
        ok(res, await store.patchAcquisitionCampaign(acquisitionId, await readBody(req), req.admin));
        return;
      }
      if (req.method === "DELETE" && pathname === `/api/admin/acquisition/campaigns/${acquisitionId}`) {
        ok(res, await store.deleteAcquisitionCampaign(acquisitionId, req.admin));
        return;
      }
      if (req.method === "POST" && pathname === `/api/admin/acquisition/campaigns/${acquisitionId}/qrcodes`) {
        ok(res, await store.saveAcquisitionQrcode(acquisitionId, await readBody(req), req.admin));
        return;
      }
      const qrcodePrefix = `/api/admin/acquisition/campaigns/${acquisitionId}/qrcodes/`;
      const qrcodeId = matchId(pathname, qrcodePrefix);
      if (req.method === "DELETE" && qrcodeId) {
        ok(res, await store.deleteAcquisitionQrcode(acquisitionId, qrcodeId, req.admin));
        return;
      }
      if (req.method === "GET" && pathname === `/api/admin/acquisition/campaigns/${acquisitionId}/relations`) {
        ok(res, await store.listAcquisitionRelations(acquisitionId, req.admin));
        return;
      }
      if (req.method === "GET" && pathname === `/api/admin/acquisition/campaigns/${acquisitionId}/orders`) {
        ok(res, await store.listAcquisitionOrders(acquisitionId, req.admin));
        return;
      }
      if (req.method === "GET" && pathname === `/api/admin/acquisition/campaigns/${acquisitionId}/rewards`) {
        ok(res, await store.listAcquisitionRewards(acquisitionId, req.admin));
        return;
      }
      if (req.method === "GET" && pathname === `/api/admin/acquisition/campaigns/${acquisitionId}/dashboard`) {
        ok(res, await store.acquisitionDashboard(acquisitionId, req.admin));
        return;
      }
    }

    if (req.method === "GET" && pathname === "/api/admin/orders") {
      ok(res, await store.listOrders({ userId: null, appid: req.admin.appid, ownerAdminId: adminOwnerId(req.admin) }));
      return;
    }

    const adminOrderId = matchId(pathname, "/api/admin/orders/");
    if (req.method === "PATCH" && adminOrderId) {
      ok(res, await store.patchOrder(adminOrderId, await readBody(req), req.admin.appid));
      return;
    }

    if (req.method === "GET" && pathname === "/api/admin/distributors") {
      ok(res, await store.listDistributors(req.admin.appid));
      return;
    }

    if (req.method === "GET" && pathname === "/api/admin/users") {
      ok(res, await store.listUsers({
        appid: req.admin.appid,
        keyword: searchParams.get("keyword") || "",
        distributorStatus: searchParams.get("distributor_status") || "",
        page: searchParams.get("page") || 1,
        pageSize: searchParams.get("page_size") || 30
      }));
      return;
    }

    const distributorId = matchId(pathname, "/api/admin/distributors/");
    if (req.method === "PATCH" && distributorId) {
      ok(res, await store.patchDistributor(distributorId, await readBody(req), req.admin.appid));
      return;
    }

    if (req.method === "GET" && pathname === "/api/admin/commissions") {
      ok(res, await store.listCommissions({ appid: req.admin.appid, ownerAdminId: adminOwnerId(req.admin) }));
      return;
    }

    if (req.method === "GET" && pathname === "/api/admin/withdrawals") {
      if (!isSuperAdmin(req.admin)) {
        fail(res, 403, "只有总管理员可以查看提现申请");
        return;
      }
      ok(res, await store.listWithdrawals(req.admin.appid));
      return;
    }

    const withdrawalId = matchId(pathname, "/api/admin/withdrawals/");
    if (req.method === "PATCH" && withdrawalId) {
      if (!isSuperAdmin(req.admin)) {
        fail(res, 403, "只有总管理员可以处理提现申请");
        return;
      }
      ok(res, await store.patchWithdrawal(withdrawalId, await readBody(req), req.admin.appid));
      return;
    }

    if (req.method === "GET" && pathname === "/api/admin/settings") {
      ok(res, await store.settings(undefined, req.admin.appid));
      return;
    }

    if (req.method === "PUT" && pathname === "/api/admin/settings") {
      ok(res, await store.updateSettings(await readBody(req), req.admin.appid));
      return;
    }

    fail(res, 404, "接口不存在");
  }

  return http.createServer(async (req, res) => {
    const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    try {
      if (requestUrl.pathname.startsWith("/api/admin/") && requestUrl.pathname !== "/api/admin/login" && !requireAdmin(req, res, true)) {
        return;
      }
      if (requestUrl.pathname.startsWith("/api/merchant/") && requestUrl.pathname !== "/api/merchant/login" && !requireMerchant(req, res)) {
        return;
      }
      if (requestUrl.pathname.startsWith("/api/")) {
        await handleApi(req, res, requestUrl.pathname, requestUrl.searchParams);
        return;
      }
      serveStatic(req, res, requestUrl.pathname, req.headers.host || "");
    } catch (error) {
      const status = error.statusCode || error.status || 500;
      fail(res, status, status >= 500 ? "服务异常" : error.message, status >= 500 ? undefined : error.details);
      if (status >= 500) console.error(error);
    }
  });
}

module.exports = { createServer };
