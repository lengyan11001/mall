const adminState = {
  tab: "dashboard",
  campaignStep: "base",
  dashboard: null,
  products: [],
  orders: [],
  campaigns: [],
  selectedCampaign: null,
  campaignRelations: [],
  campaignOrders: [],
  campaignRewards: [],
  campaignDashboard: null,
  materials: [],
  distributors: [],
  commissions: [],
  withdrawals: [],
  settings: null,
  posterLayoutRow: null,
  posterLayout: null,
  posterLayoutSelected: "qr",
  posterLayoutDrag: null,
  token: localStorage.getItem("mallAdminToken") || ""
};

const $ = selector => document.querySelector(selector);
const $$ = selector => Array.from(document.querySelectorAll(selector));

const campaignSteps = ["base", "reward", "lottery", "traffic", "other", "done"];
const productSections = ["base", "media", "detail"];

function icon(name) {
  return (window.Icon && window.Icon[name]) || "";
}

function hydrateIcons() {
  $$(".slot-icon").forEach(slot => {
    slot.innerHTML = icon(slot.dataset.icon);
  });
}

function formatMoney(value) {
  return `¥${Number(value || 0).toFixed(2)}`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function pct(value) {
  return `${Math.round(Number(value || 0) * 100)}%`;
}

function dateLabel(value) {
  if (!value) return "-";
  return new Date(value).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function compactDateLabel(value) {
  if (!value) return "-";
  return new Date(value).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function countdownLabel(value) {
  if (!value) return "长期进行";
  const remaining = Math.max(0, new Date(value).getTime() - Date.now());
  const days = Math.floor(remaining / 86400000);
  const hours = Math.floor((remaining % 86400000) / 3600000);
  const minutes = Math.floor((remaining % 3600000) / 60000);
  const seconds = Math.floor((remaining % 60000) / 1000);
  return `${String(days).padStart(2, "0")}天 ${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function avatarNode(user = {}) {
  if (user.avatar && /^https?:\/\//.test(user.avatar)) {
    return `<img src="${escapeHtml(user.avatar)}" alt="${escapeHtml(user.nickname || "用户")}" />`;
  }
  const text = Array.from(user.nickname || user.avatar || "快").slice(0, 1).join("") || "快";
  return `<span>${escapeHtml(text)}</span>`;
}

function pillClass(status) {
  if (["rejected", "refunded", "canceled", "off", "ended", "expired", "disabled"].includes(status)) return "danger";
  if (["pending", "paid", "shipped", "approved", "draft"].includes(status)) return "warn";
  if (["published", "enabled"].includes(status)) return "blue";
  return "";
}

function toast(message) {
  const node = $("#toast");
  node.textContent = message;
  node.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => node.classList.remove("show"), 2200);
}

async function api(path, options = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...(adminState.token ? { "X-Admin-Token": adminState.token } : {}),
    ...(options.headers || {})
  };
  const response = await fetch(path, {
    ...options,
    headers
  });
  const payload = await response.json().catch(() => ({}));
  if (response.status === 401 && path !== "/api/admin/login") {
    showAdminLogin();
  }
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || "请求失败");
  }
  return payload.data;
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("文件读取失败"));
    reader.readAsDataURL(file);
  });
}

function uploadAccept(kind = "image") {
  return kind === "audio"
    ? "audio/mpeg,audio/mp3,audio/wav,audio/x-wav,audio/ogg,audio/mp4,audio/x-m4a"
    : "image/png,image/jpeg,image/webp,image/gif";
}

function validateUploadFile(file, kind = "image") {
  if (!file) return null;
  if (kind === "audio") {
    if (!/^audio\/(mpeg|mp3|wav|x-wav|ogg|mp4|x-m4a)$/.test(file.type || "")) {
      throw new Error("只支持 MP3、WAV、OGG、M4A 音频");
    }
    if (file.size > 20 * 1024 * 1024) {
      throw new Error("音频不能超过 20MB");
    }
    return file;
  }
  if (!/^image\/(png|jpe?g|webp|gif)$/.test(file.type || "")) {
    throw new Error("只支持 PNG、JPG、WebP、GIF 图片");
  }
  if (file.size > 5 * 1024 * 1024) {
    throw new Error("图片不能超过 5MB");
  }
  return file;
}

async function uploadAdminFile(file, kind = "image") {
  validateUploadFile(file, kind);
  const dataUrl = await readFileAsDataUrl(file);
  return api("/api/admin/uploads", {
    method: "POST",
    body: JSON.stringify({
      file_name: file.name,
      mime_type: file.type,
      data_url: dataUrl
    })
  });
}

function pickAndUploadFile(kind = "image") {
  return new Promise((resolve, reject) => {
    const picker = document.createElement("input");
    picker.type = "file";
    picker.accept = uploadAccept(kind);
    picker.style.display = "none";
    document.body.appendChild(picker);
    let settled = false;
    let focusTimer = null;
    let readyForCancel = false;
    const cleanup = () => {
      clearTimeout(focusTimer);
      window.removeEventListener("focus", handleFocus, true);
      picker.remove();
    };
    const finish = value => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const fail = error => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const handleFocus = () => {
      if (!readyForCancel) return;
      clearTimeout(focusTimer);
      focusTimer = setTimeout(() => {
        const hasFile = picker.files && picker.files.length;
        if (!hasFile) finish(null);
      }, 350);
    };
    picker.addEventListener("change", async () => {
      const file = picker.files && picker.files[0];
      if (!file) {
        finish(null);
        return;
      }
      try {
        finish(await uploadAdminFile(file, kind));
      } catch (error) {
        fail(error);
      }
    }, { once: true });
    picker.addEventListener("cancel", () => finish(null), { once: true });
    window.addEventListener("focus", handleFocus, true);
    setTimeout(() => {
      readyForCancel = true;
    }, 0);
    picker.click();
  });
}

async function uploadOrPromptUrl(promptTitle, kind = "image") {
  const uploaded = await pickAndUploadFile(kind);
  if (uploaded && uploaded.url) {
    toast(kind === "audio" ? "音频已上传" : "图片已上传");
    return uploaded.url;
  }
  return prompt(promptTitle, "") || "";
}

function renderImagePreview(input, preview) {
  if (!input || !preview) return;
  const url = input.value.trim();
  preview.innerHTML = url ? `<img src="${escapeAttr(url)}" alt="图片预览" />` : "";
}

function renderImageUrlPreview(inputSelector, previewSelector) {
  renderImagePreview($(inputSelector), $(previewSelector));
}

function uploadControl(field, value = "", placeholder = "上传图片后自动生成链接，也可以粘贴图片链接", kind = "image") {
  const accept = uploadAccept(kind);
  const label = kind === "audio" ? "上传音频" : "上传图片";
  const preview = kind === "image" && value ? `<img src="${escapeAttr(value)}" alt="图片预览" />` : "";
  return `
    <div class="table-upload-cell">
      <div class="image-upload-row">
        <input class="input" data-field="${field}" value="${escapeAttr(value || "")}" placeholder="${escapeAttr(placeholder)}" />
        <button class="btn ghost compact" type="button" data-upload-field="${field}" data-upload-kind="${kind}" data-upload-accept="${accept}">${label}</button>
      </div>
      ${kind === "image" ? `<div class="image-url-preview">${preview}</div>` : ""}
    </div>`;
}

function chooseAndUploadFile(button) {
  const targetSelector = button.dataset.uploadTarget;
  const previewSelector = button.dataset.previewTarget;
  const kind = button.dataset.uploadKind || "image";
  const inline = button.closest(".table-upload-cell") || button.closest(".field");
  const input = targetSelector ? $(targetSelector) : inline?.querySelector("input");
  if (!input) return;
  const picker = document.createElement("input");
  picker.type = "file";
  picker.accept = button.dataset.uploadAccept || uploadAccept(kind);
  picker.addEventListener("change", async () => {
    const file = picker.files && picker.files[0];
    if (!file) return;
    const originalText = button.textContent || button.dataset.uploadLabel || (kind === "audio" ? "上传音频" : "上传图片");
    button.disabled = true;
    button.textContent = "上传中";
    try {
      const uploaded = await uploadAdminFile(file, kind);
      input.value = uploaded.url;
      const preview = previewSelector ? $(previewSelector) : inline?.querySelector(".image-url-preview");
      if (kind === "image") renderImagePreview(input, preview);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      toast(kind === "audio" ? "音频已上传" : "图片已上传");
    } catch (error) {
      toast(error.message);
    } finally {
      button.disabled = false;
      button.textContent = originalText;
    }
  }, { once: true });
  picker.click();
}

function showAdminLogin() {
  $("#admin-login-layer").classList.add("open");
}

function hideAdminLogin() {
  $("#admin-login-layer").classList.remove("open");
}

async function adminLogin() {
  const data = await api("/api/admin/login", {
    method: "POST",
    body: JSON.stringify({
      username: $("#admin-login-user").value.trim(),
      password: $("#admin-login-password").value
    })
  });
  adminState.token = data.token;
  localStorage.setItem("mallAdminToken", data.token);
  hideAdminLogin();
  toast("登录成功");
  await loadCurrent();
}

function adminLogout() {
  adminState.token = "";
  localStorage.removeItem("mallAdminToken");
  showAdminLogin();
}

function setAdminTab(tab) {
  adminState.tab = tab;
  const meta = {
    dashboard: ["数据看板", "销售额、订单量、用户增长和分销表现"],
    products: ["商品管理", "完整商品资料、价格、库存、配送、售后和图文详情"],
    acquisition: ["拓客宝", "引流商品、关系锁定、推荐奖励、引流码、表单和战报"],
    orders: ["订单管理", "筛选、发货、物流单号和退款处理"],
    distributors: ["分销管理", "分销员审核、关系链和佣金流水"],
    withdrawals: ["提现审核", "提现申请审核、拒绝和模拟打款"],
    settings: ["系统设置", "佣金比例、最低提现和合规称呼"]
  };
  $("#admin-title").textContent = meta[tab][0];
  $("#admin-subtitle").textContent = meta[tab][1];
  $$(".admin-nav button").forEach(button => button.classList.toggle("active", button.dataset.adminTab === tab));
  $$(".admin-view").forEach(view => view.classList.toggle("active", view.id === `admin-${tab}`));
  if (tab === "products") showProductOverview();
  if (tab === "acquisition") showCampaignOverview();
  loadCurrent();
}

async function loadCurrent() {
  if (adminState.tab === "dashboard") await loadDashboard();
  if (adminState.tab === "products") await loadProducts();
  if (adminState.tab === "acquisition") await loadAcquisition();
  if (adminState.tab === "orders") await loadOrders();
  if (adminState.tab === "distributors") await loadDistributors();
  if (adminState.tab === "withdrawals") await loadWithdrawals();
  if (adminState.tab === "settings") await loadSettings();
}

async function loadDashboard() {
  adminState.dashboard = await api("/api/admin/dashboard");
  renderDashboard();
}

async function loadProducts() {
  adminState.products = await api("/api/admin/products");
  renderProducts();
}

async function loadAcquisition() {
  const [campaigns, materials, products] = await Promise.all([
    api("/api/admin/acquisition/campaigns"),
    api("/api/admin/acquisition/materials"),
    adminState.products.length ? Promise.resolve(adminState.products) : api("/api/admin/products")
  ]);
  adminState.campaigns = campaigns;
  adminState.materials = materials;
  adminState.products = products;
  if (campaigns.length) {
    const selectedId = adminState.selectedCampaign?.id;
    adminState.selectedCampaign = campaigns.find(campaign => campaign.id === selectedId) || campaigns[0];
  } else {
    adminState.selectedCampaign = null;
    adminState.campaignRelations = [];
    adminState.campaignOrders = [];
    adminState.campaignRewards = [];
    adminState.campaignDashboard = null;
  }
  renderCampaigns();
  renderMaterials();
  if (adminState.selectedCampaign) await selectCampaign(adminState.selectedCampaign.id, false);
  else renderCampaignDetail();
}

async function loadOrders() {
  adminState.orders = await api("/api/admin/orders");
  renderOrders();
}

async function loadDistributors() {
  const [distributors, commissions] = await Promise.all([
    api("/api/admin/distributors"),
    api("/api/admin/commissions")
  ]);
  adminState.distributors = distributors;
  adminState.commissions = commissions;
  renderDistributors();
}

async function loadWithdrawals() {
  adminState.withdrawals = await api("/api/admin/withdrawals");
  renderWithdrawals();
}

async function loadSettings() {
  adminState.settings = await api("/api/admin/settings");
  renderSettings();
}

function renderDashboard() {
  const data = adminState.dashboard;
  $("#metric-grid").innerHTML = [
    ["销售额", formatMoney(data.sales)],
    ["订单量", data.orders],
    ["用户数", data.users],
    ["佣金池", formatMoney(data.commission)],
    ["有效商品", data.products_on],
    ["待审提现", formatMoney(data.pending_withdrawals)],
    ["已支付销售", formatMoney(data.paid_sales)],
    ["最近订单", data.recent_orders.length]
  ].map(([label, value]) => `
    <div class="metric">
      <span>${label}</span>
      <strong>${value}</strong>
    </div>
  `).join("");

  $("#recent-orders").innerHTML = data.recent_orders.map(order => `
    <tr>
      <td>#${order.id}<br><small>${dateLabel(order.created_at)}</small></td>
      <td>${order.user?.nickname || "-"}</td>
      <td>${order.product?.title || "-"}</td>
      <td>${formatMoney(order.amount)}</td>
      <td><span class="pill ${pillClass(order.status)}">${order.status_text}</span></td>
    </tr>
  `).join("");

  $("#top-distributors").innerHTML = data.top_distributors.map(user => `
    <article class="list-item">
      <div class="list-item-head">
        <h3>${user.nickname}</h3>
        <span class="pill">${formatMoney(user.total_commission)}</span>
      </div>
      <p>ID ${user.id} · 直接客户 ${user.direct_count} · ${user.distributor_status}</p>
    </article>
  `).join("");
}

function renderProducts() {
  $("#product-table").innerHTML = adminState.products.map(product => `
    <tr>
      <td>
        <div style="display:flex; align-items:center; gap:10px; min-width:220px;">
          <img class="thumb" src="${product.images[0] || ""}" alt="${product.title}" />
          <div><strong>${product.title}</strong><br><small>${product.description || ""}</small></div>
        </div>
      </td>
      <td>${product.category}</td>
      <td>${formatMoney(product.price)}</td>
      <td>${product.stock}</td>
      <td>${pct(product.commission_rate)}</td>
      <td><span class="pill ${pillClass(product.status)}">${product.status_text}</span></td>
      <td>
        <div class="row-actions">
          <button class="btn ghost" data-edit-product="${product.id}">${icon("edit")} 编辑</button>
          <button class="btn secondary" data-toggle-product="${product.id}">${product.status === "on" ? "下架" : "上架"}</button>
          <button class="btn danger" data-delete-product="${product.id}">删除</button>
        </div>
      </td>
    </tr>
  `).join("");
}

function renderCampaigns() {
  $("#campaign-product").innerHTML = adminState.products.map(product => `
    <option value="${product.id}">${product.title} / ${product.product_no || product.id}</option>
  `).join("");
  $("#campaign-table").innerHTML = adminState.campaigns.length ? adminState.campaigns.map(campaign => `
    <tr class="${adminState.selectedCampaign?.id === campaign.id ? "selected" : ""}">
      <td><strong>${campaign.name}</strong><br><small>${dateLabel(campaign.start_at)} - ${dateLabel(campaign.end_at)}</small></td>
      <td>${campaign.product?.title || "-"}<br><small>${campaign.product?.product_no || ""}</small></td>
      <td>${formatMoney(campaign.lead_price)}<br><small>库存 ${campaign.stock}</small></td>
      <td>${campaign.relation_mode_text}</td>
      <td>会员 ${campaign.relation_count}<br><small>订单 ${campaign.order_count}</small></td>
      <td><span class="pill ${pillClass(campaign.status)}">${campaign.status_text}</span></td>
      <td>
        <div class="row-actions">
          <button class="btn ghost" data-select-campaign="${campaign.id}">${icon("chart")} 查看</button>
          <button class="btn ghost" data-edit-campaign="${campaign.id}">${icon("edit")} 编辑</button>
          <button class="btn secondary" data-campaign-action="${campaign.id}" data-action="${campaign.status === "published" ? "end" : "publish"}">${campaign.status === "published" ? "结束" : "发布"}</button>
          <button class="btn danger" data-delete-campaign="${campaign.id}">删除</button>
        </div>
      </td>
    </tr>
  `).join("") : '<tr><td colspan="7"><div class="empty">暂无拓客宝活动</div></td></tr>';
}

function renderCampaignDetail() {
  const campaign = adminState.selectedCampaign;
  if (!campaign) {
    $("#campaign-detail").innerHTML = '<div class="empty">选择一个活动查看配置</div>';
    $("#campaign-relations").innerHTML = "";
    return;
  }
  const dashboard = adminState.campaignDashboard || {};
  $("#campaign-detail").innerHTML = `
    <article class="list-item">
      <div class="list-item-head">
        <h3>${campaign.name}</h3>
        <span class="pill ${pillClass(campaign.status)}">${campaign.status_text}</span>
      </div>
      <p>${campaign.description || "未填写描述"}</p>
      <div class="config-grid">
        <div class="config-item"><span>绑定模式</span><strong>${campaign.relation_mode_text}</strong></div>
        <div class="config-item"><span>发放方式</span><strong>${campaign.reward_issue_way === "instant" ? "直接到账" : "提现后发放"}</strong></div>
        <div class="config-item"><span>奖励权限</span><strong>${campaign.reward_permission === "buyer_only" ? "购物后可分销" : "人人分销"}</strong></div>
        <div class="config-item"><span>奖励规则</span><strong>${campaign.reward_rule === "member_level" ? "按会员等级" : "统一奖励"}</strong></div>
        <div class="config-item"><span>转化率</span><strong>${pct(dashboard.conversion_rate || 0)}</strong></div>
        <div class="config-item"><span>访客/浏览</span><strong>${dashboard.visitors || 0} / ${dashboard.browse_count || 0}</strong></div>
        <div class="config-item"><span>订单/金额</span><strong>${dashboard.order_count || 0} / ${formatMoney(dashboard.paid_amount || 0)}</strong></div>
        <div class="config-item"><span>一级/二级奖励</span><strong>${formatMoney(campaign.reward_level1)} / ${formatMoney(campaign.reward_level2)}</strong></div>
        <div class="config-item"><span>团队长奖励</span><strong>${campaign.team_reward_enabled ? `${formatMoney(campaign.team_reward_level1)} / ${formatMoney(campaign.team_reward_level2)}` : "未启用"}</strong></div>
        <div class="config-item"><span>额外奖励</span><strong>${campaign.reward_multiple_enabled ? "倍数" : ""}${campaign.reward_multiple_enabled && campaign.reward_step_enabled ? " + " : ""}${campaign.reward_step_enabled ? "阶梯" : ""}${!campaign.reward_multiple_enabled && !campaign.reward_step_enabled ? "未启用" : ""}</strong></div>
        <div class="config-item"><span>奖励合计</span><strong>${formatMoney(dashboard.reward_amount || campaign.reward_total)}</strong></div>
        <div class="config-item"><span>下单抽奖</span><strong>${campaign.lottery_enabled ? `已启用 / ${(campaign.lottery_config?.prizes || []).length} 档` : "未启用"}</strong></div>
        <div class="config-item"><span>引流码</span><strong>${campaign.qrcode_count || 0} 个</strong></div>
        <div class="config-item"><span>虚拟量</span><strong>销量 ${campaign.virtual_sold_count || 0} / 浏览 ${campaign.virtual_browse_count || 0}</strong></div>
      </div>
    </article>
    <article class="list-item">
      <div class="list-item-head"><h3>引流码</h3><button class="btn ghost" data-add-qrcode="${campaign.id}">${icon("plus")} 添加</button></div>
      ${(campaign.qrcodes || []).length ? campaign.qrcodes.map(qrcode => `
        <div class="inline-data-row">
          <span>${qrcode.type_text} · ${qrcode.name} · 已展示 ${qrcode.shown_count}/${qrcode.show_limit || "不限"} · ${qrcode.status_text}</span>
          <button class="btn secondary compact" type="button" data-delete-qrcode="${qrcode.id}" data-campaign-id="${campaign.id}">删除</button>
        </div>
      `).join("") : '<p>还没有配置引流码。建议先添加个人码，再添加群码。</p>'}
    </article>
    <article class="list-item">
      <div class="list-item-head"><h3>下单表单</h3><span class="pill blue">${(campaign.form_schema || []).length} 项</span></div>
      <p>${(campaign.form_schema || []).map(item => item.label || item.name || item.type).join(" / ") || "未配置，用户按默认下单流程提交。"}</p>
    </article>
  `;
  $("#campaign-relations").innerHTML = adminState.campaignRelations.length ? adminState.campaignRelations.map(item => `
    <tr>
      <td>${item.member.nickname || `ID ${item.member_id}`}<br><small>${item.member.phone || ""}</small></td>
      <td>${item.inviter?.nickname || "-"}<br><small>${item.inviter?.phone || ""}</small></td>
      <td>${item.parent_inviter?.nickname || "-"}<br><small>${item.locked_by}</small></td>
      <td>${item.team_leader?.nickname || "-"}<br><small>${item.indirect_team_leader?.nickname || ""}</small></td>
      <td>${dateLabel(item.entered_at)}</td>
    </tr>
  `).join("") : '<tr><td colspan="5"><div class="empty">暂无活动关系链数据</div></td></tr>';
}

function renderMaterials() {
  $("#material-list").innerHTML = adminState.materials.length ? adminState.materials.map(item => `
    <article class="list-item">
      <div class="list-item-head">
        <h3>${item.type_text}</h3>
        <div class="row-actions">
          <span class="pill">排序 ${item.sort_order}</span>
          <button class="btn secondary compact" type="button" data-delete-material="${item.id}">删除</button>
        </div>
      </div>
      <p>${item.image_url}</p>
    </article>
  `).join("") : '<div class="empty">暂无素材模板</div>';
}

function renderOrders() {
  $("#order-table").innerHTML = adminState.orders.map(order => `
    <tr>
      <td>#${order.id}<br><small>${dateLabel(order.created_at)}</small></td>
      <td>${order.user?.nickname || "-"}<br><small>${order.address || ""}</small></td>
      <td>${order.product?.title || "-"}<br><small>${order.quantity} 件</small></td>
      <td>${formatMoney(order.amount)}</td>
      <td>${order.logistics_no || "待发货"}</td>
      <td><span class="pill ${pillClass(order.status)}">${order.status_text}</span></td>
      <td>
        <div class="row-actions">
          <button class="btn ghost" data-ship="${order.id}" ${order.status === "paid" ? "" : "disabled"}>${icon("truck")} 发货</button>
          <button class="btn secondary" data-receive="${order.id}" ${["paid", "shipped"].includes(order.status) ? "" : "disabled"}>${icon("check")} 收货</button>
          <button class="btn danger" data-refund="${order.id}" ${order.status !== "refunded" ? "" : "disabled"}>退款</button>
        </div>
      </td>
    </tr>
  `).join("");
}

function renderDistributors() {
  const statusText = { approved: "已通过", pending: "待审核", rejected: "已拒绝" };
  $("#distributor-table").innerHTML = adminState.distributors.map(user => `
    <tr>
      <td><strong>${user.nickname}</strong><br><small>ID ${user.id} · ${user.phone || "未绑定手机号"}</small></td>
      <td>${user.parent?.nickname || "-"}</td>
      <td>${user.direct_count}</td>
      <td>${formatMoney(user.total_commission)}</td>
      <td>${formatMoney(user.available_balance)}</td>
      <td><span class="pill ${pillClass(user.distributor_status)}">${statusText[user.distributor_status] || user.distributor_status}</span></td>
      <td>
        <div class="row-actions">
          <button class="btn ghost" data-distributor="${user.id}" data-status="approved">通过</button>
          <button class="btn danger" data-distributor="${user.id}" data-status="rejected">拒绝</button>
          <button class="btn secondary" data-distributor="${user.id}" data-status="pending">待审</button>
        </div>
      </td>
    </tr>
  `).join("");

  $("#commission-flow").innerHTML = adminState.commissions.length ? adminState.commissions.slice(0, 18).map(item => `
    <article class="list-item">
      <div class="list-item-head">
        <h3>${item.beneficiary?.nickname || "-"} · ${item.level_text || `${item.level} 级`}</h3>
        <span class="pill ${pillClass(item.status)}">${item.status_text}</span>
      </div>
      <p>订单 #${item.order_id} · ${item.product?.title || "-"} · 买家 ${item.buyer?.nickname || "-"}</p>
      <strong>${formatMoney(item.amount)}</strong>
    </article>
  `).join("") : '<div class="empty">暂无佣金流水</div>';
}

function renderWithdrawals() {
  $("#withdrawal-table").innerHTML = adminState.withdrawals.map(item => `
    <tr>
      <td>#${item.id}<br><small>${dateLabel(item.created_at)}</small></td>
      <td>${item.user?.nickname || "-"}<br><small>ID ${item.user_id}</small></td>
      <td>${formatMoney(item.amount)}</td>
      <td>${item.note || "-"}</td>
      <td><span class="pill ${pillClass(item.status)}">${item.status_text}</span></td>
      <td>${item.review_note || "待审核"}<br><small>${dateLabel(item.reviewed_at)}</small></td>
      <td>
        <div class="row-actions">
          <button class="btn ghost" data-withdrawal="${item.id}" data-action="approve" ${item.status === "pending" ? "" : "disabled"}>通过</button>
          <button class="btn" data-withdrawal="${item.id}" data-action="pay" ${["pending", "approved"].includes(item.status) ? "" : "disabled"}>打款</button>
          <button class="btn danger" data-withdrawal="${item.id}" data-action="reject" ${item.status === "pending" ? "" : "disabled"}>拒绝</button>
        </div>
      </td>
    </tr>
  `).join("");
}

function renderSettings() {
  const settings = adminState.settings;
  $("#setting-level1").value = settings.commission_level_1;
  $("#setting-level2").value = settings.commission_level_2;
  $("#setting-min-withdrawal").value = settings.min_withdrawal;
  $("#setting-compliance-name").value = settings.compliance_name;
  $("#setting-auto-pay").checked = Boolean(settings.auto_pay_enabled);
}

function setProductSection(section) {
  const next = productSections.includes(section) ? section : "base";
  if (next === "detail") syncRichEditorFromSource();
  $$("[data-product-section]").forEach(button => {
    button.classList.toggle("active", button.dataset.productSection === next);
  });
  $$(".product-section").forEach(panel => {
    panel.classList.toggle("active", panel.dataset.productPanel === next);
  });
  if (next === "media") renderProductImagePreview();
}

function showProductOverview() {
  $("#product-overview").classList.remove("hidden");
  $("#product-editor").classList.add("hidden");
}

function openProductEditor(product = null) {
  $("#product-overview").classList.add("hidden");
  $("#product-editor").classList.remove("hidden");
  $("#product-editor-title").textContent = product ? "编辑商品" : "新增商品";
  $("#product-id").value = product?.id || "";
  $("#product-title").value = product?.title || "";
  $("#product-subtitle").value = product?.subtitle || "";
  $("#product-no").value = product?.product_no || "";
  $("#product-barcode").value = product?.barcode || "";
  $("#product-category").value = product?.category || "";
  $("#product-brand").value = product?.brand || "";
  $("#product-unit").value = product?.unit || "件";
  $("#product-status").value = product?.status || "on";
  $("#product-market-price").value = product?.market_price || product?.price || "";
  $("#product-price").value = product?.price || "";
  $("#product-cost-price").value = product?.cost_price || "";
  $("#product-stock").value = product?.stock ?? "";
  $("#product-commission").value = product?.commission_rate ?? 0.12;
  $("#product-weight").value = product?.weight ?? 0;
  $("#product-min-buy").value = product?.min_buy_qty ?? 1;
  $("#product-order-limit").value = product?.per_order_limit ?? 0;
  $("#product-user-limit").value = product?.per_user_limit ?? 0;
  $("#product-images").value = (product?.images || []).join("\n");
  $("#product-description").value = product?.description || "";
  $("#product-detail").value = product?.detail_html || "";
  setRichEditorHtml(product?.detail_html || "");
  $("#product-virtual").checked = Boolean(product?.is_virtual);
  $("#product-no-refund").checked = Boolean(product?.no_refund_after_pay);
  setProductSection("base");
  renderProductImagePreview();
}

function productFormPayload() {
  return {
    title: $("#product-title").value.trim(),
    subtitle: $("#product-subtitle").value.trim(),
    product_no: $("#product-no").value.trim(),
    barcode: $("#product-barcode").value.trim(),
    category: $("#product-category").value.trim(),
    brand: $("#product-brand").value.trim(),
    unit: $("#product-unit").value.trim() || "件",
    status: $("#product-status").value,
    market_price: Number($("#product-market-price").value || 0),
    price: Number($("#product-price").value),
    cost_price: Number($("#product-cost-price").value || 0),
    stock: Number($("#product-stock").value),
    commission_rate: Number($("#product-commission").value),
    weight: Number($("#product-weight").value || 0),
    min_buy_qty: Number($("#product-min-buy").value || 1),
    per_order_limit: Number($("#product-order-limit").value || 0),
    per_user_limit: Number($("#product-user-limit").value || 0),
    images: productImages(),
    description: $("#product-description").value.trim(),
    detail_html: productDetailHtml(),
    is_virtual: $("#product-virtual").checked,
    no_refund_after_pay: $("#product-no-refund").checked,
    delivery_methods: ["express"]
  };
}

function productImages() {
  return $("#product-images").value.split(/\r?\n/).map(item => item.trim()).filter(Boolean);
}

function setProductImages(images = []) {
  $("#product-images").value = [...new Set((images || []).map(item => String(item || "").trim()).filter(Boolean))].join("\n");
  renderProductImagePreview();
}

async function uploadProductImage() {
  const uploaded = await pickAndUploadFile("image");
  if (!uploaded || !uploaded.url) return;
  setProductImages([...productImages(), uploaded.url]);
  toast("商品图片已上传");
}

function renderProductImagePreview() {
  const images = productImages();
  $("#product-image-preview").innerHTML = images.length
    ? images.map((src, index) => `
      <div class="product-image-card">
        <img src="${escapeAttr(src)}" alt="商品图 ${index + 1}" />
        <button class="image-delete" type="button" data-remove-product-image="${index}" title="删除图片">删除</button>
      </div>
    `).join("")
    : '<div class="empty">图片 URL 每行一张，预览会显示在这里。</div>';
}

function setRichEditorHtml(html) {
  $("#product-rich-editor").innerHTML = html || "";
  $("#product-rich-source").value = html || "";
  $("#product-rich-preview").innerHTML = html || "";
  $("#product-detail").value = html || "";
}

function syncRichEditorFromSource() {
  if (!$("#product-rich-source").classList.contains("hidden")) {
    $("#product-rich-editor").innerHTML = $("#product-rich-source").value;
  }
}

function productDetailHtml() {
  syncRichEditorFromSource();
  const html = $("#product-rich-editor").innerHTML.trim();
  $("#product-detail").value = html;
  return html;
}

function runRichCommand(command, value = null) {
  $("#product-rich-editor").focus();
  document.execCommand(command, false, value);
  productDetailHtml();
}

async function insertRichImage() {
  const url = await uploadOrPromptUrl("图片 URL", "image");
  if (url) runRichCommand("insertImage", url);
}

function toggleRichSource() {
  const source = $("#product-rich-source");
  const editor = $("#product-rich-editor");
  const preview = $("#product-rich-preview");
  if (source.classList.contains("hidden")) {
    source.value = productDetailHtml();
    source.classList.remove("hidden");
    editor.classList.add("hidden");
    preview.classList.add("hidden");
  } else {
    editor.innerHTML = source.value;
    source.classList.add("hidden");
    editor.classList.remove("hidden");
    preview.classList.add("hidden");
    productDetailHtml();
  }
}

function showRichPreview() {
  const preview = $("#product-rich-preview");
  const editor = $("#product-rich-editor");
  const source = $("#product-rich-source");
  const showing = !preview.classList.contains("hidden");
  if (showing) {
    preview.classList.add("hidden");
    source.classList.add("hidden");
    editor.classList.remove("hidden");
    return;
  }
  preview.innerHTML = productDetailHtml();
  preview.classList.remove("hidden");
  editor.classList.add("hidden");
  source.classList.add("hidden");
}

function toDateTimeLocal(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

function fromDateTimeLocal(value) {
  return value ? new Date(value).toISOString() : "";
}

function escapeAttr(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function splitList(value) {
  return String(value || "")
    .split(/[,，、;；\s\n]+/)
    .map(item => item.trim())
    .filter(Boolean);
}

function numberValue(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function posterNicknamePreviewText() {
  return "\u7528\u6237\u6635\u79f0";
}

function estimatedLayoutTextWidth(value, fontSize) {
  return Array.from(String(value || "")).reduce((sum, char) => {
    if (/[\u2e80-\u9fff\uff00-\uffef]/.test(char)) return sum + fontSize;
    if (/\s/.test(char)) return sum + fontSize * 0.32;
    return sum + fontSize * 0.62;
  }, 0);
}

function compactNicknameWidth(maxWidth, fontSize, text = posterNicknamePreviewText()) {
  const textWidth = Math.max(fontSize * 1.8, estimatedLayoutTextWidth(text, fontSize) + Math.max(0.01, fontSize * 0.28));
  return clamp(textWidth, Math.min(maxWidth, fontSize * 1.8), maxWidth);
}

function legacyNicknameXToLeft(x, width, fontSize, align) {
  const compactWidth = compactNicknameWidth(width, fontSize);
  if (align === "right") return x + width - compactWidth;
  if (align === "center") return x + (width - compactWidth) / 2;
  return x;
}

function defaultPosterLayout() {
  return {
    mode: "overlay",
    qr: { x: 0.38, y: 0.34, size: 0.28 },
    avatar: { x: 0.86, y: 0.025, size: 0.095 },
    nickname: { x: 0.42, y: 0.045, width: 0.42, font_size: 0.032, color: "#ffffff", align: "right" }
  };
}

function normalizePosterLayout(layout = {}) {
  const defaults = defaultPosterLayout();
  const sourceNickname = layout.nickname || {};
  const nicknameWidth = clamp(numberValue(sourceNickname.width, defaults.nickname.width), 0.08, 0.85);
  const nicknameFontSize = clamp(numberValue(sourceNickname.font_size, defaults.nickname.font_size), 0.016, 0.08);
  const nicknameAlign = ["left", "center", "right"].includes(sourceNickname.align) ? sourceNickname.align : defaults.nickname.align;
  const nicknameRawX = numberValue(sourceNickname.x, defaults.nickname.x);
  const nicknameX = sourceNickname.anchor === "left"
    ? nicknameRawX
    : legacyNicknameXToLeft(nicknameRawX, nicknameWidth, nicknameFontSize, nicknameAlign);
  return {
    mode: "overlay",
    qr: {
      x: clamp(numberValue(layout.qr?.x, defaults.qr.x), 0, 0.98),
      y: clamp(numberValue(layout.qr?.y, defaults.qr.y), 0, 0.98),
      size: clamp(numberValue(layout.qr?.size, defaults.qr.size), 0.08, 0.5)
    },
    avatar: {
      x: clamp(numberValue(layout.avatar?.x, defaults.avatar.x), 0, 0.98),
      y: clamp(numberValue(layout.avatar?.y, defaults.avatar.y), 0, 0.98),
      size: clamp(numberValue(layout.avatar?.size, defaults.avatar.size), 0.04, 0.22)
    },
    nickname: {
      anchor: "left",
      x: clamp(nicknameX, 0, 0.98),
      y: clamp(numberValue(sourceNickname.y, defaults.nickname.y), 0, 0.98),
      width: nicknameWidth,
      font_size: nicknameFontSize,
      color: /^#[0-9a-f]{6}$/i.test(String(sourceNickname.color || "")) ? sourceNickname.color : defaults.nickname.color,
      align: nicknameAlign
    }
  };
}

function posterLayoutFromInput(input) {
  try {
    const value = JSON.parse(input?.value || "{}");
    return normalizePosterLayout(value);
  } catch {
    return defaultPosterLayout();
  }
}

function posterLayoutValue(layout) {
  return JSON.stringify(normalizePosterLayout(layout));
}

function renderCampaignRows(type, rows = []) {
  const safeRows = Array.isArray(rows) ? rows : [];
  if (type === "lottery-prize") {
    const list = safeRows.length ? safeRows : [{ name: "谢谢参与", type: "thanks", probability: 0.8 }, { name: "现金红包", type: "cash", amount: 1, quantity: 100, limit_per_user: 1, probability: 0.2 }];
    $("#campaign-lottery-prize-rows").innerHTML = list.map(prize => `
      <tr data-row-type="lottery-prize">
        <td><input class="input" data-field="name" value="${escapeAttr(prize.name || "")}" placeholder="谢谢参与" /></td>
        <td>${uploadControl("image_url", prize.image_url || "", "上传奖品图片")}</td>
        <td>
          <select class="select" data-field="type">
            <option value="thanks" ${prize.type === "thanks" ? "selected" : ""}>谢谢参与</option>
            <option value="cash" ${prize.type === "cash" ? "selected" : ""}>现金红包</option>
            <option value="goods" ${prize.type === "goods" ? "selected" : ""}>实物奖品</option>
            <option value="coupon" ${prize.type === "coupon" ? "selected" : ""}>优惠券</option>
          </select>
        </td>
        <td><input class="input" data-field="amount" type="number" min="0" step="0.01" value="${Number(prize.amount || 0)}" /></td>
        <td><input class="input" data-field="quantity" type="number" min="0" step="1" value="${Number(prize.quantity || 0)}" /></td>
        <td><input class="input" data-field="limit_per_user" type="number" min="0" step="1" value="${Number(prize.limit_per_user || 0)}" /></td>
        <td><input class="input" data-field="probability_percent" type="number" min="0" max="100" step="0.01" value="${Number(prize.probability || 0) * 100}" /></td>
        <td><button class="btn secondary compact" type="button" data-remove-campaign-row>删除</button></td>
      </tr>
    `).join("");
    return;
  }
  if (type === "ranking") {
    $("#campaign-ranking-rows").innerHTML = safeRows.map(item => `
      <tr data-row-type="ranking">
        <td>${uploadControl("avatar", item.avatar || "", "上传头像图片")}</td>
        <td><input class="input" data-field="nickname" value="${escapeAttr(item.nickname || "")}" placeholder="用户昵称" /></td>
        <td><input class="input" data-field="invite_count" type="number" min="0" step="1" value="${Number(item.invite_count || 0)}" /></td>
        <td><input class="input" data-field="reward_amount" type="number" min="0" step="0.01" value="${Number(item.reward_amount || 0)}" /></td>
        <td><button class="btn secondary compact" type="button" data-remove-campaign-row>删除</button></td>
      </tr>
    `).join("");
    return;
  }
  if (type === "form-field") {
    $("#campaign-form-field-rows").innerHTML = safeRows.map(item => `
      <tr data-row-type="form-field">
        <td><input class="input" data-field="label" value="${escapeAttr(item.label || item.name || "")}" placeholder="收货人姓名" /></td>
        <td><input class="input" data-field="name" value="${escapeAttr(item.name || "")}" placeholder="buyer_name" /></td>
        <td>
          <select class="select" data-field="type">
            <option value="text" ${item.type === "text" ? "selected" : ""}>文本</option>
            <option value="phone" ${item.type === "phone" ? "selected" : ""}>手机号</option>
            <option value="number" ${item.type === "number" ? "selected" : ""}>数字</option>
            <option value="select" ${item.type === "select" ? "selected" : ""}>下拉选择</option>
            <option value="textarea" ${item.type === "textarea" ? "selected" : ""}>多行文本</option>
          </select>
        </td>
        <td><input class="input" data-field="options" value="${escapeAttr(Array.isArray(item.options) ? item.options.join("，") : "")}" placeholder="选项用逗号分隔" /></td>
        <td><input data-field="required" type="checkbox" ${item.required ? "checked" : ""} /></td>
        <td><button class="btn secondary compact" type="button" data-remove-campaign-row>删除</button></td>
      </tr>
    `).join("");
    return;
  }
  if (type === "poster") {
    $("#campaign-poster-rows").innerHTML = safeRows.map(item => `
      <tr data-row-type="poster">
        <td>
          ${uploadControl("image_url", item.image_url || "", "上传海报主视觉")}
          <input type="hidden" data-field="layout" value="${escapeAttr(posterLayoutValue(item.layout || defaultPosterLayout()))}" />
          <div style="margin-top:6px;">
            <button class="btn ghost compact" type="button" data-poster-layout>排版</button>
          </div>
        </td>
        <td><input class="input" data-field="text" value="${escapeAttr(item.text || item.title || "")}" placeholder="显示在专属邀请海报上的文案" /></td>
        <td><button class="btn secondary compact" type="button" data-remove-campaign-row>删除</button></td>
      </tr>
    `).join("");
  }
}

function addCampaignRow(type) {
  const defaults = {
    "lottery-prize": { name: "谢谢参与", type: "thanks", probability: 0.1 },
    ranking: { avatar: "", nickname: "", invite_count: 0, reward_amount: 0 },
    "form-field": { label: "", name: "", type: "text", options: [], required: false },
    poster: { image_url: "", text: "", layout: defaultPosterLayout() }
  };
  if (!defaults[type]) return;
  renderCampaignRows(type, [...readCampaignRows(type), defaults[type]]);
}

function readCampaignRows(type) {
  if (type === "lottery-prize") {
    return $$("#campaign-lottery-prize-rows tr").map(row => {
      const rawName = row.querySelector('[data-field="name"]').value.trim();
      const imageUrl = row.querySelector('[data-field="image_url"]').value.trim();
      const probability = Math.max(0, numberValue(row.querySelector('[data-field="probability_percent"]').value, 0) / 100);
      if (!rawName && !imageUrl && probability <= 0) return null;
      return {
        name: rawName || "谢谢参与",
        image_url: imageUrl,
        type: row.querySelector('[data-field="type"]').value,
        amount: numberValue(row.querySelector('[data-field="amount"]').value, 0),
        quantity: Math.max(0, Math.floor(numberValue(row.querySelector('[data-field="quantity"]').value, 0))),
        limit_per_user: Math.max(0, Math.floor(numberValue(row.querySelector('[data-field="limit_per_user"]').value, 0))),
        probability
      };
    }).filter(Boolean);
  }
  if (type === "ranking") {
    return $$("#campaign-ranking-rows tr").map(row => ({
      avatar: row.querySelector('[data-field="avatar"]').value.trim(),
      nickname: row.querySelector('[data-field="nickname"]').value.trim(),
      invite_count: Math.max(0, Math.floor(numberValue(row.querySelector('[data-field="invite_count"]').value, 0))),
      reward_amount: numberValue(row.querySelector('[data-field="reward_amount"]').value, 0)
    })).filter(item => item.avatar || item.nickname || item.invite_count || item.reward_amount);
  }
  if (type === "form-field") {
    return $$("#campaign-form-field-rows tr").map((row, index) => {
      const label = row.querySelector('[data-field="label"]').value.trim();
      const rawName = row.querySelector('[data-field="name"]').value.trim();
      const options = splitList(row.querySelector('[data-field="options"]').value);
      const required = row.querySelector('[data-field="required"]').checked;
      const type = row.querySelector('[data-field="type"]').value;
      if (!label && !rawName && !options.length && !required) return null;
      return {
        label,
        name: rawName || `field_${index + 1}`,
        type,
        options,
        required
      };
    }).filter(Boolean);
  }
  if (type === "poster") {
    return $$("#campaign-poster-rows tr").map(row => ({
      image_url: row.querySelector('[data-field="image_url"]').value.trim(),
      text: row.querySelector('[data-field="text"]').value.trim(),
      layout: posterLayoutFromInput(row.querySelector('[data-field="layout"]'))
    })).filter(item => item.image_url || item.text);
  }
  return [];
}

function lotteryPrizesForPayload() {
  const prizes = readCampaignRows("lottery-prize").filter(prize => prize.probability > 0);
  const total = prizes.reduce((sum, prize) => sum + prize.probability, 0);
  if (total > 1.000001) throw new Error("奖品中奖概率合计不能超过 100%");
  const rest = Math.max(0, 1 - total);
  if (rest > 0.000001) {
    prizes.push({
      name: "谢谢参与",
      type: "thanks",
      image_url: "",
      amount: 0,
      quantity: 0,
      limit_per_user: 0,
      probability: rest
    });
  }
  return prizes.length ? prizes : [{ name: "谢谢参与", type: "thanks", image_url: "", amount: 0, quantity: 0, limit_per_user: 0, probability: 1 }];
}

function layoutStageSize() {
  const stage = $("#poster-layout-stage");
  const image = $("#poster-layout-image");
  return {
    width: image.clientWidth || stage.clientWidth || 1,
    height: image.clientHeight || stage.clientHeight || 1
  };
}

function fitPosterLayoutStage() {
  const wrap = $(".poster-layout-stage-wrap");
  const stage = $("#poster-layout-stage");
  const image = $("#poster-layout-image");
  if (!wrap || !stage || !image || !image.naturalWidth || !image.naturalHeight) return;
  const availableWidth = Math.max(240, wrap.clientWidth - 20);
  const availableHeight = Math.max(260, wrap.clientHeight - 20);
  const aspect = image.naturalWidth / image.naturalHeight;
  const width = Math.min(availableWidth, availableHeight * aspect, image.naturalWidth);
  stage.style.width = `${Math.floor(width)}px`;
}

function compactNicknameBox(layout, stageWidth, text = posterNicknamePreviewText()) {
  const nickname = layout.nickname || defaultPosterLayout().nickname;
  const maxWidth = Math.max(1, nickname.width * stageWidth);
  const fontSize = Math.max(1, nickname.font_size * stageWidth);
  const width = compactNicknameWidth(maxWidth, fontSize, text);
  const left = nickname.x * stageWidth;
  return {
    left: clamp(left, 0, Math.max(0, stageWidth - width)),
    width,
    offset: 0
  };
}

function currentLayoutPart() {
  const selected = adminState.posterLayoutSelected || "qr";
  return adminState.posterLayout?.[selected] || null;
}

function setLayoutSelected(selected) {
  adminState.posterLayoutSelected = selected;
  $("#poster-layout-selected").value = selected;
  $$(".poster-layout-item").forEach(item => item.classList.toggle("active", item.dataset.layoutItem === selected));
  const isNickname = selected === "nickname";
  $("#poster-layout-size-label").textContent = isNickname ? "字号" : "大小";
  $("#poster-layout-width-field").classList.toggle("hidden", !isNickname);
  $("#poster-layout-color-field").classList.toggle("hidden", !isNickname);
  $("#poster-layout-align-field").classList.toggle("hidden", !isNickname);
  syncPosterLayoutControls();
}

function syncPosterLayoutControls() {
  const layout = adminState.posterLayout || defaultPosterLayout();
  const selected = adminState.posterLayoutSelected || "qr";
  if (selected === "nickname") {
    $("#poster-layout-size").min = 2;
    $("#poster-layout-size").max = 8;
    $("#poster-layout-size").value = Math.round((layout.nickname.font_size || 0.032) * 100);
    $("#poster-layout-width").value = Math.round((layout.nickname.width || 0.42) * 100);
    $("#poster-layout-color").value = layout.nickname.color || "#ffffff";
    $("#poster-layout-align").value = layout.nickname.align || "right";
    return;
  }
  $("#poster-layout-size").min = selected === "avatar" ? 4 : 8;
  $("#poster-layout-size").max = selected === "avatar" ? 22 : 50;
  $("#poster-layout-size").value = Math.round((layout[selected]?.size || 0.1) * 100);
}

function renderPosterLayoutStage() {
  const layout = normalizePosterLayout(adminState.posterLayout || defaultPosterLayout());
  adminState.posterLayout = layout;
  fitPosterLayoutStage();
  const { width, height } = layoutStageSize();
  const qr = $("#poster-layout-stage [data-layout-item='qr']");
  const avatar = $("#poster-layout-stage [data-layout-item='avatar']");
  const nickname = $("#poster-layout-stage [data-layout-item='nickname']");
  const qrSize = layout.qr.size * width;
  qr.style.left = `${layout.qr.x * width}px`;
  qr.style.top = `${layout.qr.y * height}px`;
  qr.style.width = `${qrSize}px`;
  qr.style.height = `${qrSize}px`;

  const avatarSize = layout.avatar.size * width;
  avatar.style.left = `${layout.avatar.x * width}px`;
  avatar.style.top = `${layout.avatar.y * height}px`;
  avatar.style.width = `${avatarSize}px`;
  avatar.style.height = `${avatarSize}px`;
  avatar.style.fontSize = `${Math.max(10, avatarSize * 0.22)}px`;

  const nicknameBox = compactNicknameBox(layout, width);
  const nicknameFont = layout.nickname.font_size * width;
  nickname.style.left = `${nicknameBox.left}px`;
  nickname.style.top = `${layout.nickname.y * height}px`;
  nickname.style.width = `${nicknameBox.width}px`;
  nickname.style.maxWidth = `${layout.nickname.width * width}px`;
  nickname.style.fontSize = `${nicknameFont}px`;
  nickname.style.color = layout.nickname.color;
  nickname.style.textAlign = layout.nickname.align;
  nickname.textContent = posterNicknamePreviewText();
  setLayoutSelected(adminState.posterLayoutSelected || "qr");
}

function openPosterLayout(button) {
  const row = button.closest("tr");
  const imageInput = row?.querySelector('[data-field="image_url"]');
  const imageUrl = imageInput?.value.trim();
  if (!imageUrl) {
    toast("请先上传海报主视觉");
    return;
  }
  adminState.posterLayoutRow = row;
  adminState.posterLayout = posterLayoutFromInput(row.querySelector('[data-field="layout"]'));
  adminState.posterLayoutSelected = "qr";
  const modal = $("#poster-layout-modal");
  const image = $("#poster-layout-image");
  image.src = imageUrl;
  image.onload = () => requestAnimationFrame(renderPosterLayoutStage);
  modal.classList.remove("hidden");
  modal.classList.add("open");
  requestAnimationFrame(renderPosterLayoutStage);
}

function closePosterLayout() {
  const modal = $("#poster-layout-modal");
  modal.classList.add("hidden");
  modal.classList.remove("open");
  adminState.posterLayoutRow = null;
  adminState.posterLayoutDrag = null;
}

function resetPosterLayout() {
  adminState.posterLayout = defaultPosterLayout();
  renderPosterLayoutStage();
}

function savePosterLayout() {
  const row = adminState.posterLayoutRow;
  const input = row?.querySelector('[data-field="layout"]');
  if (!input) return;
  input.value = posterLayoutValue(adminState.posterLayout || defaultPosterLayout());
  closePosterLayout();
  toast("海报排版已保存，请保存活动");
}

function updatePosterLayoutFromControls() {
  const selected = adminState.posterLayoutSelected || "qr";
  const layout = normalizePosterLayout(adminState.posterLayout || defaultPosterLayout());
  if (selected === "nickname") {
    layout.nickname.font_size = clamp(numberValue($("#poster-layout-size").value, 3.2) / 100, 0.016, 0.08);
    layout.nickname.width = clamp(numberValue($("#poster-layout-width").value, 42) / 100, 0.08, 0.85);
    layout.nickname.color = $("#poster-layout-color").value || "#ffffff";
    layout.nickname.align = $("#poster-layout-align").value || "right";
  } else {
    layout[selected].size = clamp(numberValue($("#poster-layout-size").value, selected === "avatar" ? 9.5 : 28) / 100, selected === "avatar" ? 0.04 : 0.08, selected === "avatar" ? 0.22 : 0.5);
  }
  adminState.posterLayout = layout;
  renderPosterLayoutStage();
}

function startPosterLayoutDrag(event) {
  const item = event.target.closest(".poster-layout-item");
  if (!item) return;
  const selected = item.dataset.layoutItem;
  setLayoutSelected(selected);
  const layoutPart = currentLayoutPart();
  if (!layoutPart) return;
  adminState.posterLayoutDrag = {
    selected,
    startX: event.clientX,
    startY: event.clientY,
    x: layoutPart.x,
    y: layoutPart.y
  };
  item.setPointerCapture?.(event.pointerId);
  event.preventDefault();
}

function movePosterLayoutDrag(event) {
  const drag = adminState.posterLayoutDrag;
  if (!drag || !adminState.posterLayout) return;
  const { width, height } = layoutStageSize();
  const part = adminState.posterLayout[drag.selected];
  const nicknameBox = drag.selected === "nickname" ? compactNicknameBox(adminState.posterLayout, width) : null;
  const itemWidth = drag.selected === "nickname" ? nicknameBox.width : (part.size || 0.1) * width;
  const itemHeight = drag.selected === "nickname" ? Math.max(24, (part.font_size || 0.032) * width * 1.2) : (part.size || 0.1) * width;
  const nextX = drag.x + (event.clientX - drag.startX) / width;
  const nextY = drag.y + (event.clientY - drag.startY) / height;
  const minX = 0;
  const maxX = drag.selected === "nickname"
    ? (width - itemWidth) / width
    : Math.max(0, 1 - itemWidth / width);
  part.x = clamp(nextX, minX, Math.max(minX, maxX));
  part.y = clamp(nextY, 0, Math.max(0, 1 - itemHeight / height));
  renderPosterLayoutStage();
}

function endPosterLayoutDrag() {
  adminState.posterLayoutDrag = null;
}

function setCampaignStep(step) {
  adminState.campaignStep = campaignSteps.includes(step) ? step : "base";
  $$(".campaign-stepper [data-campaign-step]").forEach(button => {
    button.classList.toggle("active", button.dataset.campaignStep === adminState.campaignStep);
  });
  $$(".campaign-step-panel").forEach(panel => {
    panel.classList.toggle("active", panel.dataset.campaignPanel === adminState.campaignStep);
  });
  const index = campaignSteps.indexOf(adminState.campaignStep);
  $("#campaign-prev-step").disabled = index <= 0;
  $("#campaign-next-step").disabled = index >= campaignSteps.length - 1;
  $("#campaign-next-step").textContent = index >= campaignSteps.length - 2 ? "去完成" : "下一步";
  if (adminState.campaignStep === "done") renderCampaignReview();
}

function renderCampaignReview() {
  let payload;
  try {
    payload = campaignFormPayload();
  } catch (error) {
    $("#campaign-review").innerHTML = `<div class="empty" style="grid-column:1/-1;">${error.message}</div>`;
    return;
  }
  const product = adminState.products.find(item => item.id === payload.product_id);
  const relationText = {
    current: "按会员当前推荐关系",
    first: "按会员首次推荐关系",
    activity_visit: "独立关系链：进入活动锁定",
    activity_paid: "独立关系链：下单付款后锁定"
  }[payload.relation_mode] || payload.relation_mode;
  const rows = [
    ["活动主题", payload.name || "-"],
    ["引流商品", product?.title || `ID ${payload.product_id || "-"}`],
    ["活动状态", payload.status],
    ["时间范围", `${dateLabel(payload.start_at)} - ${dateLabel(payload.end_at)}`],
    ["库存/引流价", `${payload.stock} / ${formatMoney(payload.lead_price)}`],
    ["绑定模式", relationText],
    ["一级/二级奖励", `${formatMoney(payload.reward_level1)} / ${formatMoney(payload.reward_level2)}`],
    ["团队长奖励", payload.team_reward_enabled ? `${formatMoney(payload.team_reward_level1)} / ${formatMoney(payload.team_reward_level2)}` : "未启用"],
    ["抽奖", payload.lottery_enabled ? `启用，${payload.lottery_config.prizes.length} 档奖品` : "未启用"],
    ["引流", payload.team_qrcode_enabled ? "允许团队长上传引流码" : "平台统一引流码"],
    ["虚拟量", `销量 ${payload.virtual_sold_count} / 浏览 ${payload.virtual_browse_count} / 分享 ${payload.virtual_share_count}`],
    ["分享素材", payload.poster_config.length ? `${payload.poster_config.length} 张海报` : "未配置"]
  ];
  $("#campaign-review").innerHTML = rows.map(([label, value]) => `
    <div class="config-item">
      <span>${label}</span>
      <strong>${value}</strong>
    </div>
  `).join("");
}

async function selectCampaign(id, showToast = true) {
  const [campaign, relations, orders, rewards, dashboard] = await Promise.all([
    api(`/api/admin/acquisition/campaigns/${id}`),
    api(`/api/admin/acquisition/campaigns/${id}/relations`),
    api(`/api/admin/acquisition/campaigns/${id}/orders`),
    api(`/api/admin/acquisition/campaigns/${id}/rewards`),
    api(`/api/admin/acquisition/campaigns/${id}/dashboard`)
  ]);
  adminState.selectedCampaign = campaign;
  adminState.campaignRelations = relations;
  adminState.campaignOrders = orders;
  adminState.campaignRewards = rewards;
  adminState.campaignDashboard = dashboard;
  renderCampaigns();
  renderCampaignDetail();
  if (showToast) toast("活动数据已载入");
}

function showCampaignOverview() {
  $("#campaign-overview").classList.remove("hidden");
  $("#campaign-editor").classList.add("hidden");
}

function openCampaignEditor(campaign = null) {
  $("#campaign-overview").classList.add("hidden");
  $("#campaign-editor").classList.remove("hidden");
  $("#campaign-editor-title").textContent = campaign ? "编辑拓客宝活动" : "新建拓客宝活动";
  $("#campaign-id").value = campaign?.id || "";
  $("#campaign-name").value = campaign?.name || "";
  $("#campaign-description").value = campaign?.description || "";
  $("#campaign-product").value = campaign?.product_id || adminState.products[0]?.id || "";
  $("#campaign-status").value = campaign?.status || "draft";
  $("#campaign-start").value = toDateTimeLocal(campaign?.start_at || new Date());
  $("#campaign-end").value = toDateTimeLocal(campaign?.end_at || new Date(Date.now() + 7 * 86400000));
  $("#campaign-stock").value = campaign?.stock ?? 100;
  $("#campaign-lead-price").value = campaign?.lead_price ?? "";
  $("#campaign-user-limit").value = campaign?.per_user_limit ?? 1;
  $("#campaign-order-limit").value = campaign?.per_order_limit ?? 1;
  $("#campaign-relation-mode").value = campaign?.relation_mode || "activity_paid";
  $("#campaign-default-inviter").value = campaign?.default_inviter_id || "";
  $("#campaign-reward-issue-way").value = campaign?.reward_issue_way || "withdraw";
  $("#campaign-direct-pay-way").value = campaign?.direct_pay_way || "wechat_balance";
  $("#campaign-reward-permission").value = campaign?.reward_permission || "all";
  $("#campaign-reward-rule").value = campaign?.reward_rule || "uniform";
  $("#campaign-reward1").value = campaign?.reward_level1 ?? 0;
  $("#campaign-reward2").value = campaign?.reward_level2 ?? 0;
  $("#campaign-multiple-reward").checked = Boolean(campaign?.reward_multiple_enabled);
  $("#campaign-step-reward").checked = Boolean(campaign?.reward_step_enabled);
  $("#campaign-team-reward").checked = Boolean(campaign?.team_reward_enabled);
  $("#campaign-team-reward1").value = campaign?.team_reward_level1 ?? 0;
  $("#campaign-team-reward2").value = campaign?.team_reward_level2 ?? 0;
  const trafficConfig = campaign?.traffic_config || {};
  $("#campaign-multiple-every").value = trafficConfig.reward_multiple_every ?? 0;
  $("#campaign-multiple-amount").value = trafficConfig.reward_multiple_amount ?? 0;
  $("#campaign-step-threshold").value = trafficConfig.reward_step_threshold ?? 0;
  $("#campaign-step-amount").value = trafficConfig.reward_step_amount ?? 0;
  const lotteryConfig = campaign?.lottery_config || {
    issue_way: "immediate",
    cash_direct: true,
    description: "",
    prizes: [
      { name: "谢谢参与", type: "thanks", probability: 0.8 },
      { name: "现金红包", type: "cash", amount: 1, quantity: 100, limit_per_user: 1, probability: 0.2 }
    ]
  };
  $("#campaign-lottery-enabled").checked = Boolean(campaign?.lottery_enabled);
  $("#campaign-lottery-cash").checked = Boolean(lotteryConfig.cash_direct ?? true);
  $("#campaign-lottery-desc").value = lotteryConfig.description || "";
  renderCampaignRows("lottery-prize", lotteryConfig.prizes || []);
  $("#campaign-qrcode-guide").value = campaign?.qrcode_guide_image || "";
  renderImageUrlPreview("#campaign-qrcode-guide", "#campaign-qrcode-guide-preview");
  $("#campaign-team-qrcode-enabled").checked = Boolean(campaign?.team_qrcode_enabled);
  $("#campaign-group-switch-limit").value = trafficConfig.group_switch_limit ?? 180;
  $("#campaign-expire-notify-users").value = (trafficConfig.expire_notify_users || []).join("，");
  const qrcodeTypes = campaign?.team_qrcode_types || ["personal", "group"];
  $("#campaign-qrcode-type-personal").checked = qrcodeTypes.includes("personal");
  $("#campaign-qrcode-type-group").checked = qrcodeTypes.includes("group");
  $("#campaign-virtual-sold").value = campaign?.virtual_sold_count ?? 0;
  $("#campaign-virtual-browse").value = campaign?.virtual_browse_count ?? 0;
  $("#campaign-virtual-share").value = campaign?.virtual_share_count ?? 0;
  $("#campaign-virtual-invite").value = campaign?.virtual_invite_count ?? 0;
  renderCampaignRows("ranking", campaign?.virtual_rankings || []);
  $("#campaign-background-music").value = campaign?.background_music || "";
  $("#campaign-service-qrcode").value = campaign?.customer_service_qrcode || "";
  renderImageUrlPreview("#campaign-service-qrcode", "#campaign-service-qrcode-preview");
  renderCampaignRows("form-field", campaign?.form_schema || []);
  $("#campaign-share-cover").value = campaign?.share_cover || campaign?.product?.images?.[0] || "";
  renderImageUrlPreview("#campaign-share-cover", "#campaign-share-cover-preview");
  $("#campaign-share-description").value = campaign?.share_description || "";
  $("#campaign-share-timeline").value = campaign?.share_timeline_text || "";
  renderCampaignRows("poster", campaign?.poster_config || []);
  setCampaignStep("base");
}

function campaignFormPayload() {
  return {
    name: $("#campaign-name").value.trim(),
    description: $("#campaign-description").value.trim(),
    product_id: Number($("#campaign-product").value),
    status: $("#campaign-status").value,
    start_at: fromDateTimeLocal($("#campaign-start").value),
    end_at: fromDateTimeLocal($("#campaign-end").value),
    stock: Number($("#campaign-stock").value || 0),
    lead_price: Number($("#campaign-lead-price").value || 0),
    per_user_limit: Number($("#campaign-user-limit").value || 0),
    per_order_limit: Number($("#campaign-order-limit").value || 0),
    relation_mode: $("#campaign-relation-mode").value,
    default_inviter_id: Number($("#campaign-default-inviter").value || 0) || null,
    reward_issue_way: $("#campaign-reward-issue-way").value,
    direct_pay_way: $("#campaign-direct-pay-way").value,
    reward_permission: $("#campaign-reward-permission").value,
    reward_rule: $("#campaign-reward-rule").value,
    reward_level1: Number($("#campaign-reward1").value || 0),
    reward_level2: Number($("#campaign-reward2").value || 0),
    reward_multiple_enabled: $("#campaign-multiple-reward").checked,
    reward_step_enabled: $("#campaign-step-reward").checked,
    team_reward_enabled: $("#campaign-team-reward").checked,
    team_reward_level1: Number($("#campaign-team-reward1").value || 0),
    team_reward_level2: Number($("#campaign-team-reward2").value || 0),
    lottery_enabled: $("#campaign-lottery-enabled").checked,
    lottery_config: {
      issue_way: "immediate",
      cash_direct: $("#campaign-lottery-cash").checked,
      description: $("#campaign-lottery-desc").value.trim(),
      prizes: lotteryPrizesForPayload()
    },
    qrcode_guide_image: $("#campaign-qrcode-guide").value.trim(),
    team_qrcode_enabled: $("#campaign-team-qrcode-enabled").checked,
    traffic_config: {
      expire_notify_users: splitList($("#campaign-expire-notify-users").value).map(item => Number(item)).filter(Boolean),
      group_switch_limit: Math.max(0, Math.floor(Number($("#campaign-group-switch-limit").value || 0))),
      reward_multiple_every: Math.max(0, Math.floor(Number($("#campaign-multiple-every").value || 0))),
      reward_multiple_amount: Number($("#campaign-multiple-amount").value || 0),
      reward_step_threshold: Math.max(0, Math.floor(Number($("#campaign-step-threshold").value || 0))),
      reward_step_amount: Number($("#campaign-step-amount").value || 0)
    },
    virtual_sold_count: Number($("#campaign-virtual-sold").value || 0),
    virtual_browse_count: Number($("#campaign-virtual-browse").value || 0),
    virtual_share_count: Number($("#campaign-virtual-share").value || 0),
    virtual_invite_count: Number($("#campaign-virtual-invite").value || 0),
    virtual_rankings: readCampaignRows("ranking"),
    background_music: $("#campaign-background-music").value.trim(),
    customer_service_qrcode: $("#campaign-service-qrcode").value.trim(),
    delivery_methods: ["express"],
    form_schema: readCampaignRows("form-field"),
    share_cover: $("#campaign-share-cover").value.trim(),
    share_description: $("#campaign-share-description").value.trim(),
    share_timeline_text: $("#campaign-share-timeline").value.trim(),
    team_qrcode_types: [
      $("#campaign-qrcode-type-personal").checked ? "personal" : "",
      $("#campaign-qrcode-type-group").checked ? "group" : ""
    ].filter(Boolean),
    poster_config: readCampaignRows("poster")
  };
}

async function saveProduct() {
  const id = Number($("#product-id").value);
  const payload = productFormPayload();
  await api(id ? `/api/admin/products/${id}` : "/api/admin/products", {
    method: id ? "PUT" : "POST",
    body: JSON.stringify(payload)
  });
  toast("商品已保存");
  await loadProducts();
  showProductOverview();
}

async function saveCampaign() {
  const id = Number($("#campaign-id").value);
  const payload = campaignFormPayload();
  const campaign = await api(id ? `/api/admin/acquisition/campaigns/${id}` : "/api/admin/acquisition/campaigns", {
    method: id ? "PUT" : "POST",
    body: JSON.stringify(payload)
  });
  toast("拓客宝活动已保存");
  const campaigns = await api("/api/admin/acquisition/campaigns");
  adminState.campaigns = campaigns;
  await selectCampaign(campaign.id, false);
  showCampaignOverview();
}

async function patchCampaign(id, action) {
  const campaign = await api(`/api/admin/acquisition/campaigns/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ action })
  });
  adminState.campaigns = await api("/api/admin/acquisition/campaigns");
  await selectCampaign(campaign.id, false);
  toast(action === "end" ? "活动已结束" : "活动已发布");
}

