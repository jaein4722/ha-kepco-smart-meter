"""진단 정보 (설계문서 §29).

KEPCO 가 스키마를 바꿨을 때 원인을 좁힐 수 있을 만큼은 담되,
비밀번호·세션 쿠키·암호문은 절대 넣지 않는다.
"""
from __future__ import annotations

from dataclasses import asdict, is_dataclass
from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant

from .const import CONF_CUSTOMER_NUMBER, DOMAIN, UPDATE_MINUTES
from .coordinator import KepcoCoordinator
from .statistics import statistic_id_for


def _redact_customer(value: str | None) -> str | None:
    """고객번호는 앞 4자리만 남긴다."""
    if not value:
        return None
    return value[:4] + "*" * max(0, len(value) - 4)


def _plain(value: Any) -> Any:
    if is_dataclass(value):
        return {k: _plain(v) for k, v in asdict(value).items()}
    if isinstance(value, (list, tuple)):
        return [_plain(v) for v in value]
    if isinstance(value, dict):
        return {k: _plain(v) for k, v in value.items()}
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return str(value) if type(value).__name__ == "Decimal" else value


async def async_get_config_entry_diagnostics(
    hass: HomeAssistant, entry: ConfigEntry
) -> dict[str, Any]:
    coordinator: KepcoCoordinator = hass.data[DOMAIN][entry.entry_id]
    data = coordinator.data or {}
    customer = _redact_customer(entry.data.get(CONF_CUSTOMER_NUMBER))

    latest = data.get("latest_interval")
    return {
        "customer_number": customer,
        "statistic_id": statistic_id_for(coordinator.customer_number or "?"),
        "anchor_kwh": str(coordinator.anchor_kwh),
        "anchor_date": str(coordinator.anchor_date),
        "backfilled": coordinator._backfilled,  # noqa: SLF001
        "last_login": _plain(coordinator.client.last_login),
        "last_successful_update": _plain(data.get("fetched_at")),
        "data_delay_minutes": data.get("data_delay_minutes"),
        "intervals_in_window": data.get("interval_count"),
        "latest_interval": {
            "start": _plain(getattr(latest, "start", None)),
            "end": _plain(getattr(latest, "end", None)),
            "energy_kwh": _plain(getattr(latest, "energy_kwh", None)),
            "source": getattr(latest, "source", None),
        },
        "register_kwh": _plain(data.get("register_kwh")),
        "billing": _plain(data.get("billing")),
        "customer_info": _plain(data.get("customer")),
        "scheduled_minutes": UPDATE_MINUTES,
    }
