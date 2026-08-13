/**
 * kepco-usage-chart-card
 *
 * 파워플래너의 `사용량/요금현황` 그래프를 Home Assistant 안에서 재구성한다.
 *
 * 데이터는 전부 **이 통합이 이미 쌓아 둔 장기 통계**에서 온다. 한전에 추가로
 * 요청하지 않는다. 통합이 시간별 구간을 실제 소비 시각에 써넣기 때문에
 * 시간대별은 원본 그대로, 일별은 그것을 합산해 정확히 얻어진다.
 *
 * 요금(원)은 **추정치**다. 한전은 구간별 요금을 주지 않으므로, 청구주기 누적량에
 * 따른 누진 단가를 그 시간의 사용량에 적용해 전력량요금만 계산한다. 기본요금·
 * 기후환경요금·연료비조정액·부가세·기금은 월 단위라 시간에 배분할 수 없어 빠진다.
 * 한전 화면도 같은 자리에 "실시간 요금은 예상치"라고 적어 둔다.
 */

const CARD_VERSION = "0.2.1";

console.info(
  `%c KEPCO-USAGE-CHART-CARD %c ${CARD_VERSION} `,
  "color:#fff;background:#0b5cab;font-weight:700",
  "color:#0b5cab;background:#eee"
);

const MODES = {
  hour: { label: "시간대별", period: "hour" },
  day: { label: "일별", period: "day" },
  month: { label: "월별", period: "month" },
};

// 주택용 저압 누진 경계 (kWh). 하계에만 넓어지고, 걸치는 주기는 일할계산한다.
const TIERS_SUMMER = [300, 450];
const TIERS_NORMAL = [200, 400];
const DAY = 86400000;

const DEFAULTS = {
  modes: ["hour", "day"],
  default_mode: "hour",
  hour_window: "today", // today | rolling  (rolling = 최근 24시간)
  days: 30,
  months: 12,
  show_comparison: false,
  show_cost: false,
  chart_type: "line", // line | bar
};

function fmt(n, d = 2) {
  return Number(n).toLocaleString("ko-KR", {
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  });
}

function toDate(v) {
  return typeof v === "number" ? new Date(v) : new Date(v);
}

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function startOfHour(d) {
  const x = new Date(d);
  x.setMinutes(0, 0, 0);
  return x;
}

function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

function addHours(d, n) {
  return new Date(d.getTime() + n * 3600000);
}

function startOfMonth(d) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function addMonths(d, n) {
  return new Date(d.getFullYear(), d.getMonth() + n, 1);
}

function parseDate(s) {
  if (typeof s !== "string") return null;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
}

function overlapDays(a0, a1, b0, b1) {
  const s = Math.max(a0.getTime(), b0.getTime());
  const e = Math.min(a1.getTime(), b1.getTime());
  return e < s ? 0 : Math.round((e - s) / DAY) + 1;
}

/** 검침기간에 맞춘 누진 경계. billing-cycle 카드와 같은 규칙을 쓴다. */
function seasonalTiers(start, end) {
  if (!start || !end || end < start) {
    const m = new Date().getMonth() + 1;
    return (m === 7 || m === 8 ? TIERS_SUMMER : TIERS_NORMAL).slice();
  }
  const total = Math.round((end - start) / DAY) + 1;
  let summer = 0;
  for (let y = start.getFullYear(); y <= end.getFullYear(); y++) {
    summer += overlapDays(start, end, new Date(y, 6, 1), new Date(y, 7, 31));
  }
  const ratio = total > 0 ? summer / total : 0;
  const lerp = (a, b) => Math.round(a + (b - a) * ratio);
  return [lerp(TIERS_NORMAL[0], TIERS_SUMMER[0]), lerp(TIERS_NORMAL[1], TIERS_SUMMER[1])];
}

function fireEvent(node, type, detail) {
  node.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
}

