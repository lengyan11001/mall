const fs = require("fs/promises");
const path = require("path");
const sharp = require("sharp");
const { appError } = require("./errors");

const publicDir = path.join(__dirname, "..", "public");
const inviteDir = path.join(publicDir, "generated", "invite");
const productDir = path.join(publicDir, "generated", "product");

function campaignInviteScene(campaignId, userId) {
  const campaign = Number(campaignId);
  const user = Number(userId);
  if (!Number.isInteger(campaign) || campaign <= 0 || !Number.isInteger(user) || user <= 0) {
    throw appError(422, "活动或用户 ID 不正确");
  }
  return `c${campaign}u${user}`;
}

function parseCampaignInviteScene(scene) {
  const match = String(scene || "").match(/^c(\d+)u(\d+)$/);
  if (!match) return null;
  return {
    campaignId: Number(match[1]),
    userId: Number(match[2])
  };
}

function productInviteScene(productId, userId) {
  const product = Number(productId);
  const user = Number(userId);
  if (!Number.isInteger(product) || product <= 0 || !Number.isInteger(user) || user <= 0) {
    throw appError(422, "Product or user ID is invalid");
  }
  return `p${product}u${user}`;
}

function parseProductInviteScene(scene) {
  const match = String(scene || "").match(/^p(\d+)u(\d+)$/);
  if (!match) return null;
  return {
    productId: Number(match[1]),
    userId: Number(match[2])
  };
}

function inviteAssetPaths(campaignId, userId) {
  const scene = campaignInviteScene(campaignId, userId);
  return {
    scene,
    qrcodePath: path.join(inviteDir, `${scene}-home-code.png`),
    posterPath: path.join(inviteDir, `${scene}-home-poster.png`),
    qrcodeUrl: `/generated/invite/${scene}-home-code.png`,
    posterUrl: `/generated/invite/${scene}-home-poster.png`
  };
}

function productAssetPaths(productId, userId) {
  const scene = productInviteScene(productId, userId);
  return {
    scene,
    qrcodePath: path.join(productDir, `${scene}-code.png`),
    posterPath: path.join(productDir, `${scene}-poster.png`),
    qrcodeUrl: `/generated/product/${scene}-code.png`,
    posterUrl: `/generated/product/${scene}-poster.png`
  };
}

function escapeXml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function textLines(value, maxChars, maxLines) {
  const chars = Array.from(String(value || ""));
  const lines = [];
  for (let i = 0; i < chars.length && lines.length < maxLines; i += maxChars) {
    lines.push(chars.slice(i, i + maxChars).join(""));
  }
  return lines;
}

function svgTextLines(value, x, y, options = {}) {
  const lines = textLines(value, options.maxChars || 18, options.maxLines || 2);
  return lines.map((line, index) => (
    `<text x="${x}" y="${y + index * (options.lineHeight || 42)}" font-size="${options.size || 32}" font-weight="${options.weight || 700}" fill="${options.fill || "#18212f"}">${escapeXml(line)}</text>`
  )).join("");
}

async function imageDataUri(source) {
  const value = String(source || "").trim();
  if (!value) return "";
  if (value.startsWith("data:image/")) return value;
  try {
    if (/^https?:\/\//.test(value)) {
      const response = await fetch(value);
      if (!response.ok) return "";
      const type = response.headers.get("content-type") || "image/jpeg";
      const buffer = Buffer.from(await response.arrayBuffer());
      return `data:${type};base64,${buffer.toString("base64")}`;
    }
    if (value.startsWith("/")) {
      const normalized = path.normalize(value).replace(/^([/\\])+/, "");
      const filePath = path.join(publicDir, normalized);
      const resolved = path.resolve(filePath);
      if (!resolved.startsWith(path.resolve(publicDir))) return "";
      const ext = path.extname(resolved).toLowerCase();
      const type = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
      const buffer = await fs.readFile(resolved);
      return `data:${type};base64,${buffer.toString("base64")}`;
    }
  } catch {
    return "";
  }
  return "";
}

async function ensureInviteDir() {
  await fs.mkdir(inviteDir, { recursive: true });
}

async function ensureProductDir() {
  await fs.mkdir(productDir, { recursive: true });
}

async function writeQrcode(scene, qrcodeBuffer) {
  await ensureInviteDir();
  const paths = inviteAssetPaths(scene.replace(/^c(\d+)u(\d+)$/, "$1"), scene.replace(/^c(\d+)u(\d+)$/, "$2"));
  await fs.writeFile(paths.qrcodePath, qrcodeBuffer);
  return paths;
}

