const api = require("../../utils/api");

function parseProductInviteScene(scene) {
  const match = String(scene || "").match(/^p(\d+)u(\d+)$/);
  if (!match) return null;
  return {
    productId: Number(match[1]),
    userId: Number(match[2])
  };
}

function productScene(productId) {
  const userId = wx.getStorageSync("mall_user_id") || "";
  return userId ? `p${Number(productId)}u${userId}` : "";
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function syncPaidOrder(orderId) {
  let lastError = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await api.syncOrderPayment(orderId);
    } catch (error) {
      lastError = error;
      if (attempt < 3) await wait(1200);
    }
  }
  throw lastError || new Error("支付确认失败");
}

function normalizePoster(poster) {
  return {
    ...poster,
    poster_url: api.assetUrl(poster.poster_url),
    qrcode_url: api.assetUrl(poster.qrcode_url)
  };
}

Page({
  data: {
    product: null,
    loading: true,
    poster: null,
    posterVisible: false,
    posterLoading: false
  },

  onShow() {
    if (this.data.product) this.startScreenHeartbeat(this.data.product);
  },

  async onLoad(options = {}) {
    const decodedScene = options.scene ? decodeURIComponent(options.scene) : "";
    const invite = parseProductInviteScene(decodedScene);
    if (decodedScene) wx.setStorageSync("mall_scene", decodedScene);
    if (invite) wx.setStorageSync("store_product_id", String(invite.productId));

    const productId = Number(options.id || options.product_id || (invite && invite.productId) || 0);
    if (!productId) {
      this.setData({ loading: false });
      wx.showToast({ title: "商品参数缺失", icon: "none" });
      return;
    }
    await this.loadProduct(productId);
  },

  async loadProduct(productId) {
    try {
      const product = await api.product(productId);
      this.setData({ product, loading: false });
      this.startScreenHeartbeat(product);
    } catch (error) {
      this.setData({ loading: false });
      wx.showToast({ title: error.message, icon: "none" });
    }
  },

  onHide() {
    this.stopScreenHeartbeat();
  },

  onUnload() {
    this.stopScreenHeartbeat();
  },

  startScreenHeartbeat(product) {
    this.stopScreenHeartbeat();
    if (!product || !product.id) return;
    const send = async () => {
      if (this.heartbeatSending) return;
      this.heartbeatSending = true;
      try {
        const user = await getApp().ensureUser();
        await api.screenHeartbeat({
          user_id: user.id,
          product_id: product.id,
          scene: wx.getStorageSync("mall_scene") || "",
          page: "product"
        });
      } catch (error) {
        // Online status is best-effort; product browsing should not depend on it.
      } finally {
        this.heartbeatSending = false;
      }
    };
    send();
    this.heartbeatTimer = setInterval(send, 3000);
  },

  stopScreenHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.heartbeatSending = false;
  },

  async buyProduct() {
    if (!this.data.product) return;
    let orderId = 0;
    let paymentSucceeded = false;
    try {
      const user = await getApp().ensureUser();
      const addresses = await api.userAddresses(user.id);
      const address = addresses.find(item => item.is_default) || addresses[0] || null;
      if (!address) {
        wx.showModal({
          title: "请先维护收货地址",
          content: "下单需要选择收货地址，先去个人页新增一个地址。",
          confirmText: "去编辑",
          success(res) {
            if (res.confirm) {
              wx.setStorageSync("profile_edit_address", "1");
              wx.switchTab({ url: "/pages/distribution/index" });
            }
          }
        });
        return;
      }
      const result = await api.createOrder({
        user_id: user.id,
        product_id: this.data.product.id,
        quantity: 1,
        address_id: address.id
      });
      orderId = result.order && result.order.id;
      const paymentParams = result.payment && result.payment.params;
      if (!paymentParams) throw new Error("支付参数生成失败");
      await new Promise((resolve, reject) => {
        wx.requestPayment({
          timeStamp: paymentParams.timeStamp,
          nonceStr: paymentParams.nonceStr,
          package: paymentParams.package,
          signType: paymentParams.signType || "RSA",
          paySign: paymentParams.paySign,
          success: resolve,
          fail: reject
        });
      });
      paymentSucceeded = true;
      await syncPaidOrder(result.order.id);
      wx.showToast({ title: "下单成功" });
      wx.switchTab({ url: "/pages/orders/index" });
    } catch (error) {
      if (orderId && !paymentSucceeded) {
        try {
          await api.closeOrder(orderId);
        } catch (closeError) {
          // The order may already be paid or closed by another callback.
        }
      }
      wx.showToast({
        title: paymentSucceeded ? "支付已完成，系统确认中" : error.message,
        icon: "none"
      });
    }
  },

  async showPoster() {
    if (!this.data.product) return;
    try {
      this.setData({ posterLoading: true });
      const user = await getApp().ensureUser();
      const poster = normalizePoster(await api.sharePoster(user.id, this.data.product.id));
      wx.setStorageSync("mall_scene", poster.scene);
      this.setData({
        poster,
        posterVisible: true,
        posterLoading: false
      });
    } catch (error) {
      this.setData({ posterLoading: false });
      wx.showToast({ title: error.message, icon: "none" });
    }
  },

  closePoster() {
    this.setData({ posterVisible: false });
  },

  previewPoster() {
    const poster = this.data.poster;
    if (!poster || !poster.poster_url) return;
    wx.previewImage({
      urls: [poster.poster_url],
      current: poster.poster_url
    });
  },

  previewQrcode() {
    const poster = this.data.poster;
    if (!poster || !poster.qrcode_url) return;
    wx.previewImage({
      urls: [poster.qrcode_url],
      current: poster.qrcode_url
    });
  },

  copyPosterPath() {
    const poster = this.data.poster;
    if (!poster || !poster.path) return;
    wx.setClipboardData({ data: poster.path });
  },

  noop() {},

  onShareAppMessage() {
    const product = this.data.product || {};
    const scene = product.id ? productScene(product.id) : "";
    return {
      title: product.title || "商品详情",
      path: `/pages/product/detail?id=${product.id || ""}${scene ? `&scene=${scene}` : ""}`,
      imageUrl: product.images && product.images[0] || ""
    };
  },

  onShareTimeline() {
    const share = this.onShareAppMessage();
    return {
      title: share.title,
      query: share.path.split("?")[1] || "",
      imageUrl: share.imageUrl || ""
    };
  }
});
