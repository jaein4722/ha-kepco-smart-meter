"""장기 통계 가져오기 (설계문서 §12.2, §13).

이 모듈이 이 통합을 '주기적으로 갱신되는 센서'가 아니라 진짜 계량기 통합으로
만든다. 핵심 규칙 하나:

    데이터의 시각 = 전기를 실제로 쓴 구간의 시각
    (API 가 응답을 준 시각이 아니다)

파워플래너는 20–21시 사용량을 22시 넘어 공개하기도 한다. 순진하게 그때 센서를
갱신하면 히스토리가 두 시간 밀려 기록된다. 그래서 상태 갱신 대신 HA 의 외부 통계
API 로 **구간 시작 시각**에 직접 써넣는다.

외부 통계는 시작 시각을 키로 덮어쓰므로(UPSERT), 늦게 도착하거나 정정된 값도
자연스럽게 반영된다.
"""
from __future__ import annotations

import logging
from datetime import timedelta
from decimal import Decimal

# 직전 누적합을 찾을 때 거슬러 볼 범위. 며칠 비어 있어도 이어 붙을 만큼 넉넉히.
LOOKBACK_FOR_SUM = timedelta(days=45)

from homeassistant.components.recorder import get_instance
from homeassistant.components.recorder.models import StatisticData, StatisticMetaData

try:  # HA 2026.11+ 에서 도입
    from homeassistant.components.recorder.models import StatisticMeanType
except ImportError:  # pragma: no cover
    StatisticMeanType = None  # type: ignore[assignment]
from homeassistant.components.recorder.statistics import (
    async_add_external_statistics,
    statistics_during_period,
)
from homeassistant.const import UnitOfEnergy
from homeassistant.core import HomeAssistant

from .api import EnergyInterval
from .const import DOMAIN

_LOGGER = logging.getLogger(__name__)


def statistic_id_for(customer_number: str) -> str:
    """외부 통계 식별자. `도메인:객체` 형식이어야 한다."""
    return f"{DOMAIN}:{customer_number}_energy"


async def _async_sum_before(
    hass: HomeAssistant, statistic_id: str, moment
) -> Decimal | None:
    """주어진 시각 **직전**까지의 누적합을 가져온다.

    백필 창의 누적합을 이어 붙이려면 그 앞의 마지막 값이 필요하다.
    조회 범위를 넉넉히 잡아야 한다 — 창 시작이 자정이면 그날 자정부터 찾을 때
    범위가 비어버려 누적이 앵커부터 다시 시작하는 문제가 생긴다.
    """
    lookback = moment - LOOKBACK_FOR_SUM

    def _read():
        return statistics_during_period(
            hass, lookback, moment, {statistic_id}, "hour", None, {"sum"}
        )

    try:
        rows = await get_instance(hass).async_add_executor_job(_read)
    except Exception:  # noqa: BLE001
        _LOGGER.debug("이전 누적합 조회 실패", exc_info=True)
        return None

    series = rows.get(statistic_id) if rows else None
    if not series:
        return None

    # moment 이후 항목은 이번에 새로 쓸 구간이므로 제외한다.
    ts = moment.timestamp()
    earlier = [r for r in series if r.get("start") is not None and _as_ts(r["start"]) < ts]
    if not earlier:
        return None
    last = earlier[-1].get("sum")
    return Decimal(str(last)) if last is not None else None


def _as_ts(value) -> float:
    """recorder 는 버전에 따라 start 를 float 또는 datetime 으로 준다."""
    return value if isinstance(value, (int, float)) else value.timestamp()


async def async_import_intervals(
    hass: HomeAssistant,
    customer_number: str,
    display_name: str,
    intervals: list[EnergyInterval],
    anchor_kwh: Decimal = Decimal(0),
) -> tuple[int, Decimal | None]:
    """구간들을 실제 소비 시각에 맞춰 장기 통계로 써넣는다.

    `anchor_kwh` 는 계량기 지침 앵커다. 사용자가 전월지침을 입력했다면 누적합이
    실제 계량기 숫자와 같은 축 위에 놓이게 된다(§26).

    돌려주는 값은 (기록한 구간 수, 마지막 누적합). 누적합은 그대로 계량기 지침이
    되므로 지침 센서와 장기 통계가 같은 축을 공유한다.
    """
    if not intervals:
        return 0, None

    ordered = sorted(intervals, key=lambda i: i.start)
    statistic_id = statistic_id_for(customer_number)

    # 이 창 이전까지의 누적합에서 이어 간다. 없으면 앵커에서 시작한다.
    running = await _async_sum_before(hass, statistic_id, ordered[0].start)
    if running is None:
        running = anchor_kwh

    stats: list[StatisticData] = []
    for interval in ordered:
        running += interval.energy_kwh
        # start 는 구간이 시작된 시각이어야 한다. KEPCO 라벨이 아니라 실제 소비 시각.
        stats.append(StatisticData(start=interval.start, sum=float(running)))

    # mean_type 은 2026.11 부터 필수다. 구버전 호환을 위해 있을 때만 넣는다.
    meta_kwargs: dict = {
        "has_sum": True,
        "name": display_name,
        "source": DOMAIN,
        "statistic_id": statistic_id,
        "unit_of_measurement": UnitOfEnergy.KILO_WATT_HOUR,
    }
    if "unit_class" in getattr(StatisticMetaData, "__annotations__", {}):
        meta_kwargs["unit_class"] = "energy"
    if StatisticMeanType is not None:
        meta_kwargs["mean_type"] = StatisticMeanType.NONE
    else:
        meta_kwargs["has_mean"] = False
    metadata = StatisticMetaData(**meta_kwargs)

    async_add_external_statistics(hass, metadata, stats)
    _LOGGER.debug(
        "%s: 구간 %d개 기록 (%s ~ %s, 누적 %s kWh)",
        statistic_id,
        len(stats),
        ordered[0].start,
        ordered[-1].end,
        running,
    )
    return len(stats), running
