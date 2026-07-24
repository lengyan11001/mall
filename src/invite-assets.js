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
    versionedPosterPath(version) {
      return path.join(inviteDir, `${scene}-home-poster-${version}.png`);
    },
    qrcodeUrl: `/generated/invite/${scene}-home-code.png`,
    posterUrl: `/generated/invite/${scene}-home-poster.png`,
    versionedPosterUrl(version) {
      return `/generated/invite/${scene}-home-poster-${version}.png`;
    }
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
  const asset = await imageAsset(source);
  return asset.dataUri;
}

async function imageAsset(source) {
  const value = String(source || "").trim();
  if (!value) return { dataUri: "", width: 0, height: 0, buffer: null };
  let buffer = null;
  let type = "image/jpeg";
  try {
    if (value.startsWith("data:image/")) {
      const match = value.match(/^data:([^;]+);base64,(.+)$/);
      if (!match) return { dataUri: value, width: 0, height: 0, buffer: null };
      type = match[1];
      buffer = Buffer.from(match[2], "base64");
    }
    if (/^https?:\/\//.test(value)) {
      const response = await fetch(value);
      if (!response.ok) return { dataUri: "", width: 0, height: 0, buffer: null };
      type = response.headers.get("content-type") || "image/jpeg";
      buffer = Buffer.from(await response.arrayBuffer());
    } else if (value.startsWith("/")) {
      const normalized = path.normalize(value).replace(/^([/\\])+/, "");
      const filePath = path.join(publicDir, normalized);
      const resolved = path.resolve(filePath);
      if (!resolved.startsWith(path.resolve(publicDir))) return { dataUri: "", width: 0, height: 0, buffer: null };
      const ext = path.extname(resolved).toLowerCase();
      type = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
      buffer = await fs.readFile(resolved);
    }
    if (!buffer) return { dataUri: "", width: 0, height: 0, buffer: null };
    const metadata = await sharp(buffer).metadata();
    return {
      dataUri: `data:${type};base64,${buffer.toString("base64")}`,
      width: Number(metadata.width || 0),
      height: Number(metadata.height || 0),
      buffer
    };
  } catch {
    return { dataUri: "", width: 0, height: 0, buffer: null };
  }
}

function fitWithin(width, height, maxWidth, maxHeight) {
  const imageWidth = Number(width || 0);
  const imageHeight = Number(height || 0);
  if (imageWidth <= 0 || imageHeight <= 0) return { width: maxWidth, height: maxHeight };
  const scale = Math.min(maxWidth / imageWidth, maxHeight / imageHeight);
  return {
    width: Math.max(1, Math.round(imageWidth * scale)),
    height: Math.max(1, Math.round(imageHeight * scale))
  };
}

function avatarInitials(user) {
  const text = String(user?.nickname || user?.avatar || "WX").trim() || "WX";
  return Array.from(text).slice(0, 2).join("").toUpperCase();
}