async function deleteCampaign(id) {
  const campaign = adminState.campaigns.find(item => item.id === id);
  if (!campaign) return;
  if (!confirm(`确定删除拓客宝活动「${campaign.name}」？已经产生订单或关系链的活动不能删除。`)) return;
  adminState.campaigns = await api(`/api/admin/acquisition/campaigns/${id}`, {
    method: "DELETE"
  });
  adminState.selectedCampaign = null;
  adminState.campaignDashboard = null;
  renderCampaigns();
  renderCampaignDetail();
  toast("拓客宝活动已删除");
}

async function addQrcode(campaignId) {
  const name = prompt("引流码名称", "个人微信码");
  if (!name) return;
  const image_url = await uploadOrPromptUrl("粘贴二维码图片链接", "image");
  if (!image_url) return;
  await api(`/api/admin/acquisition/campaigns/${campaignId}/qrcodes`, {
    method: "POST",
    body: JSON.stringify({
      type: name.includes("群") ? "group" : "personal",
      name,
      image_url,
      show_limit: name.includes("群") ? 180 : 0,
      status: "enabled"
    })
  });
  await selectCampaign(campaignId, false);
  toast("引流码已保存");
}

async function deleteQrcode(campaignId, qrcodeId) {
  if (!confirm("确定删除这个引流码？")) return;
  await api(`/api/admin/acquisition/campaigns/${campaignId}/qrcodes/${qrcodeId}`, {
    method: "DELETE"
  });
  await selectCampaign(campaignId, false);
  toast("引流码已删除");
}

