"""KEPCO API 클라이언트 (설계문서 §19, §20).

이 계층은 Home Assistant 를 전혀 모른다. 정규화된 모델만 돌려주므로
KEPCO 엔드포인트가 바뀌어도 대개 api/ 안에서 해결된다.
"""
from __future__ import annotations

import asyncio
import json
import logging
from datetime import date, datetime, timedelta, timezone
from typing import Any

from curl_cffi import AsyncSession

from .auth import BASE, IMPERSONATE, async_login
from .exceptions import (
    KepcoDataIncompleteError,
    KepcoEndpointUnavailable,
    KepcoError,
    KepcoRateLimitError,
    KepcoResponseFormatError,
    KepcoSessionExpired,
)
from .models import BillingStatus, CustomerInfo, EnergyInterval
from .parser import parse_billing, parse_customers, parse_hourly

_LOGGER = logging.getLogger(__name__)

KST = timezone(timedelta(hours=9))

# 파워플래너가 소급해주는 시간별 데이터 범위(실측: 62일 가능, 95일 불가).
MAX_HISTORY_DAYS = 60

REFERER_HOURLY = BASE + "/rs/rs0201.do?menu_id=O020201"
REFERER_MAIN = BASE + "/rm/rm0201.do?menu_id=O020101"


class KepcoClient:
    """인증 상태를 스스로 관리하는 클라이언트."""

    def __init__(self, user_id: str, password: str, tz=KST) -> None:
        self._user_id = user_id
        self._password = password
        self._tz = tz
        self._session: AsyncSession | None = None
        self._lock = asyncio.Lock()
        self.last_login: datetime | None = None

    # ------------------------------------------------------------------ 수명주기

    async def async_login(self) -> None:
        await self.async_close()
        self._session = AsyncSession(impersonate=IMPERSONATE, timeout=30)
        await async_login(self._session, self._user_id, self._password)
        self.last_login = datetime.now(self._tz)

    async def async_close(self) -> None:
        if self._session is not None:
            await self._session.close()
            self._session = None

    async def _ensure_session(self) -> AsyncSession:
        if self._session is None:
            await self.async_login()
        assert self._session is not None
        return self._session

    # ------------------------------------------------------------------- 저수준

    async def _post(self, path: str, payload: dict[str, Any], referer: str) -> Any:
        """POST 후 JSON 을 돌려준다. 세션이 끊겼으면 한 번만 재로그인해 재시도한다(§19)."""
        async with self._lock:
            for attempt in (1, 2):
                session = await self._ensure_session()
                resp = await session.post(
                    BASE + path,
                    json=payload,
                    headers={"X-Requested-With": "XMLHttpRequest", "Referer": referer},
                )
                if resp.status_code == 429:
                    raise KepcoRateLimitError(f"{path} 요청이 제한됨")
                if resp.status_code == 404:
                    raise KepcoEndpointUnavailable(f"{path} 없음 (404)")
                if resp.status_code != 200:
                    raise KepcoEndpointUnavailable(f"{path} 응답 {resp.status_code}")

                text = resp.text.lstrip()
                # 빈 응답은 세션이 끊겼다는 신호다. `text[:1] in "[{"` 로 쓰면
                # 빈 문자열이 참이 되어 아래 재로그인 경로를 건너뛰고
                # 파싱 실패로 새어 나가므로 튜플로 비교한다.
                if text[:1] in ("[", "{", '"'):
                    try:
                        return json.loads(text)
                    except ValueError as err:
                        raise KepcoResponseFormatError(f"{path} JSON 파싱 실패") from err

                # 세션이 끊기면 로그인 HTML 이 돌아온다.
                if attempt == 1:
                    _LOGGER.debug("%s 에서 세션 만료 감지, 재로그인", path)
                    await self.async_login()
                    continue
                raise KepcoSessionExpired(f"{path} 재로그인 후에도 세션 확보 실패")
        raise KepcoError("도달 불가")

    # --------------------------------------------------------------- 공개 인터페이스

    async def async_list_customers(self) -> list[CustomerInfo]:
        """계정에 딸린 고객번호 목록(§25)."""
        return parse_customers(await self._post("/auth/usercustno_list.do", {}, REFERER_MAIN))

    async def async_get_hourly_usage(self, day: date) -> list[EnergyInterval]:
        """하루치 시간별 구간. 아직 검침 전이면 KepcoDataIncompleteError."""
        payload = {"SELECT_DT": day.isoformat(), "selectType": "all", "TIME_TYPE": "1"}
        rows = await self._post("/rs/rs0201_chart.do", payload, REFERER_HOURLY)
        return parse_hourly(rows, day, datetime.now(self._tz), self._tz)

    async def async_get_hourly_range(
        self, start: date, end: date, delay: float = 0.4
    ) -> list[EnergyInterval]:
        """기간 내 모든 구간을 모은다. 백필용(§13).

        상류에 부담을 주지 않도록 요청 사이에 간격을 둔다.
        데이터가 없는 날은 조용히 건너뛴다.
        """
        oldest = date.today() - timedelta(days=MAX_HISTORY_DAYS)
        if start < oldest:
            _LOGGER.debug("소급 한계로 시작일을 %s 에서 %s 로 조정", start, oldest)
            start = oldest

        out: list[EnergyInterval] = []
        day = start
        while day <= end:
            try:
                out.extend(await self.async_get_hourly_usage(day))
            except KepcoDataIncompleteError:
                pass
            except KepcoError as err:
                _LOGGER.warning("%s 조회 실패: %s", day, err)
            day += timedelta(days=1)
            if day <= end:
                await asyncio.sleep(delay)
        return out

    async def async_get_billing_status(self) -> BillingStatus:
        """현재 청구 주기 사용량과 요금(§11)."""
        payload = await self._post(
            "/rm/getRM0201.do", {"menuType": "time", "TOU": False}, REFERER_MAIN
        )
        return parse_billing(payload)
