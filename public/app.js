const state = {
  user: null,
  products: [],
  campaigns: [],
  categories: [],
  category: "全部",
  keyword: "",
  orders: [],
  summary: null,
  addresses: [],
  editingAddressId: 0,
  selectedProduct: null,
  selectedCampaign: null,
  tab: "home"
};

const $ = selector => document.querySelector(selector);
const $$ = selector => Array.from(document.querySelectorAll(selector));

function icon(name) {
  return (window.Icon && window.Icon[name]) || "";
}

function hydrateIcons() {
  $$(".slot-icon").forEach(slot => {
    slot.innerHTML = icon(slot.dataset.icon);
  });
  $("#hero-shop").innerHTML = `${icon("shop")} 去选商品`;
  $("#hero-share").innerHTML = `${icon("share")} 生成海报`;
  $("#open-login").innerHTML = icon("user");
  $("#refresh-products").innerHTML = icon("refresh");
  $("#search-products").innerHTML = icon("search");
  $("#refresh-orders").innerHTML = icon("refresh");
  $("#refresh-distribution").innerHTML = icon("refresh");
  $("#apply-distributor").innerHTML = `${icon("users")} 申请成为推荐员`;
  $("#open-withdrawal").innerHTML = `${icon("wallet")} 提现申请`;
  $("#close-drawer").innerHTML = icon("close");
  $("#buy-now").innerHTML = `${icon("order")} 微信支付下单`;
  $("#make-poster").innerHTML = `${icon("share")} 推荐海报`;
  $("#close-poster").innerHTML = icon("close");
  $("#close-campaign").innerHTML = icon("close");
  $("#campaign-buy-now").innerHTML = `${icon("order")} 活动下单`;
  $("#close-withdrawal").innerHTML = icon("close");
}

function formatMoney(value) {
  return `¥${Number(value || 0).toFixed(2)}`;
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

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function trustedRichHtml(value) {
  return String(value || "")
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, "")
    .replace(/\son\w+="[^"]*"/gi, "")
    .replace(/\son\w+='[^']*'/gi, "")
    .replace(/\sjavascript:/gi, "");
}

function shortPrizeName(name) {
  const text = String(name || "奖品");
  return text.length > 5 ? `${text.slice(0, 5)}…` : text;
}

function campaignPrizes(campaign) {
  const prizes = campaign?.lottery_config?.prizes || [];
  const normalized = prizes.length ? prizes : [{ name: "谢谢参与", type: "thanks", probability: 1 }];
  const segment = 360 / normalized.length;
  return normalized.map((prize, index) => ({
    ...prize,
    angle: Math.round(index * segment),
    shortName: shortPrizeName(prize.name)
  }));
}

function campaignTrafficQrcode(campaign) {
  const qrcodes = campaign?.active_qrcodes?.length
    ? campaign.active_qrcodes
    : (campaign?.qrcodes || []).filter(item => item.status === "enabled");
  if (qrcodes.length) {
    return {
      name: qrcodes[0].name,
      image_url: qrcodes[0].image_url,
      note: qrcodes[0].type_text || "领奖二维码"
    };
  }
  if (campaign?.qrcode_guide_image) {
    return { name: "领奖入口", image_url: campaign.qrcode_guide_image, note: "请长按识别二维码" };
  }
  if (campaign?.customer_service_qrcode) {
    return { name: "客服二维码", image_url: campaign.customer_service_qrcode, note: "请长按识别二维码" };
  }
  return null;
}

function defaultAddress() {
  return state.addresses.find(item => item.is_default) || state.addresses[0] || null;
}

function campaignScene(campaignId) {
  return sessionStorage.getItem(`mallCampaignScene:${Number(campaignId || 0)}`) || "";
}

function assetUrl(path) {
  if (!path) return "";
  if (/^https?:\/\//.test(path)) return path;
  return path;
}

async function ensureAddresses() {
  if (!state.user) await ensureUser();
  state.addresses = await api(`/api/user/addresses?user_id=${state.user.id}`);
  return state.addresses;
}

async function ensureDefaultAddress() {
  if (!state.addresses.length) await ensureAddresses();
  const address = defaultAddress();
  if (!address) {
    setTab("distribution");
    openAddressForm();
    throw new Error("请先在分销页维护收货地址");
  }
  return address;
}

function toast(message) {
  const node = $("#toast");
  node.textContent = message;
  node.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => node.classList.remove("show"), 2200);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || "请求失败");
  }
  return payload.data;
}

