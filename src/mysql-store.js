const mysql = require("mysql2/promise");
const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const { appError } = require("./errors");
const { getUnlimitedQRCode, uploadShippingInfo } = require("./wechat");
const {
  createJsapiPrepay,
  jsapiPayParams,
  queryOrder,
  yuanToFen
} = require("./wechat-pay");
const {
  buildInvitePoster,
  buildProductPoster,
  inviteAssetPaths,
  normalizeAssetEnvVersion,
  parseCampaignInviteScene,
  parseProductInviteScene,
  productAssetPaths
} = require("./invite-assets");
const { defaultAppId, resolveTenant } = require("./tenant-config");
const {
  addressRow,
  campaignRow,
  commissionRow,
  materialRow,
  money,
  orderRow,
  publicProduct,
  qrcodeRow,
  statusText
} = require("./format");

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function resolveConnectionLimit(override) {
  const perWorker = positiveInteger(process.env.DB_CONNECTION_LIMIT_PER_WORKER, 0);
  if (perWorker) return perWorker;
  if (override) return positiveInteger(override, 40);

  const configuredLimit = positiveInteger(process.env.DB_CONNECTION_LIMIT, 40);
  const totalLimit = positiveInteger(process.env.DB_TOTAL_CONNECTION_LIMIT, configuredLimit);
  const workers = positiveInteger(process.env.MALL_CLUSTER_WORKERS, 1);
  if (workers <= 1) return configuredLimit;

  return Math.max(2, Math.floor(totalLimit / workers));
}

function dbConfig({ withoutDatabase = false, connectionLimit = 0 } = {}) {
  const config = {
    host: process.env.DB_HOST || "127.0.0.1",
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || "mall",
    password: process.env.DB_PASSWORD || "",
    waitForConnections: true,
    connectionLimit: resolveConnectionLimit(connectionLimit),
    queueLimit: 0,
    charset: "utf8mb4",
    decimalNumbers: true,
    timezone: "Z",
    namedPlaceholders: true,
    multipleStatements: false
  };
  if (!withoutDatabase) {
    config.database = process.env.DB_NAME || "mall";
  }
  return config;
}

function createPool(options) {
  return mysql.createPool(dbConfig(options));
}

function assertId(id, label = "ID") {
  const normalized = Number(id);
  if (!Number.isInteger(normalized) || normalized <= 0) {
    throw appError(422, `${label} 不正确`);
  }
  return normalized;
}

async function one(conn, sql, params = {}) {
  const [rows] = await conn.query(sql, params);
  return rows[0] || null;
}

async function many(conn, sql, params = {}) {
  const [rows] = await conn.query(sql, params);
  return rows;
}

async function tx(pool, fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

function normalizeUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    appid: row.appid || "",
    openid: row.openid,
    phone: row.phone || "",
    nickname: row.nickname,
    avatar: row.avatar || "",
    parent_id: row.parent_id,
    first_parent_id: row.first_parent_id || row.parent_id || null,
    distributor_status: row.distributor_status,
    created_at: row.created_at
  };
}

function normalizeAppId(appid) {
  return String(appid || defaultAppId()).trim();
}

function withdrawalLocksBalance(status) {
  return ["pending", "approved", "paidout"].includes(String(status || ""));
}

function defaultHomeConfig() {
  return {
    hero: {
      kicker: "潮玩周边商城",
      title: "门店想要裂变效果好",
      highlight: "就用 非常好裂变",
      subtitle: "精选手办、盲盒、二次元周边，现货好物每日更新。",
      image_url: "",
      action_text: "逛商品",
      action_path: "/pages/home/index"
    },
    entries: [
      { title: "拓客宝", image_url: "", path: "/pages/store/index" },
      { title: "行业方案", image_url: "", path: "/pages/store/index" },
      { title: "经典案例", image_url: "", path: "/pages/store/index" },
      { title: "私域课堂", image_url: "", path: "/pages/store/index" },
      { title: "私域导师", image_url: "", path: "/pages/store/index" },
      { title: "引流产品", image_url: "", path: "/pages/store/index" }
    ],
    product_section: {
      kicker: "商品中心",
      title: "精选商品",
      subtitle: "普通商品在这里展示，拓客活动进入商家中心查看。"
    }
  };
}

function normalizeHomeEntry(item = {}) {
  return {
    title: cleanText(item.title, "", 16),
    image_url: cleanText(item.image_url, "", 600),
    path: cleanText(item.path, "/pages/home/index", 180) || "/pages/home/index"
  };
}

function normalizeHomeConfig(value) {
  const defaults = defaultHomeConfig();
  const source = value && typeof value === "object" ? value : {};
  const hero = source.hero && typeof source.hero === "object" ? source.hero : {};
  const productSection = source.product_section && typeof source.product_section === "object" ? source.product_section : {};
  const entries = Array.isArray(source.entries)
    ? source.entries.map(normalizeHomeEntry).filter(item => item.title).slice(0, 12)
    : defaults.entries;
  return {
    hero: {
      kicker: cleanText(hero.kicker, defaults.hero.kicker, 24),
      title: cleanText(hero.title, defaults.hero.title, 40),
      highlight: cleanText(hero.highlight, defaults.hero.highlight, 40),
      subtitle: cleanText(hero.subtitle, defaults.hero.subtitle, 100),
      image_url: cleanText(hero.image_url, defaults.hero.image_url, 600),
      action_text: cleanText(hero.action_text, defaults.hero.action_text, 16),
      action_path: cleanText(hero.action_path, defaults.hero.action_path, 180)
    },
    entries: entries.length ? entries : defaults.entries,
    product_section: {
      kicker: cleanText(productSection.kicker, defaults.product_section.kicker, 24),
      title: cleanText(productSection.title, defaults.product_section.title, 32),
      subtitle: cleanText(productSection.subtitle, defaults.product_section.subtitle, 100)
    }
  };
}

function normalizeSettings(row) {
  return {
    commission_level_1: Number(row.commission_level_1),
    commission_level_2: Number(row.commission_level_2),
    min_withdrawal: Number(row.min_withdrawal),
    compliance_name: row.compliance_name,
    auto_pay_enabled: Boolean(row.auto_pay_enabled),
    screen_audio_url: row.screen_audio_url || "",
    home_config: normalizeHomeConfig(parseDbJson(row.home_config, null))
  };
}

function displayNameFromOpenid(openid) {
  return `WxUser${String(openid || "").slice(-6).toUpperCase()}`;
}

function avatarFromName(name) {
  return Array.from(name || "WX").slice(0, 2).join("").toUpperCase();
}

function newSessionToken() {
  return crypto.randomBytes(32).toString("hex");
}

function hashAdminPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.pbkdf2Sync(String(password || ""), salt, 120000, 32, "sha256").toString("hex");
  return `pbkdf2_sha256$120000$${salt}$${hash}`;
}

function verifyAdminPassword(password, storedHash = "") {
  const legacy = String(storedHash || "");
  if (legacy.startsWith("pbkdf2_sha256$")) {
    const [, iterations, salt, hash] = legacy.split("$");
    const computed = crypto.pbkdf2Sync(String(password || ""), salt, Number(iterations || 120000), 32, "sha256").toString("hex");
    const left = Buffer.from(computed);
    const right = Buffer.from(hash || "");
    return left.length === right.length && crypto.timingSafeEqual(left, right);
  }
  return legacy && legacy === crypto.createHash("sha256").update(String(password || "")).digest("hex");
}

function boolFlag(value) {
  if (typeof value === "string") return ["1", "true", "on", "yes"].includes(value.toLowerCase()) ? 1 : 0;
  return value ? 1 : 0;
}

