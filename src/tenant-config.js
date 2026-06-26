const { appError } = require("./errors");

const DEFAULT_LEGACY_APPID = "wx96f89cb1012ee618";

function clean(value, fallback = "") {
  return String(value ?? fallback).trim();
}

function parseJson(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function normalizePayment(raw = {}, appid = "") {
  return {
    appid: clean(raw.appid, appid),
    mchid: clean(raw.mchid || raw.mch_id || raw.merchant_id || process.env.WECHAT_MCH_ID),
    merchantSerialNo: clean(raw.merchantSerialNo || raw.merchant_serial_no || raw.serial_no || process.env.WECHAT_PAY_SERIAL_NO),
    merchantPrivateKeyPath: clean(raw.merchantPrivateKeyPath || raw.merchant_private_key_path || raw.private_key_path || process.env.WECHAT_PAY_PRIVATE_KEY_PATH),
    apiV3Key: clean(raw.apiV3Key || raw.api_v3_key || process.env.WECHAT_PAY_API_V3_KEY),
    notifyUrl: clean(raw.notifyUrl || raw.notify_url || process.env.WECHAT_PAY_NOTIFY_URL),
    publicKeyId: clean(raw.publicKeyId || raw.public_key_id || process.env.WECHAT_PAY_PUBLIC_KEY_ID),
    publicKeyPath: clean(raw.publicKeyPath || raw.public_key_path || process.env.WECHAT_PAY_PUBLIC_KEY_PATH)
  };
}

function normalizeTenant(raw = {}, fallback = {}) {
  const appid = clean(raw.appid || raw.app_id || fallback.appid);
  if (!appid) return null;
  return {
    appid,
    secret: clean(raw.secret || raw.app_secret || fallback.secret),
    name: clean(raw.name || raw.display_name || fallback.name || process.env.MINIAPP_NAME || "BiHuoCY"),
    iconUrl: clean(raw.iconUrl || raw.icon_url || fallback.iconUrl || process.env.MINIAPP_ICON_URL),
    logoUrl: clean(raw.logoUrl || raw.logo_url || fallback.logoUrl || process.env.MINIAPP_LOGO_URL),
    payment: normalizePayment(raw.payment || raw.pay || raw.wechat_pay || raw, appid)
  };
}

function envTenant() {
  return normalizeTenant({
    appid: process.env.WECHAT_APP_ID,
    secret: process.env.WECHAT_APP_SECRET,
    name: process.env.MINIAPP_NAME,
    iconUrl: process.env.MINIAPP_ICON_URL,
    logoUrl: process.env.MINIAPP_LOGO_URL
  });
}

function configuredTenants() {
  const parsed = parseJson(process.env.MALL_TENANTS_JSON || process.env.WECHAT_TENANTS_JSON, []);
  const list = Array.isArray(parsed) ? parsed : Object.values(parsed || {});
  const tenants = list.map(item => normalizeTenant(item)).filter(Boolean);
  const fallback = envTenant();
  if (fallback && !tenants.some(item => item.appid === fallback.appid)) tenants.push(fallback);
  if (!tenants.length) {
    const legacy = normalizeTenant({
      appid: process.env.WECHAT_LEGACY_APP_ID || DEFAULT_LEGACY_APPID,
      secret: process.env.WECHAT_LEGACY_APP_SECRET || "",
      name: process.env.MINIAPP_NAME || "BiHuoCY"
    });
    if (legacy) tenants.push(legacy);
  }
  return tenants;
}

function tenantMap() {
  return new Map(configuredTenants().map(tenant => [tenant.appid, tenant]));
}

function defaultAppId() {
  return clean(process.env.MALL_DEFAULT_APP_ID || process.env.WECHAT_APP_ID || process.env.WECHAT_LEGACY_APP_ID || DEFAULT_LEGACY_APPID);
}

function defaultTenant() {
  const tenants = tenantMap();
  return tenants.get(defaultAppId()) || configuredTenants()[0] || null;
}

function resolveTenant(appid = "") {
  const normalized = clean(appid);
  const tenants = tenantMap();
  if (!normalized) {
    const tenant = defaultTenant();
    if (!tenant) throw appError(500, "Mini program tenant is not configured");
    return tenant;
  }
  const tenant = tenants.get(normalized);
  if (!tenant) throw appError(400, "Unknown mini program appid");
  return tenant;
}

function appidFromRequest(req, searchParams, body = {}) {
  return clean(
    req.headers["x-mall-appid"] ||
    req.headers["x-wechat-appid"] ||
    req.headers["x-miniapp-appid"] ||
    searchParams?.get("appid") ||
    body.appid ||
    body.app_id
  );
}

function resolveTenantFromRequest(req, searchParams, body = {}) {
  return resolveTenant(appidFromRequest(req, searchParams, body));
}

function publicTenant(tenant) {
  return {
    appid: tenant.appid,
    name: tenant.name,
    icon_url: tenant.iconUrl,
    logo_url: tenant.logoUrl
  };
}

function paymentTenants() {
  return configuredTenants().filter(tenant => {
    const pay = tenant.payment || {};
    return pay.mchid && pay.apiV3Key && pay.publicKeyPath;
  });
}

module.exports = {
  DEFAULT_LEGACY_APPID,
  appidFromRequest,
  configuredTenants,
  defaultAppId,
  defaultTenant,
  paymentTenants,
  publicTenant,
  resolveTenant,
  resolveTenantFromRequest
};