class KepcoUsageChartCard extends HTMLElement {
  static getStubConfig(hass) {
    const entity = Object.keys(hass.states || {}).find(
      (id) => id.startsWith("sensor.") && id.endsWith("_billing_cycle_usage")
    );
    return { entity: entity || "" };
  }

  static async getConfigElement() {
    return document.createElement("kepco-usage-chart-card-editor");
  }

  setConfig(config) {
    if (!config || (!config.entity && !config.statistic_id)) {
      throw new Error("entity 또는 statistic_id 를 지정하세요");
    }
    const cfg = { ...DEFAULTS, ...config };
    cfg.modes = (cfg.modes || []).filter((m) => MODES[m]);
    if (!cfg.modes.length) cfg.modes = ["hour", "day"];
    if (!cfg.modes.includes(cfg.default_mode)) cfg.default_mode = cfg.modes[0];

    this._config = cfg;
    this._mode = cfg.default_mode;
    this._offset = 0;
    this._data = null;
    this._cycleBefore = 0;
    this._loading = false;
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (first) this._load();
  }

  getCardSize() {
    return 6;
  }

  getGridOptions() {
    return { rows: 6, columns: 12, min_rows: 4, min_columns: 6 };
  }

  _statId() {
    if (this._config.statistic_id) return this._config.statistic_id;
    const m = /_(\d{6,})_/.exec(this._config.entity || "");
    return m ? `kepco_smart_meter:${m[1]}_energy` : null;
  }

  /** 요금 계산에 필요한 청구 정보. 엔티티 속성에서 읽는다. */
  _billing() {
    const st = this._hass && this._hass.states[this._config.entity];
    const a = (st && st.attributes) || {};
    const start = parseDate(a.billing_start);
    const end = parseDate(a.billing_end);
    const prices = Array.isArray(a.tier_unit_prices)
      ? a.tier_unit_prices.map(Number).filter((n) => Number.isFinite(n))
      : [];
    return { start, end, prices, tiers: seasonalTiers(start, end) };
  }

  _rolling() {
    return this._mode === "hour" && this._config.hour_window === "rolling";
  }

  /** 지금 모드가 볼 구간 [시작, 끝). */
  _range() {
    const now = new Date();
    if (this._mode === "hour") {
      if (this._rolling()) {
        const end = addHours(startOfHour(now), 1);
        return [addHours(end, -24), end];
      }
      const base = addDays(startOfDay(now), -this._offset);
      return [base, addDays(base, 1)];
    }
    if (this._mode === "day") {
      const end = addDays(startOfDay(now), 1);
      return [addDays(end, -this._config.days), end];
    }
    const end = addMonths(startOfMonth(now), 1);
    return [addMonths(end, -this._config.months), end];
  }

  async _load() {
    const statId = this._statId();
    if (!statId || !this._hass) return;
    this._loading = true;
    this._render();

    const [start, end] = this._range();
    const wantsCompare = this._mode === "hour" && this._config.show_comparison;
    const fetchStart = wantsCompare ? addDays(start, -1) : start;

    try {
      const res = await this._hass.callWS({
        type: "recorder/statistics_during_period",
        start_time: fetchStart.toISOString(),
        end_time: end.toISOString(),
        statistic_ids: [statId],
        period: MODES[this._mode].period,
        types: ["change"],
      });
      const rows = (res && res[statId]) || [];
      this._data = rows.map((r) => ({ t: toDate(r.start), v: Number(r.change) || 0 }));

      // 요금을 그리려면 이 창이 시작되기 전까지의 청구주기 누적량이 필요하다.
      this._cycleBefore = 0;
      const bill = this._billing();
      if (this._config.show_cost && bill.start && bill.start < start) {
        const pre = await this._hass.callWS({
          type: "recorder/statistics_during_period",
          start_time: bill.start.toISOString(),
          end_time: start.toISOString(),
          statistic_ids: [statId],
          period: "day",
          types: ["change"],
        });
        this._cycleBefore = ((pre && pre[statId]) || []).reduce(
          (s, r) => s + (Number(r.change) || 0),
          0
        );
      }
      this._error = null;
    } catch (err) {
      this._data = [];
      this._error = String((err && err.message) || err);
    }
    this._loading = false;
    this._render();
  }

