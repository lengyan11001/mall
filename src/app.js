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

async function saveAdminUpload(body = {}, appid = "") {
  const raw = String(body.data_url || body.data || "");
  const match = raw.match(/^data:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\r\n]+)$/i);
  if (!match) {
    const error = new Error("上传文件格式不正确");
    error.statusCode = 422;
    throw error;
  }
  const mime = match[1].toLowerCase().replace("image/jpg", "image/jpeg");
  const allowed = {
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
  const rule = allowed[mime];
  if (!rule) {
    const error = new Error("只支持上传 PNG、JPG、WebP、GIF 图片或 MP3、WAV、OGG、M4A 音频");
    error.statusCode = 422;
    throw error;
  }
  const buffer = Buffer.from(match[2].replace(/\s/g, ""), "base64");
  const maxSize = Number(process.env.ADMIN_UPLOAD_MAX_BYTES || rule.max);
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
    req.admin = { username, appid: legacyAdminAppId() };
    return true;
  }
  const header = req.headers.authorization || "";
  if (!header.startsWith("Basic ")) return false;
  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  const splitAt = decoded.indexOf(":");
  if (splitAt < 0) return false;
  const ok = safeEqualText(decoded.slice(0, splitAt), username) && safeEqualText(decoded.slice(splitAt + 1), password);
  if (ok) {
    req.admin = { username, appid: legacyAdminAppId() };
  }
  return ok;
}