async function buildInvitePoster({ campaign, user, qrcodeBuffer, outputPath, brandName = "非常好裂变" }) {
  await ensureInviteDir();
  const product = campaign.product || {};
  const posterConfig = Array.isArray(campaign.poster_config) ? campaign.poster_config.filter(Boolean) : [];
  const primaryPoster = posterConfig[0] || {};
  const title = campaign.name || campaign.product?.title || "拓客宝活动";
  const description = primaryPoster.text || campaign.share_description || campaign.description || campaign.product?.description || "扫码进入小程序，参与活动并领取福利。";
  const inviter = user.nickname || `用户${user.id}`;
  const price = Number(campaign.lead_price || 0).toFixed(2);
  const qrcode = qrcodeBuffer.toString("base64");
  const productImageUrl = Array.isArray(product.images) && product.images.length ? product.images[0] : product.image_url || "";
  const posterImageData = await imageDataUri(primaryPoster.image_url || campaign.share_cover || productImageUrl);
  const titleLines = svgTextLines(title, 64, 230, { maxChars: 13, maxLines: 2, size: 48, lineHeight: 58, weight: 900, fill: "#111827" });
  const descLines = svgTextLines(description, 64, 380, { maxChars: 20, maxLines: 3, size: 28, lineHeight: 42, weight: 500, fill: "#4b5563" });
  const posterVisual = posterImageData
    ? `<image x="64" y="500" width="622" height="360" preserveAspectRatio="xMidYMid slice" href="${escapeXml(posterImageData)}"/>`
    : `
      <rect x="64" y="500" width="622" height="360" rx="30" fill="#111827"/>
      <circle cx="164" cy="612" r="70" fill="#22d3ee" opacity="0.78"/>
      <circle cx="586" cy="746" r="94" fill="#fb7185" opacity="0.72"/>
      <path d="M124 768 C222 624 328 827 438 666 C487 593 576 602 630 552" fill="none" stroke="#ffffff" stroke-width="20" stroke-linecap="round" opacity="0.86"/>
    `;
  const fallbackVisualText = posterImageData ? "" : `
    <text x="92" y="565" font-size="34" font-weight="900" fill="#ffffff">潮玩福利进行中</text>
    <text x="92" y="820" font-size="26" font-weight="700" fill="#ffffff" opacity="0.84">扫码进入小程序参与活动</text>
  `;

  const svg = `
<svg width="750" height="1200" viewBox="0 0 750 1200" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <style>
      text { font-family: "Noto Sans CJK SC", "Noto Sans SC", "Microsoft YaHei", "WenQuanYi Micro Hei", sans-serif; }
    </style>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#fff7ed"/>
      <stop offset="0.42" stop-color="#e0f2fe"/>
      <stop offset="1" stop-color="#fce7f3"/>
    </linearGradient>
    <linearGradient id="accent" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#06b6d4"/>
      <stop offset="1" stop-color="#f97316"/>
    </linearGradient>
  </defs>
  <rect width="750" height="1200" fill="url(#bg)"/>
  <rect x="36" y="36" width="678" height="1128" rx="34" fill="#ffffff" opacity="0.94"/>
  <rect x="64" y="72" width="196" height="52" rx="26" fill="url(#accent)"/>
  <text x="162" y="107" text-anchor="middle" font-size="26" font-weight="900" fill="#ffffff">${escapeXml(brandName)}</text>
  <text x="64" y="156" font-size="28" font-weight="700" fill="#0f766e">专属邀请海报</text>
  ${titleLines}
  <rect x="64" y="292" width="170" height="48" rx="24" fill="#fff7ed"/>
  <text x="88" y="325" font-size="28" font-weight="900" fill="#ea580c">¥${escapeXml(price)}</text>
  ${descLines}
  <clipPath id="posterClip"><rect x="64" y="500" width="622" height="360" rx="30"/></clipPath>
  <g clip-path="url(#posterClip)">${posterVisual}</g>
  <rect x="64" y="500" width="622" height="360" rx="30" fill="none" stroke="#e5e7eb" stroke-width="2"/>
  ${fallbackVisualText}
  <rect x="185" y="902" width="380" height="210" rx="28" fill="#f8fafc"/>
  <image x="211" y="922" width="160" height="160" href="data:image/png;base64,${qrcode}"/>
  <text x="392" y="976" font-size="28" font-weight="900" fill="#111827">扫码参加</text>
  <text x="392" y="1022" font-size="24" font-weight="800" fill="#4b5563">邀请人：${escapeXml(inviter)}</text>
  <text x="392" y="1066" font-size="21" font-weight="500" fill="#6b7280">进入后自动记录关系</text>
  <text x="375" y="1142" text-anchor="middle" font-size="22" font-weight="600" fill="#6b7280">${escapeXml(brandName)} · 裂变增长</text>
</svg>`;

  await sharp(Buffer.from(svg)).png().toFile(outputPath);
}