  _slots() {
    const [start, end] = this._range();
    const out = [];
    if (this._mode === "hour") {
      for (let t = new Date(start); t < end; t = addHours(t, 1)) out.push(new Date(t));
    } else if (this._mode === "day") {
      for (let d = new Date(start); d < end; d = addDays(d, 1)) out.push(new Date(d));
    } else {
      for (let d = new Date(start); d < end; d = addMonths(d, 1)) out.push(new Date(d));
    }
    return out;
  }

  /**
   * 누진 구간을 넘어가면 쪼개서 각 구간 단가를 적용한다.
   * 돌려주는 값은 전력량요금 추정치(원)일 뿐, 청구서 총액이 아니다.
   */
  _costOf(kwh, cumBefore, tiers, prices) {
    if (!prices.length || !(kwh > 0)) return null;
    const bounds = [tiers[0], tiers[1], Infinity];
    let cost = 0;
    let left = kwh;
    let at = cumBefore;
    for (let i = 0; i < bounds.length && left > 0; i++) {
      if (at >= bounds[i]) continue;
      const take = Math.min(left, bounds[i] - at);
      cost += take * (prices[Math.min(i, prices.length - 1)] || 0);
      at += take;
      left -= take;
    }
    return cost;
  }

  _series() {
    const [start] = this._range();
    const byKey = new Map((this._data || []).map((p) => [p.t.getTime(), p.v]));
    const slots = this._slots();
    const main = slots.map((t) => ({
      t,
      v: byKey.has(t.getTime()) ? byKey.get(t.getTime()) : null,
    }));

    let compare = null;
    if (this._mode === "hour" && this._config.show_comparison) {
      compare = slots.map((t) => {
        const prev = addDays(t, -1).getTime();
        return { t, v: byKey.has(prev) ? byKey.get(prev) : null };
      });
      if (compare.every((p) => p.v == null)) compare = null;
    }

    let cost = null;
    if (this._config.show_cost && this._mode === "hour") {
      const { tiers, prices } = this._billing();
      let cum = this._cycleBefore;
      cost = main.map((p) => {
        if (p.v == null) return { t: p.t, v: null };
        const c = this._costOf(p.v, cum, tiers, prices);
        cum += p.v;
        return { t: p.t, v: c };
      });
      if (cost.every((p) => p.v == null)) cost = null;
    }

    let labels;
    if (this._mode === "hour") {
      // 파워플래너 표기와 같다: `NN시` 는 그 시각에 끝나는 한 시간이다.
      labels = (d) => `${((d.getHours() + 1) % 24) || 24}`;
    } else if (this._mode === "day") {
      labels = (d) => `${d.getMonth() + 1}/${d.getDate()}`;
    } else {
      labels = (d) => `${d.getMonth() + 1}월`;
    }
    return { main, compare, cost, labels, start };
  }

  _render() {
    const root = this.shadowRoot;
    const cfg = this._config;

    const chips = cfg.modes
      .map(
        (m) =>
          `<button class="chip ${m === this._mode ? "on" : ""}" data-mode="${m}">${MODES[m].label}</button>`
      )
      .join("");

    let body;
    if (!this._statId()) {
      body = `<div class="empty">통계를 찾을 수 없습니다. entity 나 statistic_id 를 확인하세요.</div>`;
    } else if (this._loading) {
      body = `<div class="empty">불러오는 중…</div>`;
    } else if (this._error) {
      body = `<div class="empty">통계 조회 실패: ${this._error}</div>`;
    } else {
      body = this._chart();
    }

    const canNav = this._mode === "hour" && !this._rolling();
    const nav = canNav
      ? `<div class="nav">
           <button class="navbtn" data-nav="-1" title="이전 날">‹</button>
           <span class="navlabel">${this._navLabel()}</span>
           <button class="navbtn" data-nav="1" ${this._offset === 0 ? "disabled" : ""} title="다음 날">›</button>
         </div>`
      : `<div class="nav"><span class="navlabel">${this._navLabel()}</span></div>`;

    root.innerHTML = `${this._style()}
      <ha-card>
        <div class="head">
          <div class="title">${cfg.name || "사용량 현황"}</div>
          <div class="chips">${chips}</div>
        </div>
        ${nav}
        ${body}
      </ha-card>`;

    root.querySelectorAll(".chip").forEach((b) =>
      b.addEventListener("click", () => {
        if (b.dataset.mode === this._mode) return;
        this._mode = b.dataset.mode;
        this._offset = 0;
        this._load();
      })
    );
    root.querySelectorAll(".navbtn").forEach((b) =>
      b.addEventListener("click", () => {
        const next = this._offset - Number(b.dataset.nav);
        if (next < 0) return;
        this._offset = next;
        this._load();
      })
    );
    this._wireTooltip();
  }

