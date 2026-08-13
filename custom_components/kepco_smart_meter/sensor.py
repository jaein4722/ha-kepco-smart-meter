"""센서 엔티티 (설계문서 §10, §11).

여기는 Layer A — 기기 페이지를 열었을 때 보이는 '지금 이 계량기의 상태'다.
시간별 이력은 엔티티가 아니라 장기 통계로 들어간다(§11: 24개 엔티티를 만들지 말 것).
"""
from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from decimal import Decimal
from typing import Any

from homeassistant.components.sensor import (
    SensorDeviceClass,
    SensorEntity,
    SensorEntityDescription,
    SensorStateClass,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import EntityCategory, UnitOfEnergy, UnitOfPower
from homeassistant.core import HomeAssistant
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import (
    ATTR_COMPLETENESS,
    ATTR_CUSTOMER,
    ATTR_DATA_DELAY,
    ATTR_INTERVAL_END,
    ATTR_INTERVAL_START,
    ATTR_LAST_UPDATE,
    ATTR_METER_ID,
    DOMAIN,
    MANUFACTURER,
    MODEL,
)
from .coordinator import KepcoCoordinator

# HA 는 원화 상수를 제공하지 않는다(CENT/DOLLAR/EURO 뿐). MONETARY 는 임의 통화
# 문자열을 받으므로 ISO 4217 코드를 그대로 쓴다.
CURRENCY_KRW = "KRW"


def _billing(data: dict[str, Any], field: str) -> Any:
    b = data.get("billing")
    return getattr(b, field, None) if b else None


@dataclass(frozen=True, kw_only=True)
class KepcoSensorDescription(SensorEntityDescription):
    value_fn: Callable[[dict[str, Any]], Any]
    attrs_fn: Callable[[dict[str, Any]], dict[str, Any]] | None = None


SENSORS: tuple[KepcoSensorDescription, ...] = (
    # 계량기 지침. 앵커(전월지침) + 이후 구간 합계로 재구성한다(§26).
    # 지침은 줄어들지 않으므로 total_increasing 이 맞다. 계량기 교체 시에는 값이
    # 급락하는데, HA 는 이를 리셋으로 처리한다(§24 는 명시적 처리를 권하나 v1 범위 밖).
    KepcoSensorDescription(
        key="meter_energy_import",
        translation_key="meter_energy_import",
        device_class=SensorDeviceClass.ENERGY,
        state_class=SensorStateClass.TOTAL_INCREASING,
        native_unit_of_measurement=UnitOfEnergy.KILO_WATT_HOUR,
        suggested_display_precision=3,
        value_fn=lambda d: d.get("register_kwh"),
        attrs_fn=lambda d: {
            ATTR_CUSTOMER: getattr(d.get("customer"), "customer_number", None),
            ATTR_METER_ID: getattr(d.get("customer"), "meter_id", None),
            ATTR_LAST_UPDATE: d.get("fetched_at"),
        },
    ),
    KepcoSensorDescription(
        key="billing_cycle_energy",
        translation_key="billing_cycle_energy",
        device_class=SensorDeviceClass.ENERGY,
        state_class=SensorStateClass.TOTAL,
        native_unit_of_measurement=UnitOfEnergy.KILO_WATT_HOUR,
        suggested_display_precision=1,
        value_fn=lambda d: _billing(d, "usage_kwh"),
        attrs_fn=lambda d: {
            "billing_start": _billing(d, "billing_start"),
            "billing_end": _billing(d, "billing_end"),
            "days_elapsed": _billing(d, "days_elapsed"),
            "progressive_level": _billing(d, "progressive_level"),
        },
    ),
    # device_class=energy 는 total/total_increasing 만 허용한다. 이 값은 누적이 아니라
    # '직전 한 시간에 쓴 양'이라 measurement 가 맞으므로, device_class 없이 단위만 준다.
    KepcoSensorDescription(
        key="last_hour_energy",
        translation_key="last_hour_energy",
        state_class=SensorStateClass.MEASUREMENT,
        native_unit_of_measurement=UnitOfEnergy.KILO_WATT_HOUR,
        icon="mdi:clock-outline",
        suggested_display_precision=3,
        value_fn=lambda d: getattr(d.get("latest_interval"), "energy_kwh", None),
        attrs_fn=lambda d: {
            ATTR_INTERVAL_START: getattr(d.get("latest_interval"), "start", None),
            ATTR_INTERVAL_END: getattr(d.get("latest_interval"), "end", None),
            ATTR_DATA_DELAY: d.get("data_delay_minutes"),
            ATTR_COMPLETENESS: d.get("interval_count"),
        },
    ),
    # §3: 시간당 에너지를 '현재 전력'처럼 부르지 않는다. 어디까지나 그 한 시간의 평균이다.
    KepcoSensorDescription(
        key="last_hour_average_power",
        translation_key="last_hour_average_power",
        device_class=SensorDeviceClass.POWER,
        state_class=SensorStateClass.MEASUREMENT,
        native_unit_of_measurement=UnitOfPower.WATT,
        entity_category=EntityCategory.DIAGNOSTIC,
        entity_registry_enabled_default=False,
        value_fn=lambda d: (
            float(getattr(d["latest_interval"], "energy_kwh") * 1000)
            if d.get("latest_interval")
            else None
        ),
    ),
    KepcoSensorDescription(
        key="today_energy",
        translation_key="today_energy",
        state_class=SensorStateClass.MEASUREMENT,
        native_unit_of_measurement=UnitOfEnergy.KILO_WATT_HOUR,
        icon="mdi:calendar-today",
        suggested_display_precision=3,
        value_fn=lambda d: d.get("today_kwh"),
    ),
    KepcoSensorDescription(
        key="yesterday_energy",
        translation_key="yesterday_energy",
        state_class=SensorStateClass.MEASUREMENT,
        native_unit_of_measurement=UnitOfEnergy.KILO_WATT_HOUR,
        icon="mdi:calendar-arrow-left",
        suggested_display_precision=3,
        value_fn=lambda d: d.get("yesterday_kwh"),
    ),
    KepcoSensorDescription(
        key="predicted_energy",
        translation_key="predicted_energy",
        state_class=SensorStateClass.MEASUREMENT,
        native_unit_of_measurement=UnitOfEnergy.KILO_WATT_HOUR,
        icon="mdi:chart-line",
        suggested_display_precision=1,
        value_fn=lambda d: _billing(d, "predicted_usage_kwh"),
    ),
    # 한전이 판정한 누진 단계. 구간 경계를 이쪽에서 재현하지 않는다(§33).
    KepcoSensorDescription(
        key="progressive_level",
        translation_key="progressive_level",
        icon="mdi:stairs-up",
        value_fn=lambda d: _billing(d, "progressive_level"),
        attrs_fn=lambda d: {
            "tier_unit_prices": [str(p) for p in (_billing(d, "tier_unit_prices") or ())]
        },
    ),
    KepcoSensorDescription(
        key="days_until_reading",
        translation_key="days_until_reading",
        native_unit_of_measurement="d",
        icon="mdi:calendar-clock",
        value_fn=lambda d: d.get("days_until_reading"),
    ),
    KepcoSensorDescription(
        key="current_bill",
        translation_key="current_bill",
        device_class=SensorDeviceClass.MONETARY,
        state_class=SensorStateClass.TOTAL,
        native_unit_of_measurement=CURRENCY_KRW,
        value_fn=lambda d: _billing(d, "current_charge_krw"),
        # 총계를 이루는 항목을 속성으로 붙여 어떻게 나온 금액인지 보이게 한다.
        attrs_fn=lambda d: {
            "기본요금": _billing(d, "base_charge_krw"),
            "전력량요금": _billing(d, "energy_charge_krw"),
            "기후환경요금": _billing(d, "climate_charge_krw"),
            "연료비조정액": _billing(d, "fuel_adjustment_krw"),
            "부가가치세": _billing(d, "vat_krw"),
            "전력산업기반기금": _billing(d, "fund_krw"),
        },
    ),
    KepcoSensorDescription(
        key="predicted_bill",
        translation_key="predicted_bill",
        device_class=SensorDeviceClass.MONETARY,
        state_class=SensorStateClass.TOTAL,
        native_unit_of_measurement=CURRENCY_KRW,
        value_fn=lambda d: _billing(d, "predicted_charge_krw"),
        attrs_fn=lambda d: {"예상 사용량": _billing(d, "predicted_usage_kwh")},
    ),
    KepcoSensorDescription(
        key="last_reading_time",
        translation_key="last_reading_time",
        entity_category=EntityCategory.DIAGNOSTIC,
        value_fn=lambda d: (
            getattr(d["latest_interval"], "end").isoformat()
            if d.get("latest_interval")
            else None
        ),
    ),
)


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    coordinator: KepcoCoordinator = hass.data[DOMAIN][entry.entry_id]
    async_add_entities(KepcoSensor(coordinator, entry, d) for d in SENSORS)


class KepcoSensor(CoordinatorEntity[KepcoCoordinator], SensorEntity):
    """KEPCO 스마트미터 센서."""

    _attr_has_entity_name = True
    entity_description: KepcoSensorDescription

    def __init__(
        self,
        coordinator: KepcoCoordinator,
        entry: ConfigEntry,
        description: KepcoSensorDescription,
    ) -> None:
        super().__init__(coordinator)
        self.entity_description = description
        cust = coordinator.customer_number or entry.entry_id
        self._attr_unique_id = f"{cust}_{description.key}"
        # §25: 기기는 계정이 아니라 '전기 사용 계약(계량기)' 단위로 만든다.
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, cust)},
            name=f"KEPCO 스마트미터 ({cust})",
            manufacturer=MANUFACTURER,
            model=MODEL,
            configuration_url="https://pp.kepco.co.kr/",
        )

    @property
    def native_value(self) -> Any:
        if not self.coordinator.data:
            return None
        value = self.entity_description.value_fn(self.coordinator.data)
        # Decimal 은 HA 가 직렬화하지 못하므로 마지막 순간에만 float 로 바꾼다(§15).
        return float(value) if isinstance(value, Decimal) else value

    @property
    def extra_state_attributes(self) -> dict[str, Any] | None:
        if not self.coordinator.data or not self.entity_description.attrs_fn:
            return None
        raw = self.entity_description.attrs_fn(self.coordinator.data)
        return {
            k: (float(v) if isinstance(v, Decimal) else v)
            for k, v in raw.items()
            if v is not None
        }
