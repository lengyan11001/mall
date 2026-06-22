const { apiBase } = require("../env");

function request(path, options = {}) {
  return new Promise((resolve, reject) => {
    wx.request({
      url: `${apiBase}${path}`,
      method: options.method || "GET",
      data: options.data || {},
      header: {
        "content-type": "application/json",
        "X-Mall-Session": wx.getStorageSync("mall_session") || ""
      },
      success(res) {
        const payload = res.data || {};
        if (res.statusCode >= 200 && res.statusCode < 300 && payload.ok !== false) {
          resolve(payload.data);
          return;
        }
        reject(new Error(payload.error || `请求失败：${res.statusCode}`));
      },
      fail(error) {
        reject(new Error(error.errMsg || "网络请求失败"));
      }
    });
  });
}

function assetUrl(path) {
  if (!path) return "";
  if (/^https?:\/\//.test(path)) return path;
  return `${apiBase}${path}`;
}

function getMe(userId) {
  return request(`/api/me?user_id=${userId}`);
}

function wechatLogin(data) {
  return request("/api/wechat/login", { method: "POST", data });
}

function bindInviter(data) {
  return request("/api/me/inviter", { method: "PATCH", data });
}

function products(params = {}) {
  const category = encodeURIComponent(params.category || "全部");
  const keyword = encodeURIComponent(params.keyword || "");
  return request(`/api/products?category=${category}&keyword=${keyword}`);
}

function product(productId) {
  return request(`/api/products/${productId}`);
}

function acquisitionCampaigns(params = {}) {
  const keyword = encodeURIComponent(params.keyword || "");
  return request(`/api/acquisition/campaigns?keyword=${keyword}`);
}

function activeAcquisitionCampaign(params = {}) {
  const userId = encodeURIComponent(params.user_id || "");
  const scene = encodeURIComponent(params.scene || "");
  return request(`/api/acquisition/active?user_id=${userId}&scene=${scene}`);
}

function acquisitionCampaign(campaignId, params = {}) {
  const userId = encodeURIComponent(params.user_id || "");
  const scene = encodeURIComponent(params.scene || "");
  const query = `user_id=${userId}&scene=${scene}`;
  return request(`/api/acquisition/campaigns/${campaignId}?${query}`);
}

function campaignInvitePoster(campaignId, userId) {
  return request(`/api/acquisition/campaigns/${campaignId}/invite-poster?user_id=${userId}`);
}

function orders(userId) {
  return request(`/api/orders?user_id=${userId}`);
}

function userAddresses(userId) {
  return request(`/api/user/addresses?user_id=${userId}`);
}

function saveUserAddress(data) {
  if (data.id) {
    return request(`/api/user/addresses/${data.id}`, { method: "PUT", data });
  }
  return request("/api/user/addresses", { method: "POST", data });
}

function createOrder(data) {
  return request("/api/orders", { method: "POST", data });
}

function confirmOrder(orderId) {
  return request(`/api/orders/${orderId}/confirm`, { method: "POST" });
}

function syncOrderPayment(orderId) {
  return request(`/api/orders/${orderId}/pay/sync`, { method: "POST" });
}

function closeOrder(orderId) {
  return request(`/api/orders/${orderId}/close`, { method: "POST" });
}

function distributionSummary(userId) {
  return request(`/api/distribution/summary?user_id=${userId}`);
}

function applyDistributor(userId) {
  return request("/api/distribution/apply", { method: "POST", data: { user_id: userId } });
}

function createWithdrawal(data) {
  return request("/api/withdrawals", { method: "POST", data });
}

function sharePoster(userId, productId) {
  return request(`/api/share-poster?user_id=${userId}&product_id=${productId}`);
}

function screenHeartbeat(data) {
  return request("/api/screen/heartbeat", { method: "POST", data });
}

module.exports = {
  request,
  assetUrl,
  getMe,
  wechatLogin,
  bindInviter,
  products,
  product,
  acquisitionCampaigns,
  activeAcquisitionCampaign,
  acquisitionCampaign,
  campaignInvitePoster,
  orders,
  userAddresses,
  saveUserAddress,
  createOrder,
  confirmOrder,
  syncOrderPayment,
  closeOrder,
  distributionSummary,
  applyDistributor,
  createWithdrawal,
  sharePoster,
  screenHeartbeat
};
