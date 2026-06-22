const api = require("./utils/api");

function parseCampaignInviteScene(scene) {
  const match = String(scene || "").match(/^c(\d+)u(\d+)$/);
  if (!match) return null;
  return {
    campaignId: Number(match[1]),
    userId: Number(match[2])
  };
}

function parseProductInviteScene(scene) {
  const match = String(scene || "").match(/^p(\d+)u(\d+)$/);
  if (!match) return null;
  return {
    productId: Number(match[1]),
    userId: Number(match[2])
  };
}

App({
  globalData: {
    user: null,
    token: ""
  },

  onLaunch(options) {
    this.captureScene(options);
  },

  onShow(options) {
    this.captureScene(options);
  },

  captureScene(options = {}) {
    const query = options.query || {};
    const scene = query.scene || "";
    if (scene) {
      const decodedScene = decodeURIComponent(scene);
      const invite = parseCampaignInviteScene(decodedScene);
      if (invite) {
        wx.setStorageSync(`mall_campaign_scene:${invite.campaignId}`, decodedScene);
        wx.setStorageSync("mall_scene", decodedScene);
        wx.setStorageSync("home_campaign_id", String(invite.campaignId));
        return;
      }
      const productInvite = parseProductInviteScene(decodedScene);
      if (productInvite) {
        wx.setStorageSync("mall_scene", decodedScene);
        wx.setStorageSync("store_product_id", String(productInvite.productId));
        return;
      }
      if (query.campaign_id) {
        wx.setStorageSync(`mall_campaign_scene:${Number(query.campaign_id)}`, decodedScene);
        return;
      }
      wx.setStorageSync("mall_scene", decodedScene);
    }
  },

  async ensureUser() {
    if (this.globalData.user) {
      await this.bindSceneIfNeeded();
      return this.globalData.user;
    }
    return this.loginWithWechat();
  },

  async bindSceneIfNeeded() {
    const scene = wx.getStorageSync("mall_scene") || "";
    const user = this.globalData.user;
    if (!scene || !user || user.parent_id) return user;
    try {
      const updated = await api.bindInviter({
        user_id: user.id,
        scene
      });
      this.globalData.user = updated;
      return updated;
    } catch (error) {
      if (String(error.message || "").includes("已经绑定")) return user;
      return user;
    }
  },

  async loginWithWechat(extra = {}) {
    const code = await new Promise((resolve, reject) => {
      wx.login({
        success: result => result.code ? resolve(result.code) : reject(new Error("微信登录未返回 code")),
        fail: reject
      });
    });
    const result = await api.wechatLogin({
      code,
      scene: extra.scene || wx.getStorageSync("mall_scene") || "",
      userInfo: extra.userInfo || null
    });
    this.globalData.user = result.user;
    this.globalData.token = result.token;
    wx.setStorageSync("mall_user_id", result.user.id);
    wx.setStorageSync("mall_session", result.token);
    return result.user;
  },

  async refreshWechatProfile(userInfo) {
    const user = await this.loginWithWechat({ userInfo });
    return user;
  }
});
