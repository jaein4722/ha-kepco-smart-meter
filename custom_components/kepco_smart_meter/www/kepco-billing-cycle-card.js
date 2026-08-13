/**
 * kepco-billing-cycle-card
 *
 * 이번 청구주기 사용량을 누진 구간 위에 얹어 보여 주는 카드.
 *
 * 내장 gauge 카드와 달리
 *   - 누진 경계가 검침기간에 맞춰 자동으로 정해진다 (하계 일할계산 포함)
 *   - 한전이 판정한 누진 단계를 그대로 표시한다 (경계를 이쪽에서 재현하지 않는다)
 *   - 다음 구간까지 남은 양과 검침일까지 남은 일수를 함께 보여 준다
 *   - 카드를 누르면 구간별 단가·채움·계절 산정 근거를 담은 상세 창이 열린다
 *
 * 엔티티는 `청구주기 사용량` 센서 하나만 있으면 된다. 나머지는 그 센서의
 * 속성(billing_start / billing_end / progressive_level / tier_unit_prices)에서 읽는다.
 *
 * 화면 요소는 되도록 Home Assistant 자체 컴포넌트(ha-card / ha-dialog / ha-form /
 * ha-ripple)와 디자인 토큰을 쓴다. 없으면 같은 모양의 대체물로 떨어진다.
 */

const CARD_VERSION = "0.4.0";

console.info(
  `%c KEPCO-BILLING-CYCLE-CARD %c ${CARD_VERSION} `,
  "color:#fff;background:#0b5cab;font-weight:700",
  "color:#0b5cab;background:#eee"
);

// 주택용 저압 누진 경계 (kWh).
const TIERS_SUMMER = [300, 450]; // 하계 7/1 ~ 8/31
const TIERS_NORMAL = [200, 400]; // 그 외 기간
const SUMMER_FROM = [7, 1];
const SUMMER_TO = [8, 31];

const DAY = 86400000;

const DEFAULTS = {
  show_footer: true,
  show_ticks: true,
  tap_action: { action: "detail" },
};

function polar(cx, cy, r, deg) {
  const a = (deg * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy - r * Math.sin(a)];
}

