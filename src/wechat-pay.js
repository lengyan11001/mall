const crypto = require("crypto");
const fs = require("fs");
const https = require("https");
const { URL } = require("url");
const { appError } = require("./errors");

function payConfig() {
  return {
    appid: process.env.WECHAT_APP_ID || "",
    mchid: process.env.WECHAT_MCH_ID || "",
    merchantSerialNo: process.env.WECHAT_PAY_SERIAL_NO || "",
    merchantPrivateKeyPath: process.env.WECHAT_PAY_PRIVATE_KEY_PATH || "",
    apiV3Key: process.env.WECHAT_PAY_API_V3_KEY || "",
    notifyUrl: process.env.WECHAT_PAY_NOTIFY_URL || "",
    publicKeyId: process.env.WECHAT_PAY_PUBLIC_KEY_ID || "",
    publicKeyPath: process.env.WECHAT_PAY_PUBLIC_KEY_PATH || ""
  };
}

function assertConfig(config = payConfig()) {
  const missing = Object.entries({
    WECHAT_APP_ID: config.appid,
    WECHAT_MCH_ID: config.mchid,
    WECHAT_PAY_SERIAL_NO: config.merchantSerialNo,
    WECHAT_PAY_PRIVATE_KEY_PATH: config.merchantPrivateKeyPath,
    WECHAT_PAY_API_V3_KEY: config.apiV3Key,
    WECHAT_PAY_NOTIFY_URL: config.notifyUrl,
    WECHAT_PAY_PUBLIC_KEY_ID: config.publicKeyId,
    WECHAT_PAY_PUBLIC_KEY_PATH: config.publicKeyPath
  }).filter(([, value]) => !value).map(([key]) => key);
  if (missing.length) throw appError(500, `微信支付配置缺失：${missing.join(", ")}`);
  if (Buffer.byteLength(config.apiV3Key) !== 32) throw appError(500, "微信支付 API v3 密钥必须是 32 字节");
  return config;
}

function readTextFile(filePath, label) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    throw appError(500, `${label}读取失败`);
  }
}

function nonce() {
  return crypto.randomBytes(16).toString("hex");
}

function timestamp() {
  return Math.floor(Date.now() / 1000).toString();
}

function sign(message, privateKey) {
  return crypto.createSign("RSA-SHA256").update(message).sign(privateKey, "base64");
}

function authorization(method, pathname, query, body, config) {
  const ts = timestamp();
  const nonceStr = nonce();
  const bodyText = body ? JSON.stringify(body) : "";
  const urlPath = `${pathname}${query || ""}`;
  const message = `${method}\n${urlPath}\n${ts}\n${nonceStr}\n${bodyText}\n`;
  const signature = sign(message, readTextFile(config.merchantPrivateKeyPath, "商户 API 私钥"));
  return {
    header: `WECHATPAY2-SHA256-RSA2048 mchid="${config.mchid}",nonce_str="${nonceStr}",signature="${signature}",timestamp="${ts}",serial_no="${config.merchantSerialNo}"`,
    bodyText
  };
}

function requestWechat(method, apiPath, body = null) {
  const config = assertConfig();
  const url = new URL(apiPath, "https://api.mch.weixin.qq.com");
  const auth = authorization(method, url.pathname, url.search, body, config);
  return new Promise((resolve, reject) => {
    const req = https.request({
      method,
      hostname: url.hostname,
      path: `${url.pathname}${url.search}`,
      headers: {
        Authorization: auth.header,
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": "kuaileciyuan-mall/1.0",
        "Content-Length": Buffer.byteLength(auth.bodyText)
      }
    }, res => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", chunk => { raw += chunk; });
      res.on("end", () => {
        const payload = raw ? JSON.parse(raw) : {};
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(payload);
          return;
        }
        reject(appError(502, `微信支付请求失败：${payload.message || res.statusMessage}`, {
          statusCode: res.statusCode,
          code: payload.code
        }));
      });
    });
    req.on("error", reject);
    req.end(auth.bodyText);
  });
}

function yuanToFen(value) {
  return Math.round(Number(value || 0) * 100);
}

async function createJsapiPrepay({ outTradeNo, description, amount, openid, attach = "" }) {
  const config = assertConfig();
  return requestWechat("POST", "/v3/pay/transactions/jsapi", {
    appid: config.appid,
    mchid: config.mchid,
    description: String(description || "必火次元订单").slice(0, 127),
    out_trade_no: outTradeNo,
    notify_url: config.notifyUrl,
    amount: {
      total: yuanToFen(amount),
      currency: "CNY"
    },
    payer: { openid },
    attach
  });
}

function jsapiPayParams(prepayId) {
  const config = assertConfig();
  const timeStamp = timestamp();
  const nonceStr = nonce();
  const packageValue = `prepay_id=${prepayId}`;
  const message = `${config.appid}\n${timeStamp}\n${nonceStr}\n${packageValue}\n`;
  return {
    appId: config.appid,
    timeStamp,
    nonceStr,
    package: packageValue,
    signType: "RSA",
    paySign: sign(message, readTextFile(config.merchantPrivateKeyPath, "商户 API 私钥"))
  };
}

function verifyWechatpaySignature(headers, rawBody) {
  const config = assertConfig();
  const timestampHeader = String(headers["wechatpay-timestamp"] || "");
  const nonceHeader = String(headers["wechatpay-nonce"] || "");
  const signatureHeader = String(headers["wechatpay-signature"] || "");
  if (!timestampHeader || !nonceHeader || !signatureHeader) return false;
  const message = `${timestampHeader}\n${nonceHeader}\n${rawBody}\n`;
  return crypto.verify(
    "RSA-SHA256",
    Buffer.from(message),
    readTextFile(config.publicKeyPath, "微信支付公钥"),
    Buffer.from(signatureHeader, "base64")
  );
}

function decryptResource(resource) {
  const config = assertConfig();
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    Buffer.from(config.apiV3Key, "utf8"),
    Buffer.from(resource.nonce, "utf8")
  );
  decipher.setAuthTag(Buffer.from(resource.ciphertext, "base64").subarray(-16));
  decipher.setAAD(Buffer.from(resource.associated_data || "", "utf8"));
  const ciphertext = Buffer.from(resource.ciphertext, "base64").subarray(0, -16);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plaintext.toString("utf8"));
}

async function queryOrder(outTradeNo) {
  const config = assertConfig();
  return requestWechat("GET", `/v3/pay/transactions/out-trade-no/${encodeURIComponent(outTradeNo)}?mchid=${encodeURIComponent(config.mchid)}`);
}

module.exports = {
  createJsapiPrepay,
  decryptResource,
  jsapiPayParams,
  payConfig,
  queryOrder,
  verifyWechatpaySignature,
  yuanToFen
};
