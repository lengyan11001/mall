const api = require("../../utils/api");

function money(value) {
  return Number(value || 0).toFixed(2);
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

function prizeLabel(name) {
  const text = String(name || "奖品");
  return text.length > 5 ? `${text.slice(0, 5)}...` : text;
}

function wheelPrizes(campaign) {
  const prizes = campaign && campaign.lottery_config && Array.isArray(campaign.lottery_config.prizes)
    ? campaign.lottery_config.prizes
    : [];
  const normalized = prizes.length ? prizes : [{ name: "谢谢参与", type: "thanks", probability: 1 }];
  const segment = 360 / normalized.length;
  return normalized.map((item, index) => ({
    ...item,
    angle: Math.round(index * segment),
    shortName: prizeLabel(item.name)
  }));
}

function trafficQrcode(campaign) {
  if (!campaign) return null;
  const active = Array.isArray(campaign.active_qrcodes) ? campaign.active_qrcodes : [];
  const qrcodes = active.length
    ? active
    : (Array.isArray(campaign.qrcodes) ? campaign.qrcodes.filter(item => item.status === "enabled") : []);
  if (qrcodes.length) {
    return {
      name: qrcodes[0].name,
      image_url: qrcodes[0].image_url,
      note: qrcodes[0].type_text || "领奖二维码"
    };
  }
  if (campaign.qrcode_guide_image) {
    return {
      name: "领奖入口",
      image_url: campaign.qrcode_guide_image,
      note: "请长按识别二维码"
    };
  }
  if (campaign.customer_service_qrcode) {
    return {
      name: "客服二维码",
      image_url: campaign.customer_service_qrcode,
      note: "请长按识别二维码"
    };
  }
  return null;
}

function addressLabels(addresses) {
  return addresses.map(item => `${item.receiver_name} ${item.phone}`);
}

function isAddressFormField(field) {
  const source = [
    field && field.key,
    field && field.name,
    field && field.label,
    field && field.placeholder
  ].filter(Boolean).join(" ").toLowerCase();
  return [
    "联系人",
    "联系电话",
    "联系手机",
    "手机号",
    "手机号码",
    "电话",
    "收件人",
    "收货人",
    "姓名",
    "name",
    "phone",
    "mobile",
    "tel",
    "contact",
    "receiver"
  ].some(keyword => source.includes(keyword));
}

function activityFormSchema(campaign) {
  const schema = campaign && Array.isArray(campaign.form_schema) ? campaign.form_schema : [];
  return schema.filter(field => !isAddressFormField(field));
}

function visibleFormValues(values, schema) {
  const allowed = new Set(schema.map(field => field.key).filter(Boolean));
  return Object.keys(values || {}).reduce((result, key) => {
    if (allowed.has(key)) result[key] = values[key];
    return result;
  }, {});
}

function campaignSceneKey(campaignId) {
  return `mall_campaign_scene:${Number(campaignId || 0)}`;
}

function campaignScene(campaignId) {
  return wx.getStorageSync(campaignSceneKey(campaignId)) || wx.getStorageSync("mall_scene") || "";
}

function parseCampaignInviteScene(scene) {
  const match = String(scene || "").match(/^c(\d+)u(\d+)$/);
  if (!match) return null;
  return {
    campaignId: Number(match[1]),
    userId: Number(match[2])
  };
}

function normalizeInvitePoster(poster) {
  return {
    ...poster,
    poster_url: api.assetUrl(poster.poster_url),
    qrcode_url: api.assetUrl(poster.qrcode_url)
  };
}

Page({
  data: {
    user: {},
    campaign: null,
    loading: true,
    relationText: "正在载入账户",
    campaignFormValues: {},
    campaignFormSchema: [],
    invitePosterVisible: false,
    invitePosterLoading: false,
    invitePoster: null,
    orderFlow: {
      visible: false,
      step: "checkout",
      campaign: null,
      product: null,
      formSchema: [],
      formValues: {},
      order: null,
      payment: null,
      wheelPrizes: [],
      wheelStyle: "transform: rotate(0deg);",
      wheelSpinning: false,
      lotteryRecord: null,
      lotteryDone: false,
      trafficQrcode: null,
      trafficScanned: false,
      addresses: [],
      addressLabels: [],
      selectedAddressId: 0,
      selectedAddress: null
    }
  },

  onLoad(options = {}) {
    const decodedScene = options.scene ? decodeURIComponent(options.scene) : "";
    const invite = parseCampaignInviteScene(decodedScene);
    if (invite) {
      this.pendingCampaignId = invite.campaignId;
      wx.setStorageSync(campaignSceneKey(invite.campaignId), decodedScene);
      wx.setStorageSync("mall_scene", decodedScene);
    } else if (options.campaign_id) {
      this.pendingCampaignId = Number(options.campaign_id);
      if (decodedScene) wx.setStorageSync(campaignSceneKey(this.pendingCampaignId), decodedScene);
    } else if (decodedScene) {
      wx.setStorageSync("mall_scene", decodedScene);
    }
  },

  async onShow() {
    const storedCampaignId = Number(wx.getStorageSync("home_campaign_id") || 0);
    if (storedCampaignId) {
      wx.removeStorageSync("home_campaign_id");
      this.pendingCampaignId = storedCampaignId;
    }
    await this.loadData();
  },

  onHide() {
    this.stopScreenHeartbeat();
  },

  onUnload() {
    this.stopScreenHeartbeat();
  },

  async loadData() {
    try {
      this.setData({ loading: true });
      const app = getApp();
      const user = await app.ensureUser();
      const campaignRequest = this.pendingCampaignId
        ? api.acquisitionCampaign(this.pendingCampaignId, {
            user_id: user.id,
            scene: campaignScene(this.pendingCampaignId)
          })
        : api.activeAcquisitionCampaign({
            user_id: user.id,
            scene: wx.getStorageSync("mall_scene") || ""
          });
      const campaign = await campaignRequest;
      if (campaign && campaign.id) {
        wx.setStorageSync(campaignSceneKey(campaign.id), campaignScene(campaign.id));
      }
      this.pendingCampaignId = 0;
      this.setData({
        user,
        loading: false,
        relationText: `${user.parent_id ? `推荐人 ID ${user.parent_id}` : "未绑定推荐人"} · ${user.distributor_status}`,
        campaign,
        campaignFormSchema: activityFormSchema(campaign),
        campaignFormValues: {}
      });
      this.startScreenHeartbeat(campaign);
    } catch (error) {
      this.setData({ loading: false });
      wx.showToast({ title: error.message, icon: "none" });
    }
  },

  async syncProfile() {
    try {
      const profile = await new Promise((resolve, reject) => {
        wx.getUserProfile({
          desc: "用于完善会员昵称和头像",
          success: resolve,
          fail: reject
        });
      });
      await getApp().refreshWechatProfile(profile.userInfo);
      await this.loadData();
      wx.showToast({ title: "已同步" });
    } catch (error) {
      wx.showToast({ title: "未同步资料", icon: "none" });
    }
  },

  startScreenHeartbeat(campaign) {
    this.stopScreenHeartbeat();
    if (!campaign || !campaign.id) return;
    const send = async () => {
      if (this.heartbeatSending) return;
      this.heartbeatSending = true;
      try {
        const user = await getApp().ensureUser();
        await api.screenHeartbeat({
          user_id: user.id,
          campaign_id: campaign.id,
          product_id: campaign.product_id || (campaign.product && campaign.product.id) || 0,
          scene: campaignScene(campaign.id),
          page: "home-campaign"
        });
      } catch (error) {
        // 浏览心跳只服务数据大屏，不阻塞用户下单。
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

  onCampaignFieldInput(event) {
    const key = event.currentTarget.dataset.key;
    this.setData({
      campaignFormValues: {
        ...this.data.campaignFormValues,
        [key]: event.detail.value
      }
    });
  },

  onFlowFieldInput(event) {
    const key = event.currentTarget.dataset.key;
    this.setData({
      "orderFlow.formValues": {
        ...this.data.orderFlow.formValues,
        [key]: event.detail.value
      }
    });
  },

  selectFlowAddress(event) {
    const index = Number(event.detail.value || 0);
    const selectedAddress = this.data.orderFlow.addresses[index] || null;
    this.setData({
      "orderFlow.selectedAddress": selectedAddress,
      "orderFlow.selectedAddressId": selectedAddress ? selectedAddress.id : 0
    });
  },

  goAddressSettings() {
    wx.setStorageSync("profile_edit_address", "1");
    this.setData({ "orderFlow.visible": false });
    wx.switchTab({ url: "/pages/distribution/index" });
  },

  async buyCampaign() {
    const campaign = this.data.campaign;
    if (!campaign || !campaign.id) return;
    try {
      const user = await getApp().ensureUser();
      const addresses = await api.userAddresses(user.id);
      const selectedAddress = addresses.find(item => item.is_default) || addresses[0] || null;
      this.setData({
        orderFlow: {
          visible: true,
          step: "checkout",
          campaign,
          product: campaign.product,
          formSchema: activityFormSchema(campaign),
          formValues: { ...this.data.campaignFormValues },
          order: null,
          payment: null,
          wheelPrizes: wheelPrizes(campaign),
          wheelStyle: "transform: rotate(0deg);",
          wheelSpinning: false,
          lotteryRecord: null,
          lotteryDone: false,
          trafficQrcode: null,
          trafficScanned: false,
          addresses,
          addressLabels: addressLabels(addresses),
          selectedAddressId: selectedAddress ? selectedAddress.id : 0,
          selectedAddress
        }
      });
    } catch (error) {
      wx.showToast({ title: error.message, icon: "none" });
    }
  },

  closeOrderFlow() {
    if (this.data.orderFlow.step !== "checkout") return;
    this.setData({ "orderFlow.visible": false });
  },

  validateFlowForm() {
    const campaign = this.data.orderFlow.campaign;
    const schema = this.data.orderFlow.formSchema || activityFormSchema(campaign);
    const values = this.data.orderFlow.formValues || {};
    const missing = schema.find(field => field.required && !String(values[field.key] || "").trim());
    if (missing) {
      wx.showToast({ title: `请填写${missing.label || "报名信息"}`, icon: "none" });
      return false;
    }
    return true;
  },

  async confirmCampaignPayment() {
    if (!this.validateFlowForm()) return;
    const flow = this.data.orderFlow;
    const campaign = flow.campaign;
    if (!campaign) return;
    if (!flow.selectedAddressId) {
      wx.showToast({ title: "请先选择收货地址", icon: "none" });
      return;
    }
    let orderId = 0;
    let paymentSucceeded = false;
    try {
      this.setData({ "orderFlow.step": "paying" });
      const user = await getApp().ensureUser();
      const result = await api.createOrder({
        user_id: user.id,
        campaign_id: campaign.id,
        product_id: campaign.product_id,
        quantity: 1,
        scene: campaignScene(campaign.id),
        form_values: visibleFormValues(flow.formValues, flow.formSchema || []),
        address_id: flow.selectedAddressId
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
      const paid = await syncPaidOrder(result.order.id);
      this.setData({
        "orderFlow.order": paid.order,
        "orderFlow.payment": result.payment,
        "orderFlow.lotteryRecord": paid.lottery_record || null
      });
      if (campaign.lottery_enabled && paid.lottery_record) {
        this.setData({ "orderFlow.step": "lottery" });
        return;
      }
      this.showTrafficStep();
    } catch (error) {
      if (orderId && !paymentSucceeded) {
        try {
          await api.closeOrder(orderId);
        } catch (closeError) {
          // 订单可能已经被回调支付成功或关闭。
        }
      }
      this.setData({ "orderFlow.step": paymentSucceeded ? "paying" : "checkout" });
      wx.showToast({
        title: paymentSucceeded ? "支付已完成，系统确认中" : error.message,
        icon: "none"
      });
    }
  },

  spinLottery() {
    const flow = this.data.orderFlow;
    if (flow.wheelSpinning || !flow.lotteryRecord) return;
    const prizes = flow.wheelPrizes.length ? flow.wheelPrizes : [{ name: "谢谢参与", angle: 0, shortName: "谢谢参与" }];
    const index = Math.max(0, prizes.findIndex(item => item.name === flow.lotteryRecord.prize_name));
    const safeIndex = index < 0 ? 0 : index;
    const segment = 360 / prizes.length;
    const target = 360 * 6 + (360 - safeIndex * segment) - segment / 2;
    this.setData({
      "orderFlow.wheelSpinning": true,
      "orderFlow.wheelStyle": `transform: rotate(${target}deg);`
    });
    setTimeout(() => {
      this.setData({
        "orderFlow.wheelSpinning": false,
        "orderFlow.lotteryDone": true
      });
      setTimeout(() => this.showTrafficStep(), 1000);
    }, 3200);
  },

  showTrafficStep() {
    const qrcode = trafficQrcode(this.data.orderFlow.campaign);
    this.setData({
      "orderFlow.step": "traffic",
      "orderFlow.trafficQrcode": qrcode,
      "orderFlow.trafficScanned": !qrcode
    });
  },

  previewTrafficQrcode() {
    const qrcode = this.data.orderFlow.trafficQrcode;
    if (!qrcode || !qrcode.image_url) return;
    wx.previewImage({
      urls: [qrcode.image_url],
      current: qrcode.image_url,
      complete: () => {
        this.setData({ "orderFlow.trafficScanned": true });
      }
    });
  },

  finishTrafficFlow() {
    if (!this.data.orderFlow.trafficScanned) {
      wx.showToast({ title: "请先长按识别二维码", icon: "none" });
      return;
    }
    this.setData({ "orderFlow.visible": false });
    wx.switchTab({ url: "/pages/orders/index" });
  },

  async shareCampaign() {
    const campaign = this.data.campaign;
    if (!campaign || !campaign.id) return;
    try {
      this.setData({ invitePosterLoading: true });
      const user = await getApp().ensureUser();
      const poster = normalizeInvitePoster(await api.campaignInvitePoster(campaign.id, user.id));
      wx.setStorageSync(campaignSceneKey(campaign.id), poster.scene);
      wx.setStorageSync("mall_scene", poster.scene);
      this.setData({
        invitePoster: poster,
        invitePosterVisible: true,
        invitePosterLoading: false
      });
    } catch (error) {
      this.setData({ invitePosterLoading: false });
      wx.showToast({ title: error.message, icon: "none" });
    }
  },

  closeInvitePoster() {
    this.setData({ invitePosterVisible: false });
  },

  previewInvitePoster() {
    const poster = this.data.invitePoster;
    if (!poster || !poster.poster_url) return;
    wx.previewImage({
      urls: [poster.poster_url],
      current: poster.poster_url
    });
  },

  previewInviteQrcode() {
    const poster = this.data.invitePoster;
    if (!poster || !poster.qrcode_url) return;
    wx.previewImage({
      urls: [poster.qrcode_url],
      current: poster.qrcode_url
    });
  },

  copyInvitePath() {
    const poster = this.data.invitePoster;
    if (!poster || !poster.path) return;
    wx.setClipboardData({ data: poster.path });
  },

  noop() {},

  onShareAppMessage() {
    const userId = wx.getStorageSync("mall_user_id") || "";
    const campaign = this.data.campaign;
    if (campaign && campaign.id) {
      const scene = campaignScene(campaign.id) || `c${campaign.id}u${userId}`;
      return {
        title: campaign.share_description || campaign.name,
        path: `/pages/home/index?campaign_id=${campaign.id}&scene=${scene}`,
        imageUrl: campaign.share_cover || (campaign.product && campaign.product.images && campaign.product.images[0]) || ""
      };
    }
    return {
      title: "必火次元",
      path: `/pages/home/index${userId ? `?scene=${userId}` : ""}`
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