  _navLabel() {
    const [start] = this._range();
    if (this._mode === "hour") {
      if (this._rolling()) return "최근 24시간";
      if (this._offset === 0) return "오늘";
      if (this._offset === 1) return "어제";
      return `${start.getFullYear()}. ${start.getMonth() + 1}. ${start.getDate()}.`;
    }
    if (this._mode === "day") return `최근 ${this._config.days}일`;
    return `최근 ${this._config.months}개월`;
  }

  _chart() {
    const { main, compare, cost, labels } = this._series();
    const filled = main.filter((p) => p.v != null);
    if (!filled.length) {
      return `<div class="empty">이 기간에는 기록된 사용량이 없습니다.</div>`;
    }

    const hasCost = !!cost;
    const W = 620, H = 250;
    const padL = 44, padR = hasCost ? 46 : 12, padT = 12, padB = 30;
    const iw = W - padL - padR;
    const ih = H - padT - padB;

    const all = filled
      .map((p) => p.v)
      .concat(compare ? compare.filter((p) => p.v != null).map((p) => p.v) : []);
    const rawMax = Math.max(...all, 0.001);
    const step = Math.pow(10, Math.floor(Math.log10(rawMax))) / 2;
    const max = Math.ceil(rawMax / step) * step;

    const costVals = hasCost ? cost.filter((p) => p.v != null).map((p) => p.v) : [];
    const costMax = costVals.length ? Math.max(...costVals) * 1.05 : 1;

    const n = main.length;
    const bw = iw / n;
    const x = (i) => padL + bw * i;
    const y = (v) => padT + ih - (v / max) * ih;
    const yc = (v) => padT + ih - (v / costMax) * ih;

    const ticks = [0, 0.25, 0.5, 0.75, 1];
    const grid = ticks
      .map((f) => {
        const v = max * f;
        const yy = y(v).toFixed(1);
        const right = hasCost
          ? `<text class="ytick right" x="${W - padR + 6}" y="${(y(v) + 3).toFixed(1)}">${Math.round(costMax * f).toLocaleString("ko-KR")}</text>`
          : "";
        return `<line class="grid" x1="${padL}" x2="${W - padR}" y1="${yy}" y2="${yy}"/>
                <text class="ytick" x="${padL - 6}" y="${(y(v) + 3).toFixed(1)}">${fmt(v, max < 2 ? 2 : 0)}</text>${right}`;
      })
      .join("");

    // 요금은 뒤에 깔리는 회색 막대 (파워플래너와 같은 배치)
    const costBars = hasCost
      ? cost
          .map((p, i) =>
            p.v == null
              ? ""
              : `<rect class="costbar" x="${(x(i) + bw * 0.2).toFixed(1)}" y="${yc(p.v).toFixed(1)}"
                   width="${(bw * 0.6).toFixed(1)}" height="${Math.max(0, ih + padT - yc(p.v)).toFixed(1)}"/>`
          )
          .join("")
      : "";

    const segments = (arr, cls) => {
      const out = [];
      let cur = [];
      arr.forEach((p, i) => {
        if (p.v == null) {
          if (cur.length > 1) out.push(cur.join(" "));
          cur = [];
          return;
        }
        cur.push(`${(x(i) + bw / 2).toFixed(1)},${y(p.v).toFixed(1)}`);
      });
      if (cur.length > 1) out.push(cur.join(" "));
      return out.map((pts) => `<polyline class="${cls}" points="${pts}"/>`).join("");
    };

    const dots = (arr, cls) =>
      arr
        .map((p, i) =>
          p.v == null
            ? ""
            : `<circle class="${cls}" cx="${(x(i) + bw / 2).toFixed(1)}" cy="${y(p.v).toFixed(1)}" r="2.6"/>`
        )
        .join("");

    let mainMark;
    if (this._config.chart_type === "bar") {
      mainMark = main
        .map((p, i) =>
          p.v == null
            ? ""
            : `<rect class="bar" x="${(x(i) + bw * 0.15).toFixed(1)}" y="${y(p.v).toFixed(1)}"
                 width="${(bw * 0.7).toFixed(1)}" height="${Math.max(0, ih + padT - y(p.v)).toFixed(1)}" rx="1"/>`
        )
        .join("");
    } else {
      mainMark = segments(main, "mainline") + dots(main, "maindot");
    }

    const cmp = compare ? segments(compare, "cmpline") + dots(compare, "cmpdot") : "";

    const every = Math.ceil(n / 12);
    const xticks = main
      .map((p, i) =>
        i % every === 0
          ? `<text class="xtick" x="${(x(i) + bw / 2).toFixed(1)}" y="${H - 10}">${labels(p.t)}</text>`
          : ""
      )
      .join("");

    const costAt = (i) =>
      hasCost && cost[i] && cost[i].v != null
        ? ` · ${Math.round(cost[i].v).toLocaleString("ko-KR")}원`
        : "";

    const hits = main
      .map(
        (p, i) =>
          `<rect class="hit" x="${x(i).toFixed(1)}" y="${padT}" width="${bw.toFixed(1)}" height="${ih}"
             data-label="${labels(p.t)}${this._mode === "hour" ? "시" : ""}"
             data-v="${p.v == null ? "—" : fmt(p.v, 3) + " kWh" + costAt(i)}"></rect>`
      )
      .join("");

    const total = filled.reduce((s, p) => s + p.v, 0);
    const peak = filled.reduce((a, b) => (b.v > a.v ? b : a), filled[0]);
    const costTotal = costVals.reduce((s, v) => s + v, 0);

    return `
      <div class="chartwrap">
        <svg viewBox="0 0 ${W} ${H}" class="chart">
          ${grid}
          ${costBars}
          ${mainMark}
          ${cmp}
          ${xticks}
          ${hits}
        </svg>
        <div class="tip" hidden></div>
      </div>
      <div class="legend">
        <span class="lg main">사용량</span>
        ${compare ? '<span class="lg cmp">전일</span>' : ""}
        ${hasCost ? '<span class="lg cost">요금(예상)</span>' : ""}
      </div>
      <div class="foot">
        <div class="cell"><div class="k">합계</div><div class="v">${fmt(total, 1)} kWh</div></div>
        <div class="cell"><div class="k">최대</div><div class="v">${fmt(peak.v, 2)} kWh</div></div>
        <div class="cell"><div class="k">${hasCost ? "요금 합계" : "평균"}</div>
          <div class="v">${hasCost ? Math.round(costTotal).toLocaleString("ko-KR") + "원" : fmt(total / filled.length, 2) + " kWh"}</div></div>
      </div>
      ${hasCost ? '<div class="note">요금은 전력량요금 추정치입니다. 기본요금·기후환경요금·부가세 등은 월 단위라 포함되지 않습니다.</div>' : ""}`;
  }