/** 0~1 구간 비율 두 개를 반원 호 경로로. 게이지는 180°(좌) → 0°(우) 로 흐른다. */
function arc(cx, cy, r, f0, f1) {
  const [x0, y0] = polar(cx, cy, r, 180 - 180 * f0);
  const [x1, y1] = polar(cx, cy, r, 180 - 180 * f1);
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 0 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function fmt(n, digits = 1) {
  return Number(n).toLocaleString("ko-KR", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/** 'YYYY-MM-DD' 를 로컬 자정 Date 로. new Date(str) 은 UTC 로 읽혀 하루가 밀린다. */
function parseDate(s) {
  if (typeof s !== "string") return null;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
}

function daysUntil(d) {
  if (!d) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.max(0, Math.round((d - today) / DAY));
}

/** 두 폐구간 [a0,a1], [b0,b1] 이 겹치는 일수 (양끝 포함). */
function overlapDays(a0, a1, b0, b1) {
  const s = Math.max(a0.getTime(), b0.getTime());
  const e = Math.min(a1.getTime(), b1.getTime());
  return e < s ? 0 : Math.round((e - s) / DAY) + 1;
}

/**
 * 검침기간에 대한 누진 경계를 구한다.
 *
 * 한전은 하계(7/1~8/31)에만 구간을 넓혀 준다. 검침기간이 하계에 걸쳐 있으면
 * 구간 자체를 일할계산하므로, 하계에 속한 일수 비율로 두 기준을 선형 보간한다.
 * 7/15~8/14 처럼 전부 하계면 그대로 300/450, 8/15~9/14 면 그 사이 값이 된다.
 */
function seasonalTiers(start, end) {
  if (!start || !end || end < start) {
    const m = new Date().getMonth() + 1;
    const t = m === 7 || m === 8 ? TIERS_SUMMER : TIERS_NORMAL;
    return { tiers: t.slice(), total: null, summer: null, ratio: t === TIERS_SUMMER ? 1 : 0 };
  }
  const total = Math.round((end - start) / DAY) + 1;
  let summer = 0;
  for (let y = start.getFullYear(); y <= end.getFullYear(); y++) {
    summer += overlapDays(
      start,
      end,
      new Date(y, SUMMER_FROM[0] - 1, SUMMER_FROM[1]),
      new Date(y, SUMMER_TO[0] - 1, SUMMER_TO[1])
    );
  }
  const ratio = total > 0 ? summer / total : 0;
  const lerp = (a, b) => Math.round(a + (b - a) * ratio);
  return {
    tiers: [lerp(TIERS_NORMAL[0], TIERS_SUMMER[0]), lerp(TIERS_NORMAL[1], TIERS_SUMMER[1])],
    total,
    summer,
    ratio,
  };
}

function levelOf(usage, [b1, b2]) {
  return usage < b1 ? 1 : usage < b2 ? 2 : 3;
}

function fireEvent(node, type, detail) {
  node.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
}

/**
 * HA 의 lazy 로딩 컴포넌트를 끌어온다.
 *
 * ha-dialog 같은 요소는 필요해질 때 로드되는 청크에 들어 있어서, 사용자가 아직
 * 어떤 대화상자도 열지 않았다면 정의돼 있지 않다. loadCardHelpers 를 부르면
 * 그 청크가 함께 들어온다. 실패해도 자체 대체 창으로 떨어지므로 조용히 넘긴다.
 */
async function loadHaComponents() {
  if (customElements.get("ha-dialog")) return;
  try {
    if (window.loadCardHelpers) await window.loadCardHelpers();
  } catch (err) {
    /* 무시 */
  }
}

class KepcoBillingCycleCard extends HTMLElement {
  static getStubConfig(hass) {
    const entity = Object.keys(hass.states || {}).find(
      (id) => id.startsWith("sensor.") && id.endsWith("_billing_cycle_usage")
    );
    return { entity: entity || "" };
  }

  static async getConfigElement() {
    await loadHaComponents();
    return document.createElement("kepco-billing-cycle-card-editor");
  }

  setConfig(config) {
    if (!config || !config.entity) {
      throw new Error("entity 를 지정하세요 (청구주기 사용량 센서)");
    }
    if (config.tiers && (!Array.isArray(config.tiers) || config.tiers.length !== 2)) {
      throw new Error("tiers 는 [1단계경계, 2단계경계] 형식이어야 합니다");
    }
    this._config = { ...DEFAULTS, ...config };
    this._sig = null;
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });

    // 상세 창을 쓸 카드라면 ha-dialog 청크를 미리 받아 둔다. 첫 클릭 때 받으면
    // 눌러도 한동안 아무 일이 없는 것처럼 보인다.
    if ((this._config.tap_action || {}).action === "detail") {
      loadHaComponents();
    }
  }

  set hass(hass) {
    this._hass = hass;
    const st = hass.states[this._config.entity];
    // hass 는 다른 엔티티가 바뀔 때도 들어온다. 관련 값이 그대로면 다시 그리지 않는다.
    const sig = st ? `${st.state}|${st.last_updated}` : "none";
    if (sig === this._sig) return;
    this._sig = sig;
    this._model = st ? this._compute(st) : null;
    this._render(st);
  }

  getCardSize() {
    return this._config && this._config.show_footer ? 4 : 3;
  }

  /** 섹션 뷰의 기본 크기와 리사이즈 한계.
   *
   *  한 행이 56px 이라 rows 를 그대로 높이로 받는다. 게이지는 남은 높이에
   *  맞춰 줄어들므로 어느 크기로 조절해도 카드 밖으로 넘치지 않는다.
   *  하단 요약이 3칸이라 너무 좁으면 글자가 뭉개져서 min_columns 를 둔다. */
  getGridOptions() {
    const footer = this._config && this._config.show_footer;
    return {
      rows: footer ? 5 : 4,
      columns: 12,
      min_rows: footer ? 4 : 3,
      min_columns: 6,
    };
  }

  /** 화면과 상세 창이 같은 값을 쓰도록 계산을 한곳에 모은다. */
  _compute(st) {
    const a = st.attributes || {};
    const usage = num(st.state);
    const kepcoLevel = num(a.progressive_level);
    const start = parseDate(a.billing_start);
    const end = parseDate(a.billing_end);

    const season = seasonalTiers(start, end);
    const tiers = this._config.tiers ? this._config.tiers.slice() : season.tiers;
    const source = this._config.tiers ? "카드 설정" : "검침기간 기준";

    // 표시할 단계는 언제나 한전 판정이 우선이다. 게이지 경계는 어디까지나 눈으로
    // 위치를 가늠하기 위한 것이므로, 경계 근처에서 둘이 한 단계 어긋날 수 있다.
    // 그때 경계를 억지로 끌어다 맞추면 오히려 값이 거칠어지므로, 어긋났다는 사실만
    // 상세 창에 적어 둔다.
    const computed = usage != null ? levelOf(usage, tiers) : null;
    const level = kepcoLevel != null ? kepcoLevel : computed;
    const mismatch = kepcoLevel != null && computed != null && computed !== kepcoLevel;
    const prices = Array.isArray(a.tier_unit_prices) ? a.tier_unit_prices.map(num) : [];

    return {
      usage,
      level,
      kepcoLevel,
      computed,
      mismatch,
      tiers,
      source,
      season,
      start,
      end,
      prices,
      daysElapsed: num(a.days_elapsed),
      left: daysUntil(end),
      next: usage < tiers[0] ? tiers[0] : usage < tiers[1] ? tiers[1] : null,
      max: num(this._config.max) || tiers[1] + (tiers[1] - tiers[0]),
    };
  }

  _render(st) {
    const cfg = this._config;
    const root = this.shadowRoot;

    if (!st || st.state === "unavailable" || st.state === "unknown") {
      root.innerHTML = `${this._style()}
        <ha-card><div class="empty">${
          st ? "데이터를 기다리는 중" : `엔티티를 찾을 수 없습니다: ${cfg.entity}`
        }</div></ha-card>`;
      return;
    }

    const m = this._model;
    const [b1, b2] = m.tiers;
    const cx = 100, cy = 104, r = 76, sw = 17;
    const f = (v) => Math.max(0, Math.min(1, v / m.max));
    const vf = f(m.usage);

    // 현재 위치는 중심에서 뻗는 바늘이 아니라 호 위의 마커로 찍는다.
    // 바늘을 쓰면 가운데 숫자를 가로질러 값이 안 읽힌다.
    const mAng = 180 - 180 * vf;
    const [mx0, my0] = polar(cx, cy, r - sw / 2 - 2, mAng);
    const [mx1, my1] = polar(cx, cy, r + sw / 2 + 2, mAng);
    const marker = `M ${mx0.toFixed(2)} ${my0.toFixed(2)} L ${mx1.toFixed(2)} ${my1.toFixed(2)}`;

    const ticks = cfg.show_ticks
      ? [b1, b2]
          .map((t) => {
            const [tx, ty] = polar(cx, cy, r + 13, 180 - 180 * f(t));
            return `<text class="tick" x="${tx.toFixed(1)}" y="${ty.toFixed(1)}">${t}</text>`;
          })
          .join("")
      : "";

    const footer = cfg.show_footer
      ? `<div class="footer">
           <div class="cell"><div class="k">누진 단계</div>
             <div class="v t${m.level}">${m.level}단계</div></div>
           <div class="cell"><div class="k">다음 구간까지</div>
             <div class="v">${m.next == null ? "최고 구간" : fmt(m.next - m.usage) + " kWh"}</div></div>
           <div class="cell"><div class="k">검침일까지</div>
             <div class="v">${m.left == null ? "—" : m.left === 0 ? "오늘" : "D-" + m.left}</div></div>
         </div>`
      : "";

    const period =
      m.start && m.end
        ? `${m.start.getMonth() + 1}/${m.start.getDate()} – ${m.end.getMonth() + 1}/${m.end.getDate()}`
        : "";

    const clickable = cfg.tap_action && cfg.tap_action.action !== "none";

    root.innerHTML = `${this._style()}
      <ha-card class="${clickable ? "clickable" : ""}">
        ${clickable ? "<ha-ripple></ha-ripple>" : ""}
        <div class="head">
          <div class="title">${cfg.name || "이번 청구주기"}</div>
          ${period ? `<div class="period">${period}</div>` : ""}
        </div>
        <svg viewBox="0 0 200 128" class="gauge">
          <path class="seg t1" d="${arc(cx, cy, r, 0, f(b1))}" stroke-width="${sw}" />
          <path class="seg t2" d="${arc(cx, cy, r, f(b1), f(b2))}" stroke-width="${sw}" />
          <path class="seg t3" d="${arc(cx, cy, r, f(b2), 1)}" stroke-width="${sw}" />
          ${ticks}
          <path class="marker-halo" d="${marker}" />
          <path class="marker" d="${marker}" />
          <text class="value" x="${cx}" y="${cy - 12}">${fmt(m.usage)}</text>
          <text class="unit" x="${cx}" y="${cy + 6}">kWh</text>
        </svg>
        ${footer}
      </ha-card>`;

    if (clickable) {
      const card = root.querySelector("ha-card");
      card.setAttribute("tabindex", "0");
      card.setAttribute("role", "button");
      card.addEventListener("click", () => this._onTap());
      card.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          this._onTap();
        }
      });
    }
  }

  _onTap() {
    const action = (this._config.tap_action || {}).action || "detail";
    if (action === "more-info") {
      fireEvent(this, "hass-more-info", { entityId: this._config.entity });
      return;
    }
    if (action === "detail") this._openDetail();
  }

  /** @param {boolean} withPeriod 검침기간 줄을 본문에 넣을지 (헤더에 이미 있으면 뺀다) */
  _detailContent(withPeriod = true) {
    const m = this._model;
    const [b1, b2] = m.tiers;
    // 각 구간에 얼마나 찼는지. 3단계는 상한이 없으므로 초과분을 그대로 보여 준다.
    const fills = [
      { name: "1단계", used: Math.min(m.usage, b1), cap: b1 },
      { name: "2단계", used: Math.max(0, Math.min(m.usage, b2) - b1), cap: b2 - b1 },
      { name: "3단계", used: Math.max(0, m.usage - b2), cap: null },
    ];

    const seasonLine =
      m.season.total != null
        ? `하계 ${m.season.summer}일 / 총 ${m.season.total}일` +
          (m.season.ratio > 0 && m.season.ratio < 1 ? " (일할계산)" : "")
        : "기간 정보 없음";

    const rows = [];
    if (withPeriod) {
      rows.push(["검침기간", m.start && m.end
        ? `${m.start.toLocaleDateString("ko-KR")} ~ ${m.end.toLocaleDateString("ko-KR")}`
        : "—"]);
    }
    rows.push(
      ["경과", m.daysElapsed != null ? `${m.daysElapsed}일` : "—"],
      ["검침일까지", m.left == null ? "—" : m.left === 0 ? "오늘" : `${m.left}일`],
      ["계절 구분", seasonLine],
      ["적용 구간", `${b1} / ${b2} kWh`],
      ["구간 산정", m.source],
      ["누진 단계", `${m.level}단계${m.kepcoLevel != null ? " (한전 판정)" : ""}`],
      ["사용량", `${fmt(m.usage)} kWh`],
      ["다음 구간까지", m.next == null ? "최고 구간" : `${fmt(m.next - m.usage)} kWh`]
    );
    if (m.mismatch) {
      rows.push([
        "참고",
        `표시 구간으로는 ${m.computed}단계입니다. 한전 판정(${m.kepcoLevel}단계)이 기준이며, ` +
          "경계 부근에서는 이렇게 한 단계 어긋나 보일 수 있습니다.",
      ]);
    }

    const bars = fills
      .map((t, i) => {
        const pct = t.cap ? Math.min(100, (t.used / t.cap) * 100) : t.used > 0 ? 100 : 0;
        const price = m.prices[i];
        return `<div class="bar-row">
            <div class="bar-name t${i + 1}">${t.name}</div>
            <div class="bar-track"><div class="bar-fill t${i + 1}" style="width:${pct.toFixed(1)}%"></div></div>
            <div class="bar-num">${fmt(t.used)}${t.cap ? ` / ${t.cap}` : ""}</div>
            <div class="bar-price">${price != null ? fmt(price, price % 1 ? 1 : 0) + "원" : ""}</div>
          </div>`;
      })
      .join("");

    return `
      <style>${this._detailStyle()}</style>
      <div class="detail">
        <dl>${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>
        <div class="section">구간별 사용량과 단가</div>
        ${bars}
      </div>`;
  }

  async _openDetail() {
    if (!this._model) return;
    await loadHaComponents();

    if (customElements.get("ha-dialog")) {
      const m = this._model;
      const dlg = document.createElement("ha-dialog");
      dlg.hideActions = true;

      // 최신 ha-dialog 는 headerTitle / headerSubtitle 슬롯을 쓴다. 구형은 heading
      // 속성을 읽으므로 둘 다 넣어 둔다. 닫기(X) 버튼은 대화상자가 알아서 붙인다.
      const title = this._config.name || "이번 청구주기";
      dlg.heading = title;

      const h = document.createElement("span");
      h.slot = "headerTitle";
      h.textContent = title;
      dlg.appendChild(h);

      if (m.start && m.end) {
        const sub = document.createElement("span");
        sub.slot = "headerSubtitle";
        sub.textContent = `${m.start.toLocaleDateString("ko-KR")} ~ ${m.end.toLocaleDateString("ko-KR")}`;
        dlg.appendChild(sub);
      }

      const body = document.createElement("div");
      body.innerHTML = this._detailContent(false); // 검침기간은 부제로 이미 나온다
      dlg.appendChild(body);

      dlg.addEventListener("closed", () => dlg.remove());
      document.body.appendChild(dlg);
      dlg.open = true;
      return;
    }

    // ha-dialog 를 못 얻었을 때만 쓰는 대체 창. HA 디자인 토큰으로 맞춰 둔다.
    const host = document.createElement("div");
    host.attachShadow({ mode: "open" });
    host.shadowRoot.innerHTML = `
      <style>
        .backdrop { position: fixed; inset: 0; z-index: 9999;
          background: rgba(0,0,0,.6); display: flex; align-items: center;
          justify-content: center; padding: 16px; }
        .sheet { background: var(--ha-card-background, var(--card-background-color, #1c1c1c));
          color: var(--primary-text-color, #fff);
          border-radius: var(--ha-dialog-border-radius, var(--ha-card-border-radius, 12px));
          box-shadow: 0 8px 32px rgba(0,0,0,.5);
          width: min(460px, 100%); max-height: 86vh; overflow: auto; padding: 20px 24px 16px;
          font-family: var(--paper-font-body1_-_font-family, Roboto, sans-serif); }
        h2 { margin: 0 0 16px; font-size: 20px; font-weight: 400; }
        button { margin-top: 20px; float: right; border: 0; background: none;
          color: var(--primary-color, #03a9f4); font-size: 14px; font-weight: 500;
          text-transform: uppercase; padding: 10px 12px; cursor: pointer; border-radius: 4px; }
        ${this._detailStyle()}
      </style>
      <div class="backdrop"><div class="sheet" role="dialog" aria-modal="true">
        <h2>${this._config.name || "이번 청구주기"}</h2>
        ${this._detailContent().replace(/<style>[\s\S]*?<\/style>/, "")}
        <button>닫기</button>
      </div></div>`;

    const close = () => {
      document.removeEventListener("keydown", onKey);
      host.remove();
    };
    const onKey = (e) => e.key === "Escape" && close();
    host.shadowRoot.querySelector("button").addEventListener("click", close);
    host.shadowRoot.querySelector(".backdrop").addEventListener("click", (e) => {
      if (e.target === e.currentTarget) close();
    });
    document.addEventListener("keydown", onKey);
    document.body.appendChild(host);
  }

  _detailStyle() {
    return `
      .detail { font-size: 14px; }
      dl { display: grid; grid-template-columns: auto 1fr; gap: 8px 16px; margin: 0; }
      dt { color: var(--secondary-text-color); font-size: 13px; }
      dd { margin: 0; text-align: right; font-size: 13px; }
      .section { margin: 20px 0 4px; font-size: 12px; color: var(--secondary-text-color); }
      .bar-row { display: grid; grid-template-columns: 46px 1fr 84px 56px; gap: 8px;
                 align-items: center; margin-top: 8px; font-size: 12px; }
      .bar-name { font-weight: 500; }
      .bar-track { height: 8px; border-radius: 4px;
                   background: var(--divider-color, #444); overflow: hidden; }
      .bar-fill { height: 100%; border-radius: 4px; }
      .bar-num { text-align: right; font-variant-numeric: tabular-nums; }
      .bar-price { text-align: right; color: var(--secondary-text-color); }
      .t1 { color: var(--success-color, #43a047); }
      .t2 { color: var(--warning-color, #ffa600); }
      .t3 { color: var(--error-color, #db4437); }
      .bar-fill.t1 { background: var(--success-color, #43a047); }
      .bar-fill.t2 { background: var(--warning-color, #ffa600); }
      .bar-fill.t3 { background: var(--error-color, #db4437); }`;
  }

  _style() {
    return `<style>
      /* 섹션 뷰는 rows 로 칸 높이를 고정해 준다. 그 높이 안에서 배치가 끝나야
         카드 밖으로 넘치지 않는다. 폭에 비례해 커지는 SVG 를 그대로 두면
         넓힐수록 칸을 벗어난다. */
      :host { display: block; height: 100%; }
      ha-card {
        padding: 16px; position: relative; overflow: hidden;
        height: 100%; box-sizing: border-box;
        display: flex; flex-direction: column;
      }
      ha-card.clickable { cursor: pointer; }
      ha-card.clickable:focus-visible {
        outline: 2px solid var(--primary-color); outline-offset: 2px;
      }
      .head { display:flex; align-items:baseline; justify-content:space-between; gap:8px; flex: 0 0 auto; }
      .title {
        font-size: var(--ha-font-size-l, 16px);
        font-weight: var(--ha-font-weight-medium, 500);
        color: var(--primary-text-color);
      }
      .period { font-size: var(--ha-font-size-s, 12px); color: var(--secondary-text-color); }
      /* 남은 높이를 채우되 그 안에서 비율을 지킨다(preserveAspectRatio 기본값). */
      .gauge {
        flex: 1 1 auto; min-height: 0; width: 100%; height: 100%;
        display: block; margin: 4px 0 0;
      }
      .seg { fill: none; stroke-linecap: butt; }
      .t1 { stroke: var(--success-color, #43a047); }
      .t2 { stroke: var(--warning-color, #ffa600); }
      .t3 { stroke: var(--error-color, #db4437); }
      /* 마커는 어떤 구간 색 위에 놓여도 보이도록 어두운 테두리를 깔고 흰 선을 얹는다 */
      .marker-halo { stroke: rgba(0,0,0,.55); stroke-width: 7; fill: none; stroke-linecap: round; }
      .marker { stroke: #fff; stroke-width: 3.5; fill: none; stroke-linecap: round; }
      .value {
        text-anchor: middle; font-size: 27px;
        font-weight: var(--ha-font-weight-medium, 600);
        fill: var(--primary-text-color);
      }
      .unit {
        text-anchor: middle; font-size: var(--ha-font-size-xs, 11px);
        fill: var(--secondary-text-color);
      }
      .tick { text-anchor: middle; font-size: 9px; fill: var(--secondary-text-color); }
      .footer {
        display: grid; grid-template-columns: repeat(3, 1fr);
        gap: 8px; margin-top: 4px; flex: 0 0 auto;
        border-top: 1px solid var(--divider-color); padding-top: 12px;
      }
      .cell { text-align: center; min-width: 0; }
      .k {
        font-size: var(--ha-font-size-xs, 11px);
        color: var(--secondary-text-color); margin-bottom: 2px;
      }
      .v {
        font-size: var(--ha-font-size-m, 15px);
        font-weight: var(--ha-font-weight-medium, 500);
        color: var(--primary-text-color);
      }
      .v.t1 { color: var(--success-color, #43a047); }
      .v.t2 { color: var(--warning-color, #ffa600); }
      .v.t3 { color: var(--error-color, #db4437); }
      .empty { padding: 24px 8px; text-align: center; color: var(--secondary-text-color); }
    </style>`;
  }
}

