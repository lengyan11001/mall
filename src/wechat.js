const { appError } = require("./errors");
const { defaultTenant } = require("./tenant-config");

const tokenCache = new Map();

function wechatConfig(tenant = defaultTenant()) {
  const appid = tenant?.appid || process.env.WECHAT_APP_ID;
  const secret = tenant?.secret || process.env.WECHAT_APP_SECRET;
  if (!appid || !secret) {
    throw appError(500, "WeChat mini program config is missing");
  }
  return { appid, secret };
}

async function codeToSession(code, tenant) {
  const { appid, secret } = wechatConfig(tenant);
  if (!code) {
    throw appError(422, "Missing WeChat login code");
  }

  const url = new URL("https://api.weixin.qq.com/sns/jscode2session");
  url.searchParams.set("appid", appid);
  url.searchParams.set("secret", secret);
  url.searchParams.set("js_code", code);
  url.searchParams.set("grant_type", "authorization_code");

  const response = await fetch(url);
  const data = await response.json();
  if (!response.ok || data.errcode) {
    throw appError(502, `WeChat login failed: ${data.errmsg || response.statusText}`, {
      errcode: data.errcode
    });
  }
  if (!data.openid) {
    throw appError(502, "WeChat login did not return openid");
  }
  return data;
}

async function getAccessToken(tenant) {
  const now = Date.now();
  const { appid, secret } = wechatConfig(tenant);
  const cached = tokenCache.get(appid);
  if (cached?.value && cached.expiresAt > now + 60 * 1000) {
    return cached.value;
  }

  const url = new URL("https://api.weixin.qq.com/cgi-bin/token");
  url.searchParams.set("grant_type", "client_credential");
  url.searchParams.set("appid", appid);
  url.searchParams.set("secret", secret);

  const response = await fetch(url);
  const data = await response.json();
  if (!response.ok || data.errcode || !data.access_token) {
    throw appError(502, `WeChat access_token failed: ${data.errmsg || response.statusText}`, {
      errcode: data.errcode
    });
  }

  tokenCache.set(appid, {
    value: data.access_token,
    expiresAt: now + Math.max(300, Number(data.expires_in || 7200) - 300) * 1000
  });
  return data.access_token;
}

async function getUnlimitedQRCode({ scene, page = "pages/home/index", checkPath = false }, tenant) {
  if (!scene) {
    throw appError(422, "Missing mini program QR scene");
  }
  if (String(scene).length > 32) {
    throw appError(422, "Mini program QR scene cannot exceed 32 chars");
  }

  const accessToken = await getAccessToken(tenant);
  const url = new URL("https://api.weixin.qq.com/wxa/getwxacodeunlimit");
  url.searchParams.set("access_token", accessToken);

  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      scene: String(scene),
      page,
      check_path: Boolean(checkPath)
    })
  });
  const buffer = Buffer.from(await response.arrayBuffer());
  const type = response.headers.get("content-type") || "";
  if (type.includes("application/json") || buffer[0] === 0x7b) {
    let data = {};
    try {
      data = JSON.parse(buffer.toString("utf8"));
    } catch {
      data = {};
    }
    throw appError(502, `Mini program QR generation failed: ${data.errmsg || response.statusText}`, {
      errcode: data.errcode
    });
  }
  if (!response.ok || !buffer.length) {
    throw appError(502, `Mini program QR generation failed: ${response.statusText}`);
  }
  return buffer;
}

module.exports = {
  codeToSession,
  getAccessToken,
  getUnlimitedQRCode
};