function saveUser(user) {
  state.user = user;
  localStorage.setItem("distributionMallUserId", String(user.id));
}

async function ensureUser() {
  const id = Number(localStorage.getItem("distributionMallUserId") || 0);
  if (!id) {
    $("#login-modal").classList.add("open");
    throw new Error("请先登录会员账户");
  }
  try {
    const user = await api(`/api/me?user_id=${id}`);
    saveUser(user);
  } catch {
    localStorage.removeItem("distributionMallUserId");
    $("#login-modal").classList.add("open");
    throw new Error("登录已失效，请重新登录");
  }
}

function setTab(tab) {
  state.tab = tab;
  $$(".mini-view").forEach(view => view.classList.toggle("active", view.id === `view-${tab}`));
  $$(".mini-tabs button").forEach(button => button.classList.toggle("active", button.dataset.tab === tab));
  if (tab === "orders") loadOrders();
  if (tab === "distribution") loadDistribution();
  if (tab === "store") loadProducts();
}

async function loadProducts() {
  const params = new URLSearchParams({
    category: state.category,
    keyword: state.keyword
  });
  const [data, campaigns] = await Promise.all([
    api(`/api/products?${params}`),
    api(`/api/acquisition/campaigns?keyword=${encodeURIComponent(state.keyword)}`)
  ]);
  state.products = data.products;
  state.campaigns = campaigns;
  state.categories = data.categories;
  renderCategories();
  renderProducts();
  renderCampaigns();
  renderHomeProducts();
  renderHomeCampaigns();
}

async function loadOrders() {
  state.orders = await api(`/api/orders?user_id=${state.user.id}`);
  renderOrders();
}

async function loadDistribution() {
  const [summary, addresses] = await Promise.all([
    api(`/api/distribution/summary?user_id=${state.user.id}`),
    api(`/api/user/addresses?user_id=${state.user.id}`)
  ]);
  state.summary = summary;
  state.addresses = addresses;
  renderUser();
  renderHomeSummary();
  renderDistribution();
}

function renderUser() {
  if (!state.user) return;
  $("#home-avatar").textContent = state.user.avatar || state.user.nickname.slice(0, 2);
  $("#home-name").textContent = state.user.nickname;
  const parent = state.user.parent_id ? `推荐人 ID ${state.user.parent_id}` : "未绑定推荐人";
  const statusMap = { approved: "已成为推荐员", pending: "推荐员待审核", rejected: "推荐员未通过" };
  $("#home-relation").textContent = `${parent} · ${statusMap[state.user.distributor_status] || "普通用户"}`;
}

function renderHomeSummary() {
  const data = state.summary;
  if (!data) return;
  $("#home-summary").innerHTML = [
    ["今日佣金", formatMoney(data.today)],
    ["累计佣金", formatMoney(data.total)],
    ["可提现", formatMoney(data.withdrawable)],
    ["直接客户", data.direct_count]
  ].map(([label, value]) => `
    <div class="summary-tile">
      <span>${label}</span>
      <strong>${value}</strong>
    </div>
  `).join("");
}

function renderCategories() {
  $("#category-row").innerHTML = state.categories.map(category => `
    <button class="${category === state.category ? "active" : ""}" data-category="${category}">${category}</button>
  `).join("");
}

function productCard(product) {
  return `
    <article class="product-card">
      <img src="${product.images[0]}" alt="${product.title}" />
      <div class="body">
        <h3>${product.title}</h3>
        <div class="price-row">
          <span class="price">${formatMoney(product.price)}</span>
          <span class="pill">${product.commission_label}</span>
        </div>
        <button class="btn" data-product="${product.id}">${icon("shop")} 查看详情</button>
      </div>
    </article>
  `;
}

function campaignCard(campaign) {
  const image = campaign.share_cover || campaign.product?.images?.[0] || "";
  const sold = Number(campaign.sold_count || 0) + Number(campaign.virtual_sold_count || 0);
  const leftStock = Math.max(0, Number(campaign.stock || 0) - Number(campaign.sold_count || 0));
  return `
    <article class="product-card">
      <img src="${image}" alt="${campaign.name}" />
      <div class="body">
        <h3>${campaign.name}</h3>
        <div class="price-row">
          <span class="price">${formatMoney(campaign.lead_price)}</span>
          <span class="pill blue">${campaign.relation_mode_text}</span>
        </div>
        <p style="margin:8px 0 0; color:var(--muted); font-size:12px;">已售 ${sold} · 剩余 ${leftStock}</p>
        <p style="margin:4px 0 0; color:var(--muted); font-size:12px;">${campaign.description || campaign.product?.title || ""}</p>
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px;">
          <button class="btn ghost" data-view-campaign="${campaign.id}">${icon("search")} 查看</button>
          <button class="btn" data-campaign="${campaign.id}" data-campaign-product="${campaign.product_id}">${icon("order")} 下单</button>
        </div>
      </div>
    </article>
  `;
}