  _wireTooltip() {
    const wrap = this.shadowRoot.querySelector(".chartwrap");
    const tip = this.shadowRoot.querySelector(".tip");
    if (!wrap || !tip) return;
    wrap.querySelectorAll(".hit").forEach((r) => {
      r.addEventListener("pointerenter", (ev) => {
        tip.textContent = `${r.dataset.label} · ${r.dataset.v}`;
        tip.hidden = false;
        const b = wrap.getBoundingClientRect();
        tip.style.left = `${ev.clientX - b.left}px`;
        tip.style.top = `${Math.max(0, ev.clientY - b.top - 34)}px`;
      });
      r.addEventListener("pointerleave", () => {
        tip.hidden = true;
      });
    });
  }

  _style() {
    return `<style>
      /* 섹션 뷰가 정해 준 칸 높이 안에서 배치를 끝낸다. 그래프는 남은 높이를
         채우고, 머리말과 하단 요약은 제 높이를 지킨다. */
      :host { display: block; height: 100%; }
      ha-card {
        padding: 16px; height: 100%; box-sizing: border-box;
        display: flex; flex-direction: column; overflow: hidden;
      }
      .head { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; flex: 0 0 auto; }
      .title { font-size: var(--ha-font-size-l, 16px); font-weight: var(--ha-font-weight-medium, 500);
               color: var(--primary-text-color); }
      .chips { display: flex; gap: 4px; }
      .chip {
        border: 0; border-radius: 14px; padding: 4px 12px; cursor: pointer;
        font-size: var(--ha-font-size-s, 12px); font-family: inherit;
        background: var(--secondary-background-color); color: var(--secondary-text-color);
      }
      .chip.on { background: var(--primary-color); color: var(--text-primary-color, #fff); }
      .nav { display: flex; align-items: center; gap: 6px; margin: 8px 0 0; flex: 0 0 auto; }
      .navbtn {
        border: 0; background: var(--secondary-background-color); color: var(--primary-text-color);
        width: 24px; height: 24px; border-radius: 12px; cursor: pointer; font-size: 15px; line-height: 1;
      }
      .navbtn[disabled] { opacity: .35; cursor: default; }
      .navlabel { font-size: var(--ha-font-size-s, 12px); color: var(--secondary-text-color); }
      .chartwrap { position: relative; margin-top: 4px; flex: 1 1 auto; min-height: 0; }
      .chart { width: 100%; height: 100%; display: block; overflow: visible; }
      .grid { stroke: var(--divider-color); stroke-width: 1; }
      .ytick { text-anchor: end; font-size: 9px; fill: var(--secondary-text-color); }
      .ytick.right { text-anchor: start; }
      .xtick { text-anchor: middle; font-size: 9px; fill: var(--secondary-text-color); }
      .bar { fill: var(--primary-color); }
      .costbar { fill: var(--secondary-text-color); fill-opacity: .22; }
      .mainline { fill: none; stroke: var(--primary-color); stroke-width: 2; stroke-linejoin: round; }
      .maindot { fill: var(--primary-color); }
      .cmpline { fill: none; stroke: var(--success-color, #43a047); stroke-width: 2;
                 stroke-linejoin: round; }
      .cmpdot { fill: var(--success-color, #43a047); }
      .hit { fill: transparent; }
      .hit:hover { fill: var(--primary-text-color); fill-opacity: .06; }
      .tip {
        position: absolute; transform: translateX(-50%); pointer-events: none;
        background: var(--card-background-color); color: var(--primary-text-color);
        border: 1px solid var(--divider-color); border-radius: 6px;
        padding: 4px 8px; font-size: 12px; white-space: nowrap;
        box-shadow: 0 2px 8px rgba(0,0,0,.3);
      }
      .legend { display: flex; gap: 12px; justify-content: center; margin-top: 2px; flex-wrap: wrap; flex: 0 0 auto; }
      .lg { font-size: 11px; color: var(--secondary-text-color); display: flex; align-items: center; gap: 4px; }
      .lg::before { content: ""; width: 10px; height: 3px; border-radius: 2px; }
      .lg.main::before { background: var(--primary-color); }
      .lg.cmp::before { background: var(--success-color, #43a047); }
      .lg.cost::before { background: var(--secondary-text-color); opacity: .5; height: 8px; }
      .foot {
        display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px;
        margin-top: 10px; border-top: 1px solid var(--divider-color); padding-top: 10px; flex: 0 0 auto;
      }
      .cell { text-align: center; }
      .k { font-size: var(--ha-font-size-xs, 11px); color: var(--secondary-text-color); }
      .v { font-size: var(--ha-font-size-m, 15px); font-weight: var(--ha-font-weight-medium, 500);
           color: var(--primary-text-color); }
      .note { margin-top: 8px; font-size: 11px; line-height: 1.4; color: var(--secondary-text-color); flex: 0 0 auto; }
      .empty { flex: 1 1 auto; display: flex; align-items: center; justify-content: center; padding: 8px; text-align: center; color: var(--secondary-text-color); }
    </style>`;
  }
}