function requireAdmin(req, res, isApi = false) {
  if (process.env.NODE_ENV !== "production" && !process.env.ADMIN_PASSWORD) {
    req.admin = { username: "dev", appid: legacyAdminAppId() };
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
      ok(res, publicTenant(resolveTenantFromRequest(req, searchParams)));
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
        username: admin.username,
        appid: admin.appid
      });
      return;
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
      ok(res, await store.getUser(Number(searchParams.get("user_id")), undefined, tenant.appid));
      return;
    }

    if (req.method === "GET" && pathname === "/api/user/addresses") {
      const tenant = resolveTenantFromRequest(req, searchParams);
      ok(res, await store.listUserAddresses(Number(searchParams.get("user_id")), undefined, tenant.appid));
      return;
    }

    if (req.method === "POST" && pathname === "/api/user/addresses") {
      const body = await readBody(req);
      const tenant = resolveTenantFromRequest(req, searchParams, body);
      ok(res, await store.saveUserAddress(body, tenant.appid));
      return;
    }

    const userAddressId = matchId(pathname, "/api/user/addresses/");
    if (req.method === "PUT" && userAddressId) {
      const body = await readBody(req);
      const tenant = resolveTenantFromRequest(req, searchParams, body);
      ok(res, await store.saveUserAddress({ ...body, id: userAddressId }, tenant.appid));
      return;
    }

    if (req.method === "PATCH" && pathname === "/api/me/inviter") {
      const body = await readBody(req);
      const tenant = resolveTenantFromRequest(req, searchParams, body);
      ok(res, await store.bindInviter(body, tenant.appid));
      return;
    }

    if (req.method === "POST" && pathname === "/api/distribution/apply") {
      const body = await readBody(req);
      const tenant = resolveTenantFromRequest(req, searchParams, body);
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
      ok(res, await store.campaignInvitePoster({
        campaignId: publicAcquisitionId,
        userId: Number(searchParams.get("user_id"))
      }, tenant));
      return;
    }

    if (req.method === "GET" && publicAcquisitionId) {
      const tenant = resolveTenantFromRequest(req, searchParams);
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
      ok(res, await store.createOrder(body, tenant));
      return;
    }

    if (req.method === "GET" && pathname === "/api/orders") {
      const tenant = resolveTenantFromRequest(req, searchParams);
      ok(res, await store.listOrders({ userId: Number(searchParams.get("user_id")) || null, appid: tenant.appid }));
      return;
    }

    const orderId = matchId(pathname, "/api/orders/");
    if (req.method === "POST" && orderId && pathname.endsWith("/pay/sync")) {
      const tenant = resolveTenantFromRequest(req, searchParams);
      ok(res, await store.syncWechatPayment(orderId, tenant));
      return;
    }

    if (req.method === "POST" && orderId && pathname.endsWith("/close")) {
      const tenant = resolveTenantFromRequest(req, searchParams);
      ok(res, await store.closeUnpaidOrder(orderId, tenant.appid));
      return;
    }

    if (req.method === "POST" && orderId && pathname.endsWith("/confirm")) {
      const tenant = resolveTenantFromRequest(req, searchParams);
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
      ok(res, await store.distributionSummary(Number(searchParams.get("user_id")), tenant.appid));
      return;
    }

    if (req.method === "POST" && pathname === "/api/withdrawals") {
      const body = await readBody(req);
      const tenant = resolveTenantFromRequest(req, searchParams, body);
      ok(res, await store.createWithdrawal(body, tenant.appid));
      return;
    }

    if (req.method === "GET" && pathname === "/api/share-poster") {
      const tenant = resolveTenantFromRequest(req, searchParams);
      ok(res, await store.sharePoster({
        userId: Number(searchParams.get("user_id")),
        productId: Number(searchParams.get("product_id"))
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
      ok(res, await store.screenHeartbeat(body, tenant.appid));
      return;
    }

    if (req.method === "GET" && pathname === "/api/admin/dashboard") {
      ok(res, await store.dashboard(req.admin.appid));
      return;
    }

    if (req.method === "POST" && pathname === "/api/admin/uploads") {
      const uploadBodyLimit = Number(process.env.ADMIN_UPLOAD_BODY_MAX_BYTES || 32 * 1024 * 1024);
      ok(res, await saveAdminUpload(await readBody(req, uploadBodyLimit), req.admin.appid));
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

    if (req.method === "GET" && pathname === "/api/admin/acquisition/campaigns") {
      ok(res, await store.listAcquisitionCampaigns({
        status: searchParams.get("status") || "",
        keyword: searchParams.get("keyword") || "",
        appid: req.admin.appid
      }));
      return;
    }

    if (req.method === "POST" && pathname === "/api/admin/acquisition/campaigns") {
      ok(res, await store.createAcquisitionCampaign(await readBody(req), req.admin.appid));
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

    const acquisitionId = matchId(pathname, "/api/admin/acquisition/campaigns/");
    if (acquisitionId) {
      if (req.method === "GET" && pathname === `/api/admin/acquisition/campaigns/${acquisitionId}`) {
        ok(res, await store.getAcquisitionCampaign(acquisitionId, undefined, req.admin.appid));
        return;
      }
      if (req.method === "PUT" && pathname === `/api/admin/acquisition/campaigns/${acquisitionId}`) {
        ok(res, await store.updateAcquisitionCampaign(acquisitionId, await readBody(req), req.admin.appid));
        return;
      }
      if (req.method === "PATCH" && pathname === `/api/admin/acquisition/campaigns/${acquisitionId}`) {
        ok(res, await store.patchAcquisitionCampaign(acquisitionId, await readBody(req), req.admin.appid));
        return;
      }
      if (req.method === "POST" && pathname === `/api/admin/acquisition/campaigns/${acquisitionId}/qrcodes`) {
        ok(res, await store.saveAcquisitionQrcode(acquisitionId, await readBody(req), req.admin.appid));
        return;
      }
      const qrcodePrefix = `/api/admin/acquisition/campaigns/${acquisitionId}/qrcodes/`;
      const qrcodeId = matchId(pathname, qrcodePrefix);
      if (req.method === "DELETE" && qrcodeId) {
        ok(res, await store.deleteAcquisitionQrcode(acquisitionId, qrcodeId, req.admin.appid));
        return;
      }
      if (req.method === "GET" && pathname === `/api/admin/acquisition/campaigns/${acquisitionId}/relations`) {
        ok(res, await store.listAcquisitionRelations(acquisitionId, req.admin.appid));
        return;
      }
      if (req.method === "GET" && pathname === `/api/admin/acquisition/campaigns/${acquisitionId}/orders`) {
        ok(res, await store.listAcquisitionOrders(acquisitionId, req.admin.appid));
        return;
      }
      if (req.method === "GET" && pathname === `/api/admin/acquisition/campaigns/${acquisitionId}/rewards`) {
        ok(res, await store.listAcquisitionRewards(acquisitionId, req.admin.appid));
        return;
      }
      if (req.method === "GET" && pathname === `/api/admin/acquisition/campaigns/${acquisitionId}/dashboard`) {
        ok(res, await store.acquisitionDashboard(acquisitionId, req.admin.appid));
        return;
      }
    }

    if (req.method === "GET" && pathname === "/api/admin/orders") {
      ok(res, await store.listOrders({ userId: null, appid: req.admin.appid }));
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

    const distributorId = matchId(pathname, "/api/admin/distributors/");
    if (req.method === "PATCH" && distributorId) {
      ok(res, await store.patchDistributor(distributorId, await readBody(req), req.admin.appid));
      return;
    }

    if (req.method === "GET" && pathname === "/api/admin/commissions") {
      ok(res, await store.listCommissions({ appid: req.admin.appid }));
      return;
    }

    if (req.method === "GET" && pathname === "/api/admin/withdrawals") {
      ok(res, await store.listWithdrawals(req.admin.appid));
      return;
    }

    const withdrawalId = matchId(pathname, "/api/admin/withdrawals/");
    if (req.method === "PATCH" && withdrawalId) {
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