function renderProducts() {
  $("#product-grid").innerHTML = state.products.length
    ? state.products.map(productCard).join("")
    : '<div class="empty" style="grid-column:1/-1;">没有找到匹配商品</div>';
}

function renderHomeProducts() {
  $("#home-products").innerHTML = state.products.slice(0, 4).map(productCard).join("");
}

function renderCampaigns() {
  $("#campaign-grid").innerHTML = state.campaigns.length
    ? state.campaigns.map(campaignCard).join("")
    : '<div class="empty" style="grid-column:1/-1;">暂无已发布拓客宝活动</div>';
}

function renderHomeCampaigns() {
  $("#home-campaigns").innerHTML = state.campaigns.length
    ? state.campaigns.slice(0, 2).map(campaignCard).join("")
    : '<div class="empty" style="grid-column:1/-1;">暂无已发布拓客宝活动</div>';
}

function renderOrders() {
  $("#order-list").innerHTML = state.orders.length ? state.orders.map(order => `
    <article class="list-item">
      <div class="list-item-head">
        <h3>${order.product?.title || "商品已删除"}</h3>
        <span class="pill ${order.status === "refunded" ? "danger" : order.status === "received" ? "" : "blue"}">${order.status_text}</span>
      </div>
      <p>订单 #${order.id} · ${dateLabel(order.created_at)} · ${order.quantity} 件 · ${formatMoney(order.amount)}</p>
      <p>物流单号：${order.logistics_no || "待发货"}</p>
      <div style="display:flex; gap:8px; flex-wrap:wrap;">
        <button class="btn ghost" data-share-order="${order.product_id}">${icon("share")} 生成海报</button>
        <button class="btn" data-confirm="${order.id}" ${["paid", "shipped"].includes(order.status) ? "" : "disabled"}>${icon("check")} 确认收货</button>
      </div>
    </article>
  `).join("") : '<div class="empty">还没有订单，可以先去首页活动下单。</div>';
}

function renderDistribution() {
  const data = state.summary;
  if (!data) return;
  $("#distribution-summary").innerHTML = [
    ["可提现", formatMoney(data.withdrawable)],
    ["待结算", formatMoney(data.pending)],
    ["直接客户", data.direct_count],
    ["间接客户", data.indirect_count]
  ].map(([label, value]) => `
    <div class="summary-tile">
      <span>${label}</span>
      <strong>${value}</strong>
    </div>
  `).join("");

  $("#withdrawal-amount").value = data.withdrawable || "";
  renderAddressPanel();
  $("#customer-list").innerHTML = data.customers.length ? data.customers.map(customer => `
    <article class="list-item">
      <div class="list-item-head">
        <h3>${customer.nickname}</h3>
        <span class="pill blue">下级 ${customer.children_count}</span>
      </div>
      <p>ID ${customer.id} · ${customer.phone || "未绑定手机号"} · ${dateLabel(customer.created_at)}</p>
    </article>
  `).join("") : '<div class="empty">暂无下级客户。生成海报后用 scene 绑定即可建立推荐关系。</div>';

  $("#commission-list").innerHTML = data.commissions.length ? data.commissions.map(item => `
    <article class="list-item">
      <div class="list-item-head">
        <h3>${item.product?.title || "商品"} · ${item.level_text || `${item.level} 级`}</h3>
        <span class="pill ${item.status === "canceled" ? "danger" : item.status === "pending" ? "warn" : ""}">${item.status_text}</span>
      </div>
      <p>来自 ${item.buyer?.nickname || "买家"} 的订单 #${item.order_id} · ${dateLabel(item.created_at)}</p>
      <strong>${formatMoney(item.amount)}</strong>
    </article>
  `).join("") : '<div class="empty">暂无佣金明细。</div>';

  $("#withdrawal-list").innerHTML = data.withdrawals.length ? data.withdrawals.map(item => `
    <article class="list-item">
      <div class="list-item-head">
        <h3>${formatMoney(item.amount)}</h3>
        <span class="pill ${item.status === "rejected" ? "danger" : item.status === "pending" ? "warn" : ""}">${item.status}</span>
      </div>
      <p>${dateLabel(item.created_at)} · ${item.note || "无备注"}</p>
      <p>${item.review_note || "等待后台审核"}</p>
    </article>
  `).join("") : '<div class="empty">暂无提现记录。</div>';
}

