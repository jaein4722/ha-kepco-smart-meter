"""데이터 갱신 조정자 (설계문서 §21, §23).

두 갈래 일을 한다.

* **Layer A** — 기기 페이지에 보여줄 현재 상태(지침, 청구 현황)
* **Layer B** — 실제 소비 시각에 맞춘 장기 통계 (statistics.py 가 담당)

AMI 는 늦게 오고 정정되기도 하므로 최신 구간만 보지 않고 최근 며칠을 매번 다시
훑는다(§13). 시작 시에는 앵커 시점까지 거슬러 백필한다(§23).
"""
from __future__ import annotations

import logging
from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import CALLBACK_TYPE, HomeAssistant, callback
from homeassistant.exceptions import ConfigEntryAuthFailed
from homeassistant.helpers.event import async_track_time_change
from homeassistant.helpers.storage import Store
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed

from .api import (
    KST,
    BillingStatus,
    CustomerInfo,
    EnergyInterval,
    KepcoAuthError,
    KepcoClient,
    KepcoDataIncompleteError,
    KepcoError,
)
from .const import (
    BACKFILL_DAYS,
    CONF_ANCHOR_DATE,
    CONF_CUSTOMER_NUMBER,
    CONF_PREVIOUS_READING,
    CONF_USER_ID,
    DOMAIN,
    STORAGE_KEY,
    STORAGE_VERSION,
    UPDATE_MINUTES,
)
from .statistics import async_import_intervals

_LOGGER = logging.getLogger(__name__)


class KepcoCoordinator(DataUpdateCoordinator[dict[str, Any]]):
    """파워플래너에서 주기적으로 사용량을 가져오고 통계를 채운다."""

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry) -> None:
        # update_interval 을 두지 않는다. 기동 시각에 따라 조회 시각이 흔들리지 않도록
        # 벽시계 기준 고정 시각(:05, :35)에 직접 예약한다.
        super().__init__(hass, _LOGGER, name=DOMAIN, update_interval=None)
        self.entry = entry
        self.client = KepcoClient(entry.data[CONF_USER_ID], entry.data["password"])
        self.customer_number: str = entry.data.get(CONF_CUSTOMER_NUMBER, "")
        self.customer: CustomerInfo | None = None

        raw_anchor = entry.data.get(CONF_PREVIOUS_READING)
        self.anchor_kwh = Decimal(str(raw_anchor)) if raw_anchor not in (None, "") else Decimal(0)
        self.anchor_date: date | None = None
        if entry.data.get(CONF_ANCHOR_DATE):
            self.anchor_date = date.fromisoformat(entry.data[CONF_ANCHOR_DATE])

        self._store: Store = Store(hass, STORAGE_VERSION, f"{STORAGE_KEY}.{entry.entry_id}")
        self._state: dict[str, Any] = {}
        self._backfilled = False

    async def async_load_store(self) -> None:
        self._state = await self._store.async_load() or {}
        self._backfilled = bool(self._state.get("backfilled"))

    # ------------------------------------------------------------------ 내부

    async def _async_backfill(self, billing: BillingStatus) -> None:
        """앵커(또는 청구주기 시작)부터 어제까지 한 번 훑어 통계를 채운다.

        HA 가 며칠 꺼져 있었어도 이 과정이 빈 구간을 메운다(§23).
        """
        start = self.anchor_date or billing.billing_start
        if start is None:
            start = date.today() - timedelta(days=BACKFILL_DAYS)

        end = date.today()
        _LOGGER.info("초기 백필: %s ~ %s", start, end)
        intervals = await self.client.async_get_hourly_range(start, end)
        if intervals:
            count, total = await async_import_intervals(
                self.hass,
                self.customer_number,
                f"KEPCO {self.customer_number}",
                intervals,
                self.anchor_kwh,
            )
            _LOGGER.info("백필 완료: 구간 %d개, 누적 %s kWh", count, total)

        self._backfilled = True
        self._state["backfilled"] = True
        await self._store.async_save(self._state)

    async def _async_recent_intervals(self) -> list[EnergyInterval]:
        """오늘과 최근 며칠을 다시 훑는다. 늦게 도착한 구간을 잡기 위해서다."""
        today = date.today()
        out: list[EnergyInterval] = []
        for offset in range(BACKFILL_DAYS, -1, -1):
            day = today - timedelta(days=offset)
            try:
                out.extend(await self.client.async_get_hourly_usage(day))
            except KepcoDataIncompleteError:
                # 자정 직후의 오늘처럼 아직 검침 전인 날은 정상적인 상황이다.
                continue
        return out

    # ------------------------------------------------------------------ 갱신

    async def _async_update_data(self) -> dict[str, Any]:
        try:
            if self.customer is None:
                customers = await self.client.async_list_customers()
                if customers:
                    self.customer = next(
                        (c for c in customers if c.customer_number == self.customer_number),
                        customers[0],
                    )
                    if not self.customer_number:
                        self.customer_number = self.customer.customer_number

            billing = await self.client.async_get_billing_status()

            if not self._backfilled:
                await self._async_backfill(billing)

            intervals = await self._async_recent_intervals()
        except KepcoAuthError as err:
            raise ConfigEntryAuthFailed(str(err)) from err
        except KepcoError as err:
            raise UpdateFailed(str(err)) from err
        except Exception as err:  # noqa: BLE001
            raise UpdateFailed(f"예상치 못한 오류: {err}") from err

        register: Decimal | None = None
        if intervals:
            _, register = await async_import_intervals(
                self.hass,
                self.customer_number,
                f"KEPCO {self.customer_number}",
                intervals,
                self.anchor_kwh,
            )

        latest = max(intervals, key=lambda i: i.end) if intervals else None
        now = datetime.now(KST)
        delay = int((now - latest.end).total_seconds() // 60) if latest else None

        today = now.date()
        yesterday = today - timedelta(days=1)

        def _day_sum(target: date) -> Decimal | None:
            # 구간은 끝나는 시각 기준이므로 24시 구간(다음날 00:00 종료)은 그 전날 것이다.
            picked = [i for i in intervals if (i.end - timedelta(seconds=1)).date() == target]
            return sum((i.energy_kwh for i in picked), Decimal(0)) if picked else None

        days_left = None
        if billing.billing_end:
            days_left = max(0, (billing.billing_end - today).days)

        # 청구주기 사용량은 KEPCO 가 준 값을 우선한다(§26). 구간 합계는 참고용.
        return {
            "billing": billing,
            "customer": self.customer,
            "register_kwh": register,
            "latest_interval": latest,
            "data_delay_minutes": delay,
            "interval_count": len(intervals),
            "today_kwh": _day_sum(today),
            "yesterday_kwh": _day_sum(yesterday),
            "days_until_reading": days_left,
            "fetched_at": now,
        }

    @callback
    def async_setup_schedule(self) -> CALLBACK_TYPE:
        """매시 지정된 분에 갱신을 예약한다. 해제 콜백을 돌려준다."""

        async def _tick(now) -> None:
            _LOGGER.debug("예약 갱신 실행 (%s)", now)
            await self.async_request_refresh()

        return async_track_time_change(
            self.hass, _tick, minute=UPDATE_MINUTES, second=0
        )

    async def async_shutdown_client(self) -> None:
        await self.client.async_close()
