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
const qtyInput = document.getElementById("qtyInput");
const slInput = document.getElementById("slInput");
const tpInput = document.getElementById("tpInput");
const feeInput = document.getElementById("feeInput");
const costVal = document.getElementById("costVal");
const randomBtn = document.getElementById("randomBtn");
const blindChk = document.getElementById("blindChk");
const blindLabel = document.getElementById("blindLabel");
const startTime = document.getElementById("startTime");
const startAtBtn = document.getElementById("startAtBtn");
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
let endedNormally = false;   // 是否為正常播完（非意外斷線）
let pendingPlay = false;     // 重新連線後是否自動播放
let pendingSeekTime = null;  // 重新連線後跳到的起始 epoch 秒
let historyBeforeEpoch = null; // 「從此開始」要先畫的前段歷史 K 截止 epoch
let blind = false;           // 盲測：隱藏日期

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
  checkAutoExit();
  refreshPnl();
}

let curProduct = null, curDate = null;

function startReplay(product, date) {
  curProduct = product; curDate = date;
  if (ws) ws.close();
  candleSeries.setData([]);
  volumeSeries.setData([]);
  received = 0; total = 0; playing = false; curBar = null; endedNormally = false;
  playBtn.textContent = "▶ 播放";

  pointValue = POINT_VALUE[product] || 200;
  ptNote.textContent = `${product}　每點 ${pointValue} 元 / 口`;
  if (!feeInput.value) feeInput.value = FEE_DEFAULT[product] ?? 30;
  resetTrades();

  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws/replay/${product}/${date}`);

  ws.onopen = async () => {
    setStatus("已連線，按播放開始");
    send({ cmd: "speed", value: SPEEDS[speedIdx] });   // 同步初始速度給後端
    if (historyBeforeEpoch != null) {
      await loadHistoryBefore(product, date, historyBeforeEpoch);  // 先畫前段歷史背景
      historyBeforeEpoch = null;
    }
    if (pendingSeekTime != null) {
      send({ cmd: "seek_time", time: pendingSeekTime });
      pendingSeekTime = null;
    }
    if (pendingPlay) {
      pendingPlay = false;
      playing = true; playBtn.textContent = "⏸ 暫停";
      send({ cmd: "play" });
    }
  };
  ws.onclose = () => { if (!endedNormally) setStatus("連線關閉"); };
  ws.onerror = () => setStatus("連線錯誤");
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.type === "meta") {
      total = m.total;
      setStatus(`${blind ? "？？？" : m.date} ${m.product}　共 ${total.toLocaleString()} 筆 tick`);
    } else if (m.type === "tick") {
      applyTick(m.data);
      received++;
      if (received % 50 === 0 || received === total) {
        const px = m.data.price;
        setStatus(`${received.toLocaleString()} / ${total.toLocaleString()} 筆　現價 ${px}`);
      }
    } else if (m.type === "end") {
      endedNormally = true;
      setStatus(`回放結束（${received.toLocaleString()} 筆 tick）— 按播放可重看本日`);
      playing = false; playBtn.textContent = "▶ 播放";
    } else if (m.type === "error") {
      setStatus("錯誤：" + m.msg);
    }
  };
}

// ---- 控制 ----
playBtn.onclick = () => {
  // 連線已結束（播完）→ 重新連線並自動從頭播放本日
  if (!ws || ws.readyState > WebSocket.OPEN) {
    if (curProduct && curDate) { pendingPlay = true; startReplay(curProduct, curDate); }
    return;
  }
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
const FEE_DEFAULT = { TX: 30, MTX: 15, TMF: 5 };     // 預設每口每邊手續費(元)，可自行調整
const TAX_RATE = 0.00002;                            // 股價類期貨交易稅率（每邊）
let pointValue = 200;
let lastPrice = null;
let lastTime = null;
let pos = { qty: 0, avg: 0, openCostPerLot: 0 };   // qty>0 多單、<0 空單；avg 進場均價；每口開倉成本
let realized = 0;               // 已實現損益（毛，NT$）
let costs = 0;                  // 累計手續費＋交易稅
let fills = [];                 // 每筆成交紀錄
let markers = [];               // 圖上進出場標記

function resetTrades() {
  lastPrice = null;
  lastTime = null;
  pos = { qty: 0, avg: 0, openCostPerLot: 0 };
  realized = 0;
  costs = 0;
  fills = [];
  markers = [];
  candleSeries.setMarkers([]);
  rebuildLog();
  refreshPnl();
  refreshStats();
}

function orderQty() {
  return Math.max(1, Math.floor(Number(qtyInput.value) || 1));
}

// delta：帶正負號的口數（買進 +1、賣出 −1、平倉 −pos.qty）
function trade(delta) {
  if (lastPrice == null || delta === 0) return;
  const price = lastPrice;
  const qty = Math.abs(delta);

  // 成本：手續費（每口每邊）＋ 交易稅（合約值 × 稅率）
  const fee = (Number(feeInput.value) || 0) * qty;
  const tax = Math.round(price * pointValue * TAX_RATE) * qty;
  const fillCost = fee + tax;
  const costPerLot = fillCost / qty;
  costs += fillCost;

  let pnl = 0;          // 此筆「淨」實現損益（扣平倉＋對應開倉成本）
  let isClose = false;
  if (pos.qty === 0 || Math.sign(pos.qty) === Math.sign(delta)) {
    // 同方向加碼 → 重算加權均價與每口開倉成本
    const absOld = Math.abs(pos.qty), newQty = pos.qty + delta, absNew = Math.abs(newQty);
    pos.avg = (pos.avg * absOld + price * qty) / absNew;
    pos.openCostPerLot = (pos.openCostPerLot * absOld + costPerLot * qty) / absNew;
    pos.qty = newQty;
  } else {
    // 反向 → 就重疊部分實現損益（淨額：毛 − 平倉成本 − 對應開倉成本），必要時反手
    const closeQty = Math.min(qty, Math.abs(pos.qty));
    isClose = true;
    const gross = (price - pos.avg) * Math.sign(pos.qty) * closeQty * pointValue;
    pnl = gross - costPerLot * closeQty - pos.openCostPerLot * closeQty;
    realized += gross;   // realized 記毛；headline 用 realized - costs
    pos.qty += delta;
    if (pos.qty === 0) { pos.avg = 0; pos.openCostPerLot = 0; }
    else if (Math.sign(pos.qty) === Math.sign(delta)) {
      pos.avg = price; pos.openCostPerLot = costPerLot;   // 反手後新倉
    }
  }

  const fill = { seq: fills.length + 1, time: lastTime,
                 side: delta > 0 ? "買" : "賣", price, qty, pnl, cost: fillCost, isClose };
  fills.push(fill);
  prependLogRow(fill);
  addMarker(fill);
  refreshPnl();
  refreshStats();
}

function flatten() { if (pos.qty !== 0) trade(-pos.qty); }

// 觸價自動平倉（停損/停利以「距進場點數」設定）
function checkAutoExit() {
  if (pos.qty === 0 || lastPrice == null) return;
  const dir = Math.sign(pos.qty);
  const sl = Number(slInput.value), tp = Number(tpInput.value);
  if (sl > 0) {
    const stop = pos.avg - dir * sl;
    if ((dir > 0 && lastPrice <= stop) || (dir < 0 && lastPrice >= stop)) {
      flatten(); setStatus("觸發停損，已平倉"); return;
    }
  }
  if (tp > 0) {
    const target = pos.avg + dir * tp;
    if ((dir > 0 && lastPrice >= target) || (dir < 0 && lastPrice <= target)) {
      flatten(); setStatus("觸發停利，已平倉");
    }
  }
}

// 在 K 棒上標記進出場（買=紅上箭、賣=綠下箭）
function addMarker(fill) {
  markers.push({
    time: fill.time - (fill.time % 60),
    position: fill.side === "買" ? "belowBar" : "aboveBar",
    color: fill.side === "買" ? "#ef5350" : "#26a69a",
    shape: fill.side === "買" ? "arrowUp" : "arrowDown",
    text: `${fill.side}${fill.qty}`,
  });
  markers.sort((a, b) => a.time - b.time);   // markers 需時間遞增
  candleSeries.setMarkers(markers);
}

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
  const realizedNet = realized - costs;
  const tot = realizedNet + upl;
  uplVal.textContent = fmtNT(upl); uplVal.className = pnlClass(upl);
  rplVal.textContent = fmtNT(realizedNet); rplVal.className = pnlClass(realizedNet);
  costVal.textContent = costs ? "-" + Math.round(costs).toLocaleString() : "0";
  costVal.className = costs ? "down" : "";
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
  const closed = fills.filter(f => f.isClose);   // 有平倉的成交＝完成一筆交易（pnl 已是淨額）
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
    realized: realized - costs, costs, unrealized: upl, total: realized - costs + upl,
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
  const pnlCell = f.isClose
    ? `<span class="${pnlClass(f.pnl)}">${fmtNT(f.pnl)}</span>` : "—";
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

buyBtn.onclick = () => trade(+orderQty());
sellBtn.onclick = () => trade(-orderQty());
flatBtn.onclick = () => flatten();

// 鍵盤：B 買、S 賣、F 平倉、空白鍵 播放/暫停
document.addEventListener("keydown", (e) => {
  if (e.target.tagName === "SELECT" || e.target.tagName === "INPUT") return;
  const k = e.key.toLowerCase();
  if (k === "b") trade(+orderQty());
  else if (k === "s") trade(-orderQty());
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

// ---- 隨機盲測 / 指定起始時間 ----
function applyBlind() {
  dateSel.style.display = blind ? "none" : "";
  blindLabel.style.display = blind ? "" : "none";
}
blindChk.onchange = () => { blind = blindChk.checked; applyBlind(); };

randomBtn.onclick = () => {
  const dates = datesByProduct[productSel.value] || [];
  if (!dates.length) return;
  // 隨機練習自動進入盲測：隱藏日期，避免看到是哪天
  blind = true;
  blindChk.checked = true;
  applyBlind();
  const d = dates[Math.floor(Math.random() * dates.length)];
  dateSel.value = d;
  startReplay(productSel.value, d);
};

// 載入起始時間「之前」的 1 分 K 當靜態背景
async function loadHistoryBefore(product, date, epoch) {
  let bars = [];
  try { bars = await (await fetch(`/api/bars/${product}/${date}`)).json(); }
  catch (e) { return; }
  const prior = bars.filter(b => b.time < epoch);
  if (!prior.length) return;
  candleSeries.setData(prior.map(b => ({
    time: b.time, open: b.open, high: b.high, low: b.low, close: b.close })));
  volumeSeries.setData(prior.map(b => ({
    time: b.time, value: b.volume,
    color: b.close >= b.open ? "#ef535055" : "#26a69a55" })));
  curBar = null;                      // 之後的 live tick 從起始時間開新棒
  lastPrice = prior[prior.length - 1].close;   // 現價先顯示前段收盤
  refreshPnl();
}

startAtBtn.onclick = () => {
  if (!curProduct || !curDate || !startTime.value) return;
  const [hh, mm] = startTime.value.split(":").map(Number);
  const [Y, Mo, D] = curDate.split("-").map(Number);
  // 牆鐘當 UTC，與 K 棒 time 一致
  const epoch = Math.floor(Date.UTC(Y, Mo - 1, D, hh, mm, 0) / 1000);
  historyBeforeEpoch = epoch;         // 先畫此時間之前的歷史
  pendingSeekTime = epoch;            // 再從此時間開始逐筆
  pendingPlay = true;
  startReplay(curProduct, curDate);   // 重連並清空
};

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
