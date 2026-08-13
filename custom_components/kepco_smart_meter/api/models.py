"""KEPCO 응답과 무관한 정규화 모델 (설계문서 §14).

`F_AP_QT` 같은 상류 필드명이 통합 전체로 새어나가지 않도록,
파서 계층에서 이 모델로 변환한 뒤에만 밖으로 내보낸다.

정확도가 중요한 누적/정합성 계산에는 float 대신 Decimal 을 쓴다(§15).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime
from decimal import Decimal


@dataclass(frozen=True, slots=True)
class EnergyInterval:
    """한 구간 동안 소비된 에너지.

    KEPCO 는 시간대를 `01시`~`24시` 라벨로 주는데, 이는 **그 시각에 끝나는**
    한 시간 구간을 뜻한다. 즉 `01시` = [00:00, 01:00).
    """

    start: datetime
    end: datetime
    energy_kwh: Decimal
    source: str
    received_at: datetime

    @property
    def is_hourly(self) -> bool:
        return (self.end - self.start).total_seconds() == 3600


@dataclass(frozen=True, slots=True)
class MeterRegister:
    """계량기 누적 지침.

    KEPCO 가 지침을 직접 주지 않으면 알려진 앵커에 구간 합계를 더해 재구성한다(§26).
    그 경우 `source` 로 재구성임을 표시한다.
    """

    timestamp: datetime
    energy_kwh: Decimal
    meter_id: str | None
    source: str


@dataclass(frozen=True, slots=True)
class BillingStatus:
    """청구 주기 현황.

    금액은 전부 한전이 계산해 내려준 값이다. 누진 구간이나 계절 기준을 이쪽에서
    재현하지 않는다(§33). 구간별 단가만 참고용으로 함께 담는다.
    """

    billing_start: date | None = None
    billing_end: date | None = None
    days_elapsed: int | None = None

    usage_kwh: Decimal | None = None
    predicted_usage_kwh: Decimal | None = None

    # 청구금액 총계 = 기본 + 전력량 + 기후환경 + 연료비조정 + 부가세 + 전력기금
    current_charge_krw: int | None = None
    predicted_charge_krw: int | None = None

    # 총계를 이루는 항목들. 진단·표시용.
    base_charge_krw: int | None = None
    energy_charge_krw: int | None = None
    climate_charge_krw: int | None = None
    fuel_adjustment_krw: int | None = None
    vat_krw: int | None = None
    fund_krw: int | None = None

    progressive_level: int | None = None
    tier_unit_prices: tuple[Decimal, ...] = ()


@dataclass(frozen=True, slots=True)
class CustomerInfo:
    """계약(고객번호) 단위 정보. 하나의 HA 기기에 대응한다(§25)."""

    customer_number: str
    name: str | None = None
    meter_id: str | None = None
    contract_type: str | None = None
    contract_power: str | None = None
    reading_day: int | None = None
    reading_start: date | None = None
    reading_end: date | None = None
    is_main: bool = False
    multi_meter: bool = False


@dataclass(slots=True)
class UsageSnapshot:
    """한 번의 갱신으로 얻은 모든 것."""

    intervals: list[EnergyInterval] = field(default_factory=list)
    register: MeterRegister | None = None
    billing: BillingStatus | None = None
    customer: CustomerInfo | None = None
    fetched_at: datetime | None = None

    @property
    def latest_interval(self) -> EnergyInterval | None:
        return max(self.intervals, key=lambda i: i.end) if self.intervals else None

    @property
    def total_kwh(self) -> Decimal:
        return sum((i.energy_kwh for i in self.intervals), Decimal(0))
