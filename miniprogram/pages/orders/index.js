const api = require("../../utils/api");

Page({
  data: {
    orders: []
  },

  async onShow() {
    await this.loadOrders();
  },

  async loadOrders() {
    try {
      const user = await getApp().ensureUser();
      const orders = await api.orders(user.id);
      this.setData({ orders });
    } catch (error) {
      wx.showToast({ title: error.message, icon: "none" });
    }
  },

  async confirmOrder(event) {
    try {
      await api.confirmOrder(Number(event.currentTarget.dataset.id));
      wx.showToast({ title: "已确认收货" });
      await this.loadOrders();
    } catch (error) {
      wx.showToast({ title: error.message, icon: "none" });
    }
  },

  async showPoster(event) {
    try {
      const user = await getApp().ensureUser();
      const poster = await api.sharePoster(user.id, Number(event.currentTarget.dataset.id));
      const posterUrl = api.assetUrl(poster.poster_url);
      wx.setStorageSync("mall_scene", poster.scene);
      wx.previewImage({
        urls: [posterUrl],
        current: posterUrl
      });
    } catch (error) {
      wx.showToast({ title: error.message, icon: "none" });
    }
  }
});