function renderAddressPanel() {
  const address = defaultAddress();
  const panel = $("#address-panel");
  if (!panel) return;
  if (address) {
    panel.innerHTML = `
      <article class="address-card">
        <div>
          <strong>${escapeHtml(address.receiver_name)} ${escapeHtml(address.phone)}</strong>
          <p>${escapeHtml(address.full_address)}</p>
        </div>
        ${address.is_default ? '<span class="pill warn">默认</span>' : ""}
      </article>
    `;
  } else {
    panel.innerHTML = '<div class="empty compact">还没有收货地址。</div>';
  }
  renderBuyAddressCard();
}

function renderBuyAddressCard() {
  const card = $("#buy-address-card");
  if (!card) return;
  const address = defaultAddress();
  card.innerHTML = address ? `
    <span>收货地址</span>
    <article class="address-card compact">
      <div>
        <strong>${escapeHtml(address.receiver_name)} ${escapeHtml(address.phone)}</strong>
        <p>${escapeHtml(address.full_address)}</p>
      </div>
      <button class="btn secondary" type="button" id="drawer-edit-address">管理</button>
    </article>
  ` : `
    <span>收货地址</span>
    <article class="address-card compact">
      <p>还没有收货地址。</p>
      <button class="btn" type="button" id="drawer-edit-address">去编辑</button>
    </article>
  `;
  $("#drawer-edit-address")?.addEventListener("click", () => {
    $("#product-drawer").classList.remove("open");
    setTab("distribution");
    openAddressForm();
  });
}

function openAddressForm() {
  const address = defaultAddress();
  state.editingAddressId = address?.id || 0;
  $("#address-receiver").value = address?.receiver_name || "";
  $("#address-phone").value = address?.phone || "";
  $("#address-province").value = address?.province || "";
  $("#address-city").value = address?.city || "";
  $("#address-district").value = address?.district || "";
  $("#address-detail").value = address?.detail || "";
  $("#address-default").checked = address?.is_default ?? true;
  $("#address-form").classList.remove("hidden");
}

function closeAddressForm() {
  $("#address-form").classList.add("hidden");
}

async function openProduct(id) {
  const product = await api(`/api/products/${id}`);
  state.selectedProduct = product;
  await ensureAddresses();
  $("#drawer-image").innerHTML = `<img src="${product.images[0]}" alt="${product.title}" />`;
  $("#drawer-title").textContent = product.title;
  $("#drawer-desc").textContent = product.description;
  $("#drawer-price").textContent = formatMoney(product.price);
  $("#drawer-stock").textContent = `${product.stock}`;
  $("#drawer-rich-detail").innerHTML = trustedRichHtml(product.detail_html || "");
  $("#drawer-rich-detail").classList.toggle("hidden", !product.detail_html);
  $("#buy-quantity").value = 1;
  renderBuyAddressCard();
  $("#product-drawer").classList.add("open");
}

async function buySelectedProduct() {
  if (!state.selectedProduct) return;
  const quantity = Number($("#buy-quantity").value || 1);
  const address = await ensureDefaultAddress();
  const result = await api("/api/orders", {
    method: "POST",
    body: JSON.stringify({
      user_id: state.user.id,
      product_id: state.selectedProduct.id,
      quantity,
      address_id: address.id
    })
  });
  toast(`${result.payment.message}，订单 #${result.order.id}`);
  $("#product-drawer").classList.remove("open");
  await Promise.all([loadProducts(), loadOrders(), loadDistribution()]);
  setTab("orders");
}

async function buyCampaign(campaignId, productId) {
  await ensureAddresses();
  const campaign = state.selectedCampaign?.id === campaignId
    ? state.selectedCampaign
    : await api(`/api/acquisition/campaigns/${campaignId}?user_id=${state.user.id}&scene=${encodeURIComponent(campaignScene(campaignId))}`);
  state.selectedCampaign = campaign;
  renderCampaignFlow("checkout", { campaign, productId });
}