async function addMaterial() {
  const type = prompt("素材类型：qrcode_bg / share_poster / share_cover", "share_cover") || "share_cover";
  const image_url = await uploadOrPromptUrl("粘贴素材图片链接", "image");
  if (!image_url) return;
  adminState.materials = await api("/api/admin/acquisition/materials", {
    method: "POST",
    body: JSON.stringify({ type, image_url, sort_order: 0 })
  });
  renderMaterials();
  toast("素材已保存");
}

async function deleteMaterial(id) {
  if (!confirm("确定删除这个素材模板？")) return;
  adminState.materials = await api(`/api/admin/acquisition/materials/${id}`, {
    method: "DELETE"
  });
  renderMaterials();
  toast("素材已删除");
}

async function toggleProduct(id) {
  const product = adminState.products.find(item => item.id === id);
  if (!product) return;
  await api(`/api/admin/products/${id}`, {
    method: "PUT",
    body: JSON.stringify({ status: product.status === "on" ? "off" : "on" })
  });
  toast(product.status === "on" ? "商品已下架" : "商品已上架");
  await loadProducts();
}

async function deleteProduct(id) {
  const product = adminState.products.find(item => item.id === id);
  if (!product) return;
  if (!confirm(`确定删除商品「${product.title}」？已经被拓客宝或订单引用的商品不能删除。`)) return;
  adminState.products = await api(`/api/admin/products/${id}`, {
    method: "DELETE"
  });
  renderProducts();
  toast("商品已删除");
}

