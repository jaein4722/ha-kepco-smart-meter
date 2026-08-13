"""KEPCO API 계층.

Home Assistant 에 의존하지 않는다. 이 패키지만 따로 떼어 테스트할 수 있다(§20).
"""
from .client import KST, MAX_HISTORY_DAYS, KepcoClient
from .exceptions import (
    KepcoAuthError,
    KepcoDataIncompleteError,
    KepcoEndpointUnavailable,
    KepcoError,
    KepcoRateLimitError,
    KepcoResponseFormatError,
    KepcoSessionExpired,
)
from .models import (
    BillingStatus,
    CustomerInfo,
    EnergyInterval,
    MeterRegister,
    UsageSnapshot,
)

__all__ = [
    "KST",
    "MAX_HISTORY_DAYS",
    "BillingStatus",
    "CustomerInfo",
    "EnergyInterval",
    "KepcoAuthError",
    "KepcoClient",
    "KepcoDataIncompleteError",
    "KepcoEndpointUnavailable",
    "KepcoError",
    "KepcoRateLimitError",
    "KepcoResponseFormatError",
    "KepcoSessionExpired",
    "MeterRegister",
    "UsageSnapshot",
]
