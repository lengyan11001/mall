const { appError } = require("./errors");

const tokenCache = {
  value: "",
  expiresAt: 0
};

function wechatConfig() {
  const appid = process.env.WECHAT_APP_ID;
  const secret = process.env.WECHAT_APP_SECRET;
  if (!appid || !secret) {
    throw appError(500, "微信小程序配置缺失");
  }
  return { appid, secret };
}

async function codeToSession(code) {
  const { appid, secret } = wechatConfig();
  if (!code) {
    throw appError(422, "缺少微信登录 code");
  }

  const url = new URL("https://api.weixin.qq.com/sns/jscode2session");
  url.searchParams.set("appid", appid);
  url.searchParams.set("secret", secret);
  url.searchParams.set("js_code", code);
  url.searchParams.set("grant_type", "authorization_code");

  const response = await fetch(url);
  const data = await response.json();
  if (!response.ok || data.errcode) {
    throw appError(502, `微信登录失败：${data.errmsg || response.statusText}`, {
      errcode: data.errcode
    });
  }
  if (!data.openid) {
    throw appError(502, "微信登录未返回 openid");
  }
  return data;
}

async function getAccessToken() {
  const now = Date.now();
  if (tokenCache.value && tokenCache.expiresAt > now + 60 * 1000) {
    return tokenCache.value;
  }

  const { appid, secret } = wechatConfig();
  const url = new URL("https://api.weixin.qq.com/cgi-bin/token");
  url.searchParams.set("grant_type", "client_credential");
  url.searchParams.set("appid", appid);
  url.searchParams.set("secret", secret);

  const response = await fetch(url);
  const data = await response.json();
  if (!response.ok || data.errcode || !data.access_token) {
    throw appError(502, `微信 access_token 获取失败：${data.errmsg || response.statusText}`, {
      errcode: data.errcode
    });
  }

  tokenCache.value = data.access_token;
  tokenCache.expiresAt = now + Math.max(300, Number(data.expires_in || 7200) - 300) * 1000;
  return tokenCache.value;
}

async function getUnlimitedQRCode({ scene, page = "pages/home/index", checkPath = false }) {
  if (!scene) {
    throw appError(422, "缺少小程序码 scene");
  }
  if (String(scene).length > 32) {
    throw appError(422, "小程序码 scene 不能超过 32 个字符");
  }

  const accessToken = await getAccessToken();
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
    throw appError(502, `微信小程序码生成失败：${data.errmsg || response.statusText}`, {
      errcode: data.errcode
    });
  }
  if (!response.ok || !buffer.length) {
    throw appError(502, `微信小程序码生成失败：${response.statusText}`);
  }
  return buffer;
}

module.exports = {
  codeToSession,
  getAccessToken,
  getUnlimitedQRCode
};