function parseDbJson(value, fallback) {
  if (value == null || value === "") return fallback;
  if (Array.isArray(value) || typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function jsonField(value, fallback) {
  const normalized = value === undefined ? fallback : value;
  if (normalized === undefined || normalized === null) return null;
  return JSON.stringify(normalized);
}

function mysqlDate(value, fallback = null) {
  const source = value || fallback;
  if (!source) return null;
  const date = new Date(source);
  if (Number.isNaN(date.getTime())) throw appError(422, "时间格式不正确");
  return date.toISOString().slice(0, 19).replace("T", " ");
}

function enumValue(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function cleanText(value, fallback = "", max = 255) {
  return String(value ?? fallback).trim().slice(0, max);
}

function adminUserRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    appid: normalizeAppId(row.appid),
    username: row.username,
    phone: row.phone || "",
    display_name: row.display_name || row.username,
    role: row.role || "super",
    parent_admin_id: row.parent_admin_id || null,
    status: row.status || "active",
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function normalizeAdminScope(adminOrAppid = "") {
  if (adminOrAppid && typeof adminOrAppid === "object") {
    const adminId = Number(adminOrAppid.id || adminOrAppid.admin_id || 0);
    const role = adminOrAppid.role || (adminId ? "agent" : "super");
    return {
      appid: normalizeAppId(adminOrAppid.appid),
      adminId,
      role,
      ownerAdminId: role === "agent" && adminId > 0 ? adminId : null,
      isSuper: role !== "agent" || !adminId
    };
  }
  return {
    appid: normalizeAppId(adminOrAppid),
    adminId: 0,
    role: "super",
    ownerAdminId: null,
    isSuper: true
  };
}

function assertSuperAdmin(adminOrAppid) {
  const scope = normalizeAdminScope(adminOrAppid);
  if (!scope.isSuper) throw appError(403, "只有总后台账号可以管理代理商");
  return scope;
}

function positiveInt(value, fallback = 0, max = Number.MAX_SAFE_INTEGER) {
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.min(number, max);
}

function unpaidOrderTtlMinutes() {
  return positiveInt(process.env.UNPAID_ORDER_TTL_MINUTES, 15, 120);
}

function orderExpiresAt() {
  return new Date(Date.now() + unpaidOrderTtlMinutes() * 60 * 1000);
}

function mysqlDateFromDate(date) {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

function publicListLimit(value, fallback = 100, max = 300) {
  return positiveInt(value, fallback, max);
}

function publicOffset(page = 1, pageSize = 100) {
  const normalizedPage = positiveInt(page, 1, 100000);
  return (normalizedPage - 1) * pageSize;
}

function heartbeatSessionKey(body) {
  const userId = assertId(body.user_id, "用户 ID");
  const campaignId = Number(body.campaign_id || 0);
  const productId = Number(body.product_id || 0);
  const page = cleanText(body.page, "page", 40) || "page";
  const scene = cleanText(body.scene, "", 64);
  const raw = [
    userId,
    page,
    Number.isInteger(campaignId) && campaignId > 0 ? campaignId : 0,
    Number.isInteger(productId) && productId > 0 ? productId : 0,
    scene
  ].join(":");
  return crypto.createHash("sha1").update(raw).digest("hex");
}

function imageList(body, fallback = []) {
  if (Array.isArray(body.images)) return body.images.map(item => cleanText(item, "", 600)).filter(Boolean);
  const single = cleanText(body.image || body.image_url || "", "", 600);
  if (single) return [single];
  return fallback;
}

function productPayload(body, existing = {}) {
  const images = imageList(body, parseDbJson(existing.images_json, existing.image_url ? [existing.image_url] : []));
  const price = body.price !== undefined ? money(body.price) : money(existing.price);
  const marketPrice = body.market_price !== undefined ? money(body.market_price) : money(existing.market_price || price);
  const costPrice = body.cost_price !== undefined ? money(body.cost_price) : money(existing.cost_price || price);
  return {
    title: cleanText(body.title, existing.title, 160),
    subtitle: cleanText(body.subtitle, existing.subtitle, 255),
    productNo: cleanText(body.product_no, existing.product_no || `BH${Date.now()}`, 64),
    barcode: cleanText(body.barcode, existing.barcode || `SN${Date.now()}`, 64),
    category: cleanText(body.category, existing.category || "未分类", 64) || "未分类",
    brand: cleanText(body.brand, existing.brand, 64),
    unit: cleanText(body.unit, existing.unit || "件", 16) || "件",
    marketPrice,
    price,
    costPrice,
    stock: Math.max(0, Number(body.stock ?? existing.stock ?? 0)),
    status: enumValue(body.status, ["on", "off"], existing.status || "on"),
    commissionRate: Number(body.commission_rate ?? existing.commission_rate ?? 0),
    imageUrl: images[0] || "",
    imagesJson: jsonField(images, []),
    description: cleanText(body.description, existing.description, 2000),
    detailHtml: String(body.detail_html ?? existing.detail_html ?? ""),
    weight: Number(body.weight ?? existing.weight ?? 0),
    minBuyQty: Math.max(1, Number(body.min_buy_qty ?? existing.min_buy_qty ?? 1)),
    perOrderLimit: Math.max(0, Number(body.per_order_limit ?? existing.per_order_limit ?? 0)),
    perUserLimit: Math.max(0, Number(body.per_user_limit ?? existing.per_user_limit ?? 0)),
    isVirtual: boolFlag(body.is_virtual ?? existing.is_virtual),
    noRefundAfterPay: boolFlag(body.no_refund_after_pay ?? existing.no_refund_after_pay),
    freightTemplate: cleanText(body.freight_template, existing.freight_template, 80),
    deliveryMethods: jsonField(body.delivery_methods, parseDbJson(existing.delivery_methods, ["express"])),
    pickupAddress: cleanText(body.pickup_address, existing.pickup_address, 255),
    vipEnabled: boolFlag(body.vip_enabled ?? existing.vip_enabled ?? true)
  };
}

function campaignPayload(body, existing = {}) {
  return {
    name: cleanText(body.name, existing.name, 160),
    description: cleanText(body.description, existing.description, 255),
    productId: null,
    startAt: mysqlDate(body.start_at, existing.start_at || new Date()),
    endAt: mysqlDate(body.end_at, existing.end_at || new Date(Date.now() + 7 * 86400000)),
    hideTime: boolFlag(body.hide_time ?? existing.hide_time),
    stock: Math.max(0, Number(body.stock ?? existing.stock ?? 0)),
    leadPrice: money(body.lead_price ?? existing.lead_price),
    settlePrice: money(body.settle_price ?? existing.settle_price ?? 0),
    perUserLimit: Math.max(0, Number(body.per_user_limit ?? existing.per_user_limit ?? 1)),
    perOrderLimit: Math.max(0, Number(body.per_order_limit ?? existing.per_order_limit ?? 1)),
    deliveryMethods: jsonField(body.delivery_methods, parseDbJson(existing.delivery_methods, ["express"])),
    pickupAddress: cleanText(body.pickup_address, existing.pickup_address, 255),
    freeShipping: boolFlag(body.free_shipping ?? existing.free_shipping ?? true),
    showStoreAddress: boolFlag(body.show_store_address ?? existing.show_store_address),
    verifyAtOrderStore: boolFlag(body.verify_at_order_store ?? existing.verify_at_order_store),
    memberTag: cleanText(body.member_tag, existing.member_tag, 64),
    postPayAddress: boolFlag(body.post_pay_address ?? existing.post_pay_address),
    relationMode: enumValue(body.relation_mode, ["current", "first", "activity_visit", "activity_paid"], existing.relation_mode || "activity_paid"),
    defaultInviterId: body.default_inviter_id ? Number(body.default_inviter_id) : (existing.default_inviter_id || null),
    rewardIssueWay: enumValue(body.reward_issue_way, ["withdraw", "instant"], existing.reward_issue_way || "withdraw"),
    rewardPermission: enumValue(body.reward_permission, ["all", "buyer_only"], existing.reward_permission || "all"),
    rewardRule: enumValue(body.reward_rule, ["uniform", "member_level"], existing.reward_rule || "uniform"),
    rewardLevel1: money(body.reward_level1 ?? existing.reward_level1 ?? 0),
    rewardLevel2: money(body.reward_level2 ?? existing.reward_level2 ?? 0),
    directPayWay: enumValue(body.direct_pay_way, ["wechat_balance"], existing.direct_pay_way || "wechat_balance"),
    rewardMultipleEnabled: boolFlag(body.reward_multiple_enabled ?? existing.reward_multiple_enabled),
    rewardStepEnabled: boolFlag(body.reward_step_enabled ?? existing.reward_step_enabled),
    teamRewardEnabled: boolFlag(body.team_reward_enabled ?? existing.team_reward_enabled),
    teamRewardLevel1: money(body.team_reward_level1 ?? existing.team_reward_level1 ?? 0),
    teamRewardLevel2: money(body.team_reward_level2 ?? existing.team_reward_level2 ?? 0),
    lotteryEnabled: boolFlag(body.lottery_enabled ?? existing.lottery_enabled),
    lotteryConfig: jsonField(body.lottery_config, parseDbJson(existing.lottery_config, {})),
    qrcodeGuideImage: cleanText(body.qrcode_guide_image, existing.qrcode_guide_image, 600),
    teamQrcodeEnabled: boolFlag(body.team_qrcode_enabled ?? existing.team_qrcode_enabled),
    teamQrcodeTypes: jsonField(body.team_qrcode_types, parseDbJson(existing.team_qrcode_types, ["personal", "group"])),
    trafficConfig: jsonField(body.traffic_config, parseDbJson(existing.traffic_config, {})),
    shareCover: cleanText(body.share_cover, existing.share_cover, 600),
    detailImages: jsonField(body.detail_images, parseDbJson(existing.detail_images, [])),
    shareDescription: cleanText(body.share_description, existing.share_description, 255),
    shareTimelineText: cleanText(body.share_timeline_text, existing.share_timeline_text, 255),
    customerServiceQrcode: cleanText(body.customer_service_qrcode, existing.customer_service_qrcode, 600),
    backgroundMusic: cleanText(body.background_music, existing.background_music, 600),
    posterConfig: jsonField(body.poster_config, parseDbJson(existing.poster_config, [])),
    formSchema: jsonField(body.form_schema, parseDbJson(existing.form_schema, [])),
    virtualSoldCount: Math.max(0, Number(body.virtual_sold_count ?? existing.virtual_sold_count ?? 0)),
    virtualShareCount: Math.max(0, Number(body.virtual_share_count ?? existing.virtual_share_count ?? 0)),
    virtualBrowseCount: Math.max(0, Number(body.virtual_browse_count ?? existing.virtual_browse_count ?? 0)),
    virtualInviteCount: Math.max(0, Number(body.virtual_invite_count ?? existing.virtual_invite_count ?? 0)),
    virtualRankings: jsonField(body.virtual_rankings, parseDbJson(existing.virtual_rankings, [])),
    status: enumValue(body.status, ["draft", "published", "ended", "expired"], existing.status || "draft")
  };
}

function addressPayload(body, existing = {}) {
  return {
    receiverName: cleanText(body.receiver_name, existing.receiver_name, 64),
    phone: cleanText(body.phone, existing.phone, 32),
    province: cleanText(body.province, existing.province, 64),
    city: cleanText(body.city, existing.city, 64),
    district: cleanText(body.district, existing.district, 64),
    detail: cleanText(body.detail, existing.detail, 180),
    isDefault: boolFlag(body.is_default ?? existing.is_default)
  };
}

function createStore(pool = createPool()) {
  const screenDashboardCache = new Map();

  function onlineWindowSeconds() {
    return positiveInt(process.env.SCREEN_ONLINE_WINDOW_SECONDS, 6, 60);
  }

  function screenDashboardCacheMs() {
    return positiveInt(process.env.SCREEN_DASHBOARD_CACHE_MS, 3000, 30000);
  }

  async function ping() {
    await pool.query("SELECT 1");
  }

  async function settings(conn = pool, appid = "") {
    const scopedAppId = normalizeAppId(appid);
    let row = await one(conn, "SELECT * FROM app_settings WHERE appid = :appid", { appid: scopedAppId });
    if (!row && scopedAppId) {
      const fallback = await one(conn, "SELECT * FROM app_settings ORDER BY id LIMIT 1");
      await conn.query(
        `INSERT INTO app_settings (
          appid, commission_level_1, commission_level_2, min_withdrawal, compliance_name, auto_pay_enabled, screen_audio_url, home_config
        ) VALUES (
          :appid, :level1, :level2, :minWithdrawal, :complianceName, :autoPayEnabled, :screenAudioUrl, :homeConfig
        )
        ON DUPLICATE KEY UPDATE appid = appid`,
        {
          appid: scopedAppId,
          level1: Number(fallback?.commission_level_1 ?? 0.12),
          level2: Number(fallback?.commission_level_2 ?? 0.05),
          minWithdrawal: Number(fallback?.min_withdrawal ?? 10),
          complianceName: String(fallback?.compliance_name || "Invite").slice(0, 20),
          autoPayEnabled: Boolean(fallback?.auto_pay_enabled),
          screenAudioUrl: String(fallback?.screen_audio_url || ""),
          homeConfig: jsonField(normalizeHomeConfig(parseDbJson(fallback?.home_config, null)), defaultHomeConfig())
        }
      );
      row = await one(conn, "SELECT * FROM app_settings WHERE appid = :appid", { appid: scopedAppId });
    }
    if (!row) throw appError(500, "System settings missing");
    return normalizeSettings(row);
  }

  async function verifyAdminLogin(body = {}) {
    const username = cleanText(body.username, "", 64);
    const password = String(body.password || "");
    if (!username || !password) throw appError(401, "Account or password is incorrect");
    const row = await one(pool, `
      SELECT *
      FROM admin_users
      WHERE status = 'active' AND (username = :username OR phone = :username)
      ORDER BY username = :username DESC, id DESC
      LIMIT 1
    `, { username });
    if (row) {
      if (!verifyAdminPassword(password, row.password_hash)) throw appError(401, "Account or password is incorrect");
      return adminUserRow(row);
    }
    const envUser = process.env.ADMIN_USERNAME || "";
    const envPassword = process.env.ADMIN_PASSWORD || "";
    if (envUser && envPassword && username === envUser && password === envPassword) {
      return {
        id: 0,
        username: envUser,
        phone: "",
        display_name: envUser,
        role: "super",
        appid: defaultAppId(),
        status: "active"
      };
    }
    throw appError(401, "Account or password is incorrect");
  }

  async function listAgentAdmins(adminOrAppid = "") {
    const scope = assertSuperAdmin(adminOrAppid);
    const rows = await many(pool, `
      SELECT au.*,
        (SELECT COUNT(*) FROM acquisition_campaigns ac WHERE ac.appid = au.appid AND ac.owner_admin_id = au.id) campaign_count
      FROM admin_users au
      WHERE au.appid = :appid AND au.role = 'agent'
      ORDER BY au.created_at DESC, au.id DESC
      LIMIT 300
    `, { appid: scope.appid });
    return rows.map(row => ({
      ...adminUserRow(row),
      campaign_count: Number(row.campaign_count || 0)
    }));
  }

  async function saveAgentAdmin(body = {}, adminOrAppid = "") {
    const scope = assertSuperAdmin(adminOrAppid);
    const id = Number(body.id || 0);
    const phone = cleanText(body.phone, "", 32);
    const username = cleanText(body.username || phone, "", 64);
    const displayName = cleanText(body.display_name || username || phone, "", 80);
    const password = String(body.password || "");
    const status = enumValue(body.status, ["active", "disabled"], "active");
    if (!username || !phone) throw appError(422, "手机号和登录账号必填");
    if (!id && password.length < 6) throw appError(422, "新增代理商密码至少 6 位");
    return tx(pool, async conn => {
      const duplicate = await one(conn, `
        SELECT id
        FROM admin_users
        WHERE username = :username AND id <> :id
        LIMIT 1
      `, { username, id: id || 0 });
      if (duplicate) throw appError(409, "登录账号已存在");
      if (id) {
        const existing = await one(conn, "SELECT * FROM admin_users WHERE id = :id AND appid = :appid AND role = 'agent' FOR UPDATE", {
          id,
          appid: scope.appid
        });
        if (!existing) throw appError(404, "代理商账号不存在");
        const passwordSql = password ? ", password_hash = :passwordHash" : "";
        await conn.query(
          `UPDATE admin_users SET
             username = :username,
             phone = :phone,
             display_name = :displayName,
             status = :status
             ${passwordSql}
           WHERE id = :id AND appid = :appid AND role = 'agent'`,
          {
            id,
            appid: scope.appid,
            username,
            phone,
            displayName,
            status,
            passwordHash: password ? hashAdminPassword(password) : existing.password_hash
          }
        );
        return adminUserRow(await one(conn, "SELECT * FROM admin_users WHERE id = :id", { id }));
      }
      const [result] = await conn.query(
        `INSERT INTO admin_users (
          appid, username, phone, display_name, password_hash, role, parent_admin_id, status
        ) VALUES (
          :appid, :username, :phone, :displayName, :passwordHash, 'agent', :parentAdminId, :status
        )`,
        {
          appid: scope.appid,
          username,
          phone,
          displayName,
          passwordHash: hashAdminPassword(password),
          parentAdminId: scope.adminId || null,
          status
        }
      );
      return adminUserRow(await one(conn, "SELECT * FROM admin_users WHERE id = :id", { id: result.insertId }));
    });
  }

  async function deleteAgentAdmin(agentId, adminOrAppid = "") {
    const scope = assertSuperAdmin(adminOrAppid);
    const id = assertId(agentId, "代理商账号 ID");
    return tx(pool, async conn => {
      const existing = await one(conn, "SELECT * FROM admin_users WHERE id = :id AND appid = :appid AND role = 'agent' FOR UPDATE", {
        id,
        appid: scope.appid
      });
      if (!existing) throw appError(404, "代理商账号不存在");
      await conn.query("DELETE FROM admin_users WHERE id = :id AND appid = :appid AND role = 'agent'", { id, appid: scope.appid });
      const rows = await many(conn, `
        SELECT au.*,
          (SELECT COUNT(*) FROM acquisition_campaigns ac WHERE ac.appid = au.appid AND ac.owner_admin_id = au.id) campaign_count
        FROM admin_users au
        WHERE au.appid = :appid AND au.role = 'agent'
        ORDER BY au.created_at DESC, au.id DESC
        LIMIT 300
      `, { appid: scope.appid });
      return rows.map(row => ({
        ...adminUserRow(row),
        campaign_count: Number(row.campaign_count || 0)
      }));
    });
  }

  async function getUser(userId, conn = pool, appid = "") {
    const id = assertId(userId, "用户 ID");
    const params = { id };
    const appFilter = appid ? " AND appid = :appid" : "";
    if (appid) params.appid = normalizeAppId(appid);
    const user = await one(conn, `SELECT * FROM users WHERE id = :id${appFilter}`, params);
    if (!user) throw appError(404, "用户不存在");
    return normalizeUser(user);
  }

  async function requireSessionUser(userId, sessionToken = "", appid = "", conn = pool) {
    const scopedAppId = normalizeAppId(appid);
    const id = assertId(userId, "用户 ID");
    const token = cleanText(sessionToken, "", 80);
    if (!token) throw appError(401, "登录已失效，请重新进入小程序");
    const user = await one(conn, "SELECT * FROM users WHERE id = :id AND appid = :appid AND session_token = :sessionToken", {
      id,
      appid: scopedAppId,
      sessionToken: token
    });
    if (!user) throw appError(401, "登录已失效，请重新进入小程序");
    return normalizeUser(user);
  }

  async function requireSessionOrder(orderId, sessionToken = "", appid = "", conn = pool) {
    const scopedAppId = normalizeAppId(appid);
    const id = assertId(orderId, "订单 ID");
    const token = cleanText(sessionToken, "", 80);
    if (!token) throw appError(401, "登录已失效，请重新进入小程序");
    const row = await one(conn, `
      SELECT o.id
      FROM orders o
      JOIN users u ON u.id = o.user_id AND u.appid = o.appid
      WHERE o.id = :id
        AND o.appid = :appid
        AND u.session_token = :sessionToken
    `, {
      id,
      appid: scopedAppId,
      sessionToken: token
    });
    if (!row) throw appError(403, "无权操作该订单");
    return true;
  }

  async function listUserAddresses(userId, conn = pool, appid = "") {
    const scopedAppId = normalizeAppId(appid);
    const id = assertId(userId, "用户 ID");
    const user = await one(conn, "SELECT id FROM users WHERE id = :id AND appid = :appid", { id, appid: scopedAppId });
    if (!user) throw appError(404, "用户不存在");
    const rows = await many(conn, `
      SELECT *
      FROM user_addresses
      WHERE user_id = :userId AND appid = :appid
      ORDER BY is_default DESC, id DESC
    `, { userId: id, appid: scopedAppId });
    return rows.map(addressRow);
  }

  async function getDefaultAddress(userId, conn = pool, appid = "") {
    const scopedAppId = normalizeAppId(appid);
    const id = assertId(userId, "用户 ID");
    const row = await one(conn, `
      SELECT *
      FROM user_addresses
      WHERE user_id = :userId AND appid = :appid
      ORDER BY is_default DESC, id DESC
      LIMIT 1
    `, { userId: id, appid: scopedAppId });
    return row ? addressRow(row) : null;
  }

  async function saveUserAddress(body, appid = "") {
    const scopedAppId = normalizeAppId(appid);
    return tx(pool, async conn => {
      const userId = assertId(body.user_id, "用户 ID");
      const user = await one(conn, "SELECT id FROM users WHERE id = :id AND appid = :appid FOR UPDATE", { id: userId, appid: scopedAppId });
      if (!user) throw appError(404, "用户不存在");

      let existing = null;
      if (body.id) {
        existing = await one(conn, "SELECT * FROM user_addresses WHERE id = :id AND user_id = :userId AND appid = :appid FOR UPDATE", {
          id: assertId(body.id, "地址 ID"),
          userId,
          appid: scopedAppId
        });
        if (!existing) throw appError(404, "收货地址不存在");
      }

      const payload = addressPayload(body, existing || {});
      if (!payload.receiverName) throw appError(422, "收件人必填");
      if (!payload.phone) throw appError(422, "手机号必填");
      if (!payload.detail) throw appError(422, "详细地址必填");

      const countRow = await one(conn, "SELECT COUNT(*) count FROM user_addresses WHERE user_id = :userId AND appid = :appid", { userId, appid: scopedAppId });
      const shouldDefault = payload.isDefault || Number(countRow.count || 0) <= (existing ? 1 : 0);
      if (shouldDefault) {
        await conn.query("UPDATE user_addresses SET is_default = 0 WHERE user_id = :userId AND appid = :appid", { userId, appid: scopedAppId });
      }

      if (existing) {
        await conn.query(
          `UPDATE user_addresses
           SET receiver_name = :receiverName, phone = :phone, province = :province, city = :city,
               district = :district, detail = :detail, is_default = :isDefault
           WHERE id = :id AND user_id = :userId AND appid = :appid`,
          {
            ...payload,
            isDefault: shouldDefault ? 1 : payload.isDefault,
            id: existing.id,
            userId,
            appid: scopedAppId
          }
        );
      } else {
        await conn.query(
          `INSERT INTO user_addresses (appid, user_id, receiver_name, phone, province, city, district, detail, is_default)
           VALUES (:appid, :userId, :receiverName, :phone, :province, :city, :district, :detail, :isDefault)`,
          {
            ...payload,
            appid: scopedAppId,
            userId,
            isDefault: shouldDefault ? 1 : payload.isDefault
          }
        );
      }

      const defaultCount = await one(conn, "SELECT COUNT(*) count FROM user_addresses WHERE user_id = :userId AND appid = :appid AND is_default = 1", { userId, appid: scopedAppId });
      if (!Number(defaultCount.count || 0)) {
        await conn.query(`
          UPDATE user_addresses
          SET is_default = 1
          WHERE user_id = :userId AND appid = :appid
          ORDER BY id DESC
          LIMIT 1
        `, { userId, appid: scopedAppId });
      }

      return listUserAddresses(userId, conn, scopedAppId);
    });
  }

  async function resolveOrderAddress(conn, userId, body, appid = "") {
    const scopedAppId = normalizeAppId(appid);
    const addressId = Number(body.address_id || body.addressId || 0);
    if (addressId) {
      const row = await one(conn, "SELECT * FROM user_addresses WHERE id = :id AND user_id = :userId AND appid = :appid", {
        id: assertId(addressId, "地址 ID"),
        userId,
        appid: scopedAppId
      });
      if (!row) throw appError(404, "收货地址不存在");
      const address = addressRow(row);
      return {
        addressId: address.id,
        addressText: address.display_text.slice(0, 255)
      };
    }

    const typedAddress = cleanText(body.address, "", 255);
    if (typedAddress) {
      return { addressId: null, addressText: typedAddress };
    }

    const fallback = await getDefaultAddress(userId, conn, scopedAppId);
    if (fallback) {
      return {
        addressId: fallback.id,
        addressText: fallback.display_text.slice(0, 255)
      };
    }

    throw appError(422, "请先维护收货地址");
  }

  function inviterIdFromScene(value) {
    const campaign = parseCampaignInviteScene(value);
    if (campaign) return campaign.userId;
    const product = parseProductInviteScene(value);
    if (product) return product.userId;
    return Number(value || 0);
  }

  async function bindParentIfPossible(conn, user, parentId, appid = user?.appid || "") {
    const scopedAppId = normalizeAppId(appid);
    const normalized = inviterIdFromScene(parentId);
    if (!normalized || user.parent_id || user.id === normalized) return user;
    const parent = await one(conn, "SELECT id FROM users WHERE id = :id AND appid = :appid", { id: normalized, appid: scopedAppId });
    if (!parent) return user;
    await conn.query(`
      UPDATE users
      SET parent_id = :parentId,
          first_parent_id = COALESCE(first_parent_id, :parentId)
      WHERE id = :userId AND appid = :appid AND parent_id IS NULL
    `, {
      parentId: normalized,
      userId: user.id,
      appid: scopedAppId
    });
    return getUser(user.id, conn, scopedAppId);
  }

  async function login(body, appid = "") {
    const scopedAppId = normalizeAppId(appid || body.appid);
    return tx(pool, async conn => {
      if (body.user_id) {
        let user = await getUser(Number(body.user_id), conn, scopedAppId);
        user = await bindParentIfPossible(conn, user, body.parent_id || body.scene, scopedAppId);
        return user;
      }

      const nickname = String(body.nickname || "微信用户").trim().slice(0, 24) || "微信用户";
      const initials = Array.from(nickname).slice(0, 2).join("").toUpperCase();
      const openid = body.openid ? String(body.openid).trim() : `dev_openid_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const [result] = await conn.query(
        `INSERT INTO users (appid, openid, phone, nickname, avatar, parent_id, first_parent_id, distributor_status)
         VALUES (:appid, :openid, :phone, :nickname, :avatar, NULL, NULL, 'pending')`,
        {
          appid: scopedAppId,
          openid,
          phone: String(body.phone || "").trim(),
          nickname,
          avatar: initials
        }
      );
      let user = await getUser(result.insertId, conn, scopedAppId);
      user = await bindParentIfPossible(conn, user, body.parent_id || body.scene, scopedAppId);
      return user;
    });
  }

  async function wechatLogin(body, appid = "") {
    const scopedAppId = normalizeAppId(appid || body.appid);
    return tx(pool, async conn => {
      const openid = String(body.openid || "").trim();
      if (!openid) throw appError(422, "missing openid");
      const scene = body.scene || body.parent_id;
      const hasUserInfo = Boolean(body.userInfo && (body.userInfo.nickName || body.userInfo.avatarUrl));
      const nickname = String(body.userInfo?.nickName || displayNameFromOpenid(openid)).trim().slice(0, 24);
      const avatar = String(body.userInfo?.avatarUrl || avatarFromName(nickname)).trim().slice(0, 255);
      const token = newSessionToken();
      let user = await one(conn, "SELECT * FROM users WHERE appid = :appid AND openid = :openid FOR UPDATE", { appid: scopedAppId, openid });
      if (!user) {
        const [result] = await conn.query(
          `INSERT INTO users (appid, openid, phone, nickname, avatar, parent_id, first_parent_id, distributor_status, session_token, session_key_cipher)
           VALUES (:appid, :openid, '', :nickname, :avatar, NULL, NULL, 'pending', :token, :sessionKey)`,
          {
            appid: scopedAppId,
            openid,
            nickname,
            avatar,
            token,
            sessionKey: String(body.sessionKey || "")
          }
        );
        user = await getUser(result.insertId, conn, scopedAppId);
      } else {
        await conn.query(
          `UPDATE users
           SET session_token = :token,
               session_key_cipher = :sessionKey,
               nickname = CASE WHEN :hasUserInfo = 1 THEN :nickname WHEN nickname = '' THEN :nickname ELSE nickname END,
               avatar = CASE WHEN :hasUserInfo = 1 THEN :avatar WHEN avatar = '' THEN :avatar ELSE avatar END
           WHERE id = :id AND appid = :appid`,
          {
            id: user.id,
            appid: scopedAppId,
            token,
            sessionKey: String(body.sessionKey || ""),
            nickname,
            avatar,
            hasUserInfo: hasUserInfo ? 1 : 0
          }
        );
        user = await getUser(user.id, conn, scopedAppId);
      }
      user = await bindParentIfPossible(conn, user, scene, scopedAppId);
      return { user, token };
    });
  }

  async function bindInviter(body, appid = "") {
    const scopedAppId = normalizeAppId(appid || body.appid);
    return tx(pool, async conn => {
      const user = await getUser(Number(body.user_id), conn, scopedAppId);
      if (user.parent_id) throw appError(409, "该用户已经绑定推荐人");
      return bindParentIfPossible(conn, user, body.parent_id || body.scene, scopedAppId);
    });
  }

  async function approveDistributorIfNeeded(conn, userId, appid = "") {
    const id = Number(userId || 0);
    if (!id) return null;
    const scopedAppId = normalizeAppId(appid);
    await conn.query(
      "UPDATE users SET distributor_status = 'approved' WHERE id = :id AND appid = :appid AND distributor_status <> 'approved'",
      { id, appid: scopedAppId }
    );
    return getUser(id, conn, scopedAppId);
  }

  async function applyDistributor(body, appid = "") {
    const scopedAppId = normalizeAppId(appid || body.appid);
    return tx(pool, async conn => {
      const user = await getUser(Number(body.user_id), conn, scopedAppId);
      return approveDistributorIfNeeded(conn, user.id, scopedAppId);
    });
  }

  async function categories(conn = pool, appid = "") {
    const scopedAppId = normalizeAppId(appid);
    const rows = await many(conn, "SELECT DISTINCT category FROM products WHERE appid = :appid ORDER BY category", { appid: scopedAppId });
    return ["全部", ...rows.map(row => row.category).filter(Boolean).filter(category => category !== "全部")];
  }

  async function listPublicProducts({ category = "全部", keyword = "", appid = "" }) {
    const scopedAppId = normalizeAppId(appid);
    const params = {
      appid: scopedAppId,
      category,
      keyword: `%${String(keyword).trim()}%`
    };
    const filters = ["appid = :appid", "status = 'on'"];
    if (category && category !== "全部") filters.push("category = :category");
    if (String(keyword).trim()) filters.push("(title LIKE :keyword OR description LIKE :keyword)");
    const products = await many(pool, `SELECT * FROM products WHERE ${filters.join(" AND ")} ORDER BY sales DESC, id DESC`, params);
    return {
      categories: await categories(pool, scopedAppId),
      products: products.map(publicProduct)
    };
  }

  async function getPublicProduct(productId, conn = pool, appid = "") {
    const scopedAppId = normalizeAppId(appid);
    const product = await one(conn, "SELECT * FROM products WHERE id = :id AND appid = :appid AND status = 'on'", { id: assertId(productId, "商品 ID"), appid: scopedAppId });
    if (!product) throw appError(404, "商品不存在或已下架");
    return publicProduct(product);
  }

  async function listAdminProducts(appid = "") {
    const scopedAppId = normalizeAppId(appid);
    const rows = await many(pool, "SELECT * FROM products WHERE appid = :appid ORDER BY id DESC", { appid: scopedAppId });
    return rows.map(publicProduct);
  }

  async function createProduct(body, appid = "") {
    const scopedAppId = normalizeAppId(appid || body.appid);
    const payload = productPayload(body);
    if (!payload.title || payload.price <= 0) throw appError(422, "商品标题和销售价必填");
    const [result] = await pool.query(
      `INSERT INTO products (
         appid, title, subtitle, product_no, barcode, category, brand, unit, market_price, price, cost_price,
         stock, sales, status, commission_rate, image_url, images_json, detail_html, description,
         weight, min_buy_qty, per_order_limit, per_user_limit, is_virtual, no_refund_after_pay,
         freight_template, delivery_methods, vip_enabled
       )
       VALUES (
         :appid, :title, :subtitle, :productNo, :barcode, :category, :brand, :unit, :marketPrice, :price, :costPrice,
         :stock, 0, :status, :commissionRate, :imageUrl, :imagesJson, :detailHtml, :description,
         :weight, :minBuyQty, :perOrderLimit, :perUserLimit, :isVirtual, :noRefundAfterPay,
         :freightTemplate, :deliveryMethods, :vipEnabled
       )`,
      { ...payload, appid: scopedAppId }
    );
    const product = await one(pool, "SELECT * FROM products WHERE id = :id", { id: result.insertId });
    return publicProduct(product);
  }

  async function updateProduct(productId, body, appid = "") {
    const scopedAppId = normalizeAppId(appid || body.appid);
    const id = assertId(productId, "商品 ID");
    const existing = await one(pool, "SELECT * FROM products WHERE id = :id AND appid = :appid", { id, appid: scopedAppId });
    if (!existing) throw appError(404, "商品不存在");
    const next = productPayload(body, existing);
    if (!next.title || next.price <= 0) throw appError(422, "商品标题和销售价必填");
    await pool.query(
      `UPDATE products
       SET title = :title,
           subtitle = :subtitle,
           product_no = :productNo,
           barcode = :barcode,
           category = :category,
           brand = :brand,
           unit = :unit,
           market_price = :marketPrice,
           price = :price,
           cost_price = :costPrice,
           stock = :stock,
           status = :status,
           commission_rate = :commissionRate,
           image_url = :imageUrl,
           images_json = :imagesJson,
           detail_html = :detailHtml,
           description = :description,
           weight = :weight,
           min_buy_qty = :minBuyQty,
           per_order_limit = :perOrderLimit,
           per_user_limit = :perUserLimit,
           is_virtual = :isVirtual,
           no_refund_after_pay = :noRefundAfterPay,
           freight_template = :freightTemplate,
           delivery_methods = :deliveryMethods,
           vip_enabled = :vipEnabled
       WHERE id = :id AND appid = :appid`,
      { ...next, id, appid: scopedAppId }
    );
    const product = await one(pool, "SELECT * FROM products WHERE id = :id AND appid = :appid", { id, appid: scopedAppId });
    return publicProduct(product);
  }

  async function deleteProduct(productId, appid = "") {
    const scopedAppId = normalizeAppId(appid);
    const id = assertId(productId, "商品 ID");
    return tx(pool, async conn => {
      const existing = await one(conn, "SELECT id FROM products WHERE id = :id AND appid = :appid FOR UPDATE", { id, appid: scopedAppId });
      if (!existing) throw appError(404, "商品不存在");
      const usage = await one(conn, `
        SELECT
          (SELECT COUNT(*) FROM orders WHERE product_id = :id AND appid = :appid) order_count
      `, { id, appid: scopedAppId });
      if (Number(usage.order_count || 0)) {
        throw appError(409, "商品已经被订单引用，不能直接删除，请先处理关联订单");
      }
      await conn.query("DELETE FROM products WHERE id = :id AND appid = :appid", { id, appid: scopedAppId });
      const rows = await many(conn, "SELECT * FROM products WHERE appid = :appid ORDER BY id DESC", { appid: scopedAppId });
      return rows.map(publicProduct);
    });
  }

  async function updateUserProfile(body, appid = "") {
    const scopedAppId = normalizeAppId(appid || body.appid);
    const userId = assertId(body.user_id, "用户 ID");
    const sessionToken = cleanText(body.session_token, "", 80);
    if (!sessionToken) throw appError(401, "登录已失效，请重新进入小程序");
    const nickname = cleanText(body.nickname, "", 24);
    const avatar = cleanText(body.avatar || body.avatar_url, "", 255);
    if (!nickname && !avatar) throw appError(422, "请填写昵称或选择头像");

    return tx(pool, async conn => {
      const user = await one(
        conn,
        "SELECT * FROM users WHERE id = :id AND appid = :appid AND session_token = :sessionToken FOR UPDATE",
        { id: userId, appid: scopedAppId, sessionToken }
      );
      if (!user) throw appError(401, "登录已失效，请重新进入小程序");
      await conn.query(
        `UPDATE users
         SET nickname = CASE WHEN :nickname <> '' THEN :nickname ELSE nickname END,
             avatar = CASE WHEN :avatar <> '' THEN :avatar ELSE avatar END
         WHERE id = :id AND appid = :appid`,
        { id: userId, appid: scopedAppId, nickname, avatar }
      );
      return getUser(userId, conn, scopedAppId);
    });
  }

  function campaignSelect() {
    return `
      SELECT
        ac.*,
        (SELECT COUNT(*) FROM acquisition_qrcodes q WHERE q.campaign_id = ac.id) qrcode_count,
        (SELECT COUNT(*) FROM acquisition_relations r WHERE r.campaign_id = ac.id AND r.appid = ac.appid AND r.unlocked_at IS NULL) relation_count,
        (
          SELECT COUNT(*)
          FROM acquisition_orders ao
          JOIN orders o ON o.id = ao.order_id AND o.appid = ac.appid
          WHERE ao.campaign_id = ac.id AND ao.appid = ac.appid AND o.status IN ('paid','shipped','received')
        ) order_count,
        (
          SELECT COALESCE(SUM(c.amount), 0)
          FROM acquisition_orders ao
          JOIN commissions c ON c.order_id = ao.order_id AND c.appid = ac.appid
          WHERE ao.campaign_id = ac.id AND ao.appid = ac.appid AND c.status <> 'canceled'
        ) reward_total
      FROM acquisition_campaigns ac
    `;
  }

  async function listAcquisitionCampaigns({ status = "", keyword = "", appid = "", ownerAdminId = null } = {}) {
    const scopedAppId = normalizeAppId(appid);
    const filters = ["ac.appid = :appid"];
    const params = { appid: scopedAppId, keyword: `%${cleanText(keyword, "", 80)}%` };
    const ownerId = Number(ownerAdminId || 0);
    if (ownerId > 0) {
      filters.push("ac.owner_admin_id = :ownerAdminId");
      params.ownerAdminId = ownerId;
    }
    if (status) {
      filters.push("ac.status = :status");
      params.status = enumValue(status, ["draft", "published", "ended", "expired"], "");
    }
    if (cleanText(keyword)) filters.push("(ac.name LIKE :keyword OR ac.description LIKE :keyword)");
    const rows = await many(pool, `
      ${campaignSelect()}
      ${filters.length ? `WHERE ${filters.join(" AND ")}` : ""}
      ORDER BY ac.created_at DESC, ac.id DESC
      LIMIT 200
    `, params);
    return rows.map(campaignRow);
  }

  async function getAcquisitionCampaign(campaignId, conn = pool, appid = "") {
    const scope = normalizeAdminScope(appid);
    const scopedAppId = scope.appid;
    const id = assertId(campaignId, "拓客宝活动 ID");
    const appFilter = scopedAppId ? " AND ac.appid = :appid" : "";
    const ownerFilter = scope.ownerAdminId ? " AND ac.owner_admin_id = :ownerAdminId" : "";
    const row = await one(conn, `${campaignSelect()} WHERE ac.id = :id${appFilter}${ownerFilter}`, {
      id,
      appid: scopedAppId,
      ownerAdminId: scope.ownerAdminId
    });
    if (!row) throw appError(404, "拓客宝活动不存在");
    const campaign = campaignRow(row);
    campaign.qrcodes = (await many(conn, "SELECT * FROM acquisition_qrcodes WHERE campaign_id = :id ORDER BY type, id", { id })).map(qrcodeRow);
    campaign.active_qrcodes = campaign.qrcodes.filter(qrcode => {
      const active = qrcode.status === "enabled";
      const unexpired = !qrcode.expires_at || new Date(qrcode.expires_at).getTime() > Date.now();
      const belowLimit = !qrcode.show_limit || Number(qrcode.shown_count || 0) < Number(qrcode.show_limit);
      return active && unexpired && belowLimit;
    });
    return campaign;
  }

  async function listPublicAcquisitionCampaigns({ keyword = "", appid = "" } = {}) {
    const scopedAppId = normalizeAppId(appid);
    const params = { appid: scopedAppId, keyword: `%${cleanText(keyword, "", 80)}%` };
    const filters = ["ac.appid = :appid", "ac.status = 'published'", "ac.start_at <= UTC_TIMESTAMP()", "ac.end_at >= UTC_TIMESTAMP()"];
    if (cleanText(keyword)) filters.push("(ac.name LIKE :keyword OR ac.description LIKE :keyword)");
    const rows = await many(pool, `
      ${campaignSelect()}
      WHERE ${filters.join(" AND ")}
      ORDER BY ac.created_at DESC, ac.id DESC
    `, params);
    return rows.map(campaignRow);
  }

  async function getActiveAcquisitionCampaign(userId = null, scene = "", appid = "") {
    const scopedAppId = normalizeAppId(appid);
    const rows = await many(pool, `
      ${campaignSelect()}
      WHERE ac.appid = :appid
        AND ac.status = 'published'
        AND ac.start_at <= UTC_TIMESTAMP()
        AND ac.end_at >= UTC_TIMESTAMP()
      ORDER BY ac.updated_at DESC, ac.id DESC
      LIMIT 1
    `, { appid: scopedAppId });
    if (!rows.length) return null;
    return getPublicAcquisitionCampaign(rows[0].id, userId, scene, scopedAppId);
  }

  async function getPublicAcquisitionCampaign(campaignId, userId = null, scene = "", appid = "") {
    const scopedAppId = normalizeAppId(appid);
    const campaign = await getAcquisitionCampaign(campaignId, pool, scopedAppId);
    if (campaign.status !== "published") throw appError(404, "活动未发布");
    const now = Date.now();
    if (new Date(campaign.start_at).getTime() > now || new Date(campaign.end_at).getTime() < now) {
      throw appError(404, "活动不在有效期内");
    }
    campaign.purchased_count = 0;
    campaign.reserved_count = 0;
    campaign.remaining_user_limit = campaign.per_user_limit ? Number(campaign.per_user_limit) : 0;
    if (userId) {
      const usage = await acquisitionBuyerQuantity(pool, campaign.id, Number(userId), scopedAppId);
      campaign.purchased_count = usage.paid;
      campaign.reserved_count = usage.reserved;
      campaign.remaining_user_limit = campaign.per_user_limit
        ? Math.max(0, Number(campaign.per_user_limit) - usage.active)
        : 0;
      campaign.relation = campaign.relation_mode === "activity_visit"
        ? await lockAcquisitionRelation(pool, campaign, Number(userId), scene, "visit", scopedAppId)
        : await acquisitionRelationSnapshot(pool, campaign, Number(userId), scene, "visit", scopedAppId);
    }
    if (campaign.active_qrcodes?.length && Number(campaign.active_qrcodes[0].show_limit || 0) > 0) {
      const qrcodeId = campaign.active_qrcodes[0].id;
      const [shownResult] = await pool.query(
        "UPDATE acquisition_qrcodes SET shown_count = shown_count + 1 WHERE id = :qrcodeId AND shown_count < show_limit",
        { qrcodeId }
      );
      if (shownResult.affectedRows) campaign.active_qrcodes[0].shown_count += 1;
    }
    return campaign;
  }

  function sceneInviterId(scene, campaignId, memberId) {
    const parsed = parseCampaignInviteScene(scene);
    const inviterId = parsed && parsed.campaignId === campaignId
      ? parsed.userId
      : Number(scene || 0);
    return inviterId && inviterId !== memberId ? inviterId : 0;
  }

  async function createAcquisitionCampaign(body, appid = "") {
    const scope = normalizeAdminScope(appid || body.appid);
    const scopedAppId = scope.appid;
    const payload = campaignPayload(body);
    if (!payload.name || payload.leadPrice <= 0) throw appError(422, "活动主题和引流价必填");
    return tx(pool, async conn => {
      const [result] = await conn.query(
        `INSERT INTO acquisition_campaigns (
          appid, owner_admin_id, name, description, product_id, start_at, end_at, hide_time, stock, lead_price, settle_price,
          per_user_limit, per_order_limit, delivery_methods, free_shipping, show_store_address, pickup_address,
          verify_at_order_store, member_tag, post_pay_address, relation_mode, default_inviter_id,
          reward_issue_way, reward_permission, reward_rule, reward_level1, reward_level2, direct_pay_way,
          reward_multiple_enabled, reward_step_enabled, team_reward_enabled, team_reward_level1,
          team_reward_level2, lottery_enabled, lottery_config, qrcode_guide_image, team_qrcode_enabled,
          team_qrcode_types, traffic_config, share_cover, detail_images, share_description, share_timeline_text,
          customer_service_qrcode, background_music, poster_config, form_schema, virtual_sold_count,
          virtual_share_count, virtual_browse_count, virtual_invite_count, virtual_rankings, status
        ) VALUES (
          :appid, :ownerAdminId, :name, :description, :productId, :startAt, :endAt, :hideTime, :stock, :leadPrice, :settlePrice,
          :perUserLimit, :perOrderLimit, :deliveryMethods, :freeShipping, :showStoreAddress, :pickupAddress,
          :verifyAtOrderStore, :memberTag, :postPayAddress, :relationMode, :defaultInviterId,
          :rewardIssueWay, :rewardPermission, :rewardRule, :rewardLevel1, :rewardLevel2, :directPayWay,
          :rewardMultipleEnabled, :rewardStepEnabled, :teamRewardEnabled, :teamRewardLevel1,
          :teamRewardLevel2, :lotteryEnabled, :lotteryConfig, :qrcodeGuideImage, :teamQrcodeEnabled,
          :teamQrcodeTypes, :trafficConfig, :shareCover, :detailImages, :shareDescription, :shareTimelineText,
          :customerServiceQrcode, :backgroundMusic, :posterConfig, :formSchema, :virtualSoldCount,
          :virtualShareCount, :virtualBrowseCount, :virtualInviteCount, :virtualRankings, :status
        )`,
        { ...payload, appid: scopedAppId, ownerAdminId: scope.ownerAdminId }
      );
      return getAcquisitionCampaign(result.insertId, conn, scope);
    });
  }

  async function updateAcquisitionCampaign(campaignId, body, appid = "") {
    const scope = normalizeAdminScope(appid || body.appid);
    const scopedAppId = scope.appid;
    const id = assertId(campaignId, "拓客宝活动 ID");
    const existing = await one(pool, `
      SELECT *
      FROM acquisition_campaigns
      WHERE id = :id AND appid = :appid ${scope.ownerAdminId ? "AND owner_admin_id = :ownerAdminId" : ""}
    `, { id, appid: scopedAppId, ownerAdminId: scope.ownerAdminId });
    if (!existing) throw appError(404, "拓客宝活动不存在");
    const payload = campaignPayload(body, existing);
    if (!payload.name || payload.leadPrice <= 0) throw appError(422, "活动主题和引流价必填");
    return tx(pool, async conn => {
      await conn.query(
        `UPDATE acquisition_campaigns SET
          name = :name,
          description = :description,
          product_id = :productId,
          start_at = :startAt,
          end_at = :endAt,
          hide_time = :hideTime,
          stock = :stock,
          lead_price = :leadPrice,
          settle_price = :settlePrice,
          per_user_limit = :perUserLimit,
          per_order_limit = :perOrderLimit,
          delivery_methods = :deliveryMethods,
          free_shipping = :freeShipping,
          show_store_address = :showStoreAddress,
          pickup_address = :pickupAddress,
          verify_at_order_store = :verifyAtOrderStore,
          member_tag = :memberTag,
          post_pay_address = :postPayAddress,
          relation_mode = :relationMode,
          default_inviter_id = :defaultInviterId,
          reward_issue_way = :rewardIssueWay,
          reward_permission = :rewardPermission,
          reward_rule = :rewardRule,
          reward_level1 = :rewardLevel1,
          reward_level2 = :rewardLevel2,
          direct_pay_way = :directPayWay,
          reward_multiple_enabled = :rewardMultipleEnabled,
          reward_step_enabled = :rewardStepEnabled,
          team_reward_enabled = :teamRewardEnabled,
          team_reward_level1 = :teamRewardLevel1,
          team_reward_level2 = :teamRewardLevel2,
          lottery_enabled = :lotteryEnabled,
          lottery_config = :lotteryConfig,
          qrcode_guide_image = :qrcodeGuideImage,
          team_qrcode_enabled = :teamQrcodeEnabled,
          team_qrcode_types = :teamQrcodeTypes,
          traffic_config = :trafficConfig,
          share_cover = :shareCover,
          detail_images = :detailImages,
          share_description = :shareDescription,
          share_timeline_text = :shareTimelineText,
          customer_service_qrcode = :customerServiceQrcode,
          background_music = :backgroundMusic,
          poster_config = :posterConfig,
          form_schema = :formSchema,
          virtual_sold_count = :virtualSoldCount,
          virtual_share_count = :virtualShareCount,
          virtual_browse_count = :virtualBrowseCount,
          virtual_invite_count = :virtualInviteCount,
          virtual_rankings = :virtualRankings,
          status = :status
         WHERE id = :id AND appid = :appid`,
        { ...payload, id, appid: scopedAppId }
      );
      return getAcquisitionCampaign(id, conn, scope);
    });
  }

  async function patchAcquisitionCampaign(campaignId, body, appid = "") {
    const scope = normalizeAdminScope(appid || body.appid);
    const scopedAppId = scope.appid;
    const id = assertId(campaignId, "拓客宝活动 ID");
    const action = String(body.action || "");
    const statusMap = { publish: "published", end: "ended", expire: "expired", draft: "draft" };
    if (!statusMap[action]) throw appError(422, "未知活动操作");
    return tx(pool, async conn => {
      const [result] = await conn.query(
        `UPDATE acquisition_campaigns
         SET status = :status
         WHERE id = :id AND appid = :appid ${scope.ownerAdminId ? "AND owner_admin_id = :ownerAdminId" : ""}`,
        { id, appid: scopedAppId, status: statusMap[action], ownerAdminId: scope.ownerAdminId }
      );
      if (!result.affectedRows) throw appError(404, "拓客宝活动不存在");
      return getAcquisitionCampaign(id, conn, scope);
    });
  }

  async function deleteAcquisitionCampaign(campaignId, appid = "") {
    const scope = normalizeAdminScope(appid);
    const scopedAppId = scope.appid;
    const id = assertId(campaignId, "拓客宝活动 ID");
    return tx(pool, async conn => {
      const existing = await one(conn, `
        SELECT id
        FROM acquisition_campaigns
        WHERE id = :id AND appid = :appid ${scope.ownerAdminId ? "AND owner_admin_id = :ownerAdminId" : ""}
        FOR UPDATE
      `, { id, appid: scopedAppId, ownerAdminId: scope.ownerAdminId });
      if (!existing) throw appError(404, "拓客宝活动不存在");
      // 是否删除交给商家自己判断：订单/关系链/抽奖记录/引流码都随活动级联删除，
      // 已有的普通订单不受影响（orders 表不依赖活动）。
      await conn.query("DELETE FROM acquisition_campaigns WHERE id = :id AND appid = :appid", { id, appid: scopedAppId });
      const rows = await many(
        conn,
        `${campaignSelect()} WHERE ac.appid = :appid ${scope.ownerAdminId ? "AND ac.owner_admin_id = :ownerAdminId" : ""} ORDER BY ac.id DESC`,
        { appid: scopedAppId, ownerAdminId: scope.ownerAdminId }
      );
      return rows.map(campaignRow);
    });
  }

  async function saveAcquisitionQrcode(campaignId, body, appid = "") {
    const scope = normalizeAdminScope(appid || body.appid);
    const campaign = await getAcquisitionCampaign(campaignId, pool, scope);
    const type = enumValue(body.type, ["personal", "group"], "personal");
    const payload = {
      campaignId: campaign.id,
      type,
      name: cleanText(body.name, type === "group" ? "微信群二维码" : "个人微信码", 80),
      imageUrl: cleanText(body.image_url, "", 600),
      posterBg: cleanText(body.poster_bg, "", 600),
      posterPosition: jsonField(body.poster_position, {}),
      expiresAt: body.expires_at ? mysqlDate(body.expires_at) : null,
      showLimit: Math.max(0, Number(body.show_limit || 0)),
      isDefaultTemplate: boolFlag(body.is_default_template),
      status: enumValue(body.status, ["enabled", "disabled"], "enabled")
    };
    if (body.id) {
      const id = assertId(body.id, "引流码 ID");
      await pool.query(
        `UPDATE acquisition_qrcodes
         SET type = :type, name = :name, image_url = :imageUrl, poster_bg = :posterBg,
             poster_position = :posterPosition, expires_at = :expiresAt,
             show_limit = :showLimit, is_default_template = :isDefaultTemplate, status = :status
         WHERE id = :id AND campaign_id = :campaignId`,
        { ...payload, id }
      );
    } else {
      await pool.query(
        `INSERT INTO acquisition_qrcodes (
          campaign_id, type, name, image_url, poster_bg, poster_position, expires_at,
          show_limit, is_default_template, status
        ) VALUES (
          :campaignId, :type, :name, :imageUrl, :posterBg, :posterPosition,
          :expiresAt, :showLimit, :isDefaultTemplate, :status
        )`,
        payload
      );
    }
    return getAcquisitionCampaign(campaign.id, pool, scope);
  }

  async function deleteAcquisitionQrcode(campaignId, qrcodeId, appid = "") {
    const scope = normalizeAdminScope(appid);
    const campaign = await getAcquisitionCampaign(campaignId, pool, scope);
    await pool.query("DELETE FROM acquisition_qrcodes WHERE id = :qrcodeId AND campaign_id = :campaignId", {
      qrcodeId: assertId(qrcodeId, "引流码 ID"),
      campaignId: campaign.id
    });
    return getAcquisitionCampaign(campaign.id, pool, scope);
  }

  async function listAcquisitionRelations(campaignId, appid = "") {
    const scope = normalizeAdminScope(appid);
    const scopedAppId = scope.appid;
    const id = assertId(campaignId, "拓客宝活动 ID");
    await getAcquisitionCampaign(id, pool, scope);
    const rows = await many(pool, `
      SELECT
        r.*,
        m.nickname member_nickname, m.phone member_phone, m.avatar member_avatar, m.distributor_status member_status,
        i.nickname inviter_nickname, i.phone inviter_phone,
        p.nickname parent_nickname, p.phone parent_phone,
        tl.nickname team_leader_nickname, tl.phone team_leader_phone,
        itl.nickname indirect_team_leader_nickname, itl.phone indirect_team_leader_phone
      FROM acquisition_relations r
      LEFT JOIN users m ON m.id = r.member_id
      LEFT JOIN users i ON i.id = r.inviter_id
      LEFT JOIN users p ON p.id = r.parent_inviter_id
      LEFT JOIN users tl ON tl.id = r.team_leader_id
      LEFT JOIN users itl ON itl.id = r.indirect_team_leader_id
      WHERE r.campaign_id = :id AND r.appid = :appid
      ORDER BY r.entered_at DESC
      LIMIT 200
    `, { id, appid: scopedAppId });
    return rows.map(row => ({
      id: row.id,
      campaign_id: row.campaign_id,
      member_id: row.member_id,
      member: { id: row.member_id, nickname: row.member_nickname || "", phone: row.member_phone || "", avatar: row.member_avatar || "", distributor_status: row.member_status || "" },
      inviter: row.inviter_id ? { id: row.inviter_id, nickname: row.inviter_nickname || "", phone: row.inviter_phone || "" } : null,
      parent_inviter: row.parent_inviter_id ? { id: row.parent_inviter_id, nickname: row.parent_nickname || "", phone: row.parent_phone || "" } : null,
      team_leader: row.team_leader_id ? { id: row.team_leader_id, nickname: row.team_leader_nickname || "", phone: row.team_leader_phone || "" } : null,
      indirect_team_leader: row.indirect_team_leader_id ? { id: row.indirect_team_leader_id, nickname: row.indirect_team_leader_nickname || "", phone: row.indirect_team_leader_phone || "" } : null,
      locked_by: row.locked_by,
      entered_at: row.entered_at,
      unlocked_at: row.unlocked_at
    }));
  }

  async function listAcquisitionOrders(campaignId, appid = "") {
    const scope = normalizeAdminScope(appid);
    const scopedAppId = scope.appid;
    const id = assertId(campaignId, "拓客宝活动 ID");
    await getAcquisitionCampaign(id, pool, scope);
    const rows = await loadOrderRows("JOIN acquisition_orders ao ON ao.order_id = o.id WHERE ao.campaign_id = :campaignId AND ao.appid = :appid AND o.appid = :appid", { campaignId: id, appid: scopedAppId });
    return rows.map(orderRow);
  }

  async function listAcquisitionRewards(campaignId, appid = "") {
    const scope = normalizeAdminScope(appid);
    const scopedAppId = scope.appid;
    const id = assertId(campaignId, "拓客宝活动 ID");
    await getAcquisitionCampaign(id, pool, scope);
    const rows = await many(pool, `
      SELECT
        c.*,
        o.amount order_amount, o.status order_status, o.created_at order_created_at,
        p.id product_id, p.title product_title, p.subtitle product_subtitle, p.product_no product_no, p.barcode product_barcode,
        p.category product_category, p.brand product_brand, p.unit product_unit,
        p.market_price product_market_price, p.price product_price, p.cost_price product_cost_price,
        p.stock product_stock, p.sales product_sales, p.status product_status,
        p.commission_rate product_commission_rate, p.image_url product_image_url,
        p.images_json product_images_json, p.detail_html product_detail_html,
        p.description product_description, p.weight product_weight, p.min_buy_qty product_min_buy_qty,
        p.per_order_limit product_per_order_limit, p.per_user_limit product_per_user_limit,
        p.is_virtual product_is_virtual, p.no_refund_after_pay product_no_refund_after_pay,
        p.freight_template product_freight_template, p.delivery_methods product_delivery_methods,
        p.vip_enabled product_vip_enabled, p.created_at product_created_at,
        ac.id campaign_id, ac.name campaign_name, ac.description campaign_description,
        ac.lead_price campaign_lead_price, ac.settle_price campaign_settle_price,
        ac.stock campaign_stock, ac.sold_count campaign_sold_count,
        ac.virtual_sold_count campaign_virtual_sold_count,
        ac.share_cover campaign_share_cover, ac.detail_images campaign_detail_images,
        ac.delivery_methods campaign_delivery_methods,
        ac.per_order_limit campaign_per_order_limit, ac.per_user_limit campaign_per_user_limit,
        ac.status campaign_status, ac.created_at campaign_created_at,
        buyer.nickname buyer_nickname, buyer.phone buyer_phone, buyer.avatar buyer_avatar,
        b.nickname beneficiary_nickname, b.phone beneficiary_phone, b.avatar beneficiary_avatar
      FROM acquisition_orders ao
      JOIN commissions c ON c.order_id = ao.order_id
      LEFT JOIN orders o ON o.id = c.order_id AND o.appid = :appid
      LEFT JOIN products p ON p.id = o.product_id AND p.appid = :appid
      LEFT JOIN acquisition_campaigns ac ON ac.id = ao.campaign_id AND ac.appid = :appid
      LEFT JOIN users buyer ON buyer.id = c.buyer_id AND buyer.appid = :appid
      LEFT JOIN users b ON b.id = c.beneficiary_id AND b.appid = :appid
      WHERE ao.campaign_id = :id AND ao.appid = :appid AND c.appid = :appid
      ORDER BY c.created_at DESC, c.id DESC
      LIMIT 300
    `, { id, appid: scopedAppId });
    return rows.map(commissionRow);
  }

  async function acquisitionDashboard(campaignId, appid = "") {
    const scope = normalizeAdminScope(appid);
    const scopedAppId = scope.appid;
    const id = assertId(campaignId, "拓客宝活动 ID");
    const campaign = await getAcquisitionCampaign(id, pool, scope);
    const totals = await one(pool, `
      SELECT
        (SELECT COUNT(DISTINCT member_id) FROM acquisition_relations WHERE campaign_id = :id AND appid = :appid) visitors,
        (
          SELECT COUNT(DISTINCT ao.order_id)
          FROM acquisition_orders ao
          JOIN orders o ON o.id = ao.order_id
          WHERE ao.campaign_id = :id AND ao.appid = :appid AND o.appid = :appid AND o.status IN ('paid','shipped','received')
        ) orders,
        (
          SELECT COALESCE(SUM(o.amount), 0)
          FROM acquisition_orders ao
          JOIN orders o ON o.id = ao.order_id
          WHERE ao.campaign_id = :id AND ao.appid = :appid AND o.appid = :appid AND o.status IN ('paid','shipped','received')
        ) order_amount,
        (
          SELECT COALESCE(SUM(o.amount), 0)
          FROM acquisition_orders ao
          JOIN orders o ON o.id = ao.order_id
          WHERE ao.campaign_id = :id AND ao.appid = :appid AND o.appid = :appid AND o.status IN ('paid','shipped','received')
        ) paid_amount,
        (
          SELECT COALESCE(SUM(c.amount), 0)
          FROM acquisition_orders ao
          JOIN commissions c ON c.order_id = ao.order_id
          WHERE ao.campaign_id = :id AND ao.appid = :appid AND c.appid = :appid AND c.status <> 'canceled'
        ) reward_amount
    `, { id, appid: scopedAppId }) || {};
    const relationRows = await many(pool, `
      SELECT inviter_id, COUNT(*) fans
      FROM acquisition_relations
      WHERE campaign_id = :id AND appid = :appid AND inviter_id IS NOT NULL
      GROUP BY inviter_id
      ORDER BY fans DESC
      LIMIT 20
    `, { id, appid: scopedAppId });
    return {
      campaign,
      conversion_rate: Number(totals.visitors || 0) ? Number(totals.orders || 0) / Number(totals.visitors || 1) : 0,
      visitors: Number(totals.visitors || 0) + Number(campaign.virtual_invite_count || 0),
      browse_count: Number(totals.visitors || 0) + Number(campaign.virtual_browse_count || 0),
      order_count: Number(totals.orders || 0),
      share_count: Number(campaign.virtual_share_count || 0),
      order_amount: money(totals.order_amount || 0),
      paid_amount: money(totals.paid_amount || 0),
      reward_amount: money(totals.reward_amount || 0),
      fan_rank: relationRows
    };
  }

  async function listAcquisitionMaterials(appid = "") {
    const scopedAppId = normalizeAppId(appid);
    const rows = await many(pool, "SELECT * FROM acquisition_materials WHERE appid = :appid ORDER BY type, sort_order, id DESC", { appid: scopedAppId });
    return rows.map(materialRow);
  }

  async function saveAcquisitionMaterial(body, appid = "") {
    const scopedAppId = normalizeAppId(appid || body.appid);
    const payload = {
      appid: scopedAppId,
      type: enumValue(body.type, ["qrcode_bg", "share_poster", "share_cover"], "qrcode_bg"),
      imageUrl: cleanText(body.image_url, "", 600),
      styleConfig: jsonField(body.style_config, {}),
      sortOrder: Number(body.sort_order || 0)
    };
    if (!payload.imageUrl) throw appError(422, "素材图片必填");
    if (body.id) {
      const id = assertId(body.id, "素材 ID");
      await pool.query(
        `UPDATE acquisition_materials
         SET type = :type, image_url = :imageUrl, style_config = :styleConfig, sort_order = :sortOrder
         WHERE id = :id AND appid = :appid`,
        { ...payload, id }
      );
    } else {
      await pool.query(
        `INSERT INTO acquisition_materials (appid, type, image_url, style_config, sort_order)
         VALUES (:appid, :type, :imageUrl, :styleConfig, :sortOrder)`,
        payload
      );
    }
    return listAcquisitionMaterials(scopedAppId);
  }

  async function deleteAcquisitionMaterial(materialId, appid = "") {
    const scopedAppId = normalizeAppId(appid);
    const id = assertId(materialId, "素材 ID");
    await pool.query("DELETE FROM acquisition_materials WHERE id = :id AND appid = :appid", {
      id,
      appid: scopedAppId
    });
    return listAcquisitionMaterials(scopedAppId);
  }

  async function loadOrderRows(whereSql, params = {}, conn = pool, options = {}) {
    const queryParams = { appid: null, ...params };
    const limit = options.limit ? publicListLimit(options.limit, 100, 500) : 0;
    const offset = limit ? publicOffset(options.page, limit) : 0;
    return many(conn, `
      SELECT
        o.*,
        p.title product_title, p.subtitle product_subtitle, p.product_no product_no, p.barcode product_barcode,
        p.category product_category, p.brand product_brand, p.unit product_unit,
        p.market_price product_market_price, p.price product_price, p.cost_price product_cost_price,
        p.stock product_stock, p.sales product_sales, p.status product_status, p.commission_rate product_commission_rate,
        p.image_url product_image_url, p.images_json product_images_json, p.detail_html product_detail_html,
        p.description product_description, p.weight product_weight, p.min_buy_qty product_min_buy_qty,
        p.per_order_limit product_per_order_limit, p.per_user_limit product_per_user_limit,
        p.is_virtual product_is_virtual, p.no_refund_after_pay product_no_refund_after_pay,
        p.freight_template product_freight_template, p.delivery_methods product_delivery_methods,
        p.vip_enabled product_vip_enabled, p.created_at product_created_at,
        lao.campaign_id campaign_id,
        lac.name campaign_name, lac.description campaign_description,
        lac.lead_price campaign_lead_price, lac.settle_price campaign_settle_price,
        lac.stock campaign_stock, lac.sold_count campaign_sold_count,
        lac.virtual_sold_count campaign_virtual_sold_count,
        lac.share_cover campaign_share_cover, lac.detail_images campaign_detail_images,
        lac.delivery_methods campaign_delivery_methods,
        lac.per_order_limit campaign_per_order_limit, lac.per_user_limit campaign_per_user_limit,
        lac.status campaign_status, lac.created_at campaign_created_at,
        u.openid user_openid, u.phone user_phone, u.nickname user_nickname, u.avatar user_avatar,
        u.parent_id user_parent_id, u.first_parent_id user_first_parent_id,
        u.distributor_status user_distributor_status, u.created_at user_created_at
      FROM orders o
      LEFT JOIN products p ON p.id = o.product_id AND (:appid IS NULL OR p.appid = :appid)
      LEFT JOIN acquisition_orders lao ON lao.order_id = o.id AND (:appid IS NULL OR lao.appid = :appid)
      LEFT JOIN acquisition_campaigns lac ON lac.id = lao.campaign_id AND (:appid IS NULL OR lac.appid = :appid)
      LEFT JOIN users u ON u.id = o.user_id AND (:appid IS NULL OR u.appid = :appid)
      ${whereSql}
      ORDER BY o.created_at DESC, o.id DESC
      ${limit ? `LIMIT ${limit} OFFSET ${offset}` : ""}
    `, queryParams);
  }

  async function listOrders({ userId = null, appid = "", ownerAdminId = null, page = 1, pageSize = 100 } = {}) {
    const filters = [];
    const params = {};
    if (appid) {
      filters.push("o.appid = :appid");
      params.appid = normalizeAppId(appid);
    }
    if (userId) {
      filters.push("o.user_id = :userId");
      params.userId = userId;
    }
    if (Number(ownerAdminId || 0) > 0) {
      filters.push("lac.owner_admin_id = :ownerAdminId");
      params.ownerAdminId = Number(ownerAdminId);
    }
    const rows = await loadOrderRows(filters.length ? `WHERE ${filters.join(" AND ")}` : "", params, pool, {
      page,
      limit: pageSize
    });
    return rows.map(orderRow);
  }

  async function createCommissionsForOrder(conn, order, buyer, product) {
    const scopedAppId = normalizeAppId(order.appid || buyer.appid);
    if (!buyer.parent_id) return [];
    const appSettings = await settings(conn, scopedAppId);
    const created = [];
    const parent = await one(conn, "SELECT * FROM users WHERE id = :id AND appid = :appid", { id: buyer.parent_id, appid: scopedAppId });
    if (parent) {
      await approveDistributorIfNeeded(conn, parent.id, scopedAppId);
      const amount = money(order.amount * Number(product.commission_rate || appSettings.commission_level_1));
      const [result] = await conn.query(
        `INSERT INTO commissions (appid, order_id, beneficiary_id, buyer_id, level, amount, status)
         VALUES (:appid, :orderId, :beneficiaryId, :buyerId, 1, :amount, 'pending')`,
        { appid: scopedAppId, orderId: order.id, beneficiaryId: parent.id, buyerId: buyer.id, amount }
      );
      created.push({ id: result.insertId, appid: scopedAppId, order_id: order.id, beneficiary_id: parent.id, buyer_id: buyer.id, level: 1, amount, status: "pending" });
    }
    if (parent && parent.parent_id) {
      const grandParent = await one(conn, "SELECT * FROM users WHERE id = :id AND appid = :appid", { id: parent.parent_id, appid: scopedAppId });
      if (grandParent) {
        await approveDistributorIfNeeded(conn, grandParent.id, scopedAppId);
        const amount = money(order.amount * Number(appSettings.commission_level_2 || 0));
        const [result] = await conn.query(
          `INSERT INTO commissions (appid, order_id, beneficiary_id, buyer_id, level, amount, status)
           VALUES (:appid, :orderId, :beneficiaryId, :buyerId, 2, :amount, 'pending')`,
          { appid: scopedAppId, orderId: order.id, beneficiaryId: grandParent.id, buyerId: buyer.id, amount }
        );
        created.push({ id: result.insertId, appid: scopedAppId, order_id: order.id, beneficiary_id: grandParent.id, buyer_id: buyer.id, level: 2, amount, status: "pending" });
      }
    }
    return created;
  }

  async function acquisitionRelationSnapshot(conn, campaign, userId, scene = "", lockReason = "visit", appid = "") {
    const scopedAppId = normalizeAppId(appid);
    const memberId = assertId(userId, "用户 ID");
    const member = await one(conn, "SELECT * FROM users WHERE id = :id AND appid = :appid", { id: memberId, appid: scopedAppId });
    if (!member) throw appError(404, "用户不存在");
    const sceneInviter = sceneInviterId(scene, campaign.id, memberId);
    let inviterId = null;
    let parentInviterId = null;
    let lockedBy = "system";

    if (campaign.relation_mode === "current") {
      inviterId = member.parent_id || campaign.default_inviter_id || null;
      lockedBy = "system";
    } else if (campaign.relation_mode === "first") {
      inviterId = member.first_parent_id || member.parent_id || campaign.default_inviter_id || null;
      lockedBy = "system";
    } else if (campaign.relation_mode === "activity_visit" || lockReason === "paid") {
      inviterId = sceneInviter && sceneInviter !== memberId
        ? sceneInviter
        : (member.parent_id || campaign.default_inviter_id || null);
      lockedBy = lockReason === "paid" ? "paid" : "visit";
    }

    if (inviterId) {
      const inviter = await one(conn, "SELECT id, parent_id, first_parent_id FROM users WHERE id = :id AND appid = :appid", { id: inviterId, appid: scopedAppId });
      if (!inviter) inviterId = null;
      else parentInviterId = campaign.relation_mode === "first"
        ? (inviter.first_parent_id || inviter.parent_id || null)
        : (inviter.parent_id || null);
    }

    return {
      appid: scopedAppId,
      campaign_id: campaign.id,
      member_id: memberId,
      inviter_id: inviterId,
      parent_inviter_id: parentInviterId,
      team_leader_id: inviterId,
      indirect_team_leader_id: parentInviterId,
      locked_by: lockedBy,
      entered_at: new Date(),
      unlocked_at: null
    };
  }

  async function lockAcquisitionRelation(conn, campaign, userId, scene = "", lockReason = "visit", appid = "") {
    const scopedAppId = normalizeAppId(appid);
    const memberId = assertId(userId, "用户 ID");
    const existing = await one(conn, "SELECT * FROM acquisition_relations WHERE appid = :appid AND campaign_id = :campaignId AND member_id = :memberId FOR UPDATE", {
      appid: scopedAppId,
      campaignId: campaign.id,
      memberId
    });
    const relation = await acquisitionRelationSnapshot(conn, campaign, memberId, scene, lockReason, scopedAppId);
    if (existing && (campaign.relation_mode === "activity_visit" || campaign.relation_mode === "activity_paid") && (existing.inviter_id || !relation.inviter_id)) {
      return existing;
    }
    if (existing) {
      await conn.query(
        `UPDATE acquisition_relations
         SET inviter_id = :inviterId,
             parent_inviter_id = :parentInviterId,
             team_leader_id = :teamLeaderId,
             indirect_team_leader_id = :indirectTeamLeaderId,
             locked_by = :lockedBy,
             unlocked_at = NULL
         WHERE appid = :appid AND campaign_id = :campaignId AND member_id = :memberId`,
        {
          appid: scopedAppId,
          campaignId: campaign.id,
          memberId,
          inviterId: relation.inviter_id,
          parentInviterId: relation.parent_inviter_id,
          teamLeaderId: relation.team_leader_id,
          indirectTeamLeaderId: relation.indirect_team_leader_id,
          lockedBy: relation.locked_by
        }
      );
      return one(conn, "SELECT * FROM acquisition_relations WHERE appid = :appid AND campaign_id = :campaignId AND member_id = :memberId", {
        appid: scopedAppId,
        campaignId: campaign.id,
        memberId
      });
    }

    await conn.query(
      `INSERT INTO acquisition_relations (
        appid, campaign_id, member_id, inviter_id, parent_inviter_id, team_leader_id,
        indirect_team_leader_id, locked_by
      ) VALUES (
        :appid, :campaignId, :memberId, :inviterId, :parentInviterId, :teamLeaderId,
        :indirectTeamLeaderId, :lockedBy
      )`,
      {
        appid: scopedAppId,
        campaignId: campaign.id,
        memberId,
        inviterId: relation.inviter_id,
        parentInviterId: relation.parent_inviter_id,
        teamLeaderId: relation.team_leader_id,
        indirectTeamLeaderId: relation.indirect_team_leader_id,
        lockedBy: relation.locked_by
      }
    );
    return one(conn, "SELECT * FROM acquisition_relations WHERE appid = :appid AND campaign_id = :campaignId AND member_id = :memberId", {
      appid: scopedAppId,
      campaignId: campaign.id,
      memberId
    });
  }

  function acquisitionCommissionStatus(campaign) {
    return campaign.reward_issue_way === "instant" ? "withdrawable" : "pending";
  }

  function acquisitionRewardExtraConfig(campaign) {
    const config = campaign.traffic_config || {};
    return {
      multipleEvery: Math.max(0, Math.floor(Number(config.reward_multiple_every || 0))),
      multipleAmount: money(config.reward_multiple_amount || 0),
      stepThreshold: Math.max(0, Math.floor(Number(config.reward_step_threshold || 0))),
      stepAmount: money(config.reward_step_amount || 0)
    };
  }

  async function acquisitionBuyerOrderCount(conn, campaignId, userId, appid = "") {
    const scopedAppId = normalizeAppId(appid);
    const row = await one(conn, `
      SELECT COUNT(*) count
      FROM acquisition_orders ao
      JOIN orders o ON o.id = ao.order_id
      WHERE ao.campaign_id = :campaignId
        AND o.user_id = :userId
        AND o.appid = :appid
        AND o.status IN ('paid','shipped','received')
    `, { campaignId, userId, appid: scopedAppId });
    return Number(row?.count || 0);
  }

  async function acquisitionBuyerQuantity(conn, campaignId, userId, appid = "", options = {}) {
    const scopedAppId = normalizeAppId(appid);
    const excludedOrderId = Number(options.excludeOrderId || 0);
    const row = await one(conn, `
      SELECT
        COALESCE(SUM(CASE WHEN o.status IN ('paid','shipped','received') THEN o.quantity ELSE 0 END), 0) paid_quantity,
        COALESCE(SUM(CASE
          WHEN o.status = 'unpaid' AND (o.expires_at IS NULL OR o.expires_at > UTC_TIMESTAMP()) THEN o.quantity
          ELSE 0
        END), 0) reserved_quantity
      FROM acquisition_orders ao
      JOIN orders o ON o.id = ao.order_id
      WHERE ao.campaign_id = :campaignId
        AND o.user_id = :userId
        AND o.appid = :appid
        ${excludedOrderId ? "AND o.id <> :excludedOrderId" : ""}
    `, { campaignId, userId, appid: scopedAppId, excludedOrderId });
    return {
      paid: Number(row?.paid_quantity || 0),
      reserved: Number(row?.reserved_quantity || 0),
      active: Number(row?.paid_quantity || 0) + Number(row?.reserved_quantity || 0)
    };
  }

  async function assertCampaignUserLimit(conn, campaign, userId, quantity, appid = "", options = {}) {
    const limit = Number(campaign?.per_user_limit || 0);
    if (!limit) return { paid: 0, reserved: 0, active: 0, remaining: 0 };
    const usage = await acquisitionBuyerQuantity(conn, campaign.id, userId, appid || campaign.appid, options);
    const usedQuantity = options.paidOnly ? usage.paid : usage.active;
    if (usedQuantity + Number(quantity || 0) > limit) {
      throw appError(409, `每人最多购买 ${limit} 件`);
    }
    return {
      ...usage,
      remaining: Math.max(0, limit - usedQuantity)
    };
  }

  async function productBuyerQuantity(conn, productId, userId, appid = "", options = {}) {
    const scopedAppId = normalizeAppId(appid);
    const excludedOrderId = Number(options.excludeOrderId || 0);
    const row = await one(conn, `
      SELECT
        COALESCE(SUM(CASE WHEN status IN ('paid','shipped','received') THEN quantity ELSE 0 END), 0) paid_quantity,
        COALESCE(SUM(CASE
          WHEN status = 'unpaid' AND (expires_at IS NULL OR expires_at > UTC_TIMESTAMP()) THEN quantity
          ELSE 0
        END), 0) reserved_quantity
      FROM orders
      WHERE product_id = :productId
        AND user_id = :userId
        AND appid = :appid
        ${excludedOrderId ? "AND id <> :excludedOrderId" : ""}
    `, { productId, userId, appid: scopedAppId, excludedOrderId });
    return {
      paid: Number(row?.paid_quantity || 0),
      reserved: Number(row?.reserved_quantity || 0),
      active: Number(row?.paid_quantity || 0) + Number(row?.reserved_quantity || 0)
    };
  }

  async function assertProductUserLimit(conn, product, userId, quantity, appid = "", options = {}) {
    if (!options.skipQuantityRules) {
      const perOrder = Number(product.per_order_limit || 0);
      if (perOrder && Number(quantity || 0) > perOrder) throw appError(409, `每单最多购买 ${perOrder} 件`);
      const minBuy = Number(product.min_buy_qty || 1);
      if (Number(quantity || 0) < minBuy) throw appError(409, `最少购买 ${minBuy} 件`);
    }
    const perUser = Number(product.per_user_limit || 0);
    if (!perUser) return;
    const usage = await productBuyerQuantity(conn, product.id, userId, appid || product.appid, options);
    const usedQuantity = options.paidOnly ? usage.paid : usage.active;
    if (usedQuantity + Number(quantity || 0) > perUser) {
      throw appError(409, `每人最多购买 ${perUser} 件`);
    }
  }

  async function acquisitionDirectOrderCount(conn, campaignId, inviterId, appid = "") {
    const scopedAppId = normalizeAppId(appid);
    const row = await one(conn, `
      SELECT COUNT(*) count
      FROM acquisition_orders ao
      JOIN orders o ON o.id = ao.order_id
      WHERE ao.campaign_id = :campaignId
        AND ao.inviter_id = :inviterId
        AND ao.appid = :appid
        AND o.status IN ('paid','shipped','received')
    `, { campaignId, inviterId, appid: scopedAppId });
    return Number(row?.count || 0);
  }

  async function canReceiveAcquisitionReward(conn, campaign, userId, options = {}) {
    const scopedAppId = normalizeAppId(options.appid || options.appId || campaign.appid);
    if (!userId) return false;
    if (options.buyerId && Number(userId) === Number(options.buyerId)) return false;
    const user = await one(conn, "SELECT id, distributor_status FROM users WHERE id = :id AND appid = :appid", { id: userId, appid: scopedAppId });
    if (!user) return false;
    if (options.teamReward) return true;
    if (campaign.reward_rule === "member_level" && user.distributor_status !== "approved") return false;
    if (campaign.reward_permission === "buyer_only") {
      return (await acquisitionBuyerOrderCount(conn, campaign.id, userId, scopedAppId)) > 0;
    }
    return true;
  }

  async function insertAcquisitionCommission(conn, order, buyer, campaign, reward) {
    const scopedAppId = normalizeAppId(order.appid || buyer.appid || campaign.appid);
    if (!reward.userId || money(reward.amount) <= 0) return null;
    await approveDistributorIfNeeded(conn, reward.userId, scopedAppId);
    const allowed = await canReceiveAcquisitionReward(conn, campaign, reward.userId, {
      buyerId: buyer.id,
      teamReward: reward.teamReward,
      appid: scopedAppId
    });
    if (!allowed) return null;
    const status = acquisitionCommissionStatus(campaign);
    const availableAt = status === "withdrawable" ? new Date() : null;
    const [result] = await conn.query(
      `INSERT INTO commissions (appid, order_id, beneficiary_id, buyer_id, level, amount, status, available_at)
       VALUES (:appid, :orderId, :beneficiaryId, :buyerId, :level, :amount, :status, :availableAt)`,
      {
        appid: scopedAppId,
        orderId: order.id,
        beneficiaryId: reward.userId,
        buyerId: buyer.id,
        level: reward.level,
        amount: money(reward.amount),
        status,
        availableAt
      }
    );
    return {
      id: result.insertId,
      appid: scopedAppId,
      order_id: order.id,
      beneficiary_id: reward.userId,
      buyer_id: buyer.id,
      level: reward.level,
      amount: money(reward.amount),
      status,
      available_at: availableAt
    };
  }

  async function createAcquisitionCommissions(conn, order, buyer, campaign, relation) {
    const scopedAppId = normalizeAppId(order.appid || buyer.appid || campaign.appid);
    const created = [];
    const quantity = Math.max(1, Number(order.quantity || 1));
    const rewardRows = [
      { level: 1, userId: relation?.inviter_id, amount: money(campaign.reward_level1 * quantity) },
      { level: 2, userId: relation?.parent_inviter_id, amount: money(campaign.reward_level2 * quantity) }
    ];
    if (campaign.team_reward_enabled) {
      rewardRows.push(
        { level: 11, userId: relation?.team_leader_id, amount: money(campaign.team_reward_level1 * quantity), teamReward: true },
        { level: 12, userId: relation?.indirect_team_leader_id, amount: money(campaign.team_reward_level2 * quantity), teamReward: true }
      );
    }
    if (relation?.inviter_id) {
      const extra = acquisitionRewardExtraConfig(campaign);
      const directCount = await acquisitionDirectOrderCount(conn, campaign.id, relation.inviter_id, scopedAppId);
      if (campaign.reward_multiple_enabled && extra.multipleEvery > 0 && extra.multipleAmount > 0 && directCount > 0 && directCount % extra.multipleEvery === 0) {
        rewardRows.push({ level: 21, userId: relation.inviter_id, amount: extra.multipleAmount });
      }
      if (campaign.reward_step_enabled && extra.stepThreshold > 0 && extra.stepAmount > 0 && directCount === extra.stepThreshold) {
        rewardRows.push({ level: 22, userId: relation.inviter_id, amount: extra.stepAmount });
      }
    }
    for (const reward of rewardRows) {
      const commission = await insertAcquisitionCommission(conn, order, buyer, campaign, reward);
      if (commission) created.push(commission);
    }
    return created;
  }

  async function queueInstantAcquisitionPayouts(conn, order, campaign, commissions) {
    const scopedAppId = normalizeAppId(order.appid || campaign.appid);
    if (campaign.reward_issue_way !== "instant" || !commissions.length) return [];
    const appSettings = await settings(conn, scopedAppId);
    const status = appSettings.auto_pay_enabled ? "paidout" : "approved";
    const reviewNote = appSettings.auto_pay_enabled
      ? "系统自动模拟企业付款到零钱"
      : "待后台企业付款到零钱";
    const created = [];
    for (const commission of commissions) {
      const [result] = await conn.query(
        `INSERT INTO withdrawals (appid, user_id, amount, status, note, reviewed_at, review_note)
         VALUES (:appid, :userId, :amount, :status, :note, UTC_TIMESTAMP(), :reviewNote)`,
        {
          appid: scopedAppId,
          userId: commission.beneficiary_id,
          amount: money(commission.amount),
          status,
          note: `拓客宝直接到账 订单#${order.id}`,
          reviewNote
        }
      );
      created.push({ id: result.insertId, user_id: commission.beneficiary_id, amount: money(commission.amount), status });
    }
    return created;
  }

  function thanksPrize() {
    return {
      name: "谢谢参与",
      type: "thanks",
      image_url: "",
      quantity: 0,
      amount: 0,
      limit_per_user: 0,
      probability: 1
    };
  }

  function normalizedLotteryPrizes(campaign) {
    const config = campaign.lottery_config || {};
    const prizes = Array.isArray(config.prizes) ? config.prizes : [];
    const normalized = prizes.map(prize => ({
      name: cleanText(prize.name, "谢谢参与", 120) || "谢谢参与",
      type: enumValue(prize.type, ["thanks", "cash", "goods", "coupon"], "thanks"),
      image_url: cleanText(prize.image_url, "", 600),
      quantity: Math.max(0, Number(prize.quantity || 0)),
      amount: money(prize.amount || 0),
      limit_per_user: Math.max(0, Number(prize.limit_per_user || 0)),
      probability: Math.max(0, Number(prize.probability || 0))
    })).filter(prize => prize.probability > 0);
    return normalized.length ? normalized : [thanksPrize()];
  }

  function lotteryPrizeKey(prize) {
    const source = JSON.stringify([
      cleanText(prize.name, "谢谢参与", 120),
      enumValue(prize.type, ["thanks", "cash", "goods", "coupon"], "thanks"),
      money(prize.amount || 0)
    ]);
    return crypto.createHash("sha1").update(source).digest("hex");
  }

  async function reserveLotteryPrizeStock(conn, campaign, prize, appid = "") {
    const scopedAppId = normalizeAppId(appid || campaign.appid);
    if (prize.type === "thanks" || Number(prize.quantity || 0) <= 0) return true;
    const prizeKey = lotteryPrizeKey(prize);
    await conn.query(`
      INSERT INTO acquisition_lottery_prize_stocks (
        appid, campaign_id, prize_key, prize_name, prize_type, stock_total, stock_used
      )
      SELECT
        :appid,
        :campaignId,
        :prizeKey,
        :prizeName,
        :prizeType,
        :stockTotal,
        COALESCE((
          SELECT COUNT(*)
          FROM acquisition_lottery_records
          WHERE appid = :appid
            AND campaign_id = :campaignId
            AND prize_name = :prizeName
            AND prize_type = :prizeType
            AND status <> 'failed'
        ), 0)
      ON DUPLICATE KEY UPDATE
        prize_name = VALUES(prize_name),
        prize_type = VALUES(prize_type),
        stock_total = VALUES(stock_total)
    `, {
      appid: scopedAppId,
      campaignId: campaign.id,
      prizeKey,
      prizeName: prize.name,
      prizeType: prize.type,
      stockTotal: Math.max(0, Math.floor(Number(prize.quantity || 0)))
    });
    const [result] = await conn.query(`
      UPDATE acquisition_lottery_prize_stocks
      SET stock_used = stock_used + 1
      WHERE appid = :appid
        AND campaign_id = :campaignId
        AND prize_key = :prizeKey
        AND stock_used < stock_total
    `, {
      appid: scopedAppId,
      campaignId: campaign.id,
      prizeKey
    });
    return Boolean(result.affectedRows);
  }

  async function availableLotteryPrize(conn, campaign, userId, prize, appid = "") {
    const scopedAppId = normalizeAppId(appid || campaign.appid);
    if (prize.type === "thanks") return true;
    if (prize.limit_per_user > 0) {
      const userUsed = await one(conn, `
        SELECT COUNT(*) used
        FROM acquisition_lottery_records
        WHERE appid = :appid AND campaign_id = :campaignId AND user_id = :userId AND prize_name = :prizeName AND status <> 'failed'
      `, { appid: scopedAppId, campaignId: campaign.id, userId, prizeName: prize.name });
      if (Number(userUsed.used || 0) >= prize.limit_per_user) return false;
    }
    return true;
  }

  async function runAcquisitionLottery(conn, campaign, order, buyer) {
    const scopedAppId = normalizeAppId(order.appid || buyer.appid || campaign.appid);
    if (!campaign.lottery_enabled) return null;
    const config = campaign.lottery_config || {};
    const prizes = normalizedLotteryPrizes(campaign);
    const total = prizes.reduce((sum, prize) => sum + prize.probability, 0);
    let cursor = Math.random() * (total || 1);
    let selected = thanksPrize();
    for (const prize of prizes) {
      cursor -= prize.probability;
      if (cursor <= 0) {
        selected = prize;
        break;
      }
    }
    if (!(await availableLotteryPrize(conn, campaign, buyer.id, selected, scopedAppId))) {
      selected = thanksPrize();
    } else if (!(await reserveLotteryPrizeStock(conn, campaign, selected, scopedAppId))) {
      selected = thanksPrize();
    }
    const status = selected.type === "thanks" || config.cash_direct ? "issued" : "pending";
    const [result] = await conn.query(
      `INSERT INTO acquisition_lottery_records (
        appid, campaign_id, order_id, user_id, prize_name, prize_type, prize_image,
        quantity, amount, status
      ) VALUES (
        :appid, :campaignId, :orderId, :userId, :prizeName, :prizeType, :prizeImage,
        :quantity, :amount, :status
      )`,
      {
        appid: scopedAppId,
        campaignId: campaign.id,
        orderId: order.id,
        userId: buyer.id,
        prizeName: selected.name,
        prizeType: selected.type,
        prizeImage: selected.image_url,
        quantity: selected.type === "thanks" ? 0 : 1,
        amount: selected.amount,
        status
      }
    );
    return {
      id: result.insertId,
      appid: scopedAppId,
      campaign_id: campaign.id,
      order_id: order.id,
      user_id: buyer.id,
      prize_name: selected.name,
      prize_type: selected.type,
      prize_image: selected.image_url,
      quantity: selected.type === "thanks" ? 0 : 1,
      amount: selected.amount,
      status
    };
  }

  function outTradeNo(orderId) {
    return `KLCY${Date.now()}${String(orderId).padStart(8, "0")}`;
  }

  async function acquisitionOrderMeta(conn, orderId) {
    const row = await one(conn, "SELECT * FROM acquisition_orders WHERE order_id = :orderId", { orderId });
    if (!row) return null;
    return {
      campaignId: row.campaign_id,
      appid: row.appid || "",
      formValues: parseDbJson(row.form_values, {}),
      scene: row.scene || ""
    };
  }

  async function closeUnpaidOrder(orderId, appid = "") {
    const scopedAppId = normalizeAppId(appid);
    return tx(pool, async conn => {
      const id = assertId(orderId, "订单 ID");
      const order = await one(conn, "SELECT * FROM orders WHERE id = :id AND appid = :appid FOR UPDATE", { id, appid: scopedAppId });
      if (!order) throw appError(404, "订单不存在");
      if (order.status !== "unpaid") {
        const rows = await loadOrderRows("WHERE o.id = :id", { id }, conn);
        return orderRow(rows[0]);
      }
      const meta = await acquisitionOrderMeta(conn, order.id);
      await conn.query("UPDATE orders SET status = 'closed' WHERE id = :id AND appid = :appid", { id, appid: scopedAppId });
      if (order.product_id) {
        await conn.query(
          "UPDATE products SET stock = stock + :quantity, sales = GREATEST(sales - :quantity, 0) WHERE id = :productId AND appid = :appid",
          { quantity: order.quantity, productId: order.product_id, appid: scopedAppId }
        );
      }
      if (meta) {
        await conn.query(
          "UPDATE acquisition_campaigns SET sold_count = GREATEST(sold_count - :quantity, 0) WHERE id = :campaignId AND appid = :appid",
          { quantity: order.quantity, campaignId: meta.campaignId, appid: scopedAppId }
        );
      }
      const rows = await loadOrderRows("WHERE o.id = :id", { id }, conn);
      return orderRow(rows[0]);
    });
  }

  async function closeExpiredOrders(options = {}) {
    const scopedAppId = options.appid ? normalizeAppId(options.appid) : "";
    const limit = publicListLimit(options.limit, 100, 500);
    return tx(pool, async conn => {
      const filters = [
        "status = 'unpaid'",
        "expires_at IS NOT NULL",
        "expires_at <= UTC_TIMESTAMP()"
      ];
      const params = {};
      if (scopedAppId) {
        filters.push("appid = :appid");
        params.appid = scopedAppId;
      }
      const expired = await many(conn, `
        SELECT *
        FROM orders
        WHERE ${filters.join(" AND ")}
        ORDER BY expires_at ASC, id ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      `, params);
      for (const order of expired) {
        const meta = await acquisitionOrderMeta(conn, order.id);
        await conn.query(
          "UPDATE orders SET status = 'closed' WHERE id = :id AND appid = :appid AND status = 'unpaid'",
          { id: order.id, appid: order.appid }
        );
        if (order.product_id) {
          await conn.query(
            "UPDATE products SET stock = stock + :quantity, sales = GREATEST(sales - :quantity, 0) WHERE id = :productId AND appid = :appid",
            { quantity: order.quantity, productId: order.product_id, appid: order.appid }
          );
        }
        if (meta) {
          await conn.query(
            "UPDATE acquisition_campaigns SET sold_count = GREATEST(sold_count - :quantity, 0) WHERE id = :campaignId AND appid = :appid",
            { quantity: order.quantity, campaignId: meta.campaignId, appid: order.appid }
          );
        }
      }
      return { closed_count: expired.length };
    });
  }

  async function finalizePaidOrder(conn, order, payInfo = {}) {
    const scopedAppId = normalizeAppId(order.appid);
    if (["paid", "shipped", "received"].includes(order.status)) {
      const lotteryRecord = await one(conn, "SELECT * FROM acquisition_lottery_records WHERE appid = :appid AND order_id = :orderId ORDER BY id DESC LIMIT 1", { appid: scopedAppId, orderId: order.id });
      const rows = await loadOrderRows("WHERE o.id = :id", { id: order.id }, conn);
      return {
        order: orderRow(rows[0]),
        lottery_record: lotteryRecord || null,
        commissions: []
      };
    }
    if (order.status !== "unpaid") throw appError(409, "订单状态不能支付");
    const buyer = await one(conn, "SELECT * FROM users WHERE id = :id AND appid = :appid FOR UPDATE", { id: order.user_id, appid: scopedAppId });
    if (!buyer) throw appError(404, "用户不存在");
    await approveDistributorIfNeeded(conn, buyer.id, scopedAppId);
    buyer.distributor_status = "approved";
    const meta = await acquisitionOrderMeta(conn, order.id);
    const product = order.product_id
      ? await one(conn, "SELECT * FROM products WHERE id = :id AND appid = :appid", { id: order.product_id, appid: scopedAppId })
      : null;
    if (!meta && !product) throw appError(404, "商品不存在");
    let campaign = null;
    let relation = null;
    let commissions = [];
    let lotteryRecord = null;
    if (meta) {
      const row = await one(conn, `${campaignSelect()} WHERE ac.id = :id AND ac.appid = :appid FOR UPDATE`, { id: meta.campaignId, appid: scopedAppId });
      if (!row) throw appError(404, "拓客宝活动不存在");
      campaign = campaignRow(row);
      await assertCampaignUserLimit(conn, campaign, buyer.id, order.quantity, scopedAppId, { excludeOrderId: order.id, paidOnly: true });
      relation = await lockAcquisitionRelation(conn, campaign, buyer.id, meta.scene, "paid", scopedAppId);
      await approveDistributorIfNeeded(conn, relation?.inviter_id, scopedAppId);
      await approveDistributorIfNeeded(conn, relation?.parent_inviter_id, scopedAppId);
      await conn.query(`
        UPDATE acquisition_orders
        SET inviter_id = :inviterId,
            parent_inviter_id = :parentInviterId,
            team_leader_id = :teamLeaderId,
            indirect_team_leader_id = :indirectTeamLeaderId
        WHERE appid = :appid AND order_id = :orderId
      `, {
        appid: scopedAppId,
        orderId: order.id,
        inviterId: relation?.inviter_id || null,
        parentInviterId: relation?.parent_inviter_id || null,
        teamLeaderId: relation?.team_leader_id || null,
        indirectTeamLeaderId: relation?.indirect_team_leader_id || null
      });
    } else {
      await assertProductUserLimit(conn, product, buyer.id, order.quantity, scopedAppId, { excludeOrderId: order.id, paidOnly: true, skipQuantityRules: true });
    }
    await conn.query(`
      UPDATE orders
      SET status = 'paid',
          transaction_id = CASE WHEN :transactionId <> '' THEN :transactionId ELSE transaction_id END,
          paid_at = COALESCE(paid_at, UTC_TIMESTAMP())
      WHERE id = :id AND appid = :appid
    `, {
      id: order.id,
      appid: scopedAppId,
      transactionId: cleanText(payInfo.transaction_id, "", 64)
    });
    const paidOrder = await one(conn, "SELECT * FROM orders WHERE id = :id AND appid = :appid", { id: order.id, appid: scopedAppId });
    if (campaign) {
      commissions = await createAcquisitionCommissions(conn, paidOrder, buyer, campaign, relation);
      await queueInstantAcquisitionPayouts(conn, paidOrder, campaign, commissions);
      lotteryRecord = await runAcquisitionLottery(conn, campaign, paidOrder, buyer);
    } else {
      commissions = await createCommissionsForOrder(conn, paidOrder, buyer, product);
    }
    const rows = await loadOrderRows("WHERE o.id = :id", { id: order.id }, conn);
    return {
      order: orderRow(rows[0]),
      commissions,
      lottery_record: lotteryRecord
    };
  }

  async function createOrder(body, tenantOrAppid = "") {
    const tenant = typeof tenantOrAppid === "object" ? tenantOrAppid : null;
    const scopedAppId = normalizeAppId(tenant?.appid || tenantOrAppid || body.appid);
    const created = await tx(pool, async conn => {
      const userId = assertId(body.user_id, "用户 ID");
      const campaignId = Number(body.campaign_id || 0);
      const quantity = Math.max(1, Math.min(99, Number(body.quantity || 1)));
      const buyer = await one(conn, "SELECT * FROM users WHERE id = :id AND appid = :appid FOR UPDATE", { id: userId, appid: scopedAppId });
      if (!buyer) throw appError(404, "用户不存在");
      await approveDistributorIfNeeded(conn, buyer.id, scopedAppId);
      buyer.distributor_status = "approved";
      let productId = campaignId ? null : assertId(body.product_id, "商品 ID");
      let campaign = null;
      if (campaignId) {
        const row = await one(conn, `${campaignSelect()} WHERE ac.id = :id AND ac.appid = :appid FOR UPDATE`, { id: assertId(campaignId, "拓客宝活动 ID"), appid: scopedAppId });
        if (!row) throw appError(404, "拓客宝活动不存在");
        campaign = campaignRow(row);
        if (campaign.status !== "published") throw appError(409, "活动未发布");
        const now = Date.now();
        if (new Date(campaign.start_at).getTime() > now || new Date(campaign.end_at).getTime() < now) throw appError(409, "活动不在有效期内");
        if (campaign.per_order_limit && quantity > campaign.per_order_limit) throw appError(409, `每单最多购买 ${campaign.per_order_limit} 件`);
        await assertCampaignUserLimit(conn, campaign, buyer.id, quantity, scopedAppId);
        if (Number(campaign.stock) - Number(campaign.sold_count || 0) < quantity) throw appError(409, "活动库存不足");
      }
      const product = productId
        ? await one(conn, "SELECT * FROM products WHERE id = :id AND appid = :appid AND status = 'on' FOR UPDATE", { id: productId, appid: scopedAppId })
        : null;
      if (!campaign && !product) throw appError(404, "商品不存在或已下架");
      if (!campaign) {
        await assertProductUserLimit(conn, product, buyer.id, quantity, scopedAppId);
        if (Number(product.stock) < quantity) throw appError(409, "库存不足");
      }
// 到店自提的活动不需要买家填收货地址
      const pickupOnly = Boolean(campaign)
        && Array.isArray(campaign.delivery_methods)
        && campaign.delivery_methods.length === 1
        && campaign.delivery_methods[0] === "pickup";
      const orderAddress = pickupOnly
        ? { addressId: null, addressText: "" }
        : await resolveOrderAddress(conn, buyer.id, body, scopedAppId);

      const amount = money(Number(campaign ? campaign.lead_price : product.price) * quantity);
      if (product) {
        const [productStockResult] = await conn.query(
          "UPDATE products SET stock = stock - :quantity, sales = sales + :quantity WHERE id = :id AND appid = :appid AND stock >= :quantity",
          { quantity, id: product.id, appid: scopedAppId }
        );
        if (!productStockResult.affectedRows) throw appError(409, "库存不足");
      }
      if (campaign) {
        const [stockResult] = await conn.query(
          `UPDATE acquisition_campaigns
           SET sold_count = sold_count + :quantity
           WHERE id = :id AND appid = :appid AND stock >= sold_count + :quantity`,
          { quantity, id: campaign.id, appid: scopedAppId }
        );
        if (!stockResult.affectedRows) throw appError(409, "活动库存不足");
      }
      const expiresAt = orderExpiresAt();
      const [result] = await conn.query(
        `INSERT INTO orders (appid, user_id, product_id, quantity, amount, status, pay_provider, address, address_id, expires_at)
         VALUES (:appid, :userId, :productId, :quantity, :amount, 'unpaid', 'wechat', :address, :addressId, :expiresAt)`,
        {
          appid: scopedAppId,
          userId: buyer.id,
          productId: product ? product.id : null,
          quantity,
          amount,
          address: orderAddress.addressText,
          addressId: orderAddress.addressId,
          expiresAt: mysqlDateFromDate(expiresAt)
        }
      );
      const tradeNo = outTradeNo(result.insertId);
      await conn.query("UPDATE orders SET out_trade_no = :tradeNo WHERE id = :id", { id: result.insertId, tradeNo });
      const order = await one(conn, "SELECT * FROM orders WHERE id = :id", { id: result.insertId });
      if (campaign) {
        await conn.query(
          `INSERT INTO acquisition_orders (
            appid, campaign_id, order_id, form_values, scene
          ) VALUES (
            :appid, :campaignId, :orderId, :formValues, :scene
          )`,
          {
            appid: scopedAppId,
            campaignId: campaign.id,
            orderId: order.id,
            formValues: jsonField(body.form_values, {}),
            scene: cleanText(body.scene || body.inviter_id || "", "", 64)
          }
        );
      }
      const rows = await loadOrderRows("WHERE o.id = :id", { id: order.id }, conn);
      return {
        buyer,
        description: campaign ? campaign.name : product.title,
        order: orderRow(rows[0]),
        campaign,
        expiresAt
      };
    });
    let prepay;
    try {
      prepay = await createJsapiPrepay({
        outTradeNo: created.order.out_trade_no,
        description: created.description,
        amount: created.order.amount,
        openid: created.buyer.openid,
        attach: created.campaign ? JSON.stringify({ campaign_id: created.campaign.id }) : "",
        timeExpire: created.expiresAt
      }, tenant || { appid: scopedAppId });
    } catch (error) {
      await closeUnpaidOrder(created.order.id, scopedAppId);
      throw error;
    }
    await pool.query("UPDATE orders SET prepay_id = :prepayId WHERE id = :id", {
      id: created.order.id,
      prepayId: prepay.prepay_id || ""
    });
    return {
      order: created.order,
      payment: {
        provider: "wechat-jsapi",
        out_trade_no: created.order.out_trade_no,
        prepay_id: prepay.prepay_id,
        params: jsapiPayParams(prepay.prepay_id, tenant || { appid: scopedAppId })
      },
      commissions: [],
      lottery_record: null
    };
  }

  async function syncWechatPayment(orderId, tenantOrAppid = "") {
    const tenant = typeof tenantOrAppid === "object" ? tenantOrAppid : null;
    const scopedAppId = normalizeAppId(tenant?.appid || tenantOrAppid);
    const id = assertId(orderId, "订单 ID");
    const order = await one(pool, "SELECT * FROM orders WHERE id = :id AND appid = :appid", { id, appid: scopedAppId });
    if (!order) throw appError(404, "订单不存在");
    if (["paid", "shipped", "received"].includes(order.status)) {
      return tx(pool, conn => finalizePaidOrder(conn, order));
    }
    if (!order.out_trade_no) throw appError(409, "订单缺少商户单号");
    const result = await queryOrder(order.out_trade_no, tenant || { appid: scopedAppId });
    if (result.trade_state !== "SUCCESS") {
      throw appError(409, result.trade_state_desc || "支付尚未完成", { trade_state: result.trade_state });
    }
    if (Number(result.amount?.total || 0) !== yuanToFen(order.amount)) {
      throw appError(409, "支付金额不一致");
    }
    return tx(pool, async conn => {
      const locked = await one(conn, "SELECT * FROM orders WHERE id = :id AND appid = :appid FOR UPDATE", { id, appid: scopedAppId });
      return finalizePaidOrder(conn, locked, { transaction_id: result.transaction_id || "" });
    });
  }

  async function handleWechatPayNotification(resource) {
    const outTradeNo = cleanText(resource.out_trade_no, "", 64);
    if (!outTradeNo) throw appError(422, "缺少商户订单号");
    return tx(pool, async conn => {
      const order = await one(conn, "SELECT * FROM orders WHERE out_trade_no = :outTradeNo FOR UPDATE", { outTradeNo });
      if (!order) throw appError(404, "订单不存在");
      if (Number(resource.amount?.total || 0) !== yuanToFen(order.amount)) {
        throw appError(409, "支付通知金额不一致");
      }
      return finalizePaidOrder(conn, order, { transaction_id: resource.transaction_id || "" });
    });
  }

  async function confirmOrder(orderId, appid = "") {
    const scopedAppId = normalizeAppId(appid);
    return tx(pool, async conn => {
      const id = assertId(orderId, "订单 ID");
      const order = await one(conn, "SELECT * FROM orders WHERE id = :id AND appid = :appid FOR UPDATE", { id, appid: scopedAppId });
      if (!order) throw appError(404, "订单不存在");
      if (!["paid", "shipped"].includes(order.status)) throw appError(409, "当前订单状态不能确认收货");
      await conn.query("UPDATE orders SET status = 'received', received_at = UTC_TIMESTAMP() WHERE id = :id AND appid = :appid", { id, appid: scopedAppId });
      await conn.query(
        "UPDATE commissions SET status = 'withdrawable', available_at = UTC_TIMESTAMP() WHERE order_id = :id AND appid = :appid AND status = 'pending'",
        { id, appid: scopedAppId }
      );
      const rows = await loadOrderRows("WHERE o.id = :id", { id }, conn);
      return orderRow(rows[0]);
    });
  }

  // 我的中奖记录（下单抽奖写入 acquisition_lottery_records）
  async function userLotteryRecords(userId, appid = "", limit = 100) {
    const scopedAppId = normalizeAppId(appid);
    const id = assertId(userId, "用户 ID");
    const typeText = { thanks: "谢谢参与", cash: "现金红包", goods: "实物奖品", coupon: "优惠券" };
    const recordStatusText = { pending: "待发放", issued: "已发放", failed: "发放失败" };
    const orderStatusMap = { unpaid: "待支付", paid: "已付款", shipped: "已发货", received: "已收货", refunded: "已退款", closed: "已关闭" };
    const safeLimit = Math.max(1, Math.min(200, Number(limit) || 100));
    const rows = await many(pool, `
      SELECT
        r.id, r.campaign_id, r.order_id, r.prize_name, r.prize_type, r.prize_image,
        r.quantity, r.amount, r.status, r.created_at,
        ac.name AS campaign_name, ac.share_cover AS campaign_cover,
        o.status AS order_status, o.logistics_no, o.logistics_company
      FROM acquisition_lottery_records r
      LEFT JOIN acquisition_campaigns ac ON ac.id = r.campaign_id AND ac.appid = r.appid
      LEFT JOIN orders o ON o.id = r.order_id AND o.appid = r.appid
      WHERE r.user_id = :userId AND r.appid = :appid
      ORDER BY r.id DESC
      LIMIT ${safeLimit}
    `, { userId: id, appid: scopedAppId });
    return rows.map(row => ({
      id: row.id,
      campaign_id: row.campaign_id,
      campaign_name: row.campaign_name || "",
      campaign_cover: row.campaign_cover || "",
      order_id: row.order_id,
      prize_name: row.prize_name || "",
      prize_type: row.prize_type || "thanks",
      prize_type_text: typeText[row.prize_type] || "",
      prize_image: row.prize_image || "",
      quantity: Number(row.quantity || 0) || 1,
      amount: money(row.amount || 0),
      status: row.status,
      status_text: recordStatusText[row.status] || "",
      order_status: row.order_status || "",
      order_status_text: orderStatusMap[row.order_status] || "",
      logistics_no: row.logistics_no || "",
      logistics_company: row.logistics_company || "",
      created_at: row.created_at
    }));
  }
  async function patchOrder(orderId, body, appid = "") {
    const scopedAppId = normalizeAppId(appid || body.appid);
    let shippingReceipt = null;
    const updated = await tx(pool, async conn => {
      const id = assertId(orderId, "订单 ID");
      const order = await one(conn, "SELECT * FROM orders WHERE id = :id AND appid = :appid FOR UPDATE", { id, appid: scopedAppId });
      if (!order) throw appError(404, "订单不存在");
      if (body.action === "ship") {
        if (order.status !== "paid") throw appError(409, "只有已付款订单可以发货");
        const logisticsNo = String(body.logistics_no || `SF${Date.now()}`).trim();
        const logisticsCompany = cleanText(body.logistics_company || body.express_company, "SF", 32).toUpperCase();
        await conn.query(
          "UPDATE orders SET status = 'shipped', logistics_no = :logisticsNo, logistics_company = :logisticsCompany WHERE id = :id AND appid = :appid",
          { id, appid: scopedAppId, logisticsNo, logisticsCompany }
        );
        // 发货信息上报微信订单中心所需的上下文（在事务外调用微信接口）
        const buyer = await one(
          conn,
          "SELECT id, openid FROM users WHERE id = :userId AND appid = :appid",
          { userId: order.user_id, appid: scopedAppId }
        );
        const product = order.product_id
          ? await one(
              conn,
              "SELECT title, is_virtual FROM products WHERE id = :productId AND appid = :appid",
              { productId: order.product_id, appid: scopedAppId }
            )
          : null;
        shippingReceipt = {
          transactionId: String(order.transaction_id || ""),
          outTradeNo: String(order.out_trade_no || ""),
          openid: String(buyer && buyer.openid || ""),
          trackingNo: logisticsNo,
          expressCompany: logisticsCompany,
          itemDesc: cleanText(product && product.title, "商品", 120),
          isVirtual: Boolean(product && product.is_virtual)
        };
      } else if (body.action === "refund") {
        if (order.status === "refunded") throw appError(409, "订单已经退款");
        await conn.query("UPDATE orders SET status = 'refunded' WHERE id = :id AND appid = :appid", { id, appid: scopedAppId });
        await conn.query("UPDATE commissions SET status = 'canceled' WHERE order_id = :id AND appid = :appid", { id, appid: scopedAppId });
        await conn.query(
          `UPDATE withdrawals w
           JOIN commissions c ON c.beneficiary_id = w.user_id
             AND c.order_id = :id
             AND w.note = CONCAT('拓客宝直接到账 订单#', c.order_id)
           SET w.status = 'rejected',
               w.review_note = '订单退款，直接到账奖励取消',
               w.reviewed_at = UTC_TIMESTAMP()
           WHERE w.status IN ('pending','approved') AND w.appid = :appid AND c.appid = :appid`,
          { id, appid: scopedAppId }
        );
        if (order.product_id) {
          await conn.query("UPDATE products SET stock = stock + :quantity WHERE id = :productId AND appid = :appid", {
            quantity: order.quantity,
            productId: order.product_id,
            appid: scopedAppId
          });
        }
      } else if (body.action === "receive") {
        await conn.query("UPDATE orders SET status = 'received', received_at = UTC_TIMESTAMP() WHERE id = :id AND appid = :appid", { id, appid: scopedAppId });
        await conn.query(
          "UPDATE commissions SET status = 'withdrawable', available_at = UTC_TIMESTAMP() WHERE order_id = :id AND appid = :appid AND status = 'pending'",
          { id, appid: scopedAppId }
        );
      } else {
        throw appError(422, "未知订单操作");
      }
      const rows = await loadOrderRows("WHERE o.id = :id AND o.appid = :appid", { id, appid: scopedAppId }, conn);
      return orderRow(rows[0]);
    });

    // 发货后把物流信息上报微信订单中心（用户才能在微信「订单与卡包」看到这笔订单）。
    // 上报失败不影响本地发货状态，只在返回值里带上 shipping_warning 供后台提示。
    if (shippingReceipt) {
      try {
        let tenant = { appid: scopedAppId };
        try {
          tenant = resolveTenant(scopedAppId) || tenant;
        } catch {
          // 多租户未配置时用兜底 tenant（appid），下面若缺 secret 会以 warning 返回
        }
        await uploadShippingInfo(shippingReceipt, tenant);
      } catch (error) {
        return { ...updated, shipping_warning: error.message };
      }
    }
    return updated;
  }

  async function userAvailableBalance(userId, conn = pool, appid = "") {
    const scopedAppId = normalizeAppId(appid);
    const rows = await many(conn, `
      SELECT
        COALESCE(SUM(CASE WHEN c.status = 'withdrawable' THEN c.amount ELSE 0 END), 0) gross,
        (
          SELECT COALESCE(SUM(w.amount), 0)
          FROM withdrawals w
          WHERE w.user_id = :userId AND w.appid = :appid AND w.status IN ('pending','approved','paidout')
        ) locked
      FROM commissions c
      WHERE c.beneficiary_id = :userId AND c.appid = :appid
    `, { userId, appid: scopedAppId });
    return money(Math.max(0, Number(rows[0].gross || 0) - Number(rows[0].locked || 0)));
  }

  async function listCommissions({ userId = null, appid = "", ownerAdminId = null, page = 1, pageSize = 100 } = {}) {
    const filters = [];
    const params = { appid: null };
    const limit = publicListLimit(pageSize, 100, 500);
    const offset = publicOffset(page, limit);
    if (appid) {
      filters.push("c.appid = :appid");
      params.appid = normalizeAppId(appid);
    }
    if (userId) {
      filters.push("c.beneficiary_id = :userId");
      params.userId = userId;
    }
    if (Number(ownerAdminId || 0) > 0) {
      filters.push("lac.owner_admin_id = :ownerAdminId");
      params.ownerAdminId = Number(ownerAdminId);
    }
    const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
    const rows = await many(pool, `
      SELECT
        c.*,
        o.amount order_amount, o.status order_status, o.created_at order_created_at,
        p.id product_id, p.title product_title, p.category product_category, p.price product_price,
        p.stock product_stock, p.sales product_sales, p.status product_status,
        p.commission_rate product_commission_rate, p.image_url product_image_url,
        p.description product_description, p.created_at product_created_at,
        lao.campaign_id campaign_id,
        lac.name campaign_name, lac.description campaign_description,
        lac.lead_price campaign_lead_price, lac.settle_price campaign_settle_price,
        lac.stock campaign_stock, lac.sold_count campaign_sold_count,
        lac.virtual_sold_count campaign_virtual_sold_count,
        lac.share_cover campaign_share_cover, lac.detail_images campaign_detail_images,
        lac.delivery_methods campaign_delivery_methods,
        lac.per_order_limit campaign_per_order_limit, lac.per_user_limit campaign_per_user_limit,
        lac.status campaign_status, lac.created_at campaign_created_at,
        buyer.nickname buyer_nickname, buyer.phone buyer_phone, buyer.avatar buyer_avatar,
        b.nickname beneficiary_nickname, b.phone beneficiary_phone, b.avatar beneficiary_avatar
      FROM commissions c
      LEFT JOIN orders o ON o.id = c.order_id AND (:appid IS NULL OR o.appid = :appid)
      LEFT JOIN products p ON p.id = o.product_id AND (:appid IS NULL OR p.appid = :appid)
      LEFT JOIN acquisition_orders lao ON lao.order_id = o.id AND (:appid IS NULL OR lao.appid = :appid)
      LEFT JOIN acquisition_campaigns lac ON lac.id = lao.campaign_id AND (:appid IS NULL OR lac.appid = :appid)
      LEFT JOIN users buyer ON buyer.id = c.buyer_id AND (:appid IS NULL OR buyer.appid = :appid)
      LEFT JOIN users b ON b.id = c.beneficiary_id AND (:appid IS NULL OR b.appid = :appid)
      ${where}
      ORDER BY c.created_at DESC, c.id DESC
      LIMIT ${limit} OFFSET ${offset}
    `, params);
    return rows.map(commissionRow);
  }

  async function distributionSummary(userId, appid = "") {
    const scopedAppId = normalizeAppId(appid);
    const id = assertId(userId, "用户 ID");
    const user = await getUser(id, pool, scopedAppId);
    const appSettings = await settings(pool, scopedAppId);
    const [directCount] = await many(pool, `
      SELECT COUNT(*) direct_count
      FROM users
      WHERE parent_id = :id AND appid = :appid
    `, { id, appid: scopedAppId });
    const directCustomers = await many(pool, `
      SELECT u.*, (SELECT COUNT(*) FROM users child WHERE child.parent_id = u.id AND child.appid = :appid) children_count
      FROM users u
      WHERE u.parent_id = :id AND u.appid = :appid
      ORDER BY u.created_at DESC
      LIMIT 100
    `, { id, appid: scopedAppId });
    const [indirect] = await many(pool, `
      SELECT COUNT(*) indirect_count
      FROM users child
      JOIN users direct ON direct.id = child.parent_id
      WHERE direct.parent_id = :id AND child.appid = :appid AND direct.appid = :appid
    `, { id, appid: scopedAppId });
    const indirectCustomers = await many(pool, `
      SELECT
        child.*,
        direct.id direct_parent_id,
        direct.nickname direct_parent_nickname,
        direct.phone direct_parent_phone
      FROM users child
      JOIN users direct ON direct.id = child.parent_id
      WHERE direct.parent_id = :id AND child.appid = :appid AND direct.appid = :appid
      ORDER BY child.created_at DESC
      LIMIT 100
    `, { id, appid: scopedAppId });
    const commissions = await listCommissions({ userId: id, appid: scopedAppId, pageSize: 100 });
    const rows = await many(pool, `
      SELECT
        COALESCE(SUM(CASE WHEN status <> 'canceled' AND DATE(created_at) = UTC_DATE() THEN amount ELSE 0 END), 0) today,
        COALESCE(SUM(CASE WHEN status <> 'canceled' THEN amount ELSE 0 END), 0) total,
        COALESCE(SUM(CASE WHEN status = 'pending' THEN amount ELSE 0 END), 0) pending
      FROM commissions
      WHERE beneficiary_id = :id AND appid = :appid
    `, { id, appid: scopedAppId });
    const withdrawnRows = await many(pool, "SELECT COALESCE(SUM(amount), 0) withdrawn FROM withdrawals WHERE user_id = :id AND appid = :appid AND status = 'paidout'", { id, appid: scopedAppId });
    const withdrawals = await many(pool, "SELECT * FROM withdrawals WHERE user_id = :id AND appid = :appid ORDER BY created_at DESC, id DESC LIMIT 100", { id, appid: scopedAppId });
    return {
      user,
      settings: appSettings,
      today: money(rows[0].today),
      total: money(rows[0].total),
      pending: money(rows[0].pending),
      withdrawable: await userAvailableBalance(id, pool, scopedAppId),
      withdrawn: money(withdrawnRows[0].withdrawn),
      direct_count: Number(directCount.direct_count || 0),
      indirect_count: Number(indirect.indirect_count || 0),
      direct_customers: directCustomers.map(row => ({ ...normalizeUser(row), relation_label: "direct", children_count: Number(row.children_count || 0) })),
      indirect_customers: indirectCustomers.map(row => ({
        ...normalizeUser(row),
        relation_label: "indirect",
        direct_parent_id: row.direct_parent_id || null,
        direct_parent_nickname: row.direct_parent_nickname || "",
        direct_parent_phone: row.direct_parent_phone || ""
      })),
      customers: directCustomers.map(row => ({ ...normalizeUser(row), relation_label: "direct", children_count: Number(row.children_count || 0) })),
      commissions,
      withdrawals
    };
  }

  async function createWithdrawal(body, appid = "") {
    const scopedAppId = normalizeAppId(appid || body.appid);
    return tx(pool, async conn => {
      const userId = assertId(body.user_id, "用户 ID");
      const amount = money(body.amount);
      const user = await one(conn, "SELECT id FROM users WHERE id = :id AND appid = :appid FOR UPDATE", { id: userId, appid: scopedAppId });
      if (!user) throw appError(404, "用户不存在");
      const appSettings = await settings(conn, scopedAppId);
      if (amount <= 0) {
        throw appError(422, "提现金额必须大于 0");
      }
      if (amount < Number(appSettings.min_withdrawal || 0)) {
        throw appError(422, `最低提现金额为 ${appSettings.min_withdrawal} 元`);
      }
      const available = await userAvailableBalance(userId, conn, scopedAppId);
      if (amount > available) {
        throw appError(422, "可提现余额不足", { available });
      }
      const [result] = await conn.query(
        `INSERT INTO withdrawals (appid, user_id, amount, status, note)
         VALUES (:appid, :userId, :amount, 'pending', :note)`,
        { appid: scopedAppId, userId, amount, note: String(body.note || "").slice(0, 80) }
      );
      return one(conn, "SELECT * FROM withdrawals WHERE id = :id", { id: result.insertId });
    });
  }

  async function sharePoster({ userId, productId, envVersion = "release" }, tenantOrAppid = "") {
    const tenant = typeof tenantOrAppid === "object" ? tenantOrAppid : null;
    const scopedAppId = normalizeAppId(tenant?.appid || tenantOrAppid);
    const qrEnvVersion = normalizeAssetEnvVersion(envVersion);
    const user = await getUser(userId, pool, scopedAppId);
    const product = await getPublicProduct(productId, pool, scopedAppId);
    const appSettings = await settings(pool, scopedAppId);
    const paths = productAssetPaths(product.id, user.id, qrEnvVersion);
    let qrcodeBuffer;
    try {
      qrcodeBuffer = await fs.readFile(paths.qrcodePath);
    } catch {
      qrcodeBuffer = await getUnlimitedQRCode({
        scene: paths.scene,
        page: "pages/product/detail",
        checkPath: false,
        envVersion: qrEnvVersion
      }, tenant || { appid: scopedAppId });
      await fs.mkdir(path.dirname(paths.qrcodePath), { recursive: true });
      await fs.writeFile(paths.qrcodePath, qrcodeBuffer);
    }

    await buildProductPoster({
      product,
      user,
      qrcodeBuffer,
      outputPath: paths.posterPath,
      complianceName: appSettings.compliance_name,
      brandName: tenant?.name || "非常好裂变"
    });

    return {
      product,
      user,
      scene: paths.scene,
      page: "pages/product/detail",
      path: `/pages/product/detail?id=${product.id}&scene=${paths.scene}`,
      qrcode_url: paths.qrcodeUrl,
      poster_url: paths.posterUrl,
      env_version: qrEnvVersion,
      qr_payload: `product:${product.id};referrer:${user.id}`,
      compliance_name: appSettings.compliance_name
    };
  }

  async function campaignInvitePoster({ userId, campaignId, envVersion = "release" }, tenantOrAppid = "") {
    const tenant = typeof tenantOrAppid === "object" ? tenantOrAppid : null;
    const scopedAppId = normalizeAppId(tenant?.appid || tenantOrAppid);
    const qrEnvVersion = normalizeAssetEnvVersion(envVersion);
    const user = await getUser(userId, pool, scopedAppId);
    const campaign = await getAcquisitionCampaign(campaignId, pool, scopedAppId);
    if (campaign.status !== "published") throw appError(404, "活动未发布");
    const now = Date.now();
    if (new Date(campaign.start_at).getTime() > now || new Date(campaign.end_at).getTime() < now) {
      throw appError(404, "活动不在有效期内");
    }

    const paths = inviteAssetPaths(campaign.id, user.id, qrEnvVersion);
    let qrcodeBuffer;
    try {
      qrcodeBuffer = await fs.readFile(paths.qrcodePath);
    } catch {
      qrcodeBuffer = await getUnlimitedQRCode({
        scene: paths.scene,
        page: "pages/home/index",
        checkPath: false,
        envVersion: qrEnvVersion
      }, tenant || { appid: scopedAppId });
      await fs.mkdir(path.dirname(paths.qrcodePath), { recursive: true });
      await fs.writeFile(paths.qrcodePath, qrcodeBuffer);
    }

    const posterVersion = Date.now();
    const posterPath = typeof paths.versionedPosterPath === "function"
      ? paths.versionedPosterPath(posterVersion)
      : paths.posterPath;
    const posterUrl = typeof paths.versionedPosterUrl === "function"
      ? paths.versionedPosterUrl(posterVersion)
      : `${paths.posterUrl}?v=${posterVersion}`;

    await buildInvitePoster({
      campaign,
      user,
      qrcodeBuffer,
      outputPath: posterPath,
      brandName: tenant?.name || "非常好裂变"
    });

    return {
      campaign,
      user,
      scene: paths.scene,
      page: "pages/home/index",
      path: `/pages/home/index?campaign_id=${campaign.id}&scene=${paths.scene}`,
      qrcode_url: paths.qrcodeUrl,
      poster_url: posterUrl,
      env_version: qrEnvVersion,
      qr_payload: `campaign:${campaign.id};referrer:${user.id}`
    };
  }

  async function dashboard(appid = "") {
    const scopedAppId = normalizeAppId(appid);
    const appSettings = await settings(pool, scopedAppId);
    const metrics = await one(pool, `
      SELECT
        COALESCE(SUM(CASE WHEN o.status IN ('paid','shipped','received') THEN o.amount ELSE 0 END), 0) sales,
        COALESCE(SUM(CASE WHEN o.status IN ('paid','shipped','received') THEN o.amount ELSE 0 END), 0) paid_sales,
        COALESCE(SUM(CASE WHEN o.status IN ('paid','shipped','received') THEN 1 ELSE 0 END), 0) orders,
        (SELECT COUNT(*) FROM users WHERE appid = :appid) users,
        (SELECT COUNT(*) FROM products WHERE appid = :appid AND status = 'on') products_on,
        (SELECT COALESCE(SUM(amount), 0) FROM commissions WHERE appid = :appid AND status <> 'canceled') commission,
        (SELECT COALESCE(SUM(amount), 0) FROM withdrawals WHERE appid = :appid AND status = 'pending') pending_withdrawals
      FROM orders o
      WHERE o.appid = :appid
    `, { appid: scopedAppId });
    const recentRows = await loadOrderRows("WHERE o.appid = :appid", { appid: scopedAppId }, pool, { limit: 8 });
    const topRows = await many(pool, `
      SELECT u.*,
        COALESCE(SUM(CASE WHEN c.status <> 'canceled' THEN c.amount ELSE 0 END), 0) total_commission,
        (SELECT COUNT(*) FROM users child WHERE child.parent_id = u.id AND child.appid = :appid) direct_count
      FROM users u
      LEFT JOIN commissions c ON c.beneficiary_id = u.id AND c.appid = :appid
      WHERE u.appid = :appid
      GROUP BY u.id
      ORDER BY total_commission DESC, direct_count DESC
      LIMIT 6
    `, { appid: scopedAppId });
    const featuredCampaignRow = await one(pool, `
      ${campaignSelect()}
      WHERE ac.appid = :appid
      ORDER BY
        CASE ac.status WHEN 'published' THEN 0 WHEN 'draft' THEN 1 WHEN 'ended' THEN 2 ELSE 3 END,
        order_count DESC,
        ac.updated_at DESC,
        ac.id DESC
      LIMIT 1
    `, { appid: scopedAppId });
    const featuredCampaign = featuredCampaignRow ? campaignRow(featuredCampaignRow) : null;
    const campaignOrderJoin = featuredCampaign
      ? "JOIN acquisition_orders ao ON ao.order_id = o.id AND ao.appid = :appid AND ao.campaign_id = :campaignId"
      : "LEFT JOIN acquisition_orders ao ON ao.order_id = o.id AND ao.appid = :appid";
    const campaignCommissionJoin = featuredCampaign
      ? "JOIN acquisition_orders ao ON ao.order_id = c.order_id AND ao.appid = :appid AND ao.campaign_id = :campaignId"
      : "LEFT JOIN acquisition_orders ao ON ao.order_id = c.order_id AND ao.appid = :appid";
    const campaignParams = featuredCampaign ? { appid: scopedAppId, campaignId: featuredCampaign.id } : { appid: scopedAppId };
    const heartbeatParams = {
      ...campaignParams,
      campaignIdForRelation: featuredCampaign ? featuredCampaign.id : 0
    };
    const onlineWindow = onlineWindowSeconds();
    const liveCount = await one(pool, `
      SELECT COUNT(DISTINCT user_id) count
      FROM screen_heartbeats
      WHERE last_seen_at >= UTC_TIMESTAMP() - INTERVAL ${onlineWindow} SECOND
        AND appid = :appid
        ${featuredCampaign ? "AND campaign_id = :campaignId" : ""}
    `, campaignParams);
    const liveRows = await many(pool, `
      SELECT
        hb.*,
        m.nickname member_nickname, m.avatar member_avatar,
        ar.inviter_id, ar.team_leader_id,
        i.nickname inviter_nickname,
        tl.nickname team_leader_nickname
      FROM screen_heartbeats hb
      LEFT JOIN screen_heartbeats newer ON newer.user_id = hb.user_id
        AND newer.appid = :appid
        AND newer.last_seen_at >= UTC_TIMESTAMP() - INTERVAL ${onlineWindow} SECOND
        ${featuredCampaign ? "AND newer.campaign_id = :campaignId" : ""}
        AND (
          newer.last_seen_at > hb.last_seen_at
          OR (newer.last_seen_at = hb.last_seen_at AND newer.id > hb.id)
        )
      LEFT JOIN users m ON m.id = hb.user_id AND m.appid = :appid
      LEFT JOIN acquisition_relations ar ON ar.member_id = hb.user_id
        AND ar.appid = :appid
        AND ar.campaign_id = :campaignIdForRelation
      LEFT JOIN users i ON i.id = ar.inviter_id AND i.appid = :appid
      LEFT JOIN users tl ON tl.id = ar.team_leader_id AND tl.appid = :appid
      WHERE hb.last_seen_at >= UTC_TIMESTAMP() - INTERVAL ${onlineWindow} SECOND
        AND hb.appid = :appid
        ${featuredCampaign ? "AND hb.campaign_id = :campaignId" : ""}
        AND newer.id IS NULL
      ORDER BY hb.last_seen_at DESC
      LIMIT 8
    `, heartbeatParams);
    const recentBattleOrders = await many(pool, `
      SELECT
        o.id, o.amount, o.created_at,
        u.nickname user_nickname, u.avatar user_avatar,
        p.title product_title,
        i.nickname inviter_nickname,
        tl.nickname team_leader_nickname
      FROM orders o
      ${campaignOrderJoin}
      LEFT JOIN users u ON u.id = o.user_id AND u.appid = :appid
      LEFT JOIN products p ON p.id = o.product_id AND p.appid = :appid
      LEFT JOIN users i ON i.id = ao.inviter_id AND i.appid = :appid
      LEFT JOIN users tl ON tl.id = ao.team_leader_id AND tl.appid = :appid
      WHERE o.appid = :appid AND o.status IN ('paid','shipped','received')
      ORDER BY o.created_at DESC, o.id DESC
      LIMIT 8
    `, campaignParams);
    const fanRankRows = await many(pool, `
      SELECT
        u.id, u.nickname, u.avatar,
        COUNT(child.id) fans
      FROM users u
      JOIN users child ON child.parent_id = u.id AND child.appid = :appid
      WHERE u.appid = :appid
      GROUP BY u.id
      ORDER BY fans DESC, u.id DESC
      LIMIT 8
    `, { appid: scopedAppId });
    const earningRankRows = await many(pool, `
      SELECT
        u.id, u.nickname, u.avatar,
        COALESCE(SUM(CASE WHEN c.status <> 'canceled' THEN c.amount ELSE 0 END), 0) earnings
      FROM commissions c
      ${campaignCommissionJoin}
      JOIN users u ON u.id = c.beneficiary_id AND u.appid = :appid
      WHERE c.appid = :appid
      GROUP BY u.id
      ORDER BY earnings DESC, u.id DESC
      LIMIT 8
    `, campaignParams);
    const splitRows = await many(pool, `
      SELECT
        CASE
          WHEN fans BETWEEN 1 AND 5 THEN '1-5人'
          WHEN fans BETWEEN 6 AND 10 THEN '6-10人'
          WHEN fans BETWEEN 11 AND 20 THEN '11-20人'
          WHEN fans BETWEEN 21 AND 30 THEN '21-30人'
          WHEN fans BETWEEN 31 AND 40 THEN '31-40人'
          WHEN fans BETWEEN 41 AND 50 THEN '41-50人'
          ELSE '>50人'
        END bucket,
        COUNT(*) count
      FROM (
        SELECT inviter_id, COUNT(*) fans
        FROM acquisition_relations
        WHERE appid = :appid AND inviter_id IS NOT NULL
        ${featuredCampaign ? "AND campaign_id = :campaignId" : ""}
        GROUP BY inviter_id
      ) ranked
      GROUP BY bucket
      ORDER BY
        CASE bucket
          WHEN '1-5人' THEN 1
          WHEN '6-10人' THEN 2
          WHEN '11-20人' THEN 3
          WHEN '21-30人' THEN 4
          WHEN '31-40人' THEN 5
          WHEN '41-50人' THEN 6
          ELSE 7
        END
    `, campaignParams);
    const campaignTotals = featuredCampaign ? await one(pool, `
      SELECT
        (SELECT COUNT(DISTINCT member_id)
         FROM acquisition_relations
         WHERE campaign_id = :campaignId AND appid = :appid) visitors,
        (SELECT COUNT(DISTINCT ao.order_id)
         FROM acquisition_orders ao
         JOIN orders o ON o.id = ao.order_id AND o.appid = :appid
         WHERE ao.campaign_id = :campaignId AND ao.appid = :appid AND o.status IN ('paid','shipped','received')) order_count,
        (SELECT COUNT(DISTINCT o.user_id)
         FROM acquisition_orders ao
         JOIN orders o ON o.id = ao.order_id AND o.appid = :appid
         WHERE ao.campaign_id = :campaignId AND ao.appid = :appid AND o.status IN ('paid','shipped','received')) buyer_count,
        (SELECT COALESCE(SUM(o.amount), 0)
         FROM acquisition_orders ao
         JOIN orders o ON o.id = ao.order_id AND o.appid = :appid
         WHERE ao.campaign_id = :campaignId AND ao.appid = :appid AND o.status IN ('paid','shipped','received')) paid_amount,
        (SELECT COALESCE(SUM(c.amount), 0)
         FROM acquisition_orders ao
         JOIN commissions c ON c.order_id = ao.order_id AND c.appid = :appid
         WHERE ao.campaign_id = :campaignId AND ao.appid = :appid AND c.status <> 'canceled') reward_amount
    `, campaignParams) : null;
    const totalRelationCount = await one(pool, "SELECT COUNT(*) count FROM acquisition_relations WHERE appid = :appid", { appid: scopedAppId });
    return {
      sales: money(metrics.sales),
      paid_sales: money(metrics.paid_sales),
      orders: Number(metrics.orders || 0),
      users: Number(metrics.users || 0),
      products_on: Number(metrics.products_on || 0),
      commission: money(metrics.commission),
      pending_withdrawals: money(metrics.pending_withdrawals),
      top_distributors: topRows.map(row => ({
        ...normalizeUser(row),
        total_commission: money(row.total_commission),
        direct_count: Number(row.direct_count || 0)
      })),
      recent_orders: recentRows.slice(0, 8).map(orderRow),
      battle_screen: {
        title: featuredCampaign ? `${featuredCampaign.name} 作战大屏` : "必火次元作战大屏",
        campaign: featuredCampaign,
        audio_url: appSettings.screen_audio_url || featuredCampaign?.background_music || "",
        countdown_to: featuredCampaign ? featuredCampaign.end_at : null,
        browsing_count: Number(liveCount?.count || 0),
        browse_count: Number(campaignTotals?.visitors || 0) + Number(featuredCampaign?.virtual_browse_count || 0),
        share_count: Number(featuredCampaign?.virtual_share_count || 0),
        visitor_count: featuredCampaign
          ? Number(campaignTotals?.visitors || 0) + Number(featuredCampaign.virtual_invite_count || 0)
          : Number(metrics.users || 0),
        award_count: Number(totalRelationCount?.count || 0),
        order_count: featuredCampaign ? Number(campaignTotals?.order_count || 0) : Number(metrics.orders || 0),
        buyer_count: featuredCampaign ? Number(campaignTotals?.buyer_count || 0) : Number(metrics.users || 0),
        lottery_reward: money(0),
        promotion_reward: featuredCampaign ? money(campaignTotals?.reward_amount || 0) : money(metrics.commission || 0),
        live_visitors: liveRows.map(row => ({
          member: {
            id: row.user_id,
            nickname: row.member_nickname || `用户${row.user_id}`,
            avatar: row.member_avatar || ""
          },
          inviter: row.inviter_nickname || "-",
          team: row.team_leader_nickname || "-",
          status: "实时在线",
          last_seen_at: row.last_seen_at
        })),
        recent_orders: recentBattleOrders.map(row => ({
          id: row.id,
          member: row.user_nickname || "-",
          avatar: row.user_avatar || "",
          inviter: row.inviter_nickname || "-",
          team: row.team_leader_nickname || "-",
          product: row.product_title || "-",
          amount: money(row.amount || 0),
          created_at: row.created_at
        })),
        fan_rank: fanRankRows.map((row, index) => ({
          rank: index + 1,
          id: row.id,
          nickname: row.nickname || `用户${row.id}`,
          avatar: row.avatar || "",
          fans: Number(row.fans || 0)
        })),
        earning_rank: earningRankRows.map((row, index) => ({
          rank: index + 1,
          id: row.id,
          nickname: row.nickname || `用户${row.id}`,
          avatar: row.avatar || "",
          earnings: money(row.earnings || 0)
        })),
        split_analysis: splitRows.map(row => ({
          bucket: row.bucket,
          count: Number(row.count || 0)
        }))
      }
    };
  }

  async function merchantDashboard(adminOrAppid = "") {
    const scope = normalizeAdminScope(adminOrAppid);
    const ownerFilter = scope.ownerAdminId ? "AND ac.owner_admin_id = :ownerAdminId" : "";
    const params = { appid: scope.appid, ownerAdminId: scope.ownerAdminId };
    const totals = await one(pool, `
      SELECT
        COUNT(DISTINCT ac.id) campaign_count,
        COUNT(DISTINCT CASE WHEN ac.status = 'published' THEN ac.id END) published_count,
        COUNT(DISTINCT CASE WHEN o.status IN ('paid','shipped','received') THEN o.id END) paid_order_count,
        COALESCE(SUM(CASE WHEN o.status IN ('paid','shipped','received') THEN o.amount ELSE 0 END), 0) paid_amount,
        COUNT(DISTINCT CASE WHEN o.status IN ('paid','shipped','received') AND o.created_at >= CURDATE() THEN o.id END) today_order_count,
        COALESCE(SUM(CASE WHEN o.status IN ('paid','shipped','received') AND o.created_at >= CURDATE() THEN o.amount ELSE 0 END), 0) today_amount
      FROM acquisition_campaigns ac
      LEFT JOIN acquisition_orders ao ON ao.campaign_id = ac.id AND ao.appid = ac.appid
      LEFT JOIN orders o ON o.id = ao.order_id AND o.appid = ac.appid
      WHERE ac.appid = :appid ${ownerFilter}
    `, params) || {};
    const campaigns = await listAcquisitionCampaigns({
      appid: scope.appid,
      ownerAdminId: scope.ownerAdminId,
      status: ""
    });
    const orders = await listOrders({
      appid: scope.appid,
      ownerAdminId: scope.ownerAdminId,
      pageSize: 20
    });
    return {
      admin: {
        id: scope.adminId,
        appid: scope.appid,
        role: scope.role
      },
      campaign_count: Number(totals.campaign_count || 0),
      published_count: Number(totals.published_count || 0),
      paid_order_count: Number(totals.paid_order_count || 0),
      paid_amount: money(totals.paid_amount || 0),
      today_order_count: Number(totals.today_order_count || 0),
      today_amount: money(totals.today_amount || 0),
      campaigns,
      orders
    };
  }

  function isPaidOrder(order = {}) {
    return ["paid", "shipped", "received"].includes(order.status);
  }

  function customerCampaignStats(customerId, beneficiaryId, orders = [], rewards = []) {
    const buyerId = Number(customerId || 0);
    const ownerId = Number(beneficiaryId || 0);
    const buyerOrders = orders.filter(item => Number(item.user_id || 0) === buyerId);
    const paidOrders = buyerOrders.filter(isPaidOrder);
    const buyerRewards = rewards.filter(item => (
      Number(item.buyer_id || 0) === buyerId &&
      Number(item.beneficiary_id || 0) === ownerId &&
      item.status !== "canceled"
    ));
    return {
      order_count: buyerOrders.length,
      paid_order_count: paidOrders.length,
      paid_amount: money(paidOrders.reduce((sum, item) => sum + Number(item.amount || 0), 0)),
      reward_amount: money(buyerRewards.reduce((sum, item) => sum + Number(item.amount || 0), 0)),
      last_order_id: buyerOrders[0]?.id || null,
      last_order_status: buyerOrders[0]?.status || "",
      last_order_status_text: buyerOrders[0]?.status_text || "",
      last_order_at: buyerOrders[0]?.created_at || null
    };
  }

  function withdrawalSummaryRows(rows = []) {
    return rows.map(row => ({
      id: row.id,
      user_id: row.user_id,
      amount: money(row.amount),
      status: row.status,
      status_text: statusText[row.status] || row.status,
      note: row.note || "",
      created_at: row.created_at,
      reviewed_at: row.reviewed_at,
      review_note: row.review_note || ""
    }));
  }

  function personalCampaignData(userId, relations = [], rewards = [], orders = [], withdrawals = []) {
    const id = Number(userId || 0);
    if (!id) {
      return {
        user_id: 0,
        direct_count: 0,
        indirect_count: 0,
        order_count: 0,
        paid_order_count: 0,
        paid_amount: money(0),
        reward_total: money(0),
        pending: money(0),
        withdrawable: money(0),
        direct_customers: [],
        indirect_customers: [],
        rewards: [],
        orders: [],
        withdrawals: []
      };
    }
    const directCustomers = relations
      .filter(item => item.inviter && Number(item.inviter.id) === id)
      .map(item => ({
        ...item.member,
        entered_at: item.entered_at,
        ...customerCampaignStats(item.member?.id, id, orders, rewards)
      }));
    const indirectCustomers = relations
      .filter(item => item.parent_inviter && Number(item.parent_inviter.id) === id)
      .map(item => ({
        ...item.member,
        entered_at: item.entered_at,
        direct_parent: item.inviter,
        ...customerCampaignStats(item.member?.id, id, orders, rewards)
      }));
    const personalRewards = rewards.filter(item => Number(item.beneficiary_id || 0) === id && item.status !== "canceled");
    const personalOrders = orders.filter(item => Number(item.user_id || 0) === id);
    const paidOrders = personalOrders.filter(isPaidOrder);
    const total = personalRewards.reduce((sum, item) => sum + Number(item.amount || 0), 0);
    const pending = personalRewards
      .filter(item => item.status === "pending")
      .reduce((sum, item) => sum + Number(item.amount || 0), 0);
    const withdrawable = personalRewards
      .filter(item => item.status === "withdrawable")
      .reduce((sum, item) => sum + Number(item.amount || 0), 0);
    const lockedWithdrawals = withdrawals
      .filter(item => withdrawalLocksBalance(item.status))
      .reduce((sum, item) => sum + Number(item.amount || 0), 0);
    return {
      user_id: id,
      direct_count: directCustomers.length,
      indirect_count: indirectCustomers.length,
      order_count: personalOrders.length,
      paid_order_count: paidOrders.length,
      paid_amount: money(paidOrders.reduce((sum, item) => sum + Number(item.amount || 0), 0)),
      reward_total: money(total),
      pending: money(pending),
      withdrawable: money(Math.max(0, withdrawable - lockedWithdrawals)),
      direct_customers: directCustomers,
      indirect_customers: indirectCustomers,
      rewards: personalRewards,
      orders: personalOrders,
      withdrawals: withdrawalSummaryRows(withdrawals)
    };
  }

  async function merchantCampaignData(campaignId, adminOrAppid = "", options = {}) {
    const scope = normalizeAdminScope(adminOrAppid);
    const userId = Number(options.userId || 0);
    const [campaignDashboard, relations, orders, rewards, withdrawals, appSettings] = await Promise.all([
      acquisitionDashboard(campaignId, scope),
      listAcquisitionRelations(campaignId, scope),
      listAcquisitionOrders(campaignId, scope),
      listAcquisitionRewards(campaignId, scope),
      userId ? listUserWithdrawals(userId, scope.appid) : [],
      settings(pool, scope.appid)
    ]);
    const directCustomers = relations.filter(item => item.inviter).map(item => item.member);
    const indirectCustomers = relations.filter(item => item.parent_inviter).map(item => ({
      ...item.member,
      direct_parent: item.inviter,
      parent_inviter: item.parent_inviter
    }));
    return {
      dashboard: campaignDashboard,
      campaign: campaignDashboard.campaign,
      relations,
      direct_customers: directCustomers,
      indirect_customers: indirectCustomers,
      orders,
      rewards,
      settings: {
        min_withdrawal: Number(appSettings.min_withdrawal || 0)
      },
      personal: personalCampaignData(userId, relations, rewards, orders, withdrawals)
    };
  }

  async function screenDashboard(appid = "") {
    const scopedAppId = normalizeAppId(appid);
    const ttl = screenDashboardCacheMs();
    const cached = screenDashboardCache.get(scopedAppId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }
    const data = await dashboard(appid);
    const screen = data.battle_screen || {};
    const value = {
      ...screen,
      title: screen.title || "必火次元作战大屏",
      online_count: Number(screen.browsing_count || 0),
      online_users: (screen.live_visitors || []).map(item => ({
        ...item,
        status: "实时在线",
        last_seen_at: item.last_seen_at
      }))
    };
    screenDashboardCache.set(scopedAppId, {
      value,
      expiresAt: Date.now() + ttl
    });
    return value;
  }

  async function screenHeartbeat(body, appid = "") {
    const scopedAppId = normalizeAppId(appid || body.appid);
    const userId = assertId(body.user_id, "用户 ID");
    const rawCampaignId = Number(body.campaign_id || 0);
    const rawProductId = Number(body.product_id || 0);
    const campaignId = Number.isInteger(rawCampaignId) && rawCampaignId > 0 ? rawCampaignId : null;
    const productId = Number.isInteger(rawProductId) && rawProductId > 0 ? rawProductId : null;
    const payload = {
      appid: scopedAppId,
      userId,
      campaignId,
      productId,
      scene: cleanText(body.scene, "", 64),
      page: cleanText(body.page, "", 40),
      sessionKey: cleanText(body.session_key, "", 96) || heartbeatSessionKey(body)
    };
    await pool.query(`
      INSERT INTO screen_heartbeats (
        appid, user_id, campaign_id, product_id, scene, page, session_key, last_seen_at
      )
      VALUES (
        :appid, :userId, :campaignId, :productId, :scene, :page, :sessionKey, UTC_TIMESTAMP()
      )
      ON DUPLICATE KEY UPDATE
        user_id = VALUES(user_id),
        campaign_id = VALUES(campaign_id),
        product_id = VALUES(product_id),
        scene = VALUES(scene),
        page = VALUES(page),
        last_seen_at = UTC_TIMESTAMP()
    `, payload);
    return { ok: true, online_window_seconds: onlineWindowSeconds() };
  }

  async function listDistributors(appid = "", options = {}) {
    const scopedAppId = normalizeAppId(appid);
    const limit = publicListLimit(options.limit || options.pageSize, 300, 500);
    const rows = await many(pool, `
      SELECT u.*,
        p.nickname parent_nickname, p.phone parent_phone, p.avatar parent_avatar,
        (SELECT COUNT(*) FROM users child WHERE child.parent_id = u.id AND child.appid = :appid) direct_count,
        COALESCE(SUM(CASE WHEN c.status <> 'canceled' THEN c.amount ELSE 0 END), 0) total_commission,
        GREATEST(
          COALESCE(SUM(CASE WHEN c.status = 'withdrawable' THEN c.amount ELSE 0 END), 0) -
          (
            SELECT COALESCE(SUM(w.amount), 0)
            FROM withdrawals w
            WHERE w.user_id = u.id AND w.appid = :appid AND w.status IN ('pending','approved','paidout')
          ),
          0
        ) available_balance
      FROM users u
      LEFT JOIN users p ON p.id = u.parent_id AND p.appid = :appid
      LEFT JOIN commissions c ON c.beneficiary_id = u.id AND c.appid = :appid
      WHERE u.appid = :appid
      GROUP BY u.id, p.id
      ORDER BY u.created_at DESC
      LIMIT ${limit}
    `, { appid: scopedAppId });
    return rows.map(row => ({
      ...normalizeUser(row),
      parent: row.parent_nickname ? {
        id: row.parent_id,
        nickname: row.parent_nickname,
        phone: row.parent_phone || "",
        avatar: row.parent_avatar || ""
      } : null,
      direct_count: Number(row.direct_count || 0),
      total_commission: money(row.total_commission),
      available_balance: money(row.available_balance)
    }));
  }

  async function listUsers(options = {}) {
    const scopedAppId = normalizeAppId(options.appid);
    const keyword = cleanText(options.keyword, "", 80);
    const distributorStatus = ["pending", "approved", "rejected"].includes(String(options.distributorStatus || ""))
      ? String(options.distributorStatus)
      : "";
    const page = positiveInt(options.page, 1, 1000000);
    const pageSize = publicListLimit(options.pageSize, 30, 100);
    const offset = (page - 1) * pageSize;
    const where = ["u.appid = :appid"];
    const params = {
      appid: scopedAppId,
      keyword: `%${keyword}%`
    };
    if (keyword) {
      where.push("(u.nickname LIKE :keyword OR u.phone LIKE :keyword OR CAST(u.id AS CHAR) LIKE :keyword)");
    }
    if (distributorStatus) {
      where.push("u.distributor_status = :distributorStatus");
      params.distributorStatus = distributorStatus;
    }

    const whereSql = where.join(" AND ");
    const [countRow, rows] = await Promise.all([
      one(pool, `SELECT COUNT(*) total FROM users u WHERE ${whereSql}`, params),
      many(pool, `
        SELECT
          u.*,
          p.nickname parent_nickname,
          p.phone parent_phone,
          p.avatar parent_avatar,
          COALESCE(dc.direct_count, 0) direct_count,
          COALESCE(c.total_commission, 0) total_commission,
          GREATEST(
            COALESCE(c.withdrawable_commission, 0) - COALESCE(w.locked_amount, 0),
            0
          ) available_balance
        FROM users u
        LEFT JOIN users p
          ON p.id = u.parent_id AND p.appid = :appid
        LEFT JOIN (
          SELECT parent_id, COUNT(*) direct_count
          FROM users
          WHERE appid = :appid AND parent_id IS NOT NULL
          GROUP BY parent_id
        ) dc ON dc.parent_id = u.id
        LEFT JOIN (
          SELECT
            beneficiary_id,
            SUM(CASE WHEN status <> 'canceled' THEN amount ELSE 0 END) total_commission,
            SUM(CASE WHEN status = 'withdrawable' THEN amount ELSE 0 END) withdrawable_commission
          FROM commissions
          WHERE appid = :appid
          GROUP BY beneficiary_id
        ) c ON c.beneficiary_id = u.id
        LEFT JOIN (
          SELECT user_id, SUM(amount) locked_amount
          FROM withdrawals
          WHERE appid = :appid AND status IN ('pending', 'approved', 'paidout')
          GROUP BY user_id
        ) w ON w.user_id = u.id
        WHERE ${whereSql}
        ORDER BY u.created_at DESC, u.id DESC
        LIMIT ${pageSize} OFFSET ${offset}
      `, params)
    ]);

    const total = Number(countRow?.total || 0);
    return {
      items: rows.map(row => ({
        ...normalizeUser(row),
        parent: row.parent_nickname ? {
          id: row.parent_id,
          nickname: row.parent_nickname,
          phone: row.parent_phone || "",
          avatar: row.parent_avatar || ""
        } : null,
        direct_count: Number(row.direct_count || 0),
        total_commission: money(row.total_commission),
        available_balance: money(row.available_balance)
      })),
      total,
      page,
      page_size: pageSize,
      page_count: Math.ceil(total / pageSize)
    };
  }

  async function patchDistributor(userId, body, appid = "") {
    const scopedAppId = normalizeAppId(appid || body.appid);
    const id = assertId(userId, "用户 ID");
    if (!["approved", "pending", "rejected"].includes(body.status)) throw appError(422, "分销员状态不正确");
    const [result] = await pool.query("UPDATE users SET distributor_status = :status WHERE id = :id AND appid = :appid", { status: body.status, id, appid: scopedAppId });
    if (!result.affectedRows) throw appError(404, "用户不存在");
    return getUser(id, pool, scopedAppId);
  }

  async function listWithdrawals(appid = "", options = {}) {
    const scopedAppId = normalizeAppId(appid);
    const limit = publicListLimit(options.limit || options.pageSize, 100, 500);
    const rows = await many(pool, `
      SELECT w.*, u.nickname user_nickname, u.phone user_phone, u.avatar user_avatar
      FROM withdrawals w
      LEFT JOIN users u ON u.id = w.user_id AND u.appid = :appid
      WHERE w.appid = :appid
      ORDER BY w.created_at DESC, w.id DESC
      LIMIT ${limit}
    `, { appid: scopedAppId });
    return rows.map(row => ({
      id: row.id,
      user_id: row.user_id,
      amount: money(row.amount),
      status: row.status,
      status_text: statusText[row.status] || row.status,
      note: row.note || "",
      created_at: row.created_at,
      reviewed_at: row.reviewed_at,
      review_note: row.review_note || "",
      user: row.user_nickname ? {
        id: row.user_id,
        nickname: row.user_nickname,
        phone: row.user_phone || "",
        avatar: row.user_avatar || ""
      } : null
    }));
  }

  async function listUserWithdrawals(userId, appid = "", options = {}) {
    const scopedAppId = normalizeAppId(appid);
    const id = assertId(userId, "用户 ID");
    const limit = publicListLimit(options.limit || options.pageSize, 100, 500);
    return many(pool, `
      SELECT *
      FROM withdrawals
      WHERE appid = :appid AND user_id = :id
      ORDER BY created_at DESC, id DESC
      LIMIT ${limit}
    `, { appid: scopedAppId, id });
  }

  async function patchWithdrawal(withdrawalId, body, appid = "") {
    const scopedAppId = normalizeAppId(appid || body.appid);
    return tx(pool, async conn => {
      const id = assertId(withdrawalId, "提现 ID");
      const withdrawal = await one(conn, "SELECT * FROM withdrawals WHERE id = :id AND appid = :appid FOR UPDATE", { id, appid: scopedAppId });
      if (!withdrawal) throw appError(404, "提现申请不存在");

      let status;
      let note;
      if (body.action === "approve") {
        if (withdrawal.status !== "pending") throw appError(409, "只有待审核提现可以通过");
        status = "approved";
        note = String(body.review_note || "审核通过，等待管理员打款").slice(0, 120);
      } else if (body.action === "pay") {
        if (!["pending", "approved"].includes(withdrawal.status)) throw appError(409, "该提现申请不能打款");
        status = "paidout";
        note = String(body.review_note || "已确认打款，微信自动出款待接入").slice(0, 120);
      } else if (body.action === "reject") {
        if (withdrawal.status !== "pending") throw appError(409, "只有待审核提现可以拒绝");
        status = "rejected";
        note = String(body.review_note || "审核未通过").slice(0, 120);
      } else if (body.action === "fail") {
        if (!["pending", "approved"].includes(withdrawal.status)) throw appError(409, "该提现申请不能标记失败");
        status = "failed";
        note = String(body.review_note || "出款失败，金额已退回可提现").slice(0, 120);
      } else {
        throw appError(422, "未知提现操作");
      }
      await conn.query(
        "UPDATE withdrawals SET status = :status, review_note = :note, reviewed_at = UTC_TIMESTAMP() WHERE id = :id AND appid = :appid",
        { status, note, id, appid: scopedAppId }
      );
      return one(conn, "SELECT * FROM withdrawals WHERE id = :id AND appid = :appid", { id, appid: scopedAppId });
    });
  }

  async function updateSettings(body, appid = "") {
    const scopedAppId = normalizeAppId(appid || body.appid);
    await settings(pool, scopedAppId);
    const homeConfig = normalizeHomeConfig(body.home_config);
    await pool.query(
      `UPDATE app_settings
       SET commission_level_1 = :level1, commission_level_2 = :level2, min_withdrawal = :minWithdrawal,
           compliance_name = :complianceName, auto_pay_enabled = :autoPayEnabled, screen_audio_url = :screenAudioUrl,
           home_config = :homeConfig
       WHERE appid = :appid`,
      {
        appid: scopedAppId,
        level1: Number(body.commission_level_1),
        level2: Number(body.commission_level_2),
        minWithdrawal: Number(body.min_withdrawal),
        complianceName: String(body.compliance_name || "推荐有礼").trim().slice(0, 20),
        autoPayEnabled: Boolean(body.auto_pay_enabled),
        screenAudioUrl: cleanText(body.screen_audio_url, "", 600),
        homeConfig: jsonField(homeConfig, defaultHomeConfig())
      }
    );
    return settings(pool, scopedAppId);
  }

  async function close() {
    await pool.end();
  }

  return {
    ping,
    close,
    verifyAdminLogin,
    listAgentAdmins,
    saveAgentAdmin,
    deleteAgentAdmin,
    merchantDashboard,
    merchantCampaignData,
    login,
    wechatLogin,
    updateUserProfile,
    getUser,
    requireSessionUser,
    requireSessionOrder,
    listUserAddresses,
    saveUserAddress,
    bindInviter,
    applyDistributor,
    listPublicProducts,
    getPublicProduct,
    listPublicAcquisitionCampaigns,
    getActiveAcquisitionCampaign,
    getPublicAcquisitionCampaign,
    listAdminProducts,
    createProduct,
    updateProduct,
    deleteProduct,
    listAcquisitionCampaigns,
    getAcquisitionCampaign,
    createAcquisitionCampaign,
    updateAcquisitionCampaign,
    patchAcquisitionCampaign,
    userLotteryRecords,
    deleteAcquisitionCampaign,
    saveAcquisitionQrcode,
    deleteAcquisitionQrcode,
    listAcquisitionRelations,
    listAcquisitionOrders,
    listAcquisitionRewards,
    acquisitionDashboard,
    listAcquisitionMaterials,
    saveAcquisitionMaterial,
    deleteAcquisitionMaterial,
    createOrder,
    closeExpiredOrders,
    syncWechatPayment,
    closeUnpaidOrder,
    handleWechatPayNotification,
    listOrders,
    confirmOrder,
    patchOrder,
    distributionSummary,
    createWithdrawal,
    sharePoster,
    campaignInvitePoster,
    dashboard,
    screenDashboard,
    screenHeartbeat,
    listDistributors,
    listUsers,
    patchDistributor,
    listCommissions,
    listWithdrawals,
    patchWithdrawal,
    settings,
    updateSettings
  };
}

module.exports = {
  createPool,
  createStore,
  dbConfig
};