async function patchOrder(id, action) {
  const body = { action };
  if (action === "ship") {
    body.logistics_no = prompt("请输入物流单号", `SF${Date.now()}`) || "";
    if (!body.logistics_no) return;
  }
  await api(`/api/admin/orders/${id}`, {
    method: "PATCH",
    body: JSON.stringify(body)
  });
  toast("订单已更新");
  await loadOrders();
}

async function patchDistributor(id, status) {
  await api(`/api/admin/distributors/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ status })
  });
  toast("分销员状态已更新");
  await loadDistributors();
}

async function patchWithdrawal(id, action) {
  const review_note = action === "reject" ? "审核未通过" : action === "pay" ? "已模拟企业付款到零钱" : "审核通过";
  await api(`/api/admin/withdrawals/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ action, review_note })
  });
  toast("提现申请已处理");
  await loadWithdrawals();
}

async function saveSettings() {
  await api("/api/admin/settings", {
    method: "PUT",
    body: JSON.stringify({
      commission_level_1: Number($("#setting-level1").value),
      commission_level_2: Number($("#setting-level2").value),
      min_withdrawal: Number($("#setting-min-withdrawal").value),
      compliance_name: $("#setting-compliance-name").value,
      auto_pay_enabled: $("#setting-auto-pay").checked
    })
  });
  toast("设置已保存");
  await loadSettings();
}

