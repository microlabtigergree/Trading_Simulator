// 台指期 1分K 回放前端：Lightweight Charts + WebSocket
const chartEl = document.getElementById("chart");
const chart = LightweightCharts.createChart(chartEl, {
  layout: { background: { color: "#131722" }, textColor: "#d1d4dc" },
  grid: { vertLines: { color: "#1e222d" }, horzLines: { color: "#1e222d" } },
  timeScale: { timeVisible: true, secondsVisible: false, borderColor: "#2a2e39" },
  rightPriceScale: { borderColor: "#2a2e39" },
  crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
});

// 台股慣例：紅漲綠跌
const candleSeries = chart.addCandlestickSeries({
  upColor: "#ef5350", downColor: "#26a69a",
  borderUpColor: "#ef5350", borderDownColor: "#26a69a",
  wickUpColor: "#ef5350", wickDownColor: "#26a69a",
});
const volumeSeries = chart.addHistogramSeries({
  priceFormat: { type: "volume" }, priceScaleId: "vol",
});
chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });

window.addEventListener("resize", () => {
  chart.resize(chartEl.clientWidth, chartEl.clientHeight);
});

// ---- DOM ----
const productSel = document.getElementById("productSel");
const dateSel = document.getElementById("dateSel");
const playBtn = document.getElementById("playBtn");
const stepBtn = document.getElementById("stepBtn");
const speedDown = document.getElementById("speedDown");
const speedUp = document.getElementById("speedUp");
const speedVal = document.getElementById("speedVal");
const realBtn = document.getElementById("realBtn");
const statusEl = document.getElementById("status");
const buyBtn = document.getElementById("buyBtn");
const sellBtn = document.getElementById("sellBtn");
const flatBtn = document.getElementById("flatBtn");
const pxVal = document.getElementById("pxVal");
const posVal = document.getElementById("posVal");
const uplVal = document.getElementById("uplVal");
const rplVal = document.getElementById("rplVal");
const totVal = document.getElementById("totVal");
const ptNote = document.getElementById("ptNote");
const nTradesEl = document.getElementById("nTrades");
const winRateEl = document.getElementById("winRate");
const nWinEl = document.getElementById("nWin");
const nLossEl = document.getElementById("nLoss");
const avgWinEl = document.getElementById("avgWin");
const avgLossEl = document.getElementById("avgLoss");
const profitFactorEl = document.getElementById("profitFactor");
const maxDDEl = document.getElementById("maxDD");
const maxConsecEl = document.getElementById("maxConsec");
const logToggle = document.getElementById("logToggle");
const tradeLog = document.getElementById("tradeLog");
const logTable = document.getElementById("logTable");
const logBody = document.getElementById("logBody");
const logEmpty = document.getElementById("logEmpty");
const saveBtn = document.getElementById("saveBtn");
const historyBtn = document.getElementById("historyBtn");
const histClose = document.getElementById("histClose");
const histClear = document.getElementById("histClear");
const historyModal = document.getElementById("historyModal");
const histSummary = document.getElementById("histSummary");
const histTable = document.getElementById("histTable");
const histBody = document.getElementById("histBody");
const histEmpty = document.getElementById("histEmpty");

let ws = null;
let playing = false;
let received = 0;
let total = 0;

function setStatus(t) { statusEl.textContent = t; }

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

// 由 tick 即時聚合「形成中」的 1 分 K
let curBar = null;   // {time, open, high, low, close, vol}

function applyTick(t) {
  const barTime = t.time - (t.time % 60);   // 分鐘 floor
  if (!curBar || barTime !== curBar.time) {
    // 進入新的一分鐘 → 開新棒
    curBar = { time: barTime, open: t.price, high: t.price,
               low: t.price, close: t.price, vol: t.volume };
  } else {
    curBar.high = Math.max(curBar.high, t.price);
    curBar.low = Math.min(curBar.low, t.price);
    curBar.close = t.price;
    curBar.vol += t.volume;
  }
  candleSeries.update({ time: curBar.time, open: curBar.open,
    high: curBar.high, low: curBar.low, close: curBar.close });
  volumeSeries.update({ time: curBar.time, value: curBar.vol,
    color: curBar.close >= curBar.open ? "#ef535055" : "#26a69a55" });

  lastPrice = t.price;
  lastTime = t.time;
  refreshPnl();
}

