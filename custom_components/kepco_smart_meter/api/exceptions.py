"""KEPCO API 예외 계층 (설계문서 §28).

호출자가 상황을 구분해 대응할 수 있도록 오류를 세분화한다.
전부 "update failed" 로 뭉개면 진단과 유지보수가 어려워진다.
"""
from __future__ import annotations


class KepcoError(Exception):
    """모든 KEPCO 오류의 기반."""


class KepcoAuthError(KepcoError):
    """자격증명이 거부됨. 재로그인으로 해결되지 않는다."""


class KepcoSessionExpired(KepcoError):
    """세션이 만료됨. 재로그인 후 재시도하면 된다."""


class KepcoRateLimitError(KepcoError):
    """요청이 너무 잦아 상류가 거부함."""


class KepcoResponseFormatError(KepcoError):
    """응답 형식이 예상과 다름. KEPCO 가 스키마를 바꿨을 가능성."""


class KepcoDataIncompleteError(KepcoError):
    """응답은 정상이나 필요한 구간 데이터가 아직 없음."""


class KepcoEndpointUnavailable(KepcoError):
    """엔드포인트가 사라졌거나 접근 불가."""
