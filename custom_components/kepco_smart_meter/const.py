"""상수 정의."""
from __future__ import annotations

DOMAIN = "kepco_smart_meter"
MANUFACTURER = "한국전력공사"
MODEL = "Smart Meter (PowerPlanner AMI)"

# 통합이 함께 배포하는 Lovelace 커스텀 카드. www/ 아래 파일을 그대로 서빙한다.
# CARD_VERSION 은 캐시 무효화용이라 카드를 고칠 때마다 올려야 한다.
URL_BASE = f"/{DOMAIN}"
CARD_FILES = (
    "kepco-billing-cycle-card.js",
    "kepco-usage-chart-card.js",
    "kepco-bill-card.js",
)
CARD_VERSION = "0.6.0"
FRONTEND_KEY = f"{DOMAIN}_frontend_registered"

CONF_USER_ID = "user_id"
CONF_CUSTOMER_NUMBER = "customer_number"
CONF_READING_DAY = "reading_day"
CONF_PREVIOUS_READING = "previous_reading"
CONF_ANCHOR_DATE = "anchor_date"

# 상류가 1시간 단위 AMI 라 더 자주 조회해도 얻을 게 없다. 다만 마지막 구간이
# 정시 직후 조금 늦게 올라오므로 정시 한 번만으로는 놓칠 수 있다(§22).
#
# 기동 시각 기준 상대 주기가 아니라 **벽시계 기준 고정 시각**에 돌린다.
# 재시작해도 조회 시각이 흔들리지 않고, AMI 가 올라온 뒤를 겨냥할 수 있다.
UPDATE_MINUTES = [5, 35]

# 매 갱신마다 다시 훑는 창. AMI 는 지연·정정될 수 있으므로 최신 구간만 보지 않는다(§13).
BACKFILL_DAYS = 2

STORAGE_VERSION = 1
STORAGE_KEY = f"{DOMAIN}.state"

ATTR_INTERVAL_START = "last_interval_start"
ATTR_INTERVAL_END = "last_interval_end"
ATTR_DATA_DELAY = "data_delay_minutes"
ATTR_SOURCE = "source"
ATTR_LAST_UPDATE = "last_successful_update"
ATTR_CUSTOMER = "customer_number"
ATTR_METER_ID = "meter_id"
ATTR_COMPLETENESS = "interval_completeness"