customElements.define("kepco-usage-chart-card", KepcoUsageChartCard);

/* ------------------------------------------------------------------ 편집기 */

const EDITOR_SCHEMA = [
  { name: "entity", required: true, selector: { entity: { domain: "sensor" } } },
  { name: "name", selector: { text: {} } },
  {
    name: "modes",
    selector: {
      select: {
        multiple: true,
        mode: "list",
        options: [
          { value: "hour", label: "시간대별" },
          { value: "day", label: "일별" },
          { value: "month", label: "월별 (기록이 쌓인 만큼만)" },
        ],
      },
    },
  },
  {
    name: "hour_window",
    selector: {
      select: {
        mode: "dropdown",
        options: [
          { value: "today", label: "오늘 (0~24시)" },
          { value: "rolling", label: "최근 24시간" },
        ],
      },
    },
  },
  {
    type: "grid",
    schema: [
      { name: "days", selector: { number: { min: 7, max: 60, step: 1, mode: "box" } } },
      {
        name: "chart_type",
        selector: {
          select: {
            mode: "dropdown",
            options: [
              { value: "line", label: "꺾은선" },
              { value: "bar", label: "막대" },
            ],
          },
        },
      },
    ],
  },
  {
    type: "grid",
    schema: [
      { name: "show_comparison", selector: { boolean: {} } },
      { name: "show_cost", selector: { boolean: {} } },
    ],
  },
];

