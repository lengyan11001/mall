const api = require("../../utils/api");

function money(value) {
  return Number(value || 0).toFixed(2);
}

Page({
  data: {
    summary: {
      user: {},
      withdrawable: "0.00",
      pending: "0.00",
      direct_count: 0,
      indirect_count: 0
    },
    commissions: [],
    customers: [],
    addresses: [],
    defaultAddress: null,
    addressEditing: false,
    addressForm: {
      id: 0,
      receiver_name: "",
      phone: "",
      province: "",
      city: "",
      district: "",
      detail: "",
      is_default: true
    }
  },

  async onShow() {
    await this.loadSummary();
  },

  async loadSummary() {
    try {
      const user = await getApp().ensureUser();
      const [summary, addresses] = await Promise.all([
        api.distributionSummary(user.id),
        api.userAddresses(user.id)
      ]);
      const defaultAddress = addresses.find(item => item.is_default) || addresses[0] || null;
      this.setData({
        summary: {
          ...summary,
          withdrawable: money(summary.withdrawable),
          pending: money(summary.pending)
        },
        commissions: summary.commissions,
        customers: summary.customers,
        addresses,
        defaultAddress
      });
      if (wx.getStorageSync("profile_edit_address")) {
        wx.removeStorageSync("profile_edit_address");
        this.startAddressEdit({ currentTarget: { dataset: { id: defaultAddress ? defaultAddress.id : 0 } } });
      }
    } catch (error) {
      wx.showToast({ title: error.message, icon: "none" });
    }
  },

  async applyDistributor() {
    try {
      const user = await getApp().ensureUser();
      await api.applyDistributor(user.id);
      wx.showToast({ title: "已提交审核" });
      await this.loadSummary();
    } catch (error) {
      wx.showToast({ title: error.message, icon: "none" });
    }
  },

  async withdraw() {
    try {
      const user = await getApp().ensureUser();
      await api.createWithdrawal({
        user_id: user.id,
        amount: Number(this.data.summary.withdrawable),
        note: "小程序提现申请"
      });
      wx.showToast({ title: "已提交提现" });
      await this.loadSummary();
    } catch (error) {
      wx.showToast({ title: error.message, icon: "none" });
    }
  },

  startAddressEdit(event) {
    const id = Number(event.currentTarget.dataset.id || 0);
    const current = this.data.addresses.find(item => item.id === id);
    this.setData({
      addressEditing: true,
      addressForm: current ? {
        id: current.id,
        receiver_name: current.receiver_name,
        phone: current.phone,
        province: current.province,
        city: current.city,
        district: current.district,
        detail: current.detail,
        is_default: current.is_default
      } : {
        id: 0,
        receiver_name: "",
        phone: "",
        province: "",
        city: "",
        district: "",
        detail: "",
        is_default: true
      }
    });
  },

  cancelAddressEdit() {
    this.setData({ addressEditing: false });
  },

  onAddressInput(event) {
    const field = event.currentTarget.dataset.field;
    this.setData({
      [`addressForm.${field}`]: event.detail.value
    });
  },

  onAddressDefault(event) {
    this.setData({ "addressForm.is_default": event.detail.value });
  },

  async saveAddress() {
    try {
      const user = await getApp().ensureUser();
      const form = this.data.addressForm;
      if (!form.receiver_name || !form.phone || !form.detail) {
        wx.showToast({ title: "请填写收件人、手机号和详细地址", icon: "none" });
        return;
      }
      const addresses = await api.saveUserAddress({
        ...form,
        user_id: user.id
      });
      const defaultAddress = addresses.find(item => item.is_default) || addresses[0] || null;
      this.setData({
        addresses,
        defaultAddress,
        addressEditing: false
      });
      wx.showToast({ title: "地址已保存" });
    } catch (error) {
      wx.showToast({ title: error.message, icon: "none" });
    }
  }
});
