"""KEPCO 응답 → 정규화 모델 변환 (설계문서 §14).

상류 필드명(`F_AP_QT` 등)을 아는 유일한 계층이다.
KEPCO 가 스키마를 바꾸면 대개 여기만 고치면 된다.
"""
from __future__ import annotations

import logging
import re
from datetime import date, datetime, timedelta
from decimal import Decimal, InvalidOperation
from typing import Any

from .exceptions import KepcoDataIncompleteError, KepcoResponseFormatError
from .models import BillingStatus, CustomerInfo, EnergyInterval

_LOGGER = logging.getLogger(__name__)

SOURCE_HOURLY = "pp:rs0201_chart"
SOURCE_BILLING = "pp:getRM0201"
SOURCE_CUSTOMER = "pp:usercustno_list"


def _dec(value: Any) -> Decimal | None:
    """숫자를 Decimal 로. 반올림하지 않는다(§15)."""
    if value in (None, "", "-"):
        return None
    try:
        return Decimal(str(value).replace(",", "").strip())
    except (InvalidOperation, ValueError):
        return None


def _int(value: Any) -> int | None:
    d = _dec(value)
    return int(d) if d is not None else None


def parse_hourly(rows: Any, day: date, received_at: datetime, tz) -> list[EnergyInterval]:
    """시간대별 응답을 구간 목록으로.

    KEPCO 의 `MR_HHMI2` 는 `01:00`~`24:00` 이며 **그 시각에 끝나는** 한 시간을 뜻한다.
    라벨이 00 이 아니라 01 에서 시작해 24 로 끝나는 것이 근거다 — 그래야 하루가
    정확히 24칸으로 덮인다. 따라서 `NN시` 의 구간은 [NN-1:00, NN:00) 이다.

    아직 검침되지 않은 시간은 `NO_DATA_YN == "Y"` 로 오므로 건너뛴다.
    """
    if not isinstance(rows, list):
        raise KepcoResponseFormatError("시간대별 응답이 목록이 아님")

    intervals: list[EnergyInterval] = []
    midnight = datetime.combine(day, datetime.min.time(), tzinfo=tz)

    for item in rows:
        if not isinstance(item, dict) or item.get("NO_DATA_YN") == "Y":
            continue
        raw = str(item.get("MR_HHMI2") or item.get("MR_HHMI") or "")
        m = re.match(r"(\d{1,2})", raw)
        energy = _dec(item.get("F_AP_QT"))
        if not m or energy is None:
            continue
        end_hour = int(m.group(1))
        if not 1 <= end_hour <= 24:
            continue
        end = midnight + timedelta(hours=end_hour)
        intervals.append(
            EnergyInterval(
                start=end - timedelta(hours=1),
                end=end,
                energy_kwh=energy,
                source=SOURCE_HOURLY,
                received_at=received_at,
            )
        )

    if not intervals:
        raise KepcoDataIncompleteError(f"{day} 에 검침된 시간이 없음")
    return intervals


def _ymd(value: Any) -> date | None:
    if not isinstance(value, str):
        return None
    m = re.match(r"(\d{4})[.\-/]?(\d{2})[.\-/]?(\d{2})", value)
    return date(int(m.group(1)), int(m.group(2)), int(m.group(3))) if m else None


def parse_billing(payload: Any) -> BillingStatus:
    """`/rm/getRM0201.do` 응답에서 청구 현황을 뽑는다.

    금액 필드가 여럿이라 의미를 정확히 골라야 한다. 실측으로 확인한 관계:

        TOT_BILL             = 기본 + 전력량            (부가세·기금 제외)
        TOTAL_CHARGE         = 청구금액 **총계**        ← 현재 요금은 이것
        PREDICT_TOT_BILL     = 예상 기본 + 예상 전력량
        PREDICT_TOTAL_CHARGE = 예상 청구금액 **총계**   ← 예상 요금은 이것

    `NUM_PREDICT_BILL` 은 예상 '전력량요금'일 뿐이므로 예상 청구액으로 쓰면
    현재 요금보다 작게 나오는 모순이 생긴다.
    """
    if not isinstance(payload, dict):
        raise KepcoResponseFormatError("청구 응답이 객체가 아님")

    # SELECT_DT 는 조회 기준일(대개 오늘)이지 주기의 끝이 아니다.
    # 검침일은 END_DT 다. 예: START_DT 2026.08.15 / END_DT 2026.09.14 /
    # SELECT_DT 2026.08.18 / DT 4 (경과 일수).
    end = _ymd(payload.get("END_DT"))
    start = _ymd(payload.get("START_DT"))
    days = _int(payload.get("DT"))
    if start is None and days:
        as_of = _ymd(payload.get("SELECT_DT"))
        if as_of:
            start = as_of - timedelta(days=days - 1)

    tiers = tuple(
        p
        for key in ("USEKWH_UCOST1", "USEKWH_UCOST2", "USEKWH_UCOST3",
                    "USEKWH_UCOST4", "USEKWH_UCOST5", "USEKWH_UCOST6")
        if (p := _dec(payload.get(key))) not in (None, Decimal(0))
    )

    return BillingStatus(
        billing_start=start,
        billing_end=end,
        days_elapsed=days,
        usage_kwh=_dec(payload.get("F_AP_QT")),
        predicted_usage_kwh=_dec(payload.get("PREDICT_TOT")),
        current_charge_krw=_int(payload.get("TOTAL_CHARGE")),
        predicted_charge_krw=_int(payload.get("PREDICT_TOTAL_CHARGE")),
        base_charge_krw=_int(payload.get("NUM_BASE_BILL")),
        energy_charge_krw=_int(payload.get("NUM_KWH_BILL")),
        climate_charge_krw=_int(payload.get("NUM_ENV")),
        fuel_adjustment_krw=_int(payload.get("NUM_FUL")),
        vat_krw=_int(payload.get("VAT_BILL")),
        fund_krw=_int(payload.get("FUND_BILL")),
        progressive_level=_int(payload.get("PREDICT_BILL_LEVEL")),
        tier_unit_prices=tiers,
    )


def parse_customers(payload: Any) -> list[CustomerInfo]:
    """고객번호 목록. 계정 하나에 여러 계약이 달릴 수 있다(§25)."""
    if not isinstance(payload, list):
        raise KepcoResponseFormatError("고객번호 응답이 목록이 아님")

    def _date(value: Any) -> date | None:
        if not isinstance(value, str):
            return None
        m = re.match(r"(\d{4})[.\-]?(\d{2})[.\-]?(\d{2})", value)
        return date(int(m.group(1)), int(m.group(2)), int(m.group(3))) if m else None

    out: list[CustomerInfo] = []
    for item in payload:
        if not isinstance(item, dict) or not item.get("CUSTNO"):
            continue
        out.append(
            CustomerInfo(
                customer_number=str(item["CUSTNO"]),
                name=item.get("CUSTNM"),
                meter_id=item.get("METER_ID"),
                contract_type=item.get("CNTR_KND_NM") or item.get("CNTR_KND_CD"),
                contract_power=item.get("CNTR_PWR"),
                reading_day=_int(item.get("MR_DD")),
                reading_start=_date(item.get("MR_ST_DT")),
                reading_end=_date(item.get("MR_END_DT")),
                is_main=item.get("MAIN_CUST_YN") == "Y",
                multi_meter=item.get("MULTI_METER_YN") == "Y",
            )
        )
    return out