async function submitCampaignPayment(campaign, productId) {
  const address = await ensureDefaultAddress();
  renderCampaignFlow("paying", { campaign, productId });
  const result = await api("/api/orders", {
    method: "POST",
    body: JSON.stringify({
      user_id: state.user.id,
      campaign_id: campaign.id,
      product_id: productId,
      quantity: 1,
      scene: campaignScene(campaign.id),
      address_id: address.id
    })
  });
  if (campaign.lottery_enabled && result.lottery_record) {
    renderCampaignFlow("lottery", { campaign, productId, result });
    return;
  }
  renderCampaignFlow("traffic", { campaign, productId, result });
}

function renderCampaignFlow(step, context = {}) {
  const campaign = context.campaign;
  const product = campaign?.product || {};
  const result = context.result || null;
  $("#campaign-flow-modal").classList.add("open");
  $("#campaign-flow-steps").innerHTML = ["下单", "抽奖", "领奖"].map(item => {
    const active = (step === "checkout" || step === "paying") && item === "下单"
      || step === "lottery" && item === "抽奖"
      || step === "traffic" && item === "领奖";
    return `<span class="${active ? "active" : ""}">${item}</span>`;
  }).join("");
  if (step === "checkout" || step === "paying") {
    const address = defaultAddress();
    $("#campaign-flow-content").innerHTML = `
      <div class="flow-head">
        <div>
          <h2>确认订单</h2>
          <p>请先确认下单商品信息，支付完成后进入抽奖流程。</p>
        </div>
        <button class="icon-btn" id="flow-close">${icon("close")}</button>
      </div>
      <div class="order-product">
        <img src="${campaign.share_cover || product.images?.[0] || ""}" alt="${escapeHtml(campaign.name)}" />
        <div>
          <h3>${escapeHtml(campaign.name)}</h3>
          <p>${escapeHtml(product.title || "")}</p>
          <div style="display:flex; justify-content:space-between; align-items:center;"><strong class="price">${formatMoney(campaign.lead_price)}</strong><span class="pill warn">x1</span></div>
        </div>
      </div>
      <div class="address-card compact" style="margin-top:12px;">
        ${address ? `
          <div><strong>${escapeHtml(address.receiver_name)} ${escapeHtml(address.phone)}</strong><p>${escapeHtml(address.full_address)}</p></div>
          <button class="btn secondary" id="flow-edit-address" type="button">管理地址</button>
        ` : `
          <p>还没有收货地址。</p>
          <button class="btn" id="flow-edit-address" type="button">去编辑地址</button>
        `}
      </div>
      <button class="btn" id="flow-pay" style="width:100%; margin-top:14px;" ${step === "paying" ? "disabled" : ""}>${step === "paying" ? "正在支付" : `确认支付 ${formatMoney(campaign.lead_price)}`}</button>
    `;
    $("#flow-close").addEventListener("click", () => $("#campaign-flow-modal").classList.remove("open"));
    $("#flow-edit-address")?.addEventListener("click", () => {
      $("#campaign-flow-modal").classList.remove("open");
      setTab("distribution");
      openAddressForm();
    });
    $("#flow-pay").addEventListener("click", () => submitCampaignPayment(campaign, context.productId).catch(error => {
      if (!String(error.message || "").includes("收货地址")) {
        renderCampaignFlow("checkout", context);
      }
      toast(error.message);
    }));
    return;
  }
  if (step === "lottery") {
    const prizes = campaignPrizes(campaign);
    $("#campaign-flow-content").innerHTML = `
      <div class="flow-head"><div><h2>支付完成</h2><p>${escapeHtml(campaign.lottery_config?.description || "点击转盘开始抽奖。")}</p></div></div>
      <div class="wheel-wrap">
        <div class="wheel-pointer"></div>
        <div class="wheel" id="campaign-wheel">
          ${prizes.map(prize => `<span class="wheel-prize" style="transform: rotate(${prize.angle}deg) translateY(-145px);">${escapeHtml(prize.shortName)}</span>`).join("")}
        </div>
        <button class="wheel-button" id="spin-campaign-wheel">开始</button>
      </div>
      <div class="lottery-result hidden" id="campaign-lottery-result"></div>
    `;
    $("#spin-campaign-wheel").addEventListener("click", () => {
      const index = Math.max(0, prizes.findIndex(item => item.name === result.lottery_record.prize_name));
      const segment = 360 / prizes.length;
      const target = 360 * 6 + (360 - index * segment) - segment / 2;
      $("#campaign-wheel").style.transform = `rotate(${target}deg)`;
      $("#spin-campaign-wheel").disabled = true;
      $("#spin-campaign-wheel").textContent = "抽奖中";
      setTimeout(() => {
        $("#campaign-lottery-result").classList.remove("hidden");
        $("#campaign-lottery-result").innerHTML = `<strong>${escapeHtml(result.lottery_record.prize_name)}</strong><p>${result.lottery_record.prize_type === "thanks" ? "感谢参与，继续完成领奖步骤。" : "中奖啦，继续完成领奖步骤。"}</p>`;
        $("#spin-campaign-wheel").textContent = "已开奖";
        setTimeout(() => renderCampaignFlow("traffic", context), 900);
      }, 3100);
    });
    return;
  }
  const qrcode = campaignTrafficQrcode(campaign);
  $("#campaign-flow-content").innerHTML = `
    <div class="flow-head"><div><h2>扫码进群/加客服</h2><p>请打开二维码并长按识别，完成后才能关闭流程。</p></div></div>
    ${qrcode ? `
      <div class="traffic-card">
        <img src="${qrcode.image_url}" alt="${escapeHtml(qrcode.name)}" />
        <h3>${escapeHtml(qrcode.name)}</h3>
        <p>${escapeHtml(qrcode.note)}</p>
        <button class="btn ghost" id="open-flow-qrcode">打开二维码</button>
      </div>
    ` : '<div class="empty">当前活动未配置领奖二维码，可直接完成。</div>'}
    <button class="btn" id="finish-flow" style="width:100%; margin-top:14px;" ${qrcode ? "disabled" : ""}>完成并查看订单</button>
  `;
  if (qrcode) {
    $("#open-flow-qrcode").addEventListener("click", () => {
      window.open(qrcode.image_url, "_blank");
      $("#finish-flow").disabled = false;
    });
  }
  $("#finish-flow").addEventListener("click", async () => {
    $("#campaign-flow-modal").classList.remove("open");
    $("#campaign-modal").classList.remove("open");
    await Promise.all([loadProducts(), loadOrders(), loadDistribution()]);
    setTab("orders");
  });
}

