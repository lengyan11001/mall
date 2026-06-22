const statusText = {
  unpaid: "待支付",
  paid: "已付款",
  shipped: "已发货",
  received: "已收货",
  refunded: "已退款",
  closed: "已关闭",
  pending: "待结算",
  withdrawable: "可提现",
  canceled: "已取消",
  approved: "已通过",
  rejected: "已拒绝",
  paidout: "已打款",
  on: "上架",
  off: "下架",
  draft: "未发布",
  published: "已发布",
  ended: "已结束",
  expired: "已过期",
  enabled: "启用",
  disabled: "停用"
};

function money(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function parseJson(value, fallback) {
  if (value == null || value === "") return fallback;
  if (Array.isArray(value) || typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function bool(value) {
  return Boolean(Number(value || 0));
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

function activityFormSchema(value) {
  const schema = parseJson(value, []);
  return Array.isArray(schema) ? schema.filter(field => !isAddressFormField(field)) : [];
}

function publicProduct(product) {
  const images = parseJson(product.images_json, null);
  const normalizedImages = Array.isArray(images)
    ? images.filter(Boolean)
    : (product.image_url ? [product.image_url] : []);
  return {
    ...product,
    subtitle: product.subtitle || "",
    product_no: product.product_no || "",
    barcode: product.barcode || "",
    brand: product.brand || "",
    unit: product.unit || "件",
    market_price: money(product.market_price || product.price),
    price: money(product.price),
    cost_price: money(product.cost_price),
    weight: Number(product.weight || 0),
    min_buy_qty: Number(product.min_buy_qty || 1),
    per_order_limit: Number(product.per_order_limit || 0),
    per_user_limit: Number(product.per_user_limit || 0),
    is_virtual: bool(product.is_virtual),
    no_refund_after_pay: bool(product.no_refund_after_pay),
    freight_template: product.freight_template || "",
    delivery_methods: parseJson(product.delivery_methods, ["express"]),
    vip_enabled: bool(product.vip_enabled ?? 1),
    commission_rate: Number(product.commission_rate),
    images: normalizedImages,
    detail_html: product.detail_html || "",
    status_text: statusText[product.status] || product.status,
    commission_label: `${Math.round(Number(product.commission_rate || 0) * 100)}%`
  };
}

function campaignRow(row) {
  const modeText = {
    current: "按会员当前推荐关系",
    first: "按会员首次推荐关系",
    activity_visit: "独立关系链：进入活动锁定",
    activity_paid: "独立关系链：下单付款后锁定"
  };
  return {
    id: row.id,
    name: row.name,
    description: row.description || "",
    product_id: row.product_id,
    product: row.product_title ? publicProduct({
      id: row.product_id,
      title: row.product_title,
      subtitle: row.product_subtitle,
      product_no: row.product_no,
      barcode: row.product_barcode,
      category: row.product_category,
      brand: row.product_brand,
      unit: row.product_unit,
      market_price: row.product_market_price,
      price: row.product_price,
      cost_price: row.product_cost_price,
      stock: row.product_stock,
      sales: row.product_sales,
      status: row.product_status,
      commission_rate: row.product_commission_rate,
      image_url: row.product_image_url,
      images_json: row.product_images_json,
      detail_html: row.product_detail_html,
      description: row.product_description,
      weight: row.product_weight,
      min_buy_qty: row.product_min_buy_qty,
      per_order_limit: row.product_per_order_limit,
      per_user_limit: row.product_per_user_limit,
      is_virtual: row.product_is_virtual,
      no_refund_after_pay: row.product_no_refund_after_pay,
      freight_template: row.product_freight_template,
      delivery_methods: row.product_delivery_methods,
      vip_enabled: row.product_vip_enabled,
      created_at: row.product_created_at
    }) : null,
    start_at: row.start_at,
    end_at: row.end_at,
    hide_time: bool(row.hide_time),
    stock: Number(row.stock || 0),
    sold_count: Number(row.sold_count || 0),
    lead_price: money(row.lead_price),
    settle_price: money(row.settle_price),
    per_user_limit: Number(row.per_user_limit || 0),
    per_order_limit: Number(row.per_order_limit || 0),
    delivery_methods: parseJson(row.delivery_methods, ["express"]),
    free_shipping: bool(row.free_shipping),
    show_store_address: bool(row.show_store_address),
    verify_at_order_store: bool(row.verify_at_order_store),
    member_tag: row.member_tag || "",
    post_pay_address: bool(row.post_pay_address),
    relation_mode: row.relation_mode,
    relation_mode_text: modeText[row.relation_mode] || row.relation_mode,
    default_inviter_id: row.default_inviter_id,
    reward_issue_way: row.reward_issue_way,
    reward_permission: row.reward_permission,
    reward_rule: row.reward_rule,
    reward_level1: money(row.reward_level1),
    reward_level2: money(row.reward_level2),
    direct_pay_way: row.direct_pay_way || "wechat_balance",
    reward_multiple_enabled: bool(row.reward_multiple_enabled),
    reward_step_enabled: bool(row.reward_step_enabled),
    team_reward_enabled: bool(row.team_reward_enabled),
    team_reward_level1: money(row.team_reward_level1),
    team_reward_level2: money(row.team_reward_level2),
    lottery_enabled: bool(row.lottery_enabled),
    lottery_config: parseJson(row.lottery_config, {}),
    qrcode_guide_image: row.qrcode_guide_image || "",
    team_qrcode_enabled: bool(row.team_qrcode_enabled),
    team_qrcode_types: parseJson(row.team_qrcode_types, ["personal", "group"]),
    traffic_config: parseJson(row.traffic_config, {}),
    share_cover: row.share_cover || "",
    share_description: row.share_description || "",
    share_timeline_text: row.share_timeline_text || "",
    customer_service_qrcode: row.customer_service_qrcode || "",
    background_music: row.background_music || "",
    poster_config: parseJson(row.poster_config, []),
    form_schema: activityFormSchema(row.form_schema),
    virtual_sold_count: Number(row.virtual_sold_count || 0),
    virtual_share_count: Number(row.virtual_share_count || 0),
    virtual_browse_count: Number(row.virtual_browse_count || 0),
    virtual_invite_count: Number(row.virtual_invite_count || 0),
    virtual_rankings: parseJson(row.virtual_rankings, []),
    status: row.status,
    status_text: statusText[row.status] || row.status,
    qrcode_count: Number(row.qrcode_count || 0),
    relation_count: Number(row.relation_count || 0),
    order_count: Number(row.order_count || 0),
    reward_total: money(row.reward_total || 0),
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function qrcodeRow(row) {
  return {
    id: row.id,
    campaign_id: row.campaign_id,
    type: row.type,
    type_text: row.type === "group" ? "群二维码" : "个人二维码",
    name: row.name,
    image_url: row.image_url || "",
    poster_bg: row.poster_bg || "",
    poster_position: parseJson(row.poster_position, {}),
    expires_at: row.expires_at,
    show_limit: Number(row.show_limit || 0),
    shown_count: Number(row.shown_count || 0),
    is_default_template: bool(row.is_default_template),
    status: row.status,
    status_text: statusText[row.status] || row.status,
    created_at: row.created_at
  };
}

function materialRow(row) {
  const typeText = {
    qrcode_bg: "引流码背景",
    share_poster: "分享海报",
    share_cover: "小程序分享封面"
  };
  return {
    id: row.id,
    type: row.type,
    type_text: typeText[row.type] || row.type,
    image_url: row.image_url || "",
    style_config: parseJson(row.style_config, {}),
    sort_order: Number(row.sort_order || 0),
    created_at: row.created_at
  };
}

function orderRow(row) {
  const order = {
    id: row.id,
    user_id: row.user_id,
    product_id: row.product_id,
    quantity: row.quantity,
    amount: money(row.amount),
    status: row.status,
    pay_provider: row.pay_provider || "",
    out_trade_no: row.out_trade_no || "",
    transaction_id: row.transaction_id || "",
    address: row.address,
    address_id: row.address_id || null,
    logistics_no: row.logistics_no || "",
    created_at: row.created_at,
    paid_at: row.paid_at,
    received_at: row.received_at,
    status_text: statusText[row.status] || row.status,
    product: row.product_title ? publicProduct({
      id: row.product_id,
      title: row.product_title,
      subtitle: row.product_subtitle,
      product_no: row.product_no,
      barcode: row.product_barcode,
      category: row.product_category,
      brand: row.product_brand,
      unit: row.product_unit,
      market_price: row.product_market_price,
      price: row.product_price,
      cost_price: row.product_cost_price,
      stock: row.product_stock,
      sales: row.product_sales,
      status: row.product_status,
      commission_rate: row.product_commission_rate,
      image_url: row.product_image_url,
      images_json: row.product_images_json,
      detail_html: row.product_detail_html,
      description: row.product_description,
      weight: row.product_weight,
      min_buy_qty: row.product_min_buy_qty,
      per_order_limit: row.product_per_order_limit,
      per_user_limit: row.product_per_user_limit,
      is_virtual: row.product_is_virtual,
      no_refund_after_pay: row.product_no_refund_after_pay,
      freight_template: row.product_freight_template,
      delivery_methods: row.product_delivery_methods,
      vip_enabled: row.product_vip_enabled,
      created_at: row.product_created_at
    }) : null,
    user: row.user_nickname ? {
      id: row.user_id,
      openid: row.user_openid,
      phone: row.user_phone || "",
      nickname: row.user_nickname,
      avatar: row.user_avatar || "",
      parent_id: row.user_parent_id,
      first_parent_id: row.user_first_parent_id || row.user_parent_id || null,
      distributor_status: row.user_distributor_status,
      created_at: row.user_created_at
    } : null
  };
  return order;
}

function addressRow(row) {
  const fullAddress = [
    row.province,
    row.city,
    row.district,
    row.detail
  ].filter(Boolean).join("");
  return {
    id: row.id,
    user_id: row.user_id,
    receiver_name: row.receiver_name || "",
    phone: row.phone || "",
    province: row.province || "",
    city: row.city || "",
    district: row.district || "",
    detail: row.detail || "",
    full_address: fullAddress,
    display_text: [row.receiver_name, row.phone, fullAddress].filter(Boolean).join(" "),
    is_default: bool(row.is_default),
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function commissionRow(row) {
  const levelText = {
    1: "一级购买奖励",
    2: "二级购买奖励",
    11: "直属团队长奖励",
    12: "间推团队长奖励",
    21: "倍数额外奖励",
    22: "阶梯额外奖励"
  }[Number(row.level)] || `${row.level} 级奖励`;
  return {
    id: row.id,
    order_id: row.order_id,
    beneficiary_id: row.beneficiary_id,
    buyer_id: row.buyer_id,
    level: row.level,
    level_text: levelText,
    amount: money(row.amount),
    status: row.status,
    created_at: row.created_at,
    available_at: row.available_at,
    status_text: statusText[row.status] || row.status,
    order: row.order_amount ? {
      id: row.order_id,
      amount: money(row.order_amount),
      status: row.order_status,
      created_at: row.order_created_at
    } : null,
    product: row.product_title ? publicProduct({
      id: row.product_id,
      title: row.product_title,
      subtitle: row.product_subtitle,
      product_no: row.product_no,
      barcode: row.product_barcode,
      category: row.product_category,
      brand: row.product_brand,
      unit: row.product_unit,
      market_price: row.product_market_price,
      price: row.product_price,
      cost_price: row.product_cost_price,
      stock: row.product_stock,
      sales: row.product_sales,
      status: row.product_status,
      commission_rate: row.product_commission_rate,
      image_url: row.product_image_url,
      images_json: row.product_images_json,
      detail_html: row.product_detail_html,
      description: row.product_description,
      weight: row.product_weight,
      min_buy_qty: row.product_min_buy_qty,
      per_order_limit: row.product_per_order_limit,
      per_user_limit: row.product_per_user_limit,
      is_virtual: row.product_is_virtual,
      no_refund_after_pay: row.product_no_refund_after_pay,
      freight_template: row.product_freight_template,
      delivery_methods: row.product_delivery_methods,
      vip_enabled: row.product_vip_enabled,
      created_at: row.product_created_at
    }) : null,
    buyer: row.buyer_nickname ? {
      id: row.buyer_id,
      nickname: row.buyer_nickname,
      phone: row.buyer_phone || "",
      avatar: row.buyer_avatar || ""
    } : null,
    beneficiary: row.beneficiary_nickname ? {
      id: row.beneficiary_id,
      nickname: row.beneficiary_nickname,
      phone: row.beneficiary_phone || "",
      avatar: row.beneficiary_avatar || ""
    } : null
  };
}

module.exports = {
  statusText,
  money,
  parseJson,
  publicProduct,
  campaignRow,
  qrcodeRow,
  materialRow,
  orderRow,
  addressRow,
  commissionRow
};