const EDITOR_LABELS = {
  entity: "청구주기 사용량 센서",
  name: "카드 제목",
  modes: "표시할 축",
  hour_window: "시간대별 기준",
  days: "일별 기간 (일)",
  chart_type: "그래프 모양",
  show_comparison: "전일 비교선",
  show_cost: "요금 추정치 (시간대별)",
};

class KepcoUsageChartCardEditor extends HTMLElement {
  setConfig(config) {
    this._config = { ...DEFAULTS, ...config };
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    if (this._form) this._form.hass = hass;
  }

  _render() {
    if (!this._form) {
      this._form = document.createElement("ha-form");
      this._form.computeLabel = (s) => EDITOR_LABELS[s.name] || s.name;
      this._form.addEventListener("value-changed", (e) => this._changed(e));
      this.appendChild(this._form);
    }
    this._form.hass = this._hass;
    this._form.schema = EDITOR_SCHEMA;
    this._form.data = this._config;
  }

  _changed(ev) {
    ev.stopPropagation();
    const config = { ...ev.detail.value };
    for (const k of Object.keys(config)) {
      if (config[k] === "" || config[k] === undefined) delete config[k];
    }
    fireEvent(this, "config-changed", { config });
  }
}

customElements.define("kepco-usage-chart-card-editor", KepcoUsageChartCardEditor);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "kepco-usage-chart-card",
  name: "KEPCO 사용량 현황",
  description: "시간대별·일별 사용량 그래프 (장기 통계 기반)",
  preview: true,
  documentationURL: "https://github.com/jaein4722/ha-kepco-smart-meter",
});