async function openCampaign(id) {
  const campaign = await api(`/api/acquisition/campaigns/${id}?user_id=${state.user.id}&scene=${encodeURIComponent(campaignScene(id))}`);
  state.selectedCampaign = campaign;
  const image = campaign.share_cover || campaign.product?.images?.[0] || "";
  const sold = Number(campaign.sold_count || 0) + Number(campaign.virtual_sold_count || 0);
  const browse = Number(campaign.relation_count || 0) + Number(campaign.virtual_browse_count || 0);
  const rankings = campaign.virtual_rankings || [];
  $("#campaign-image").innerHTML = image ? `<img src="${image}" alt="${escapeHtml(campaign.name)}" />` : "";
  $("#campaign-title").textContent = campaign.name;
  $("#campaign-desc").textContent = campaign.description || campaign.product?.title || "";
  $("#campaign-content").innerHTML = `
    <div class="summary-grid" style="margin-top:14px;">
      <div class="summary-tile"><span>活动价</span><strong>${formatMoney(campaign.lead_price)}</strong></div>
      <div class="summary-tile"><span>销量 / 浏览</span><strong>${sold} / ${browse}</strong></div>
      <div class="summary-tile"><span>绑定模式</span><strong>${campaign.relation_mode_text}</strong></div>
      <div class="summary-tile"><span>每人限购</span><strong>${campaign.per_user_limit || "不限"}</strong></div>
    </div>
    ${rankings.length ? `
      <section class="campaign-block">
        <h3>虚拟排行榜</h3>
        ${rankings.map(item => `
          <div class="campaign-qrcode">
            ${item.avatar ? `<img src="${item.avatar}" alt="${escapeHtml(item.nickname || "用户")}" />` : '<div class="mock-qr" style="width:64px;height:64px;border-width:4px;">榜</div>'}
            <div><strong>${escapeHtml(item.nickname || "用户")}</strong><p>邀请 ${Number(item.invite_count || 0)} 人 · 奖励 ${formatMoney(item.reward_amount || 0)}</p></div>
          </div>
        `).join("")}
      </section>
    ` : ""}
  `;
  $("#campaign-buy-now").dataset.campaign = campaign.id;
  $("#campaign-buy-now").dataset.campaignProduct = campaign.product_id;
  $("#campaign-invite-now").dataset.campaignInvite = campaign.id;
  $("#campaign-modal").classList.add("open");
}