async function buildProductPoster({ product, user, qrcodeBuffer, outputPath, complianceName = "Invite", brandName = "非常好裂变" }) {
  await ensureProductDir();
  const title = product.title || brandName;
  const subtitle = product.subtitle || product.description || "Scan to open product detail.";
  const inviter = user.nickname || `User${user.id}`;
  const price = Number(product.price || 0).toFixed(2);
  const stock = Number(product.stock || 0);
  const qrcode = qrcodeBuffer.toString("base64");
  const imageUrl = Array.isArray(product.images) && product.images.length ? product.images[0] : product.image_url || "";
  const titleLines = svgTextLines(title, 56, 162, { maxChars: 13, maxLines: 2, size: 48, lineHeight: 58, weight: 900, fill: "#111827" });
  const subtitleLines = svgTextLines(subtitle, 56, 286, { maxChars: 18, maxLines: 2, size: 26, lineHeight: 38, weight: 600, fill: "#64748b" });
  const productImageData = await imageDataUri(imageUrl);

  let productImage = "";
  if (productImageData) {
    productImage = `<image x="70" y="394" width="610" height="430" preserveAspectRatio="xMidYMid slice" href="${escapeXml(productImageData)}"/>`;
  } else {
    productImage = `
      <rect x="70" y="394" width="610" height="430" rx="28" fill="#0f172a"/>
      <path d="M128 710 C230 560 322 760 442 610 C494 546 586 560 638 500" fill="none" stroke="#38bdf8" stroke-width="20" stroke-linecap="round"/>
      <circle cx="176" cy="522" r="74" fill="#fb7185" opacity="0.78"/>
      <circle cx="590" cy="730" r="88" fill="#a78bfa" opacity="0.68"/>
      <text x="110" y="804" font-size="30" font-weight="900" fill="#ffffff">${escapeXml(brandName)}</text>
    `;
  }

  const svg = `
<svg width="750" height="1200" viewBox="0 0 750 1200" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <style>
      text { font-family: "Noto Sans CJK SC", "Noto Sans SC", "Microsoft YaHei", "WenQuanYi Micro Hei", sans-serif; }
    </style>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#eef2ff"/>
      <stop offset="0.45" stop-color="#ecfeff"/>
      <stop offset="1" stop-color="#fff1f2"/>
    </linearGradient>
    <linearGradient id="brand" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#0ea5e9"/>
      <stop offset="0.55" stop-color="#8b5cf6"/>
      <stop offset="1" stop-color="#f97316"/>
    </linearGradient>
  </defs>
  <rect width="750" height="1200" fill="url(#bg)"/>
  <rect x="32" y="32" width="686" height="1136" rx="34" fill="#ffffff" opacity="0.96"/>
  <rect x="56" y="70" width="210" height="52" rx="26" fill="url(#brand)"/>
  <text x="161" y="105" text-anchor="middle" font-size="26" font-weight="900" fill="#ffffff">${escapeXml(brandName)}</text>
  ${titleLines}
  ${subtitleLines}
  <clipPath id="productClip"><rect x="70" y="394" width="610" height="430" rx="28"/></clipPath>
  <g clip-path="url(#productClip)">${productImage}</g>
  <rect x="70" y="394" width="610" height="430" rx="28" fill="none" stroke="#e2e8f0" stroke-width="2"/>
  <rect x="56" y="850" width="638" height="242" rx="30" fill="#0f172a"/>
  <text x="90" y="910" font-size="30" font-weight="900" fill="#ffffff">￥${escapeXml(price)}</text>
  <text x="90" y="956" font-size="22" font-weight="700" fill="#cbd5e1">库存 ${stock} · ${escapeXml(complianceName)}</text>
  <text x="90" y="1012" font-size="24" font-weight="700" fill="#e2e8f0">邀请人：${escapeXml(inviter)}</text>
  <rect x="456" y="876" width="176" height="176" rx="22" fill="#ffffff"/>
  <text x="544" y="1078" text-anchor="middle" font-size="20" font-weight="700" fill="#cbd5e1">扫码到商品详情</text>
  <text x="375" y="1138" text-anchor="middle" font-size="22" font-weight="700" fill="#64748b">扫码后自动记录邀请关系</text>
</svg>`;

  const qrcodeLayer = await sharp(qrcodeBuffer)
    .resize(140, 140, { fit: "contain", background: "#ffffff" })
    .png()
    .toBuffer();

  await sharp(Buffer.from(svg))
    .png()
    .composite([{ input: qrcodeLayer, left: 474, top: 894 }])
    .toFile(outputPath);
}

module.exports = {
  campaignInviteScene,
  parseCampaignInviteScene,
  productInviteScene,
  parseProductInviteScene,
  inviteAssetPaths,
  productAssetPaths,
  ensureInviteDir,
  ensureProductDir,
  buildInvitePoster,
  buildProductPoster
};