customElements.define("kepco-billing-cycle-card", KepcoBillingCycleCard);

/* ------------------------------------------------------------------ 편집기 */

const EDITOR_SCHEMA = [
  { name: "entity", required: true, selector: { entity: { domain: "sensor" } } },
  { name: "name", selector: { text: {} } },
  {
    type: "grid",
    schema: [
      { name: "show_footer", selector: { boolean: {} } },
      { name: "show_ticks", selector: { boolean: {} } },
    ],
  },
  {
    name: "tap_action_mode",
    selector: {
      select: {
        mode: "dropdown",
        options: [
          { value: "detail", label: "상세 창 열기" },
          { value: "more-info", label: "기본 대화상자" },
          { value: "none", label: "동작 없음" },
        ],
      },
    },
  },
  { name: "max", selector: { number: { min: 100, max: 3000, step: 50, mode: "box" } } },
];

const EDITOR_LABELS = {
  entity: "청구주기 사용량 센서",
  name: "카드 제목",
  show_footer: "하단 요약 표시",
  show_ticks: "경계 눈금 표시",
  tap_action_mode: "눌렀을 때",
  max: "게이지 최대치 (비우면 자동)",
};

class KepcoBillingCycleCardEditor extends HTMLElement {
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
    // tap_action 은 객체라 폼에서 다루기 번거로우므로 평평한 값으로 바꿔 준다.
    const { tap_action, ...rest } = this._config;
    this._form.data = { ...rest, tap_action_mode: (tap_action || {}).action || "detail" };
  }

  _changed(ev) {
    ev.stopPropagation();
    const { tap_action_mode, ...rest } = ev.detail.value;
    const config = { ...rest, tap_action: { action: tap_action_mode || "detail" } };
    // 빈 값은 저장하지 않는다. YAML 이 지저분해진다.
    for (const k of Object.keys(config)) {
      if (config[k] === "" || config[k] === undefined) delete config[k];
    }
    fireEvent(this, "config-changed", { config });
  }
}

customElements.define("kepco-billing-cycle-card-editor", KepcoBillingCycleCardEditor);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "kepco-billing-cycle-card",
  name: "KEPCO 청구주기",
  description: "이번 청구주기 사용량을 누진 구간 위에 표시합니다",
  preview: true,
  documentationURL: "https://github.com/jaein4722/ha-kepco-smart-meter",
});