function bindEvents() {
  $$(".admin-nav button").forEach(button => {
    button.addEventListener("click", () => setAdminTab(button.dataset.adminTab));
  });
  $("#admin-refresh").addEventListener("click", () => loadCurrent().then(() => toast("已刷新")));
  $("#new-product").addEventListener("click", () => openProductEditor());
  $("#new-campaign").addEventListener("click", () => openCampaignEditor());
  $("#refresh-campaigns").addEventListener("click", () => loadAcquisition().then(() => toast("拓客宝已刷新")));
  $("#new-material").addEventListener("click", () => addMaterial().catch(error => toast(error.message)));
  $("#back-product-list").addEventListener("click", showProductOverview);
  $$("[data-product-section]").forEach(button => {
    button.addEventListener("click", () => setProductSection(button.dataset.productSection));
  });
  $("#product-images").addEventListener("input", renderProductImagePreview);
  $("#product-rich-editor").addEventListener("input", productDetailHtml);
  $$("[data-rich-command]").forEach(button => {
    button.addEventListener("click", () => runRichCommand(button.dataset.richCommand, button.dataset.richValue || null));
  });
  $$("[data-rich-action]").forEach(button => {
    button.addEventListener("click", () => {
      (async () => {
        if (button.dataset.richAction === "link") {
          const url = prompt("链接地址", "https://");
          if (url) runRichCommand("createLink", url);
        }
        if (button.dataset.richAction === "image") {
          await insertRichImage();
        }
        if (button.dataset.richAction === "source") toggleRichSource();
        if (button.dataset.richAction === "preview") showRichPreview();
      })().catch(error => toast(error.message));
    });
  });
  $("#upload-product-image").addEventListener("click", () => uploadProductImage().catch(error => toast(error.message)));
  $("#clear-product-images").addEventListener("click", () => {
    if (!productImages().length) return;
    if (!confirm("确定清空所有商品图片？")) return;
    setProductImages([]);
  });
  $("#back-campaign-list").addEventListener("click", showCampaignOverview);
  $("#save-product").addEventListener("click", () => saveProduct().catch(error => toast(error.message)));
  $("#save-campaign").addEventListener("click", () => saveCampaign().catch(error => toast(error.message)));
  $$(".campaign-stepper [data-campaign-step]").forEach(button => {
    button.addEventListener("click", () => setCampaignStep(button.dataset.campaignStep));
  });
  $$("[data-add-campaign-row]").forEach(button => {
    button.addEventListener("click", () => addCampaignRow(button.dataset.addCampaignRow));
  });
  $$("[data-upload-target]").forEach(button => {
    button.addEventListener("click", () => chooseAndUploadFile(button));
    const target = $(button.dataset.uploadTarget);
    if (target && button.dataset.previewTarget) {
      target.addEventListener("input", () => renderImageUrlPreview(button.dataset.uploadTarget, button.dataset.previewTarget));
    }
  });
  $("#campaign-prev-step").addEventListener("click", () => {
    const index = campaignSteps.indexOf(adminState.campaignStep);
    setCampaignStep(campaignSteps[Math.max(0, index - 1)]);
  });
  $("#campaign-next-step").addEventListener("click", () => {
    const index = campaignSteps.indexOf(adminState.campaignStep);
    setCampaignStep(campaignSteps[Math.min(campaignSteps.length - 1, index + 1)]);
  });
  $("#close-poster-layout").addEventListener("click", closePosterLayout);
  $("#reset-poster-layout").addEventListener("click", resetPosterLayout);
  $("#save-poster-layout").addEventListener("click", savePosterLayout);
  $("#poster-layout-selected").addEventListener("change", event => setLayoutSelected(event.target.value));
  ["#poster-layout-size", "#poster-layout-width", "#poster-layout-color", "#poster-layout-align"].forEach(selector => {
    $(selector).addEventListener("input", updatePosterLayoutFromControls);
  });
  $("#poster-layout-stage").addEventListener("pointerdown", startPosterLayoutDrag);
  document.addEventListener("pointermove", movePosterLayoutDrag);
  document.addEventListener("pointerup", endPosterLayoutDrag);
  window.addEventListener("resize", () => {
    if (!$("#poster-layout-modal").classList.contains("hidden")) renderPosterLayoutStage();
  });
  $("#save-settings").addEventListener("click", () => saveSettings().catch(error => toast(error.message)));
  $("#admin-login-form").addEventListener("submit", event => {
    event.preventDefault();
    adminLogin().catch(error => toast(error.message));
  });
  $("#admin-logout").addEventListener("click", adminLogout);

  document.addEventListener("click", event => {
    const edit = event.target.closest("[data-edit-product]");
    if (edit) {
      const product = adminState.products.find(item => item.id === Number(edit.dataset.editProduct));
      openProductEditor(product);
    }
    const toggle = event.target.closest("[data-toggle-product]");
    if (toggle) {
      toggleProduct(Number(toggle.dataset.toggleProduct)).catch(error => toast(error.message));
    }
    const deleteProductButton = event.target.closest("[data-delete-product]");
    if (deleteProductButton) {
      deleteProduct(Number(deleteProductButton.dataset.deleteProduct)).catch(error => toast(error.message));
    }
    const selectCampaignButton = event.target.closest("[data-select-campaign]");
    if (selectCampaignButton) {
      selectCampaign(Number(selectCampaignButton.dataset.selectCampaign)).catch(error => toast(error.message));
    }
    const editCampaign = event.target.closest("[data-edit-campaign]");
    if (editCampaign) {
      const campaign = adminState.campaigns.find(item => item.id === Number(editCampaign.dataset.editCampaign));
      openCampaignEditor(campaign);
    }
    const campaignAction = event.target.closest("[data-campaign-action]");
    if (campaignAction) {
      patchCampaign(Number(campaignAction.dataset.campaignAction), campaignAction.dataset.action).catch(error => toast(error.message));
    }
    const deleteCampaignButton = event.target.closest("[data-delete-campaign]");
    if (deleteCampaignButton) {
      deleteCampaign(Number(deleteCampaignButton.dataset.deleteCampaign)).catch(error => toast(error.message));
    }
    const posterLayout = event.target.closest("[data-poster-layout]");
    if (posterLayout) {
      event.preventDefault();
      openPosterLayout(posterLayout);
      return;
    }
    const removeCampaignRow = event.target.closest("[data-remove-campaign-row]");
    if (removeCampaignRow) {
      removeCampaignRow.closest("tr")?.remove();
      return;
    }
    const removeProductImage = event.target.closest("[data-remove-product-image]");
    if (removeProductImage) {
      const index = Number(removeProductImage.dataset.removeProductImage);
      setProductImages(productImages().filter((_, itemIndex) => itemIndex !== index));
    }
    const uploadField = event.target.closest("[data-upload-field]");
    if (uploadField) {
      chooseAndUploadFile(uploadField);
    }
    const qrcode = event.target.closest("[data-add-qrcode]");
    if (qrcode) {
      addQrcode(Number(qrcode.dataset.addQrcode)).catch(error => toast(error.message));
    }
    const deleteQrcodeButton = event.target.closest("[data-delete-qrcode]");
    if (deleteQrcodeButton) {
      deleteQrcode(Number(deleteQrcodeButton.dataset.campaignId), Number(deleteQrcodeButton.dataset.deleteQrcode)).catch(error => toast(error.message));
    }
    const deleteMaterialButton = event.target.closest("[data-delete-material]");
    if (deleteMaterialButton) {
      deleteMaterial(Number(deleteMaterialButton.dataset.deleteMaterial)).catch(error => toast(error.message));
    }
    const ship = event.target.closest("[data-ship]");
    if (ship) {
      patchOrder(Number(ship.dataset.ship), "ship").catch(error => toast(error.message));
    }
    const receive = event.target.closest("[data-receive]");
    if (receive) {
      patchOrder(Number(receive.dataset.receive), "receive").catch(error => toast(error.message));
    }
    const refund = event.target.closest("[data-refund]");
    if (refund) {
      patchOrder(Number(refund.dataset.refund), "refund").catch(error => toast(error.message));
    }
    const distributor = event.target.closest("[data-distributor]");
    if (distributor) {
      patchDistributor(Number(distributor.dataset.distributor), distributor.dataset.status).catch(error => toast(error.message));
    }
    const withdrawal = event.target.closest("[data-withdrawal]");
    if (withdrawal) {
      patchWithdrawal(Number(withdrawal.dataset.withdrawal), withdrawal.dataset.action).catch(error => toast(error.message));
    }
  });
  document.addEventListener("input", event => {
    const uploadInput = event.target.closest(".table-upload-cell input");
    if (uploadInput) {
      renderImagePreview(uploadInput, uploadInput.closest(".table-upload-cell")?.querySelector(".image-url-preview"));
    }
  });
}

async function init() {
  hydrateIcons();
  bindEvents();
  if (!adminState.token) {
    showAdminLogin();
    return;
  }
  hideAdminLogin();
  await loadDashboard();
}

init().catch(error => toast(error.message));