let curProduct = null, curDate = null;

function startReplay(product, date) {
  curProduct = product; curDate = date;
  if (ws) ws.close();
  candleSeries.setData([]);
  volumeSeries.setData([]);
  received = 0; total = 0; playing = false; curBar = null;
  playBtn.textContent = "▶ 播放";

  pointValue = POINT_VALUE[product] || 200;
  ptNote.textContent = `${product}　每點 ${pointValue} 元 / 口`;
  resetTrades();

  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws/replay/${product}/${date}`);

  ws.onopen = () => {
    setStatus("已連線，按播放開始");
    send({ cmd: "speed", value: SPEEDS[speedIdx] });   // 同步初始速度給後端
  };
  ws.onclose = () => setStatus("連線關閉");
  ws.onerror = () => setStatus("連線錯誤");
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.type === "meta") {
      total = m.total;
      setStatus(`${m.date} ${m.product}　共 ${total.toLocaleString()} 筆 tick`);
    } else if (m.type === "tick") {
      applyTick(m.data);
      received++;
      if (received % 50 === 0 || received === total) {
        const px = m.data.price;
        setStatus(`${received.toLocaleString()} / ${total.toLocaleString()} 筆　現價 ${px}`);
      }
    } else if (m.type === "end") {
      setStatus(`回放結束（${received.toLocaleString()} 筆 tick）`);
      playing = false; playBtn.textContent = "▶ 播放";
    } else if (m.type === "error") {
      setStatus("錯誤：" + m.msg);
    }
  };
}

// ---- 控制 ----
playBtn.onclick = () => {
  playing = !playing;
  send({ cmd: playing ? "play" : "pause" });
  playBtn.textContent = playing ? "⏸ 暫停" : "▶ 播放";
};
stepBtn.onclick = () => send({ cmd: "step" });

// 速度檔位（加減按鈕在其間切換）
const SPEEDS = [1, 2, 5, 10, 20, 30, 60, 120, 240];
let speedIdx = 0;   // 預設 1x 真實

function applySpeed() {
  const v = SPEEDS[speedIdx];
  speedVal.textContent = v === 1 ? "1x 真實" : v + "x";
  send({ cmd: "speed", value: v });
}
speedDown.onclick = () => { if (speedIdx > 0) { speedIdx--; applySpeed(); } };
speedUp.onclick = () => { if (speedIdx < SPEEDS.length - 1) { speedIdx++; applySpeed(); } };
realBtn.onclick = () => { speedIdx = 0; applySpeed(); };   // 一鍵切真實時間
// ---- 模擬下單 / 損益 ----
const POINT_VALUE = { TX: 200, MTX: 50, TMF: 10 };   // 每點新台幣 / 口（大台 200、小台 50、微台 10）
let pointValue = 200;
let lastPrice = null;
let lastTime = null;
let pos = { qty: 0, avg: 0 };   // qty>0 多單、<0 空單；avg 進場均價
let realized = 0;               // 已實現損益（NT$）
let fills = [];                 // 每筆成交紀錄

function resetTrades() {
  lastPrice = null;
  lastTime = null;
  pos = { qty: 0, avg: 0 };
  realized = 0;
  fills = [];
  rebuildLog();
  refreshPnl();
  refreshStats();
}

// delta：帶正負號的口數（買進 +1、賣出 −1、平倉 −pos.qty）
function trade(delta) {
  if (lastPrice == null || delta === 0) return;
  const price = lastPrice;
  let pnl = 0;   // 此筆成交實現的損益（純加碼為 0）
  if (pos.qty === 0 || Math.sign(pos.qty) === Math.sign(delta)) {
    // 同方向加碼 → 重算加權均價
    const newQty = pos.qty + delta;
    pos.avg = (pos.avg * Math.abs(pos.qty) + price * Math.abs(delta)) / Math.abs(newQty);
    pos.qty = newQty;
  } else {
    // 反向 → 先就重疊部分實現損益，必要時反手
    const closeQty = Math.min(Math.abs(delta), Math.abs(pos.qty));
    pnl = (price - pos.avg) * Math.sign(pos.qty) * closeQty * pointValue;
    realized += pnl;
    pos.qty += delta;
    if (pos.qty === 0) pos.avg = 0;
    else if (Math.sign(pos.qty) === Math.sign(delta)) pos.avg = price;  // 反手後新均價
  }
  const fill = { seq: fills.length + 1, time: lastTime,
                 side: delta > 0 ? "買" : "賣", price, qty: Math.abs(delta), pnl };
  fills.push(fill);
  prependLogRow(fill);
  refreshPnl();
  refreshStats();
}

function flatten() { if (pos.qty !== 0) trade(-pos.qty); }

function fmtNT(v) {
  const s = Math.round(v).toLocaleString();
  return v > 0 ? "+" + s : s;
}
function pnlClass(v) { return v > 0 ? "up" : v < 0 ? "down" : ""; }

function refreshPnl() {
  pxVal.textContent = lastPrice == null ? "—" : lastPrice;
  if (pos.qty === 0) {
    posVal.textContent = "無"; posVal.className = "";
  } else {
    posVal.textContent = `${pos.qty > 0 ? "多" : "空"} ${Math.abs(pos.qty)} 口 @ ${Math.round(pos.avg)}`;
    posVal.className = pos.qty > 0 ? "up" : "down";
  }
  const upl = (lastPrice != null && pos.qty !== 0)
    ? (lastPrice - pos.avg) * pos.qty * pointValue : 0;
  const tot = realized + upl;
  uplVal.textContent = fmtNT(upl); uplVal.className = pnlClass(upl);
  rplVal.textContent = fmtNT(realized); rplVal.className = pnlClass(realized);
  totVal.textContent = fmtNT(tot); totVal.className = pnlClass(tot);
}

// time 以「台北牆鐘當 UTC」存放 → 用 UTC getter 取回顯示
function fmtTime(epoch) {
  if (epoch == null) return "—";
  const d = new Date(epoch * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

// ---- 統計 ----
// 一筆「交易」＝有實現損益的成交（純加碼不計）。回傳所有指標。
function computeStats() {
  const closed = fills.filter(f => f.pnl !== 0);
  const wins = closed.filter(f => f.pnl > 0);
  const losses = closed.filter(f => f.pnl < 0);
  const sum = (arr) => arr.reduce((s, f) => s + f.pnl, 0);
  const grossWin = sum(wins), grossLoss = sum(losses);

  // 依平倉順序累積權益曲線 → 最大回撤 / 最大連續虧損
  let cum = 0, peak = 0, maxDD = 0, streak = 0, maxStreak = 0;
  for (const f of closed) {
    cum += f.pnl;
    peak = Math.max(peak, cum);
    maxDD = Math.max(maxDD, peak - cum);
    if (f.pnl < 0) { streak++; maxStreak = Math.max(maxStreak, streak); }
    else streak = 0;
  }

  const upl = (lastPrice != null && pos.qty !== 0)
    ? (lastPrice - pos.avg) * pos.qty * pointValue : 0;

  return {
    trades: closed.length, wins: wins.length, losses: losses.length,
    winRate: closed.length ? wins.length / closed.length * 100 : null,
    avgWin: wins.length ? grossWin / wins.length : 0,
    avgLoss: losses.length ? grossLoss / losses.length : 0,
    profitFactor: grossLoss < 0 ? grossWin / Math.abs(grossLoss)
                                : (wins.length ? Infinity : null),
    maxDrawdown: maxDD, maxConsecLoss: maxStreak,
    realized, unrealized: upl, total: realized + upl,
  };
}

function refreshStats() {
  const s = computeStats();
  nTradesEl.textContent = s.trades;
  nWinEl.textContent = s.wins;
  nLossEl.textContent = s.losses;
  winRateEl.textContent = s.winRate == null ? "—" : s.winRate.toFixed(0) + "%";
  avgWinEl.textContent = fmtNT(s.avgWin); avgWinEl.className = pnlClass(s.avgWin);
  avgLossEl.textContent = fmtNT(s.avgLoss); avgLossEl.className = pnlClass(s.avgLoss);
  if (s.profitFactor == null) { profitFactorEl.textContent = "—"; profitFactorEl.className = ""; }
  else if (s.profitFactor === Infinity) { profitFactorEl.textContent = "∞"; profitFactorEl.className = "up"; }
  else { profitFactorEl.textContent = s.profitFactor.toFixed(2); profitFactorEl.className = s.profitFactor >= 1 ? "up" : "down"; }
  maxDDEl.textContent = s.maxDrawdown ? "-" + Math.round(s.maxDrawdown).toLocaleString() : "0";
  maxDDEl.className = s.maxDrawdown ? "down" : "";
  maxConsecEl.textContent = s.maxConsecLoss;
  maxConsecEl.className = s.maxConsecLoss ? "down" : "";
}

// ---- 成績存檔 / 歷史 ----
function pct(v) { return v == null ? "—" : v.toFixed(0) + "%"; }

saveBtn.onclick = async () => {
  const s = computeStats();
  if (s.trades === 0 && pos.qty === 0) { setStatus("本場尚無交易，未存檔"); return; }
  const rec = {
    saved_at: new Date().toISOString(),
    replay_date: curDate, product: curProduct,
    trades: s.trades, wins: s.wins, losses: s.losses,
    win_rate: s.winRate,
    realized: Math.round(s.realized), total: Math.round(s.total),
    max_drawdown: Math.round(s.maxDrawdown), max_consec_loss: s.maxConsecLoss,
    profit_factor: (s.profitFactor == null || s.profitFactor === Infinity)
      ? null : +s.profitFactor.toFixed(2),
  };
  try {
    const r = await fetch("/api/session", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(rec),
    });
    const j = await r.json();
    setStatus(`已存檔本場成績（累計 ${j.count} 場）`);
  } catch (e) {
    setStatus("存檔失敗：" + e);
  }
};

historyBtn.onclick = async () => {
  let list = [];
  try { list = await (await fetch("/api/sessions")).json(); }
  catch (e) { setStatus("讀取歷史失敗：" + e); return; }

  histBody.innerHTML = "";
  if (!list.length) {
    histTable.style.display = "none"; histEmpty.style.display = "";
    histSummary.textContent = "";
  } else {
    histTable.style.display = ""; histEmpty.style.display = "none";
    const totalPnl = list.reduce((s, r) => s + (r.total || 0), 0);
    const totalTrades = list.reduce((s, r) => s + (r.trades || 0), 0);
    const totalWins = list.reduce((s, r) => s + (r.wins || 0), 0);
    const overallWin = totalTrades ? totalWins / totalTrades * 100 : null;
    const profitDays = list.filter(r => (r.total || 0) > 0).length;
    histSummary.innerHTML =
      `練習場次 <b>${list.length}</b>　　獲利場次 <b class="up">${profitDays}</b>　　` +
      `累計總損益 <b class="${pnlClass(totalPnl)}">${fmtNT(totalPnl)}</b>　　` +
      `整體勝率 <b>${pct(overallWin)}</b>（${totalWins}/${totalTrades}）`;
    // 最新在最上
    for (const r of [...list].reverse()) {
      const tr = document.createElement("tr");
      const when = (r.saved_at || "").replace("T", " ").slice(0, 16);
      tr.innerHTML =
        `<td>${when}</td><td>${r.replay_date || "—"}</td><td>${r.product || "—"}</td>` +
        `<td>${r.trades ?? 0}</td><td>${pct(r.win_rate)}</td>` +
        `<td class="${pnlClass(r.total)}">${fmtNT(r.total || 0)}</td>` +
        `<td class="down">${r.max_drawdown ? "-" + r.max_drawdown.toLocaleString() : "0"}</td>` +
        `<td>${r.max_consec_loss ?? 0}</td>`;
      histBody.appendChild(tr);
    }
  }
  historyModal.style.display = "flex";
};

histClear.onclick = async () => {
  if (!confirm("確定清除所有歷史練習成績？此動作無法復原。")) return;
  try { await fetch("/api/sessions", { method: "DELETE" }); }
  catch (e) { setStatus("清除失敗：" + e); return; }
  await historyBtn.onclick();   // 重新載入（顯示為空）
  setStatus("已清除歷史成績");
};

histClose.onclick = () => { historyModal.style.display = "none"; };
historyModal.onclick = (e) => { if (e.target === historyModal) historyModal.style.display = "none"; };

// ---- 交易明細表 ----
function prependLogRow(f) {
  logEmpty.style.display = "none";
  logTable.style.display = "";
  const tr = document.createElement("tr");
  const pnlCell = f.pnl === 0 ? "—"
    : `<span class="${pnlClass(f.pnl)}">${fmtNT(f.pnl)}</span>`;
  tr.innerHTML =
    `<td>${f.seq}</td><td>${fmtTime(f.time)}</td>` +
    `<td class="${f.side === "買" ? "act-b" : "act-s"}">${f.side}</td>` +
    `<td>${f.price}</td><td>${f.qty}</td><td>${pnlCell}</td>`;
  logBody.prepend(tr);   // 最新在最上
}

function rebuildLog() {
  logBody.innerHTML = "";
  logTable.style.display = "none";
  logEmpty.style.display = "";
}

logToggle.onclick = () => {
  tradeLog.classList.toggle("show");
  logToggle.textContent = tradeLog.classList.contains("show") ? "交易明細 ▲" : "交易明細 ▼";
  // 側欄開合會改變圖表寬度 → 重新調整
  requestAnimationFrame(() => chart.resize(chartEl.clientWidth, chartEl.clientHeight));
};

buyBtn.onclick = () => trade(+1);
sellBtn.onclick = () => trade(-1);
flatBtn.onclick = () => flatten();

// 鍵盤：B 買、S 賣、F 平倉、空白鍵 播放/暫停
document.addEventListener("keydown", (e) => {
  if (e.target.tagName === "SELECT" || e.target.tagName === "INPUT") return;
  const k = e.key.toLowerCase();
  if (k === "b") trade(+1);
  else if (k === "s") trade(-1);
  else if (k === "f") flatten();
  else if (e.code === "Space") { e.preventDefault(); playBtn.click(); }
});

// ---- 商品 / 日期 兩段式選擇 ----
const PRODUCT_LABEL = { TX: "TX 大台", MTX: "MTX 小台", TMF: "TMF 微台" };
const PRODUCT_ORDER = ["TX", "MTX", "TMF"];
let datesByProduct = {};

function populateDates(product) {
  dateSel.innerHTML = "";
  const dates = (datesByProduct[product] || []).slice().sort().reverse();  // 新到舊
  for (const d of dates) {
    const opt = document.createElement("option");
    opt.value = d; opt.textContent = d;
    dateSel.appendChild(opt);
  }
}

productSel.onchange = () => {
  populateDates(productSel.value);
  startReplay(productSel.value, dateSel.value);
};
dateSel.onchange = () => startReplay(productSel.value, dateSel.value);

// ---- 初始化：載入可回放交易日 ----
fetch("/api/dates").then(r => r.json()).then(list => {
  if (!list.length) { setStatus("data/bars 尚無資料，請先跑 build_bars"); return; }
  datesByProduct = {};
  for (const d of list) (datesByProduct[d.product] ||= []).push(d.date);

  productSel.innerHTML = "";
  const products = PRODUCT_ORDER.filter(p => datesByProduct[p])
    .concat(Object.keys(datesByProduct).filter(p => !PRODUCT_ORDER.includes(p)));
  for (const p of products) {
    const opt = document.createElement("option");
    opt.value = p; opt.textContent = PRODUCT_LABEL[p] || p;
    productSel.appendChild(opt);
  }

  populateDates(productSel.value);
  startReplay(productSel.value, dateSel.value);
});