async function makeCampaignInvitePoster(campaignId) {
  const poster = await api(`/api/acquisition/campaigns/${campaignId}/invite-poster?user_id=${state.user.id}`);
  sessionStorage.setItem(`mallCampaignScene:${campaignId}`, poster.scene);
  $("#poster-content").innerHTML = `
    <div style="display:grid; gap:14px;">
      <img src="${assetUrl(poster.poster_url)}" alt="${escapeHtml(poster.campaign.name)}" style="width:100%; border-radius:18px; background:#edf2f7;" />
      <div class="campaign-qrcode">
        <img src="${assetUrl(poster.qrcode_url)}" alt="个人二维码" />
        <div>
          <strong>个人二维码</strong>
          <p>扫码进入小程序后，会按当前活动配置继续建立关系、下单和领奖。</p>
          <p style="word-break:break-all; color:var(--muted);">${escapeHtml(poster.path)}</p>
        </div>
      </div>
    </div>
  `;
  $("#poster-modal").classList.add("open");
}

async function makePoster(productId = null) {
  const product = productId
    ? await api(`/api/products/${productId}`)
    : state.selectedProduct || state.products[0];
  if (!product) {
    toast("暂无商品可生成海报");
    return;
  }
  const poster = await api(`/api/share-poster?user_id=${state.user.id}&product_id=${product.id}`);
  $("#poster-content").innerHTML = `
    <div class="poster">
      <img src="${assetUrl(poster.poster_url || poster.product.images[0])}" alt="${escapeHtml(poster.product.title)}" />
      <div class="poster-body">
        <span class="pill">${escapeHtml(poster.compliance_name || "推荐")}</span>
        <h3 style="margin-top:10px;">${escapeHtml(poster.product.title)}</h3>
        <p style="color:rgba(255,255,255,.76);">好友 ${escapeHtml(poster.user.nickname)} 推荐，扫码直接到商品详情并绑定关系，scene=${escapeHtml(poster.scene)}</p>
        <div class="poster-bottom">
          <div>
            <div class="price">${formatMoney(poster.product.price)}</div>
            <p style="margin:6px 0 0; color:rgba(255,255,255,.7);">路径：${escapeHtml(poster.path)}</p>
          </div>
          <img src="${assetUrl(poster.qrcode_url)}" alt="商品二维码邀请码" style="width:96px;height:96px;border-radius:12px;background:#fff;padding:8px;" />
        </div>
      </div>
    </div>
  `;
  $("#poster-modal").classList.add("open");
}

async function confirmOrder(id) {
  await api(`/api/orders/${id}/confirm`, { method: "POST" });
  toast("已确认收货，相关佣金变为可提现");
  await Promise.all([loadOrders(), loadDistribution()]);
}

async function submitLogin() {
  const user = await api("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({
      nickname: $("#login-name").value,
      phone: $("#login-phone").value,
      scene: $("#login-scene").value
    })
  });
  saveUser(user);
  $("#login-modal").classList.remove("open");
  await bootData();
  toast("登录成功");
}

async function applyDistributor() {
  const user = await api("/api/distribution/apply", {
    method: "POST",
    body: JSON.stringify({ user_id: state.user.id })
  });
  saveUser(user);
  toast(user.distributor_status === "approved" ? "你已经是推荐员" : "已提交推荐员审核");
  await loadDistribution();
}

async function submitWithdrawal() {
  const amount = Number($("#withdrawal-amount").value || 0);
  await api("/api/withdrawals", {
    method: "POST",
    body: JSON.stringify({
      user_id: state.user.id,
      amount,
      note: $("#withdrawal-note").value
    })
  });
  $("#withdrawal-modal").classList.remove("open");
  toast("提现申请已提交后台审核");
  await loadDistribution();
}

async function submitAddress(event) {
  event.preventDefault();
  state.addresses = await api(state.editingAddressId ? `/api/user/addresses/${state.editingAddressId}` : "/api/user/addresses", {
    method: state.editingAddressId ? "PUT" : "POST",
    body: JSON.stringify({
      id: state.editingAddressId || undefined,
      user_id: state.user.id,
      receiver_name: $("#address-receiver").value.trim(),
      phone: $("#address-phone").value.trim(),
      province: $("#address-province").value.trim(),
      city: $("#address-city").value.trim(),
      district: $("#address-district").value.trim(),
      detail: $("#address-detail").value.trim(),
      is_default: $("#address-default").checked
    })
  });
  closeAddressForm();
  renderAddressPanel();
  toast("地址已保存");
}

