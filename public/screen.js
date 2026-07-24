const $ = selector => document.querySelector(selector);

const screenState = {
  audioUrl: "",
  audioManuallyPaused: false
};

function formatMoney(value) {
  return Number(value || 0).toFixed(2);
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
  return `${String(days).padStart(2, "0")}天${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function resolveAssetUrl(url) {
  const source = String(url || "").trim();
  if (!source) return "";
  try {
    return new URL(source, window.location.origin).href;
  } catch {
    return source;
  }
}

function isImageAvatar(value) {
  const source = String(value || "").trim();
  return /^(https?:\/\/|data:image\/|\/(?:uploads|generated|assets)\/)/.test(source);
}

function avatarNode(user = {}) {
  const avatar = String(user.avatar || user.avatar_url || "").trim();
  if (isImageAvatar(avatar)) {
    return `<img src="${escapeHtml(resolveAssetUrl(avatar))}" alt="${escapeHtml(user.nickname || "用户")}" />`;
  }
  const text = Array.from(user.nickname || avatar || "访").slice(0, 1).join("") || "访";
  return `<span>${escapeHtml(text)}</span>`;
}

const splitBuckets = [
  ">50人",
  "41-50人",
  "31-40人",
  "21-30人",
  "11-20人",
  "6-10人",
  "1-5人"
];

function normalizeSplitBucket(value) {
  const text = String(value || "").replace(/\s+/g, "");
  if (/^>?\s*50/.test(text) || text.includes(">50")) return ">50人";
  const range = text.match(/(\d+)\D+(\d+)/);
  if (!range) return "";
  return `${range[1]}-${range[2]}人`;
}

function splitScaleMax(counts) {
  const maxCount = Math.max(50, ...counts.map(count => Number(count || 0)));
  const step = Math.max(10, Math.ceil(maxCount / 5 / 10) * 10);
  return step * 5;
}

function renderSplitAnalysis(rows = []) {
  const countByBucket = new Map();
  rows.forEach(row => {
    const bucket = normalizeSplitBucket(row.bucket);
    if (!bucket) return;
    countByBucket.set(bucket, (countByBucket.get(bucket) || 0) + Number(row.count || 0));
  });
  const chartRows = splitBuckets.map(bucket => ({
    bucket,
    count: countByBucket.get(bucket) || 0
  }));
  const max = splitScaleMax(chartRows.map(row => row.count));
  const ticks = Array.from({ length: 6 }, (_, index) => Math.round(max / 5 * index));

  return `
    <div class="battle-split-chart">
      <div class="battle-split-grid" aria-hidden="true">
        ${ticks.map(tick => `<i style="left:${tick / max * 100}%"></i>`).join("")}
      </div>
      <div class="battle-split-rows">
        ${chartRows.map(row => `
          <div class="battle-split-row">
            <span>${escapeHtml(row.bucket)}</span>
            <b title="${escapeHtml(row.bucket)}：${row.count}">
              <i style="width:${Math.min(100, Math.max(0, row.count / max * 100))}%"></i>
            </b>
          </div>
        `).join("")}
      </div>
      <div class="battle-split-axis" aria-hidden="true">
        ${ticks.map(tick => `<span style="left:${tick / max * 100}%">${tick}</span>`).join("")}
      </div>
    </div>
  `;
}

async function api(path) {
  const response = await fetch(path, { headers: { "Content-Type": "application/json" } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) throw new Error(payload.error || "请求失败");
  return payload.data;
}

function renderStats(target, rows) {
  target.innerHTML = rows.map(([label, value]) => `
    <div>
      <span>${escapeHtml(label)}:</span>
      <strong>${escapeHtml(value)}</strong>
    </div>
  `).join("");
}

function setAudioButtonState(playing) {
  const button = $("#screen-audio-toggle");
  if (!button) return;
  button.classList.toggle("playing", Boolean(playing));
  button.setAttribute("aria-label", playing ? "暂停背景音频" : "播放背景音频");
}

async function playScreenAudio() {
  const audio = $("#screen-audio");
  const button = $("#screen-audio-toggle");
  if (!audio || !screenState.audioUrl) return;
  button?.classList.remove("hidden");
  try {
    await audio.play();
    setAudioButtonState(true);
  } catch {
    setAudioButtonState(false);
  }
}

function applyScreenAudio(url) {
  const audio = $("#screen-audio");
  const button = $("#screen-audio-toggle");
  const nextUrl = resolveAssetUrl(url);
  if (!audio || !button) return;
  if (!nextUrl) {
    audio.removeAttribute("src");
    screenState.audioUrl = "";
    button.classList.add("hidden");
    return;
  }
  button.classList.remove("hidden");
  if (screenState.audioUrl !== nextUrl) {
    screenState.audioUrl = nextUrl;
    audio.src = nextUrl;
    audio.volume = 0.62;
    audio.load();
    screenState.audioManuallyPaused = false;
  }
  if (!screenState.audioManuallyPaused && audio.paused) {
    playScreenAudio();
  }
}

function initScreenControls() {
  const audio = $("#screen-audio");
  const audioButton = $("#screen-audio-toggle");
  audioButton?.addEventListener("click", () => {
    if (!audio || !screenState.audioUrl) return;
    if (audio.paused) {
      screenState.audioManuallyPaused = false;
      playScreenAudio();
    } else {
      screenState.audioManuallyPaused = true;
      audio.pause();
      setAudioButtonState(false);
    }
  });
  audio?.addEventListener("play", () => setAudioButtonState(true));
  audio?.addEventListener("pause", () => setAudioButtonState(false));
  $("#screen-fullscreen")?.addEventListener("click", () => {
    if (document.fullscreenElement) {
      document.exitFullscreen?.();
      return;
    }
    document.documentElement.requestFullscreen?.();
  });
}

function renderScreen(screen) {
  const campaign = screen.campaign || {};
  window.currentScreenCountdownTo = screen.countdown_to || null;
  $("#battle-title").textContent = screen.title || "活动作战大屏";
  $("#battle-campaign-name").textContent = campaign.name || "全店经营数据";
  $("#battle-countdown").textContent = countdownLabel(screen.countdown_to);
  $("#battle-entry-title").textContent = `正在浏览(${screen.online_count || 0}人)`;
  $("#battle-order-title").textContent = `最近下单(${screen.order_count || 0}人)`;

  const stats = [
    ["浏览量", screen.browse_count || 0],
    ["浏览人数", screen.visitor_count || 0],
    ["下单数量", screen.order_count || 0],
    ["下单人数", screen.buyer_count || 0],
    ["分享人数", screen.share_count || 0],
    ["获客数量", screen.award_count || 0],
    ["抽奖奖励", formatMoney(screen.lottery_reward || 0)],
    ["推广奖励", formatMoney(screen.promotion_reward || 0)]
  ];
  renderStats($("#battle-stats-left"), stats.slice(0, 4));
  renderStats($("#battle-stats-right"), stats.slice(4));

  const entries = screen.online_users || [];
  $("#battle-recent-entries").innerHTML = `
    <div class="battle-table-head"><span>会员昵称</span><span>邀请人</span><span>所属团队</span><span>最后心跳</span></div>
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
    <div class="battle-table-head"><span>会员昵称</span><span>邀请人</span><span>所属团队</span><span>下单时间</span></div>
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

  $("#battle-split-analysis").innerHTML = renderSplitAnalysis(screen.split_analysis || []);

  applyScreenAudio(screen.audio_url);
}

async function loadScreen() {
  const query = new URLSearchParams(window.location.search);
  const screen = await api(`/api/screen/dashboard${query.toString() ? `?${query.toString()}` : ""}`);
  renderScreen(screen);
}

initScreenControls();

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
