const $ = selector => document.querySelector(selector);

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

async function api(path) {
  const response = await fetch(path, { headers: { "Content-Type": "application/json" } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) throw new Error(payload.error || "请求失败");
  return payload.data;
}

function renderScreen(screen) {
  const campaign = screen.campaign || {};
  window.currentScreenCountdownTo = screen.countdown_to || null;
  $("#battle-title").textContent = screen.title || "必火次元作战大屏";
  $("#battle-campaign-name").textContent = campaign.name || "全店经营数据";
  $("#battle-countdown").textContent = countdownLabel(screen.countdown_to);
  $("#battle-entry-title").textContent = `实时在线(${screen.online_count || 0}人)`;
  $("#battle-order-title").textContent = `最近下单(${screen.order_count || 0}人)`;

  $("#battle-stats").innerHTML = [
    ["浏览量", screen.browse_count || 0],
    ["分享人数", screen.share_count || 0],
    ["浏览人数", screen.visitor_count || 0],
    ["获客数量", screen.award_count || 0],
    ["下单数量", screen.order_count || 0],
    ["抽奖奖励", formatMoney(screen.lottery_reward || 0)],
    ["下单人数", screen.buyer_count || 0],
    ["推广奖励", formatMoney(screen.promotion_reward || 0)]
  ].map(([label, value]) => `
    <div>
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
    </div>
  `).join("");

  const entries = screen.online_users || [];
  $("#battle-recent-entries").innerHTML = `
    <div class="battle-table-head"><span>会员昵称</span><span>邀请人</span><span>所属战队</span><span>最后心跳</span></div>
    ${entries.length ? entries.map(row => `
      <div class="battle-table-row">
        <span class="battle-user"><i>${avatarNode(row.member)}</i>${escapeHtml(row.member?.nickname || "-")}</span>
        <span>${escapeHtml(row.inviter || "-")}</span>
        <span>${escapeHtml(row.team || "-")}</span>
        <span>${escapeHtml(compactDateLabel(row.last_seen_at))}</span>
      </div>
    `).join("") : '<div class="battle-empty">暂无实时在线用户</div>'}
  `;

  const orders = screen.recent_orders || [];
  $("#battle-recent-orders").innerHTML = `
    <div class="battle-table-head"><span>会员昵称</span><span>邀请人</span><span>所属战队</span><span>下单时间</span></div>
    ${orders.length ? orders.map(row => `
      <div class="battle-table-row">
        <span class="battle-user"><i>${avatarNode({ nickname: row.member, avatar: row.avatar })}</i>${escapeHtml(row.member || "-")}</span>
        <span>${escapeHtml(row.inviter || "-")}</span>
        <span>${escapeHtml(row.team || "-")}</span>
        <span>${escapeHtml(compactDateLabel(row.created_at))}</span>
      </div>
    `).join("") : '<div class="battle-empty">暂无下单记录</div>'}
  `;

  $("#battle-fan-rank").innerHTML = (screen.fan_rank || []).length ? screen.fan_rank.map(row => `
    <div class="battle-rank-row">
      <span>${row.rank}</span>
      <i>${avatarNode(row)}</i>
      <strong>${escapeHtml(row.nickname)}</strong>
      <em>${row.fans}</em>
    </div>
  `).join("") : '<div class="battle-empty">暂无粉丝排行</div>';

  $("#battle-earning-rank").innerHTML = (screen.earning_rank || []).length ? screen.earning_rank.map(row => `
    <div class="battle-rank-row">
      <span>${row.rank}</span>
      <i>${avatarNode(row)}</i>
      <strong>${escapeHtml(row.nickname)}</strong>
      <em>${formatMoney(row.earnings)}</em>
    </div>
  `).join("") : '<div class="battle-empty">暂无收益排行</div>';

  const splitRows = screen.split_analysis || [];
  const maxSplit = Math.max(1, ...splitRows.map(row => Number(row.count || 0)));
  $("#battle-split-analysis").innerHTML = splitRows.length ? splitRows.map(row => `
    <div class="battle-bar-row">
      <span>${escapeHtml(row.bucket)}</span>
      <b><i style="width:${Math.max(4, Number(row.count || 0) / maxSplit * 100)}%"></i></b>
      <em>${row.count}</em>
    </div>
  `).join("") : '<div class="battle-empty">暂无裂变数据</div>';
}

async function loadScreen() {
  const query = new URLSearchParams(window.location.search);
  const screen = await api(`/api/screen/dashboard${query.toString() ? `?${query.toString()}` : ""}`);
  renderScreen(screen);
}

loadScreen().catch(error => {
  document.body.innerHTML = `<div class="screen-error">${escapeHtml(error.message)}</div>`;
});

setInterval(() => {
  const countdown = $("#battle-countdown");
  if (!countdown) return;
  const current = window.currentScreenCountdownTo;
  if (current) countdown.textContent = countdownLabel(current);
}, 1000);

setInterval(() => {
  loadScreen().catch(() => {});
}, 5000);