async function circleImageLayer(buffer, size) {
  const roundedMask = Buffer.from(`
<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">
  <circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="#ffffff"/>
</svg>`);
  const image = await sharp(buffer)
    .resize(size, size, { fit: "cover" })
    .png()
    .toBuffer();
  return sharp(image)
    .composite([{ input: roundedMask, blend: "dest-in" }])
    .png()
    .toBuffer();
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
  const inviter = user.nickname || `用户${user.id}`;
  const productImageUrl = Array.isArray(product.images) && product.images.length ? product.images[0] : product.image_url || "";
  const posterAsset = await imageAsset(primaryPoster.image_url || campaign.share_cover || productImageUrl);
  const avatarAsset = await imageAsset(user.avatar);
  const hasPosterImage = Boolean(posterAsset.dataUri);
  const visualMaxWidth = 690;
  const visualMaxHeight = 980;
  const visualSize = hasPosterImage
    ? fitWithin(posterAsset.width, posterAsset.height, visualMaxWidth, visualMaxHeight)
    : { width: visualMaxWidth, height: 420 };
  const visualX = Math.round((750 - visualSize.width) / 2);
  const visualY = 30;
  const visualBottom = visualY + visualSize.height;
  const infoY = visualBottom + 22;
  const infoHeight = 290;
  const svgHeight = infoY + infoHeight + 28;
  const qrSize = 240;
  const qrX = 58;
  const qrY = infoY + 25;
  const avatarSize = 92;
  const avatarX = 340;
  const avatarY = infoY + 91;
  const nicknameLines = svgTextLines(inviter, 456, infoY + 151, { maxChars: 10, maxLines: 1, size: 34, lineHeight: 40, weight: 900, fill: "#111827" });
  const avatarFallback = avatarAsset.buffer ? "" : `
    <circle cx="${avatarX + avatarSize / 2}" cy="${avatarY + avatarSize / 2}" r="${avatarSize / 2}" fill="#14b8a6"/>
    <text x="${avatarX + avatarSize / 2}" y="${avatarY + 49}" text-anchor="middle" font-size="28" font-weight="900" fill="#ffffff">${escapeXml(avatarInitials(user))}</text>
  `;
  const posterVisual = hasPosterImage
    ? `<image x="${visualX}" y="${visualY}" width="${visualSize.width}" height="${visualSize.height}" preserveAspectRatio="xMidYMid meet" href="${escapeXml(posterAsset.dataUri)}"/>`
    : `
      <rect x="${visualX}" y="${visualY}" width="${visualSize.width}" height="${visualSize.height}" rx="30" fill="#111827"/>
      <circle cx="${visualX + 100}" cy="${visualY + 112}" r="70" fill="#22d3ee" opacity="0.78"/>
      <circle cx="${visualX + visualSize.width - 100}" cy="${visualY + visualSize.height - 114}" r="94" fill="#fb7185" opacity="0.72"/>
      <path d="M${visualX + 60} ${visualY + visualSize.height - 92} C${visualX + 158} ${visualY + 124} ${visualX + 264} ${visualY + visualSize.height - 33} ${visualX + 374} ${visualY + 166} C${visualX + 423} ${visualY + 93} ${visualX + 512} ${visualY + 102} ${visualX + 566} ${visualY + 52}" fill="none" stroke="#ffffff" stroke-width="20" stroke-linecap="round" opacity="0.86"/>
    `;
  const fallbackVisualText = hasPosterImage ? "" : `
    <text x="${visualX + 28}" y="${visualY + 65}" font-size="34" font-weight="900" fill="#ffffff">潮玩福利进行中</text>
    <text x="${visualX + 28}" y="${visualY + visualSize.height - 42}" font-size="26" font-weight="700" fill="#ffffff" opacity="0.84">扫码进入小程序参与活动</text>
  `;

  const svg = `
<svg width="750" height="${svgHeight}" viewBox="0 0 750 ${svgHeight}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <style>
      text { font-family: "Noto Sans CJK SC", "Noto Sans SC", "Microsoft YaHei", "WenQuanYi Micro Hei", sans-serif; }
    </style>
  </defs>
  <rect width="750" height="${svgHeight}" fill="#ffffff"/>
  <clipPath id="posterClip"><rect x="${visualX}" y="${visualY}" width="${visualSize.width}" height="${visualSize.height}" rx="30"/></clipPath>
  <g clip-path="url(#posterClip)">${posterVisual}</g>
  <rect x="${visualX}" y="${visualY}" width="${visualSize.width}" height="${visualSize.height}" rx="30" fill="none" stroke="#e5e7eb" stroke-width="2"/>
  ${fallbackVisualText}
  <rect x="30" y="${infoY}" width="690" height="${infoHeight}" rx="28" fill="#f8fafc"/>
  <rect x="${qrX - 14}" y="${qrY - 14}" width="${qrSize + 28}" height="${qrSize + 28}" rx="24" fill="#ffffff"/>
  <circle cx="${avatarX + avatarSize / 2}" cy="${avatarY + avatarSize / 2}" r="${avatarSize / 2 + 4}" fill="#ffffff" stroke="#e5e7eb" stroke-width="2"/>
  ${avatarFallback}
  <text x="456" y="${infoY + 96}" font-size="24" font-weight="700" fill="#64748b">邀请人</text>
  ${nicknameLines}
</svg>`;

  const qrcodeLayer = await sharp(qrcodeBuffer)
    .resize(qrSize, qrSize, { fit: "contain", background: "#ffffff" })
    .png()
    .toBuffer();
  const composites = [{ input: qrcodeLayer, left: qrX, top: qrY }];
  if (avatarAsset.buffer) {
    composites.push({
      input: await circleImageLayer(avatarAsset.buffer, avatarSize),
      left: avatarX,
      top: avatarY
    });
  }

  await sharp(Buffer.from(svg))
    .png()
    .composite(composites)
    .toFile(outputPath);
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
