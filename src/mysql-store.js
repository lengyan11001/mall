const mysql = require("mysql2/promise");
const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const { appError } = require("./errors");
const { getUnlimitedQRCode } = require("./wechat");
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
  parseCampaignInviteScene,
  parseProductInviteScene,
  productAssetPaths
} = require("./invite-assets");
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

function dbConfig({ withoutDatabase = false } = {}) {
  const config = {
    host: process.env.DB_HOST || "127.0.0.1",
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || "mall",
    password: process.env.DB_PASSWORD || "",
    waitForConnections: true,
    connectionLimit: Number(process.env.DB_CONNECTION_LIMIT || 40),
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

function normalizeSettings(row) {
  return {
    commission_level_1: Number(row.commission_level_1),
    commission_level_2: Number(row.commission_level_2),
    min_withdrawal: Number(row.min_withdrawal),
    compliance_name: row.compliance_name,
    auto_pay_enabled: Boolean(row.auto_pay_enabled)
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
    vipEnabled: boolFlag(body.vip_enabled ?? existing.vip_enabled ?? true)
  };
}

function campaignPayload(body, existing = {}) {
  return {
    name: cleanText(body.name, existing.name, 160),
    description: cleanText(body.description, existing.description, 255),
    productId: Number(body.product_id ?? existing.product_id),
    startAt: mysqlDate(body.start_at, existing.start_at || new Date()),
    endAt: mysqlDate(body.end_at, existing.end_at || new Date(Date.now() + 7 * 86400000)),
    hideTime: boolFlag(body.hide_time ?? existing.hide_time),
    stock: Math.max(0, Number(body.stock ?? existing.stock ?? 0)),
    leadPrice: money(body.lead_price ?? existing.lead_price),
    settlePrice: money(body.settle_price ?? existing.settle_price ?? 0),
    perUserLimit: Math.max(0, Number(body.per_user_limit ?? existing.per_user_limit ?? 1)),
    perOrderLimit: Math.max(0, Number(body.per_order_limit ?? existing.per_order_limit ?? 1)),
    deliveryMethods: jsonField(body.delivery_methods, parseDbJson(existing.delivery_methods, ["express"])),
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
  async function ping() {
    await pool.query("SELECT 1");
  }

  async function settings(conn = pool) {
    const row = await one(conn, "SELECT * FROM app_settings WHERE id = 1");
    if (!row) throw appError(500, "系统设置缺失");
    return normalizeSettings(row);
  }

  async function getUser(userId, conn = pool) {
    const id = assertId(userId, "用户 ID");
    const user = await one(conn, "SELECT * FROM users WHERE id = :id", { id });
    if (!user) throw appError(404, "用户不存在");
    return normalizeUser(user);
  }

  async function listUserAddresses(userId, conn = pool) {
    const id = assertId(userId, "用户 ID");
    const user = await one(conn, "SELECT id FROM users WHERE id = :id", { id });
    if (!user) throw appError(404, "用户不存在");
    const rows = await many(conn, `
      SELECT *
      FROM user_addresses
      WHERE user_id = :userId
      ORDER BY is_default DESC, id DESC
    `, { userId: id });
    return rows.map(addressRow);
  }

  async function getDefaultAddress(userId, conn = pool) {
    const id = assertId(userId, "用户 ID");
    const row = await one(conn, `
      SELECT *
      FROM user_addresses
      WHERE user_id = :userId
      ORDER BY is_default DESC, id DESC
      LIMIT 1
    `, { userId: id });
    return row ? addressRow(row) : null;
  }

  async function saveUserAddress(body) {
    return tx(pool, async conn => {
      const userId = assertId(body.user_id, "用户 ID");
      const user = await one(conn, "SELECT id FROM users WHERE id = :id FOR UPDATE", { id: userId });
      if (!user) throw appError(404, "用户不存在");

      let existing = null;
      if (body.id) {
        existing = await one(conn, "SELECT * FROM user_addresses WHERE id = :id AND user_id = :userId FOR UPDATE", {
          id: assertId(body.id, "地址 ID"),
          userId
        });
        if (!existing) throw appError(404, "收货地址不存在");
      }

      const payload = addressPayload(body, existing || {});
      if (!payload.receiverName) throw appError(422, "收件人必填");
      if (!payload.phone) throw appError(422, "手机号必填");
      if (!payload.detail) throw appError(422, "详细地址必填");

      const countRow = await one(conn, "SELECT COUNT(*) count FROM user_addresses WHERE user_id = :userId", { userId });
      const shouldDefault = payload.isDefault || Number(countRow.count || 0) <= (existing ? 1 : 0);
      if (shouldDefault) {
        await conn.query("UPDATE user_addresses SET is_default = 0 WHERE user_id = :userId", { userId });
      }

      if (existing) {
        await conn.query(
          `UPDATE user_addresses
           SET receiver_name = :receiverName, phone = :phone, province = :province, city = :city,
               district = :district, detail = :detail, is_default = :isDefault
           WHERE id = :id AND user_id = :userId`,
          {
            ...payload,
            isDefault: shouldDefault ? 1 : payload.isDefault,
            id: existing.id,
            userId
          }
        );
      } else {
        await conn.query(
          `INSERT INTO user_addresses (user_id, receiver_name, phone, province, city, district, detail, is_default)
           VALUES (:userId, :receiverName, :phone, :province, :city, :district, :detail, :isDefault)`,
          {
            ...payload,
            userId,
            isDefault: shouldDefault ? 1 : payload.isDefault
          }
        );
      }

      const defaultCount = await one(conn, "SELECT COUNT(*) count FROM user_addresses WHERE user_id = :userId AND is_default = 1", { userId });
      if (!Number(defaultCount.count || 0)) {
        await conn.query(`
          UPDATE user_addresses
          SET is_default = 1
          WHERE user_id = :userId
          ORDER BY id DESC
          LIMIT 1
        `, { userId });
      }

      return listUserAddresses(userId, conn);
    });
  }

  async function resolveOrderAddress(conn, userId, body) {
    const addressId = Number(body.address_id || body.addressId || 0);
    if (addressId) {
      const row = await one(conn, "SELECT * FROM user_addresses WHERE id = :id AND user_id = :userId", {
        id: assertId(addressId, "地址 ID"),
        userId
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

    const fallback = await getDefaultAddress(userId, conn);
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

  async function bindParentIfPossible(conn, user, parentId) {
    const normalized = inviterIdFromScene(parentId);
    if (!normalized || user.parent_id || user.id === normalized) return user;
    const parent = await one(conn, "SELECT id FROM users WHERE id = :id", { id: normalized });
    if (!parent) return user;
    await conn.query(`
      UPDATE users
      SET parent_id = :parentId,
          first_parent_id = COALESCE(first_parent_id, :parentId)
      WHERE id = :userId AND parent_id IS NULL
    `, {
      parentId: normalized,
      userId: user.id
    });
    return getUser(user.id, conn);
  }

  async function login(body) {
    return tx(pool, async conn => {
      if (body.user_id) {
        let user = await getUser(Number(body.user_id), conn);
        user = await bindParentIfPossible(conn, user, body.parent_id || body.scene);
        return user;
      }

      const nickname = String(body.nickname || "微信用户").trim().slice(0, 24) || "微信用户";
      const initials = Array.from(nickname).slice(0, 2).join("").toUpperCase();
      const openid = body.openid ? String(body.openid).trim() : `dev_openid_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const [result] = await conn.query(
        `INSERT INTO users (openid, phone, nickname, avatar, parent_id, first_parent_id, distributor_status)
         VALUES (:openid, :phone, :nickname, :avatar, NULL, NULL, 'pending')`,
        {
          openid,
          phone: String(body.phone || "").trim(),
          nickname,
          avatar: initials
        }
      );
      let user = await getUser(result.insertId, conn);
      user = await bindParentIfPossible(conn, user, body.parent_id || body.scene);
      return user;
    });
  }

  async function wechatLogin(body) {
    return tx(pool, async conn => {
      const openid = String(body.openid || "").trim();
      if (!openid) throw appError(422, "missing openid");
      const scene = body.scene || body.parent_id;
      const nickname = String(body.userInfo?.nickName || displayNameFromOpenid(openid)).trim().slice(0, 24);
      const avatar = String(body.userInfo?.avatarUrl || avatarFromName(nickname)).trim().slice(0, 255);
      const token = newSessionToken();
      let user = await one(conn, "SELECT * FROM users WHERE openid = :openid FOR UPDATE", { openid });
      if (!user) {
        const [result] = await conn.query(
          `INSERT INTO users (openid, phone, nickname, avatar, parent_id, first_parent_id, distributor_status, session_token, session_key_cipher)
           VALUES (:openid, '', :nickname, :avatar, NULL, NULL, 'pending', :token, :sessionKey)`,
          {
            openid,
            nickname,
            avatar,
            token,
            sessionKey: String(body.sessionKey || "")
          }
        );
        user = await getUser(result.insertId, conn);
      } else {
        await conn.query(
          `UPDATE users
           SET session_token = :token,
               session_key_cipher = :sessionKey,
               nickname = CASE WHEN nickname = '' THEN :nickname ELSE nickname END,
               avatar = CASE WHEN avatar = '' THEN :avatar ELSE avatar END
           WHERE id = :id`,
          {
            id: user.id,
            token,
            sessionKey: String(body.sessionKey || ""),
            nickname,
            avatar
          }
        );
        user = await getUser(user.id, conn);
      }
      user = await bindParentIfPossible(conn, user, scene);
      return { user, token };
    });
  }

  async function bindInviter(body) {
    return tx(pool, async conn => {
      const user = await getUser(Number(body.user_id), conn);
      if (user.parent_id) throw appError(409, "该用户已经绑定推荐人");
      return bindParentIfPossible(conn, user, body.parent_id || body.scene);
    });
  }

  async function applyDistributor(body) {
    return tx(pool, async conn => {
      const user = await getUser(Number(body.user_id), conn);
      if (user.distributor_status !== "approved") {
        await conn.query("UPDATE users SET distributor_status = 'pending' WHERE id = :id", { id: user.id });
      }
      return getUser(user.id, conn);
    });
  }

  async function categories(conn = pool) {
    const rows = await many(conn, "SELECT DISTINCT category FROM products ORDER BY category");
    return ["全部", ...rows.map(row => row.category).filter(Boolean).filter(category => category !== "全部")];
  }

  async function listPublicProducts({ category = "全部", keyword = "" }) {
    const params = {
      category,
      keyword: `%${String(keyword).trim()}%`
    };
    const filters = ["status = 'on'"];
    if (category && category !== "全部") filters.push("category = :category");
    if (String(keyword).trim()) filters.push("(title LIKE :keyword OR description LIKE :keyword)");
    const products = await many(pool, `SELECT * FROM products WHERE ${filters.join(" AND ")} ORDER BY sales DESC, id DESC`, params);
    return {
      categories: await categories(),
      products: products.map(publicProduct)
    };
  }

  async function getPublicProduct(productId, conn = pool) {
    const product = await one(conn, "SELECT * FROM products WHERE id = :id AND status = 'on'", { id: assertId(productId, "商品 ID") });
    if (!product) throw appError(404, "商品不存在或已下架");
    return publicProduct(product);
  }

  async function listAdminProducts() {
    const rows = await many(pool, "SELECT * FROM products ORDER BY id DESC");
    return rows.map(publicProduct);
  }

  async function createProduct(body) {
    const payload = productPayload(body);
    if (!payload.title || payload.price <= 0) throw appError(422, "商品标题和销售价必填");
    const [result] = await pool.query(
      `INSERT INTO products (
         title, subtitle, product_no, barcode, category, brand, unit, market_price, price, cost_price,
         stock, sales, status, commission_rate, image_url, images_json, detail_html, description,
         weight, min_buy_qty, per_order_limit, per_user_limit, is_virtual, no_refund_after_pay,
         freight_template, delivery_methods, vip_enabled
       )
       VALUES (
         :title, :subtitle, :productNo, :barcode, :category, :brand, :unit, :marketPrice, :price, :costPrice,
         :stock, 0, :status, :commissionRate, :imageUrl, :imagesJson, :detailHtml, :description,
         :weight, :minBuyQty, :perOrderLimit, :perUserLimit, :isVirtual, :noRefundAfterPay,
         :freightTemplate, :deliveryMethods, :vipEnabled
       )`,
      payload
    );
    const product = await one(pool, "SELECT * FROM products WHERE id = :id", { id: result.insertId });
    return publicProduct(product);
  }

  async function updateProduct(productId, body) {
    const id = assertId(productId, "商品 ID");
    const existing = await one(pool, "SELECT * FROM products WHERE id = :id", { id });
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
       WHERE id = :id`,
      { ...next, id }
    );
    const product = await one(pool, "SELECT * FROM products WHERE id = :id", { id });
    return publicProduct(product);
  }

  function campaignSelect() {
    return `
      SELECT
        ac.*,
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
        (SELECT COUNT(*) FROM acquisition_qrcodes q WHERE q.campaign_id = ac.id) qrcode_count,
        (SELECT COUNT(*) FROM acquisition_relations r WHERE r.campaign_id = ac.id AND r.unlocked_at IS NULL) relation_count,
        (
          SELECT COUNT(*)
          FROM acquisition_orders ao
          JOIN orders o ON o.id = ao.order_id
          WHERE ao.campaign_id = ac.id AND o.status IN ('paid','shipped','received')
        ) order_count,
        (
          SELECT COALESCE(SUM(c.amount), 0)
          FROM acquisition_orders ao
          JOIN commissions c ON c.order_id = ao.order_id
          WHERE ao.campaign_id = ac.id AND c.status <> 'canceled'
        ) reward_total
      FROM acquisition_campaigns ac
      LEFT JOIN products p ON p.id = ac.product_id
    `;
  }

  async function listAcquisitionCampaigns({ status = "", keyword = "" } = {}) {
    const filters = [];
    const params = { keyword: `%${cleanText(keyword, "", 80)}%` };
    if (status) {
      filters.push("ac.status = :status");
      params.status = enumValue(status, ["draft", "published", "ended", "expired"], "");
    }
    if (cleanText(keyword)) filters.push("(ac.name LIKE :keyword OR p.title LIKE :keyword OR p.product_no LIKE :keyword)");
    const rows = await many(pool, `
      ${campaignSelect()}
      ${filters.length ? `WHERE ${filters.join(" AND ")}` : ""}
      ORDER BY ac.created_at DESC, ac.id DESC
      LIMIT 200
    `, params);
    return rows.map(campaignRow);
  }

  async function getAcquisitionCampaign(campaignId, conn = pool) {
    const id = assertId(campaignId, "拓客宝活动 ID");
    const row = await one(conn, `${campaignSelect()} WHERE ac.id = :id`, { id });
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

  async function listPublicAcquisitionCampaigns({ keyword = "" }) {
    const params = { keyword: `%${cleanText(keyword, "", 80)}%` };
    const filters = ["ac.status = 'published'", "ac.start_at <= UTC_TIMESTAMP()", "ac.end_at >= UTC_TIMESTAMP()"];
    if (cleanText(keyword)) filters.push("(ac.name LIKE :keyword OR p.title LIKE :keyword OR p.product_no LIKE :keyword)");
    const rows = await many(pool, `
      ${campaignSelect()}
      WHERE ${filters.join(" AND ")}
      ORDER BY ac.created_at DESC, ac.id DESC
    `, params);
    const campaigns = rows.map(campaignRow);
    return campaigns.slice(0, 1);
  }

  async function getActiveAcquisitionCampaign(userId = null, scene = "") {
    const rows = await many(pool, `
      ${campaignSelect()}
      WHERE ac.status = 'published'
        AND ac.start_at <= UTC_TIMESTAMP()
        AND ac.end_at >= UTC_TIMESTAMP()
      ORDER BY ac.updated_at DESC, ac.id DESC
      LIMIT 1
    `);
    if (!rows.length) return null;
    return getPublicAcquisitionCampaign(rows[0].id, userId, scene);
  }

  async function getPublicAcquisitionCampaign(campaignId, userId = null, scene = "") {
    const campaign = await getAcquisitionCampaign(campaignId);
    if (campaign.status !== "published") throw appError(404, "活动未发布");
    const now = Date.now();
    if (new Date(campaign.start_at).getTime() > now || new Date(campaign.end_at).getTime() < now) {
      throw appError(404, "活动不在有效期内");
    }
    if (userId) {
      campaign.relation = campaign.relation_mode === "activity_visit"
        ? await lockAcquisitionRelation(pool, campaign, Number(userId), scene, "visit")
        : await acquisitionRelationSnapshot(pool, campaign, Number(userId), scene, "visit");
    }
    if (campaign.active_qrcodes?.length) {
      const qrcodeId = campaign.active_qrcodes[0].id;
      await pool.query(
        "UPDATE acquisition_qrcodes SET shown_count = shown_count + 1 WHERE id = :qrcodeId",
        { qrcodeId }
      );
      campaign.active_qrcodes[0].shown_count += 1;
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

  async function createAcquisitionCampaign(body) {
    const payload = campaignPayload(body);
    if (!payload.name || !payload.productId || payload.leadPrice <= 0) throw appError(422, "活动主题、引流商品和引流价必填");
    const product = await one(pool, "SELECT id FROM products WHERE id = :id", { id: payload.productId });
    if (!product) throw appError(404, "引流商品不存在");
    return tx(pool, async conn => {
      if (payload.status === "published") {
        await conn.query("UPDATE acquisition_campaigns SET status = 'ended' WHERE status = 'published'");
      }
      const [result] = await conn.query(
        `INSERT INTO acquisition_campaigns (
          name, description, product_id, start_at, end_at, hide_time, stock, lead_price, settle_price,
          per_user_limit, per_order_limit, delivery_methods, free_shipping, show_store_address,
          verify_at_order_store, member_tag, post_pay_address, relation_mode, default_inviter_id,
          reward_issue_way, reward_permission, reward_rule, reward_level1, reward_level2, direct_pay_way,
          reward_multiple_enabled, reward_step_enabled, team_reward_enabled, team_reward_level1,
          team_reward_level2, lottery_enabled, lottery_config, qrcode_guide_image, team_qrcode_enabled,
          team_qrcode_types, traffic_config, share_cover, share_description, share_timeline_text,
          customer_service_qrcode, background_music, poster_config, form_schema, virtual_sold_count,
          virtual_share_count, virtual_browse_count, virtual_invite_count, virtual_rankings, status
        ) VALUES (
          :name, :description, :productId, :startAt, :endAt, :hideTime, :stock, :leadPrice, :settlePrice,
          :perUserLimit, :perOrderLimit, :deliveryMethods, :freeShipping, :showStoreAddress,
          :verifyAtOrderStore, :memberTag, :postPayAddress, :relationMode, :defaultInviterId,
          :rewardIssueWay, :rewardPermission, :rewardRule, :rewardLevel1, :rewardLevel2, :directPayWay,
          :rewardMultipleEnabled, :rewardStepEnabled, :teamRewardEnabled, :teamRewardLevel1,
          :teamRewardLevel2, :lotteryEnabled, :lotteryConfig, :qrcodeGuideImage, :teamQrcodeEnabled,
          :teamQrcodeTypes, :trafficConfig, :shareCover, :shareDescription, :shareTimelineText,
          :customerServiceQrcode, :backgroundMusic, :posterConfig, :formSchema, :virtualSoldCount,
          :virtualShareCount, :virtualBrowseCount, :virtualInviteCount, :virtualRankings, :status
        )`,
        payload
      );
      return getAcquisitionCampaign(result.insertId, conn);
    });
  }

  async function updateAcquisitionCampaign(campaignId, body) {
    const id = assertId(campaignId, "拓客宝活动 ID");
    const existing = await one(pool, "SELECT * FROM acquisition_campaigns WHERE id = :id", { id });
    if (!existing) throw appError(404, "拓客宝活动不存在");
    const payload = campaignPayload(body, existing);
    if (!payload.name || !payload.productId || payload.leadPrice <= 0) throw appError(422, "活动主题、引流商品和引流价必填");
    return tx(pool, async conn => {
      if (payload.status === "published") {
        await conn.query("UPDATE acquisition_campaigns SET status = 'ended' WHERE status = 'published' AND id <> :id", { id });
      }
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
         WHERE id = :id`,
        { ...payload, id }
      );
      return getAcquisitionCampaign(id, conn);
    });
  }

  async function patchAcquisitionCampaign(campaignId, body) {
    const id = assertId(campaignId, "拓客宝活动 ID");
    const action = String(body.action || "");
    const statusMap = { publish: "published", end: "ended", expire: "expired", draft: "draft" };
    if (!statusMap[action]) throw appError(422, "未知活动操作");
    return tx(pool, async conn => {
      if (action === "publish") {
        await conn.query("UPDATE acquisition_campaigns SET status = 'ended' WHERE status = 'published' AND id <> :id", { id });
      }
      await conn.query("UPDATE acquisition_campaigns SET status = :status WHERE id = :id", { id, status: statusMap[action] });
      return getAcquisitionCampaign(id, conn);
    });
  }

  async function saveAcquisitionQrcode(campaignId, body) {
    const campaign = await getAcquisitionCampaign(campaignId);
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
    return getAcquisitionCampaign(campaign.id);
  }

  async function deleteAcquisitionQrcode(campaignId, qrcodeId) {
    const campaign = await getAcquisitionCampaign(campaignId);
    await pool.query("DELETE FROM acquisition_qrcodes WHERE id = :qrcodeId AND campaign_id = :campaignId", {
      qrcodeId: assertId(qrcodeId, "引流码 ID"),
      campaignId: campaign.id
    });
    return getAcquisitionCampaign(campaign.id);
  }

  async function listAcquisitionRelations(campaignId) {
    const id = assertId(campaignId, "拓客宝活动 ID");
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
      WHERE r.campaign_id = :id
      ORDER BY r.entered_at DESC
      LIMIT 200
    `, { id });
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

  async function listAcquisitionOrders(campaignId) {
    const id = assertId(campaignId, "拓客宝活动 ID");
    const rows = await loadOrderRows("JOIN acquisition_orders ao ON ao.order_id = o.id WHERE ao.campaign_id = :campaignId", { campaignId: id });
    return rows.map(orderRow);
  }

  async function listAcquisitionRewards(campaignId) {
    const id = assertId(campaignId, "拓客宝活动 ID");
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
        buyer.nickname buyer_nickname, buyer.phone buyer_phone, buyer.avatar buyer_avatar,
        b.nickname beneficiary_nickname, b.phone beneficiary_phone, b.avatar beneficiary_avatar
      FROM acquisition_orders ao
      JOIN commissions c ON c.order_id = ao.order_id
      LEFT JOIN orders o ON o.id = c.order_id
      LEFT JOIN products p ON p.id = o.product_id
      LEFT JOIN users buyer ON buyer.id = c.buyer_id
      LEFT JOIN users b ON b.id = c.beneficiary_id
      WHERE ao.campaign_id = :id
      ORDER BY c.created_at DESC, c.id DESC
      LIMIT 300
    `, { id });
    return rows.map(commissionRow);
  }

  async function acquisitionDashboard(campaignId) {
    const id = assertId(campaignId, "拓客宝活动 ID");
    const campaign = await getAcquisitionCampaign(id);
    const totals = await one(pool, `
      SELECT
        (SELECT COUNT(DISTINCT member_id) FROM acquisition_relations WHERE campaign_id = :id) visitors,
        (
          SELECT COUNT(DISTINCT ao.order_id)
          FROM acquisition_orders ao
          JOIN orders o ON o.id = ao.order_id
          WHERE ao.campaign_id = :id AND o.status IN ('paid','shipped','received')
        ) orders,
        (
          SELECT COALESCE(SUM(o.amount), 0)
          FROM acquisition_orders ao
          JOIN orders o ON o.id = ao.order_id
          WHERE ao.campaign_id = :id AND o.status IN ('paid','shipped','received')
        ) order_amount,
        (
          SELECT COALESCE(SUM(o.amount), 0)
          FROM acquisition_orders ao
          JOIN orders o ON o.id = ao.order_id
          WHERE ao.campaign_id = :id AND o.status IN ('paid','shipped','received')
        ) paid_amount,
        (
          SELECT COALESCE(SUM(c.amount), 0)
          FROM acquisition_orders ao
          JOIN commissions c ON c.order_id = ao.order_id
          WHERE ao.campaign_id = :id AND c.status <> 'canceled'
        ) reward_amount
    `, { id }) || {};
    const relationRows = await many(pool, `
      SELECT inviter_id, COUNT(*) fans
      FROM acquisition_relations
      WHERE campaign_id = :id AND inviter_id IS NOT NULL
      GROUP BY inviter_id
      ORDER BY fans DESC
      LIMIT 20
    `, { id });
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

  async function listAcquisitionMaterials() {
    const rows = await many(pool, "SELECT * FROM acquisition_materials ORDER BY type, sort_order, id DESC");
    return rows.map(materialRow);
  }

  async function saveAcquisitionMaterial(body) {
    const payload = {
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
         WHERE id = :id`,
        { ...payload, id }
      );
    } else {
      await pool.query(
        `INSERT INTO acquisition_materials (type, image_url, style_config, sort_order)
         VALUES (:type, :imageUrl, :styleConfig, :sortOrder)`,
        payload
      );
    }
    return listAcquisitionMaterials();
  }

  async function loadOrderRows(whereSql, params = {}, conn = pool) {
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
        u.openid user_openid, u.phone user_phone, u.nickname user_nickname, u.avatar user_avatar,
        u.parent_id user_parent_id, u.first_parent_id user_first_parent_id,
        u.distributor_status user_distributor_status, u.created_at user_created_at
      FROM orders o
      LEFT JOIN products p ON p.id = o.product_id
      LEFT JOIN users u ON u.id = o.user_id
      ${whereSql}
      ORDER BY o.created_at DESC, o.id DESC
    `, params);
  }

  async function listOrders({ userId = null }) {
    const rows = await loadOrderRows(userId ? "WHERE o.user_id = :userId" : "", { userId });
    return rows.map(orderRow);
  }

  async function createCommissionsForOrder(conn, order, buyer, product) {
    if (!buyer.parent_id) return [];
    const appSettings = await settings(conn);
    const created = [];
    const parent = await one(conn, "SELECT * FROM users WHERE id = :id AND distributor_status = 'approved'", { id: buyer.parent_id });
    if (parent) {
      const amount = money(order.amount * Number(product.commission_rate || appSettings.commission_level_1));
      const [result] = await conn.query(
        `INSERT INTO commissions (order_id, beneficiary_id, buyer_id, level, amount, status)
         VALUES (:orderId, :beneficiaryId, :buyerId, 1, :amount, 'pending')`,
        { orderId: order.id, beneficiaryId: parent.id, buyerId: buyer.id, amount }
      );
      created.push({ id: result.insertId, order_id: order.id, beneficiary_id: parent.id, buyer_id: buyer.id, level: 1, amount, status: "pending" });
    }
    if (parent && parent.parent_id) {
      const grandParent = await one(conn, "SELECT * FROM users WHERE id = :id AND distributor_status = 'approved'", { id: parent.parent_id });
      if (grandParent) {
        const amount = money(order.amount * Number(appSettings.commission_level_2 || 0));
        const [result] = await conn.query(
          `INSERT INTO commissions (order_id, beneficiary_id, buyer_id, level, amount, status)
           VALUES (:orderId, :beneficiaryId, :buyerId, 2, :amount, 'pending')`,
          { orderId: order.id, beneficiaryId: grandParent.id, buyerId: buyer.id, amount }
        );
        created.push({ id: result.insertId, order_id: order.id, beneficiary_id: grandParent.id, buyer_id: buyer.id, level: 2, amount, status: "pending" });
      }
    }
    return created;
  }

  async function acquisitionRelationSnapshot(conn, campaign, userId, scene = "", lockReason = "visit") {
    const memberId = assertId(userId, "用户 ID");
    const member = await one(conn, "SELECT * FROM users WHERE id = :id", { id: memberId });
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
      inviterId = sceneInviter && sceneInviter !== memberId ? sceneInviter : (campaign.default_inviter_id || null);
      lockedBy = lockReason === "paid" ? "paid" : "visit";
    }

    if (inviterId) {
      const inviter = await one(conn, "SELECT id, parent_id, first_parent_id FROM users WHERE id = :id", { id: inviterId });
      if (!inviter) inviterId = null;
      else parentInviterId = campaign.relation_mode === "first"
        ? (inviter.first_parent_id || inviter.parent_id || null)
        : (inviter.parent_id || null);
    }

    return {
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

  async function lockAcquisitionRelation(conn, campaign, userId, scene = "", lockReason = "visit") {
    const memberId = assertId(userId, "用户 ID");
    const existing = await one(conn, "SELECT * FROM acquisition_relations WHERE campaign_id = :campaignId AND member_id = :memberId FOR UPDATE", {
      campaignId: campaign.id,
      memberId
    });
    if (existing && (campaign.relation_mode === "activity_visit" || campaign.relation_mode === "activity_paid")) return existing;

    const relation = await acquisitionRelationSnapshot(conn, campaign, memberId, scene, lockReason);
    if (existing) {
      await conn.query(
        `UPDATE acquisition_relations
         SET inviter_id = :inviterId,
             parent_inviter_id = :parentInviterId,
             team_leader_id = :teamLeaderId,
             indirect_team_leader_id = :indirectTeamLeaderId,
             locked_by = :lockedBy,
             unlocked_at = NULL
         WHERE campaign_id = :campaignId AND member_id = :memberId`,
        {
          campaignId: campaign.id,
          memberId,
          inviterId: relation.inviter_id,
          parentInviterId: relation.parent_inviter_id,
          teamLeaderId: relation.team_leader_id,
          indirectTeamLeaderId: relation.indirect_team_leader_id,
          lockedBy: relation.locked_by
        }
      );
      return one(conn, "SELECT * FROM acquisition_relations WHERE campaign_id = :campaignId AND member_id = :memberId", {
        campaignId: campaign.id,
        memberId
      });
    }

    await conn.query(
      `INSERT INTO acquisition_relations (
        campaign_id, member_id, inviter_id, parent_inviter_id, team_leader_id,
        indirect_team_leader_id, locked_by
      ) VALUES (
        :campaignId, :memberId, :inviterId, :parentInviterId, :teamLeaderId,
        :indirectTeamLeaderId, :lockedBy
      )`,
      {
        campaignId: campaign.id,
        memberId,
        inviterId: relation.inviter_id,
        parentInviterId: relation.parent_inviter_id,
        teamLeaderId: relation.team_leader_id,
        indirectTeamLeaderId: relation.indirect_team_leader_id,
        lockedBy: relation.locked_by
      }
    );
    return one(conn, "SELECT * FROM acquisition_relations WHERE campaign_id = :campaignId AND member_id = :memberId", {
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

  async function acquisitionBuyerOrderCount(conn, campaignId, userId) {
    const row = await one(conn, `
      SELECT COUNT(*) count
      FROM acquisition_orders ao
      JOIN orders o ON o.id = ao.order_id
      WHERE ao.campaign_id = :campaignId
        AND o.user_id = :userId
        AND o.status IN ('paid','shipped','received')
    `, { campaignId, userId });
    return Number(row?.count || 0);
  }

  async function acquisitionDirectOrderCount(conn, campaignId, inviterId) {
    const row = await one(conn, `
      SELECT COUNT(*) count
      FROM acquisition_orders ao
      JOIN orders o ON o.id = ao.order_id
      WHERE ao.campaign_id = :campaignId
        AND ao.inviter_id = :inviterId
        AND o.status IN ('paid','shipped','received')
    `, { campaignId, inviterId });
    return Number(row?.count || 0);
  }

  async function canReceiveAcquisitionReward(conn, campaign, userId, options = {}) {
    if (!userId) return false;
    if (options.buyerId && Number(userId) === Number(options.buyerId)) return false;
    const user = await one(conn, "SELECT id, distributor_status FROM users WHERE id = :id", { id: userId });
    if (!user) return false;
    if (options.teamReward) return true;
    if (campaign.reward_rule === "member_level" && user.distributor_status !== "approved") return false;
    if (campaign.reward_permission === "buyer_only") {
      return (await acquisitionBuyerOrderCount(conn, campaign.id, userId)) > 0;
    }
    return true;
  }

  async function insertAcquisitionCommission(conn, order, buyer, campaign, reward) {
    if (!reward.userId || money(reward.amount) <= 0) return null;
    const allowed = await canReceiveAcquisitionReward(conn, campaign, reward.userId, {
      buyerId: buyer.id,
      teamReward: reward.teamReward
    });
    if (!allowed) return null;
    const status = acquisitionCommissionStatus(campaign);
    const availableAt = status === "withdrawable" ? new Date() : null;
    const [result] = await conn.query(
      `INSERT INTO commissions (order_id, beneficiary_id, buyer_id, level, amount, status, available_at)
       VALUES (:orderId, :beneficiaryId, :buyerId, :level, :amount, :status, :availableAt)`,
      {
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
      const directCount = await acquisitionDirectOrderCount(conn, campaign.id, relation.inviter_id);
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
    if (campaign.reward_issue_way !== "instant" || !commissions.length) return [];
    const appSettings = await settings(conn);
    const status = appSettings.auto_pay_enabled ? "paidout" : "approved";
    const reviewNote = appSettings.auto_pay_enabled
      ? "系统自动模拟企业付款到零钱"
      : "待后台企业付款到零钱";
    const created = [];
    for (const commission of commissions) {
      const [result] = await conn.query(
        `INSERT INTO withdrawals (user_id, amount, status, note, reviewed_at, review_note)
         VALUES (:userId, :amount, :status, :note, UTC_TIMESTAMP(), :reviewNote)`,
        {
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

  async function availableLotteryPrize(conn, campaign, userId, prize) {
    if (prize.type === "thanks") return true;
    if (prize.quantity > 0) {
      const used = await one(conn, `
        SELECT COUNT(*) used
        FROM acquisition_lottery_records
        WHERE campaign_id = :campaignId AND prize_name = :prizeName AND status <> 'failed'
      `, { campaignId: campaign.id, prizeName: prize.name });
      if (Number(used.used || 0) >= prize.quantity) return false;
    }
    if (prize.limit_per_user > 0) {
      const userUsed = await one(conn, `
        SELECT COUNT(*) used
        FROM acquisition_lottery_records
        WHERE campaign_id = :campaignId AND user_id = :userId AND prize_name = :prizeName AND status <> 'failed'
      `, { campaignId: campaign.id, userId, prizeName: prize.name });
      if (Number(userUsed.used || 0) >= prize.limit_per_user) return false;
    }
    return true;
  }

  async function runAcquisitionLottery(conn, campaign, order, buyer) {
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
    if (!(await availableLotteryPrize(conn, campaign, buyer.id, selected))) {
      selected = thanksPrize();
    }
    const status = selected.type === "thanks" || config.cash_direct ? "issued" : "pending";
    const [result] = await conn.query(
      `INSERT INTO acquisition_lottery_records (
        campaign_id, order_id, user_id, prize_name, prize_type, prize_image,
        quantity, amount, status
      ) VALUES (
        :campaignId, :orderId, :userId, :prizeName, :prizeType, :prizeImage,
        :quantity, :amount, :status
      )`,
      {
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
      formValues: parseDbJson(row.form_values, {}),
      scene: row.scene || ""
    };
  }

  async function closeUnpaidOrder(orderId) {
    return tx(pool, async conn => {
      const id = assertId(orderId, "订单 ID");
      const order = await one(conn, "SELECT * FROM orders WHERE id = :id FOR UPDATE", { id });
      if (!order) throw appError(404, "订单不存在");
      if (order.status !== "unpaid") {
        const rows = await loadOrderRows("WHERE o.id = :id", { id }, conn);
        return orderRow(rows[0]);
      }
      const meta = await acquisitionOrderMeta(conn, order.id);
      await conn.query("UPDATE orders SET status = 'closed' WHERE id = :id", { id });
      await conn.query(
        "UPDATE products SET stock = stock + :quantity, sales = GREATEST(sales - :quantity, 0) WHERE id = :productId",
        { quantity: order.quantity, productId: order.product_id }
      );
      if (meta) {
        await conn.query(
          "UPDATE acquisition_campaigns SET sold_count = GREATEST(sold_count - :quantity, 0) WHERE id = :campaignId",
          { quantity: order.quantity, campaignId: meta.campaignId }
        );
      }
      const rows = await loadOrderRows("WHERE o.id = :id", { id }, conn);
      return orderRow(rows[0]);
    });
  }

  async function finalizePaidOrder(conn, order, payInfo = {}) {
    if (["paid", "shipped", "received"].includes(order.status)) {
      const lotteryRecord = await one(conn, "SELECT * FROM acquisition_lottery_records WHERE order_id = :orderId ORDER BY id DESC LIMIT 1", { orderId: order.id });
      const rows = await loadOrderRows("WHERE o.id = :id", { id: order.id }, conn);
      return {
        order: orderRow(rows[0]),
        lottery_record: lotteryRecord || null,
        commissions: []
      };
    }
    if (order.status !== "unpaid") throw appError(409, "订单状态不能支付");
    const buyer = await one(conn, "SELECT * FROM users WHERE id = :id FOR UPDATE", { id: order.user_id });
    if (!buyer) throw appError(404, "用户不存在");
    const product = await one(conn, "SELECT * FROM products WHERE id = :id", { id: order.product_id });
    if (!product) throw appError(404, "商品不存在");
    const meta = await acquisitionOrderMeta(conn, order.id);
    let campaign = null;
    let relation = null;
    let commissions = [];
    let lotteryRecord = null;
    if (meta) {
      const row = await one(conn, `${campaignSelect()} WHERE ac.id = :id FOR UPDATE`, { id: meta.campaignId });
      if (!row) throw appError(404, "拓客宝活动不存在");
      campaign = campaignRow(row);
      relation = await lockAcquisitionRelation(conn, campaign, buyer.id, meta.scene, "paid");
      await conn.query(`
        UPDATE acquisition_orders
        SET inviter_id = :inviterId,
            parent_inviter_id = :parentInviterId,
            team_leader_id = :teamLeaderId,
            indirect_team_leader_id = :indirectTeamLeaderId
        WHERE order_id = :orderId
      `, {
        orderId: order.id,
        inviterId: relation?.inviter_id || null,
        parentInviterId: relation?.parent_inviter_id || null,
        teamLeaderId: relation?.team_leader_id || null,
        indirectTeamLeaderId: relation?.indirect_team_leader_id || null
      });
    }
    await conn.query(`
      UPDATE orders
      SET status = 'paid',
          transaction_id = CASE WHEN :transactionId <> '' THEN :transactionId ELSE transaction_id END,
          paid_at = COALESCE(paid_at, UTC_TIMESTAMP())
      WHERE id = :id
    `, {
      id: order.id,
      transactionId: cleanText(payInfo.transaction_id, "", 64)
    });
    const paidOrder = await one(conn, "SELECT * FROM orders WHERE id = :id", { id: order.id });
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

  async function createOrder(body) {
    const created = await tx(pool, async conn => {
      const userId = assertId(body.user_id, "用户 ID");
      const campaignId = Number(body.campaign_id || 0);
      const quantity = Math.max(1, Math.min(99, Number(body.quantity || 1)));
      const buyer = await one(conn, "SELECT * FROM users WHERE id = :id FOR UPDATE", { id: userId });
      if (!buyer) throw appError(404, "用户不存在");
      let productId = campaignId ? Number(body.product_id || 0) : assertId(body.product_id, "商品 ID");
      let campaign = null;
      if (campaignId) {
        const row = await one(conn, `${campaignSelect()} WHERE ac.id = :id FOR UPDATE`, { id: assertId(campaignId, "拓客宝活动 ID") });
        if (!row) throw appError(404, "拓客宝活动不存在");
        campaign = campaignRow(row);
        if (campaign.status !== "published") throw appError(409, "活动未发布");
        const now = Date.now();
        if (new Date(campaign.start_at).getTime() > now || new Date(campaign.end_at).getTime() < now) throw appError(409, "活动不在有效期内");
        if (campaign.per_order_limit && quantity > campaign.per_order_limit) throw appError(409, `每单最多购买 ${campaign.per_order_limit} 件`);
        const purchased = await one(conn, `
          SELECT COALESCE(SUM(o.quantity), 0) total
          FROM acquisition_orders ao
          JOIN orders o ON o.id = ao.order_id
          WHERE ao.campaign_id = :campaignId AND o.user_id = :userId AND o.status IN ('paid','shipped','received')
        `, { campaignId: campaign.id, userId: buyer.id });
        if (campaign.per_user_limit && Number(purchased.total || 0) + quantity > campaign.per_user_limit) throw appError(409, `每人最多购买 ${campaign.per_user_limit} 件`);
        if (Number(campaign.stock) - Number(campaign.sold_count || 0) < quantity) throw appError(409, "活动库存不足");
        productId = campaign.product_id;
      }
      const product = await one(conn, "SELECT * FROM products WHERE id = :id AND status = 'on' FOR UPDATE", { id: productId });
      if (!product) throw appError(404, "商品不存在或已下架");
      if (Number(product.stock) < quantity) throw appError(409, "库存不足");
      const orderAddress = await resolveOrderAddress(conn, buyer.id, body);

      const amount = money(Number(campaign ? campaign.lead_price : product.price) * quantity);
      await conn.query(
        "UPDATE products SET stock = stock - :quantity, sales = sales + :quantity WHERE id = :id AND stock >= :quantity",
        { quantity, id: product.id }
      );
      if (campaign) {
        const [stockResult] = await conn.query(
          `UPDATE acquisition_campaigns
           SET sold_count = sold_count + :quantity
           WHERE id = :id AND stock >= sold_count + :quantity`,
          { quantity, id: campaign.id }
        );
        if (!stockResult.affectedRows) throw appError(409, "活动库存不足");
      }
      const [result] = await conn.query(
        `INSERT INTO orders (user_id, product_id, quantity, amount, status, pay_provider, address, address_id)
         VALUES (:userId, :productId, :quantity, :amount, 'unpaid', 'wechat', :address, :addressId)`,
        {
          userId: buyer.id,
          productId: product.id,
          quantity,
          amount,
          address: orderAddress.addressText,
          addressId: orderAddress.addressId
        }
      );
      const tradeNo = outTradeNo(result.insertId);
      await conn.query("UPDATE orders SET out_trade_no = :tradeNo WHERE id = :id", { id: result.insertId, tradeNo });
      const order = await one(conn, "SELECT * FROM orders WHERE id = :id", { id: result.insertId });
      if (campaign) {
        await conn.query(
          `INSERT INTO acquisition_orders (
            campaign_id, order_id, form_values, scene
          ) VALUES (
            :campaignId, :orderId, :formValues, :scene
          )`,
          {
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
        campaign
      };
    });
    let prepay;
    try {
      prepay = await createJsapiPrepay({
        outTradeNo: created.order.out_trade_no,
        description: created.description,
        amount: created.order.amount,
        openid: created.buyer.openid,
        attach: created.campaign ? JSON.stringify({ campaign_id: created.campaign.id }) : ""
      });
    } catch (error) {
      await closeUnpaidOrder(created.order.id);
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
        params: jsapiPayParams(prepay.prepay_id)
      },
      commissions: [],
      lottery_record: null
    };
  }

  async function syncWechatPayment(orderId) {
    const id = assertId(orderId, "订单 ID");
    const order = await one(pool, "SELECT * FROM orders WHERE id = :id", { id });
    if (!order) throw appError(404, "订单不存在");
    if (["paid", "shipped", "received"].includes(order.status)) {
      return tx(pool, conn => finalizePaidOrder(conn, order));
    }
    if (!order.out_trade_no) throw appError(409, "订单缺少商户单号");
    const result = await queryOrder(order.out_trade_no);
    if (result.trade_state !== "SUCCESS") {
      throw appError(409, result.trade_state_desc || "支付尚未完成", { trade_state: result.trade_state });
    }
    if (Number(result.amount?.total || 0) !== yuanToFen(order.amount)) {
      throw appError(409, "支付金额不一致");
    }
    return tx(pool, async conn => {
      const locked = await one(conn, "SELECT * FROM orders WHERE id = :id FOR UPDATE", { id });
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

  async function confirmOrder(orderId) {
    return tx(pool, async conn => {
      const id = assertId(orderId, "订单 ID");
      const order = await one(conn, "SELECT * FROM orders WHERE id = :id FOR UPDATE", { id });
      if (!order) throw appError(404, "订单不存在");
      if (!["paid", "shipped"].includes(order.status)) throw appError(409, "当前订单状态不能确认收货");
      await conn.query("UPDATE orders SET status = 'received', received_at = UTC_TIMESTAMP() WHERE id = :id", { id });
      await conn.query(
        "UPDATE commissions SET status = 'withdrawable', available_at = UTC_TIMESTAMP() WHERE order_id = :id AND status = 'pending'",
        { id }
      );
      const rows = await loadOrderRows("WHERE o.id = :id", { id }, conn);
      return orderRow(rows[0]);
    });
  }

  async function patchOrder(orderId, body) {
    return tx(pool, async conn => {
      const id = assertId(orderId, "订单 ID");
      const order = await one(conn, "SELECT * FROM orders WHERE id = :id FOR UPDATE", { id });
      if (!order) throw appError(404, "订单不存在");
      if (body.action === "ship") {
        if (order.status !== "paid") throw appError(409, "只有已付款订单可以发货");
        await conn.query("UPDATE orders SET status = 'shipped', logistics_no = :logisticsNo WHERE id = :id", {
          id,
          logisticsNo: String(body.logistics_no || `SF${Date.now()}`).trim()
        });
      } else if (body.action === "refund") {
        if (order.status === "refunded") throw appError(409, "订单已经退款");
        await conn.query("UPDATE orders SET status = 'refunded' WHERE id = :id", { id });
        await conn.query("UPDATE commissions SET status = 'canceled' WHERE order_id = :id", { id });
        await conn.query(
          `UPDATE withdrawals w
           JOIN commissions c ON c.beneficiary_id = w.user_id
             AND c.order_id = :id
             AND w.note = CONCAT('拓客宝直接到账 订单#', c.order_id)
           SET w.status = 'rejected',
               w.review_note = '订单退款，直接到账奖励取消',
               w.reviewed_at = UTC_TIMESTAMP()
           WHERE w.status IN ('pending','approved')`,
          { id }
        );
        await conn.query("UPDATE products SET stock = stock + :quantity WHERE id = :productId", {
          quantity: order.quantity,
          productId: order.product_id
        });
      } else if (body.action === "receive") {
        await conn.query("UPDATE orders SET status = 'received', received_at = UTC_TIMESTAMP() WHERE id = :id", { id });
        await conn.query(
          "UPDATE commissions SET status = 'withdrawable', available_at = UTC_TIMESTAMP() WHERE order_id = :id AND status = 'pending'",
          { id }
        );
      } else {
        throw appError(422, "未知订单操作");
      }
      const rows = await loadOrderRows("WHERE o.id = :id", { id }, conn);
      return orderRow(rows[0]);
    });
  }

  async function userAvailableBalance(userId, conn = pool) {
    const rows = await many(conn, `
      SELECT
        COALESCE(SUM(CASE WHEN c.status = 'withdrawable' THEN c.amount ELSE 0 END), 0) gross,
        (
          SELECT COALESCE(SUM(w.amount), 0)
          FROM withdrawals w
          WHERE w.user_id = :userId AND w.status <> 'rejected'
        ) locked
      FROM commissions c
      WHERE c.beneficiary_id = :userId
    `, { userId });
    return money(Math.max(0, Number(rows[0].gross || 0) - Number(rows[0].locked || 0)));
  }

  async function listCommissions({ userId = null } = {}) {
    const where = userId ? "WHERE c.beneficiary_id = :userId" : "";
    const rows = await many(pool, `
      SELECT
        c.*,
        o.amount order_amount, o.status order_status, o.created_at order_created_at,
        p.id product_id, p.title product_title, p.category product_category, p.price product_price,
        p.stock product_stock, p.sales product_sales, p.status product_status,
        p.commission_rate product_commission_rate, p.image_url product_image_url,
        p.description product_description, p.created_at product_created_at,
        buyer.nickname buyer_nickname, buyer.phone buyer_phone, buyer.avatar buyer_avatar,
        b.nickname beneficiary_nickname, b.phone beneficiary_phone, b.avatar beneficiary_avatar
      FROM commissions c
      LEFT JOIN orders o ON o.id = c.order_id
      LEFT JOIN products p ON p.id = o.product_id
      LEFT JOIN users buyer ON buyer.id = c.buyer_id
      LEFT JOIN users b ON b.id = c.beneficiary_id
      ${where}
      ORDER BY c.created_at DESC, c.id DESC
    `, { userId });
    return rows.map(commissionRow);
  }

  async function distributionSummary(userId) {
    const id = assertId(userId, "用户 ID");
    const user = await getUser(id);
    const appSettings = await settings();
    const directCustomers = await many(pool, `
      SELECT u.*, (SELECT COUNT(*) FROM users child WHERE child.parent_id = u.id) children_count
      FROM users u
      WHERE u.parent_id = :id
      ORDER BY u.created_at DESC
    `, { id });
    const [indirect] = await many(pool, `
      SELECT COUNT(*) indirect_count
      FROM users child
      JOIN users direct ON direct.id = child.parent_id
      WHERE direct.parent_id = :id
    `, { id });
    const commissions = await listCommissions({ userId: id });
    const rows = await many(pool, `
      SELECT
        COALESCE(SUM(CASE WHEN status <> 'canceled' AND DATE(created_at) = UTC_DATE() THEN amount ELSE 0 END), 0) today,
        COALESCE(SUM(CASE WHEN status <> 'canceled' THEN amount ELSE 0 END), 0) total,
        COALESCE(SUM(CASE WHEN status = 'pending' THEN amount ELSE 0 END), 0) pending
      FROM commissions
      WHERE beneficiary_id = :id
    `, { id });
    const withdrawnRows = await many(pool, "SELECT COALESCE(SUM(amount), 0) withdrawn FROM withdrawals WHERE user_id = :id AND status = 'paidout'", { id });
    const withdrawals = await many(pool, "SELECT * FROM withdrawals WHERE user_id = :id ORDER BY created_at DESC, id DESC", { id });
    return {
      user,
      settings: appSettings,
      today: money(rows[0].today),
      total: money(rows[0].total),
      pending: money(rows[0].pending),
      withdrawable: await userAvailableBalance(id),
      withdrawn: money(withdrawnRows[0].withdrawn),
      direct_count: directCustomers.length,
      indirect_count: Number(indirect.indirect_count || 0),
      customers: directCustomers.map(row => ({ ...normalizeUser(row), children_count: Number(row.children_count || 0) })),
      commissions,
      withdrawals
    };
  }

  async function createWithdrawal(body) {
    return tx(pool, async conn => {
      const userId = assertId(body.user_id, "用户 ID");
      const amount = money(body.amount);
      await getUser(userId, conn);
      const appSettings = await settings(conn);
      if (amount < Number(appSettings.min_withdrawal || 0)) {
        throw appError(422, `最低提现金额为 ${appSettings.min_withdrawal} 元`);
      }
      const available = await userAvailableBalance(userId, conn);
      if (amount > available) {
        throw appError(422, "可提现余额不足", { available });
      }
      const [result] = await conn.query(
        `INSERT INTO withdrawals (user_id, amount, status, note)
         VALUES (:userId, :amount, 'pending', :note)`,
        { userId, amount, note: String(body.note || "").slice(0, 80) }
      );
      return one(conn, "SELECT * FROM withdrawals WHERE id = :id", { id: result.insertId });
    });
  }

  async function sharePoster({ userId, productId }) {
    const user = await getUser(userId);
    const product = await getPublicProduct(productId);
    const appSettings = await settings();
    const paths = productAssetPaths(product.id, user.id);
    let qrcodeBuffer;
    try {
      qrcodeBuffer = await fs.readFile(paths.qrcodePath);
    } catch {
      qrcodeBuffer = await getUnlimitedQRCode({
        scene: paths.scene,
        page: "pages/product/detail",
        checkPath: false
      });
      await fs.mkdir(path.dirname(paths.qrcodePath), { recursive: true });
      await fs.writeFile(paths.qrcodePath, qrcodeBuffer);
    }

    await buildProductPoster({
      product,
      user,
      qrcodeBuffer,
      outputPath: paths.posterPath,
      complianceName: appSettings.compliance_name
    });

    return {
      product,
      user,
      scene: paths.scene,
      page: "pages/product/detail",
      path: `/pages/product/detail?id=${product.id}&scene=${paths.scene}`,
      qrcode_url: paths.qrcodeUrl,
      poster_url: paths.posterUrl,
      qr_payload: `product:${product.id};referrer:${user.id}`,
      compliance_name: appSettings.compliance_name
    };
  }

  async function campaignInvitePoster({ userId, campaignId }) {
    const user = await getUser(userId);
    const campaign = await getAcquisitionCampaign(campaignId);
    if (campaign.status !== "published") throw appError(404, "活动未发布");
    const now = Date.now();
    if (new Date(campaign.start_at).getTime() > now || new Date(campaign.end_at).getTime() < now) {
      throw appError(404, "活动不在有效期内");
    }

    const paths = inviteAssetPaths(campaign.id, user.id);
    let qrcodeBuffer;
    try {
      qrcodeBuffer = await fs.readFile(paths.qrcodePath);
    } catch {
      qrcodeBuffer = await getUnlimitedQRCode({
        scene: paths.scene,
        page: "pages/home/index",
        checkPath: false
      });
      await fs.mkdir(path.dirname(paths.qrcodePath), { recursive: true });
      await fs.writeFile(paths.qrcodePath, qrcodeBuffer);
    }

    await buildInvitePoster({
      campaign,
      user,
      qrcodeBuffer,
      outputPath: paths.posterPath
    });

    return {
      campaign,
      user,
      scene: paths.scene,
      page: "pages/home/index",
      path: `/pages/home/index?campaign_id=${campaign.id}&scene=${paths.scene}`,
      qrcode_url: paths.qrcodeUrl,
      poster_url: paths.posterUrl,
      qr_payload: `campaign:${campaign.id};referrer:${user.id}`
    };
  }

  async function dashboard() {
    const metrics = await one(pool, `
      SELECT
        COALESCE(SUM(CASE WHEN o.status IN ('paid','shipped','received') THEN o.amount ELSE 0 END), 0) sales,
        COALESCE(SUM(CASE WHEN o.status IN ('paid','shipped','received') THEN o.amount ELSE 0 END), 0) paid_sales,
        COALESCE(SUM(CASE WHEN o.status IN ('paid','shipped','received') THEN 1 ELSE 0 END), 0) orders,
        (SELECT COUNT(*) FROM users) users,
        (SELECT COUNT(*) FROM products WHERE status = 'on') products_on,
        (SELECT COALESCE(SUM(amount), 0) FROM commissions WHERE status <> 'canceled') commission,
        (SELECT COALESCE(SUM(amount), 0) FROM withdrawals WHERE status = 'pending') pending_withdrawals
      FROM orders o
    `);
    const recentRows = await loadOrderRows("", {});
    const topRows = await many(pool, `
      SELECT u.*,
        COALESCE(SUM(CASE WHEN c.status <> 'canceled' THEN c.amount ELSE 0 END), 0) total_commission,
        (SELECT COUNT(*) FROM users child WHERE child.parent_id = u.id) direct_count
      FROM users u
      LEFT JOIN commissions c ON c.beneficiary_id = u.id
      GROUP BY u.id
      ORDER BY total_commission DESC, direct_count DESC
      LIMIT 6
    `);
    const featuredCampaignRow = await one(pool, `
      ${campaignSelect()}
      ORDER BY
        CASE ac.status WHEN 'published' THEN 0 WHEN 'draft' THEN 1 WHEN 'ended' THEN 2 ELSE 3 END,
        order_count DESC,
        ac.updated_at DESC,
        ac.id DESC
      LIMIT 1
    `);
    const featuredCampaign = featuredCampaignRow ? campaignRow(featuredCampaignRow) : null;
    const campaignOrderJoin = featuredCampaign
      ? "JOIN acquisition_orders ao ON ao.order_id = o.id AND ao.campaign_id = :campaignId"
      : "LEFT JOIN acquisition_orders ao ON ao.order_id = o.id";
    const campaignCommissionJoin = featuredCampaign
      ? "JOIN acquisition_orders ao ON ao.order_id = c.order_id AND ao.campaign_id = :campaignId"
      : "LEFT JOIN acquisition_orders ao ON ao.order_id = c.order_id";
    const campaignParams = featuredCampaign ? { campaignId: featuredCampaign.id } : {};
    const heartbeatParams = {
      ...campaignParams,
      campaignIdForRelation: featuredCampaign ? featuredCampaign.id : 0
    };
    const liveCount = await one(pool, `
      SELECT COUNT(DISTINCT user_id) count
      FROM screen_heartbeats
      WHERE last_seen_at >= UTC_TIMESTAMP() - INTERVAL 5 SECOND
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
        AND newer.last_seen_at >= UTC_TIMESTAMP() - INTERVAL 5 SECOND
        ${featuredCampaign ? "AND newer.campaign_id = :campaignId" : ""}
        AND (
          newer.last_seen_at > hb.last_seen_at
          OR (newer.last_seen_at = hb.last_seen_at AND newer.id > hb.id)
        )
      LEFT JOIN users m ON m.id = hb.user_id
      LEFT JOIN acquisition_relations ar ON ar.member_id = hb.user_id
        AND ar.campaign_id = :campaignIdForRelation
      LEFT JOIN users i ON i.id = ar.inviter_id
      LEFT JOIN users tl ON tl.id = ar.team_leader_id
      WHERE hb.last_seen_at >= UTC_TIMESTAMP() - INTERVAL 5 SECOND
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
      LEFT JOIN users u ON u.id = o.user_id
      LEFT JOIN products p ON p.id = o.product_id
      LEFT JOIN users i ON i.id = ao.inviter_id
      LEFT JOIN users tl ON tl.id = ao.team_leader_id
      WHERE o.status IN ('paid','shipped','received')
      ORDER BY o.created_at DESC, o.id DESC
      LIMIT 8
    `, campaignParams);
    const fanRankRows = await many(pool, `
      SELECT
        u.id, u.nickname, u.avatar,
        COUNT(child.id) fans
      FROM users u
      JOIN users child ON child.parent_id = u.id
      GROUP BY u.id
      ORDER BY fans DESC, u.id DESC
      LIMIT 8
    `);
    const earningRankRows = await many(pool, `
      SELECT
        u.id, u.nickname, u.avatar,
        COALESCE(SUM(CASE WHEN c.status <> 'canceled' THEN c.amount ELSE 0 END), 0) earnings
      FROM commissions c
      ${campaignCommissionJoin}
      JOIN users u ON u.id = c.beneficiary_id
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
        WHERE inviter_id IS NOT NULL
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
        COUNT(DISTINCT ar.member_id) visitors,
        COUNT(DISTINCT CASE WHEN o.status IN ('paid','shipped','received') THEN ao.order_id ELSE NULL END) order_count,
        COUNT(DISTINCT CASE WHEN o.status IN ('paid','shipped','received') THEN o.user_id ELSE NULL END) buyer_count,
        COALESCE(SUM(CASE WHEN o.status IN ('paid','shipped','received') THEN o.amount ELSE 0 END), 0) paid_amount,
        COALESCE(SUM(CASE WHEN c.status <> 'canceled' THEN c.amount ELSE 0 END), 0) reward_amount
      FROM acquisition_campaigns ac
      LEFT JOIN acquisition_relations ar ON ar.campaign_id = ac.id
      LEFT JOIN acquisition_orders ao ON ao.campaign_id = ac.id
      LEFT JOIN orders o ON o.id = ao.order_id
      LEFT JOIN commissions c ON c.order_id = ao.order_id
      WHERE ac.id = :campaignId
    `, campaignParams) : null;
    const totalRelationCount = await one(pool, "SELECT COUNT(*) count FROM acquisition_relations");
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

  async function screenDashboard() {
    const data = await dashboard();
    const screen = data.battle_screen || {};
    return {
      ...screen,
      title: screen.title || "必火次元作战大屏",
      online_count: Number(screen.browsing_count || 0),
      online_users: (screen.live_visitors || []).map(item => ({
        ...item,
        status: "实时在线",
        last_seen_at: item.last_seen_at
      }))
    };
  }

  async function screenHeartbeat(body) {
    return tx(pool, async conn => {
      const userId = assertId(body.user_id, "用户 ID");
      await getUser(userId, conn);
      const rawCampaignId = Number(body.campaign_id || 0);
      const rawProductId = Number(body.product_id || 0);
      const campaignId = Number.isInteger(rawCampaignId) && rawCampaignId > 0 ? rawCampaignId : null;
      const productId = Number.isInteger(rawProductId) && rawProductId > 0 ? rawProductId : null;
      if (campaignId) await getAcquisitionCampaign(campaignId, conn);
      if (productId) await getPublicProduct(productId, conn);
      const payload = {
        userId,
        campaignId,
        productId,
        scene: cleanText(body.scene, "", 64),
        page: cleanText(body.page, "", 40),
        sessionKey: cleanText(body.session_key, "", 96) || heartbeatSessionKey(body)
      };
      await conn.query(`
        INSERT INTO screen_heartbeats (
          user_id, campaign_id, product_id, scene, page, session_key, last_seen_at
        )
        VALUES (
          :userId, :campaignId, :productId, :scene, :page, :sessionKey, UTC_TIMESTAMP()
        )
        ON DUPLICATE KEY UPDATE
          user_id = VALUES(user_id),
          campaign_id = VALUES(campaign_id),
          product_id = VALUES(product_id),
          scene = VALUES(scene),
          page = VALUES(page),
          last_seen_at = UTC_TIMESTAMP()
      `, payload);
      return { ok: true, online_window_seconds: 5 };
    });
  }

  async function listDistributors() {
    const rows = await many(pool, `
      SELECT u.*,
        p.nickname parent_nickname, p.phone parent_phone, p.avatar parent_avatar,
        (SELECT COUNT(*) FROM users child WHERE child.parent_id = u.id) direct_count,
        COALESCE(SUM(CASE WHEN c.status <> 'canceled' THEN c.amount ELSE 0 END), 0) total_commission
      FROM users u
      LEFT JOIN users p ON p.id = u.parent_id
      LEFT JOIN commissions c ON c.beneficiary_id = u.id
      GROUP BY u.id, p.id
      ORDER BY u.created_at DESC
    `);
    return Promise.all(rows.map(async row => ({
      ...normalizeUser(row),
      parent: row.parent_nickname ? {
        id: row.parent_id,
        nickname: row.parent_nickname,
        phone: row.parent_phone || "",
        avatar: row.parent_avatar || ""
      } : null,
      direct_count: Number(row.direct_count || 0),
      total_commission: money(row.total_commission),
      available_balance: await userAvailableBalance(row.id)
    })));
  }

  async function patchDistributor(userId, body) {
    const id = assertId(userId, "用户 ID");
    if (!["approved", "pending", "rejected"].includes(body.status)) throw appError(422, "分销员状态不正确");
    const [result] = await pool.query("UPDATE users SET distributor_status = :status WHERE id = :id", { status: body.status, id });
    if (!result.affectedRows) throw appError(404, "用户不存在");
    return getUser(id);
  }

  async function listWithdrawals() {
    const rows = await many(pool, `
      SELECT w.*, u.nickname user_nickname, u.phone user_phone, u.avatar user_avatar
      FROM withdrawals w
      LEFT JOIN users u ON u.id = w.user_id
      ORDER BY w.created_at DESC, w.id DESC
    `);
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

  async function patchWithdrawal(withdrawalId, body) {
    return tx(pool, async conn => {
      const id = assertId(withdrawalId, "提现 ID");
      const withdrawal = await one(conn, "SELECT * FROM withdrawals WHERE id = :id FOR UPDATE", { id });
      if (!withdrawal) throw appError(404, "提现申请不存在");
      if (body.action !== "pay" && withdrawal.status !== "pending") throw appError(409, "该提现申请已经审核");
      if (body.action === "pay" && !["pending", "approved"].includes(withdrawal.status)) throw appError(409, "该提现申请不能打款");

      let status;
      let note;
      const appSettings = await settings(conn);
      if (body.action === "approve") {
        status = appSettings.auto_pay_enabled ? "paidout" : "approved";
        note = String(body.review_note || "审核通过，等待企业付款").slice(0, 120);
      } else if (body.action === "pay") {
        status = "paidout";
        note = String(body.review_note || "已模拟企业付款到零钱").slice(0, 120);
      } else if (body.action === "reject") {
        status = "rejected";
        note = String(body.review_note || "审核未通过").slice(0, 120);
      } else {
        throw appError(422, "未知提现操作");
      }
      await conn.query(
        "UPDATE withdrawals SET status = :status, review_note = :note, reviewed_at = UTC_TIMESTAMP() WHERE id = :id",
        { status, note, id }
      );
      return one(conn, "SELECT * FROM withdrawals WHERE id = :id", { id });
    });
  }

  async function updateSettings(body) {
    await pool.query(
      `UPDATE app_settings
       SET commission_level_1 = :level1, commission_level_2 = :level2, min_withdrawal = :minWithdrawal,
           compliance_name = :complianceName, auto_pay_enabled = :autoPayEnabled
       WHERE id = 1`,
      {
        level1: Number(body.commission_level_1),
        level2: Number(body.commission_level_2),
        minWithdrawal: Number(body.min_withdrawal),
        complianceName: String(body.compliance_name || "推荐有礼").trim().slice(0, 20),
        autoPayEnabled: Boolean(body.auto_pay_enabled)
      }
    );
    return settings();
  }

  async function close() {
    await pool.end();
  }

  return {
    ping,
    close,
    login,
    wechatLogin,
    getUser,
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
    listAcquisitionCampaigns,
    getAcquisitionCampaign,
    createAcquisitionCampaign,
    updateAcquisitionCampaign,
    patchAcquisitionCampaign,
    saveAcquisitionQrcode,
    deleteAcquisitionQrcode,
    listAcquisitionRelations,
    listAcquisitionOrders,
    listAcquisitionRewards,
    acquisitionDashboard,
    listAcquisitionMaterials,
    saveAcquisitionMaterial,
    createOrder,
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