async function bootData() {
  renderUser();
  await Promise.all([loadProducts(), loadOrders(), loadDistribution()]);
  const params = new URLSearchParams(window.location.search);
  const campaignId = Number(params.get("campaign_id") || 0);
  const scene = params.get("scene") || "";
  if (campaignId) {
    if (scene) sessionStorage.setItem(`mallCampaignScene:${campaignId}`, scene);
    setTab("store");
    await openCampaign(campaignId);
  }
}

function bindEvents() {
  $$(".mini-tabs button, .quick-stats button").forEach(button => {
    button.addEventListener("click", () => setTab(button.dataset.tab));
  });
  $("#hero-shop").addEventListener("click", () => setTab("store"));
  $("#hero-share").addEventListener("click", () => makePoster());
  $("#open-login").addEventListener("click", () => $("#login-modal").classList.add("open"));
  $("#refresh-products").addEventListener("click", () => loadProducts().then(() => toast("商品已刷新")));
  $("#refresh-orders").addEventListener("click", () => loadOrders().then(() => toast("订单已刷新")));
  $("#refresh-distribution").addEventListener("click", () => loadDistribution().then(() => toast("分销数据已刷新")));
  $("#search-products").addEventListener("click", () => {
    state.keyword = $("#product-keyword").value.trim();
    loadProducts();
  });
  $("#product-keyword").addEventListener("keydown", event => {
    if (event.key === "Enter") {
      state.keyword = $("#product-keyword").value.trim();
      loadProducts();
    }
  });
  document.addEventListener("click", event => {
    const category = event.target.closest("[data-category]");
    if (category) {
      state.category = category.dataset.category;
      loadProducts();
    }
    const product = event.target.closest("[data-product]");
    if (product) {
      openProduct(Number(product.dataset.product)).catch(error => toast(error.message));
    }
    const confirm = event.target.closest("[data-confirm]");
    if (confirm) {
      confirmOrder(Number(confirm.dataset.confirm)).catch(error => toast(error.message));
    }
    const shareOrder = event.target.closest("[data-share-order]");
    if (shareOrder) {
      makePoster(Number(shareOrder.dataset.shareOrder)).catch(error => toast(error.message));
    }
    const campaign = event.target.closest("[data-campaign]");
    if (campaign) {
      openCampaign(Number(campaign.dataset.campaign)).catch(error => toast(error.message));
    }
    const viewCampaign = event.target.closest("[data-view-campaign]");
    if (viewCampaign) {
      openCampaign(Number(viewCampaign.dataset.viewCampaign)).catch(error => toast(error.message));
    }
    const campaignInvite = event.target.closest("[data-campaign-invite]");
    if (campaignInvite) {
      makeCampaignInvitePoster(Number(campaignInvite.dataset.campaignInvite)).catch(error => toast(error.message));
    }
  });
  $("#close-drawer").addEventListener("click", () => $("#product-drawer").classList.remove("open"));
  $("#buy-now").addEventListener("click", () => buySelectedProduct().catch(error => toast(error.message)));
  $("#make-poster").addEventListener("click", () => makePoster().catch(error => toast(error.message)));
  $("#close-poster").addEventListener("click", () => $("#poster-modal").classList.remove("open"));
  $("#close-campaign").addEventListener("click", () => $("#campaign-modal").classList.remove("open"));
  $("#apply-distributor").addEventListener("click", () => applyDistributor().catch(error => toast(error.message)));
  $("#open-withdrawal").addEventListener("click", () => $("#withdrawal-modal").classList.add("open"));
  $("#close-withdrawal").addEventListener("click", () => $("#withdrawal-modal").classList.remove("open"));
  $("#withdrawal-cancel").addEventListener("click", () => $("#withdrawal-modal").classList.remove("open"));
  $("#withdrawal-submit").addEventListener("click", () => submitWithdrawal().catch(error => toast(error.message)));
  $("#edit-address").addEventListener("click", () => openAddressForm());
  $("#cancel-address").addEventListener("click", () => closeAddressForm());
  $("#address-form").addEventListener("submit", event => submitAddress(event).catch(error => toast(error.message)));
  $("#login-submit").addEventListener("click", () => submitLogin().catch(error => toast(error.message)));
  $("#login-cancel").addEventListener("click", () => $("#login-modal").classList.remove("open"));
}

async function init() {
  hydrateIcons();
  bindEvents();
  await ensureUser();
  await bootData();
}

init().catch(error => toast(error.message));
