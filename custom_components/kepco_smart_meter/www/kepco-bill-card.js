/**
 * kepco-bill-card
 *
 * 현재 요금과 예상 요금을 보여 주는 카드. 누르면 청구 항목 내역이 열린다.
 *
 * 금액은 전부 **한전이 계산해 내려준 값**이다. 누진 로직이나 단가를 이쪽에서
 * 재현하지 않는다(설계문서 §33).
 *
 * 엔티티는 `현재 요금` 센서 하나만 지정하면 된다. 예상 요금과 청구주기 정보는
 * 같은 계량기의 형제 엔티티에서 자동으로 찾는다.
 */

const CARD_VERSION = "0.1.0";

console.info(
  `%c KEPCO-BILL-CARD %c ${CARD_VERSION} `,
  "color:#fff;background:#0b5cab;font-weight:700",
  "color:#0b5cab;background:#eee"
);

// 한전 고지서와 같은 순서. 센서 속성 이름을 그대로 쓴다.
const ITEMS = [
  "기본요금",
  "전력량요금",
  "기후환경요금",
  "연료비조정액",
  "부가가치세",
  "전력산업기반기금",
];

const DEFAULTS = {
  show_progress: true,
  tap_action: { action: "detail" },
};

const DAY = 86400000;

function won(n) {
  return Number(n).toLocaleString("ko-KR", { maximumFractionDigits: 0 });
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function parseDate(s) {
  if (typeof s !== "string") return null;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
}

function daysUntil(d) {
  if (!d) return null;
  const t = new Date();
  t.setHours(0, 0, 0, 0);
  return Math.max(0, Math.round((d - t) / DAY));
}

function fireEvent(node, type, detail) {
  node.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
}

async function loadHaComponents() {
  if (customElements.get("ha-dialog")) return;
  try {
    if (window.loadCardHelpers) await window.loadCardHelpers();
  } catch (err) {
    /* 무시 — 자체 대체 창으로 떨어진다 */
  }
}

class KepcoBillCard extends HTMLElement {
  static getStubConfig(hass) {
    const entity = Object.keys(hass.states || {}).find(
      (id) => id.startsWith("sensor.") && id.endsWith("_current_bill")
    );
    return { entity: entity || "" };
  }

  static async getConfigElement() {
    await loadHaComponents();
    return document.createElement("kepco-bill-card-editor");
  }

  setConfig(config) {
    if (!config || !config.entity) {
      throw new Error("entity 를 지정하세요 (현재 요금 센서)");
    }
    this._config = { ...DEFAULTS, ...config };
    this._sig = null;
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    if ((this._config.tap_action || {}).action === "detail") loadHaComponents();
  }

  set hass(hass) {
    this._hass = hass;
    const sig = this._signature(hass);
    if (sig === this._sig) return;
    this._sig = sig;
    this._render();
  }

  /** 관련 엔티티가 하나라도 바뀌었을 때만 다시 그린다. */
  _signature(hass) {
    return this._entityIds()
      .map((id) => {
        const st = hass.states[id];
        return st ? `${id}=${st.state}@${st.last_updated}` : `${id}=x`;
      })
      .join("|");
  }

  /** 현재 요금 엔티티에서 형제 엔티티 ID 를 끌어낸다. */
  _entityIds() {
    const cur = this._config.entity;
    const sib = (suffix) => cur.replace(/_current_bill$/, suffix);
    return [
      cur,
      this._config.predicted_entity || sib("_predicted_bill"),
      this._config.cycle_entity || sib("_billing_cycle_usage"),
    ];
  }

  getCardSize() {
    return 3;
  }

  getGridOptions() {
    return { rows: 3, columns: 12, min_rows: 2, min_columns: 6 };
  }

  _model() {
    const hass = this._hass;
    const [curId, predId, cycleId] = this._entityIds();
    const cur = hass.states[curId];
    if (!cur) return null;

    const pred = hass.states[predId];
    const cycle = hass.states[cycleId];
    const ca = cur.attributes || {};

    const items = ITEMS.map((k) => ({ name: k, value: num(ca[k]) })).filter(
      (i) => i.value != null
    );

    const end = cycle ? parseDate((cycle.attributes || {}).billing_end) : null;
    const start = cycle ? parseDate((cycle.attributes || {}).billing_start) : null;

    return {
      current: num(cur.state),
      predicted: pred ? num(pred.state) : null,
      predictedUsage: pred ? num((pred.attributes || {})["예상 사용량"]) : null,
      usage: cycle ? num(cycle.state) : null,
      level: cycle ? num((cycle.attributes || {}).progressive_level) : null,
      start,
      end,
      left: daysUntil(end),
      items,
    };
  }

  _render() {
    const root = this.shadowRoot;
    const cfg = this._config;
    const m = this._model();

    if (!m || m.current == null) {
      root.innerHTML = `${this._style()}
        <ha-card><div class="empty">${
          m ? "요금 데이터를 기다리는 중" : `엔티티를 찾을 수 없습니다: ${cfg.entity}`
        }</div></ha-card>`;
      return;
    }

    // 예상 요금 대비 지금 어디까지 왔는지. 청구주기의 진행도를 금액으로 본다.
    const pct =
      m.predicted && m.predicted > 0
        ? Math.max(0, Math.min(100, (m.current / m.predicted) * 100))
        : null;

    const progress =
      cfg.show_progress && pct != null
        ? `<div class="bar"><div class="fill" style="width:${pct.toFixed(1)}%"></div></div>`
        : "";

    const clickable = cfg.tap_action && cfg.tap_action.action !== "none";

    root.innerHTML = `${this._style()}
      <ha-card class="${clickable ? "clickable" : ""}">
        ${clickable ? "<ha-ripple></ha-ripple>" : ""}
        <div class="head">
          <div class="title">${cfg.name || "전기요금"}</div>
          ${m.left != null
            ? `<div class="sub">${m.left === 0 ? "오늘 검침" : "검침 D-" + m.left}</div>`
            : ""}
        </div>
        <div class="amount">
          <span class="cur">${won(m.current)}</span><span class="unit">원</span>
        </div>
        ${progress}
        <div class="row">
          <div class="cell"><div class="k">예상 요금</div>
            <div class="v">${m.predicted != null ? won(m.predicted) + "원" : "—"}</div></div>
          <div class="cell"><div class="k">사용량</div>
            <div class="v">${m.usage != null ? m.usage.toLocaleString("ko-KR", { maximumFractionDigits: 1 }) + " kWh" : "—"}</div></div>
          <div class="cell"><div class="k">누진 단계</div>
            <div class="v t${m.level || 0}">${m.level != null ? m.level + "단계" : "—"}</div></div>
        </div>
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

  _detailContent(m) {
    const sum = m.items.reduce((s, i) => s + i.value, 0);
    // 항목 합계와 센서의 총계가 어긋나면 반올림 차이다. 굳이 감추지 않고 보여 준다.
    const diff = Math.round(m.current - sum);

    const rows = m.items
      .map(
        (i) =>
          `<tr><td>${i.name}</td><td class="n">${won(i.value)}원</td></tr>`
      )
      .join("");

    const extra = [];
    if (m.predicted != null) {
      extra.push(["예상 요금", `${won(m.predicted)}원`]);
    }
    if (m.predictedUsage != null) {
      extra.push(["예상 사용량", `${m.predictedUsage.toLocaleString("ko-KR", { maximumFractionDigits: 1 })} kWh`]);
    }
    if (m.usage != null) {
      extra.push(["현재 사용량", `${m.usage.toLocaleString("ko-KR", { maximumFractionDigits: 1 })} kWh`]);
    }
    if (m.level != null) extra.push(["누진 단계", `${m.level}단계`]);
    if (m.left != null) {
      extra.push(["검침일까지", m.left === 0 ? "오늘" : `${m.left}일`]);
    }

    return `
      <style>${this._detailStyle()}</style>
      <div class="detail">
        <table class="items">
          ${rows}
          ${diff !== 0 ? `<tr class="minor"><td>단수 조정</td><td class="n">${won(diff)}원</td></tr>` : ""}
          <tr class="total"><td>청구금액</td><td class="n">${won(m.current)}원</td></tr>
        </table>
        ${extra.length
          ? `<div class="section">그 밖에</div>
             <table class="items">
               ${extra.map(([k, v]) => `<tr><td>${k}</td><td class="n">${v}</td></tr>`).join("")}
             </table>`
          : ""}
        <div class="note">금액은 모두 한전이 계산해 내려준 값입니다. 실제 청구서와 다를 수 있습니다.</div>
      </div>`;
  }

  async _openDetail() {
    const m = this._model();
    if (!m) return;
    await loadHaComponents();

    const title = this._config.name || "전기요금";
    const period =
      m.start && m.end
        ? `${m.start.toLocaleDateString("ko-KR")} ~ ${m.end.toLocaleDateString("ko-KR")}`
        : "";

    if (customElements.get("ha-dialog")) {
      const dlg = document.createElement("ha-dialog");
      dlg.hideActions = true;
      dlg.heading = title; // 구버전 ha-dialog 대비

      const h = document.createElement("span");
      h.slot = "headerTitle";
      h.textContent = title;
      dlg.appendChild(h);

      if (period) {
        const sub = document.createElement("span");
        sub.slot = "headerSubtitle";
        sub.textContent = period;
        dlg.appendChild(sub);
      }

      const body = document.createElement("div");
      body.innerHTML = this._detailContent(m);
      dlg.appendChild(body);

      dlg.addEventListener("closed", () => dlg.remove());
      document.body.appendChild(dlg);
      dlg.open = true;
      return;
    }

    const host = document.createElement("div");
    host.attachShadow({ mode: "open" });
    host.shadowRoot.innerHTML = `
      <style>
        .backdrop { position: fixed; inset: 0; z-index: 9999; background: rgba(0,0,0,.6);
          display: flex; align-items: center; justify-content: center; padding: 16px; }
        .sheet { background: var(--ha-card-background, var(--card-background-color, #1c1c1c));
          color: var(--primary-text-color, #fff);
          border-radius: var(--ha-dialog-border-radius, 12px);
          width: min(420px, 100%); max-height: 86vh; overflow: auto; padding: 20px 24px 16px;
          font-family: var(--paper-font-body1_-_font-family, Roboto, sans-serif); }
        h2 { margin: 0 0 4px; font-size: 20px; font-weight: 400; }
        .p { color: var(--secondary-text-color); font-size: 13px; margin-bottom: 12px; }
        button { margin-top: 16px; float: right; border: 0; background: none;
          color: var(--primary-color); font-size: 14px; font-weight: 500;
          padding: 10px 12px; cursor: pointer; }
        ${this._detailStyle()}
      </style>
      <div class="backdrop"><div class="sheet" role="dialog" aria-modal="true">
        <h2>${title}</h2>${period ? `<div class="p">${period}</div>` : ""}
        ${this._detailContent(m).replace(/<style>[\s\S]*?<\/style>/, "")}
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
      table.items { width: 100%; border-collapse: collapse; }
      table.items td { padding: 7px 0; font-size: 13px; }
      table.items td:first-child { color: var(--secondary-text-color); }
      td.n { text-align: right; font-variant-numeric: tabular-nums; }
      tr.minor td { color: var(--secondary-text-color); font-size: 12px; }
      tr.total td {
        border-top: 1px solid var(--divider-color); padding-top: 10px;
        font-weight: 600; font-size: 15px; color: var(--primary-text-color);
      }
      .section { margin: 18px 0 2px; font-size: 12px; color: var(--secondary-text-color); }
      .note { margin-top: 16px; font-size: 11px; line-height: 1.5; color: var(--secondary-text-color); }`;
  }

  _style() {
    return `<style>
      ha-card { padding: 16px; position: relative; overflow: hidden; }
      ha-card.clickable { cursor: pointer; }
      ha-card.clickable:focus-visible { outline: 2px solid var(--primary-color); outline-offset: 2px; }
      .head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
      .title { font-size: var(--ha-font-size-l, 16px); font-weight: var(--ha-font-weight-medium, 500);
               color: var(--primary-text-color); }
      .sub { font-size: var(--ha-font-size-s, 12px); color: var(--secondary-text-color); }
      .amount { display: flex; align-items: baseline; gap: 3px; margin: 10px 0 2px; }
      .cur { font-size: 34px; font-weight: 600; color: var(--primary-text-color); line-height: 1; }
      .unit { font-size: 15px; color: var(--secondary-text-color); }
      .bar { height: 6px; border-radius: 3px; background: var(--divider-color);
             overflow: hidden; margin: 12px 0 2px; }
      .fill { height: 100%; background: var(--primary-color); border-radius: 3px; }
      .row {
        display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px;
        margin-top: 12px; border-top: 1px solid var(--divider-color); padding-top: 12px;
      }
      .cell { text-align: center; min-width: 0; }
      .k { font-size: var(--ha-font-size-xs, 11px); color: var(--secondary-text-color); margin-bottom: 2px; }
      .v { font-size: var(--ha-font-size-m, 15px); font-weight: var(--ha-font-weight-medium, 500);
           color: var(--primary-text-color); }
      .v.t1 { color: var(--success-color, #43a047); }
      .v.t2 { color: var(--warning-color, #ffa600); }
      .v.t3 { color: var(--error-color, #db4437); }
      .empty { padding: 24px 8px; text-align: center; color: var(--secondary-text-color); }
    </style>`;
  }
}

customElements.define("kepco-bill-card", KepcoBillCard);

/* ------------------------------------------------------------------ 편집기 */

const EDITOR_SCHEMA = [
  { name: "entity", required: true, selector: { entity: { domain: "sensor" } } },
  { name: "name", selector: { text: {} } },
  {
    type: "grid",
    schema: [
      { name: "show_progress", selector: { boolean: {} } },
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
    ],
  },
];

const EDITOR_LABELS = {
  entity: "현재 요금 센서",
  name: "카드 제목",
  show_progress: "예상 대비 진행 막대",
  tap_action_mode: "눌렀을 때",
};

class KepcoBillCardEditor extends HTMLElement {
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
    const { tap_action, ...rest } = this._config;
    this._form.data = { ...rest, tap_action_mode: (tap_action || {}).action || "detail" };
  }

  _changed(ev) {
    ev.stopPropagation();
    const { tap_action_mode, ...rest } = ev.detail.value;
    const config = { ...rest, tap_action: { action: tap_action_mode || "detail" } };
    for (const k of Object.keys(config)) {
      if (config[k] === "" || config[k] === undefined) delete config[k];
    }
    fireEvent(this, "config-changed", { config });
  }
}

customElements.define("kepco-bill-card-editor", KepcoBillCardEditor);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "kepco-bill-card",
  name: "KEPCO 전기요금",
  description: "현재 요금과 예상 요금. 누르면 청구 항목 내역이 열립니다",
  preview: true,
  documentationURL: "https://github.com/jaein4722/ha-kepco-smart-meter",
});
